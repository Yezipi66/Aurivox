/**
 * Step 3: 语音识别 (ASR)
 *
 * 根据语言选择 ASR 引擎：
 * - 中文/粤语: 达摩 ASR (FunASR) — 中文专用，精度高
 * - 日语/英语/其他: Faster Whisper — 多语种通用
 *
 * 来源感知：
 * - 有切片(slicer_opt/ 内有真实 .wav) → 对切片跑 ASR，产出 slicer_opt.list
 * - 无切片(不切片模式) → 对 raw 源跑 ASR，产出 raw_opt.list
 * 产出的 .list 路径列一律写成【资产内相对路径】(slicer_opt/<f> 或 raw/<f>)，
 * 不再钉临时/外部绝对路径 —— 资产目录搬家后仍可复用。
 *
 * 完全使用项目内的 gsv-tools/asr/ + 项目 venv 的 Python
 */

const path = require('path');
const fs = require('fs');
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');
const { resolveAudioSource, AUDIO_RE } = require('./_source');

const GSV_TOOLS = path.join(__dirname, '..', 'gsv-tools');
const PYTHON = getPythonPath();

// sourceKind → 持久化 list 文件名。raw 源导出 raw_opt.list，切片源导出 slicer_opt.list。
const LIST_NAME = { raw: 'raw_opt.list', slicer_opt: 'slicer_opt.list' };

/**
 * 来源感知的 ASR 内核：对 srcDir 跑 ASR，把结果写成 asset-relative 的 .list。
 * 供训练 pipeline 步骤与 Assets 就地恢复共用（单一实现，避免重复）。
 *
 * @param {object} args
 *   srcDir     要识别的音频目录（切片目录或 raw 目录）
 *   sourceKind 'slicer_opt' | 'raw' —— 决定 list 文件名与路径列前缀
 *   language   语言码 (ja/zh/en/...)
 *   voiceId    音色 id（写入 list 的 speaker 列）
 *   outDir     .list 输出目录（临时 asr_output/ 或资产 asr_opt/）
 *   config     训练配置（读取 asr 引擎/模型参数）
 *   setChild   登记子进程（可取消），可选
 * @param {function} log
 * @returns {{ listPath, listName, sourceKind, segments }}
 */
async function runAsr(args, log) {
  const { srcDir, sourceKind, language, voiceId, outDir, config } = args;
  const asrConfig = (config && config.steps && config.steps.asr) || { params: {} };
  const listName = LIST_NAME[sourceKind];
  if (!listName) throw new Error(`未知 ASR sourceKind: ${sourceKind}`);

  if (!fs.existsSync(srcDir)) throw new Error(`ASR 源目录不存在: ${srcDir}`);
  const files = fs.readdirSync(srcDir).filter(f => AUDIO_RE.test(f));
  if (files.length === 0) throw new Error(`ASR 源目录无音频文件: ${srcDir}`);

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

  const asrParams = asrConfig.params || {};
  const modelSize = asrParams.model_size || 'large-v3-turbo';
  const asrPrecision = asrParams.precision || (process.env.CUDA_VISIBLE_DEVICES === '' ? 'int8' : 'float16');

  fs.mkdirSync(outDir, { recursive: true });
  // ASR python 写到独立临时子目录，避免与最终 <name>.list 命名冲突
  const rawAsrDir = path.join(outDir, `.asr_raw_${sourceKind}`);
  fs.rmSync(rawAsrDir, { recursive: true, force: true });
  fs.mkdirSync(rawAsrDir, { recursive: true });

  log(`ASR: source=${sourceKind}, input=${srcDir}, lang=${language}, engine=${engine}, model=${modelSize}, precision=${asrPrecision}`);

  const asrDir = path.join(GSV_TOOLS, 'asr');
  let cmd;
  if (engine === 'funasr') {
    const script = path.join(asrDir, 'funasr_asr.py');
    cmd = [PYTHON, script, '-i', srcDir, '-o', rawAsrDir, '-l', resolvedLang];
  } else {
    const script = path.join(asrDir, 'fasterwhisper_asr.py');
    cmd = [
      PYTHON, script,
      '-i', srcDir, '-o', rawAsrDir, '-l', resolvedLang,
      '-s', modelSize,
      '--model_dir', asrDir,
      '-p', asrPrecision,
    ];
  }

  log(`Running: ${cmd.join(' ')}`);
  try {
    const result = await spawnAsync(cmd[0], cmd.slice(1), {
      timeout: 900000,
      env: getCleanEnv({ CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES || '0' }),
      onChild: (child) => { if (args.setChild) args.setChild(child); },
      onStdout: (s) => log(`[asr] ${s.trimEnd()}`),
      onStderr: (s) => log(`[asr:err] ${s.trimEnd()}`),
    });
    if (result.stdout) log(`stdout: ${result.stdout.slice(-500)}`);
    if (result.stderr) log(`stderr: ${result.stderr.slice(-500)}`);
    // spawnAsync resolves on process close REGARDLESS of exit code (只在 spawn 出错/
    // 超时时 reject)。若 ASR Python 以非零码退出(脚本内部报错),这里必须显式抛错，
    // 否则会继续解析空产物 → 静默产出「零文本」却上报成功。
    if (result.status !== 0) {
      throw new Error(`ASR process exited with code ${result.status}: ${(result.stderr || '').slice(-200)}`);
    }
  } catch (err) {
    throw new Error(`ASR failed: ${err.message}`);
  }

  // 解析 ASR python 产出的 .list（每行: <abs_path>|<speaker>|<LANG>|<text>），
  // 只取 basename + text；路径列改写成 asset-relative: <sourceKind>/<basename>。
  const produced = fs.readdirSync(rawAsrDir).filter(f => f.endsWith('.list'));
  const textByName = {};
  if (produced.length > 0) {
    const content = fs.readFileSync(path.join(rawAsrDir, produced[0]), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split('|');
      if (parts.length >= 4) {
        const bn = path.basename(parts[0].replace(/\\/g, '/'));
        textByName[bn] = parts.slice(3).join('|');
      }
    }
  } else {
    log('WARN: ASR 未产出 .list，文本置空');
  }

  // 以源目录的真实音频文件为准，生成 asset-relative 的规范 list + segments
  const listPath = path.join(outDir, listName);
  const lines = [];
  const segments = [];
  files.forEach((f, i) => {
    const text = textByName[f] || '';
    // 规范行：资产内相对路径 | speaker(voiceId) | LANG | text
    lines.push(`${sourceKind}/${f}|${voiceId}|${resolvedLang.toUpperCase()}|${text}`);
    segments.push({
      index: i,
      scene: path.parse(f).name,
      audio_filename: f,
      audio_path: `${sourceKind}/${f}`,
      text,
      matched: true,
      duration: 0,
    });
  });
  fs.writeFileSync(listPath, lines.join('\n') + '\n', 'utf-8');

  // 清理临时 asr_raw 子目录
  try { fs.rmSync(rawAsrDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  log(`ASR 完成: ${listName}（${segments.length} 条，路径写活为 ${sourceKind}/）`);
  return { listPath, listName, sourceKind, segments };
}

/**
 * Pipeline 步骤入口。来源感知：切片存在→slicer_opt，否则→raw。
 */
async function run(ctx, log) {
  const { workDir, language, config, voiceId } = ctx;

  // 来源感知：切片存在→slicer_opt，否则→raw（统一由共享解析器决定，去 passthrough）
  const { sourceKind, srcDir } = resolveAudioSource(ctx);
  if (!sourceKind) throw new Error('ASR: 未找到可识别的音频来源（既无切片也无 raw）');

  const outputDir = path.join(workDir, 'asr_output');
  const { listName, segments } = await runAsr({
    srcDir, sourceKind, language, voiceId, outDir: outputDir, config,
    setChild: ctx.setChild,
  }, log);

  const segData = {
    voice: voiceId,
    language,
    source_kind: sourceKind,
    source_file: `${sourceKind}/`,
    generated_at: new Date().toISOString(),
    total: segments.length,
    matched: segments.length,
    segments,
  };
  const segPath = path.join(workDir, 'segments.json');
  fs.writeFileSync(segPath, JSON.stringify(segData, null, 2));
  log(`Done: ${segments.length} segments（list=${listName}）`);
  return { segmentsPath: segPath, segmentCount: segments.length, listName, sourceKind };
}

module.exports = { run, runAsr };
