/**
 * Step 1: 去人声 (Vocal Separation)
 *
 * 调用 UVR5 工具，从原始音频中分离人声
 * 使用项目自带的 gsv-tools/uvr5/ + 项目 venv 的 Python
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');

/**
 * 解析项目自带的 vendor ffmpeg 目录（由 download_ffmpeg.py provision）。
 * uvr5_cli.py 通过裸命令 `ffprobe` / `ffmpeg` 探测并重采样音频，这两个二进制
 * 既不在系统 PATH 也不在 venv 里，只在 vendor/ffmpeg/<platform>/。我们把该目录
 * 前置进子进程 PATH，让 UVR5 能找到它们。不碰全局 PATH。
 */
function getVendorFfmpegDir() {
  let platKey;
  if (process.platform === 'win32') {
    platKey = 'windows-x86_64';
  } else if (process.platform === 'darwin') {
    platKey = os.arch() === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64';
  } else {
    platKey = os.arch() === 'arm64' ? 'linux-aarch64' : 'linux-x86_64';
  }
  // __dirname = lib/training/steps → 3 层 .. 回到项目根
  return path.resolve(__dirname, '..', '..', '..', 'vendor', 'ffmpeg', platKey);
}

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

  // webui.py 是 GPT-SoVITS 原版 gradio 网页应用（启动 web 服务、按位置读 argv、
  // import 时 os.listdir 硬编码相对路径），从来不是批处理 CLI。改用项目自带的
  // 无头 CLI uvr5_cli.py，它复用同一套分离器（AudioPre/MDX/Roformer），接受
  // --model/--input/--output 并把人声写入输出目录。
  const script = path.join(__dirname, '..', 'gsv-tools', 'uvr5', 'uvr5_cli.py');
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
      //
      // 另外：uvr5_cli.py 用裸命令 ffprobe/ffmpeg 探测并重采样音频，需要它们在 PATH 上。
      // 把项目自带的 vendor/ffmpeg/<platform>/ 目录前置进子进程 PATH（大小写无关，
      // 复用 getCleanEnv 已归并的单一 PATH 键），使 UVR5 能定位这两个二进制。
      env: (() => {
        const e = getCleanEnv({
          PYTHONPATH: path.join(__dirname, '..', 'gsv_code'),
        });
        const ffmpegDir = getVendorFfmpegDir();
        const pathKey = Object.keys(e).find((k) => k.toLowerCase() === 'path') || 'PATH';
        e[pathKey] = ffmpegDir + path.delimiter + (e[pathKey] || '');
        return e;
      })(),
    });

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const logPath = path.join(outputDir, 'uvr5_cli.log');

    if (result.status !== 0) {
      // uvr5_cli.py 把每个文件的失败原因 + `==== UVR5 ERRORS ====` 汇总块打到
      // STDOUT（不是 stderr！stderr 只有 numpy/librosa 的无害警告）。之前只回显
      // stderr，导致报错里全是警告、看不到真因。这里优先带上 stdout 尾部（含汇总块），
      // 再附 stderr 尾部与完整日志路径，让失败一眼可读。
      throw new Error(
        `UVR5 返回非零退出码 ${result.status}:\n` +
        `--- 关键输出(stdout, 含失败清单) ---\n${stdout.slice(-4000)}\n` +
        `--- 警告(stderr) ---\n${stderr.slice(-800)}\n` +
        `完整日志: ${logPath}`
      );
    }

    // 成功也可能有"被容忍丢弃"的文件（uvr5_cli.py 的 --max-fail-ratio）。若 stdout 里
    // 出现 DROPPED 块，抬升为 warning 级日志，确保用户明确知道少了哪些素材。
    if (/UVR5 DROPPED FILES/.test(stdout)) {
      const m = stdout.slice(stdout.indexOf('==== UVR5 DROPPED FILES'));
      log(`⚠ 部分音频被跳过（分离无有效结果，已从训练集剔除）。详见下方与日志 ${logPath}：`);
      log(m.slice(0, 2000));
    }
    log(`去人声完成: ${stdout ? stdout.slice(-200) : 'ok'}`);
  } catch (err) {
    throw new Error(`UVR5 执行失败: ${err.message}`);
  }

  const outFiles = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  return { outputDir, fileCount: outFiles.length };
}

module.exports = { run };
