/**
 * Step 3: 语音识别 (ASR)
 *
 * ASR 引擎：一律使用 Faster Whisper（含中文/粤语）。
 * 达摩/FunASR 在 Windows 环境下对中文反复报错，已弃用；
 * 仅当 steps.asr.params.engines 显式指定时才会用其他引擎，
 * 且若显式指定的 funasr 失败会自动回退到 faster-whisper。
 *
 * 来源感知：
 * - 有切片(slicer_opt/ 内有真实 .wav) → 对切片跑 ASR，产出 slicer_opt.list
 * - 无切片(不切片模式) → 对 raw 源跑 ASR，产出 raw_opt.list
 * 产出的 .list 路径列一律写成【资产内相对路径】(slicer_opt/<f> 或 raw/<f>)，
 * 不再钉临时/外部绝对路径 —— 资产目录搬家后仍可复用。
 *
 * 完全使用项目内的 vendor/asr/ + 项目 venv 的 Python
 */

const path = require('path');
const fs = require('fs');
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');
const { resolveAudioSource, AUDIO_RE } = require('./_source');

const { ASR_DIR, ASR_MODELS_DIR } = require('../../paths');
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
  if (!listName) throw new Error(`Unknown ASR sourceKind: ${sourceKind}`);

  if (!fs.existsSync(srcDir)) throw new Error(`ASR source directory does not exist: ${srcDir}`);
  const files = fs.readdirSync(srcDir).filter(f => AUDIO_RE.test(f));
  if (files.length === 0) throw new Error(`ASR source directory has no audio files: ${srcDir}`);

  const asrParams = asrConfig.params || {};

  // Engine selection (稳妥版 / conservative). faster-whisper is the robust,
  // cross-platform DEFAULT for every language. FunASR (Paraformer-large +
  // FSMN-VAD + CT-Transformer punctuation) is the official pipeline's Chinese
  // stack and yields better zh/yue accuracy AND punctuation, but historically
  // hangs/crashes on Windows — so it is strictly OPT-IN, only for zh/yue, and
  // any failure auto-falls back to faster-whisper below (training never dies).
  //
  // Source of the choice: the user's explicit per-run `engine` field
  // ('auto' | 'faster-whisper' | 'funasr', from the Training page). Legacy
  // configs may instead carry a per-language `engines{}` map; honor it as a
  // secondary source. 'auto' and 'faster-whisper' both mean faster-whisper.
  const FUNASR_LANGS = new Set(['zh', 'yue']);
  let requested = asrParams.engine;
  if (!requested) {
    const engines = asrParams.engines || {};
    requested = (engines[language] && engines[language].engine)
      || (engines['default'] && engines['default'].engine);
  }
  let engine = 'faster-whisper';
  if (requested === 'funasr') {
    if (FUNASR_LANGS.has(String(language).toLowerCase())) {
      engine = 'funasr';
    } else {
      // FunASR only ships zh/yue models here; ja/en/ko/auto stay on whisper.
      log(`ASR: FunASR requested but only supports zh/yue; language='${language}' uses faster-whisper.`);
    }
  }

  const langMap = { zh: 'zh', yue: 'yue', ja: 'ja', en: 'en', ko: 'ko' };
  const resolvedLang = langMap[language] || language;
  // auto 挡位：ASR 逐文件自动检测语言，.list 的 LANG 列写各自检测到的语言，
  // 而非统一的全局语言。音素化(preprocess)会据此按行选择清洗器。
  const isAuto = String(language).toLowerCase() === 'auto';
  // GPT-SoVITS 音素清洗器支持的语言；auto 下检测到的语言若不在此集合内，
  // 回退到 AUTO_FALLBACK_LANG，避免下游音素化因未知语言而报错。
  const SUPPORTED_PHONEME_LANGS = new Set(['zh', 'yue', 'ja', 'en', 'ko']);
  const AUTO_FALLBACK_LANG = 'ja';

  let modelSize = asrParams.model_size || 'large-v3-turbo';
  if (modelSize === 'large') modelSize = 'large-v3';  // 旧配方兼容别名
  const asrPrecision = asrParams.precision || (process.env.CUDA_VISIBLE_DEVICES === '' ? 'int8' : 'float16');
  // Patch #22：强制简体中文（默认开）。本产品不支持繁体，zh/yue 输出统一转简体。
  const forceSimplified = asrParams.force_simplified_chinese !== false;

  fs.mkdirSync(outDir, { recursive: true });
  // ASR python 写到独立临时子目录，避免与最终 <name>.list 命名冲突
  const rawAsrDir = path.join(outDir, `.asr_raw_${sourceKind}`);
  fs.rmSync(rawAsrDir, { recursive: true, force: true });
  fs.mkdirSync(rawAsrDir, { recursive: true });

  log(`ASR: source=${sourceKind}, input=${srcDir}, lang=${language}, engine=${engine}, model=${modelSize}, precision=${asrPrecision}`);

  // 脚本与权重现在是两个目录：ASR_DIR 放识别脚本，ASR_MODELS_DIR 放模型。
  const buildCmd = (eng) => {
    if (eng === 'funasr') {
      const script = path.join(ASR_DIR, 'funasr_asr.py');
      return [PYTHON, script, '-i', srcDir, '-o', rawAsrDir, '-l', resolvedLang];
    }
    const script = path.join(ASR_DIR, 'fasterwhisper_asr.py');
    return [
      PYTHON, script,
      '-i', srcDir, '-o', rawAsrDir, '-l', resolvedLang,
      '-s', modelSize,
      '--model_dir', ASR_MODELS_DIR,
      '-p', asrPrecision,
      forceSimplified ? '--force-simplified' : '--no-force-simplified',
    ];
  };
  let cmd = buildCmd(engine);

  const runOnce = async () => {
    log(`Running: ${cmd.join(' ')}`);
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
  };
  try {
    await runOnce();
  } catch (err) {
    // 显式配置的 funasr 失败 → 回退 faster-whisper，避免训练因 ASR 死掉。
    if (engine === 'funasr') {
      log(`WARN: FunASR failed (${err.message}). Falling back to faster-whisper.`);
      engine = 'faster-whisper';
      fs.rmSync(rawAsrDir, { recursive: true, force: true });
      fs.mkdirSync(rawAsrDir, { recursive: true });
      cmd = buildCmd(engine);
      try {
        await runOnce();
      } catch (err2) {
        throw new Error(`ASR failed: ${err2.message}`);
      }
    } else {
      throw new Error(`ASR failed: ${err.message}`);
    }
  }

  // 解析 ASR python 产出的 .list（每行: <abs_path>|<speaker>|<LANG>|<text>），
  // 只取 basename + text；路径列改写成 asset-relative: <sourceKind>/<basename>。
  const produced = fs.readdirSync(rawAsrDir).filter(f => f.endsWith('.list'));
  const textByName = {};
  const detectedLangByName = {};
  if (produced.length > 0) {
    const content = fs.readFileSync(path.join(rawAsrDir, produced[0]), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split('|');
      if (parts.length >= 4) {
        const bn = path.basename(parts[0].replace(/\\/g, '/'));
        textByName[bn] = parts.slice(3).join('|');
        // 保留 python 逐文件检测到的语言列(parts[2])，供 auto 挡位逐行使用。
        detectedLangByName[bn] = (parts[2] || '').trim().toLowerCase();
      }
    }
  } else {
    log('WARN: ASR produced no .list; text left empty');
  }

  // Patch #23：读取 ASR python 的置信度旁车（<name>.conf.json，键为片段文件名）。
  // 数据只存旁车，绝不写入 .list 第 5 列（会被 slice(3) 吞进文本）。
  const confByName = {};
  try {
    const confFiles = fs.readdirSync(rawAsrDir).filter(f => f.endsWith('.conf.json'));
    if (confFiles.length > 0) {
      const raw = JSON.parse(fs.readFileSync(path.join(rawAsrDir, confFiles[0]), 'utf-8'));
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          confByName[path.basename(String(k).replace(/\\/g, '/'))] = v;
        }
      }
    }
  } catch (e) {
    log(`WARN: failed to read confidence sidecar: ${e.message}`);
  }

  // 以源目录的真实音频文件为准，生成 asset-relative 的规范 list + segments
  const listPath = path.join(outDir, listName);
  const lines = [];
  const segments = [];
  const confOut = {};
  files.forEach((f, i) => {
    const text = textByName[f] || '';
    const conf = confByName[f] || null;
    if (conf) confOut[f] = conf;
    // auto：使用该文件检测到的语言(不受支持则回退)；否则统一用全局语言。
    let lineLang = resolvedLang;
    if (isAuto) {
      const det = detectedLangByName[f] || '';
      lineLang = SUPPORTED_PHONEME_LANGS.has(det) ? det : AUTO_FALLBACK_LANG;
    }
    // 规范行：资产内相对路径 | speaker(voiceId) | LANG | text
    lines.push(`${sourceKind}/${f}|${voiceId}|${lineLang.toUpperCase()}|${text}`);
    segments.push({
      index: i,
      scene: path.parse(f).name,
      audio_filename: f,
      audio_path: `${sourceKind}/${f}`,
      text,
      lang: lineLang,
      matched: true,
      duration: 0,
      confidence: conf && typeof conf.confidence === 'number' ? conf.confidence : null,
    });
  });
  fs.writeFileSync(listPath, lines.join('\n') + '\n', 'utf-8');

  // 置信度旁车：与 <kind>.list 同目录同名（<kind>.conf.json），键为片段文件名。
  try {
    const confPath = path.join(outDir, listName.replace(/\.list$/i, '.conf.json'));
    fs.writeFileSync(confPath, JSON.stringify(confOut), 'utf-8');
  } catch (e) {
    log(`WARN: failed to write confidence sidecar: ${e.message}`);
  }

  // 清理临时 asr_raw 子目录
  try { fs.rmSync(rawAsrDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  log(`ASR done: ${listName} (${segments.length} entries, paths rewritten as ${sourceKind}/)`);
  return { listPath, listName, sourceKind, segments };
}

/**
 * Pipeline 步骤入口。来源感知：切片存在→slicer_opt，否则→raw。
 */
async function run(ctx, log) {
  const { workDir, language, config, voiceId } = ctx;

  // 来源感知：切片存在→slicer_opt，否则→raw（统一由共享解析器决定，去 passthrough）
  const { sourceKind, srcDir } = resolveAudioSource(ctx);
  if (!sourceKind) throw new Error('ASR: no recognizable audio source found (neither slices nor raw)');

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
