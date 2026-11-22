'use strict'

// 引擎依赖环境的安装：组装执行计划、逐条执行、装完自检。
// 装法由名片的 install.env_command 决定；名片的 uv 命令需要替换时，uv 的位置由 resolveUv 解析。
// 进度与断点续传由 envProgress.js 负责，本文件只管「执行哪条命令、执行结果是什么」。

const fs = require('node:fs')
const { applyInstallChoices, declaredDeps } = require('./installChoices')
const path = require('node:path')
const { spawnSync, spawn } = require('node:child_process')
const { projectRoot, engineDir } = require('./clone.js')
const { killProcessTree } = require('./clone.js')
const { venvPythonRelPath } = require(
  path.join(__dirname, '..', '..', '..', 'lib', 'engines', 'platformPaths.js'))
const { canSpawnPython } = require(
  path.join(__dirname, '..', '..', '..', 'lib', 'util', 'pythonResolve.js'))
const {
  readEnvCommand,
  detectDependencyManifest,
  suggestEnvCommand,
  engineVenvDirAbs,
  engineVenvPythonAbs,
  canUseEngineVenv,
  buildVenvStep,
  readEnginePythonVersion,
  PYTHON_VERSION_POOL,
  withTargetPython,
  syncEnvFor,
  isVenvCreateStep,
  hasPartialVenvMark,
  markPartialVenv,
} = require('./envDetect')
const { stepArtifactExists } = require('./envProgress')
const {
  uvCacheDirFor,
} = require(
  path.join(__dirname, '..', '..', '..', 'lib', 'paths', 'cache.js'))

// uv 可执行文件相对于平台虚拟环境目录的位置。平台不认识这个布局时返回 null。
function uvRelPath (platform) {
  if (platform === 'win32') return path.join('Scripts', 'uv.exe')
  if (platform === 'linux' || platform === 'darwin') return path.join('bin', 'uv')
  return null
}

// 解析 uv 的调用方式：先找平台虚拟环境里自带的 uv，再找 PATH 上的 uv。
// 返回 { ok, argv, via }：argv 是可直接 spawn 的参数数组，两种来源的调用方式一致。
function resolveUv (root, platform) {
  const plat = platform || process.platform
  const pyRel = venvPythonRelPath(plat)
  if (!pyRel) return { ok: false, why: '这个平台（' + (plat || '未知') + '）没有已知的 Python 虚拟环境布局' }

  const venvs = [path.join(root, 'venv'), path.join(root, 'cache', 'slim-venv')]
  for (const v of venvs) {
    const py = path.join(v, pyRel)
    try {
      if (!fs.existsSync(py)) continue
      const chk = spawnSync(py, ['-m', 'uv', '--version'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000, windowsHide: true, shell: false,
      })
      if (chk.status === 0) return { ok: true, argv: [py, '-m', 'uv'], via: 'venv 自带 uv（' + v + '）' }
    } catch (e) { /* 换下一个候选 */ }
  }
  const p = spawnSync('uv', ['--version'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000, windowsHide: true, shell: false,
  })
  if (!p.error && p.status === 0) return { ok: true, argv: ['uv'], via: 'uv on PATH', viaZh: 'PATH 上的 uv' }
  return { ok: false, why: 'uv was not found (neither in the platform venv nor on PATH).',
    whyZh: '未找到 uv（平台 venv 里没有，PATH 上也没有）' }
}

// uv 有几类可判定的失败会在报错里给出自己的解法。按提示各重试一次，
//   不改上游声明，也不把这些开关默认加到所有安装上。
const UV_INDEX_HINT_RE = /--index-strategy unsafe-best-match|not at the requested version/i
const UV_BUILD_DEP_HINT_RE = /No module named 'pkg_resources'|doesn't declare it as a build dependency|extra-build-dependencies/i
// `-e .` 撞上「上游这个 pyproject 根本不是给安装用的」的三种报错。判据取 setuptools /
//   pip 自己的原话：缺构建后端、flat-layout 里多个顶层包、legacy 构建后端失败。
//   三者都说明上游没有声明一个可安装的项目，与包本身能不能编出来无关。
const UV_NOT_INSTALLABLE_RE = /Multiple top-level packages discovered|does not include a [`"']?\[build-system\][`"']?|build_meta:__legacy__\.build_editable[\s\S]{0,40}failed/i

function afterPipInstall (argv, words) {
  const at = argv.findIndex((w, i) => i > 0 && w === 'install' && argv[i - 1] === 'pip')
  if (at < 0) return null
  const out = argv.slice()
  out.splice(at + 1, 0, ...words)
  return out
}

/**
 * 把 `-e <path>` 换成 `-r requirements.txt`（同目录）。
 * 只在同目录确有 requirements.txt 时换，否则返回 null 让这次失败如实上报：
 *   没有可换的清单时把错误换成另一条命令，只会把真正的原因埋掉。
 * 其余参数（解释器、索引、--no-deps）原样保留，依赖版本全部交给 uv 解析。
 */
function switchToRequirements (argv, step, root, id) {
  if (!Array.isArray(argv) || argv.includes('-r')) return null
  const dir = step && (step.absCwd || step.cwd)
    ? (step.absCwd || path.join(root, 'engines', id, step.cwd))
    : path.join(root, 'engines', id)
  try {
    if (!fs.existsSync(path.join(dir, 'requirements.txt'))) return null
  } catch (e) { return null }
  const out = argv.slice()
  const i = out.indexOf('-e')
  if (i >= 0) out.splice(i, 2, '-r', 'requirements.txt')
  else out.push('-r', 'requirements.txt')
  return out
}

function withIndexStrategy (argv) {
  if (argv.includes('--index-strategy')) return null
  return afterPipInstall(argv, ['--index-strategy', 'unsafe-best-match'])
}

// 老源码包在 setup.py 里用了 pkg_resources 却没声明构建依赖；新版 setuptools
//   的构建隔离环境里没有它。约束构建期 setuptools 版本即可，不动运行时环境。
function buildConstraintFile (root, id) {
  const f = path.join(root, 'engines', String(id || ''), '.wizard-build-constraints.txt')
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, 'setuptools<81\n', 'utf8')
  } catch (e) { return null }
  return f
}

// uv 把 wheel 缓存指针写到同目录的 .tmpXXXX/link，再用 rename 覆盖最终名。
//   Windows 上覆盖已存在文件时，目标被别的句柄以不共享删除的方式打开、或目标
//   带只读属性，MoveFileEx 都返回 ERROR_ACCESS_DENIED(5)；两种情况的错误码相同，
//   单看错误码分不出来。缓存路径与结构本身正常，故不属于位置写错。
//   按访问防护会在文件刚写入时短暂持有句柄（本机 Defender 实时保护开启，D: 盘
//   无排除项），于是同一个包可能这次成功、下次失败，换一个包也会出现。清缓存
//   残留治不了这一类：目标指针本身有效，uv 是在覆盖它。
//   判断时同时要求出现拒绝访问与 uv 缓存内部路径，避免把引擎目录本身的权限
//   问题也当成缓存冲突来重试。
const UV_CACHE_BUSY_RE = /os error 5|拒绝访问|Access is denied/i
// builds-v<n> 是 uv 解 sdist 时的构建目录：setuptools 往 wheel 目录里写 egg-info
//   会撞上已存在的半成品与按访问防护的句柄，报的同样是拒绝访问。
//   它不是 wheel 缓存指针，但同属 uv 缓存内部路径，判据一并认。
const UV_CACHE_PATH_RE = /(?:wheels-v\d+|archive-v\d+|sdists-v\d+|builds-v\d+)[\\/]|\.tmp[A-Za-z0-9]{4,}[\\/]link/i

function isUvCacheBusy (r) {
  const text = `${r.stderr || ''}\n${r.stdout || ''}`
  return UV_CACHE_BUSY_RE.test(text) && UV_CACHE_PATH_RE.test(text)
}

// 缓存写入冲突第二档重试用的独立缓存目录：与主缓存分开，绕开被占用的条目。
//   保留下来供后续重试复用，不清空。
function uvRetryCacheDir (root) {
  return path.join(root || projectRoot() || '', 'cache', 'uv-retry')
}

// 组装要执行的步骤：建环境、照上游锁文件装依赖、按需另装与本机后端匹配的 torch。
/**
 * `uv sync` 也要点名 Python 版本。
 *
 * sync 管的是「项目环境」：它按 pyproject 的 requires-python 自己挑解释器，
 *   UV_PROJECT_ENVIRONMENT 只告诉它环境放在哪，不告诉它用哪个版本。
 *   于是出现这种局面：引擎声明 >=3.10,<3.14，人在下拉里选了 3.12、平台也照着
 *   建了 3.12 的环境，sync 却仍按 3.13 去解析依赖，报错里写的是 cp313，
 *   而盘上的环境明明是 3.12。选版本这一步等于失效。
 */
function withSyncPython (argv, version) {
  if (!Array.isArray(argv) || !version) return argv
  const isSync = /^uv$/i.test(argv[0]) && /^sync$/i.test(argv[1])
  if (!isSync) return argv
  if (argv.some((a) => a === '-p' || a === '--python' || a.startsWith('--python='))) return argv
  return [...argv, '--python', String(version)]
}

function buildSteps ({ argv, cwdRel, alt, venv, sync, targetPython, altPython, specs, specNames }) {
  const steps = []
  if (venv && Array.isArray(venv.argv)) {
    steps.push({
      kind: 'env',
      argv: venv.argv,
      cwd: cwdRel,
      needs_network: false,
      skipIfExists: true,
      why: venv.why,
      whyZh: venv.whyZh,
    })
  }
  steps.push({
    kind: 'env',
    // sync 路线必须把版本点名，否则它按 requires-python 自己挑，选的版本等于白选。
    argv: withSyncPython(argv, venv && venv.pythonVersion),
    cwd: cwdRel,
    needs_network: true,
    env: sync || undefined,
    // 这步的产物是「依赖清单里的包都装上」：把清单解析出的包名挂在这里，
    //   断点续传与完成判定都读它。`-r requirements.txt` 形式下包名不在 argv 上，
    //   没有这份列表就只能退化成「site-packages 非空」：装了 torch 就算过，
    //   清单里其余的包从没装过也照样报完成。
    specs: Array.isArray(specs) ? specs : undefined,
    specNames: Array.isArray(specNames) && specNames.length ? specNames : undefined,
    why: 'Install dependencies from the upstream lock file.',
    whyZh: '照上游依赖清单安装。',
  })
  if (alt && alt.then) {
    steps.push({
      kind: 'env',
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
 * 下拉里能选的 Python 版本。
 *   失败时解析出的「这个依赖支持哪几档」要并进来：否则文案让人选 3.9、下拉里却没有 3.9，
 *   说得对但做不到。
 */
function mergeVersionOptions (pool, extra) {
  const base = (Array.isArray(pool) && pool.length) ? pool : PYTHON_VERSION_POOL.slice()
  const more = Array.isArray(extra) ? extra : []
  const all = [...new Set([...base, ...more])]
  return all.sort((a, b) => {
    const [a1, a2] = String(a).split('.').map(Number)
    const [b1, b2] = String(b).split('.').map(Number)
    return (a1 - b1) || (a2 - b2)
  })
}

/**
 * 界面上要显示的 Python 版本信息。
 *   python_version          这次要建的版本（人选的优先，其次引擎声明的，最后平台基座）
 *   python_version_source   依据：python-version / requires-python / chosen / platform-base
 *   python_version_declared 引擎声明的原文（可能是区间），给人对照着选
 *   python_version_options  可选档位
 */
function pythonMeta (root, id, venv) {
  const declared = readEnginePythonVersion(engineDir(id, root))
  const current = venv ? venv.pythonVersion : null
  const options = PYTHON_VERSION_POOL.slice()
  // 当前生效的版本必须在选项里：不在的话 <select> 会把第一项当成选中项显示出来，
  //   看上去像「平台要用 3.8 建环境」，而实际用的是声明里那一档。
  //   引擎声明的版本也一并保住，同理。
  for (const v of [current, declared ? declared.version : null]) {
    if (v && !options.includes(v)) options.push(v)
  }
  options.sort((a, b) => {
    const [a1, a2] = String(a).split('.').map(Number)
    const [b1, b2] = String(b).split('.').map(Number)
    return (a1 - b1) || (a2 - b2)
  })
  return {
    python_version: current,
    python_version_source: venv ? venv.pythonVersionSource : null,
    python_version_declared: declared ? (declared.spec || declared.version) : null,
    python_version_options: options,
  }
}

/**
 * 把 uv 的「这个包没有当前 Python 版本的 wheel」翻译成人话。
 *
 * uv 的原话（真实格式，注意版本号外面有反引号）：
 *   error: Distribution `spacy==3.8.4 @ registry+https://pypi.org/simple` can't be
 *   installed because it doesn't have a source distribution or wheel for the current platform
 *   hint: You're using CPython 3.13 (`cp313`), but `spacy` (v3.8.4) only has wheels
 *   with the following Python ABI tags: `cp310`, `cp311`, `cp312`
 *
 * 对使用者有用的只有三件：缺的是哪个包、当前是哪一版、该换成哪一版。
 * 换成哪一版是人的决定，所以文案指向「从头重装本步」+ 改 Python 版本，不自动降级。
 * wheel 是 PyPI 上的预编译安装包，这个术语照用、不译成别的词。
 *
 * 不是这一类就返回 null，调用方照原样给出 uv 的原文。
 */
function explainInstallFailure (text) {
  const s = String(text || '')
  if (!/doesn't have a source distribution or wheel for the current platform/i.test(s)) {
    return null
  }
  const current = (s.match(/You're using CPython (\d+\.\d+)/i) || [])[1] || null
  // 版本号两侧的反引号、空白、逗号都要吃掉：`cp310`, `cp311`, `cp312`
  const abiRaw = (s.match(/ABI tags:\s*([`\s\w,]+)/i) || [])[1] || ''
  const available = abiRaw.split(',')
    .map((x) => x.replace(/[`\s]/g, ''))
    .map((tag) => { const m = /^cp(\d)(\d+)$/.exec(tag); return m ? `${m[1]}.${m[2]}` : null })
    .filter(Boolean)
  const dist = (s.match(/Distribution `([^`]+)`/) || [])[1] || ''
  const pkg = dist.split(/[=@\s]/)[0] || ''

  const cur = current || '当前'
  // 「A、B 或 C」的写法：中文里用顿号分列、最后一个用「或」，读起来不像清单。
  const oneOf = (arr, fmt) => {
    const xs = arr.map((v) => fmt(v))
    if (xs.length <= 1) return xs[0] || ''
    return `${xs.slice(0, -1).join('、')} 或 ${xs[xs.length - 1]}`
  }
  const listZh = available.length ? oneOf(available, (v) => `Python ${v}`) : null
  const listEn = available.length ? oneOf(available, (v) => `Python ${v}`) : null
  const named = pkg || null

  // 有可用版本就点名；解析不出来时不硬凑一句「只提供 的」，改说「不支持这个版本」。
  const errorZh = listZh
    ? `当前用的是 Python ${cur}，但 ${named || '这个依赖'} 还不支持这个版本，它只支持 ${listZh}。`
    : `当前用的是 Python ${cur}，但 ${named || '这个依赖'} 还不支持这个版本。`
  const errorEn = listEn
    ? `This environment uses Python ${cur}, but ${named || 'a dependency'} does not support it yet; it supports ${listEn} only.`
    : `This environment uses Python ${cur}, but ${named || 'a dependency'} does not support it yet.`

  return {
    code: 'NO_WHEEL_FOR_PYTHON',
    python_version: current,
    available,
    error: errorEn,
    errorZh,
    // 不再单独给一句「为什么」：上面那行已经说清缺什么、哪一版、换哪一档，
    //   再来一句只是把同一件事讲两遍。
    hint: listEn
      ? 'Click "Reinstall this step from the start" at the bottom right, clear the current '
        + `environment, then choose ${listEn} and try again.`
      : 'Click "Reinstall this step from the start" at the bottom right, clear the current '
        + 'environment, then choose an older Python version and try again.',
    hintZh: listZh
      ? `请点击右下角「从头重装本步」，清空当前环境后，重新选择 ${listZh} 再试一次。`
      : '请点击右下角「从头重装本步」，清空当前环境后，重新选择一个更低的 Python 版本再试一次。',
  }
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
  let guess = suggestEnvCommand(dir)
  let choices = { supported: false, applied: false, reason: cmd.ok ? 'manifest' : null }
  // 改写之后每个包的最终 spec：界面照这份显示。
  //   界面自己拼会与真正写进清单副本的那份分叉（约束形式可能不同）。
  let specs = null
  // conda 路线（上游给的是 environment.yml，或 manifest 指定 conda 命令）
  //   没有 Python 解释器这一步。
  const cmdIsConda = cmd.ok && Array.isArray(cmd.argv) && cmd.argv[0] === 'conda'
  const guessIsConda = !cmd.ok && Array.isArray(guess.argv) && guess.argv[0] === 'conda'
  // 引擎环境要用的 Python 版本要先算出来：选依赖版本时要按它判断
  //   torch 哪个版本在本机后端上可用（判据要 Python 的 ABI）。
  //   manifest 指定了安装命令时照样要建环境：那只是装依赖的命令，
  //   Python 环境本身仍然是引擎要用的。
  const venv = (cmdIsConda || guessIsConda) ? null : buildVenvStep(root, id, input.pythonVersion)
  if (!cmd.ok && guess.argv) {
    const picked = applyInstallChoices(dir, guess, {
      ...input,
      pythonVersion: venv ? venv.pythonVersion : null,
    })
    if (!picked.guess) return { ...picked, id }
    guess = picked.guess
    choices = picked.choices
    if (picked.specs) specs = picked.specs
  }
  const effArgv = cmd.ok ? cmd.argv : guess.argv
  const condaRoute = Array.isArray(effArgv) && effArgv[0] === 'conda'
  const venvStep = condaRoute ? null : (venv || buildVenvStep(root, id, input.pythonVersion))
  // 建环境那一步拿不到解释器 ⇒ 计划不完整，如实报出来。
  // 不静默产出一个 argv 为 null 的步骤：那会让执行期报 Node 内部错误，
  // 使用者看不出是「这个 Python 版本本机没有」。
  if (venvStep && !venvStep.argv) {
    return { ok: false, code: 'NO_PYTHON_FOR_VERSION', id,
      error: venvStep.why, whatToDo: venvStep.whyZh,
      pythonVersion: venvStep.pythonVersion,
      pythonVersionSource: venvStep.pythonVersionSource }
  }
  const syncRoute = Array.isArray(effArgv) && effArgv[1] === 'sync'
  const sync = (syncRoute && !cmd.ok)
    ? syncEnvFor(engineVenvDirAbs(root, id)) : null
  const targetPython = sync ? null : engineVenvPythonAbs(root, id)

  if (!cmd.ok) {
    if (!guess.argv) {
      return { ok: false, code: cmd.code || 'NO_ENV_COMMAND', id,
        error: cmd.error, cwd: '.',
        whatToDo: guess.why }
    }
    const cwdRel = guess.cwd || '.'
    const NOTE = 'env_command 返回 0 仅表示命令执行完毕，'
      + '不代表该引擎可以运行，仍需后续校验（import 探针或实际合成）。'
    const guessSync = Array.isArray(guess.argv) && guess.argv[1] === 'sync'
    const guessTarget = guessSync ? null : engineVenvPythonAbs(root, id)
    const guessAltTarget = engineVenvPythonAbs(root, id)
    return {
      ok: true, id, from: 'probe', from_file: guess.from,
      guessed: true,
      choices,
      specs,
      env_command: withTargetPython(guess.argv, guessTarget),
      pythonVersion: venv ? venv.pythonVersion : null,
      pythonVersionSource: venv ? venv.pythonVersionSource : null,
      ...pythonMeta(root, id, venv),
      whatToDo: guess.why,
      whatToDoZh: guess.whyZh,
      alternative: guess.alternative || null,
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
        cwdRel: path.join('engines', id, guess.cwd || '.'),
        alt: guess.alternative,
        venv,
        sync: guessSync ? syncEnvFor(engineVenvDirAbs(root, id)) : null,
        targetPython: guessTarget,
        altPython: guessAltTarget,
        specs,
        // 完成判定用的干净包名列表（取包名、不比版本；锁文件路线读同目录 pyproject）。
        //   与 specs 分开：specs 可能带版本串且界面在用，这份只供判据，不进界面。
        specNames: declaredDeps(dir, guess),
      }),
    }
  }

  const deps = detectDependencyManifest(dir)
  const usingManifest = cmd.ok
  const argv = usingManifest ? cmd.argv : guess.argv
  const installSync = (!usingManifest && syncRoute)
    ? syncEnvFor(engineVenvDirAbs(root, id)) : null
  const installTarget = installSync ? null : engineVenvPythonAbs(root, id)
  const installAltTarget = engineVenvPythonAbs(root, id)

  const steps = buildSteps({
    argv: withTargetPython(argv, installTarget),
    cwdRel: path.join('engines', id, (guess && guess.cwd) || '.'),
    alt: (!usingManifest && guess) ? guess.alternative : null,
    venv,
    sync: installSync,
    targetPython: installTarget,
    altPython: installAltTarget,
    specs,
    // 名片写死了安装命令：平台不再按清单推导，判据也不拿上游清单去核对
    //   （这条命令可能有意只装一部分，拿清单核对会把它误判成「没装完」）。
    specNames: null,
  })

  steps.push({
    kind: 'note',
    why: 'env_command 返回 0 仅表示命令执行完毕，'
      + '不代表该引擎可以运行，仍需后续校验'
      + '（import 探针 / 真跑一次合成）。',
  })

  // 名片写死了安装命令时，说明那一栏要说的是「按名片执行，平台不再推导」。
  //   不能沿用自动探测的 why：那条文案描述的是探测分支（例如「跳过 torch、单独装」），
  //   而这里执行的是名片原文，可能恰恰包含 torch。说错了会把人往反方向带。
  const declaredWhy = 'The platform runs the command declared in the manifest (install.env_command): '
    + argv.join(' ') + '. It does not re-derive the install method from the dependency manifest; '
    + 'whether torch is included depends on this command.'
  const declaredWhyZh = '执行的是名片声明的命令（install.env_command）：' + argv.join(' ')
    + '。平台不再依据依赖清单推导安装方式；是否包含 torch 由这条命令本身决定。'

  return {
    ok: true,
    id,
    dir,
    env_command: argv,
    from: usingManifest ? 'manifest' : 'probe',
    from_file: usingManifest ? 'manifest.json (install.env_command)' : guess.from,
    guessed: !usingManifest,
    pythonVersion: venv ? venv.pythonVersion : null,
    pythonVersionSource: venv ? venv.pythonVersionSource : null,
    ...pythonMeta(root, id, venv),
    whatToDo: usingManifest ? declaredWhy : guess.why,
    whatToDoZh: usingManifest ? declaredWhyZh : guess.whyZh,
    choices,
    specs,
    dependencies: deps,
    steps,
    execute: input.execute === true,
  }
}

// 只验 torch 系：这三个的 import 名与包名一一对应。其余包名与 import 名
//   不见得一致（Pillow 是 PIL，piper-phonemize 是 piper_phonemize），
//   拿不准的不许猜，猜错会报出一条假失败。
const TORCH_FAMILY = ['torch', 'torchaudio', 'torchvision']

// 从一条依赖声明里取包名：`setuptools<81` => setuptools。
function specName (spec) {
  return String(spec || '').split(/[<>=!~;\s\[]/)[0].trim().toLowerCase()
}

// 装完自检：这个引擎自己的环境能不能 import 核心依赖。
// 验谁有两个来源，缺一不可：
//   ① 命令行里出现的包名（如 uv sync --no-install-package torch 这类写法）；
//   ② 依赖清单里的声明（opts.specs）。`-r requirements.txt` 路线下包名不在
//      argv 上，只看 ① 会把「已经装了 torch」判成「没有可验证的依赖」，
//      界面于是显示未验证，读的人自然会以为它没装。
function verifyEngineEnvImports (root, id, steps, alt, opts = {}) {
  const builtHere = steps.some(isVenvCreateStep)
  if (!builtHere) {
    return { checked: false, reason: 'this-install-method-manages-its-own-environment',
      mods: [] }
  }
  const skipped = new Set(Array.isArray(opts.excluded) ? opts.excluded : [])
  const mods = new Set()
  for (const s of steps) {
    const line = (s.argv || []).join(' ')
    if (/(^|\s)torch(==|@|\s|$)/.test(line)) mods.add('torch')
  }
  if (alt && Array.isArray(alt.needs)) {
    for (const n of alt.needs) if (typeof n === 'string' && n) mods.add(n)
  }
  const declared = Array.isArray(opts.specs) ? opts.specs : []
  const family = declared.map(specName).filter((n) => TORCH_FAMILY.includes(n))
  for (const n of family) mods.add(n)
  // 被显式跳过的包不验：那不是「没装成」，是这次不装。
  const list = [...mods].filter((n) => !skipped.has(n))
  if (list.length === 0) {
    // 声明过却一个都不剩，说明是被跳过了；这与「上游没说」是两件事，
    //   用同一句话讲，读的人会以为上游没声明 torch。
    return { checked: false,
      reason: family.length > 0 ? 'declared-torch-was-skipped' : 'no-core-dependency-declared',
      mods: [] }
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

// 在该引擎自己的环境里 import 一个模块，返回 { ok, mod, code, detail }。
function probeImportInEngineVenv (root, id, mod, timeoutMs) {
  const py = engineVenvPythonAbs(root, id)
  if (!py) {
    return { ok: false, mod, code: 'NO_ENGINE_PYTHON',
      detail: 'no known virtual environment layout for this platform' }
  }
  if (!canSpawnPython(py, { timeoutMs: Math.min(timeoutMs || 20000, 20000) })) {
    return { ok: false, mod, code: 'ENGINE_VENV_UNUSABLE',
      detail: `cannot launch ${py}` }
  }
  let r
  try {
    r = spawnSync(py, ['-c', `import ${mod}`], {
      encoding: 'utf8', timeout: timeoutMs || 120000,
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvFor(root, undefined),
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

// 装完的 torch 到底是哪一档。自检只证明「能 import」，证明不了「装的是你选的那一档」：
//   CPU 版同样能 import，选了 XPU 却装成 CPU 时，前面每一步都是绿的。
// 判据取 torch 自己报的事实（版本后缀 + 运行时探测），不读目录名，也不看我们的命令。
const TORCH_BACKEND_PROBE = [
  'import json, torch',
  'o = {"version": torch.__version__, "cuda": bool(torch.version.cuda)}',
  'try:',
  '    o["xpu"] = bool(torch.xpu.is_available())',
  'except Exception:',
  '    o["xpu"] = False',
  'print(json.dumps(o))',
].join('\n')

function torchBackendOf (info) {
  const v = String((info && info.version) || '')
  if (v.includes('+xpu') || (info && info.xpu)) return 'ipex'
  if (v.includes('+rocm')) return 'rocm'
  if (v.includes('+cu') || (info && info.cuda)) return 'cuda'
  return 'cpu'
}

// 在该引擎自己的环境里问一次 torch 属于哪个后端。
//   起不来、读不出结论时返回 null：这只是补充判据，不许把已经装好的环境判成坏的。
function probeTorchBackend (root, id, timeoutMs) {
  const py = engineVenvPythonAbs(root, id)
  if (!py) return null
  let r
  try {
    r = spawnSync(py, ['-c', TORCH_BACKEND_PROBE], {
      encoding: 'utf8', timeout: timeoutMs || 120000,
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvFor(root, undefined),
    })
  } catch (e) { return null }
  if (!r || r.error || r.status !== 0) return null
  const lines = String(r.stdout || '').trim().split(/\r?\n/)
  const last = lines[lines.length - 1] || ''
  let info = null
  try { info = JSON.parse(last) } catch (e) { return null }
  if (!info || !info.version) return null
  return { ...info, backend: torchBackendOf(info) }
}

// 后端键的显示名：界面与结论里都按这个说法。
const BACKEND_LABEL = { cpu: 'CPU', cuda: 'CUDA', ipex: 'XPU', rocm: 'ROCm', zluda: 'ZLUDA', directml: 'DirectML' }

function backendLabel (key) {
  return BACKEND_LABEL[key] || key
}

// 只有「选了后端」才比对：没选时推荐值只是建议，装成 CPU 不算做错。
function probeBackendAfterInstall (root, id, plan, v, probe) {
  const expected = (plan.choices && plan.choices.backend) || null
  if (!v || !v.checked) return null
  if (!Array.isArray(v.mods) || !v.mods.includes('torch')) return null
  if (Array.isArray(v.missing) && v.missing.length > 0) return null
  const info = (typeof probe === 'function' ? probe : probeTorchBackend)(root, id)
  if (!info) return null
  return {
    expected,
    actual: info.backend,
    version: info.version,
    ok: expected ? info.backend === expected : true,
  }
}

function backendNoteEn (b) {
  if (!b) return ''
  const got = backendLabel(b.actual)
  if (b.ok) return `The torch build is ${got} (${b.version}). `
  return `You chose ${backendLabel(b.expected)}, but the torch build is ${got} (${b.version}). `
}

function backendNoteZh (b) {
  if (!b) return ''
  const got = backendLabel(b.actual)
  if (b.ok) return `torch 是 ${got} 版（${b.version}）。`
  return `但选的是 ${backendLabel(b.expected)}，实际装到的是 ${got} 版（${b.version}）。`
}

// 解析 uv/pip 的下载进度行，返回 { file, size, status } 数组。
function parseProgress (text) {
  if (!text || typeof text !== 'string') return []
  const results = []
  for (const l of text.split('\n')) {
    const trimmed = l.trim()
    let m = trimmed.match(/^Downloading\s+(\S+)\s+\(([^)]+)\)/)
    if (m) {
      results.push({ file: m[1], size: m[2], status: 'downloading' })
      continue
    }
    m = trimmed.match(/^Downloaded\s+(\S+)/)
    if (m) {
      results.push({ file: m[1], size: null, status: 'downloaded' })
    }
  }
  return results
}

// 子进程环境：继承宿主，但剥掉两样会污染 Python 子进程的变量。
//   ① PYTHONPATH：WorkBuddy 沙箱把 sitecustomize.py 塞在这里（它劫持
//     shutil.rmtree、把删除改走回收站 SHFileOperationW）。uv 的构建隔离子进程
//     会加载它，setuptools 构建 wheel 时清理临时目录就 SHFileOperationW 失败
//     (0x2) ⇒ 构建失败。剥掉它，构建子进程才恢复正常的 rmtree。
//   ② VIRTUAL_ENV：指向平台根 venv，会与引擎自己的 .venv 冲突，uv 会报
//     "does not match the project environment path" 的警告。
//   sync 步骤用的 UV_PROJECT_ENVIRONMENT 是独立键，不在这里，不受影响。
function childEnvFor (root, envOverride) {
  // UV_CACHE_DIR 先落默认值，再让 envOverride 覆盖：缓存写入冲突的重试要换目录。
  const env = { ...process.env, UV_CACHE_DIR: uvCacheDirFor(root), ...envOverride }
  delete env.PYTHONPATH
  delete env.VIRTUAL_ENV
  return env
}

// 执行前清掉 uv 构建缓存里被中断构建留下的 .tmp* 目录。
//   被中断的 uv sdist 构建会留下 builds-v0/.tmp* 的半成品；下次重跑 uv 复用
//   这些残留时，setuptools 重写 egg-info 会撞上目录里已有的半成品，报
//   [WinError 5] 拒绝访问。清掉 .tmp* 后 uv 从头构建。
//   这一道只处理「构建目录被复用」，不处理 wheel 缓存指针的覆盖冲突：后者由
//   isUvCacheBusy 识别并重试，目标指针本身有效，不需要删。
//   只删被中断的临时目录，正常完成的构建缓存（wheel/sdist）不动。
function cleanStaleUvBuilds (root) {
  const uvCache = uvCacheDirFor(root)
  const buildsDir = path.join(uvCache, 'builds-v0')
  let entries
  try { entries = fs.readdirSync(buildsDir) } catch (e) { return }
  for (const name of entries) {
    if (!name.startsWith('.tmp')) continue
    const p = path.join(buildsDir, name)
    try { fs.rmSync(p, { recursive: true, force: true }) } catch (e) { /* 删不掉 ⇒ uv 会如实报 */ }
  }
}

// 跑一步（异步流式）。取消通道 cancel 带 signal 与 spawn 时按它取消，否则用默认实现。
function runOne (step, root, timeoutMs, argvOverride, onLine, envOverride, cancel) {
  return new Promise((resolve) => {
    const argv = Array.isArray(argvOverride) && argvOverride.length > 0 ? argvOverride : step.argv
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
      shell: false,
      env: childEnvFor(root, envOverride),
    })
    let stdoutTail = ''
    let stderrTail = ''
    let killedByTimeout = false
    let cancelled = false
    let resolved = false
    let safetyNetId = null
    const safeResolve = (r) => {
      if (resolved) return
      resolved = true
      if (safetyNetId) { clearTimeout(safetyNetId); safetyNetId = null }
      if (signal) { try { signal.removeEventListener('abort', onAbort) } catch (e) { /* 监听器已经移除 */ } }
      resolve(r)
    }
    const doCancel = () => {
      if (cancelled) return
      cancelled = true
      try { killFn(child) } catch (e) { /* 进程已经退出 */ }
      if (safetyNetId) clearTimeout(safetyNetId)
      safetyNetId = setTimeout(() => {
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
        try { onLine(text, isErr) } catch (e) { /* 回调抛错不打断安装 */ }
      }
      const progress = parseProgress(text)
      for (const p of progress) {
        if (typeof send === 'function') {
          try { send('progress', p) } catch (e) { /* 回调抛错不打断安装 */ }
        }
      }
    }
    child.stdout.on('data', (d) => onChunk(d, false))
    child.stderr.on('data', (d) => onChunk(d, true))
    child.on('error', (err) => {
      safeResolve({ ok: false, code: 'SPAWN_FAILED', status: null,
        stdout: stdoutTail, stderr: stderrTail, error: err.message })
    })
    child.on('close', (code) => {
      if (cancelled) {
        safeResolve({ ok: false, code: 'INSTALL_CANCELLED', status: code,
          stdout: stdoutTail, stderr: stderrTail,
          error: 'Install cancelled by user. The process tree was killed.\n'
            + 'The engine environment under engines/<id>/.venv is partial; '
            + 're-running this step rebuilds it.',
          errorZh: '安装已取消，进程树已终止。\n'
            + 'engines/<id>/.venv 下的环境是不完整的；重新执行本步骤会先重建它。',
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
            + '下载可能仍在继续，重新执行本步骤会从断点续传，不会重下已完成的部分。' })
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
    if (signal) {
      if (signal.aborted) { doCancel() }
      else { try { signal.addEventListener('abort', onAbort, { once: true }) } catch (e) { /* 监听器已经移除 */ } }
    }
    if (timeoutMs > 0) {
      setTimeout(() => {
        killedByTimeout = true
        try { child.kill('SIGKILL') } catch (e) { /* 进程已经退出 */ }
      }, timeoutMs).unref()
    }
  })
}

/**
 * 按计划逐条执行安装步骤，装完再做一次 import 自检。
 *
 * @param {object} input {id, manifest, execute, root, timeoutMs, onStep}
 * @param {(i:number,total:number,step:object,argv:string[])=>void} [input.onStep]
 * @param {(line:string, isErr:boolean)=>void} [input.onLine]
 * @returns {Promise<object>}
 */
async function runEnv (input = {}) {
  const plan = buildEnvPlan(input)
  if (!plan.ok) return plan
  if (input.execute !== true) return { ...plan, stepsRun: [], failedAt: null }

  const root = input.root || projectRoot()
  const timeoutMs = input.timeoutMs || 60 * 60 * 1000
  // 执行前清掉被中断构建留下的 .tmp* 构建目录（见 cleanStaleUvBuilds 注释）。
  //   只在真正执行时清：只出计划（execute:false）时不碰缓存。
  cleanStaleUvBuilds(root)
  const steps = (plan.steps || []).filter((s) => s && s.kind === 'env' && s.argv)
  const stepsRun = []
  const probe = typeof input.probeImport === 'function' ? input.probeImport : null
  const runStep = typeof input.runStep === 'function' ? input.runStep : runOne

  const signal = (input.signal && typeof input.signal.addEventListener === 'function')
    ? input.signal : null

  const { readProgress: readEnvProgress, writeProgress: writeEnvProgress,
    resetProgress: resetEnvProgress } = require('./installState')
  const resetProgress = input.resetProgress === true
  if (resetProgress) {
    resetEnvProgress(root, String(input.id || ''), 'env')
    // 从头重装不再沿用上一次的任何结论：失败标记一并清掉，
    //   否则下面那个分支还会按「上次失败」再删一次环境。
    markPartialVenv(root, String(input.id || ''), null)
  }
  // 必须在清空之后再读：这份集合就是「哪几步可以跳过」的判据，
  //   沿用清空之前读到的那一份，等于没清。
  let doneKeys = readEnvProgress(root, String(input.id || ''), 'env')

  if (!resetProgress && hasPartialVenvMark(root, String(input.id || ''))) {
    const venvDir = engineVenvDirAbs(root, String(input.id || ''))
    try { fs.rmSync(venvDir, { recursive: true, force: true }) } catch (e) { /* 删不掉 ⇒ 由后续命令如实报错 */ }
    markPartialVenv(root, String(input.id || ''), null)
    doneKeys = readEnvProgress(root, String(input.id || ''), 'env')
  }

  const persist = () => {
    if (resetProgress) return
    writeEnvProgress(root, String(input.id || ''), 'env',
      stepsRun.filter((s) => s.ok === true).map((s) => s.argvKey))
  }
  const markBroken = (why) => {
    const id = String(input.id || '')
    try {
      const built = fs.existsSync(engineVenvDirAbs(root, id))
      if (built) markPartialVenv(root, id, why)
    } catch (e) { /* 标记失败不掩盖真正的错误 */ }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    step.absCwd = path.join(root, step.cwd || '.')
    const argv = step.argv.slice()
    if (/^uv$/i.test(argv[0])) {
      const uv = resolveUv(projectRoot()) || resolveUv(root)
      if (uv && uv.ok) {
        argv.splice(0, 1, ...uv.argv)
      } else {
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

    let argvKey = argv.join(' ')
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
    }

    if (typeof input.onStep === 'function') {
      try { input.onStep(i, steps.length, step, argv) } catch (e) { /* 回调抛错不打断安装 */ }
    }

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
          + 'engines/<id>/.venv 下的环境是不完整的；重新执行本步骤会先重建它。',
        note: 'Steps that already succeeded are still recorded — '
          + 're-running skips them and continues from where it stopped.',
        noteZh: '已成功的步骤仍在断点记录里，重跑会跳过它们、从未完成处继续。',
      }
    }

    let currentArgv = argv.slice()
    let r = await runStep(step, root, timeoutMs, currentArgv, input.onLine, step.env,
      { signal })
    // 一次安装可能遇到两类问题：多索引解析与源码包构建。
    //   每类按 uv 的提示各重试一次，后一次基于前一次实际执行的命令。
    let constraintFile = null
    const strategies = [
      { re: UV_INDEX_HINT_RE,
        notice: '多索引解析未通过，按 uv 的提示改用 unsafe-best-match 重试。',
        make: (a) => withIndexStrategy(a) },
      { re: UV_BUILD_DEP_HINT_RE,
        notice: '源码包缺构建期依赖，按 uv 的提示约束 setuptools 版本后重试。',
        make: (a) => {
          if (a.includes('--build-constraints')) return null
          if (!constraintFile) constraintFile = buildConstraintFile(root, input.id)
          return constraintFile ? afterPipInstall(a, ['--build-constraints', constraintFile]) : null
        } },
      // 上游的 pyproject.toml 只是一份工具配置（没有项目表、没有构建后端），
      //   装它等于把 lint 配置当成包。改走同目录的 requirements.txt，
      //   依赖版本交给 uv 解析，平台不猜版本、也不改上游声明。
      { re: UV_NOT_INSTALLABLE_RE,
        notice: '上游的 pyproject.toml 不构成可安装的项目，改用同目录的 requirements.txt 装依赖。',
        make: (a) => switchToRequirements(a, step, root, input.id) },
    ]
    for (const st of strategies) {
      if (r.ok || !st.re.test(`${r.stderr || ''}\n${r.stdout || ''}`)) continue
      const retryArgv = st.make(currentArgv)
      if (!retryArgv) continue
      if (typeof input.onLine === 'function') {
        try { input.onLine(st.notice, false) } catch (e) { /* 回调抛错不打断安装 */ }
      }
      const retry = await runStep(step, root, timeoutMs, retryArgv, input.onLine,
        step.env, { signal })
      // 以最后一次尝试为准：沿用更早的错误会把真正卡住的那一步藏起来。
      r = retry
      r.retriedWith = retryArgv.join(' ')
      currentArgv = retryArgv
      if (r.ok) {
        argv.splice(0, argv.length, ...retryArgv)
        argvKey = retryArgv.join(' ')
        break
      }
    }
    // 缓存写入冲突分两类，救法不同：
    //   一、wheel 缓存的指针文件覆盖失败（wheels-v<n>）：换一个独立缓存目录即可绕开；
    //   二、源码包构建时的拒绝访问（builds-v<n>）：源码包在缓存目录里解包后就地构建，
    //       产物目录也在缓存里，换缓存目录只是换个位置再失败一次，必须让这次构建不进缓存。
    //   第二类与批次规模相关：11 个源码包一起构建时 4 次全部失败，关掉缓存后 3 次
    //   全部通过；单个源码包 20 次不失败。失败落在哪个包上每次不同，与包本身无关。
    //   三档都不改上游声明，也不改系统设置；argv 保持不变。
    if (!r.ok && isUvCacheBusy(r)) {
      const attempts = [
        { env: step.env, notice: 'Uv 缓存写入被占用，原样重试一次。' },
        { env: { ...(step.env || {}), UV_CACHE_DIR: uvRetryCacheDir(root) },
          notice: 'Uv 缓存仍被占用，换独立缓存目录重试。' },
        { env: { ...(step.env || {}), UV_NO_CACHE: '1' },
          notice: '源码包构建目录仍被占用，改为不使用缓存重试（会重新下载，较慢）。' },
      ]
      for (const attempt of attempts) {
        if (r.ok) break
        if (typeof input.onLine === 'function') {
          try { input.onLine(attempt.notice, false) } catch (e) { /* 回调抛错不打断安装 */ }
        }
        // 上一次失败的构建会留下 builds-v0/.tmp*，uv 复用它会再撞一次同样的拒绝访问。
        cleanStaleUvBuilds(root)
        r = await runStep(step, root, timeoutMs, currentArgv, input.onLine,
          attempt.env, { signal })
        r.retriedWith = currentArgv.join(' ')
      }
    }
    if (constraintFile) {
      try { fs.rmSync(constraintFile, { force: true }) } catch (e) { /* 临时约束文件删不掉不影响安装 */ }
    }
    stepsRun.push({
      n: i + 1,
      of: steps.length,
      argv,
      argvKey,
      ok: r.ok,
      status: r.status,
      code: r.code,
      output: r.ok ? r.stdout.slice(-2000) : (r.stderr || r.stdout || '(no output)'),
      doneAt: r.ok ? new Date().toISOString() : null,
    })
    persist()

    if (!r.ok) {
      // 「这个包没有当前 Python 版本的 wheel」是最常见的一类：uv 的原话有两段，
      //   而使用者只需要知道「缺哪个包、现在哪一版、该换成哪一版」。
      //   换成哪一版是人的决定，这里只翻译，不自动降级。
      const rawOut = String(r.stderr || r.stdout || '')
      const explained = (r.code === 'INSTALL_CANCELLED' || r.code === 'INSTALL_CANCEL_FAILED')
        ? null : explainInstallFailure(rawOut)
      if (r.code === 'INSTALL_CANCELLED' || r.code === 'INSTALL_CANCEL_FAILED') {
        markBroken('install cancelled by user')
      } else if (r.code === 'ENV_TIMEOUT') {
        markBroken('command timed out and was killed')
      } else {
        markBroken('command failed')
      }
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
        error: explained
          ? explained.error
          : (isCancelled
            ? 'Install cancelled by user. The process tree was killed.\n'
            + 'The engine environment under engines/<id>/.venv is partial; '
            + 're-running this step rebuilds it.'
          : (r.code === 'SPAWN_FAILED'
            ? `Cannot launch ${step.argv[0]}: ${r.error}\n`
              + 'The platform cannot confirm whether the install succeeded — check the engines/<id>/ directory.'
            : (r.stderr || r.stdout || '(no output)'))),
        errorZh: explained
          ? explained.errorZh
          : (isCancelled
            ? '安装已取消，进程树已终止。\n'
            + 'engines/<id>/.venv 下的环境是不完整的；重新执行本步骤会先重建它。'
          : (r.code === 'SPAWN_FAILED'
            ? `起不动「${step.argv[0]}」：${r.error}\n`
              + '平台无法确认是否安装成功，请检查 engines/<id>/ 目录。'
            : (r.stderr || r.stdout || '（没有输出）'))),
        detail: explained ? rawOut : undefined,
        cause: explained ? explained.cause : undefined,
        causeZh: explained ? explained.causeZh : undefined,
        hint: explained ? explained.hint : undefined,
        hintZh: explained ? explained.hintZh : undefined,
        python_version: explained ? explained.python_version : (plan.python_version || null),
        python_version_options: mergeVersionOptions(
          plan.python_version_options, explained ? explained.available : null),
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
            + '引擎环境停在不完整状态。重新执行本步骤会先删掉 .venv 再重建，'
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

  const v = verifyEngineEnvImports(root, String(input.id || ''),
    steps, plan.alternative, { probe: probe || undefined,
      specs: plan.specs,
      excluded: (plan.choices && plan.choices.excluded) || [] })
  if (v.checked && v.missing.length > 0) {
    return {
      ...plan,
      ok: false,
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
        + '这些包装到了别处，通常是装进了平台自己的虚拟环境。\n'
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

  markPartialVenv(root, String(input.id || ''), null)

  // 没有可验证对象的那两支：命令都过了，但平台什么都没证明。
  //   不判失败（安装方式可能是它自己管环境，这不算错），但必须如实说清
  //   「这一步只证明命令已结束」，并指出真正的判据在第 5 步。
  //   编译型引擎（自己带 CMake / C 扩展）正好落在这里：本机没有工具链时
  //   退出码照样是 0，平台也无从替人装上编译器。
  const why = v.checked ? null : (v.reason === 'this-install-method-manages-its-own-environment'
    ? {
        note: 'This install method manages its own environment, so the platform has nothing it '
          + 'can import inside this engine\'s own .venv to confirm the result.',
        noteZh: '这个安装方式自己管环境，平台在该引擎自己的 .venv 里没有可 import 的对象来确认结果。',
      }
    : v.reason === 'declared-torch-was-skipped'
      ? {
          note: 'The upstream declares torch, but this install skipped it, so the platform has '
            + 'nothing to import and confirm here. Installing it yourself is allowed; the '
            + 'verdict still comes in step 5.',
          noteZh: '上游声明了 torch，但这次安装把它跳过了，平台没有可 import 的对象来确认结果。'
            + '自己装也可以，能否出声的判据仍在第 5 步。',
        }
      : {
        note: 'This install has no core dependency the platform can check: the command runs the '
          + 'engine\'s own build, and an exit code of 0 says nothing about whether it built. '
          + 'If the upstream publishes a prebuilt package for this platform, the install command '
          + 'in the manifest can point at that package instead.',
        noteZh: '这次安装没有平台可验证的核心依赖：命令包含该引擎自己的构建步骤，'
          + '而退出码 0 不代表它真的构建出来了。'
          + '上游若发布了本平台的预编译包，可以把名片的安装命令改成直接用那个包。',
      })

  const backendCheck = probeBackendAfterInstall(root, String(input.id || ''), plan, v,
    typeof input.probeBackend === 'function' ? input.probeBackend : null)

  return {
    ...plan,
    ok: true,
    envStatus: 0,
    stepsRun,
    failedAt: null,
    envCheck: v,
    // 装完的 torch 属于哪一档，与选的是否一致。没选后端时为 null。
    backendCheck,
    // 与 envUnverified 分开：这一步验过了，只是结果不是所选的那一档。
    backendMismatch: Boolean(backendCheck && !backendCheck.ok),
    // 给界面一个机器可读的标记：这一步「已结束但没验过」，结论条要按警告上色。
    envUnverified: !v.checked,
    envUnverifiedReason: v.checked ? null : v.reason,
    note: v.checked
      ? `Completed ${steps.length} step(s). Every command exited 0, and `
        + `${v.mods.join(', ')} imports in this engine's own environment. `
        + backendNoteEn(backendCheck)
        + 'Whether the engine can actually start still needs the checks that come next.'
      : `Completed ${steps.length} step(s), but this step is not verified. ${why.note} `
        + 'The verdict comes in step 5: whether it can synthesize audio.',
    noteZh: v.checked
      ? `已完成 ${steps.length} 个步骤。所有命令退出码均为 0，`
        + `且 ${v.mods.join('、')} 在该引擎自己的环境里可以 import。`
        + backendNoteZh(backendCheck)
        + '该引擎能否真正启动仍需后续校验。'
      : `已完成 ${steps.length} 个步骤，但这一步没有验证过。${why.noteZh}`
        + '真正的判据在第 5 步：能不能合成出音频。',
  }
}

module.exports = {
  buildSteps,
  uvRelPath,
  resolveUv,
  buildEnvPlan,
  explainInstallFailure,
  mergeVersionOptions,
  verifyEngineEnvImports,
  probeImportInEngineVenv,
  probeTorchBackend,
  torchBackendOf,
  parseProgress,
  childEnvFor,
  cleanStaleUvBuilds,
  isUvCacheBusy,
  uvRetryCacheDir,
  runOne,
  runEnv,
}
