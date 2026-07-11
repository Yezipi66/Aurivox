/**
 * Step 1: 去人声 (Vocal Separation)
 *
 * 调用 UVR5 工具，从原始音频中分离人声
 * 使用项目自带的 gsv-tools/uvr5/ + 项目 venv 的 Python
 */

const path = require('path');
const fs = require('fs');
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');

async function run(ctx, log) {
  const { inputDir, workDir, config } = ctx;
  const params = config.steps.denoise.params;
  const outputDir = path.join(workDir, 'denoise');
  const python = getPythonPath();

  if (!fs.existsSync(python)) {
    throw new Error(`Python not found: ${python}`);
  }

  log(`去人声: 输入=${inputDir}, 输出=${outputDir}`);
  log(`Python: ${python}`);

  fs.mkdirSync(outputDir, { recursive: true });

  const files = fs.readdirSync(inputDir).filter(f =>
    /\.(wav|mp3|flac|m4a|ogg)$/i.test(f)
  );

  if (files.length === 0) {
    throw new Error('输入目录中没有音频文件');
  }

  const script = path.join(__dirname, '..', 'gsv-tools', 'uvr5', 'webui.py');
  const weightsDir = path.join(__dirname, '..', 'gsv-tools', 'uvr5', 'uvr5_weights');
  const modelName = params.model === 'mdx-net' ? 'HP2_all_vocals.pth' : params.model;
  const modelPath = path.join(weightsDir, modelName);

  if (!fs.existsSync(modelPath)) {
    throw new Error(`UVR5 模型文件不存在: ${modelPath}`);
  }

  log(`运行 UVR5: ${python} ${script} --model ${modelPath} --input ${inputDir} --output ${outputDir}`);

  try {
    const result = await spawnAsync(python, [
      script,
      '--model', modelPath,
      '--input', inputDir,
      '--output', outputDir,
    ], {
      cwd: path.join(__dirname, '..', 'gsv-tools', 'uvr5'),
      timeout: 600000,
      // bug.md 方案A: webui.py 在 gsv-tools/uvr5/ 下运行，Python 的 sys.path[0]
      // 指向该目录，找不到位于 lib/training/gsv_code/tools/ 的 tools 包
      // (ModuleNotFoundError: No module named 'tools')。getCleanEnv 会删除继承的
      // PYTHONPATH，但 extra 传入的值会覆盖回来，把 gsv_code/ 加入 sys.path，
      // 使 `from tools.i18n.i18n import I18nAuto` 可解析。只改调用方 env，不碰 vendor。
      env: getCleanEnv({
        PYTHONPATH: path.join(__dirname, '..', 'gsv_code'),
      }),
    });

    if (result.status !== 0) {
      const stderr = result.stderr || '';
      throw new Error(`UVR5 返回非零退出码 ${result.status}: ${stderr.slice(-500)}`);
    }

    log(`去人声完成: ${result.stdout ? result.stdout.slice(-200) : 'ok'}`);
  } catch (err) {
    throw new Error(`UVR5 执行失败: ${err.message}`);
  }

  const outFiles = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  return { outputDir, fileCount: outFiles.length };
}

module.exports = { run };
