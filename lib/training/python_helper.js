/**
 * 获取项目 Python 路径 + 构造隔离到 venv 的干净环境
 */
const fs = require('fs');
const path = require('path');

const paths = require('../paths');

const PYTHON_CONFIG = path.join(__dirname, 'python.json');

// __dirname = <root>/lib/training → 项目根在上两级。
// 所有 Python 解析都以【当前项目根】为基准，这样整个文件夹可以自由
// 移动/改名/换盘符，不会因为烤死的绝对路径而失效。
// 项目根一律取自 lib/paths.js，不在此处按 __dirname 数目录层数（引擎契约 C7）。
const PROJECT_ROOT = paths.APP_DIR;

// 项目自带 / 部署时创建的解释器，全部相对项目根解析：
//   1) 部署创建的 venv
//   2) 内嵌可迁移运行时 (tools/runtime/python)
function _pythonCandidates() {
  const isWin = process.platform === 'win32';
  if (isWin) {
    return [
      path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe'),
      path.join(PROJECT_ROOT, 'tools', 'runtime', 'python', 'python.exe'),
    ];
  }
  return [
    path.join(PROJECT_ROOT, 'venv', 'bin', 'python'),
    path.join(PROJECT_ROOT, 'tools', 'runtime', 'python', 'bin', 'python3'),
  ];
}

// 解析项目自带的 ffmpeg 目录（vendor/ffmpeg/<platform>/），与 broker 端
// lib/audio/ffmpeg.js 的 vendoredFfmpegPath 同源。返回目录（非可执行文件），
// 供 getCleanEnv 将其前置到子进程 PATH。
function _vendorFfmpegDir() {
  const isWin = process.platform === 'win32';
  const arch = process.arch;
  const bin = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  let keys = [];
  if (isWin) keys = ['windows-x86_64'];
  else if (process.platform === 'linux') keys = [arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64'];
  else if (process.platform === 'darwin') keys = [arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64'];
  for (const k of keys) {
    const dir = path.join(PROJECT_ROOT, 'vendor', 'ffmpeg', k);
    try { if (fs.existsSync(path.join(dir, bin))) return dir; } catch (e) {}
  }
  return null;
}

function getPythonPath() {
  // 1. 尊重 python.json，但：始终把相对值重新锚定到【当前】项目根，并剥掉
  //    可能被误加的前后引号(曾导致 No Python at '"D:\...python.exe' 这类
  //    路径里带引号的 bug)。若它是一个【已不存在】的绝对路径——典型的
  //    “项目被移动过”或非英文路径被破坏的情况——则忽略它，改用下面的
  //    相对候选，从而让移动项目后依然能找到 Python。
  try {
    if (fs.existsSync(PYTHON_CONFIG)) {
      const cfg = JSON.parse(fs.readFileSync(PYTHON_CONFIG, 'utf-8'));
      let p = (cfg.python || '').trim().replace(/^["']+|["']+$/g, '');
      if (p) {
        if (!path.isAbsolute(p)) p = path.resolve(PROJECT_ROOT, p);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (e) {}

  // 2. 项目相对解释器：先 venv，再内嵌 runtime。
  for (const cand of _pythonCandidates()) {
    if (fs.existsSync(cand)) return cand;
  }

  // 3. 兜底：返回期望的 venv 路径(让报错信息指向正确位置)，
  //    实在没有再退回 PATH 上的 python。
  return _pythonCandidates()[0] || 'python';
}

/**
 * 构造隔离到项目 venv 的干净环境变量。
 * - 清除可能污染 venv 解析的 PYTHONHOME / PYTHONPATH / conda 变量
 * - 前置 venv Scripts 到 PATH，确保 DLL / 子工具来自 venv
 * - PYTHONUNBUFFERED=1 让子进程输出实时刷出
 * - 允许调用方通过 extra 覆盖 / 追加
 */
function getCleanEnv(extra = {}) {
  const env = { ...process.env };

  // 移除会干扰 venv 解析的变量
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.PYTHONSTARTUP;
  // conda 残留
  delete env.CONDA_PREFIX;
  delete env.CONDA_DEFAULT_ENV;
  delete env.CONDA_PYTHON_EXE;

  // 把 venv 的 Scripts 目录前置到 PATH（大小写无关，避免 Windows 上 Path/PATH 重复键导致系统 PATH 丢失）
  const python = getPythonPath();
  if (path.isAbsolute(python)) {
    const venvBin = path.dirname(python);

    // 找到现有的 PATH 键（Windows 常见为 'Path'）；找不到则用 'PATH'
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const existing = env[pathKey] || '';

    // 删除所有大小写变体，统一只保留一个键
    for (const k of Object.keys(env)) {
      if (k.toLowerCase() === 'path') delete env[k];
    }
    env[pathKey] = venvBin + path.delimiter + existing;

    env.VIRTUAL_ENV = path.dirname(venvBin);
  }

  // 让 Python 子进程（torchaudio / FunASR / UVR5）也能找到项目自带 ffmpeg：
  // 把 vendor/ffmpeg/<platform>/ 前置到 PATH。否则 torchaudio 会提示
  // “ffmpeg is not installed” 并退回内置加载器，尽管项目里其实带了 ffmpeg。
  const ffdir = _vendorFfmpegDir();
  if (ffdir) {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = ffdir + path.delimiter + (env[pathKey] || '');
  }

  // 默认无缓冲，配合 onStdout 实时日志
  if (env.PYTHONUNBUFFERED === undefined) env.PYTHONUNBUFFERED = '1';

  // 强制 Python 以 UTF-8 输出，避免 Windows 下中文文件名在日志里乱码
  if (env.PYTHONUTF8 === undefined) env.PYTHONUTF8 = '1';
  if (env.PYTHONIOENCODING === undefined) env.PYTHONIOENCODING = 'utf-8';

  // --- 缓存：全部收进项目根的 cache/ ---------------------------------------
  // 此处是 Python 子进程环境的唯一注入点，因此也是缓存位置的唯一注入点。
  // 迁此之前 numba 缓存有四处定义两个值，而 HuggingFace / ModelScope /
  // torch hub 三个缓存全项目无人设置，默认落在 %USERPROFILE% —— 在项目之外，
  // 备份和清理都够不着（引擎契约 C9）。
  //
  // numba/librosa 防卡死：把缓存指向确定可写目录即可，不要禁用 JIT
  // （禁用 JIT 会破坏 resampy 的 @guvectorize，导致 librosa.resample 报 TypingError）
  const CACHE_ENV = {
    NUMBA_CACHE_DIR: paths.CACHE.numba,
    HF_HOME: paths.CACHE.hf,
    MODELSCOPE_CACHE: paths.CACHE.modelscope,
    TORCH_HOME: paths.CACHE.torch,
    GSV_DICT_CACHE_DIR: paths.CACHE.dict,
  };
  for (const [k, v] of Object.entries(CACHE_ENV)) {
    if (env[k] === undefined) {
      env[k] = v;
      fs.mkdirSync(v, { recursive: true });
    }
  }

  // --- 权重目录：由 lib/paths.js 下发，脚本不得自行推算 --------------------
  // 兜底逻辑仍留在各脚本里（上溯找 package.json），仅用于脱离本进程直接跑的场合。
  const MODEL_ENV = {
    MODELS_DIR: paths.MODELS_DIR,
    GSV_PRETRAINED_DIR: paths.GSV_PRETRAINED_DIR,
    FASTER_WHISPER_DIR: paths.FASTER_WHISPER_DIR,
    FUNASR_MODELS_DIR: paths.FUNASR_MODELS_DIR,
    UVR5_WEIGHTS_DIR: paths.UVR5_WEIGHTS_DIR,
    LANGDETECT_DIR: paths.PRETRAINED.langdetect,
    G2PW_DIR: paths.PRETRAINED.g2pw,
    SR_CKPT_DIR: paths.PRETRAINED.superRes,
    SV_CKPT_PATH: paths.PRETRAINED.svCkpt,
  };
  for (const [k, v] of Object.entries(MODEL_ENV)) {
    if (env[k] === undefined) env[k] = v;
  }

  return { ...env, ...extra };
}

module.exports = { getPythonPath, getCleanEnv };
