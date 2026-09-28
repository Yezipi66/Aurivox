'use strict'
// ---------------------------------------------------------------------------
//  memprobe —— 「我起的那个进程，连同它的子孙，一共吃了多少内存」
//
//  ⭐⭐⭐ 这一层量的是**进程**，不是引擎。
//    所以它对任何一台 TTS 引擎逐字一样：不需要作者在名片里填任何字段、
//    不需要知道引擎内部长什么样、不需要认识 python 还是 exe。
//    「兼容全部 TTS」这件难事，在内存这一项上根本不是难事。
//
//  ⛔ 这个文件不猜「哪个进程是引擎」。根 PID 是 spawn 当场返回给我们的
//    （supervisor 里 r.proc.pid），我们**记着**它，不去认它。
//    真机实测（2026-08-31）证明猜这条路是死的：
//      19320  4.6MB    venv\Scripts\python.exe        ← 项目 venv 里的壳
//      10260  3547MB   AppData\...\uv\...\python.exe  ← 真身，不在项目目录下
//    同一个脚本、同一组参数、两个不同的解释器，100% 的内存在子进程里。
//    按「exe 在我们 venv 底下」去认，只会认到那个 4.6MB 的壳。
// ---------------------------------------------------------------------------

const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

/** 量出来的数上再乘这么多，用来盖住漏算的子进程和断掉的父子链。 */
const HEADROOM = 1.15

/** 一棵树最多收多少个进程 —— 防止认错爹时把半台机器收进来。 */
const MAX_TREE = 512

// ---------------------------------------------------------------------------
//  三个系统，同一个问题，三种问法。
//
//  ⚠ 「当前用了多少」三家都有；「这辈子最高用过多少」**只有两家有**：
//      Linux    /proc/<pid>/status 的 VmHWM        ✅ 内核一直记着，精确
//      Windows  Win32_Process.PeakWorkingSetSize   ✅ 单位是 KB（实测确认）
//      macOS    ⛔ 没有。ps 只给当前值。
//
//  ⛔ 不许因为 macOS 拿不到峰值，就把三家统统改成定时采样 ——
//    那是拿最差的那个去把另外两个拉平，白白扔掉两个系统上免费且精确的数。
//    macOS 单独退化成采样（由调用方在合成期间多次调用 sampleTree 取 max）。
// ---------------------------------------------------------------------------

/**
 * Windows。
 *
 * ⚠⚠ 同一张表里两个挨着的字段**单位不一样**：
 *      WorkingSetSize      是**字节**
 *      PeakWorkingSetSize  是 **KB**
 *    2026-08-31 真机实测确认（原始值 79944 ⇒ 当 KB 算 78.1MB，与当前值
 *    13.4MB 相容；当字节算 0.1MB，比当前值还小 —— 而峰值不可能小于当前值）。
 *    ⛔ 按印象统一当字节除，峰值会小 1024 倍，而「把 8G 读成 8M」正是
 *      会让机器 OOM 的那个方向。
 */
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

/** macOS。⛔ peak 恒为 null —— 不是没写，是系统没有这个数。 */
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

/** 这台机器上「峰值」是免费拿的还是得自己采。调用方靠它决定要不要开采样。 */
function peakIsFree(platform) {
  const p = platform || process.platform
  return p === 'win32' || p === 'linux'
}

/** 拿全机器进程表。拿不到就返回空数组 —— ⛔ 不抛，量不到不该拖垮启动。 */
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

/**
 * 从 rootPid 往下收整棵树。
 *
 * ⚠ 这**注定是估计，不是精确值**，两个方向都可能错：
 *   多算 —— Windows 上父进程死了之后，子进程的 ParentProcessId 字段不会
 *           清空，那个 PID 被系统复用给别人时，会把不相干的进程收进来。
 *   漏算 —— 中间隔了一层跑完就退的壳（cmd.exe 之类），链从中间断掉。
 *           真机实测见过四层链：server.js → ???? → venv 壳 → uv 真身。
 *
 * ⭐ 不要紧，因为我们不需要算准，只需要**别低估**。多算 ⇒ 判得保守 ⇒
 *   误拒一次启动；漏算 ⇒ 判得乐观 ⇒ 机器 OOM。所以余量只往上加。
 */
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
    // ⚠ 防环：进程表是边读边变的，理论上能读出自相矛盾的父子关系。
    if (seen.has(pid)) continue
    seen.add(pid)
    const r = byPid.get(pid)
    if (r) out.push(r)
    for (const k of (kids.get(pid) || [])) stack.push(k)
  }
  return out
}

const toMb = (bytes) => Math.ceil(bytes / (1024 * 1024))

/**
 * 量一棵树。返回 MB。
 *
 * ⛔ 单位一律 MB 存，GB 只在显示的时候换算。用 GB 存会把 1.5G 舍成 1 或 2
 *   —— 一个变量差一倍，而舍掉的精度找不回来。
 *
 * @returns {{ok:boolean, rootPid:number, count:number, rssMb:number,
 *            peakMb:number|null, peakIsFree:boolean, reason:string}}
 */
function sampleTree(rootPid, opts = {}) {
  const platform = opts.platform || process.platform
  const rows = opts.rows || processTable({ platform })
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { ok: false, rootPid, count: 0, rssMb: 0, peakMb: null,
      peakIsFree: peakIsFree(platform), reason: '没给根 PID' }
  }
  if (!rows.length) {
    return { ok: false, rootPid, count: 0, rssMb: 0, peakMb: null,
      peakIsFree: peakIsFree(platform), reason: '拿不到这台机器的进程表' }
  }
  const tree = collectTree(rows, rootPid)
  if (!tree.length) {
    // ⚠ 进程已经没了。⛔ 这时**绝不能**记 0 —— 记 0 等于告诉后面
    //   「这台引擎不吃内存」，那是最危险的一条记录。宁可这次不记。
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
    // ⚠ 把一棵树里各进程的峰值相加，等于假设它们**同时**到顶 —— 不成立，
    //   所以这是个高估。高估在安全那边，先这么用。
    //   ⛔ 但也因此，这个数不许拿去跟「当前用量」做等价比较。
    //
    // ⛔⛔ 系统给不出峰值时（macOS）**退回当前用量，绝不返回 null/0**。
    //   我第一版写成了「缺峰值就返回 null」—— 那等于在 macOS 上一笔账都
    //   记不下来，每次启动都走「第一次，问用户」，那个框永远不会消失。
    //   ⭐ 退回当前值是低估，但低估的是**已知偏低**，由 peakExact=false
    //     告诉调用方去补采样；返回 null 是假装什么都没量到，那才是真丢。
    peakMb: toMb(Math.max(peak, rss)),
    /** true = 这是操作系统记的真峰值；false = 只是这一刻的当前值，得靠多采几次凑。 */
    peakExact: !peakMissing,
    peakIsFree: peakIsFree(platform),
    reason: '',
  }
}

/** 这台机器现在还剩多少 MB。⭐ 这个数天然已经把别人吃掉的算进去了。 */
function freeMb() {
  return Math.floor(os.freemem() / (1024 * 1024))
}

/**
 * 这台机器一共多少 MB。
 *
 * ⭐ 与 freeMb 成对：freeMb 回答「现在还剩多少」（已经把别人吃掉的算进去），
 *   totalMb 回答「一共多少」。两者相减 = 已经被别人吃掉的量。
 *
 * ⚠⚠ 为什么 cap 要用 totalMb 而不是 freeMb（2026-09-29 Owner 定的）：
 *   cap 问的是「这台机器**养得起几台引擎**」—— 那是个**能力**问题，
 *   答案取决于机器有多大，不取决于此刻谁在占。
 *   用 freeMb 算的话，别人开个浏览器就把 cap 改了 ⇒ 同一台机器每次开机
 *   的 cap 都不一样 ⇒ 「为什么昨天能起 3 台今天只能起 1 台」没人答得上。
 *   ⇒ 能力看 total；「此刻够不够」那一层是 freeMb 的活（needs_confirm）。
 */
function totalMb() {
  return Math.floor(os.totalmem() / (1024 * 1024))
}

/** 加余量。⛔ 只往上加，不往下抹。 */
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
