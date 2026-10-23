// 端口归属判定：把一个期望端口解析成一个动作，跨三平台。free 没人监听；own 我们自己
// 上次留下的；claimed 别台已许给此端口；shifted 陌生进程占着；后三者都往上挪。
// 只认 LISTENING：TIME_WAIT 等状态在 Stop 杀掉监听者后还会挂几十秒，算成「端口被占」会让
// start 以为「上次那个仍在运行，不用重启」。

'use strict'

const P = require('./ports.js')

function testPort (port) {
  return P.isPortListening(port)
}

/**
 * 这个 pid 是不是我们家的。两条都要满足：路径或命令行里有这个安装根目录，且命令行
 * 里有 `server.js`（后端）或本次传入的某个引擎记号。路径这条不能省：只看「命令行里有
 * server.js」会把别人的 server.js 也认成我们的。记号来自 manifest.json 的
 * own_process_mark，一台引擎一个；拿不到就只认后端，空记号也不能参与匹配。问「A 的
 * 端口」时只传 A 的记号，否则 B 占着 A 的端口会被判成「A 已在运行」。
 */
function testIsOwnProcess (pid, baseDir, marks = []) {
  if (!pid) return false
  const info = P.procInfo(pid)
  const hay = (info.path + ' ' + info.commandLine).toLowerCase()
  if (!hay.trim()) return false

  const baseLc = String(baseDir || '').toLowerCase()
  if (!baseLc) return false
  const underBase = hay.includes(baseLc)
  if (!underBase) return false

  if (hay.includes('server.js')) return true
  for (const m of marks || []) {
    if (m && hay.includes(String(m).toLowerCase())) return true
  }
  return false
}

// 从期望端口往上找第一个没人听的。`exclude` = 已许给别台引擎但还没开始监听的端口：少了它，
// 两台引擎写同一个默认端口会都被判成「空闲」。
function getFreePort (startPort, { maxTries = 50, exclude = [] } = {}) {
  const taken = new Set((exclude || []).map(Number))
  for (let p = startPort; p < startPort + maxTries; p++) {
    if (p > 65535) break
    if (taken.has(p)) continue
    if (!testPort(p)) return p
  }
  return null
}

// 主入口：判定一个期望端口归谁，必要时往上挪。action 取 free/own/claimed/shifted/exhausted
function resolvePort (name, desired, baseDir, { marks = [], exclude = [] } = {}) {
  const res = { name, port: desired, action: 'free', ownerPid: null }
  const taken = new Set((exclude || []).map(Number))

  // 本次启动里已经有别台认领了这个端口。它还没开始监听，所以 testPort 会回答「空闲」：那
  // 个答案在这里是错的，先单独挡掉。也别并进下面的 shifted（那条路会印「被陌生进程 pid
  // 占着」，而这里没有陌生进程）。
  if (taken.has(desired)) {
    const free = getFreePort(desired + 1, { exclude })
    if (free === null) { res.action = 'exhausted'; return res }
    res.port = free
    res.action = 'claimed'
    return res
  }

  if (!testPort(desired)) return res

  const ownerPid = P.listenersOnPort(desired)[0] || null
  res.ownerPid = ownerPid
  if (testIsOwnProcess(ownerPid, baseDir, marks)) { res.action = 'own'; return res }

  const free = getFreePort(desired + 1, { exclude })
  if (free === null) { res.action = 'exhausted'; return res }
  res.port = free
  res.action = 'shifted'
  return res
}

/** 给界面/日志用的一句人话（措辞不要自己改口）*/
function describe (r) {
  switch (r.action) {
    case 'free': return `${r.name}: ${r.port} 空闲，直接用。`
    case 'own': return `${r.name}: ${r.port} 已被**我们自己的**进程占着（pid ${r.ownerPid}）：复用，不重启。`
    case 'shifted': return `${r.name}: 期望端口被陌生进程占着（pid ${r.ownerPid}）：挪到 ${r.port}。`
    case 'claimed': return `${r.name}: 本次启动里已有另一台要用这个端口：挪到 ${r.port}。`
    case 'exhausted': return `${r.name}: 附近找不到空端口，中止。`
    default: return `${r.name}: ${r.port}`
  }
}

module.exports = {
  testPort,
  testIsOwnProcess,
  getFreePort,
  resolvePort,
  describe,
}