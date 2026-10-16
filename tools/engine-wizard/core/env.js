'use strict'
//  ENV：第 3 步，建引擎自己的 Python 环境并装依赖。
//
//  装法由名片的 install.env_command 决定，这里没有「没声明就默认 uv sync」这类分支：
//  uv / poetry / pip -r / conda 各家不同，猜错的表现是装到一半失败、磁盘留一半。
//
//  torch 系包体积大且与显卡绑定，上游通常单独装。本文件不特殊处理 torch，
//  env_command 里写什么就跑什么；没包含 torch 是上游的选择。
//  例外：锁文件锁的后端与本机不一致时，跳过 torch 系包，另给一条装本机后端的命令
//  （见 suggestBackendAlternative）。

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync, spawn } = require('node:child_process')
const { projectRoot, engineDir, killProcessTree } = require('./clone.js')
// killProcessTree 复用 clone.js 那一份：杀进程树（Windows taskkill /T、其他平台
//   kill 进程组）只有一种正确写法，本文件再写一份必然漂移。
const { venvPythonRelPath } = require(
  path.join(__dirname, '..', '..', '..', 'lib', 'engines', 'platformPaths.js'))
const { canSpawnPython } = require(
  path.join(__dirname, '..', '..', '..', 'lib', 'util', 'pythonResolve.js'))

/** 读取并校验名片里的 install.env_command */
function readEnvCommand (manifest) {
  const inst = manifest && manifest.install
  if (inst === undefined || inst === null) {
    // 错误信息只说：① 缺什么 ② 怎么补 ③ 补了之后会怎样。
    // 不解释内部设计原则（如「平台不猜」），用户要知道的是「现在该怎么办」。
    return {
      ok: false, code: 'NO_INSTALL_SECTION',
      whatToDo: 'Manifest 尚未声明 install.env_command，'
        + '该字段用于确定依赖安装方式。\n'
        + '可选两种处理方式：\n'
        + '  ① 暂时跳过本步骤，在第 4 步填写 Manifest 时声明 '
        + 'install.env_command，然后返回本步骤执行；\n'
        + '  ② 按上游说明在 engines/<引擎 id>/ 内自行创建环境，'
        + '平台会检测到该环境已就绪。',
      error: 'Manifest 尚未声明 install.env_command，该字段用于确定依赖安装方式。\n'
        + '可在第 4 步填写 Manifest 后返回执行；'
        + '也可按上游说明在 engines/<引擎 id>/ 内自行创建环境，'
        + '平台会检测到。',
    }
  }
  const cmd = inst.env_command
  if (cmd === undefined || cmd === null) {
    return {
      ok: false, code: 'NO_ENV_COMMAND',
      error: '名片里有 install 段，但没写 install.env_command。\n'
        + 'uv / poetry / pip -r / conda 各家不一样，平台不猜。\n'
        + '照上游的安装说明写这一行，例如：\n'
        + '  "env_command": ["uv", "sync"]\n'
        + '  "env_command": ["uv", "pip", "install", "-r", "requirements.txt"]',
    }
  }
  if (!Array.isArray(cmd) || cmd.length === 0
      || cmd.some((s) => typeof s !== 'string' || !s.trim())) {
    return {
      ok: false, code: 'BAD_ENV_COMMAND',
      error: 'install.env_command 必须是非空的字符串数组（argv 形式），'
        + '例如 ["uv","sync"]。\n'
        + '写成一整行命令会在含空格的路径上被错误拆分，排查困难。',
    }
  }
  return { ok: true, argv: cmd.map((s) => s.trim()) }
}

/**
 * 从上游自己的依赖清单推出装法：只报，不替用户选装法。
 *
 * 依据：第 1 步的探测已经读到了上游的清单文件名
 *   （pyproject.toml / uv.lock / requirements.txt / environment.yml），
 *   而且这些文件名本身就决定了装法：
 *   有 uv.lock ⇒ 版本已定，照它装；只有 requirements.txt ⇒ uv pip -r。
 *   但只根据文件存在与否，不猜包名、不猜版本。
 *
 * 名片的 install.env_command 仍然优先：
 *   名片作者知道这台引擎的特殊装法（要编译、要特定源…），
 *   探测推出的只是「常规装法」，不能盖过名片。
 */

/**
 * 锁文件装不了本机后端时，给出第二条命令（两条都给，平台不拍板）。
 *
 * lock 锁的是版本号，不是后端：同一个 2.8.0 在 xpu / cpu / rocm 线上各有 wheel。
 * 想换后端不必放弃锁文件：记下版本号，只重建 torch。
 *
 * 本函数只产出一条建议，不执行、不判断哪条对：平台只验不建，用哪条由使用者决定。
 *
 * @param {string} dir 清单所在目录
 * @param {string} lockRel lock 相对路径（可能带一层子目录）
 * @returns {{argv:string[], why:string, needs:string[]}|null}
 *   null = 读不出 torch 版本 / 锁的后端与推荐一致 / 推荐后端没有官方 index
 */
function suggestBackendAlternative (dir, lockRel) {
  let hw
  try {
    hw = require('./hardware.js')
  } catch (e) { return null }
  if (!hw || typeof hw.readTorchPin !== 'function') return null
  if (typeof hw.readTorchFamilyPins !== 'function') return null

  let text
  try { text = fs.readFileSync(path.join(dir, lockRel), 'utf8') } catch (e) { return null }
  const pin = hw.readTorchPin(text)
  if (!pin || !pin.plain) return null

  let rec
  try { rec = hw.recommendBackend(hw.detectGpus()) } catch (e) { return null }
  if (!rec || !rec.recommended) return null

  // 一致时不给第二条：没有需要解决的问题，多给一条只是噪音
  if (pin.backend && pin.backend === rec.recommended) return null

  const opt = (hw.BACKEND_PREFERENCE || []).find((b) => b.key === rec.recommended)
  if (!opt || !opt.index) return null   // 没有官方 index ⇒ 平台给不出命令

  // 读整族（torch + lock 里真有的兄弟包）。
  // 只装 torch 一个包会让 torchaudio 留在 CUDA 版 ⇒ 引擎跑不起来
  // （torch 2.8.0+xpu 能 import，torchaudio 2.8.0+cu128 报
  //   FileNotFoundError: libtorchaudio.pyd 找不到依赖）。
  // xpu 索引上 torchaudio==2.8.0 解析出来就是 2.8.0+xpu
  // （同一版本号、同一个索引自动配对），所以整族一起装是对的。
  const family = hw.readTorchFamilyPins(text)
  if (!family || !family.length) return null

  const specs = family.map((p) => `${p.name}==${p.plain}`)
  const names = family.map((p) => p.name)

  // 只重建 torch 系；锁文件里的其余包照旧（那才是锁文件的价值）。
  // 完整流程是两步：
  //   ① uv sync --no-install-package torch --no-install-package torchaudio …
  //   ② uv pip install torch==<v> torchaudio==<v> … --index-url <本机 index>
  // 为什么不用「先 uv sync 再补装」：那会先装一整套 CUDA torch，
  //   与随后装的版本冲突。
  // 为什么不用「改 lock 去掉 torch」：lock 是上游的产物，
  //   改了产生 diff，且 uv 会在下次 sync 时重新解析。
  return {
    // 不重复 argv：主命令已经是第①步了，这里只给第②步。
    //   重复一遍会让界面显示两条几乎一样的命令。
    then: ['uv', 'pip', 'install', ...specs, '--index-url', opt.index],
    why: `The lock pins Torch as a CUDA build (${pin.version}), which differs from the backend `
      + `recommended for this machine (${opt.label}) — run this step `
      + `next to install the Torch family (${names.join(', ')}) at version ${pin.plain} `
      + `from the official ${opt.label} index:`,
    whyZh: `锁文件指定的 torch 是 CUDA 版（${pin.version}），与本机推荐的后端`
      + `（${opt.label}）不一致。上面的命令已跳过 torch，`
      + `请再执行这一步，从 ${opt.label} 的官方 index 安装 torch 系整族`
      + `（${names.join('、')}），版本号 ${pin.plain}：`,
    needs: names,
    familyPins: family,
  }
}

/**
 * 按上游的依赖清单推导安装方式。
 * @param {string} dir 引擎目录
 * @returns {{argv:string[]|null, from:string|null, why:string}}
 */
function suggestEnvCommand (dir) {
  // 清单常常不在根目录（如 infer/requirements.txt），所以往下找一层。
  // 必须排除 .venv / site-packages：里面的 requirements.txt 是某个依赖自己的，
  // 不是这台引擎的。排除第三方目录（third_party / vendor / node_modules）：
  // 那是上游 vendored 的别人的项目。
  const NAMES = ['pyproject.toml', 'uv.lock', 'requirements.txt', 'environment.yml']
  const SKIP = new Set(['.venv', 'venv', 'site-packages', 'node_modules',
    'third_party', 'vendor', '.git', '__pycache__'])
  const found = []
  let rootLevelLock = null
  for (const f of NAMES) {
    // 根目录优先（锁文件 > pyproject > requirements）
    if (fs.existsSync(path.join(dir, f))) {
      found.push(f)
      if (f === 'uv.lock') rootLevelLock = f
    }
  }
  if (found.length === 0) {
    // 根目录没有 ⇒ 往下找一层（真实项目里清单就在一层子目录里）
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { /* 读不到就当没有 */ }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue
      const sub = path.join(dir, e.name)
      for (const f of NAMES) {
        if (fs.existsSync(path.join(sub, f))) { found.push(`${e.name}/${f}`); break }
      }
    }
  }
  if (found.length === 0) {
    return { argv: null, from: null,
      why: '这一层里没有找到依赖清单（pyproject.toml / uv.lock / '
        + 'requirements.txt / environment.yml，根目录和一层子目录都找过了）\n'
        + '请在 Manifest 中声明 install.env_command，平台将按该声明安装；'
        + '或者按上游说明自己装。' }
  }
  // 优先级照上游文档的通行做法：锁文件 > pyproject > requirements
  const pick = (n) => found.find((f) => f === n || f.endsWith('/' + n))
  const lock = pick('uv.lock')
  const conda = pick('environment.yml')
  const pyproj = pick('pyproject.toml')
  const req = pick('requirements.txt')
  if (lock) {
    // 只算一次：alternative 要同时用于 why 与返回值
    const alt = suggestBackendAlternative(dir, lock)
    return { argv: ['uv', 'sync'], from: lock, cwd: '.',
      // 不写「照它装最稳」：那只在锁的后端与本机一致时成立：
      //   锁的后端是 CUDA 而本机是 XPU 时，照装恰恰装的是不能用的那套。
      //   ⇒ 有替代命令时，这句改成只说「照锁装」这一事实。
      why: (alt
        ? `The upstream provides ${lock}; the Torch backend it pins does not match this machine, `
          + `so Torch is skipped and only the rest is installed.`
        : `The upstream provides ${lock} — versions are already pinned, so install straight from it.`),
      whyZh: (alt
        ? `上游有 ${lock}，其中锁定的 torch 后端与本机不一致，`
          + `因此跳过 torch、只装其余依赖。`
        : `上游有 ${lock} ⇒ 版本已经定死了，照它装最稳。`),
      // 有替代命令时，执行的那条也必须用它：
      //   否则点「安装」装的是 CUDA 版，而 alternative 只作展示。
      //   --no-install-package 让 uv 照锁装其余全部、只跳过 torch 系整族。
      //   必须跳过整族（torch + torchaudio + …）：只跳 torch 会把兄弟包
      //     留在 CUDA 版 ⇒ torchaudio import 报 FileNotFoundError。
      argv: (alt
        ? ['uv', 'sync', ...(alt.needs || ['torch']).flatMap((n) => ['--no-install-package', n])]
        : ['uv', 'sync']),
      alternative: alt }
  }
  if (conda) {
    return { argv: ['conda', 'env', 'create', '-f', conda],
      from: conda, cwd: conda.includes('/') ? conda.slice(0, conda.indexOf('/')) : '.',
      why: `The upstream uses a conda environment file (${conda}) — run conda env create.`,
      whyZh: `上游用 conda 环境文件（${conda}）⇒ 用 conda env create。` }
  }
  if (pyproj) {
    // pyproject 单独存在时不能直接 uv sync：
    //   上游没锁文件 ⇒ 装到什么版本是未定的 ⇒ 装完不可复现。
    //   而且很多项目的 pyproject 里依赖写不全。
    // 诚实的做法：uv pip install -e . （只装它自己声明的依赖）
    const cwd = pyproj.includes('/') ? pyproj.slice(0, pyproj.indexOf('/')) : '.'
    const rel = pyproj.includes('/') ? pyproj.slice(pyproj.indexOf('/') + 1) : '.'
    return { argv: ['uv', 'pip', 'install', '-e', rel], from: pyproj, cwd,
      why: `The upstream provides only ${pyproj} — install it with uv pip install -e ${rel}.`
        + '\nThe upstream ships no lock file, so installed versions are decided by upstream and are not reproducible.',
      whyZh: `上游只有 ${pyproj} ⇒ 用 uv pip install -e ${rel} 装它声明的依赖。\n`
        + '上游未提供锁文件，安装版本由上游决定，无法复现。' }
  }
  return { argv: ['uv', 'pip', 'install', '-r', req], from: req,
    cwd: req.includes('/') ? req.slice(0, req.indexOf('/')) : '.',
    why: `The upstream uses ${req} (legacy) — uv pip install -r ${req}.`,
    whyZh: `上游是 ${req}（老项目）⇒ uv pip install -r ${req}。` }
}

function detectDependencyManifest (dir) {
  const candidates = [
    'pyproject.toml', 'uv.lock', 'requirements.txt',
    'environment.yml', 'setup.py',
  ]
  const found = candidates.filter((f) => fs.existsSync(path.join(dir, f)))
  // 这里只查根目录，与 suggestEnvCommand 的策略不一致
  //   （那边会往下找一层并排除 .venv）。
  //   两边策略不一致 ⇒ 同一台引擎在两处得到不同结论，界面自相矛盾。
  if (found.length === 0) {
    return {
      found: false,
      note: 'No dependency manifest at this level'
        + ' (pyproject.toml / uv.lock / requirements.txt / environment.yml are all absent).\n'
        + 'It may live in a subdirectory, or this engine may need no extra install.',
      noteZh: '这一层里没有依赖清单'
        + '（pyproject.toml / uv.lock / requirements.txt / environment.yml 都没有）。\n'
        + '可能放在子目录里，也可能这台引擎不需要额外安装。',
      found_files: [],
    }
  }
  return { found: true, found_files: found,
    note: 'Upstream dependency manifests: ' + found.join(', '),
    noteZh: '上游的依赖清单：' + found.join('、') }
}

/**
 * 该引擎自己的隔离环境（engines/<id>/.venv）。
 *
 * uv 工具的三条硬约束：
 *   ① uv 选目标环境的唯一可靠方式是 `-p/--python <绝对路径>`。
 *      设 VIRTUAL_ENV 无效（uv 认自己所在的那个环境），相对路径也无效。
 *   ② `uv sync` 的 `-p/--python` 是「用哪个解释器当基准建项目环境」，
 *      不是「装进哪个解释器」。`uv sync -p <已存在的 venv>` 会静默装进
 *      项目目录新建的 .venv。sync 那条路的正确写法是 UV_PROJECT_ENVIRONMENT=<绝对路径>。
 *   ③ `conda env create` 自己会建环境 ⇒ 不许再塞一步 uv venv。
 *
 * Python 版本：名片 schema 没有声明 python 版本的字段 ⇒ 退回平台根 venv 的 python。
 * 上游若声明了版本但平台读不到，如实报错，不自动换版本。
 */

/**
 * 取消/中断时在 .venv 里留下的标记文件。
 *
 * 为什么必须有它：装依赖取消或失败后，.venv 里是一半的依赖：
 *   site-packages 非空、uv 的下一条命令不报错，界面看不出这个环境是坏的。
 * 所以在那一步失败的当时就写下「这个环境不完整」，下次重跑时先看见它。
 */
const PARTIAL_VENV_MARK = '.wizard-partial-venv'

/** 该引擎 .venv 下的标记文件绝对路径 */
function partialVenvMarkAbs (root, id) {
  return path.join(engineVenvDirAbs(root, id), PARTIAL_VENV_MARK)
}

/**
 * .venv 里有没有「环境不完整」这个标记。
 *
 * 只认文件在不在，不看内容：内容只是给人看的说明。
 * 标记只由平台自己写（取消/失败时）和平台自己删（重跑真装完时），
 * 用户手动建的这份文件同样有效：那也是他知道环境坏了。
 *
 * @param {string} root 项目根
 * @param {string} id   引擎 id
 * @returns {boolean}
 */
function hasPartialVenvMark (root, id) {
  try { return fs.existsSync(partialVenvMarkAbs(root, id)) } catch (e) { return false }
}

/**
 * 写下/抹掉「环境不完整」这个标记。
 *
 * 写不进（只读盘、目录被锁）时静默：这是进度记录，不是安装本身，
 * 宿主盘只读的机器上不该让它把安装过程炸掉。
 *
 * @param {string} root 项目根
 * @param {string} id   引擎 id
 * @param {string|null} why null = 抹掉标记
 */
function markPartialVenv (root, id, why) {
  const f = partialVenvMarkAbs(root, id)
  try {
    if (why === null || why === undefined) {
      fs.rmSync(f, { force: true })
      return
    }
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify({
      at: new Date().toISOString(),
      why: String(why),
      noteZh: '这个环境不完整：上一次安装被取消或中途失败。'
        + '重新执行本步骤会先删掉整个 .venv 再重建，已下载的 wheel 仍会复用。',
      note: 'This environment is incomplete: the previous install was cancelled '
        + 'or failed midway. Re-running this step removes the whole .venv and '
        + 'rebuilds it; already-downloaded wheels are still reused.',
    }, null, 2), 'utf8')
  } catch (e) { /* 标记写不写都不该拦住安装本身 */ }
}

/**
 * 该引擎自己的隔离环境目录（绝对路径） */
function engineVenvDirAbs (root, id) {
  return path.join(root, 'engines', String(id), '.venv')
}

/** 该引擎隔离环境里那个解释器的绝对路径（布局按平台推导） */
function engineVenvPythonAbs (root, id) {
  const rel = venvPythonRelPath(process.platform)
  if (!rel) return null       // 不认识的平台不猜（见 resolveUv 同样的口径）
  return path.join(engineVenvDirAbs(root, id), rel)
}

/**
 * 这个环境能不能用：判据是「能按绝对路径起起来并执行代码」。
 *
 * 不能用「文件存在」判断：venv/Scripts/python.exe 文件在、
 * 但 pyvenv.cfg 的 home 指向另一台机器 ⇒ 启动报 uv trampoline failed to spawn。
 * 复用 lib/util/pythonResolve.js 的 canSpawnPython，不在本文件里再写一份。
 *
 * @param {string} root 项目根
 * @param {string} id   引擎 id
 * @returns {boolean}
 */
function canUseEngineVenv (root, id) {
  const py = engineVenvPythonAbs(root, id)
  if (!py) return false
  return canSpawnPython(py)
}

/**
 * 平台根 venv 的 python（绝对路径）：建引擎环境时的基准解释器。
 *
 * 用「平台根」而不是引擎自己的：引擎环境此刻还不存在，拿它的 python 当基准是循环依赖。
 * 路径按平台推导（win32 Scripts/ / posix bin/）。
 *
 * 与 resolveUv 同一口径：项目根优先，root 兜底。
 * uv 装在平台自己的 venv 里，而那套 venv 在项目根下。
 * runEnv 解析 uv 时也是 `resolveUv(projectRoot()) || resolveUv(root)`，
 * 这里必须同一条，否则会出现「装依赖用 A 的 uv、建环境用 B 的 python」。
 * 这里只查文件在不在（要 spawn 的那份判据在 canUseEngineVenv）：
 * 出计划时不 spawn，不让预览接口为了排版等 20 秒。
 *
 * @param {string} root 引擎/夹具那一层的根
 * @returns {string|null} 找不到该解释器时给 null（调用方如实报错）
 */
function platformPythonAbs (root) {
  const rel = venvPythonRelPath(process.platform)
  if (!rel) return null
  const prj = (() => { try { return projectRoot() } catch (e) { return null } })()
  const bases = [prj, root].filter((b) => typeof b === 'string' && b)
  for (const b of bases) {
    const p = path.join(b, 'venv', rel)
    try { if (fs.existsSync(p)) return p } catch (e) { /* 下一个 */ }
  }
  return null
}

/**
 * 建环境那一步的 argv：`<平台python> -m uv venv <绝对路径>`。
 *
 * 走 uv 而不是 `python -m venv`：平台解析 uv 用的是「平台 venv 的 python -m uv」
 * （见 resolveUv），本步要用的包管理器和装依赖那步是同一个 ⇒ 一条路，不两套。
 * `python -m venv` 造出来的环境不带 uv，装依赖那步还得另外找 uv。
 *
 * @param {string} root 项目根
 * @param {string} id   引擎 id
 * @returns {{argv:string[]|null, python:string|null, why:string, whyZh:string}}
 */
function buildVenvStep (root, id) {
  const venvDir = engineVenvDirAbs(root, id)
  const py = platformPythonAbs(root)
  if (!py) {
    return { argv: null, python: null,
      why: 'This platform has no known Python virtual environment layout, so the platform '
        + 'cannot tell which interpreter to use.',
      whyZh: '这个平台没有已知的 Python 虚拟环境布局，平台不知道该用哪个解释器。' }
  }
  return {
    // 对已存在的环境重跑 uv venv 会报「A virtual environment already exists」
    // 并退 2 ⇒ 幂等靠 skipIfExists 在执行期跳过（与断点续传同一套机制），
    // 不是靠 --allow-existing（那会把已有环境当普通目录保留，重装等于没生效）。
    // --python 必须显式指定平台自己的解释器。
    // 只写 `uv venv <路径>` 而不带 --python 时，uv 自己挑最新版 CPython
    //   ⇒ 上游 requirements 里 `torch==2.5.1` 会报
    //   「no wheels with a matching Python ABI tag」。
    // 「用平台 python 跑 uv」不等于「新环境用平台 python」：
    // uv 是平台 venv 里的一个包，它默认认自己所在的环境，
    // 建新环境时有自己的一套挑选逻辑（VIRTUAL_ENV 也压不住它）。
    argv: [py, '-m', 'uv', 'venv', venvDir, '--python', py, '--no-project'],
    python: py,
    venvDir,
    skipIfExists: true,
    why: 'Create an isolated Python environment for this engine under engines/'
      + `${id}/.venv. Dependencies are installed into it, not into the platform's own `
      + 'environment.',
    whyZh: `为该引擎在 engines/${id}/.venv 下建一个独立的 Python 环境。`
      + '依赖会装进这个环境，不装进平台自己的环境。',
  }
}

/**
 * 给装依赖那一步钉上目标解释器。
 *
 * `-p/--python` 必须是绝对路径（相对路径 uv 会报
 *   「No virtual environment or system Python installation found for path」）。
 * 设 VIRTUAL_ENV 对 uv 无效 ⇒ 这里只走 -p 一条路。
 * 已经在 argv 里显式写了目标解释器的（名片作者自己写的）不重复加。
 *
 * 只对 `uv pip …` 加这个参数，有两个原因：
 *   ① `-p` 是 uv 的参数，不是 pip / poetry / conda 的：
 *      给 `node -e …` 或 `pip install -r …` 加 `-p` 会让命令直接起不来
 *      （spawn 报 ENOENT）。
 *   ② `uv sync` 也不加（它的 -p 是「用哪个解释器当基准建项目环境」，
 *      会静默装进另一个 .venv，见 syncEnvFor）。
 *   ⇒ 其他装法（名片自己声明的）平台不改它的 argv。
 *
 * @param {string[]} argv 原 argv
 * @param {string} pyAbs  目标解释器绝对路径
 * @returns {string[]}
 */
function withTargetPython (argv, pyAbs) {
  if (!pyAbs) return argv
  const out = (argv || []).slice()
  // 名片作者自己指定了（真名片就这么写）⇒ 以名片为准，不重复加
  if (out.includes('-p') || out.includes('--python')) return out
  // 只认 `uv pip …`：别的命令加 -p 会起不来（见上）
  if (!/^uv$/i.test(out[0] || '') || out[1] !== 'pip') return out
  // 位置：`uv pip <subcmd> -p <py> …`
  //   （uv 认全局选项，位置不挑；这里放在子命令后面纯粹为了 argv 读起来顺。）
  let at = 2
  if (out[2] === 'install' || out[2] === 'compile' || out[2] === 'sync') at = 3
  out.splice(at, 0, '-p', pyAbs)
  return out
}

/**
 * uv sync 那条路的目标环境：UV_PROJECT_ENVIRONMENT。
 *
 * sync 不用 `-p`：`uv sync -p <某个已存在的 venv>` 会照锁装完、退出码 0，
 * 但装进的是它在项目目录新建的 .venv，指定的 venv 里根本没有那个包：静默装错地方。
 * 正确写法只有 UV_PROJECT_ENVIRONMENT=<绝对路径>。
 * 连带陷阱：cwd 在清单所在的子目录时，uv 会把 .venv 建在那一层
 * （infer/requirements.txt ⇒ infer/.venv），所以这个变量必须显式给。
 *
 * @param {string} venvDirAbs 该引擎隔离环境目录的绝对路径
 * @returns {{UV_PROJECT_ENVIRONMENT:string}}
 */
function syncEnvFor (venvDirAbs) {
  // 刻意不设 VIRTUAL_ENV：它对 uv 无效，
  //   留着会给人「设了就生效」的错觉。
  return { UV_PROJECT_ENVIRONMENT: venvDirAbs }
}

/**
 * 组装执行步骤。
 *
 * 建环境是第①步，装依赖紧随其后：顺序不能反：
 *   反了就是「装到不存在的环境里」，症状与没建环境一模一样
 *   （uv 报 No virtual environment found）。
 *
 * 装法自带环境的（conda）不加建环境那一步（conda 自己会建，建两遍）。
 *
 * 两条装依赖的路径各要自己的目标环境参数：
 *   · targetPython：主安装步用的 `-p <引擎环境里的 python>`（sync 那条路除外）
 *   · altPython：第②步（装本机后端 torch）用的 `-p`，与主步是不是 sync 无关
 * 为什么必须分开：第②步永远是 `uv pip install …`，
 *   而 `uv pip` 的 `-p` 才是「装进哪个环境」（见 withTargetPython）。
 *   漏给第②步加 -p ⇒ torch 被装进平台根 venv，
 *   而引擎环境里独缺它 ⇒ 用户拿到的环境 import torch 失败，
 *   三步退出码却全是 0，界面显示「安装完成」。
 *
 * @param {{argv:string[], cwdRel:string, alt?:object|null,
 *          venv?:object|null, sync?:object|null,
 *          targetPython?:string|null, altPython?:string|null}} o
 * @returns {object[]}
 */
function buildSteps ({ argv, cwdRel, alt, venv, sync, targetPython, altPython }) {
  const steps = []
  // 建环境那一步排最前（conda 那条路除外）
  if (venv && Array.isArray(venv.argv)) {
    steps.push({
      kind: 'env',
      argv: venv.argv,
      cwd: cwdRel,
      needs_network: false,
      // 执行期据此判重：环境已能起 ⇒ 跳过（与断点续传同一套机制）
      skipIfExists: true,
      why: venv.why,
      whyZh: venv.whyZh,
    })
  }
  steps.push({
    kind: 'env',
    argv,
    cwd: cwdRel,
    needs_network: true,
    // sync 那条路用 UV_PROJECT_ENVIRONMENT 选目标（不用 -p，见 syncEnvFor）
    env: sync || undefined,
    why: 'Install dependencies from the upstream lock file.',
    whyZh: '照上游依赖清单安装。',
  })
  if (alt && alt.then) {
    steps.push({
      kind: 'env',
      // 第②步必须钉同一个目标环境（altPython），不能跟着主步走。
      //   主步是 `uv sync` 时 targetPython 故意是 null（sync 靠
      //   UV_PROJECT_ENVIRONMENT，见 syncEnvFor），但第②步是 `uv pip install`，
      //   对它来说 -p 才是「装进哪个环境」⇒ 必须显式给引擎环境里的 python。
      //   torch 装进平台根 venv ⇒ 引擎环境里独缺它 ⇒ import torch 失败，
      //   而三步退出码全是 0，界面显示「安装完成」。
      //   另有那层 UV_PROJECT_ENVIRONMENT（sync 那条路带来的）在这里是无害的：
      //   `uv pip install` 只读 -p，不看那个变量。
      argv: withTargetPython(alt.then, altPython || targetPython),
      cwd: cwdRel,
      needs_network: true,
      env: sync || undefined,
      why: 'Install the Torch build matching this machine backend, '
        + 'into this engine\'s own environment.',
      whyZh: '把本机后端对应的 Torch 装进该引擎自己的环境。',
    })
  }
  return steps
}

/**
 * 这一步是不是「平台自己建引擎环境」那一步（`<python> -m uv venv <dir>`）。
 *
 * 判据看的是相邻两个 argv 元素（`uv` 紧跟 `venv`）：
 *   别拿 `/venv/` 这类正则去扫整行：`conda env create -f env.yml`
 *   里也可能有 "env"，而 `-m uv venv` 这两个词是并列的。
 *
 * @param {object} step 计划里的一步
 * @returns {boolean}
 */
function isVenvCreateStep (step) {
  const argv = (step && step.argv) || []
  for (let i = 0; i + 1 < argv.length; i++) {
    if (/^uv$/i.test(argv[i]) && /^venv$/i.test(argv[i + 1])) return true
  }
  return false
}

/**
 * 装完自检：这个环境能不能 import 引擎的核心依赖。
 *
 * 为什么必须有这一步：三条命令退出码全是 0，界面显示「安装完成」，
 * 而 engines/<id>/.venv 独缺 torch
 *   ⇒ `<引擎环境>/Scripts/python.exe -c "import torch"` 报 ModuleNotFoundError，
 *   transformers 自己警告「None of PyTorch, TensorFlow >= 2.0, or Flax have been found」。
 * 退出码 0 只说明命令跑完了，不说明装进了对的地方。
 *
 * 判据复用 lib/util/pythonResolve.js 的 canSpawnPython
 *   （「能按绝对路径起起来并执行代码」）而不是 existsSync
 *   文件存在但解释器起不来时，import 的结果是假象。
 *
 * 验哪些包：从这次真的跑过的命令里读（steps 的 argv + alt.needs），
 *   不替用户猜这台引擎需要什么。不涉及 torch 的装法就不验 torch。
 *
 * @param {string} root 项目根
 * @param {string} id   引擎 id
 * @param {object[]} steps 本次执行的可执行步骤（已过滤掉 kind!=='env'）
 * @param {object|null} alt alternative（有则它的 needs 是要验的包）
 * @param {{probe?:Function, timeoutMs?:number}} [opts]
 *   probe 供测试注入：(pyAbs, mod) => {ok, code, stdout, stderr}
 * @returns {{checked:boolean, reason?:string, mods:string[],
 *            missing?:string[], results?:object[]}}
 */
function verifyEngineEnvImports (root, id, steps, alt, opts = {}) {
  // 平台没参与建环境（conda 那条路自建环境）⇒ 平台手里没有它的解释器
  const builtHere = steps.some(isVenvCreateStep)
  if (!builtHere) {
    return { checked: false, reason: 'this-install-method-manages-its-own-environment',
      mods: [] }
  }
  // 要验哪些包：从真的跑过的命令里读
  const mods = new Set()
  for (const s of steps) {
    const line = (s.argv || []).join(' ')
    if (/(^|\s)torch(==|@|\s|$)/.test(line)) mods.add('torch')
  }
  if (alt && Array.isArray(alt.needs)) {
    for (const n of alt.needs) if (typeof n === 'string' && n) mods.add(n)
  }
  const list = [...mods]
  if (list.length === 0) {
    return { checked: false, reason: 'no-core-dependency-declared', mods: [] }
  }

  const probe = typeof opts.probe === 'function' ? opts.probe : probeImportInEngineVenv
  const results = []
  const missing = []
  for (const mod of list) {
    const r = probe(root, id, mod, opts.timeoutMs)
    results.push(r)
    if (!r.ok) missing.push(mod)
  }
  return { checked: true, mods: list, missing, results }
}

/**
 * 在该引擎自己的环境里 import 一个模块。
 *
 * 为什么分两下：canSpawnPython 先判「这个解释器起不起来」，
 *   起不来时的 ModuleNotFoundError 是假象（连解释器都没跑起来）。
 *   ⇒ 先用它判解释器，再用真正的 import 判那个包（见 verifyEngineEnvImports）。
 *
 * @param {string} root 项目根
 * @param {string} id   引擎 id
 * @param {string} mod  包名
 * @param {number} [timeoutMs]
 * @returns {{ok:boolean, mod:string, code:string, detail:string}}
 */
function probeImportInEngineVenv (root, id, mod, timeoutMs) {
  const py = engineVenvPythonAbs(root, id)
  if (!py) {
    return { ok: false, mod, code: 'NO_ENGINE_PYTHON',
      detail: 'no known virtual environment layout for this platform' }
  }
  // canSpawnPython：判「能按绝对路径起起来并执行代码」，不是「文件在」
  if (!canSpawnPython(py, { timeoutMs: Math.min(timeoutMs || 20000, 20000) })) {
    return { ok: false, mod, code: 'ENGINE_VENV_UNUSABLE',
      detail: `cannot launch ${py}` }
  }
  let r
  try {
    r = spawnSync(py, ['-c', `import ${mod}`], {
      encoding: 'utf8', timeout: timeoutMs || 120000,
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    return { ok: false, mod, code: 'PROBE_FAILED', detail: e.message }
  }
  if (r.error) return { ok: false, mod, code: 'PROBE_FAILED', detail: r.error.message }
  if (r.status !== 0) {
    return { ok: false, mod, code: 'MODULE_NOT_FOUND',
      detail: (r.stderr || r.stdout || '').trim().slice(0, 600) }
  }
  return { ok: true, mod, code: 'OK', detail: '' }
}

/**
 * uv 的可执行文件，相对平台虚拟环境目录：布局按平台推导。
 *
 * 为什么按平台分（而不是写死一个名字）：
 *   虚拟环境的布局在 posix 与 windows 上是结构性不同，不是命名习惯：
 *   windows 的 Scripts/ 来自那个年代 .cmd 包装脚本的做法，posix 一直是 bin/。
 *   平台自己的 lib/engines/platformPaths.js:54 venvPythonRelPath 就是这么分的。
 *
 * 纯函数：不读盘、不看 env。platform 显式传入，
 *   所以 macOS/Linux 的形状在 Windows 上也能测。
 * 不认识的平台（freebsd / aix 等）返回 null：不猜。
 *   猜错的后果是「指到一个不存在的文件」⇒ 报「没找到 uv」，而用户什么都没做错。
 *
 * @param {string} platform  process.platform（win32 / linux / darwin）
 * @returns {string|null} 相对 venv 目录的路径；不认识的平台给 null
 */
function uvRelPath (platform) {
  if (platform === 'win32') return path.join('Scripts', 'uv.exe')
  if (platform === 'linux' || platform === 'darwin') return path.join('bin', 'uv')
  return null
}

/**
 * 解析 uv 的两段：与平台 bootstrap 同一套调用方式。
 *
 * 为什么必须返回平台 venv 的 python（而不是 uv 的 shim 可执行文件）：
 *   uv 是装进平台 venv 的一个包（requirements-platform.txt:57 uv==0.12.1），
 *   平台自己在 bootstrap.js:362 就是这么调的：
 *     runNative(VENV_PY, ['-m', 'uv', 'pip', 'install', ...])
 *   找 `venv/Scripts/uv.exe` 是 pip 生成的 console-script shim，
 *   shim 只是个小入口脚本，它的可用性取决于 venv 的 python 路径没变。
 *   平台自己的正路（python -m uv）依赖不到 shim，更抗分发时的路径漂移。
 *
 * 为什么必须带回退（bootstrap.js:313/321）：
 *   平台允许 uv 不存在：`TTS_NO_UV=1` 直接跳过；uv 装失败就 Warn 后继续，
 *   bootstrap 照样成功。⇒ 一台正常分发的机器完全可以没有 uv。
 *   所以这里的回退链是：
 *       ① 平台 venv 的 python -m uv   （正路，与 bootstrap 一致）
 *       ② PATH 上的 uv                 （用户自己装了 uv、且 venv 里没装）
 *       ③ 都没有 ⇒ null（调用方如实报错）
 *
 * 分发与多平台：绝对路径是运行时从项目根算出来的，不是写死的字符串。
 *   平台拷到哪，server.js 就在哪，projectRoot() 就指向那，
 *   venv 就在旁边：与平台自己的 venvPython() 同一模式。
 *   布局按平台推导（win32 Scripts/ / posix bin/）。
 *
 * 探针（probe_spawn_path.js）：spawnSync 用 shell:false 时
 *   只有裸名才走 PATH 搜索，带路径分隔符的参数一律按文件路径解析。
 *   而 runEnv 执行时 cwd 是引擎目录（engines/<id>），不是项目根
 *   ⇒ 相对路径 'venv/Scripts/uv.exe' 会解析成
 *      engines/<id>/venv/Scripts/uv.exe：不存在。
 *   所以这里返回绝对路径。
 *
 * @param {string} root 项目根
 * @param {string} [platform] 默认 process.platform
 * @returns {{ok:true, argv:string[], via:string} | {ok:false, why:string}}
 */
function resolveUv (root, platform) {
  const plat = platform || process.platform
  const pyRel = venvPythonRelPath(plat)
  // 不认识的平台不猜（猜错比报「不支持」更难让人看懂）
  if (!pyRel) return { ok: false, why: '这个平台（' + (plat || '未知') + '）没有已知的 Python 虚拟环境布局' }

  // 候选 venv：平台的 venv 优先，精简镜像里的次之
  const venvs = [path.join(root, 'venv'), path.join(root, 'cache', 'slim-venv')]
  for (const v of venvs) {
    const py = path.join(v, pyRel)
    try {
      if (!fs.existsSync(py)) continue
      // 确认 uv 作为模块装在里面了（-m uv --version 能跑）
      const chk = spawnSync(py, ['-m', 'uv', '--version'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000, windowsHide: true, shell: false,
      })
      if (chk.status === 0) return { ok: true, argv: [py, '-m', 'uv'], via: 'venv 自带 uv（' + v + '）' }
    } catch (e) { /* 下一个 */ }
  }
  // ② 回退到 PATH 上的 uv（用户自己装的）
  //   必须用裸名：spawnSync 只有裸名才走 PATH 搜索
  const p = spawnSync('uv', ['--version'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000, windowsHide: true, shell: false,
  })
  if (!p.error && p.status === 0) return { ok: true, argv: ['uv'], via: 'uv on PATH', viaZh: 'PATH 上的 uv' }
  return { ok: false, why: 'uv was not found (neither in the platform venv nor on PATH).',
    whyZh: '未找到 uv（平台 venv 里没有，PATH 上也没有）' }
}

function buildEnvPlan (input = {}) {
  const id = input.id
  const root = input.root || projectRoot()
  if (!root) {
    return { ok: false, code: 'NO_ROOT',
      error: '找不到项目根（向上没有 server.js）' }
  }
  const dir = engineDir(id, root)

  if (!fs.existsSync(dir)) {
    return { ok: false, code: 'NO_ENGINE_DIR',
      error: `engines/${id}/ 还不存在。请先执行第 2 步的克隆，或检查路径是否写错。` }
  }
  const cmd = readEnvCommand(input.manifest)
  // 名片优先，探测兜底：名片是第 4 步才写的，
  //   不兜底则第 2 步必然卡死。
  const guess = suggestEnvCommand(dir)
  // 建隔离环境的准备：环境先建，装依赖才有地方装。
  // conda 那条路除外（conda env create 自己会建环境）。
  // 装法既看名片也看探测：名片自己写的 conda/sync 同样要认，
  // 否则会给一台声明 conda 的引擎塞一步 uv venv。
  const effArgv = cmd.ok ? cmd.argv : guess.argv
  const condaRoute = Array.isArray(effArgv) && effArgv[0] === 'conda'
  const venv = condaRoute ? null : buildVenvStep(root, id)
  // sync 那条路用 UV_PROJECT_ENVIRONMENT 选目标（不用 -p，见 syncEnvFor）
  const syncRoute = Array.isArray(effArgv) && effArgv[1] === 'sync'
  // 名片自己写的 sync：平台不替名片作者改 argv 的语义 ⇒ 仍按 manifest 处理，
  //   只有探测出的 sync 才由平台接管目标环境。
  const sync = (syncRoute && !cmd.ok)
    ? syncEnvFor(engineVenvDirAbs(root, id)) : null
  // 装依赖要钉的目标解释器（sync 那条路除外，它靠环境变量）
  const targetPython = sync ? null : engineVenvPythonAbs(root, id)

  if (!cmd.ok) {
    if (!guess.argv) {
      // 两边都没有 ⇒ 如实说清要做什么，不写「平台不会替你猜装法」
      //   （那是把设计原则讲给用户听，他要知道的是「现在该怎么办」）
      return { ok: false, code: cmd.code || 'NO_ENV_COMMAND', id,
        error: cmd.error, cwd: '.',
        // 明确告诉他下一步该干什么
        whatToDo: guess.why }
    }
    // 探测能推出 ⇒ 用它，但如实说清这是推出来的。
    // steps 必须和正常路径同构：缺了它 ⇒ runEnv 执行时拿到 undefined，
    //   命令根本没跑，界面上却显示「成功」。
    //   这里补齐，且 why 与正常路径用同一段文字。
    const cwdRel = guess.cwd || '.'
    const NOTE = 'env_command 返回 0 仅表示命令执行完毕，'
      + '不代表该引擎可以运行，仍需后续校验（import 探针或实际合成）。'
    const guessSync = Array.isArray(guess.argv) && guess.argv[1] === 'sync'
    const guessTarget = guessSync ? null : engineVenvPythonAbs(root, id)
    // 第②步的目标解释器与 guessSync 无关：它永远是 `uv pip install`，
    //   -p 才是它的目标环境开关（见 buildSteps 的注释）
    const guessAltTarget = engineVenvPythonAbs(root, id)
    return {
      ok: true, id, from: 'probe', from_file: guess.from,
      guessed: true,
      env_command: withTargetPython(guess.argv, guessTarget),
      whatToDo: guess.why,
      whatToDoZh: guess.whyZh,
      // 锁文件的后端与本机不一致时，第二条命令（只重建 torch）
      alternative: guess.alternative || null,
      // note / noteZh：同一句话的英文与中文版本，前端按 lang 选。
      //   两段必须成对维护：只改一边会让另一语言界面出现半句英文。
      note: (guess.alternative
        ? `${guess.why}\nThe install method is derived from the upstream dependency manifest — ${guess.from}.`
        : `The install method is derived from the upstream dependency manifest — ${guess.from}.\n`
          + `  ${guess.why}\n`
          + 'If this engine needs a specific install method, declare install.env_command in the Manifest; the platform prefers that declaration.'),
      noteZh: (guess.alternative
        ? `${guess.whyZh}\n该安装方式依据上游依赖清单推导得出（依据：${guess.from}）。`
        : `该安装方式依据上游依赖清单推导得出（依据：${guess.from}）。\n`
          + `  ${guess.whyZh}\n`
          + '如该引擎需要特定安装方式，请在 Manifest 中声明 '
          + 'install.env_command，平台将优先采用该声明。'),
      steps: buildSteps({
        argv: withTargetPython(guess.argv, guessTarget),
        // cwd 必须是相对项目根的路径（runEnv 会 path.join(root, cwd)）。
        //   早退分支里 guess.cwd 是相对引擎目录的（uv sync 要在有
        //   uv.lock 的地方跑）⇒ 必须补上 engines/<id>/ 前缀，
        //   否则会 cd 到项目根执行，uv 找不到 lock。
        cwdRel: path.join('engines', id, guess.cwd || '.'),
        // 有 alternative 时，第②步（装本机后端的 torch）也进 steps
        //   它是这次安装的一部分，不是可选建议。
        //   只放进 alternative 的话，runEnv 永远不会执行它
        //   ⇒ 装出一个没有 torch 的环境而界面显示「完成」。
        alt: guess.alternative,
        // 建隔离环境那一步（conda 那条路除外）
        venv,
        sync: guessSync ? syncEnvFor(engineVenvDirAbs(root, id)) : null,
        targetPython: guessTarget,
        altPython: guessAltTarget,
      }),
    }
  }

  const deps = detectDependencyManifest(dir)
  // 装法：名片优先，探测兜底（见上面 suggestEnvCommand）
  const usingManifest = cmd.ok
  const argv = usingManifest ? cmd.argv : guess.argv
  // sync 用环境变量选目标环境；名片自己写的 sync 不接管
  //   （名片作者负责他自己的 argv 语义，平台不替他改）
  const installSync = (!usingManifest && syncRoute)
    ? syncEnvFor(engineVenvDirAbs(root, id)) : null
  const installTarget = installSync ? null : engineVenvPythonAbs(root, id)
  // 第②步的目标解释器与 installSync 无关（它永远是 `uv pip install`）
  const installAltTarget = engineVenvPythonAbs(root, id)

  const steps = buildSteps({
    argv: withTargetPython(argv, installTarget),
    // cwd = 清单所在的那个目录：uv sync 要在有 uv.lock 的地方跑；
    //   pip -r 也要在清单旁边跑（清单在 infer/requirements.txt
    //   ⇒ cwd 必须是 engines/<id>/infer，不是 engines/<id>）。
    cwdRel: path.join('engines', id, (guess && guess.cwd) || '.'),
    // 有 alternative 时第②步也进 steps（见 buildSteps 的注释）
    alt: (!usingManifest && guess) ? guess.alternative : null,
    // 建隔离环境那一步（conda 那条路除外）
    venv,
    sync: installSync,
    targetPython: installTarget,
    altPython: installAltTarget,
  })

  steps.push({
    kind: 'note',
    why: 'env_command 返回 0 仅表示命令执行完毕，'
      + '不代表该引擎可以运行，仍需后续校验'
      + '（import 探针 / 真跑一次合成）。',
  })

  return {
    ok: true,
    id,
    dir,
    env_command: argv,
    // 界面要能说清「这条装法从哪来的」
    from: usingManifest ? 'manifest' : 'probe',
    from_file: usingManifest ? 'manifest.json (install.env_command)' : guess.from,
    guessed: !usingManifest,
    whatToDo: guess.why,
    dependencies: deps,
    steps,
    execute: input.execute === true,
  }
}

/**
 * 解析 uv/pip 的下载进度行。
 * @param {string} text 输出文本（可能含多行）
 * @returns {{file:string, size:string|null, status:string}[]}
 */
function parseProgress (text) {
  if (!text || typeof text !== 'string') return []
  const results = []
  for (const l of text.split('\n')) {
    const trimmed = l.trim()
    // uv 下载行：Downloading torch (731.1MiB)
    let m = trimmed.match(/^Downloading\s+(\S+)\s+\(([^)]+)\)/)
    if (m) {
      results.push({ file: m[1], size: m[2], status: 'downloading' })
      continue
    }
    // uv 下载完成：Downloaded torch
    m = trimmed.match(/^Downloaded\s+(\S+)/)
    if (m) {
      results.push({ file: m[1], size: null, status: 'downloaded' })
    }
  }
  return results
}

/**
 * 跑一步（异步流式）。返回 Promise<{ok, code, status, stdout, stderr, error}>
 *
 * 为什么异步：同步 spawnSync 会阻塞直到命令结束：装依赖要几分钟到几
 *   十分钟，界面只能干等。改 spawn 后 stdout/stderr 逐行回调，进度条才有米下锅。
 * 不传给 onLine 时行为不变（仍收集尾部输出），调用方不必为了用进度而改判据。
 *
 * uv sync 会自己建项目环境（默认 .venv）：
 *   清单在 infer/ 子目录时它把 .venv 建在 infer/ 而不是引擎目录，
 *   那与名片上写的 runtime.python（engines/<id>/.venv）不是同一个。
 * @param {object} step       计划里的一步（含 argv / cwd / absCwd）
 * @param {string} root       项目根
 * @param {number} timeoutMs  超时（毫秒）
 * @param {string[]} [argvOverride] 覆盖 step.argv（工具名换成绝对路径）
 * @param {(line:string)=>void} [onLine] stdout/stderr 每行回调
 * @param {object} [envOverride]  这一步要加的环境变量（如 UV_PROJECT_ENVIRONMENT）
 * @param {object} [cancel]  取消通道：
 *   @param {AbortSignal} [cancel.signal]     取消信号（前端取消按钮 → 端点 → 这里）
 *   @param {Function} [cancel.spawn]         可注入的 spawn（测试用，不真起进程）
 *   @param {Function} [cancel.killProcessTree] 可注入的杀进程树（测试用）
 *   @param {number}   [cancel.safetyNetMs]   杀不掉时的安全网（默认 5000）
 * @returns {Promise<{ok:boolean, code:string, status:number|null, stdout:string, stderr:string, error?:string}>}
 */
function runOne (step, root, timeoutMs, argvOverride, onLine, envOverride, cancel) {
  return new Promise((resolve) => {
    const argv = Array.isArray(argvOverride) && argvOverride.length > 0 ? argvOverride : step.argv
    // 取消通道：缺省值给「不许注入」。测试注入 spawn 是为了不真起进程，
    //   生产路径上这里必须是真的 spawn，否则取消逻辑测了等于没测。
    const spawnFn = typeof cancel === 'object' && cancel && typeof cancel.spawn === 'function'
      ? cancel.spawn : spawn
    const killFn = typeof cancel === 'object' && cancel && typeof cancel.killProcessTree === 'function'
      ? cancel.killProcessTree : killProcessTree
    const signal = cancel && cancel.signal ? cancel.signal : null
    const safetyNetMs = (cancel && typeof cancel.safetyNetMs === 'number')
      ? cancel.safetyNetMs : 5000
    const child = spawnFn(argv[0], argv.slice(1), {
      cwd: step.absCwd || step.cwd,
      windowsHide: true,
      // argv 直接 spawn：走 shell 会被含空格的路径拆错
      shell: false,
      // uv sync 靠 UV_PROJECT_ENVIRONMENT 选目标环境（-p 不管用，见 syncEnvFor）
      env: envOverride ? { ...process.env, ...envOverride } : undefined,
    })
    let stdoutTail = ''
    let stderrTail = ''
    let killedByTimeout = false
    // 取消状态：cancelled 由 abort 信号置位，cancelled 为真时下面所有
    //   resolve 分支都走「已取消」这一条，绝不让退出码冒充成成败。
    let cancelled = false
    let resolved = false
    let safetyNetId = null
    const safeResolve = (r) => {
      if (resolved) return
      resolved = true
      if (safetyNetId) { clearTimeout(safetyNetId); safetyNetId = null }
      if (signal) { try { signal.removeEventListener('abort', onAbort) } catch (e) { /* 兼容 */ } }
      resolve(r)
    }
    // 取消：杀进程树（不等 close：进程可能永远不退，那时由安全网兜底）
    const doCancel = () => {
      if (cancelled) return
      cancelled = true
      try { killFn(child) } catch (e) { /* 已退出 */ }
      if (safetyNetId) clearTimeout(safetyNetId)
      safetyNetId = setTimeout(() => {
        // 杀不掉 ⇒ 不假装取消成功。前端据此重试或手动处置。
        safeResolve({ ok: false, code: 'INSTALL_CANCEL_FAILED', status: null,
          stdout: stdoutTail, stderr: stderrTail,
          error: 'Cannot cancel the install: the process could not be killed.\n'
            + 'A credential manager dialog may be blocking it, or the download '
            + 'is still writing to disk.',
          errorZh: '无法取消安装：进程杀不掉。\n'
            + '可能被凭据管理器弹框阻塞，也可能下载仍在写盘。' })
      }, safetyNetMs).unref()
    }
    const onAbort = () => doCancel()
    const onChunk = (buf, isErr) => {
      const text = buf.toString('utf8')
      if (isErr) stderrTail = (stderrTail + text).slice(-16000)
      else stdoutTail = (stdoutTail + text).slice(-16000)
      if (typeof onLine === 'function') {
        // 回调不能中断执行；出错只当没听见
        try { onLine(text, isErr) } catch (e) { /* 忽略 */ }
      }
      // 解析 uv/pip 下载进度并发送
      const progress = parseProgress(text)
      for (const p of progress) {
        if (typeof send === 'function') {
          try { send('progress', p) } catch (e) { /* 忽略 */ }
        }
      }
    }
    child.stdout.on('data', (d) => onChunk(d, false))
    child.stderr.on('data', (d) => onChunk(d, true))
    child.on('error', (err) => {
      // 起不来与取消无关：如实报 SPAWN_FAILED，不吞、也不伪装成取消
      safeResolve({ ok: false, code: 'SPAWN_FAILED', status: null,
        stdout: stdoutTail, stderr: stderrTail, error: err.message })
    })
    child.on('close', (code) => {
      // 取消优先：进程是被我们杀的，退出码（1 / 3221225786 之类）不是安装结论
      if (cancelled) {
        safeResolve({ ok: false, code: 'INSTALL_CANCELLED', status: code,
          stdout: stdoutTail, stderr: stderrTail,
          error: 'Install cancelled by user. The process tree was killed.\n'
            + 'The engine environment under engines/<id>/.venv is partial; '
            + 're-running this step rebuilds it.',
          errorZh: '安装已取消，进程树已终止。\n'
            + 'engines/<id>/.venv 下的环境是半截的；重新执行本步骤会先重建它。',
          cancelled: true })
        return
      }
      if (killedByTimeout) {
        safeResolve({ ok: false, code: 'ENV_TIMEOUT', status: code,
          stdout: stdoutTail, stderr: stderrTail,
          error: `Command timed out (${Math.round(timeoutMs / 60000)} min) and was killed.\n`
            + 'The download may still be in progress — re-running this step resumes '
            + 'from the breakpoint; already-downloaded parts are not re-fetched.',
          errorZh: `命令超时（${Math.round(timeoutMs / 60000)} 分钟）被终止。\n`
            + '下载可能仍在继续 —— 重新执行本步骤会从断点续传，不会重下已完成的部分。' })
        return
      }
      safeResolve({
        ok: code === 0,
        code: code === 0 ? 'OK' : 'ENV_FAILED',
        status: code,
        stdout: stdoutTail.trim(),
        stderr: stderrTail.trim(),
      })
    })
    // 取消信号：abort 一到就杀进程。注册放在 spawn 之后是因为
    //   killFn 需要 child 这个对象；abort 在 spawn 之前就到的情况
    //   由 runEnv 循环开头那道 abort 检查兜住（见 failedAt 之前的判断）。
    if (signal) {
      if (signal.aborted) { doCancel() }
      else { try { signal.addEventListener('abort', onAbort, { once: true }) } catch (e) { /* 兼容 */ } }
    }
    // 超时处理：杀掉进程树。uv/pip 下载大包时要很长的安静期，
    //   所以超时从「整条命令」放宽到「无输出超时」由调用方用 progress 心跳处理；
    //   这里只在调用方显式传 timeoutMs 时按总时长兜底。
    if (timeoutMs > 0) {
      setTimeout(() => {
        killedByTimeout = true
        try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
      }, timeoutMs).unref()
    }
  })
}

/**
 * @param {object} input {id, manifest, execute, root, timeoutMs, onStep}
 * @param {(i:number,total:number,step:object,argv:string[])=>void} [input.onStep]
 *   每步开始前的回调，用于让界面显示进度。
 * @param {(line:string, isErr:boolean)=>void} [input.onLine]
 *   每步 stdout/stderr 的逐行回调，用于进度条 / 实时日志。
 * @returns {Promise<object>} 计划的字段 + {stepsRun, failedAt, ok, note}
 */
async function runEnv (input = {}) {
  const plan = buildEnvPlan(input)
  // 判据是 input.execute，不是 plan.execute：
  //   buildEnvPlan 从不设置 plan.execute（它只负责出计划），
  //   读 plan.execute 永远 undefined ⇒ runEnv 一条命令都没跑就 return，
  //   而返回的 plan.ok 是 true ⇒ 界面显示「完成」。
  if (!plan.ok) return plan
  if (input.execute !== true) return { ...plan, stepsRun: [], failedAt: null }

  const root = input.root || projectRoot()
  const timeoutMs = input.timeoutMs || 60 * 60 * 1000   // 装环境要很久
  // 必须过滤掉 kind !== 'env' 的项：steps 里混着 {kind:'note'}
  //   那种说明性条目，它没有 argv ⇒ 直接 spawn 会报 ENOENT。
  const steps = (plan.steps || []).filter((s) => s && s.kind === 'env' && s.argv)
  const stepsRun = []
  // 装完自检用的探针入口（可注入，测试不许真 spawn）
  const probe = typeof input.probeImport === 'function' ? input.probeImport : null
  // 执行单步的入口（可注入，测试不许真装包）。
  //   注入点存在的理由：自检在全部步骤跑完之后才算，
  //   而计划里那几条 uv 命令一跑就是几个 GB ⇒ 测试必须能把「跑」这一步换掉，
  //   同时保留真实的计划（argv / env 的形状正是要验的东西）。
  const runStep = typeof input.runStep === 'function' ? input.runStep : runOne

  // 取消通道：端点把 AbortController 交进来（前端点「取消」→ abort）。
  //   没有 signal 时一切照旧：不取消的正常流程不受影响。
  const signal = (input.signal && typeof input.signal.addEventListener === 'function')
    ? input.signal : null

  // 断点续传：每个引擎目录下的 .wizard-install.json
  //   记录已成功完成的步骤（env 段）。重跑时跳过它们：
  //   uv/pip 的缓存会让重复跑同一条命令只重下缺的部分（已下载的 wheel
  //   不会重下）：所以「跳过已完成步骤」配合「不删环境目录」，中断重跑
  //   只补剩下的，而不是全部重来。
  // 判据必须含 argv：换了命令（比如换了 torch 后端）就不该跳过。
  // 判据还必须有产物检查：命令相同但产物没了 ⇒ 不许 SKIPPED（见 stepArtifactExists）
  const { readProgress: readEnvProgress, writeProgress: writeEnvProgress,
    resetProgress: resetEnvProgress } = require('./installState')
  let doneKeys = readEnvProgress(root, String(input.id || ''), 'env')
  // 从头重装：清除进度记录 + 忽略已完成（不许只让用户手动删文件）
  const resetProgress = input.resetProgress === true
  if (resetProgress) resetEnvProgress(root, String(input.id || ''), 'env')

  // 取消后留半截环境：第①步（建 .venv）之后取消/失败，.venv 里是一半的依赖。
  //   半截环境对 uv 是「看起来好的环境」：下次照旧跳过装包步，而 import 失败。
  //   所以重跑之前先看一眼标记：有标记就删掉整个 .venv，不留半成品给下一步。
  //   标记的写入时机：那一步不是成功的时候（取消 / 失败 / 超时）都写。
  if (!resetProgress && hasPartialVenvMark(root, String(input.id || ''))) {
    const venvDir = engineVenvDirAbs(root, String(input.id || ''))
    try { fs.rmSync(venvDir, { recursive: true, force: true }) } catch (e) { /* 删不掉 ⇒ 由后续命令如实报错 */ }
    markPartialVenv(root, String(input.id || ''), null)
    doneKeys = readEnvProgress(root, String(input.id || ''), 'env')
  }

  // 只有真正成功的步骤才写 done。SKIPPED 的产品也在里面（它确实完成了），
  //   但失败、取消、超时的那一条绝不进 done：把它写进去，
  //   下次重跑会跳过一条根本没跑完的命令，而界面显示「已完成」。
  const persist = () => {
    // 从头重装时不写进度文件（否则第一步完成后又被写回去）
    if (resetProgress) return
    writeEnvProgress(root, String(input.id || ''), 'env',
      stepsRun.filter((s) => s.ok === true).map((s) => s.argvKey))
  }
  // 这一步失败了/被取消了 ⇒ 留下「环境不完整」的标记，下次重跑先删半截环境
  const markBroken = (why) => {
    const id = String(input.id || '')
    try {
      // 只在建环境那一步之后才可能留下半截环境（第①步之前 .venv 还不存在）
      const built = fs.existsSync(engineVenvDirAbs(root, id))
      if (built) markPartialVenv(root, id, why)
    } catch (e) { /* 标记失败不该盖掉真正的错误 */ }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    // cwd 必须是绝对路径：上面的 spawn 用它当 cwd，
    //   传相对路径会相对于进程 cwd 而非项目根。
    step.absCwd = require('node:path').join(root, step.cwd || '.')
    // 头是 uv 这类平台自带工具时换成绝对路径。
    //   uv 装在项目根下（venv/Scripts/uv.exe），不是引擎的 root
    //   （夹具/引擎目录）下：所以要查 projectRoot()，不是 root。
    //   uv 不在 PATH 上时，spawn 用 shell:false ⇒ 只认绝对路径与 PATH。
    const argv = step.argv.slice()
    if (/^uv$/i.test(argv[0])) {
      // resolveUv 返回 {ok, argv:[py,'-m','uv'], via} | {ok:false, why}。
      //   ok 时把它的 argv 整段换上，失败时如实报 why。
      const uv = resolveUv(projectRoot()) || resolveUv(root)
      if (uv && uv.ok) {
        argv.splice(0, 1, ...uv.argv)
      } else {
        // uv 找不到 ⇒ 如实报「工具未找到」，不让 spawn 报 ENOENT
        return {
          ...plan, ok: false, code: 'UV_NOT_FOUND',
          stepsRun, failedAt: i + 1, failedArgv: step.argv,
          error: (uv && uv.why) || 'uv was not found. The platform usually ships it '
            + 'inside its own virtual environment; if that path is missing, check that the '
            + 'platform files are intact, or add uv to PATH and retry.',
          errorZh: (uv && uv.whyZh) || '未找到 uv。平台通常自带它（在平台自己的虚拟环境里），'
            + '如果该路径不存在，请确认平台文件完整，或将 uv 加入 PATH 后重试。',
          note: 'Installation did not start.',
          noteZh: '安装未开始。',
        }
      }
    }

    const argvKey = argv.join(' ')
    // 建环境那一步的幂等：环境已经能起（不是「目录存在」）⇒ 跳过。
    //   判据是 canUseEngineVenv（能不能按绝对路径 spawn），
    //   不是 existsSync：有「文件在但起不来」的情况
    //   （venv/Scripts/python.exe 在，pyvenv.cfg 指向另一台机器）。
    //   与断点续传同一套机制（标 SKIPPED、界面显示「已完成」）。
    const alreadyThere = step.skipIfExists === true
      && canUseEngineVenv(root, String(input.id || ''))
    if (alreadyThere) {
      stepsRun.push({
        n: i + 1, of: steps.length, argv, argvKey,
        ok: true, status: 0, code: 'SKIPPED',
        output: 'This engine already has a working Python environment — skipped.',
        outputZh: '该引擎已有可用的 Python 环境，跳过。',
        doneAt: new Date().toISOString(),
      })
      continue
    }
    // 断点续传：这条命令上次已经成功跑完 ⇒ 跳过（界面会看到「已完成」）。
    //   只有完全相同的命令才跳：换后端/换清单都会让 key 变，必须重跑。
    // 判据还必须有产物检查：命令相同但产物没了 ⇒ 不许 SKIPPED
    if (doneKeys.has(argvKey)) {
      if (stepArtifactExists(step, root, String(input.id || ''))) {
        stepsRun.push({
          n: i + 1, of: steps.length, argv, argvKey,
          ok: true, status: 0, code: 'SKIPPED',
          output: 'Previously completed successfully — skipped (breakpoint resume).',
          outputZh: '上次已成功执行，跳过（断点续传）。',
          doneAt: new Date().toISOString(),
        })
        continue
      }
      // 产物没了 ⇒ 不跳过，继续执行（下面会真的跑）
    }

    if (typeof input.onStep === 'function') {
      try { input.onStep(i, steps.length, step, argv) } catch (e) { /* 回调不影响安装 */ }
    }

    // 取消信号：每一步开跑之前先看一眼。上一步结束到这一步开始之间点了取消，
    //   就在这里停下，不新起进程（否则界面已经取消而进程又在跑）。
    if (signal && signal.aborted) {
      markBroken('cancelled before this step started')
      return {
        ...plan,
        ok: false,
        code: 'INSTALL_CANCELLED',
        cancelled: true,
        stepsRun,
        failedAt: i + 1,
        failedArgv: step.argv,
        error: 'Install cancelled by user. The process tree was killed.\n'
          + 'The engine environment under engines/<id>/.venv is partial; '
          + 're-running this step rebuilds it.',
        errorZh: '安装已取消，进程树已终止。\n'
          + 'engines/<id>/.venv 下的环境是半截的；重新执行本步骤会先重建它。',
        note: 'Steps that already succeeded are still recorded — '
          + 're-running skips them and continues from where it stopped.',
        noteZh: '已成功的步骤仍在断点记录里 —— 重跑会跳过它们、从未完成处继续。',
      }
    }

    // 取消通道交给 runOne（生产路径是 runOne，测试注入 runStep 时被换成假的，
    //   假的忽略第七个参数：那正是注入点的用法）。
    const r = await runStep(step, root, timeoutMs, argv, input.onLine, step.env,
      { signal })
    stepsRun.push({
      n: i + 1,
      of: steps.length,
      argv,
      argvKey,
      ok: r.ok,
      status: r.status,
      code: r.code,
      // 失败时带出上游原话；成功时只留尾部（uv 输出很长，界面用不上）
      output: r.ok ? r.stdout.slice(-2000) : (r.stderr || r.stdout || '(no output)'),
      doneAt: r.ok ? new Date().toISOString() : null,
    })
    persist()

    if (!r.ok) {
      // 半截环境标记：取消 / 失败 / 超时都要写（只有成功不写）
      if (r.code === 'INSTALL_CANCELLED' || r.code === 'INSTALL_CANCEL_FAILED') {
        markBroken('install cancelled by user')
      } else if (r.code === 'ENV_TIMEOUT') {
        markBroken('command timed out and was killed')
      } else {
        markBroken('command failed')
      }
      // 取消不是失败：代码、文案都要分开。取消是使用者自己的选择，
      //   把它写成「第 N 步失败」是在用一个错的结论解释一件对的事。
      const isCancelled = r.code === 'INSTALL_CANCELLED'
        || r.code === 'INSTALL_CANCEL_FAILED'
      return {
        ...plan,
        ok: false,
        code: r.code === 'SPAWN_FAILED' ? 'SPAWN_FAILED' : r.code,
        status: r.status,
        stepsRun,
        failedAt: isCancelled ? i + 1 : i + 1,
        failedArgv: step.argv,
        cancelled: isCancelled ? true : undefined,
        error: isCancelled
          ? 'Install cancelled by user. The process tree was killed.\n'
            + 'The engine environment under engines/<id>/.venv is partial; '
            + 're-running this step rebuilds it.'
          : (r.code === 'SPAWN_FAILED'
            ? `Cannot launch ${step.argv[0]}: ${r.error}\n`
              + 'The platform cannot confirm whether the install succeeded — check the engines/<id>/ directory.'
            : (r.stderr || r.stdout || '(no output)')),
        errorZh: isCancelled
          ? '安装已取消，进程树已终止。\n'
            + 'engines/<id>/.venv 下的环境是半截的；重新执行本步骤会先重建它。'
          : (r.code === 'SPAWN_FAILED'
            ? `起不动「${step.argv[0]}」：${r.error}\n`
              + '平台无法确认是否安装成功，请检查 engines/<id>/ 目录。'
            : (r.stderr || r.stdout || '（没有输出）')),
        // 取消时「上一步跑到哪了」仍然照实报：每一步的状态都在 stepsRun 里
        note: isCancelled
          ? `The install stopped before step ${i + 1}/${steps.length}. `
            + `${stepsRun.filter((s) => s.ok).length} step(s) had already finished.\n`
            + 'The engine environment is partial. Re-running this step removes '
            + 'the .venv and rebuilds it; already-downloaded wheels are still reused.'
          : (steps.length > 1
            ? `Step ${i + 1}/${steps.length} failed.\n`
              + 'An interrupted install leaves a partial environment. Re-running this step resumes from where it stopped:\n'
              + 'Steps that already succeeded are skipped, and only the rest continue (uv/pip caches keep the downloaded wheels).\n'
              + 'Read the error above before deciding whether to retry or change the command.'
            : 'An interrupted install leaves a partial environment. Re-running this step resumes from where it stopped:\n'
              + 'uv/pip caches keep the downloaded parts, so nothing is re-downloadable from scratch.\n'
              + 'Read the error above before deciding whether to retry or change the command.'),
        noteZh: isCancelled
          ? `安装停在第 ${i + 1}/${steps.length} 步之前，此前已有 `
            + `${stepsRun.filter((s) => s.ok).length} 步完成。\n`
            + '引擎环境停在半截状态。重新执行本步骤会先删掉 .venv 再重建，'
            + '已下载的依赖包仍会复用。'
          : (steps.length > 1
            ? `第 ${i + 1}/${steps.length} 步失败。\n`
              + '安装中断会保留不完整的环境。重新执行本步骤会从断点续传：\n'
              + '已成功的步骤会跳过，未完成的部分继续（uv/pip 的缓存会保留已下载的 wheel）。\n'
              + '请先阅读上方错误信息，再决定重试或更换命令。'
            : '安装中断会保留不完整的环境。重新执行本步骤会从断点续传：\n'
              + 'uv/pip 的缓存会保留已下载的部分，不会全部重下。\n'
              + '请先阅读上方错误信息，再决定重试或更换命令。'),
      }
    }
  }

  // 装完自检：命令全退 0 不等于这个环境能用。
  //   症状：三步退出码全是 0、界面显示「安装完成」，
  //   而 engines/<id>/.venv 独缺 torch ⇒ import torch 失败。
  //   成因是 alt 那步没钉目标环境（装进了平台根 venv），
  //   所以这里不是补一句提示，是如实判它有没有装成功。
  const v = verifyEngineEnvImports(root, String(input.id || ''),
    steps, plan.alternative, { probe: probe || undefined })
  if (v.checked && v.missing.length > 0) {
    return {
      ...plan,
      ok: false,
      // 不用 ENV_FAILED：那会让界面显示「第 N 步失败」，
      //   而事实上每一步都成功了，是装错了地方。
      code: 'ENGINE_ENV_UNUSABLE',
      envCheck: v,
      stepsRun,
      failedAt: null,
      error: `Every command reported success, but ${v.missing.join(', ')} `
        + 'cannot be imported in this engine\'s own environment under '
        + `engines/${input.id}/.venv.\n`
        + 'The packages went somewhere else, most likely the platform\'s own '
        + 'virtual environment.\n'
        + 'To install them into the engine\'s environment, run:\n'
        + `  <platform python> -m uv pip install -p <engines/${input.id}/.venv python> `
        + `${v.missing.join(' ')}\n`
        + 'The absolute path of that interpreter is shown in the command list above.',
      errorZh: `所有命令都报告成功，但 ${v.missing.join('、')} 在该引擎自己的环境`
        + `（engines/${input.id}/.venv）里无法 import。\n`
        + '这些包装到了别处，最可能装进了平台自己的虚拟环境。\n'
        + '装进该引擎环境的做法：\n'
        + `  <平台 python> -m uv pip install -p <engines/${input.id}/.venv 的 python> `
        + `${v.missing.join(' ')}\n`
        + '那个解释器的绝对路径见上方命令列表。',
      note: 'The install finished, but the engine cannot import its core '
        + `dependency (${v.missing.join(', ')}) in its own environment.\n`
        + 'An exit code of 0 only means the command finished. Re-running this '
        + 'step will skip the completed commands and run only what is missing.',
      noteZh: '安装已执行完毕，但该引擎在自己的环境里 import 不了核心依赖'
        + `（${v.missing.join('、')}）。\n`
        + '退出码 0 只说明命令执行完毕。重新执行本步骤会跳过已完成的命令，'
        + '只补装缺的部分。',
    }
  }

  // 走到这里 = 全部步骤成功、自检也过了 ⇒ 抹掉「环境不完整」的标记。
  //   标记是给失败/取消用的，装完还留着它，下次重跑会白删一次 .venv。
  markPartialVenv(root, String(input.id || ''), null)

  return {
    ...plan,
    ok: true,
    envStatus: 0,
    stepsRun,
    failedAt: null,
    // 自检结论带给界面：通过时说清验过了（不许只是安静地成功）
    envCheck: v,
    note: v.checked
      ? `Completed ${steps.length} step(s). Every command exited 0, and `
        + `${v.mods.join(', ')} imports in this engine's own environment. `
        + 'Whether the engine can actually start still needs the checks that come next.'
      : `Completed ${steps.length} step(s). An exit code of 0 only means the command finished —`
        + ' whether the engine can actually be imported still needs the checks that come next.',
    noteZh: v.checked
      ? `已完成 ${steps.length} 个步骤。所有命令退出码均为 0，`
        + `且 ${v.mods.join('、')} 在该引擎自己的环境里可以 import。`
        + '该引擎能否真正启动仍需后续校验。'
      : `已完成 ${steps.length} 个步骤。退出码 0 仅表示命令执行完毕，`
        + '该引擎能否正常导入仍需后续校验。',
  }
}

/**
 * 装包那步的产物：目标 site-packages 非空。
 *
 * 路径按平台推导（与 venvPythonRelPath 同一套）：
 *   win32  → .venv/Lib/site-packages
 *   posix  → .venv/lib/python3.x/site-packages
 * 不猜版本号：遍历 lib/ 下所有 python3.* 目录。
 *
 * @param {string} venvDir 该引擎 .venv 目录的绝对路径
 * @returns {boolean}
 */
function sitePackagesNonEmpty (venvDir) {
  const candidates = []
  if (process.platform === 'win32') {
    candidates.push(path.join(venvDir, 'Lib', 'site-packages'))
  } else {
    const libDir = path.join(venvDir, 'lib')
    let entries = []
    try { entries = fs.readdirSync(libDir, { withFileTypes: true }) } catch (e) { return false }
    for (const e of entries) {
      if (e.isDirectory() && /^python3\./.test(e.name)) {
        candidates.push(path.join(libDir, e.name, 'site-packages'))
      }
    }
  }
  for (const sp of candidates) {
    try {
      const items = fs.readdirSync(sp)
      if (items.length > 0) return true
    } catch (e) { /* 下一个 */ }
  }
  return false
}

/**
 * 某一步的产物是否还在。
 *
 * 只判断「命令执行完该留下的东西」在不在，不看命令文本：
 *   建环境那步（skipIfExists）→ 引擎 venv 的解释器能起
 *   装包那步 → 目标 venv 的 site-packages 非空
 * 认不出的步（如 conda、纯脚本）→ 返回 true，按旧行为交给命令文本判重，
 *   不因为「不认识」就把已经完成的步骤重跑一遍。
 *
 * @param {object} step 计划里的一步
 * @param {string} root 项目根
 * @param {string} id 引擎 id
 * @returns {boolean} 产物在不在
 */
function stepArtifactExists (step, root, id) {
  const venvDir = engineVenvDirAbs(root, id)
  if (step && step.skipIfExists) {
    // 建环境那步：解释器能起才算产物在（只有目录不算，空壳 venv 会骗过存在性检查）
    return canUseEngineVenv(root, id)
  }
  const argv = (step && step.argv) || []
  const joined = argv.join(' ')
  if (/\b(uv|pip)\b/.test(joined) && /\b(install|sync)\b/.test(joined)) {
    return sitePackagesNonEmpty(venvDir)
  }
  return true
}

module.exports = {
  readEnvCommand, detectDependencyManifest, buildEnvPlan, runEnv,
  uvRelPath, resolveUv,
  // 建隔离环境用得上的那几件（buildVenvStep / canUseEngineVenv 等）
  engineVenvDirAbs, engineVenvPythonAbs, canUseEngineVenv,
  platformPythonAbs, buildVenvStep, withTargetPython, syncEnvFor,
  // 装完自检（装出来的环境缺 torch 却报成功）
  verifyEngineEnvImports, probeImportInEngineVenv, isVenvCreateStep,
  // 断点续传的产物检查（命令相同但产物没了仍跳过）
  stepArtifactExists, sitePackagesNonEmpty,
  // 单步执行（取消通道的载体，测试注入 spawn 不真跑）
  runOne,
  // 取消/失败后留半截环境的标记（重跑先删 .venv 再建）
  partialVenvMarkAbs, hasPartialVenvMark, markPartialVenv,
}