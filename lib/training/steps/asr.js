/**
 * Step 3: 语音识别 (ASR)
 *
 * 根据语言选择 ASR 引擎：
 * - 中文/粤语: 达摩 ASR (FunASR) — 中文专用，精度高
 * - 日语/英语/其他: Faster Whisper — 多语种通用
 *
 * 完全使用项目内的 gsv-tools/asr/ + 项目 venv 的 Python
 */

const path = require('path');
const fs = require('fs');
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');

const GSV_TOOLS = path.join(__dirname, '..', 'gsv-tools');
const PYTHON = getPythonPath();

async function run(ctx, log) {
  const { workDir, language, config, voiceId } = ctx;
  const asrConfig = config.steps.asr;

  let srcDir = ctx.inputDir;
  if (fs.existsSync(path.join(workDir, 'slicer_opt'))) {
    srcDir = path.join(workDir, 'slicer_opt');
  }

  // 选择引擎
  let engine = 'faster-whisper';
  const engines = (asrConfig.params && asrConfig.params.engines) || {};
  if (engines[language]) {
    engine = engines[language].engine;
  } else if (language.startsWith('zh') || language === 'yue') {
    engine = 'funasr';
  } else if (engines['default']) {
    engine = engines['default'].engine;
  }

  const langMap = { zh: 'zh', yue: 'yue', ja: 'ja', en: 'en', ko: 'ko' };
  const resolvedLang = langMap[language] || language;

  // ASR params from config
  const asrParams = asrConfig.params || {};
  const modelSize = asrParams.model_size || 'large-v3-turbo';
  const asrPrecision = asrParams.precision || (process.env.CUDA_VISIBLE_DEVICES === '' ? 'int8' : 'float16');

  log(`ASR: input=${srcDir}, lang=${language}, engine=${engine}, model=${modelSize}, precision=${asrPrecision}`);

  const files = fs.readdirSync(srcDir).filter(f =>
    /\.(wav|mp3|flac)$/i.test(f)
  );
  if (files.length === 0) throw new Error('No audio files');

  const outputDir = path.join(workDir, 'asr_output');
  fs.mkdirSync(outputDir, { recursive: true });

  const asrDir = path.join(GSV_TOOLS, 'asr');
  let cmd;
  if (engine === 'funasr') {
    const script = path.join(asrDir, 'funasr_asr.py');
    cmd = [PYTHON, script, '-i', srcDir, '-o', outputDir, '-l', resolvedLang];
  } else {
    const script = path.join(asrDir, 'fasterwhisper_asr.py');
    // 传 turbo + --model_dir，拼出 gsv-tools/asr/faster-whisper-large-v3-turbo（本地已存在），零下载
    const precision = asrPrecision;
    cmd = [
      PYTHON, script,
      '-i', srcDir, '-o', outputDir, '-l', resolvedLang,
      '-s', modelSize,
      '--model_dir', asrDir,
      '-p', precision,
    ];
  }

  log(`Running: ${cmd.join(' ')}`);

  try {
    const result = await spawnAsync(cmd[0], cmd.slice(1), {
      timeout: 900000,
      env: getCleanEnv({
        CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES || '0',
      }),
      onChild: (child) => ctx.setChild(child),
      onStdout: (s) => log(`[asr] ${s.trimEnd()}`),
      onStderr: (s) => log(`[asr:err] ${s.trimEnd()}`),
    });
    if (result.stdout) log(`stdout: ${result.stdout.slice(-500)}`);
    if (result.stderr) log(`stderr: ${result.stderr.slice(-500)}`);
  } catch (err) {
    throw new Error(`ASR failed: ${err.message}`);
  }

  // Parse output
  const listFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.list'));
  const segments = [];

  if (listFiles.length > 0) {
    const content = fs.readFileSync(path.join(outputDir, listFiles[0]), 'utf-8');
    for (let i = 0; i < content.split('\n').filter(l => l.trim()).length; i++) {
      const line = content.split('\n').filter(l => l.trim())[i];
      const parts = line.split('|');
      if (parts.length >= 4) {
        const audioFile = path.basename(parts[0]);
        segments.push({
          index: i, scene: path.parse(audioFile).name,
          audio_filename: audioFile, audio_path: `slicer_opt/${audioFile}`,
          text: parts[3] || '', matched: true, duration: 0,
        });
      }
    }
  }

  if (segments.length === 0) {
    log('WARN: No segments parsed, using filenames');
    for (let i = 0; i < files.length; i++) {
      segments.push({
        index: i, scene: path.parse(files[i]).name,
        audio_filename: files[i], audio_path: `slicer_opt/${files[i]}`,
        text: '', matched: true, duration: 0,
      });
    }
  }

  const segData = {
    voice: voiceId, language, asr_engine: engine,
    source_file: 'slicer_opt/', generated_at: new Date().toISOString(),
    total: segments.length, matched: segments.length, segments,
  };

  const segPath = path.join(workDir, 'segments.json');
  fs.writeFileSync(segPath, JSON.stringify(segData, null, 2));
  log(`Done: ${segments.length} segments`);
  return { segmentsPath: segPath, segmentCount: segments.length };
}

module.exports = { run };
