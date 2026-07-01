/**
 * Step 2: 语音切片 (Audio Slicing)
 *
 * 调用 slicer2.py，将长音频按静音切分成短片段
 * 使用项目自带的 gsv-tools/slicer2.py + 项目 venv 的 Python
 */

const path = require('path');
const fs = require('fs');
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

  const script = path.join(__dirname, '..', 'gsv-tools', 'slicer2.py');
  const files = fs.readdirSync(srcDir).filter(f =>
    /\.(wav|mp3|flac)$/i.test(f)
  );

  if (files.length === 0) {
    throw new Error('没有音频文件需要切片');
  }

  // Passthrough (恒等切片): 当不适合切片 / 用户选择不切片时，把源音频原样拷入
  // slicer_opt/。这样 slicer_opt 永远是"参考片段的唯一真相源"，下游 asr /
  // segments / finalize 全部按 slicer_opt 统一处理，无需为 raw 单独分支，也修掉了
  // "不切片训练 → slicer_opt 缺失 → 发布出的 segments 指向不存在文件"的隐性 bug。
  const passthrough = !!(ctx.stepOptions && ctx.stepOptions.slicePassthrough);
  if (passthrough) {
    log(`语音切片[passthrough]: 源=${srcDir} 原样拷入 ${outputDir}（不切片）`);
    let copied = 0;
    for (const f of files) {
      if (ctx.isCancelled && ctx.isCancelled()) throw new Error('cancelled');
      fs.copyFileSync(path.join(srcDir, f), path.join(outputDir, f));
      copied++;
    }
    log(`passthrough 完成，共 ${copied} 个源文件原样入 slicer_opt`);
    return { outputDir, fileCount: copied, passthrough: true };
  }

  log(`语音切片: 输入=${srcDir}, 输出=${outputDir}`);
  log(`Python: ${python}`);

  const minLengthMs = params.min_duration_sec * 1000;
  const minIntervalMs = params.min_silence_sec * 1000;
  const maxSilKeptMs = 500;

  if (ctx.isCancelled && ctx.isCancelled()) {
    throw new Error('cancelled');
  }

  log(`共 ${files.length} 个音频，单进程批量切片...`);

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
    throw new Error(`切片失败 (exit ${result.status}): ${(result.stderr || '').slice(-300)}`);
  }

  const totalSlices = fs.readdirSync(outputDir).filter(ff => ff.endsWith('.wav')).length;
  log(`语音切片完成，共 ${totalSlices} 个切片`);
  return { outputDir, fileCount: totalSlices };
}

module.exports = { run };
