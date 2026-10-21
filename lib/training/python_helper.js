// 训练线的 Python 解释器解析，以及给子进程构造的隔离环境。
// 解释器判据是「按绝对路径真能起一次」，不是「文件在」：venv 的文件在，base 解释器可能指向别处。
const fs = require('fs');
const path = require('path');

const paths = require('../paths');
const { firstWorkingPython } = require('../util/pythonResolve');
// 名片的 runtime.python 与 python.json 都是虚拟环境目录，按平台推导可执行文件。
const { venvPythonRelPath } = require('../engines/platformPaths');

const PYTHON_CONFIG = path.join(__dirname, 'python.json');

// 所有 Python 解析都以【当前项目根】为基准，整个文件夹因此可以自由移动/改名/换盘符。
// 项目根一律取自 lib/paths.js，不按 __dirname 数目录层数（引擎契约 C7）。
const PROJECT_ROOT = paths.APP_DIR;

// 「训练线可用」的解释器候选：故意为空。平台根 venv 没有 torch 等训练依赖，拿它跑训练会报
// ModuleNotFoundError: torch，而真正的原因是本机没有能跑训练的环境。裸解释器不许出现在可用
// 候选里，只配出现在「报错指向哪」的兜底里。
function _pythonCandidates() {
  return [];
}

// 兜底：一个都没找到时，报错该指向哪里。顺序 = python.json 声明的 venv → 平台根 venv → 内嵌
// runtime。最后一项只是「总得有个路径」，不代表它能跑。
function _lastResortPath() {
  try {
    if (fs.existsSync(PYTHON_CONFIG)) {
      const cfg = JSON.parse(fs.readFileSync(PYTHON_CONFIG, 'utf-8'));
      const declared = (cfg.venv || cfg.python || '').trim().replace(/^["']+|["']+$/g, '');
      if (declared) {
        const abs = path.isAbsolute(declared) ? declared : path.resolve(PROJECT_ROOT, declared);
        return /[\\/](python|python3)(\.exe)?$/i.test(abs)
          ? abs
          : path.join(abs, venvPythonRelPath(process.platform));
      }
    }
  } catch (e) { /* 落到下面两层 */ }
  const isWin = process.platform === 'win32';
  return isWin
    ? path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe')
    : path.join(PROJECT_ROOT, 'tools', 'runtime', 'python', 'bin', 'python3');
}

// 解析项目自带的 ffmpeg 目录（vendor/ffmpeg/<platform>/），与 broker 端 lib/audio/ffmpeg.js 的
// vendoredFfmpegPath 同源。返回目录，不是可执行文件。
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
  // 1. 尊重 python.json：相对值重新锚定到【当前】项目根，剥掉可能被误加的前后引号
  //    （路径里带引号会让解释器报「找不到」）。写的是虚拟环境目录，按平台推导可执行文件。
  //    它指向的绝对路径已不存在时（项目被移动过）忽略它，改用下面的相对候选。
  try {
    if (fs.existsSync(PYTHON_CONFIG)) {
      const cfg = JSON.parse(fs.readFileSync(PYTHON_CONFIG, 'utf-8'));
      // venv 优先，其次兼容旧的 python 字段（那时写的是可执行文件）
      const declared = (cfg.venv || cfg.python || '').trim().replace(/^["']+|["']+$/g, '');
      if (declared) {
        const abs = path.isAbsolute(declared)
          ? declared
          : path.resolve(PROJECT_ROOT, declared);
        const looksLikeExe = /[\\/](python|python3)(\.exe)?$/i.test(abs);
        const exe = looksLikeExe
          ? abs
          : path.join(abs, venvPythonRelPath(process.platform));
        if (require('../util/pythonResolve').canSpawnPython(exe)) return exe;
      }
    }
  } catch (e) {
    // python.json 读不到或内容坏了 ⇒ 视为「没声明」，继续走候选探测，不在这里报错。
  }

  // 2. 项目相对解释器：先 venv，再内嵌 runtime（同一个判据）
  const fromProject = firstWorkingPython(_pythonCandidates(), { pathNames: [] });
  if (fromProject) return fromProject;

  // 3. 兜底：一个都没找到 ⇒ 返回期望的路径，让报错指向正确位置。这一分支故意不验证「真能起
  //    一次」：它指向 python.json 声明的引擎 venv，报错于是直指它起不来。
  return _lastResortPath() || 'python';
}

// 构造隔离到项目 venv 的干净环境变量：清除污染 venv 解析的 PYTHONHOME / PYTHONPATH / conda
// 变量，前置 venv Scripts 到 PATH 以确保 DLL 与子工具来自 venv，extra 可覆盖或追加。
function getCleanEnv(extra = {}) {
  const env = { ...process.env };

  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.PYTHONSTARTUP;
  delete env.CONDA_PREFIX;
  delete env.CONDA_DEFAULT_ENV;
  delete env.CONDA_PYTHON_EXE;

  // 把 venv 的 Scripts 目录前置到 PATH（大小写无关，避免 Windows 上 Path/PATH 重复键导致系统 PATH 丢失）
  const python = getPythonPath();
  if (path.isAbsolute(python)) {
    const venvBin = path.dirname(python);

    // 找到现有的 PATH 键（Windows 常见为 'Path'），删掉所有大小写变体，只保留一个键。
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const existing = env[pathKey] || '';

    for (const k of Object.keys(env)) {
      if (k.toLowerCase() === 'path') delete env[k];
    }
    env[pathKey] = venvBin + path.delimiter + existing;

    env.VIRTUAL_ENV = path.dirname(venvBin);
  }

  // 让 Python 子进程（torchaudio / FunASR / UVR5）也能找到项目自带 ffmpeg：把
  // vendor/ffmpeg/<platform>/ 前置到 PATH。否则 torchaudio 会提示 ffmpeg 缺失并退回内置加载器。
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

  // 缓存：全部收进项目根的 cache/。这里是 Python 子进程环境的唯一注入点，因此也是缓存位置的
  // 唯一注入点。HuggingFace / ModelScope / torch hub 默认落在 %USERPROFILE%，在项目之外，备份
  // 和清理都够不着（引擎契约 C9）。numba/librosa 防卡死只需把缓存指向确定可写目录，不要禁用
  // JIT（禁用会破坏 resampy 的 @guvectorize，librosa.resample 报 TypingError）
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

  // 权重目录：由 lib/paths.js 下发，脚本不得自行推算。兜底逻辑仍留在各脚本里（上溯找
  // package.json），仅用于脱离本进程直接跑的场合。
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
