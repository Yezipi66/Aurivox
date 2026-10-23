// 训练第 1 步：人声提取（Vocal Separation），多阶段流水线。
//
// 读 config.steps.denoise.params.pipeline = [{ model:<id>, agg?:<int> }, ...]，
// 按顺序逐级执行，每一级的输出作为下一级的输入。每级都调用无界面的 uvr5_cli.py，
// 参数是本级解析出的权重与 agg。
// 输出格式固定为 WAV：人声轨要喂给下游的切片与 ASR，那些环节要求无损 PCM，
// 所以格式不是训练流水线里的用户选项。
// 单个 params.model（字符串）的老配方由 uvr5_models.normalizePipeline 归一为单级流水线。

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const PATHS = require('../../paths');
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');
const uvr5 = require('../../../pipeline/uvr5/uvr5_models');

// 单级子进程超时（毫秒）。人声分离很慢：MDX-Net 与 Roformer 在 CPU 上尤其慢，
// 长音频输入更慢，所以默认给到 30 分钟，可用 UVR5_STAGE_TIMEOUT_MS 覆盖。
const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟
function resolveStageTimeoutMs() {
  const raw = process.env.UVR5_STAGE_TIMEOUT_MS;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_STAGE_TIMEOUT_MS;
}
const STAGE_TIMEOUT_MS = resolveStageTimeoutMs();

// CUDA 探测尽力而为（同步，只做一次）。返回 true / false，探测失败时返回 null。
// 放在 spawn_async 之外是刻意的：这样它不干扰单元测试依赖的子进程调用计数。
function cudaAvailable(python, env) {
  try {
    const out = execFileSync(
      python,
      ['-c', 'import torch,sys; sys.stdout.write("1" if torch.cuda.is_available() else "0")'],
      { env, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return String(out).trim().endsWith('1');
  } catch (_) {
    return null; // torch 导入或探测失败：不报为「没有 CUDA」，保持不确定
  }
}

function getVendorFfmpegDir() {
  let platKey;
  if (process.platform === 'win32') {
    platKey = 'windows-x86_64';
  } else if (process.platform === 'darwin') {
    platKey = os.arch() === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64';
  } else {
    platKey = os.arch() === 'arm64' ? 'linux-aarch64' : 'linux-x86_64';
  }
  return path.resolve(__dirname, '..', '..', '..', 'vendor', 'ffmpeg', platKey);
}

// 定位 torch 自带的原生库目录（…/site-packages/torch/lib）。torch 的 CUDA 运行时与
// cuDNN 8 的 DLL 就在那里；onnxruntime 的 CUDAExecutionProvider 需要在 DLL 搜索路径上
// 才能找到它们，否则加载 onnxruntime_providers_cuda.dll 失败（Windows LoadLibrary 错误 126），
// MDX-Net 会静默退回 CPU。torch 自己的 os.add_dll_directory 管不到 onnxruntime，
// 所以必须由这里把该目录加进子进程的 PATH。
function getTorchLibDir() {
  try {
    const python = getPythonPath();
    if (!path.isAbsolute(python)) return null;
    const venvRoot = path.dirname(path.dirname(python)); // <python.exe> 上溯两级是 venv 根
    const candidates = [];
    if (process.platform === 'win32') {
      candidates.push(path.join(venvRoot, 'Lib', 'site-packages', 'torch', 'lib'));
    } else {
      const libDir = path.join(venvRoot, 'lib');
      if (fs.existsSync(libDir)) {
        for (const d of fs.readdirSync(libDir)) {
          if (/^python/i.test(d)) {
            candidates.push(path.join(libDir, d, 'site-packages', 'torch', 'lib'));
          }
        }
      }
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  } catch (_) { /* best-effort */ }
  return null;
}

function buildChildEnv() {
  const e = getCleanEnv({ PYTHONPATH: PATHS.GSV_CODE_DIR });
  const pathKey = Object.keys(e).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const prepend = [];
  // torch 的 CUDA/cuDNN DLL 放在最前，让 onnxruntime（MDX-Net）能用 GPU。
  const torchLib = getTorchLibDir();
  if (torchLib) prepend.push(torchLib);
  // 自带的 ffmpeg（转码与 mp3/m4a 解码兜底）。
  prepend.push(getVendorFfmpegDir());
  e[pathKey] = prepend.join(path.delimiter) + path.delimiter + (e[pathKey] || '');
  return e;
}

async function runStage(stage, stageIdx, totalStages, inputDir, outputDir, sctx, log) {
  const { python, script, weightsDir, cwd } = sctx;
  const model = uvr5.getModel(stage.model);
  if (!model) throw new Error(`Unknown UVR5 model id: ${stage.model}`);

  const missing = uvr5.missingFiles(weightsDir, stage.model);
  if (missing.length) {
    throw new Error(
      `UVR5 model "${stage.model}" is not installed. Missing file(s):\n` +
      missing.map((f) => `  - ${path.join(weightsDir, f)}`).join('\n') +
      `\nDownload it from the Vocal Extraction panel (Download model), or run ` +
      `download_uvr5.py --model ${stage.model}.`
    );
  }

  const modelArg = uvr5.resolveWeightArg(weightsDir, stage.model);
  const args = [
    script,
    '--model', modelArg,
    '--input', inputDir,
    '--output', outputDir,
    // 中间级与最终级的输出都是 WAV：人声轨要喂给下游的切片与 ASR，那些环节要求
    // 无损 PCM，所以输出格式不是训练流水线里的用户选项。
    '--format', 'wav',
  ];
  if (model.aggApplicable && stage.agg != null) {
    args.push('--agg', String(stage.agg));
  }

  // 专家参数：只传本模型架构适用的那些
  // （uvr5_models.normalizePipeline 已经剔掉不适用的参数）。
  // `precision` 对应已有的 --is_half 开关。
  if (stage.precision != null) {
    args.push('--is_half', stage.precision === 'fp16' ? 'true' : 'false');
  }
  if (stage.tta != null) args.push('--tta', stage.tta ? 'true' : 'false');
  if (stage.postprocess != null) args.push('--postprocess', stage.postprocess ? 'true' : 'false');
  if (stage.highEnd != null) args.push('--high-end', String(stage.highEnd));
  if (stage.chunks != null) args.push('--chunks', String(stage.chunks));
  if (stage.overlap != null) args.push('--overlap', String(stage.overlap));
  if (stage.batchSize != null) args.push('--batch-size', String(stage.batchSize));

  fs.mkdirSync(outputDir, { recursive: true });
  const expertDesc = uvr5.expertParamsFor(model.arch)
    .filter((k) => stage[k] != null)
    .map((k) => `${k}=${stage[k]}`)
    .join(', ');
  log(`[denoise] stage ${stageIdx + 1}/${totalStages}: ${stage.model}` +
    (model.aggApplicable ? ` (agg=${stage.agg})` : '') +
    (expertDesc ? ` [${expertDesc}]` : '') +
    ` — ${inputDir} -> ${outputDir}`);

  const result = await spawnAsync(python, args, {
    cwd,
    timeout: STAGE_TIMEOUT_MS,
    env: buildChildEnv(),
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const logPath = path.join(outputDir, 'uvr5_cli.log');

  if (result.status !== 0) {
    throw new Error(
      `UVR5 stage ${stageIdx + 1} (${stage.model}) exited with non-zero code ${result.status}:\n` +
      `--- key output (stdout, incl. failure list) ---\n${stdout.slice(-4000)}\n` +
      `--- warnings (stderr) ---\n${stderr.slice(-800)}\n` +
      `full log: ${logPath}`
    );
  }

  if (/UVR5 DROPPED FILES/.test(stdout)) {
    const m = stdout.slice(stdout.indexOf('==== UVR5 DROPPED FILES'));
    log(`⚠ Some audio was skipped during stage ${stageIdx + 1} (${stage.model}); removed from the set. See ${logPath}:`);
    log(m.slice(0, 2000));
  }
  log(`[denoise] stage ${stageIdx + 1} done: ${stdout ? stdout.slice(-160) : 'ok'}`);

  const produced = fs.existsSync(outputDir)
    ? fs.readdirSync(outputDir).filter((f) => f !== 'uvr5_cli.log')
    : [];
  if (produced.length === 0) {
    throw new Error(`UVR5 stage ${stageIdx + 1} (${stage.model}) produced no output files.`);
  }
  return produced.length;
}

// 人声提取之后，分离出的人声（workDir/denoise）成为切片、ASR 与训练真正吃的「原始素材」。
// 提取前的原始混音只存在于调用方持有的 inputDir（工作区之外），用户之后可能移动或删除它，
// 于是这个任务对审计与重建并不自足。
// 所以运行前把原件一次性快照到 workDir/raw_b4_extraction/，任务同时保留「进去的」与
// 「出来的」。用 UVR5_KEEP_RAW=0 可以关闭。
function preserveOriginals(inputDir, workDir, files, log, keepFlag) {
  // 关闭方式：界面复选框（stepOptions.keepRawB4Extraction === false）或环境变量
  // UVR5_KEEP_RAW=0。默认（未指定）保留快照。
  if (keepFlag === false) return;
  if (String(process.env.UVR5_KEEP_RAW || '1') === '0') return;
  const rawDir = path.join(workDir, 'raw_b4_extraction');
  fs.mkdirSync(rawDir, { recursive: true });
  let copied = 0;
  for (const f of files) {
    const dst = path.join(rawDir, f);
    if (fs.existsSync(dst)) continue;  // 续跑或分叉时已经快照过
    try {
      fs.copyFileSync(path.join(inputDir, f), dst);
      copied++;
    } catch (e) {
      log(`WARNING: could not preserve original ${f} -> raw_b4_extraction (${e.message})`);
    }
  }
  if (copied > 0) {
    log(`Preserved ${copied} original file(s) before extraction: ${rawDir} ` +
      `(the separated vocals in denoise/ are the training input; set UVR5_KEEP_RAW=0 to skip)`);
  }
}

async function run(ctx, log) {
  const { inputDir, workDir, config, stepOptions } = ctx;
  const params = (config.steps.denoise && config.steps.denoise.params) || {};
  const finalDir = path.join(workDir, 'denoise');
  const python = getPythonPath();

  if (!fs.existsSync(python)) {
    throw new Error(`Python not found: ${python}`);
  }

  const pipeline = uvr5.normalizePipeline(
    Array.isArray(params.pipeline) ? params.pipeline : params
  );
  if (pipeline.length === 0) {
    throw new Error(
      'Vocal extraction is enabled but no valid model pipeline was provided ' +
      '(params.pipeline is empty). Disable the step or choose a preset/model.'
    );
  }

  const files = fs.existsSync(inputDir)
    ? fs.readdirSync(inputDir).filter((f) => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f))
    : [];
  if (files.length === 0) {
    throw new Error('No audio files in the input directory');
  }

  const script = path.join(PATHS.UVR5_DIR, 'uvr5_cli.py');
  // 权重目录默认取随发行版附带的位置，测试可覆盖。
  const weightsDir = (config && config.uvr5WeightsDir) || PATHS.UVR5_WEIGHTS_DIR;
  const cwd = PATHS.UVR5_DIR;
  const stageCtx = { python, script, weightsDir, cwd };

  log(`Vocal extraction: input=${inputDir}, output=${finalDir}`);
  log(`Python: ${python}`);
  log(`Pipeline (${pipeline.length} stage${pipeline.length > 1 ? 's' : ''}): ` +
    pipeline.map((s) => s.model + (s.agg != null ? `@${s.agg}` : '')).join(' -> '));
  log(`Per-stage timeout: ${Math.round(STAGE_TIMEOUT_MS / 60000)} min ` +
    `(override with env UVR5_STAGE_TIMEOUT_MS, in milliseconds)`);

  // 尽早提示没有 CUDA：人声分离在 CPU（任何非 CUDA 设备）上可能非常慢，
  // 让用户事先知道要等很久。
  if (cudaAvailable(python, buildChildEnv()) === false) {
    log('WARNING: no CUDA (GPU) detected — vocal separation will run on CPU and can be ' +
      'VERY slow. MDX-Net / Roformer are especially compute-heavy; a long clip or full ' +
      'song may take tens of minutes. (Only validated on NVIDIA/CUDA; non-CUDA devices ' +
      'such as AMD / Intel Arc are untested.)');
  }

  fs.mkdirSync(finalDir, { recursive: true });

  // 提取前先把原件快照下来，让任务自足（见 preserveOriginals）。
  preserveOriginals(inputDir, workDir, files, log,
    stepOptions ? stepOptions.keepRawB4Extraction : undefined);

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uvr5-chain-'));
  try {
    let currentInput = inputDir;
    for (let i = 0; i < pipeline.length; i++) {
      const isLast = i === pipeline.length - 1;
      const outDir = isLast ? finalDir : path.join(scratchRoot, `stage-${i + 1}`);
      // eslint-disable-next-line no-await-in-loop
      await runStage(pipeline[i], i, pipeline.length, currentInput, outDir, stageCtx, log);
      currentInput = outDir;
    }
  } catch (err) {
    throw new Error(`UVR5 execution failed: ${err.message}`);
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  const outFiles = fs.existsSync(finalDir) ? fs.readdirSync(finalDir) : [];
  return { outputDir: finalDir, fileCount: outFiles.length };
}

module.exports = { run };
