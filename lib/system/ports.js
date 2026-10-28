// 跨平台的「端口 / 进程」原语：启动与停止两个入口都要用，放在一处只有一个实现，拆成两份就一定会漂移。
// 只认 LISTENING：TIME_WAIT 等状态在 Stop 杀掉监听者之后还会挂几十秒，算成「端口被占」会让 start 误判「不用重启」。
// 每个平台先试原生命令，不可用才退回兜底。「我上次留下的」和「别人占着的」必须分得开，
// 所以要拿可执行文件路径加完整命令行。
// 这里不判断「这个进程是不是我们家的」：那是 portChoice.js 的事。

'use strict'

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync, spawn } = require('node:child_process')

const IS_WIN = process.platform === 'win32'

/** 跑一条命令拿 stdout（失败返回空串，不抛）*/
function run (cmd, args, timeoutMs = 8000) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (r.error || r.status !== 0) return ''
  return r.stdout || ''
}

/** 监听 port 的进程 pid 列表（去重）。只算 LISTENING。 */
function listenersOnPort (port) {
  const p = String(port)
  if (IS_WIN) return winListeners(p)
  if (process.platform === 'linux') return linuxListeners(p)
  if (process.platform === 'darwin') return darwinListeners(p)
  // 不认识的平台不猜：宁可说「查不到」，也不要返回一个看着像真的空数组，
  // 后者会被读成「端口空闲」，而它实际是「不知道」。
  return []
}

// Windows：先试 Get-NetTCPConnection（结构化，不必解析表格），不可用才退 netstat。
function winListeners (port) {
  const ps =
    "$c = Get-NetTCPConnection -State Listen -LocalPort " + port + " -ErrorAction Stop; " +
    'if ($c) { $c | ForEach-Object { $_.OwningProcess } }'
  const viaCmdlet = run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps])
  if (viaCmdlet.trim()) {
    return [...new Set(
      viaCmdlet.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number))]
  }
  // 兜底：解析 netstat -ano，只认 LISTENING。
  const out = run('netstat.exe', ['-ano'])
  const found = []
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    // 本地地址列里匹配「:端口」后面必须跟空白或行尾，否则 9886 会匹配上 19886。
    if (!new RegExp('[:.]' + port + '\\s').test(line)) continue
    const cols = line.trim().split(/\s+/)
    const last = cols[cols.length - 1]
    if (/^\d+$/.test(last)) found.push(Number(last))
  }
  return [...new Set(found)]
}

// Linux：`ss -Hltnp` 直接给出 pid。没有 ss 就退回解析 /proc/net/tcp 加遍历 fd（慢但全）。
function linuxListeners (port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')

  const ss = run('ss', ['-Hltnp'])
  if (ss) {
    const found = []
    for (const line of ss.split('\n')) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 4) continue
      const local = cols[3] || ''
      // local_address 形如 0.0.0.0:9886 或 [::]:9886
      if (!local.endsWith(':' + hex) && !local.endsWith(':' + port)) continue
      // 过滤状态：ss -l 只列 LISTEN，这里再确认一次，不依赖调用处的选项。
      if (cols[0] && !/^LISTEN/i.test(cols[0])) continue
      const m = /pid=(\d+)/.exec(line)
      if (m) found.push(Number(m[1]))
    }
    if (found.length) return [...new Set(found)]
  }

  // 兜底：/proc/net/tcp 的 LISTEN 状态是 0A，inode 要靠 /proc/*/fd 配对。
  const tcp = run('sh', ['-c', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null'])
  if (!tcp) return []
  const inodes = new Set()
  for (const line of tcp.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 10) continue
    if (cols[3] !== '0A') continue // 0A = TCP_LISTEN
    if (!cols[1].endsWith(':' + hex)) continue
    inodes.add(cols[9])
  }
  if (!inodes.size) return []
  const found = []
  for (const pid of pids()) {
    const fddir = '/proc/' + pid + '/fd'
    let names
    try { names = fs.readdirSync(fddir) } catch (_) { continue }
    for (const fd of names) {
      let link
      try { link = fs.readlinkSync(path.join(fddir, fd)) } catch (_) { continue }
      const m = /^socket:\[(\d+)\]$/.exec(link)
      if (m && inodes.has(m[1])) { found.push(pid); break }
    }
  }
  return [...new Set(found)]
}

// macOS：lsof 的 -F 输出是机器可读的字段流：p<pid> n<name> …
function darwinListeners (port) {
  const out = run('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-F', 'pn'])
  const found = []
  let pid = null
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== null && /^\d+$/.test(line.slice(1))) {
      found.push(Number(line.slice(1)))
      pid = null
    }
  }
  return [...new Set(found)]
}

/** 端口上有没有人在听（只要一个布尔，不要 pid 列表）*/
function isPortListening (port) {
  return listenersOnPort(port).length > 0
}

/** 一个 pid 的可执行文件路径与完整命令行（尽力而为，任一可能为空）。 */
function procInfo (pid) {
  if (!pid || pid <= 0) return { pid: 0, path: '', commandLine: '', name: '' }
  if (IS_WIN) return winProcInfo(pid)
  if (process.platform === 'linux') return linuxProcInfo(pid)
  return bsdProcInfo(pid) // darwin
}

function winProcInfo (pid) {
  const all = winAllProcs()
  return all.get(Number(pid)) || { pid: Number(pid), path: '', commandLine: '', name: '' }
}

// 一次拿到全部进程的信息，然后建索引。为什么要批：逐个 pid 查会变成「每个进程起一次 PowerShell」，一次 stop 要几十秒。
function allProcsInfo () {
  if (IS_WIN) return winAllProcs()
  const out = new Map()
  for (const pid of pids()) out.set(pid, procInfo(pid))
  return out
}

// 缓存必须带 TTL，不能是进程生命周期级：进程级的表里查不到之后才启动的进程，
// 而 stop 的第二遍目录扫描正是为这种情况存在的。
// 2 秒：够覆盖一次批量查询，又不至于看不见刚起的进程。
const WIN_PROCS_TTL_MS = 2000
let _winProcsCache = null
let _winProcsAt = 0
function winAllProcs () {
  if (_winProcsCache && Date.now() - _winProcsAt < WIN_PROCS_TTL_MS) return _winProcsCache
  _winProcsCache = new Map()
  _winProcsAt = Date.now()
  // 用 ConvertTo-Json 而不是逐字段分隔：分隔符方案要处理「路径里有空格」，而 PowerShell 自己的 ConvertTo-Json 不会。
  const ps = [
    'Get-CimInstance Win32_Process |',
    '  Select-Object ProcessId, ExecutablePath, CommandLine, Name |',
    '  ConvertTo-Json -Compress -Depth 2',
  ].join(' ')
  const out = run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps], 30000)
  if (out.trim()) {
    try {
      const data = JSON.parse(out.trim())
      for (const row of (Array.isArray(data) ? data : [data])) {
        const pid = Number(row.ProcessId)
        if (!pid) continue
        const p = row.ExecutablePath || ''
        _winProcsCache.set(pid, {
          pid,
          path: p,
          commandLine: row.CommandLine || '',
          // 没有路径时退回名称：路径为空就放弃判断会漏掉真实的进程，名字至少可用于展示与部分判断。
          name: row.Name || (p ? path.basename(p) : ''),
        })
      }
    } catch (_) { /* 解析不了就退回逐个查 */ }
  }
  return _winProcsCache
}

function linuxProcInfo (pid) {
  const info = { pid, path: '', commandLine: '', name: '' }
  try { info.path = fs.readlinkSync('/proc/' + pid + '/exe') } catch (_) {}
  try {
    info.commandLine = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')
      // Linux 的 cmdline 用 \0 分隔参数
      .replace(/\0+$/, '').split('\0').join(' ')
  } catch (_) {
    // 进程刚退出时 /proc/<pid>/cmdline 就没了：commandLine 留空，path 与 name 照常返回，
    // 调用方按「只知道 pid」处理。
  }
  if (info.path) info.name = path.basename(info.path)
  return info
}

function bsdProcInfo (pid) {
  const info = { pid, path: '', commandLine: '', name: '' }
  const out = run('ps', ['-o', 'comm=', '-o', 'args=', '-p', String(pid)])
  const line = out.trim()
  if (line) {
    // comm 与 args 之间可能有多个空格，而 args 本身含空格：只能按前导空白切一次
    const m = line.match(/^(\S+)\s+([\s\S]*)$/)
    if (m) { info.name = m[1]; info.commandLine = m[2] }
  }
  return info
}

/** 强制结束一个 pid。不吞掉失败：返回值说明到底成没成，因为「停不掉」会锁住文件。 */
function killPid (pid) {
  if (!pid || pid <= 0) return { ok: false, why: 'pid 不合法' }
  if (IS_WIN) {
    const r = spawnSync('taskkill.exe', ['/F', '/PID', String(pid)],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    if (r.status === 0) return { ok: true, why: '' }
    const raw = ((r.stdout || '') + (r.stderr || '')).trim()
    // taskkill 的输出走系统 OEM 代码页（本机 GBK），按 utf8 解出来是乱码，而这条会显示给用户：
    // 一句乱码等于没有信息。所以不是 ASCII 就不用它，只说我们自己知道的事：
    // 「权限不足 / 进程已不存在 / 系统拒绝」这三种，我们能从「这个 pid 现在还在不在」独立判掉后两种。
    if (raw && !/^[\x00-\x7F]*$/.test(raw)) {
      return {
        ok: false,
        why: procAlive(pid)
          ? '系统拒绝结束这个进程。最常见的原因是权限不足：'
            + '用管理员身份重跑一次试试。'
          : '结束失败，但该进程已经不在了（可能是它自己退的）',
      }
    }
    return { ok: false, why: raw || ('taskkill 退出码 ' + r.status) }
  }
  // 杀之前先看它在不在：POSIX 的 kill 对「已经死掉的 pid」也可能返回成功（僵尸进程还能收信号，
  // pid 被复用时更是如此），而「杀一个已经不在的进程」该如实说失败。
  if (!procAlive(pid)) {
    return { ok: false, why: '该进程已经不在了（可能它自己退的）' }
  }
  try { process.kill(pid, 'SIGKILL') } catch (e) { return { ok: false, why: e.message } }
  // 真去确认一次：信号只是投递出去，进程被调度处理之前它还「在」，立刻查会判成「进程仍在」。
  // Windows 的 taskkill 是同步的，不受这个影响。20ms 足够调度一次；查 5 次。
  for (let i = 0; i < 5; i++) {
    if (!procAlive(pid)) return { ok: true, why: '' }
    sleepSyncMs(20)
  }
  return { ok: false, why: '进程仍在' }
}

/** 同步睡一会儿（Atomics.wait 是 Node 里唯一不占事件循环的睡法） */
function sleepSyncMs (ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch (e) { /* 忽略 */ }
}

/** 这个 pid 现在还在吗 */
function procAlive (pid) {
  if (!pid || pid <= 0) return false
  if (IS_WIN) {
    const out = run('tasklist.exe', ['/FI', 'PID eq ' + pid, '/NH'])
    return new RegExp('\\b' + pid + '\\b').test(out)
  }
  // POSIX：信号 0 只问「能不能送达」。但僵尸进程也能收信号，kill(pid, 0) 对僵尸返回成功，
  // 而僵尸早就退出了（只是还没被父进程回收）。不看 /proc 就分不出「还活着」与「已经死了但没被回收」：
  // 读 /proc/<pid>/stat 的第 3 个字段，Z = 僵尸。
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
      // 格式：pid (comm) state …，comm 里可能有空格与括号，从最后一个 ')' 之后取。
      const tail = stat.slice(stat.lastIndexOf(')') + 1).trim()
      const state = tail.split(' ')[0]
      if (state === 'Z' || state === 'X') return false   // 僵尸 / 已死
    } catch (e) {
      // /proc 里没有这个 pid：已经退出（正常路径）
      return false
    }
  }
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** 当前用户可见的全部 pid */
function pids () {
  if (IS_WIN) {
    const out = run('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | ForEach-Object { $_.Id }'])
    return out.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number)
  }
  if (process.platform === 'linux') {
    const out = run('sh', ['-c', 'ls -1 /proc 2>/dev/null'])
    return out.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number)
  }
  const out = run('ps', ['-o', 'pid=', '-A'])
  return out.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number)
}

/**
 * 可执行文件落在 `dir` 之下的所有进程。
 * 只比可执行文件路径，不比命令行：把命令行也算进去是危险的放宽，命令行里含仓库路径的东西太多
 *（用户的 shell、编辑器、CI 的包装脚本），全都会命中，于是会把用户的 shell 杀掉。
 * 引擎的 pid 能被找到，是因为它们的可执行文件路径就在引擎 venv 里。
 * 需要「路径 + 命令行」一起看的是 testIsOwnProcess（同目录下的身份判定助手）。
 */
function procsUnderDir (dir, { matchCmdline = false } = {}) {
  if (!dir) return []
  const base = path.resolve(dir).toLowerCase()
  const out = []
  for (const [pid, info] of allProcsInfo()) {
    if (pid === process.pid) continue
    if (!info.path) continue
    let hay = info.path.toLowerCase()
    if (matchCmdline) hay += ' ' + info.commandLine.toLowerCase()
    if (hay.includes(base)) out.push({ pid, path: info.path, name: info.name })
  }
  return out
}


/**
 * 在后台起一个进程，stdout / stderr 各落一个文件。
 * 三平台都要「彻底脱离当前进程」：Windows 需要 windowsHide（否则弹黑框）；POSIX 需要
 * detached: true 加 unref()，否则父进程一退它就被收走；落盘用 fd 而不是重定向字符串，
 * 因为 POSIX 的 detached 进程没有终端。
 */
function spawnDetached (exe, args, { cwd, outFile, errFile, env } = {}) {
  const mk = (file) => {
    if (!file) return 'ignore'
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); return fs.openSync(file, 'a') }
    catch (e) { return 'ignore' }
  }
  const outFd = mk(outFile)
  const errFd = mk(errFile)
  const c = spawn(exe, args || [], {
    cwd: cwd || process.cwd(),
    env: env || process.env,
    detached: !IS_WIN,      // POSIX：脱离当前进程组，否则父进程一退它就被收走
    windowsHide: true,      // Windows：否则弹一个黑框
    stdio: ['ignore', outFd, errFd],
  })
  c.unref()
  for (const fd of [outFd, errFd]) if (fd !== 'ignore') { try { fs.closeSync(fd) } catch (_) {} }
  // spawn 是异步的：pid 立刻就有，但 exe 本身可能根本起不来（路径错、缺权限）。
  // 那个错误会走 'error' 事件，这里只能报「已发起」。
  return { ok: true, pid: c.pid || null, why: '' }
}

/** 打开浏览器。@returns {{ok:boolean, how:string}} */
function openUrl (url) {
  if (IS_WIN) {
    // 不能用 start：它是 cmd 内建，spawnSync 找不到，要用 cmd /c。而且 URL 里的 & 会把命令截断：
    // 传数组参数让 cmd 自己引号化。
    const r = spawnSync('cmd.exe', ['/c', 'start', '""', url], { windowsHide: true })
    return { ok: r.status === 0, how: 'cmd /c start' }
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const r = spawnSync(opener, [url], { stdio: 'ignore', detached: true })
  if (r.error) return { ok: false, how: opener + ' 不可用' }
  r.unref && r.unref()
  return { ok: true, how: opener }
}

/** 探一个 HTTP 端点是否已就绪。*/
function httpReady (url, timeoutMs = 2000) {
  const http = require('node:http')
  return new Promise(resolve => {
    let done = false
    const finish = v => { if (!done) { done = true; resolve(v) } }
    let req
    try {
      req = http.get(url, { timeout: timeoutMs }, res => {
        res.resume()
        // 判据：状态码 > 0 就算就绪。502 也算：那说明后端在听，而它自己内部出错是另一回事。
        finish(res.statusCode > 0)
      })
    } catch (_) { return finish(false) }
    req.on('error', () => finish(false))
    req.on('timeout', () => { try { req.destroy() } catch (_) {} ; finish(false) })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 清掉进程表缓存：必须有，否则 stop 起来之后新起的进程看不见。 */
function clearProcsCache () { _winProcsCache = null; _winProcsAt = 0 }

module.exports = {
  listenersOnPort,
  procAlive,
  allProcsInfo,
  clearProcsCache,
  isPortListening,
  procInfo,
  killPid,
  pids,
  procsUnderDir,
  spawnDetached,
  openUrl,
  httpReady,
  sleep,
  IS_WIN,
}