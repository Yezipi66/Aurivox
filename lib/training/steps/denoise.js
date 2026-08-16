/**
 * Step 1: 人声提取 / 分离 (Vocal Separation) — multi-stage pipeline.
 *
 * Reads config.steps.denoise.params.pipeline = [{ model:<id>, agg?:<int> }, ...]
 * and runs each stage in order, feeding stage N output into stage N+1. This
 * mirrors the official "先 MDX-Net 再 DeEcho-Aggressive" chaining. Each stage
 * reuses the headless uvr5_cli.py with the stage resolved weight + agg.
 *
 * Legacy: an old recipe carrying params.model (a single string) is coerced to a
 * one-stage pipeline via uvr5_models.normalizePipeline, preserving behaviour.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const PATHS = require('../../paths');
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');
const uvr5 = require('../../../vendor/gsv-tools/uvr5/uvr5_models');

// Per-stage subprocess timeout (ms). UVR5 separation can be slow — especially
// MDX-Net / Roformer, on CPU (non-CUDA) devices, or with long full-song inputs —
// so the default is generous (30 min) and overridable via UVR5_STAGE_TIMEOUT_MS.
const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
function resolveStageTimeoutMs() {
  const raw = process.env.UVR5_STAGE_TIMEOUT_MS;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_STAGE_TIMEOUT_MS;
}
const STAGE_TIMEOUT_MS = resolveStageTimeoutMs();

// Best-effort CUDA probe (synchronous, one-off). Returns true/false, or null when
// unknown (probe failed). Runs OUTSIDE spawn_async on purpose so it stays cheap and
// does not interfere with the stage-spawn accounting relied on by unit tests.
function cudaAvailable(python, env) {
  try {
    const out = execFileSync(
      python,
      ['-c', 'import torch,sys; sys.stdout.write("1" if torch.cuda.is_available() else "0")'],
      { env, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return String(out).trim().endsWith('1');
  } catch (_) {
    return null; // torch import / probe failed — stay quiet rather than false-alarm
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

// Locate torch's bundled native lib dir (…/site-packages/torch/lib). torch (cu121)
// ships the CUDA runtime + cuDNN 8 DLLs there; onnxruntime's CUDAExecutionProvider
// needs them on the DLL search path, otherwise it fails to load
// onnxruntime_providers_cuda.dll (Windows LoadLibrary error 126) and MDX-Net
// silently falls back to CPU. torch's own os.add_dll_directory does NOT cover
// onnxruntime, so we must add the dir to PATH ourselves for the child process.
function getTorchLibDir() {
  try {
    const python = getPythonPath();
    if (!path.isAbsolute(python)) return null;
    const venvRoot = path.dirname(path.dirname(python)); // <python.exe> -> Scripts -> venv
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
  // torch's CUDA/cuDNN DLLs first, so onnxruntime (MDX-Net) can run on GPU.
  const torchLib = getTorchLibDir();
  if (torchLib) prepend.push(torchLib);
  // vendored ffmpeg (transcode + mp3/m4a decode fallback).
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
    // Intermediate + final stage output stays WAV: the vocal track feeds ASR /
    // slicing downstream, which require lossless PCM. Output format is therefore
    // NOT a user knob inside the training pipeline.
    '--format', 'wav',
  ];
  if (model.aggApplicable && stage.agg != null) {
    args.push('--agg', String(stage.agg));
  }

  // Expert knobs — only emit the ones applicable to this model's architecture
  // (uvr5_models.normalizePipeline already stripped inapplicable params).
  // `precision` maps to the existing --is_half flag.
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

// After vocal extraction, the SEPARATED vocal (workDir/denoise) becomes the effective
// "raw" that feeds slice → ASR → training. The ORIGINAL pre-extraction mixdown lives
// only in the caller-owned inputDir (outside the workspace), which the user may later
// move/delete — so the .staging task isn't self-contained for audit/reconstruction.
// We snapshot the originals into workDir/raw_b4_extraction/ once, before running, so the
// task keeps BOTH "what went in" and "what came out". Opt out with UVR5_KEEP_RAW=0.
function preserveOriginals(inputDir, workDir, files, log, keepFlag) {
  // Opt out via the UI checkbox (stepOptions.keepRawB4Extraction === false) or the
  // UVR5_KEEP_RAW=0 env override. Default (undefined) keeps the snapshot.
  if (keepFlag === false) return;
  if (String(process.env.UVR5_KEEP_RAW || '1') === '0') return;
  const rawDir = path.join(workDir, 'raw_b4_extraction');
  fs.mkdirSync(rawDir, { recursive: true });
  let copied = 0;
  for (const f of files) {
    const dst = path.join(rawDir, f);
    if (fs.existsSync(dst)) continue;  // resume/fork: already snapshotted
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
  // Weights dir is the shipped location by default; overridable for tests.
  const weightsDir = (config && config.uvr5WeightsDir) || PATHS.UVR5_WEIGHTS_DIR;
  const cwd = PATHS.UVR5_DIR;
  const stageCtx = { python, script, weightsDir, cwd };

  log(`Vocal extraction: input=${inputDir}, output=${finalDir}`);
  log(`Python: ${python}`);
  log(`Pipeline (${pipeline.length} stage${pipeline.length > 1 ? 's' : ''}): ` +
    pipeline.map((s) => s.model + (s.agg != null ? `@${s.agg}` : '')).join(' -> '));
  log(`Per-stage timeout: ${Math.round(STAGE_TIMEOUT_MS / 60000)} min ` +
    `(override with env UVR5_STAGE_TIMEOUT_MS, in milliseconds)`);

  // Warn early when there's no CUDA GPU: UVR5 separation on CPU (or any non-CUDA
  // device) can be extremely slow, so users know to expect long waits up front.
  if (cudaAvailable(python, buildChildEnv()) === false) {
    log('WARNING: no CUDA (GPU) detected — vocal separation will run on CPU and can be ' +
      'VERY slow. MDX-Net / Roformer are especially compute-heavy; a long clip or full ' +
      'song may take tens of minutes. (Only validated on NVIDIA/CUDA; non-CUDA devices ' +
      'such as AMD / Intel Arc are untested.)');
  }

  fs.mkdirSync(finalDir, { recursive: true });

  // Snapshot the pre-extraction originals so the task is self-contained (see helper).
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
