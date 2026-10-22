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
 * 平台自己的解释器路径，用来建引擎的虚拟环境。
 * 找的是项目根下的 venv/，不是引擎自己的 engines/<id>/.venv。找不到时返回 null。
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
 * 造出建虚拟环境这一步。
 * 返回 {argv, python, venvDir, skipIfExists}：argv 是建环境的命令，python 是解释器路径，
 * venvDir 是环境目录，skipIfExists 表示环境已存在时跳过这一步。
 * 找不到可用的解释器时 argv 为 null。
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
  buildVenvStep,
  withTargetPython,
  syncEnvFor,
  isVenvCreateStep,
  partialVenvMarkAbs,
  hasPartialVenvMark,
  markPartialVenv,
}
