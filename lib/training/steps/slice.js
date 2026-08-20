/**
 * Step 2: 语音切片 (Audio Slicing)
 *
 * 调用 slicer2.py，将长音频按静音切分成短片段
 * 使用项目自带的 pipeline/slicer/slicer2.py + 项目 venv 的 Python
 */

const path = require('path');
const fs = require('fs');
const PATHS = require('../../paths');
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');

async function run(ctx, log) {
  const { inputDir, workDir, config } = ctx;
  const params = config.steps.slice.params;

  const python = getPythonPath();
  if (!fs.existsSync(python)) {
    throw new Error(`Python not found: ${python}`);
  }

  const srcDir = fs.existsSync(path.join(workDir, 'denoise'))
    ? path.join(workDir, 'denoise')
    : inputDir;

  const outputDir = path.join(workDir, 'slicer_opt');
  fs.mkdirSync(outputDir, { recursive: true });

  const script = path.join(PATHS.SLICER_DIR, 'slicer2.py');
  const files = fs.readdirSync(srcDir).filter(f =>
    /\.(wav|mp3|flac)$/i.test(f)
  );

  if (files.length === 0) {
    throw new Error('No audio files to slice');
  }

  // 去 passthrough：不切片模式不再把 raw 伪装拷入 slicer_opt。"不切片"= 该步禁用
  // (stepOptions.slice=false)，下游 asr/preprocess/finalize 会走 raw 分支并产出
  // raw_opt.list。资产至少有 raw 或切片一种参考音频（由 slice||copyRaw 不变式保证）。

  log(`Audio slicing: input=${srcDir}, output=${outputDir}`);
  log(`Python: ${python}`);

  const minLengthMs = params.min_duration_sec * 1000;
  const minIntervalMs = params.min_silence_sec * 1000;
  const maxSilKeptMs = 500;

  if (ctx.isCancelled && ctx.isCancelled()) {
    throw new Error('cancelled');
  }

  log(`${files.length} audio file(s), single-process batch slicing...`);

  // 一次进程处理整个文件夹：librosa 只导入一次，省掉 N-1 次启动开销
  const result = await spawnAsync(python, [
    script,
    '--in_dir', srcDir,
    '--out', outputDir,
    '--db_thresh', String(params.silence_threshold_db),
    '--min_length', String(minLengthMs),
    '--min_interval', String(minIntervalMs),
    '--hop_size', '10',
    '--max_sil_kept', String(maxSilKeptMs),
  ], {
    timeout: 1800000, // 30 分钟，整批
    env: getCleanEnv(),
    onChild: (child) => ctx.setChild(child),
    onStdout: (s) => log(`[slicer] ${s.trimEnd()}`),
    onStderr: (s) => log(`[slicer:err] ${s.trimEnd()}`),
  });

  if (result.status !== 0 && result.error !== 'killed') {
    throw new Error(`Slicing failed (exit ${result.status}): ${(result.stderr || '').slice(-300)}`);
  }

  const totalSlices = fs.readdirSync(outputDir).filter(ff => ff.endsWith('.wav')).length;
  log(`Audio slicing done, ${totalSlices} slice(s) total`);
  return { outputDir, fileCount: totalSlices };
}

module.exports = { run };
