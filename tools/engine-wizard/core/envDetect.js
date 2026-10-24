'use strict'
// 引擎依赖环境的检测层：读名片里声明的 install.env_command、按上游的依赖清单推导装法、
// 推导引擎虚拟环境的路径与解释器。全部是读盘与路径计算，不执行安装。
// 判据是名片的 install 段与上游目录里的依赖清单文件；两者都没有就把选择权交回使用者。

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { projectRoot, engineDir } = require('./clone.js')
const { venvPythonRelPath } = require(
  path.join(__dirname, '..', '..', '..', 'lib', 'engines', 'platformPaths.js'))
const { canSpawnPython } = require(
  path.join(__dirname, '..', '..', '..', 'lib', 'util', 'pythonResolve.js'))

// 平台基座的 Python 版本。引擎没声明版本时用它。
//   这是 AI 生态最常用的版本，也是仓库内嵌解释器（tools/runtime/python）的版本；
//   平台自带的 wheel（tools/wheels 里的 cp311 轮子）也只认它。
const PLATFORM_BASE_PYTHON = '3.11'

/**
 * 读名片里的 install.env_command 并校验。
 * 返回 {ok:true, argv} 或 {ok:false, code, error}：code 分别是 NO_INSTALL_SECTION（名片没有
 * install 段）、NO_ENV_COMMAND（有 install 段但没写 env_command）、BAD_ENV_COMMAND
 * （env_command 不是非空字符串数组）。argv 是去空白后的命令与参数。
 */
function readEnvCommand (manifest) {
  const inst = manifest && manifest.install
  if (inst === undefined || inst === null) {
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
 * 锁文件锁定的 torch 后端与本机推荐的后端不一致时，给出另一条安装命令。
 * 两条命令都给，不替使用者选定其中一条。无法判定时返回 null。
 * 判定成立时返回 {then, why, whyZh, needs, familyPins}：then 是补装 torch 系的命令，
 * needs 是要补装的包名。
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

  if (pin.backend && pin.backend === rec.recommended) return null

  const opt = (hw.BACKEND_PREFERENCE || []).find((b) => b.key === rec.recommended)
  if (!opt || !opt.index) return null

  const family = hw.readTorchFamilyPins(text)
  if (!family || !family.length) return null

  const specs = family.map((p) => `${p.name}==${p.plain}`)
  const names = family.map((p) => p.name)

  return {
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
 * 按上游目录里的依赖清单推导安装方式。
 * 返回 {argv, from, cwd, why, whyZh}：argv 是安装命令，from 是依据的清单文件，cwd 是执行目录。
 * 根目录与一层子目录都找不到依赖清单时 argv 为 null，交给使用者自己装。
 */
function suggestEnvCommand (dir) {
  const NAMES = ['pyproject.toml', 'uv.lock', 'requirements.txt', 'environment.yml']
  const SKIP = new Set(['.venv', 'venv', 'site-packages', 'node_modules',
    'third_party', 'vendor', '.git', '__pycache__'])
  const found = []
  let rootLevelLock = null
  for (const f of NAMES) {
    if (fs.existsSync(path.join(dir, f))) {
      found.push(f)
      if (f === 'uv.lock') rootLevelLock = f
    }
  }
  if (found.length === 0) {
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
  const pick = (n) => found.find((f) => f === n || f.endsWith('/' + n))
  const lock = pick('uv.lock')
  const conda = pick('environment.yml')
  const pyproj = pick('pyproject.toml')
  const req = pick('requirements.txt')
  if (lock) {
    const alt = suggestBackendAlternative(dir, lock)
    return { argv: ['uv', 'sync'], from: lock, cwd: '.',
      why: (alt
        ? `The upstream provides ${lock}; the Torch backend it pins does not match this machine, `
          + `so Torch is skipped and only the rest is installed.`
        : `The upstream provides ${lock} — versions are already pinned, so install straight from it.`),
      whyZh: (alt
        ? `上游有 ${lock}，其中锁定的 torch 后端与本机不一致，`
          + `因此跳过 torch、只装其余依赖。`
        : `上游有 ${lock} ⇒ 版本已经定死了，照它装最稳。`),
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

/**
 * 查这一层目录里有没有上游的依赖清单。
 * 返回 {found, found_files, note, noteZh}：found 为 true 时 found_files 是清单文件名数组，
 * 为 false 时 found_files 为空数组，note 与 noteZh 说明这一层没有清单。
 */
function detectDependencyManifest (dir) {
  const candidates = [
    'pyproject.toml', 'uv.lock', 'requirements.txt',
    'environment.yml', 'setup.py',
  ]
  const found = candidates.filter((f) => fs.existsSync(path.join(dir, f)))
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

// 安装进度标记：装到一半被打断时，虚拟环境目录里留下这个标记文件。

const PARTIAL_VENV_MARK = '.wizard-partial-venv'

function partialVenvMarkAbs (root, id) {
  return path.join(engineVenvDirAbs(root, id), PARTIAL_VENV_MARK)
}

function hasPartialVenvMark (root, id) {
  try { return fs.existsSync(partialVenvMarkAbs(root, id)) } catch (e) { return false }
}

/**
 * 写或删安装进度标记。why 为 null 或 undefined 表示删掉标记。
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

// 引擎虚拟环境的路径推导：每个引擎的环境放在 engines/<id>/.venv 下。

function engineVenvDirAbs (root, id) {
  return path.join(root, 'engines', String(id), '.venv')
}

/**
 * 引擎虚拟环境里的解释器路径。当前平台没有已知的虚拟环境布局时返回 null。
 */
function engineVenvPythonAbs (root, id) {
  const rel = venvPythonRelPath(process.platform)
  if (!rel) return null
  return path.join(engineVenvDirAbs(root, id), rel)
}

/**
 * 这台引擎的虚拟环境能不能用。解释器路径算不出来，或该解释器起不来，都返回 false。
 */
function canUseEngineVenv (root, id) {
  const py = engineVenvPythonAbs(root, id)
  if (!py) return false
  return canSpawnPython(py)
}

/**
 * 从 requires-python 的区间里挑一个具体的主次版本。
 *
 * 规则：**优先选区间内最高的版本**。
 *   `>=3.10,<3.12` ⇒ 3.11（上界排他，所以取上界减一）
 *   `>=3.10,<3.13` ⇒ 3.12
 *   `>=3.10,<=3.12` ⇒ 3.12（上界包容，取上界本身）
 *   `>=3.10` ⇒ 3.10（没有上界就没有「最高」可取，取下界）
 *   `==3.11.*` / `~=3.11` / `3.11` ⇒ 3.11
 *
 * 为什么取最高而不是最低：区间表达的是「这一族都能跑」，而上游通常是在
 * 较新的 Python 上测试的。取区间内最高的版本，才落在上游真正测过的那一档；
 * 取下界反而可能撞上上游没测过的旧版本。
 * Python 的 wheel ABI 按主次版本分，所以只需要主次版本。
 *
 * @param {string} spec requires-python 的原始值
 * @returns {string|null} '3.11' 这样的主次版本；解析不出来返回 null
 */
function pickFromRequiresPython (spec) {
  const s = String(spec || '').trim()
  if (!s) return null

  // 单版本形态：==3.11 / ==3.11.* / ~=3.11 / 3.11
  const eq = s.match(/^(?:==|~=)?\s*(\d+)\.(\d+)/)
  if (eq && !s.includes('>') && !s.includes('<')) {
    return `${eq[1]}.${eq[2]}`
  }

  // 上界：<3.12（排他）要减一；<=3.12（包容）取本值
  const upper = s.match(/<=\s*(\d+)\.(\d+)/)
  const upperExclusive = upper || s.match(/<\s*(\d+)\.(\d+)/)
  if (upperExclusive) {
    const [, maj, min] = upperExclusive
    if (upper) return `${maj}.${min}`
    // 排他上界：最高可选是上界的前一个次版本
    const m = Number(min)
    return m > 0 ? `${maj}.${m - 1}` : `${Number(maj) - 1}.0`
  }

  // 只有下界：取下界
  const lower = s.match(/>=\s*(\d+)\.(\d+)/)
  if (lower) return `${lower[1]}.${lower[2]}`

  return null
}

/**
 * 读这台引擎自己声明的 Python 版本。
 *
 * 两个来源，同一优先级：根目录的 .python-version 文件（上游钉死的那个版本），
 * 其次是 pyproject.toml 的 requires-python（可能是区间）。
 * 都没有时返回 null：平台不猜版本，退回平台基座。
 *
 * 返回 {version, source}：version 是 '3.11' 这样的主次版本；source 是
 * 'python-version' 或 'requires-python'，供界面说清「按哪个声明建的」。
 */
function readEnginePythonVersion (dir) {
  // 来源一：.python-version 文件。一行一个版本号，可能带补丁号（3.11.13）。
  try {
    const raw = fs.readFileSync(path.join(dir, '.python-version'), 'utf8').trim()
    const m = raw.match(/^(\d+)\.(\d+)/)
    if (m) return { version: `${m[1]}.${m[2]}`, source: 'python-version' }
  } catch (e) { /* 没有这个文件就往下看 */ }

  // 来源二：pyproject.toml 的 requires-python。区间取区内最高的那个版本。
  try {
    const raw = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8')
    const m = raw.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)
    if (m) {
      const picked = pickFromRequiresPython(m[1])
      if (picked) return { version: picked, source: 'requires-python' }
    }
  } catch (e) { /* 没有 pyproject 就往下看 */ }

  return null
}

/**
 * 这个解释器的版本在不在受支持的区间内。
 * want 形如 '3.11' 或 [3, 11]；匹配主次版本。
 * 读不出版本时返回 null（调用方按「不校验」处理，不因此拒绝候选）。
 */
function supportsVersion (exe, want) {
  const parts = Array.isArray(want) ? want : String(want).split('.').map(Number)
  if (!parts.length || parts.some((n) => !Number.isInteger(n))) return null
  let r
  try {
    r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false })
  } catch (e) { return null }
  if (r.error || r.status !== 0) return null
  const m = /(\d+)\.(\d+)/.exec((r.stdout || '') + (r.stderr || ''))
  if (!m) return null
  return Number(m[1]) === parts[0] && Number(m[2]) === parts[1]
}

/**
 * 平台自己的解释器路径，用来跑 uv。
 *
 * 顺序：平台根 venv / cache/slim-venv（这两个自带 uv）先于仓库内嵌的解释器
 * （内嵌解释器是裸解释器，没装 uv，只能当引擎环境的目标解释器）。
 * 候选按顺序试，第一个「能起且版本受支持」的胜出。找不到时返回 null。
 */
function platformPythonAbs (root, opts = {}) {
  const prj = (() => { try { return projectRoot() } catch (e) { return null } })()
  const bases = [prj, root].filter((b) => typeof b === 'string' && b)
  const candidates = [
    // 带 uv 的平台环境：跑 uv 得用它。
    ...bases.flatMap((b) => {
      const r = venvPythonRelPath(process.platform)
      return r ? [
        path.join(b, 'venv', r),
        path.join(b, 'cache', 'slim-venv', r),
      ] : []
    }),
    // 内嵌解释器：本仓库自带，可跟着仓库搬（与 bootstrap 用的同一个）。
    ...(prj ? [path.join(prj, 'tools', 'runtime', 'python',
      process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'))] : []),
  ].filter((p) => typeof p === 'string' && p)
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue
    } catch (e) { continue }
    if (!canSpawnPython(p)) continue
    if (opts.requireVersion && !supportsVersion(p, opts.requireVersion)) continue
    return p
  }
  return null
}

/**
 * 造出建虚拟环境这一步。
 *
 * 解释器的选法（规范，不猜）：
 *   ① 引擎自己声明了 Python 版本（.python-version 或 requires-python）⇒ 用它；
 *     requires-python 是区间时取**区间内最高的那个版本**（见 pickFromRequiresPython）。
 *   ② 引擎没声明 ⇒ 用平台基座（3.11）；
 *   ③ 连平台基座都拿不到 ⇒ 报出来，不回落去任意版本的解释器。
 * 第③条是硬的：回落等于把「版本不匹配」这个错误推迟到装依赖那一步，
 * 症状变成「No solution found when resolving dependencies」，看不出真因。
 *
 * 两个 python 各自的角色（别混）：
 *   · argv[0] 是**跑 uv 的那个**解释器：它必须有 uv（平台根 venv / slim-venv 有，
 *     仓库内嵌的解释器是裸解释器、没装 uv）。
 *   · --python 给的是**新环境该用哪个版本**：引擎声明了就用声明的版本号，
 *     没声明就用平台基座版本号。给版本号而不是路径 ⇒ 本机没有那个版本时，
 *     uv 会自己下载一个（3.10 / 3.11.13 / 3.12 都拉得下来）。
 *
 * 返回 {argv, python, venvDir, skipIfExists, pythonVersion, pythonVersionSource}：
 * argv 是建环境的命令，python 是跑 uv 的解释器路径，venvDir 是环境目录，
 * skipIfExists 表示环境已存在时跳过这一步。
 * 找不到可用的解释器时 argv 为 null。
 */
function buildVenvStep (root, id) {
  const venvDir = engineVenvDirAbs(root, id)
  const declared = readEnginePythonVersion(engineDir(id, root))
  // 引擎声明了就用声明的，没声明就用平台基座 3.11。
  //   两条路都拿不到 ⇒ 不用任意版本顶上：见本函数的注释第③条。
  const wantVersion = declared ? declared.version : PLATFORM_BASE_PYTHON
  const uvPy = platformPythonAbs(root)
  if (!uvPy) {
    return {
      argv: null, python: null,
      pythonVersion: wantVersion,
      pythonVersionSource: declared ? declared.source : 'platform-base',
      why: 'The platform cannot find a Python interpreter with uv installed, '
        + 'so it cannot create the engine environment.',
      whyZh: '平台上找不到装了 uv 的 Python 解释器，无法为该引擎建立环境。',
    }
  }
  return {
    argv: [uvPy, '-m', 'uv', 'venv', venvDir, '--python', wantVersion, '--no-project'],
    python: uvPy,
    venvDir,
    skipIfExists: true,
    pythonVersion: wantVersion,
    pythonVersionSource: declared ? declared.source : 'platform-base',
    why: 'Create an isolated Python environment for this engine under engines/'
      + `${id}/.venv. Dependencies are installed into it, not into the platform's own `
      + `environment. The environment uses Python ${wantVersion}`
      + (declared ? ` (declared by the engine in ${declared.source})` : ' (the platform base version)')
      + '.',
    whyZh: `为该引擎在 engines/${id}/.venv 下建一个独立的 Python 环境。`
      + '依赖会装进这个环境，不装进平台自己的环境。'
      + `环境用 Python ${wantVersion}`
      + (declared ? `（引擎在 ${declared.source} 里声明的）` : '（平台基座版本）') + '。',
  }
}

/**
 * 在 uv 命令里补上目标解释器。
 * 补上 -p <pyAbs> 后的命令。命令不是 uv pip，或者已经带了 -p / --python 时原样返回。
 */
function withTargetPython (argv, pyAbs) {
  if (!pyAbs) return argv
  const out = (argv || []).slice()
  if (out.includes('-p') || out.includes('--python')) return out
  if (!/^uv$/i.test(out[0] || '') || out[1] !== 'pip') return out
  let at = 2
  if (out[2] === 'install' || out[2] === 'compile' || out[2] === 'sync') at = 3
  out.splice(at, 0, '-p', pyAbs)
  return out
}

/**
 * 让 uv 把这个虚拟环境当作项目环境。
 * 返回 {UV_PROJECT_ENVIRONMENT}，作为执行这条命令时传入的环境变量。
 */
function syncEnvFor (venvDirAbs) {
  return { UV_PROJECT_ENVIRONMENT: venvDirAbs }
}

/**
 * 这一步是不是在建虚拟环境。命令是 uv venv 时返回 true。
 */
function isVenvCreateStep (step) {
  const argv = (step && step.argv) || []
  for (let i = 0; i + 1 < argv.length; i++) {
    if (/^uv$/i.test(argv[i]) && /^venv$/i.test(argv[i + 1])) return true
  }
  return false
}

module.exports = {
  readEnvCommand,
  detectDependencyManifest,
  suggestEnvCommand,
  engineVenvDirAbs,
  engineVenvPythonAbs,
  canUseEngineVenv,
  platformPythonAbs,
  supportsVersion,
  readEnginePythonVersion,
  pickFromRequiresPython,
  PLATFORM_BASE_PYTHON,
  buildVenvStep,
  withTargetPython,
  syncEnvFor,
  isVenvCreateStep,
  partialVenvMarkAbs,
  hasPartialVenvMark,
  markPartialVenv,
}
