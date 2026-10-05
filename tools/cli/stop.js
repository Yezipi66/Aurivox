// =============================================================================
//  stop.js — 停掉后端与推理引擎（跨平台主体）
//  取代 tools\scripts\stop.ps1（139 行 PowerShell）。
//
//  两遍，因为「占着端口」和「在运行」不是同一件事：
//    第一遍 按端口 —— 正常情况走这条；
//    第二遍 按项目目录扫进程 —— 已经不监听但**还活着**的进程仍然锁着文件，
//      所以「没有进程在监听」**不等于**「什么都没在跑」。
//      一个掉了监听器的后端曾被这个脚本报成「没在运行」，
//      然后它把一次文件迁移卡住，卡到用户手工把它找出来为止。
//
//  引擎的端口问 manifest.json 要 —— 这个文件里不该有任何一台具体引擎的知识。
//
//  ⭐⭐ 停止脚本的可靠性高于一切：它原本一个外部程序都不用，
//     改成问 node 就等于给「停不掉服务」新增一个失败原因。
//     所以问不到引擎端口时**只警告不退出**，交给第二遍兜底 ——
//     那一遍不依赖任何外部程序。
// =============================================================================

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const P = require(path.join(__dirname, '..', '..', 'lib', 'system', 'ports.js'))

// ── 参数 ────────────────────────────────────────────────────────────────────
// ⭐ --dry-run：只报告「会停掉什么」，一个进程都不动。
//    为什么需要它：这份脚本的第一遍是**按端口杀**的，而端口是平台写死的
//    （后端 9886）。没有 dry-run 的话，在别人的后端正跑着的那台机器上
//    验证它 = 把那个后端杀掉。
const DRY = process.argv.includes('--dry-run')

// ── 颜色（跟原来的 Write-Host -ForegroundColor 观感一致）──────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code, m) => (useColor ? code + m + '\x1b[0m' : m)
const CY = '\x1b[36m', GR = '\x1b[32m', YE = '\x1b[33m', RD = '\x1b[31m', DG = '\x1b[90m'
const Say = (m, col) => console.log(c(col, m))

// ── 项目根：向上找**持有 package.json** 的那一层 ──────────────────────────
// ⛔ 绝不数目录层级：这个文件被搬过好几次，而「数层级」会一直「能用」
//    却指着某个不对的地方。
function projectRoot () {
  let d = __dirname
  for (;;) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d
    const parent = path.dirname(d)
    if (parent === d) return null
    d = parent
  }
}

// ── 后端端口是平台自己的，不是引擎知识 ────────────────────────────────────
const BACKEND_PORT = 9886

/**
 * 问 manifest.json 要各引擎的端口。
 * @returns {Array<{name:string, port:number}>}
 */
function enginePorts (root) {
  if (!root) return []
  const cli = path.join(root, 'lib', 'engines', 'engine-launch-plan.cjs')
  if (!fs.existsSync(cli)) return []
  const node = bundledNode(root) || process.execPath
  let txt = ''
  try {
    const r = spawnSync(node, [cli, '--all'], { encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0) return []
    txt = (r.stdout || '').trim()
  } catch (_) { return [] }
  let data
  try { data = JSON.parse(txt) } catch (_) { return [] }
  const out = []
  for (const e of (data.engines || [])) {
    if (e.ok && e.launchable) out.push({ name: 'engine ' + e.id, port: Number(e.port) })
  }
  return out
}

/** 自带的可移植 node；没有就退回 PATH 上的 node */
function bundledNode (root) {
  const p = path.join(root, 'tools', 'runtime', 'node',
    process.platform === 'win32' ? 'node.exe' : 'node')
  return fs.existsSync(p) ? p : null
}

// =============================================================================
//  主流程
// =============================================================================
Say('==================== TTS Broker Stop ====================', CY)
let killedAny = false

// ⭐ 清掉进程表缓存：这个脚本可能刚被 start 叫起来，那之后新起的进程
//   在缓存里看不见 ⇒ 第一遍按端口能找到（那走的是另一条查询），
//   而第二遍目录扫描会漏掉它们。
P.clearProcsCache()

const root = projectRoot()
const ports = [{ name: 'backend server.js', port: BACKEND_PORT }]

const eps = enginePorts(root)
if (eps.length === 0) {
  Say('  [WARN] 拿不到引擎端口列表(manifest.json/node)，改由下面第二遍按项目目录清理。', YE)
} else {
  for (const ep of eps) ports.push(ep)
}

// ⭐ 第一遍处理过的 pid。第二遍要跳过它们 ——
//   原 PowerShell 会把同一个 pid 报两遍（先「按端口停了」，再「结束失败，
//   但它已经不在了」）。第二句是**第一句的后果**，不是新的故障，
//   而用户看着像报错。⚠️ 这是从原脚本带来的行为，不是新引入的。
const handled = new Set()

// ── 第一遍：按端口 ─────────────────────────────────────────────────────────
for (const item of ports) {
  const pids = P.listenersOnPort(item.port)
  if (pids.length === 0) {
    Say(`  :${String(item.port).padEnd(5)} ${item.name.padEnd(20)} no listening process (not running)`, DG)
    continue
  }
  for (const pid of pids) {
    const before = P.procInfo(pid)
    if (DRY) {
      Say(`  :${String(item.port).padEnd(5)} ${item.name.padEnd(20)} WOULD stop PID=${pid} (${before.name})`, YE)
      killedAny = true
      continue
    }
    const r = P.killPid(pid)
    if (r.ok) {
      Say(`  :${String(item.port).padEnd(5)} ${item.name.padEnd(20)} stopped PID=${pid} (${before.name})`, GR)
      killedAny = true
      handled.add(pid)
    } else {
      Say(`  :${String(item.port).padEnd(5)} ${item.name.padEnd(20)} failed to stop PID=${pid}: ${r.why}`, RD)
    }
  }
}

// ── 第二遍：项目目录里还活着的 ─────────────────────────────────────────────
// ⚠️ 这一遍**不依赖任何外部程序** —— 它是「问不到引擎端口」时唯一的兜底。
const leftovers = P.procsUnderDir(root)
for (const p of leftovers) {
  if (handled.has(p.pid)) continue   // 第一遍已经报过并停掉了
  if (DRY) {
    Say(`  ${'still-running (no listener)'.padEnd(27)} WOULD stop PID=${p.pid} (${p.path})`, YE)
    killedAny = true
    continue
  }
  const r = P.killPid(p.pid)
  if (r.ok) {
    Say(`  ${'still-running (no listener)'.padEnd(27)} stopped PID=${p.pid} (${p.path})`, GR)
    killedAny = true
    handled.add(p.pid)
  } else {
    Say(`  ${'still-running (no listener)'.padEnd(27)} failed to stop PID=${p.pid}: ${r.why}`, RD)
  }
}

if (!killedAny) Say('  (no services were running)', YE)
Say('=========================================================', CY)
if (DRY) Say('(--dry-run: 什么进程都没动)', YE)