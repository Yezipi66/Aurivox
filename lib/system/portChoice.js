// 端口归属判定：把一个期望端口解析成一个动作，跨三平台。free 没人监听；own 是本安装上次
// 留下的进程；claimed 本次启动已许给别台；shifted 陌生进程占着；后三者都往上挪。
// 只认 LISTENING：TIME_WAIT 等状态在 Stop 杀掉监听者后还会挂几十秒，算成「端口被占」会让
// start 以为「上次那个仍在运行，不用重启」。

'use strict'

const P = require('./ports.js')

function testPort (port) {
  return P.isPortListening(port)
}

/**
 * 这个 pid 是不是本安装起的进程。两段判据都要成立：
 *   ① 落在安装根里：可执行文件路径、命令行，任一处含安装根目录即可。两个都查，是因为
 *      进程可能跑在 PATH 上的系统解释器上，可执行文件路径在仓库外，只有命令行能证明归属。
 *      只看「命令行里有 server.js」会把别的安装的 server.js 也认成本安装的。
 *   ② 有身份记号：命令行里有 `server.js`，或 marks 里某一项出现在命令行里。
 *      记号只查命令行，不查路径：路径里的同名只是巧合，命令行里的记号是启动时带上的。
 *      拿不到命令行就如实判「不是」，不猜。
 *
 * marks 只传问的那个自己：多传一个记号，就会把占着这个端口的另一台引擎判成「这台已在
 * 运行」。空记号不参与匹配。
 */
function testIsOwnProcess (pid, baseDir, marks = []) {
  if (!pid) return false
  const baseLc = String(baseDir || '').toLowerCase()
  if (!baseLc) return false
  const info = P.procInfo(pid)
  const pathLc = String(info.path || '').toLowerCase()
  const cmdLc = String(info.commandLine || '').toLowerCase()
  if (!pathLc && !cmdLc) return false
  if (!pathLc.includes(baseLc) && !cmdLc.includes(baseLc)) return false
  if (cmdLc.includes('server.js')) return true
  for (const m of marks || []) {
    if (m && cmdLc.includes(String(m).toLowerCase())) return true
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
    case 'own': return `${r.name}: ${r.port} 已被本平台自己的进程占着（pid ${r.ownerPid}）：复用，不重启。`
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