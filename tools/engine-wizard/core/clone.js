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
 * @returns {{ok:true, dir} | {ok:false, code, error, entries?}}
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
  if (info.entries.length === 0) return { ok: true, dir: info.dir }

  // 非空，所以不许默默继续，也不许默默覆盖
  const listed = info.entries.slice(0, 8)
  return {
    ok: false,
    code: 'DIR_NOT_EMPTY',
    dir: info.dir,
    entries: info.entries,
    error: `engines/${id}/ already has ${info.entries.length} item(s):`
      + `${listed.join(', ')}${info.entries.length > 8 ? ' …' : ''}\n`
      + 'git clone requires an empty target directory.\n'
      + '  · Usually this means the engine was already cloned — check whether you need to reinstall.\n'
      + '  · To reinstall, remove the directory first (the platform will not delete it for you).\n',
    errorZh: `engines/${id}/ 里已经有 ${info.entries.length} 项：`
      + `${listed.map((e) => e).join('、')}${info.entries.length > 8 ? ' …' : ''}\n`
      + 'git clone 要求目标目录为空。\n'
      + '  · 通常表示该引擎已克隆过，请确认是否需要重新安装\n'
      + '  · 如需重新安装，请先移除该目录（平台不会自动删除）\n',
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
 *   （git 自己也是父进程，kill 了 shell 它还在跑）。
 * 非 Windows: kill 进程组（负 PID）：git 起的子进程在同一组里。
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killProcessTree (child) {
  if (!child || child.killed) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true })
    } catch (e) { /* 进程可能已退出 */ }
  } else {
    // 负 PID = 进程组（spawn 默认不设 detached，子进程在同一个组里）
    try { process.kill(-child.pid, 'SIGKILL') } catch (e) { /* 可能已退出 */ }
  }
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
              + '可能被凭据管理器弹框阻塞 —— 请手动关闭弹框。',
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

module.exports = {
  projectRoot, engineDir, inspectTarget, checkClonable, buildClonePlan, runClone,
  killProcessTree,
}