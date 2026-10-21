'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

/** 定位项目根：用 server.js 作锚点（ROOT_LAYOUT.md 说它是定位锚点 C7） */
function projectRoot (from) {
  let dir = from || __dirname
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'server.js'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

function engineDir (id, root) {
  return path.join(root, 'engines', id)
}

/**
 * 跑一条 git 命令，读它的标准输出。
 * git 坏了、目录不是仓库、命令不存在，都归到「读不到」这一类，不当成错误抛出去。
 */
function gitOut (args, cwd) {
  try {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (r.status !== 0) return null
    const out = (r.stdout || '').trim()
    return out || null
  } catch (e) {
    return null
  }
}

/**
 * 两个路径是不是同一个目录。
 *
 * 为什么不能直接比字符串：
 *   Windows 上同一个目录可以有多种写法 ——
 *   短路径（C:\Users\RUNNER~1\AppData\Local\Temp）
 *   与长路径（C:\Users\runneradmin\AppData\Local\Temp）指的是同一个地方，
 *   而 git rev-parse --show-toplevel 返回的是长路径、Node 的 tmpdir() 给的是短路径。
 *   直接比字符串 ⇒ 判定为「不是同一个目录」⇒ 误判成「这个目录不是 git 仓库」。
 *   （CI 的 Windows runner 上 os.tmpdir() 就是短路径，所以这条在那里必现。）
 *
 * 做法：先 fs.realpathSync 把两边都展开成同一个形式再比。
 *   拿不到（路径不存在）时退回「按字符串比」——
 *   那时两边本来就该是同一个字符串。
 */
function samePath (a, b) {
  if (!a || !b) return false
  const norm = (p) => {
    try { return fs.realpathSync.native(p).replace(/[\\/]+$/, '').toLowerCase() } catch (e) { /* 拿不到就用原样 */ }
    return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  }
  return norm(a) === norm(b)
}

/**
 * 读一个目录的 git 身份：它自己是不是仓库根、来自哪个上游、停在哪个提交。
 *
 * 为什么要先确认「它自己是不是仓库根」：
 *   git 会向上找 .git。engines/ 下的一个普通目录（不是仓库）向上找，
 *   会找到 Aurivox 自己的 .git，于是 remote.origin.url 读出来是
 *   Aurivox 的地址，而不是那个目录的来历。show-toplevel 认得出这个差别。
 *
 * HEAD 与分支是尽力而为：仓库损坏时（packed-refs 坏了、对象签名不对）
 *   这两条读不到，如实给 null，不影响 origin 的判定。
 *
 * @returns {{isRepo:boolean, origin:string|null, head:string|null, branch:string|null, repoRoot:string|null}}
 */
function readGitIdentity (dir) {
  const none = { isRepo: false, origin: null, head: null, branch: null, repoRoot: null }
  if (!dir || !fs.existsSync(dir)) return none

  const top = gitOut(['rev-parse', '--show-toplevel'], dir)
  if (!top) return none
  if (!samePath(top, dir)) return none

  const origin = gitOut(['config', '--get', 'remote.origin.url'], dir)
  const head = gitOut(['rev-parse', '--short', 'HEAD'], dir)
  let branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], dir)
  if (branch === 'HEAD') branch = null

  return { isRepo: true, origin, head, branch, repoRoot: top }
}

/**
 * 把仓库地址归一化成 host/owner/repo，好让不同写法能对上。
 *
 * 要对上的写法：https 与 http、.git 后缀、git@ 与 ssh://、大小写。
 * 路径大小写按不敏感处理：GitHub 的 owner/repo 本来就不区分大小写。
 */
function normalizeRepoUrl (url) {
  if (!url) return null
  let s = String(url).trim()
  if (!s) return null
  s = s.replace(/^git\+/i, '')
  const m = s.match(/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[\/:](.+)$/i)
  if (!m) return null
  const host = m[1].toLowerCase()
  const p = m[2]
    .replace(/\.git$/i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  if (!host || !p) return null
  return host + '/' + p.toLowerCase()
}

/**
 * 判断目标目录跟上游是不是同一个仓库。
 *
 * 结论只有三档：
 *   same       同一个上游：本地就是这个仓库克隆出来的。
 *   different  另一个上游：本地来自别的仓库。
 *   unknown    说不出来：目录不是 git 仓库，或仓库里没有 origin。
 *
 * @returns {{match:'same'|'different'|'unknown', local:string|null, upstream:string|null, reason:string}}
 */
function compareUpstream (dir, cloneUrl) {
  const upstream = normalizeRepoUrl(cloneUrl)
  const id = readGitIdentity(dir)

  if (!id.isRepo) {
    return {
      match: 'unknown', local: null, upstream,
      reason: 'The directory is not a git repository, so the platform cannot tell '
      + 'where it came from.',
      reasonZh: '该目录不是 git 仓库，平台无从判断它的来源。',
    }
  }
  if (!id.origin) {
    return {
      match: 'unknown', local: null, upstream,
      reason: 'The repository has no origin remote, so the platform cannot tell '
      + 'where it came from.',
      reasonZh: '该仓库没有 origin 远端，平台无从判断它的来源。',
    }
  }
  const local = normalizeRepoUrl(id.origin)
  if (!local) {
    return {
      match: 'unknown', local: id.origin, upstream,
      reason: `The origin remote (${id.origin}) is not a URL the platform can compare.`,
      reasonZh: `origin 远端（${id.origin}）不是平台能比对的地址。`,
    }
  }
  if (!upstream) {
    return {
      match: 'unknown', local, upstream: null,
      reason: 'No upstream URL was given, so the directory cannot be compared.',
      reasonZh: '没有给上游地址，无从比对。',
    }
  }
  return {
    match: local === upstream ? 'same' : 'different',
    local,
    upstream,
    reason: local === upstream
      ? 'The directory was cloned from the same upstream.'
      : 'The directory came from a different upstream.',
    reasonZh: local === upstream
      ? '该目录来自同一个上游。'
      : '该目录来自另一个上游。',
  }
}

/**
 * 动手之前先看目标目录。
 *
 * 判据来自 git 自己的行为（clone 拒绝非空目录），但提前查而不是等它报：
 *   等它报的时候，用户可能已经等了很久。
 *
 * @returns {{ok:true, dir:string, exists:boolean, entries:string[]}
 *          | {ok:false, code, error, entries?}}
 */
function inspectTarget (id, opts = {}) {
  const root = opts.root || projectRoot()
  if (!root) {
    return { ok: false, code: 'NO_ROOT',
      error: 'Project root not found (no server.js above). The wizard must run inside the project directory.', errorZh: '找不到项目根（向上没有 server.js）。向导需要在项目目录内运行。' }
  }
  const dir = engineDir(id, root)

  if (!fs.existsSync(dir)) {
    return { ok: true, dir, exists: false, entries: [] }
  }
  const entries = fs.readdirSync(dir)
  // 空目录 git 能直接往里放，等于没问题；目录不存在也一样，git 会自己建
  return { ok: true, dir, exists: true, entries }
}

/**
 * 决定能不能克隆：理由必须是用户看得懂的话，不是 git 的原话。
 *
 * 目录非空时不是一律拦下，而是分情况说清楚：
 *
 *   same       目录来自同一个上游 ⇒ 复用它，不重新克隆。
 *              上游可能有新版本，但本地那份是使用者已经装好环境的资产，
 *              重新拉一遍会毁掉它，所以复用是默认行为。
 *   different  目录来自另一个上游 ⇒ 复用它，但要说明「这不是你要的那个上游」。
 *              仍然不拦：使用者可能故意把一个仓库放到另一个名字下。
 *   unknown    说不出来（不是 git 仓库、仓库坏了、没有 origin）⇒ 复用它，
 *   说明平台无从判断来源。
 *
 * 三种都复用，因为「重新克隆」要删掉使用者已经攒下的东西
 *   （装好的环境、下载好的权重、装好的名片）。
 *   平台没有断点续传，重新拉一遍等于从头再来。
 *
 * @returns {{ok:true, dir, state:'empty'|'reused', upstream?, git?}}
 *          | {ok:false, code, error, entries?}}
 */
function checkClonable (id, opts = {}) {
  // id 的校验在 buildClonePlan 里已做，但本函数可被单独调用，故此处同样兜底：
  //   空/非字符串/纯空格一律拒绝。
  if (typeof id !== 'string' || !id.trim()) {
    return { ok: false, code: 'MISSING_ID',
      error: 'No directory name given.\n',
      errorZh: '还没有填目录名。请先填写目录名，它会成为 engines/ 下的文件夹名。' }
  }
  const info = inspectTarget(id, opts)
  if (!info.ok) return info
  if (info.entries.length === 0) {
    return { ok: true, dir: info.dir, state: 'empty' }
  }

  // 非空：复用，不重克隆。查一下它来自哪个上游，好让使用者知道手上这份是什么。
  const upstream = compareUpstream(info.dir, opts.cloneUrl)
  const git = readGitIdentity(info.dir)
  return {
    ok: true,
    dir: info.dir,
    state: 'reused',
    entries: info.entries,
    upstream,
    git,
  }
}

/**
 * 真正的克隆。默认只打印计划，不动盘。
 *
 * 理由跟 tools/install-engine.cjs 一样（它是项目已有的先例）：
 *   克隆要联网、要写盘；「敲错一个字就开始下载」不是一个好的默认值。
 */
function buildClonePlan (input = {}) {
  const id = input.id
  if (typeof id !== 'string' || !id.trim()) {
    return { ok: false, code: 'MISSING_ID',
      error: 'No directory name given.\n',
      errorZh: '还没有填目录名。\n'
        + '请先填写目录名：它会成为 engines/ 下的文件夹名，并作为 id 写入名片。\n'
        + '粘贴链接并解析成功后，目录名会自动填好。' }
  }
  if (!input.cloneUrl || !String(input.cloneUrl).trim()) {
    return { ok: false, code: 'NO_CLONE_URL',
      error: 'No clone URL given.\n',
      errorZh: '没有 clone 地址。\n'
        + '请先执行「解析链接」，该步骤会从 GitHub 地址中取得 cloneUrl。' }
  }
  const clonable = checkClonable(id, input)
  if (!clonable.ok) {
    return { ok: false, code: clonable.code, error: clonable.error,
      entries: clonable.entries }
  }

  const depth = input.depth === 1 ? ['--depth', '1'] : []

  // 目录里已经有东西 ⇒ 复用，不重新克隆。
  //   重新克隆要删掉使用者已经装好的环境、下载好的权重、装好的名片，
  //   而平台没有断点续传，重新拉一遍等于从头再来。
  //   所以这一步在复用时不做任何写盘动作，只把现状说清楚。
  if (clonable.state === 'reused') {
    return {
      ok: true,
      id,
      dir: clonable.dir,
      cloneUrl: input.cloneUrl,
      state: 'reused',
      upstream: clonable.upstream,
      git: clonable.git,
      entries: clonable.entries,
      steps: [
        {
          kind: 'reuse',
          why: `engines/${id}/ already has content, so it is reused as it is. `
            + 'Nothing is downloaded and nothing is deleted.',
          whyZh: `engines/${id}/ 里已经有内容，直接复用。`
            + '既不下载也不删除任何东西。',
        },
      ],
      execute: input.execute === true,
    }
  }

  const steps = [
    {
      kind: 'clone',
      argv: ['git', 'clone', ...depth, input.cloneUrl, `engines/${id}`],
      cwd: '.',
      needs_network: true,
      why: `Pull the upstream into engines/${id}/` + (depth.length
          ? ' (shallow clone, latest only \u2014 history cannot be checked out later)'
          : ' (full clone. A shallow clone would prevent checking out a specific version later)')
        + ', default branch',
      whyZh: `把上游拉进 engines/${id}/`
        + (depth.length ? '（浅克隆，仅取最新版，之后无法 checkout 到历史版本）'
          : '（完整克隆。浅克隆会导致之后无法 checkout 到指定版本）')
        + '，默认分支',
    },
  ]

  if (depth.length) {
    steps.push({
      kind: 'note',
      why: 'Shallow clone selected. To pin a specific version later, '
        + 'a full re-clone is required.',
      whyZh: '已选择浅克隆。若之后需要指定历史版本，'
        + '必须重新完整克隆。',
    })
  }

  steps.push({
    kind: 'gitignore',
    why: `The upstream source tree must be excluded via .gitignore \u2014 engines/${id} ` 
      + `holds thousands of files that would otherwise be committed.`,
    whyZh: `上游源码需要写入 .gitignore 排除，${id} 那一树有几千个文件，\n`
      + `否则会随提交进入版本库。`
  })

  return {
    ok: true,
    id,
    dir: clonable.dir,
    cloneUrl: input.cloneUrl,
    steps,
    execute: input.execute === true,
  }
}

/**
 * 杀进程树。
 *
 * Windows: taskkill /T 杀整个树：child.kill() 只杀 shell 不杀 git
 *   （git 自己也是父进程，kill 了 shell 后它仍在运行）。
 * 非 Windows: kill 进程组（负 PID）：git 起的子进程在同一组里。
 *
 * @param {import('node:child_process').ChildProcess} child
 */
/**
 * 杀进程树。
 *
 * 两条实现路径完全不同（Windows 走 taskkill /T /F，posix 走信号），
 * 而开发机只有 Windows ⇒ posix 那条长期没人跑过。
 * 它在 Linux 上杀不掉任何进程：spawn 默认不设 detached
 * ⇒ 子进程与父进程同组，负 PID 指的是「组 ID 等于 child.pid 的那个组」，
 * 而它并不存在 ⇒ 那个进程一直跑，node --test 等它退出 ⇒ 整轮测试挂住。
 *
 * platform 显式传入（与 venvPythonRelPath / resolveUv 同一套做法）：
 *   这样 posix 那条在任何机器上都能被测到。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} [platform] process.platform
 */
function killProcessTree (child, platform) {
  if (!child || child.killed) return
  const plat = platform || process.platform
  if (plat === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true })
    } catch (e) { /* 进程可能已退出 */ }
    return
  }
  // 先杀进程本身：这一条与组无关，任何平台都该做。
  try { child.kill('SIGKILL') } catch (e) { /* 可能已退出 */ }
  // 再尝试杀组：子进程自己建了组时（detached）这一条才有用。
  try { process.kill(-child.pid, 'SIGKILL') } catch (e) { /* 没有那个组 */ }
}

/**
 * 执行克隆（异步，支持取消）。
 *
 * 取消时：
 *   1. 杀进程树（Windows: taskkill /T；其他: kill 进程组）
 *   2. 删掉整个目标目录：本步创建的，删除是撤销本步操作
 *      （不是只删 .git：只删 .git 会留下残缺目录，下次卡在目录非空）
 *   3. 返回 CLONE_CANCELLED
 *
 * 凭据管理器弹框杀不掉时：5 秒安全网后如实报 CLONE_CANCEL_FAILED。
 *
 * @param {object} input - 同 buildClonePlan，另加：
 *   @param {AbortSignal} [input.signal] - 取消信号
 *   @param {Function} [input.spawn]   - 可注入的 spawn（测试用，不真跑 git）
 * @returns {Promise<object>}
 */
async function runClone (input = {}) {
  const plan = buildClonePlan(input)
  if (!plan.ok || !plan.execute) return plan

  // 复用的情形：不跑 git，也不写盘。
  //   目录里已有的东西是使用者的资产（装好的环境、下载好的权重），
  //   重新克隆会先删掉它们，而平台没有断点续传。
  if (plan.state === 'reused') {
    return {
      ...plan,
      ok: true,
      reused: true,
      note: 'The engine directory already exists, so it was reused as it is. '
        + 'Nothing was downloaded and nothing was deleted.',
      noteZh: '引擎目录已存在，直接复用了。'
        + '既没有下载，也没有删除任何东西。',
    }
  }

  const root = input.root || projectRoot()
  const argv = plan.steps[0].argv
  const targetDir = path.join(root, 'engines', String(input.id))
  const timeoutMs = input.timeoutMs || 30 * 60 * 1000
  // 测试注入点：不真跑 git clone（太慢、要联网）
  const spawnFn = typeof input.spawn === 'function' ? input.spawn : spawn
  // 测试注入点：杀进程树（Windows taskkill / 非 Windows kill 进程组）
  const killFn = typeof input.killProcessTree === 'function'
    ? input.killProcessTree
    : killProcessTree

  return new Promise((resolve) => {
    let resolved = false
    let cancelled = false
    let cancelReason = null        // 'user' | 'timeout' | null
    let child = null
    let timeoutId = null
    let stdout = ''
    let stderr = ''

    const safeResolve = (result) => {
      if (resolved) return
      resolved = true
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null }
      resolve(result)
    }

    const cleanup = () => {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null }
    }

    /**
     * 取消：杀进程树 + 删目录。
     * 不在这里 resolve：等 child.on('close') 触发（进程真死了才算取消成功）。
     * 安全网：进程杀不掉时（如凭据管理器弹框阻塞），5 秒后如实报无法取消。
     */
    const doCancel = (reason) => {
      if (cancelled) return
      cancelled = true
      cancelReason = reason
      if (child) killFn(child)
      try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch (e) { }
      // 安全网：进程杀不掉 ⇒ 不假装成功。
      // 不分原因兜底：用户取消与超时都会走到这里，只要有一步没 resolve
      // 就必须收尾，否则调用方永远等不到结果。
      const safetyNetMs = typeof input.safetyNetMs === 'number' ? input.safetyNetMs : 5000
      setTimeout(() => {
        if (!resolved && cancelled) {
          safeResolve({
            ...plan, ok: false,
            code: cancelReason === 'user' ? 'CLONE_CANCEL_FAILED' : 'CLONE_TIMEOUT',
            error: 'Cannot cancel clone: the process could not be killed.\n'
              + 'A credential manager dialog may be blocking it — close it manually.',
            errorZh: '无法取消克隆：进程杀不掉。\n'
              + '可能被凭据管理器弹框阻塞，请手动关闭弹框。',
          })
        }
      }, safetyNetMs).unref()
    }

    const onAbort = () => doCancel('user')

    if (input.signal) {
      if (input.signal.aborted) {
        // 取消发生在 spawn 之前：还没有进程要杀、没有 close 事件会来，
        //   只走 doCancel 的话这个 Promise 永远不 settle。这里直接收尾。
        doCancel('user')
        safeResolve({
          ...plan, ok: false, code: 'CLONE_CANCELLED',
          cancelled: true,
          error: 'Clone cancelled before git was launched.',
          errorZh: '已取消：git 还没启动。',
        })
        return
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      child = spawnFn(argv[0], argv.slice(1), {
        cwd: root,
        windowsHide: true,
        shell: false,
      })
    } catch (e) {
      if (input.signal) input.signal.removeEventListener('abort', onAbort)
      safeResolve({
        ...plan, ok: false, code: 'SPAWN_FAILED',
        error: `Cannot launch git: ${e.message}`,
        errorZh: `起不动 git：${e.message}`,
      })
      return
    }

    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })

    child.on('error', (e) => {
      if (input.signal) input.signal.removeEventListener('abort', onAbort)
      if (cancelled) return
      safeResolve({
        ...plan, ok: false, code: 'SPAWN_FAILED',
        error: `Cannot launch git: ${e.message}`,
        errorZh: `起不动 git：${e.message}`,
      })
    })

    child.on('close', (code) => {
      if (input.signal) input.signal.removeEventListener('abort', onAbort)
      cleanup()
      if (cancelled) {
        if (cancelReason === 'user') {
          safeResolve({
            ...plan, ok: false, code: 'CLONE_CANCELLED',
            error: 'Clone cancelled by user.\nThe target directory has been removed.',
            errorZh: '克隆已取消。\n目标目录已删除。',
          })
        } else {
          safeResolve({
            ...plan, ok: false, code: 'CLONE_TIMEOUT',
            error: 'Clone timed out. The target directory has been removed.',
            errorZh: '克隆超时，目标目录已删除。',
          })
        }
        return
      }
      if (code !== 0) {
        safeResolve({
          ...plan, ok: false, code: 'GIT_FAILED',
          error: (stderr || stdout || 'git 没有说为什么就退了').trim(),
          status: code,
        })
        return
      }
      // 只报「git 说成功了」，不报「克隆好了」：那要等第 4 步的自检（import 探针）才能下结论。
      safeResolve({
        ...plan, ok: true, gitStatus: code,
        note: 'git exited 0. That only means the files are in place — '
          + 'whether this engine actually works awaits the checks that come next.',
        noteZh: 'git 退出码 0。这只说明文件到位了，'
          + '「这台引擎能用吗」要等后面的校验。',
      })
    })

    // 超时处理：杀进程树 + 删目录
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => doCancel('timeout'), timeoutMs)
      timeoutId.unref()
    }
  })
}

/**
 * 删掉目标目录。
 *
 * 两个用途：
 *   ① 目标目录已存在（之前克隆过），使用者要重来 ⇒ 清除后重试。
 *   ② 克隆完成后悔了 ⇒ 撤销克隆。
 *
 * 判据：只删 engines/<id>/ 这一棵，不碰 engines/ 里的其他引擎。
 *   路径由 id 拼出来，id 里带斜杠会越出 engines/ ⇒ 先按安全 id 校验。
 *
 * @returns {{ok:true, id, dir, removed:boolean, entries:number}}
 *          | {ok:false, code, error}
 */
function removeTargetDir (id, opts = {}) {
  if (typeof id !== 'string' || !id.trim()) {
    return { ok: false, code: 'MISSING_ID',
      error: 'No directory name given.',
      errorZh: '还没有填目录名。' }
  }
  // id 会拼进路径：只允许字母数字、下划线、连字符。
  // 允许斜杠的话 engines/../.. 就能删到 engines/ 外面去。
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return { ok: false, code: 'BAD_ID',
      error: `Invalid directory name: ${id}`,
      errorZh: `目录名不合法：${id}。只允许字母、数字、下划线与连字符。` }
  }
  const root = opts.root || projectRoot(opts.from)
  if (!root) {
    return { ok: false, code: 'NO_ROOT',
      error: 'Project root not found (no server.js above). The wizard must run inside the project directory.',
      errorZh: '找不到项目根（向上没有 server.js）。向导需要在项目目录内运行。' }
  }
  const dir = engineDir(id, root)
  if (!fs.existsSync(dir)) {
    return { ok: true, id, dir, removed: false, entries: 0 }
  }
  const entries = fs.readdirSync(dir).length
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    return { ok: false, code: 'REMOVE_FAILED',
      error: `Cannot remove ${dir}: ${(e && e.message) || e}`,
      errorZh: `删不掉 ${dir}：${(e && e.message) || e}` }
  }
  return { ok: true, id, dir, removed: true, entries }
}

module.exports = {
  projectRoot, engineDir, inspectTarget, checkClonable, buildClonePlan, runClone,
  killProcessTree, removeTargetDir,
  readGitIdentity, normalizeRepoUrl, compareUpstream,
}