// =============================================================================
//  portChoice.js — 「这个端口归谁」的三平台翻译
//
//  ⚠️⚠️⚠️ 这个算法**不是**重新设计的，是从 tools\scripts\start.ps1 里
//     **逐条搬过来的**。那份 PowerShell 被真机 bug 打磨过，每一条判据都有
//     来历。搬的时候我把来历一起搬了过来 —— 因为「为什么这么判」比「判什么」
//     更难重建，丢了就等于把 bug 放回去。
//
//  一个期望端口解析成一个动作：
//   free      没人监听 → 就用它，正常启动
//   own       **我们自己**上次留下的 → 就用它，不重启
//   claimed   本次启动里**别的服务**已经许给这个端口 → 往上挪
//   shifted   **陌生程序**占着 → 往上挪
//   exhausted 附近找不到空端口 → 致命，退出
// =============================================================================

'use strict'

const P = require('./ports.js')

// =============================================================================
//  Test-Port —— 这个端口上有没有人在听
// =============================================================================
/**
 * ⭐ **只认 LISTENING**，不认 TIME_WAIT / CLOSE_WAIT / ESTABLISHED。
 *
 * 那几个状态在 Stop 杀掉监听者之后还会挂几十秒。把它们算成「端口被占」
 * ⇒ start 会以为「上次那个还在跑，不用重启」⇒ 出现「点完停止、再点两次启动
 * 那个端口就再也起不来」的 bug。
 *
 * ⛔ 这不是性能问题，是正确性问题 —— 别为了「快」把它放宽成「有连接就算」。
 */
function testPort (port) {
  return P.isPortListening(port)
}

// =============================================================================
//  Get-ListenerPid —— 谁在听
// =============================================================================
// 三平台的「谁在听这个端口」命令完全不同，ports.js 各自处理：
//   Windows  Get-NetTCPConnection，不可用才退回解析 netstat
//   Linux    ss -Hltnp，没有就退回 /proc/net/tcp + fd 配对
//   macOS    lsof -F pn
// ⚠️ 共同的一条：**只取 LISTEN**（见 testPort 的说明）。

// =============================================================================
//  Test-IsOwnProcess —— 这个 pid 是不是我们家的
// =============================================================================
/**
 * 判据（两条都要满足）：
 *   1. 可执行文件路径或完整命令行里含有**这个安装根目录**
 *   2. 并且命令行里有 `server.js`（后端），或本次传入的某个记号（某台引擎）
 *
 * ⚠️ 为什么要有第 1 条：光看「命令行里有 server.js」会把**别人**的
 *   server.js 也认成我们的 —— 那台机器上恰好有另一个 node 服务的概率不低，
 *   而认错的后果是「占着端口的那个陌生程序被当成自己人，于是不去挪端口」。
 *
 * ⭐⭐ 引擎的记号来自 manifest.json（own_process_mark），一台引擎一个。
 *   拿不到就只认后端 —— **宁可漏认自家引擎**（后果是端口往上挪一个，
 *   还能起来），也不要瞎猜一个名字去误伤别人的进程。
 *
 * ⭐⭐⭐ 问「A 这台占的端口」时**必须只传 A 自己的记号**：
 *   若把 B 的记号也算上，而 B 恰好占着 A 的端口，就会被判成「A 已经在跑」
 *   ⇒ A 永远起不来，且**不报错**。lib/engines/launchPlan.js 第 264-274 行
 *   已经为同一个坑把记号改成一台一个，这里不能再把它们混回去。
 *
 * @param {number} pid
 * @param {string} baseDir   这个安装根的绝对路径
 * @param {string[]} marks   本次**这一台**的记号（不是全部）
 */
function testIsOwnProcess (pid, baseDir, marks = []) {
  if (!pid) return false
  const info = P.procInfo(pid)
  // ⚠️ 大小写不敏感：Windows 与 macOS 的文件系统默认不区分大小写，
  //   而 Linux 区分。原 PowerShell 用 OrdinalIgnoreCase 比路径，
  //   但命令行那段是 ToLowerInvariant 后比 —— 统一成全小写比。
  const hay = (info.path + ' ' + info.commandLine).toLowerCase()
  if (!hay.trim()) return false

  const baseLc = String(baseDir || '').toLowerCase()
  if (!baseLc) return false
  const underBase = hay.includes(baseLc)
  if (!underBase) return false

  if (hay.includes('server.js')) return true
  for (const m of marks || []) {
    // ⛔ 空记号不能参与匹配 —— `hay.includes('')` 恒为 true，
    //   那会让「什么都算自家进程」。原 PowerShell 用
    //   `if ($m -and ...)` 挡住了，这里用同样的判据。
    if (m && hay.includes(String(m).toLowerCase())) return true
  }
  return false
}

// =============================================================================
//  Get-FreePort —— 从期望端口往上找第一个没人听的
// =============================================================================
/**
 * ⚠️ `exclude` = **本次启动里已经许给别台引擎、但还没开始监听**的端口。
 *
 * ⛔ 少了它，两台 manifest.json 写了同一个默认端口时，两台都会被判成
 * 「这个端口没人听，空闲」，然后第二台起来撞死第一台 ——
 * 而 testPort 问的是「**现在**有没有人在听」，它答不了「**等下**有没有人要听」。
 */
function getFreePort (startPort, { maxTries = 50, exclude = [] } = {}) {
  const taken = new Set((exclude || []).map(Number))
  for (let p = startPort; p < startPort + maxTries; p++) {
    if (p > 65535) break
    if (taken.has(p)) continue
    if (!testPort(p)) return p
  }
  return null
}

// =============================================================================
//  Resolve-Port —— 主入口
// =============================================================================
/**
 * @returns {{name:string, port:number, action:'free'|'own'|'claimed'|'shifted'|'exhausted', ownerPid:number|null}}
 */
function resolvePort (name, desired, baseDir, { marks = [], exclude = [] } = {}) {
  const res = { name, port: desired, action: 'free', ownerPid: null }
  const taken = new Set((exclude || []).map(Number))

  // ⭐ 本次启动里已经有别台认领了这个端口。它还没开始监听，所以 testPort
  //   会回答「空闲」—— 那个答案在这里是**错的**，先单独挡掉，别让它往下走。
  // ⛔ 也别把它并进下面的 shifted：那条路会印「被陌生进程 pid 占着」，
  //   而这里根本没有陌生进程，pid 是空的。两种情况原因不同，得分开说。
  if (taken.has(desired)) {
    const free = getFreePort(desired + 1, { exclude })
    if (free === null) { res.action = 'exhausted'; return res }
    res.port = free
    res.action = 'claimed'
    return res
  }

  if (!testPort(desired)) return res // free

  const ownerPid = P.listenersOnPort(desired)[0] || null
  res.ownerPid = ownerPid
  if (testIsOwnProcess(ownerPid, baseDir, marks)) { res.action = 'own'; return res }

  const free = getFreePort(desired + 1, { exclude })
  if (free === null) { res.action = 'exhausted'; return res }
  res.port = free
  res.action = 'shifted'
  return res
}

/** 给界面/日志用的一句人话（保持原来的措辞，别自己改口）*/
function describe (r) {
  switch (r.action) {
    case 'free': return `${r.name}: ${r.port} 空闲，直接用。`
    case 'own': return `${r.name}: ${r.port} 已被**我们自己的**进程占着（pid ${r.ownerPid}）—— 复用，不重启。`
    case 'shifted': return `${r.name}: 期望端口被陌生进程占着（pid ${r.ownerPid}）—— 挪到 ${r.port}。`
    case 'claimed': return `${r.name}: 本次启动里已有另一台要用这个端口 —— 挪到 ${r.port}。`
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