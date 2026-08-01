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
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');
const uvr5 = require('../gsv-tools/uvr5/uvr5_models');

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

function buildChildEnv() {
  const e = getCleanEnv({ PYTHONPATH: path.join(__dirname, '..', 'gsv_code') });
  const ffmpegDir = getVendorFfmpegDir();
  const pathKey = Object.keys(e).find((k) => k.toLowerCase() === 'path') || 'PATH';
  e[pathKey] = ffmpegDir + path.delimiter + (e[pathKey] || '');
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
    timeout: 600000,
    env: buildChildEnv(),
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const logPath = path.join(outputDir, 'uvr5_cli.log');

  if (result.status !== 0) {
    throw new Error(
      `UVR5 stage ${stageIdx + 1} (${stage.model}) 返回非零退出码 ${result.status}:\n` +
      `--- 关键输出(stdout, 含失败清单) ---\n${stdout.slice(-4000)}\n` +
      `--- 警告(stderr) ---\n${stderr.slice(-800)}\n` +
      `完整日志: ${logPath}`
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

async function run(ctx, log) {
  const { inputDir, workDir, config } = ctx;
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

  const script = path.join(__dirname, '..', 'gsv-tools', 'uvr5', 'uvr5_cli.py');
  // Weights dir is the shipped location by default; overridable for tests.
  const weightsDir = (config && config.uvr5WeightsDir)
    || path.join(__dirname, '..', 'gsv-tools', 'uvr5', 'uvr5_weights');
  const cwd = path.join(__dirname, '..', 'gsv-tools', 'uvr5');
  const stageCtx = { python, script, weightsDir, cwd };

  log(`Vocal extraction: input=${inputDir}, output=${finalDir}`);
  log(`Python: ${python}`);
  log(`Pipeline (${pipeline.length} stage${pipeline.length > 1 ? 's' : ''}): ` +
    pipeline.map((s) => s.model + (s.agg != null ? `@${s.agg}` : '')).join(' -> '));

  fs.mkdirSync(finalDir, { recursive: true });

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
