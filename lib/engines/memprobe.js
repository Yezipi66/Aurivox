'use strict'
// memprobe：量「我起的那个进程连同它的子孙，一共吃了多少内存」。量的是进程不是引擎：不需要名片
// 填任何字段，不认识引擎内部长什么样，也不区分 python 还是 exe。
// 不猜「哪个进程是引擎」：根 PID 是 spawn 当场返回的。同一脚本可能派生两个解释器（venv 的壳与
// 真正的运行时），引擎的内存几乎全在后者里。

const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

/** 量出来的数上再乘这么多，用来盖住漏算的子进程和断掉的父子链。 */
const HEADROOM = 1.15

/** 一棵树最多收多少个进程：防止认错爹时把半台机器收进来。 */
const MAX_TREE = 512

// 三个系统，同一个问题，三种问法。「当前用了多少」三家都有；「一生最高用过多少」只有两家有：Linux
// 的 VmHWM 与 Windows 的 PeakWorkingSetSize（单位 KB）；macOS 没有，只给当前值，单独退化成采样。

// Windows。同一张表里两个挨着的字段单位不同：WorkingSetSize 是字节，PeakWorkingSetSize 是 KB。
// 按印象统一当字节除，峰值会小 1024 倍，正是让机器 OOM 的那个方向。
function tableWindows() {
  const ps =
    'Get-CimInstance Win32_Process | ' +
    'Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PeakWorkingSetSize | ' +
    'ConvertTo-Json -Compress -Depth 2'
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  let arr = JSON.parse(out)
  if (!Array.isArray(arr)) arr = [arr]
  return arr.map((r) => ({
    pid: Number(r.ProcessId),
    ppid: r.ParentProcessId == null ? null : Number(r.ParentProcessId),
    name: r.Name || '',
    rss: r.WorkingSetSize == null ? null : Number(r.WorkingSetSize),       // 字节
    peak: r.PeakWorkingSetSize == null ? null : Number(r.PeakWorkingSetSize) * 1024, // KB ⇒ 字节
  }))
}

/** Linux。VmHWM 天然就是峰值，读个文件而已。 */
function tableLinux() {
  const rows = []
  let names
  try { names = fs.readdirSync('/proc') } catch { return rows }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    let txt
    try { txt = fs.readFileSync(`/proc/${name}/status`, 'utf8') } catch { continue }
    const pick = (k) => {
      const m = txt.match(new RegExp('^' + k + ':\\s+(\\d+) kB', 'm'))
      return m ? Number(m[1]) * 1024 : null
    }
    const pp = (txt.match(/^PPid:\s+(\d+)$/m) || [])[1]
    rows.push({
      pid: Number(name),
      ppid: pp == null ? null : Number(pp),
      name: (txt.match(/^Name:\s+(.*)$/m) || [])[1] || '',
      rss: pick('VmRSS'),
      peak: pick('VmHWM'),
    })
  }
  return rows
}

/** macOS。peak 恒为 null：不是没写，是系统没有这个数。 */
function tableMac() {
  const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
  const rows = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: (m[4].split('/').pop() || m[4]).slice(0, 64),
      rss: Number(m[3]) * 1024,   // ps 的 rss 是 KB
      peak: null,
    })
  }
  return rows
}

/** 本机上「峰值」是免费获得还是需要自行采集，调用方靠它决定要不要开采样。 */
function peakIsFree(platform) {
  const p = platform || process.platform
  return p === 'win32' || p === 'linux'
}

/** 拿全机器进程表。拿不到就返回空数组：不抛，量不到不该拖垮启动。 */
function processTable(opts = {}) {
  const platform = opts.platform || process.platform
  try {
    if (platform === 'win32') return tableWindows()
    if (platform === 'darwin') return tableMac()
    return tableLinux()
  } catch {
    return []
  }
}

// 从 rootPid 往下收整棵树。这注定是估计，两个方向都可能错：多算是 Windows 上父进程死后子进程的
// ParentProcessId 不清空，那个 PID 被复用给别人时会把不相干的进程收进来；漏算是中间隔了一层执行完
// 即退的壳，链从中间断掉。只需要别低估：多算 ⇒ 误拒一次启动；漏算 ⇒ 机器 OOM。所以余量只往上加。
function collectTree(rows, rootPid) {
  const byPid = new Map()
  const kids = new Map()
  for (const r of rows) {
    byPid.set(r.pid, r)
    if (r.ppid == null) continue
    if (!kids.has(r.ppid)) kids.set(r.ppid, [])
    kids.get(r.ppid).push(r.pid)
  }
  const seen = new Set()
  const out = []
  const stack = [rootPid]
  while (stack.length && out.length < MAX_TREE) {
    const pid = stack.pop()
    // 防环：进程表是边读边变的，理论上能读出自相矛盾的父子关系。
    if (seen.has(pid)) continue
    seen.add(pid)
    const r = byPid.get(pid)
    if (r) out.push(r)
    for (const k of (kids.get(pid) || [])) stack.push(k)
  }
  return out
}

const toMb = (bytes) => Math.ceil(bytes / (1024 * 1024))

/** 量一棵树，返回 MB。单位一律 MB 存：用 GB 存会把 1.5G 舍成 1 或 2，一个变量差一倍。 */
function sampleTree(rootPid, opts = {}) {
  const platform = opts.platform || process.platform
  const rows = opts.rows || processTable({ platform })
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { ok: false, rootPid, count: 0, rssMb: 0, peakMb: null,
      peakIsFree: peakIsFree(platform), reason: '没给根 PID' }
  }
  if (!rows.length) {
    return { ok: false, rootPid, count: 0, rssMb: 0, peakMb: null,
      peakIsFree: peakIsFree(platform), reason: '拿不到本机的进程表' }
  }
  const tree = collectTree(rows, rootPid)
  if (!tree.length) {
    // 进程已经没了。这时绝不能记 0：记 0 等于告诉后面「这台引擎不吃内存」。
    return { ok: false, rootPid, count: 0, rssMb: 0, peakMb: null,
      peakIsFree: peakIsFree(platform), reason: '这个 PID 已经不在了，这次不记账' }
  }
  let rss = 0
  let peak = 0
  let peakMissing = false
  for (const n of tree) {
    rss += n.rss || 0
    if (n.peak == null) peakMissing = true
    else peak += n.peak
  }
  return {
    ok: true,
    rootPid,
    count: tree.length,
    rssMb: toMb(rss),
    // 各进程的峰值相加，等于假设它们同时到顶：不成立，所以这是个高估。高估在安全那边，但也不许
    // 拿去跟「当前用量」做等价比较。
    // 系统给不出峰值时（macOS）退回当前用量，绝不返回 null/0：返回 null 等于假装什么都没测到，
    // 退回当前值是低估，由 peakExact=false 告诉调用方去补采样。
    peakMb: toMb(Math.max(peak, rss)),
    /** true = 这是操作系统记的真峰值；false = 只是这一刻的当前值，得靠多采几次凑。 */
    peakExact: !peakMissing,
    peakIsFree: peakIsFree(platform),
    reason: '',
  }
}

/** 本机现在还剩多少 MB。这个数天然已经把别人占用的算进去了。 */
function freeMb() {
  return Math.floor(os.freemem() / (1024 * 1024))
}

// 本机一共多少 MB。与 freeMb 成对：freeMb 回答「现在还剩多少」（已把别人吃掉的算进去），totalMb
// 回答「一共多少」，两者相减 = 已被别人吃掉的量。
// cap 用 totalMb 而不是 freeMb：cap 问的是「本机能容纳几台引擎」，取决于机器有多大；用 freeMb 算，
// 别人开个浏览器就把 cap 改了。
function totalMb() {
  return Math.floor(os.totalmem() / (1024 * 1024))
}

/** 加余量。只往上加，不往下抹。 */
function withHeadroom(mb, headroom) {
  const h = Number.isFinite(headroom) && headroom >= 1 ? headroom : HEADROOM
  return Number.isFinite(mb) && mb > 0 ? Math.ceil(mb * h) : mb
}

module.exports = {
  HEADROOM,
  MAX_TREE,
  processTable,
  collectTree,
  sampleTree,
  peakIsFree,
  freeMb,
  totalMb,
  withHeadroom,
}
