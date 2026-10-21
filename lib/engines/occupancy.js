'use strict'

// 「平台此刻占了你的什么」。
// 报的是历史峰值而不是此刻占用：峰值就是 OOM 风险本身。实时读进程树是错的，
// 尤其在 Linux 上 OOM killer 直接杀进程，被杀的进程正在崩溃，此刻读到的数字
// 既不是它的常态也不是它的峰值。⇒ 报峰值，如实标明是峰值。不许标成「当前
// 占用」，那是一个测不出来的数，标错了比不报更坏。
//
// 这一层是纯计算：不 spawn、不读时钟、不写盘，所有读数由调用方注入。

// attempting 里有没有这个引擎 id。两种形状都认，理由见调用处。
function attemptingHas(attempting, id) {
  if (!attempting) return false
  if (Array.isArray(attempting)) return attempting.includes(id)
  if (typeof attempting === 'object') return Object.prototype.hasOwnProperty.call(attempting, id)
  return false
}

function engineOccupancy(profile, opts = {}) {
  const id = profile && profile.id
  const resident = !!(opts.resident)

  // 三态，不许糊成两态：
  //   number 这台引擎历史上最多吃过多少（账本只涨不落）
  //   null 从未测量过：不是 0（0 = 声称它不消耗内存，最危险的说法）
  // 问的是 needMbOf(id) 而不是「读整本账」：注入进来的 ledger 是一薄层闭包，
  // 它不返回整本账。未测量时返回 null，语义正好就是「从未测量过」。
  let peak = null
  if (typeof opts.needMbOf === 'function') {
    try {
      const v = opts.needMbOf(id)
      if (Number.isFinite(v) && v > 0) peak = v
    } catch (_) { peak = null }
  }

  return {
    id,
    label: (profile && profile.label) || id,
    running: resident,
    peak_mb: peak,
    measured: peak !== null,
    // 「正在试」但未写完 ⇒ 上次未正常退出。
    // attempting 有两种形状，两种都必须认：['a','b']（id 数组，来自
    // ledger.attemptingIds()）与 {a:{...}}（账本原样）。写成
    // `opts.attempting[id]` 时数组下标取到 undefined ⇒ 永远是 false
    // ⇒ OOM 预警永远不出现，而且不报任何错。
    last_attempt_unfinished: attemptingHas(opts.attempting, id),
  }
}

// 整台机器的占用总览。opts 见调用方：profiles / status / ledger / attempting /
// mem / cap / capSource。
function occupancyReport(opts = {}) {
  const profiles = opts.profiles || []
  const status = opts.status || {}
  const engines = profiles.map((p) =>
    engineOccupancy(p, {
      ledger: opts.ledger,
      attempting: opts.attempting,
      resident: !!(status[p.id] && status[p.id].running),
      needMbOf: opts.needMbOf,
      attempting: opts.attempting,
    }))

  const running = engines.filter((e) => e.running)
  const known = engines.filter((e) => e.measured)
  const unknown = engines.filter((e) => !e.measured)
  const totalKnownPeakMb = known.reduce((s, e) => s + e.peak_mb, 0)

  const mem = opts.mem || {}
  const freeMb = typeof mem.freeMb === 'function' ? safeCall(mem.freeMb) : null
  const totalMb = typeof mem.totalMb === 'function' ? safeCall(mem.totalMb) : null

  return {
    engines,
    summary: {
      installed: engines.length,
      running: running.length,
      // 三个数都是「常驻」这一件事的三个切面，别混：running_count 是现在开着
      // 几台；resident_peak_mb 是这几台合计的历史峰值（含未运行但测量过的）；
      // unknown_count 是有几台从未测量过，这些才是风险最高的。
      running_count: running.length,
      resident_peak_mb: running.reduce(
        (s, e) => s + (e.measured ? e.peak_mb : 0), 0),
      all_known_peak_mb: totalKnownPeakMb,
      unknown_count: unknown.length,
      free_mb: freeMb,
      total_mb: totalMb,
      // 已被别人吃掉的量。cap 用 total 而不用 free 就是因为这个数在动。
      used_by_others_mb: (freeMb != null && totalMb != null) ? totalMb - freeMb : null,
      cap: Number.isFinite(opts.cap) ? opts.cap : null,
      cap_source: opts.capSource || null,
    },
    // 一句人话。数字都在上面，这句只是把「该不该担心」说清楚。
    headline: headline({ engines, running, unknown, freeMb, totalMb, residentPeakMb: running.reduce(
      (s, e) => s + (e.measured ? e.peak_mb : 0), 0) }),
  }
}

function safeCall(fn) {
  try { const v = fn(); return Number.isFinite(v) ? v : null } catch (_) { return null }
}

// 一句话总结。分三档，因为「知不知道」比「多不多」更要紧：
//   未测量任何一台  ⇒ 最危险的状态，要说清楚
//   有未测量的 + 常驻 ⇒ 混合，说清楚哪几台没有数据
//   全量过            ⇒ 才报总数
function headline({ engines, running, unknown, freeMb, totalMb, residentPeakMb }) {
  if (!engines.length) return '本机尚未安装任何引擎。'
  if (!running.length) return `装了 ${engines.length} 台引擎，当前一台都未运行（按需启动）。`

  const parts = [`${running.length} 台运行中`]
  if (residentPeakMb > 0) parts.push(`历史峰值合计约 ${fmtMb(residentPeakMb)}`)
  if (freeMb != null && totalMb != null) {
    parts.push(`系统剩余 ${fmtMb(freeMb)} / 共 ${fmtMb(totalMb)}`)
  }
  let s = parts.join('，') + '。'
  if (unknown.length) {
    const names = unknown.map((e) => e.id).join(' / ')
    s += `⚠ ${names} 从未测量过占用（第一次启动时会询问一次）`
    const unfinished = unknown.filter((e) => e.last_attempt_unfinished)
    if (unfinished.length) {
      s += `；其中 ${unfinished.map((e) => e.id).join(' / ')} **上次未正常退出**`
    }
  }
  return s
}

function fmtMb(mb) {
  if (!Number.isFinite(mb) || mb < 0) return '?'
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

module.exports = { occupancyReport, engineOccupancy, headline, fmtMb, attemptingHas }
