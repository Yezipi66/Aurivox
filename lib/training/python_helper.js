/**
 * 获取项目 Python 路径 + 构造隔离到 venv 的干净环境
 */
const fs = require('fs');
const path = require('path');

const paths = require('../paths');
// ⭐ A15：判据是「按绝对路径真能起一次」，不是「文件在」（venv 的文件在、
//   base 解释器指向另一台机器，是这个项目搬过机器后的典型形状）。
const { firstWorkingPython } = require('../util/pythonResolve');
// ⭐ 名片的 runtime.python 现在约定是**虚拟环境目录**，平台按平台推导
//   Scripts/python.exe 或 bin/python。python.json 与它同一约定。
const { venvPythonRelPath } = require('../engines/platformPaths');

const PYTHON_CONFIG = path.join(__dirname, 'python.json');

// __dirname = <root>/lib/training → 项目根在上两级。
// 所有 Python 解析都以【当前项目根】为基准，这样整个文件夹可以自由
// 移动/改名/换盘符，不会因为烤死的绝对路径而失效。
// 项目根一律取自 lib/paths.js，不在此处按 __dirname 数目录层数（引擎契约 C7）。
const PROJECT_ROOT = paths.APP_DIR;

// ⛔⛔ 「训练线**可以**用」的解释器 —— 全部相对项目根解析。
//
// ⚠️⚠️ 2026-10-04（A14）这里被拆成两个函数，而拆的理由是一条**静默失败**：
//
//   内嵌可迁移运行时 `tools/runtime/python` 是**裸解释器**，没有 torch。
//   它从前与根 venv 混在同一个候选列表里，靠「根 venv 的文件存在」挡在前面。
//   而 A15 把判据换成「真能起一次」之后，根 venv 起不来就被正确跳过了 ——
//   于是解析**一路落到裸解释器**并成功返回。
//   ⇒ 训练会用一个没有 torch 的解释器启动，然后在某一步炸成
//     `ModuleNotFoundError: torch` —— 那句话会让人去**装包**，
//     而真正的原因是「这台机器上没有能跑训练的环境」。
//
// ⇒ 所以：**裸解释器不许出现在可用候选里**，它只配出现在「报错指向哪」的兜底里。
//   ⭐ 分不清「可用」与「该报错指向哪」，是这类 bug 的通用形状。
function _pythonCandidates() {
  // ⛔ 2026-10-04（A19 之后）：这里**故意返回空列表**。
  //
  // 它从前是「平台根 venv」，而那一条在两个时期各坏一次、且坏法不同：
  //   · A19 之前：根 venv 装着 GSV 的 206 个包，但 base 解释器指向另一台机器
  //     ⇒ 起不来 ⇒ 这层从不生效（**歪打正着**）。
  //   · A19 之后：根 venv 瘦成 3 个工具链包（uv / packaging / hf_transfer）
  //     ⇒ **能跑了，但里面没有 torch / librosa / soundfile**
  //     ⇒ 训练会以 `ModuleNotFoundError: torch` 炸，而真正的原因是
  //       「这台机器上没有能跑训练的环境」。**那是更坏的失败** ——
  //       它会让人去装包，而不是去看环境。
  //
  // ⇒ 结论：平台根 venv **永远不可能满足训练**（C12：它只装平台自己的），
  //   所以它不配出现在「可用候选」里。训练线只有一条路：
  //   **python.json 声明的那个引擎 venv**。
  //
  // ⭐ 保留这个函数（而不是删掉）是为了让「可用候选」这个概念在代码里
  //   仍然存在且为空 —— 将来若平台自己有了需要 Python 的能力，
  //   往这里加一条**并且说明它为什么够用**，比重新引入这个坑更容易被看见。
  return [];
}

// ⭐ 兜底：**一个都没找到时**，报错该指向哪里。
//   顺序 = python.json 声明的那个 venv → 平台根 venv → 内嵌 runtime。
//   ⚠️ 最后一项只是「总得有个路径」，不代表它能跑。
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
  //
  // ⭐ 2026-10-04（A14）：python.json 现在写的是**虚拟环境目录**
  //   （`engines/gpt-sovits/.venv`），与名片的 runtime.python 同一约定 ——
  //   所以要按平台推导可执行文件，而不是把它当 exe 直接用。
  //   ⛔ 但**不**把内嵌 runtime 加进候选：训练要 torch，而内嵌 runtime 是
  //     裸解释器 ⇒ 悄悄回落到它，会把「训练线不可用」变成一句
  //     ModuleNotFoundError，那种错会让人去装包而不是去看环境。
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
        // ⚠️ 判据是「真能起一次」，不是「文件在」（A15）
        if (require('../util/pythonResolve').canSpawnPython(exe)) return exe;
      }
    }
  } catch (e) {}

  // 2. 项目相对解释器：先 venv，再内嵌 runtime（同 A15 的判据）
  const fromProject = firstWorkingPython(_pythonCandidates(), { pathNames: [] });
  if (fromProject) return fromProject;

  // 3. 兜底：一个都没找到 ⇒ 返回**期望**的路径，让报错指向正确位置。
  //    ⭐ 这里**故意不用** A15 的判据：这一分支存在的意义就是
  //      「什么都没有时仍然给出一条指向正确位置的报错」，
  //      它本来就该返回一个**尚未被验证**的路径。
  //    ⛔ 而它现在指向的是 **python.json 声明的引擎 venv** ——
  //      那正是训练线该用的地方（A14），所以报错会直接说
  //      「engines/gpt-sovits/.venv 起不来」，而不是指向一个不相干的路径。
  return _lastResortPath() || 'python';
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
