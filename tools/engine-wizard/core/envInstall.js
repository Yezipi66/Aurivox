'use strict'

// 引擎依赖环境的安装：组装执行计划、逐条执行、装完自检。
// 装法由名片的 install.env_command 决定；名片的 uv 命令需要替换时，uv 的位置由 resolveUv 解析。
// 进度与断点续传由 envProgress.js 负责，本文件只管「执行哪条命令、执行结果是什么」。

const fs = require('node:fs')
const { applyInstallChoices } = require('./installChoices')
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

function afterPipInstall (argv, words) {
  const at = argv.findIndex((w, i) => i > 0 && w === 'install' && argv[i - 1] === 'pip')
  if (at < 0) return null
  const out = argv.slice()
  out.splice(at + 1, 0, ...words)
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
function buildSteps ({ argv, cwdRel, alt, venv, sync, targetPython, altPython }) {
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
    argv,
    cwd: cwdRel,
    needs_network: true,
    env: sync || undefined,
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
  const venv = (cmdIsConda || guessIsConda) ? null : buildVenvStep(root, id)
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
  const venvStep = condaRoute ? null : (venv || buildVenvStep(root, id))
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
    whatToDo: usingManifest ? declaredWhy : guess.why,
    whatToDoZh: usingManifest ? declaredWhyZh : guess.whyZh,
    choices,
    specs,
    dependencies: deps,
    steps,
    execute: input.execute === true,
  }
}

// 装完自检：这个引擎自己的环境能不能 import 核心依赖。
function verifyEngineEnvImports (root, id, steps, alt, opts = {}) {
  const builtHere = steps.some(isVenvCreateStep)
  if (!builtHere) {
    return { checked: false, reason: 'this-install-method-manages-its-own-environment',
      mods: [] }
  }
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
  let doneKeys = readEnvProgress(root, String(input.id || ''), 'env')
  const resetProgress = input.resetProgress === true
  if (resetProgress) resetEnvProgress(root, String(input.id || ''), 'env')

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
    // 缓存写入冲突：先原样重跑（占用通常很短），仍失败再换独立缓存目录。
    //   两条路径都不改上游声明，也不改系统设置；argv 保持不变。
    if (!r.ok && isUvCacheBusy(r)) {
      const attempts = [
        { env: step.env, notice: 'Uv 缓存写入被占用，原样重试一次。' },
        { env: { ...(step.env || {}), UV_CACHE_DIR: uvRetryCacheDir(root) },
          notice: 'Uv 缓存仍被占用，换独立缓存目录重试。' },
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
            + 'engines/<id>/.venv 下的环境是不完整的；重新执行本步骤会先重建它。'
          : (r.code === 'SPAWN_FAILED'
            ? `起不动「${step.argv[0]}」：${r.error}\n`
              + '平台无法确认是否安装成功，请检查 engines/<id>/ 目录。'
            : (r.stderr || r.stdout || '（没有输出）')),
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
    steps, plan.alternative, { probe: probe || undefined })
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

  return {
    ...plan,
    ok: true,
    envStatus: 0,
    stepsRun,
    failedAt: null,
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

module.exports = {
  buildSteps,
  uvRelPath,
  resolveUv,
  buildEnvPlan,
  verifyEngineEnvImports,
  probeImportInEngineVenv,
  parseProgress,
  childEnvFor,
  cleanStaleUvBuilds,
  isUvCacheBusy,
  uvRetryCacheDir,
  runOne,
  runEnv,
}
