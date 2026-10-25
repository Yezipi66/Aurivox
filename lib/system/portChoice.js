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
 * 这个 pid 是不是我们家的。两段判据都要成立，各查各的地方：
 *   ① 在安装根里：可执行文件路径、命令行，任一处含这个安装根目录即可。
 *      认命令行是因为两种起法的证据落点不同：引擎的解释器在自己的 .venv 里，
 *      证据落在路径；后端可能跑在 PATH 上的系统 node（路径在仓库外），
 *      那时只有脚本的绝对路径能证明它属于这个安装。
 *      这条不能省：只看「命令行里有 server.js」会把别人的 server.js 也认成我们的。
 *   ② 有身份记号：命令行里出现 `server.js`（后端），或本次传入的某个引擎记号。
 *      记号只查命令行，不查路径：路径里的字样可能恰好同名，是巧合；
 *      命令行里的记号是启动时自己带上的。命令行拿不到就如实判「不是」，不猜。
 *
 * 记号哪来的：不是名片字段（manifest.json 里没有 own_process_mark 这一项），
 * 而是 lib/engines/launchPlan.js 现场算出来的：走通用宿主的引擎用 profile.json
 * 的绝对路径，其余用入口脚本的绝对路径，一台引擎一个，拿不到就只认后端。
 * 空记号不能参与匹配。问「A 的端口」时只传 A 的记号，否则 B 占着 A 的端口会被判成
 * 「A 已在运行」；问后端端口时才传全部引擎的记号（引擎占着后端端口也要认出来）。
 *
 * 注意与 procsUnderDir（杀进程用的那份清单）的口径不同：那份只信可执行文件路径，
 * 因为按命令行杀会把「在项目目录里执行 stop 的 shell」一起杀掉。
 *   ⇒ 认得出不等于杀得掉：靠命令行认出来的那一档（弱判据）就可能杀不掉，
 *   这条差异由 ports.node.test.js 里那条守卫钉住，不要顺手抹平。
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