'use strict'

// ============================================================================
//  occupancy.js —— 「平台此刻占了你的什么」
//
//  ⭐ Owner 2026-09-29：「一个应用不能太霸道」。
//     霸道的两种形态，这一刀治第二种：
//       1. 占得多            —— B3 治了（cap 不再擅自关引擎）
//       2. **占得多还不说**  —— 这一刀
//     第一种是「做了你不喜欢的事」，第二种是「做了你不知道的事」。
//     后者更坏：用户没法判断要不要关掉它。
//
// ── 为什么报的是「历史峰值」而不是「此刻占用」【Owner 2026-09-29 纠正】──
//
//  我最初提议「实时读进程树」，Owner 指出那是错的，理由成立：
//
//    ⭐ **峰值就是 OOM 风险本身。**
//      memledger.js 写得很清楚：「**只涨不落**：账本存的是「最多吃过多少」，
//      不是「上次吃了多少」。按上次的记，跑一次短文本就会把上次长文本的
//      教训抹掉 ⇒ 下次长文本 OOM。」
//
//    ⭐⭐ 尤其在 Linux 上，实时读数是**最危险**的读法：
//      OOM killer 直接杀进程 —— 被杀的进程正在崩溃，此刻读到的数字
//      既不是它的常态也不是它的峰值。而峰值是它**活着时达到的真实高度**。
//      代码里连这个都想到了（markAttempting：「被 OOM 打死的进程来不及
//      让我们读峰值 ⇒ 下次还会用同样的无知去赌同一把」）。
//
//  ⇒ 所以：报峰值，如实标明是峰值。⛔ 不许标成「当前占用」——
//    那是一个我们**测不出来**的数，标错了比不报更坏。
//
// ── 这一层是纯计算 ────────────────────────────────────────────────────────
//  ⛔ 不 spawn、不读时钟、不写盘。所有读数由调用方注入，
//     与 envCheck.js / residency.js 同一个纪律（单测要能在没有真进程的机器上跑）。

/** 单台引擎的占用读数。 */
/**
 * attempting 里有没有这个引擎 id。⛔ 两种形状都认，理由见调用处。
 * @param {string[]|object|null} attempting
 */
function attemptingHas(attempting, id) {
  if (!attempting) return false
  if (Array.isArray(attempting)) return attempting.includes(id)
  if (typeof attempting === 'object') return Object.prototype.hasOwnProperty.call(attempting, id)
  return false
}

function engineOccupancy(profile, opts = {}) {
  const id = profile && profile.id
  const resident = !!(opts.resident)

  // ⭐ 三态，⛔ 不许糊成两态：
  //   number  这台引擎**历史上最多**吃过多少（memledger 只涨不落）
  //   null    **从来没量到过** —— 不是 0（0 = 声称它不吃内存，最危险的说法）
  //
  // ⚠ 问的是 needMbOf(id) 而不是「读整本账」：注入进来的 ledger 是一薄层闭包
  //   （server.js 只给了 needMb/record/markAttempting/reapAttempts），
  //   它不返回整本账。memledger.needMb 在没量过时返回 SEED_MB = null ——
  //   语义正好就是「从来没量过」，两者天然一致。
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
    // 曾经「正在试」但没写完 ⇒ 上次没活着回来（memledger.markAttempting）
    //
    // ⚠⚠ attempting 有**两种形状**，两种都必须认：
    //     ['a','b']（id 数组，来自 ledger.attemptingIds()）
    //     {a:{...}}  （账本原样）
    //   写成 `opts.attempting[id]` 时数组下标取到 undefined ⇒ 永远是 false
    //   ⇒ **OOM 预警永远不出现**，而且不报任何错。
    //   ⭐ 那是这个项目最贵的一类失败：现场证据在，闸门不响。
    last_attempt_unfinished: attemptingHas(opts.attempting, id),
  }
}

/**
 * 整台机器的占用总览。
 *
 * @param {object}   opts
 * @param {object[]} opts.profiles    这一台机器上**所有**已装的引擎
 * @param {object}   opts.status      supervisor.status() 的产物（谁在跑）
 * @param {object}   opts.ledger      memledger 的账本
 * @param {object}   opts.attempting  账本里的 attempting 段
 * @param {object}   opts.mem         { freeMb, totalMb }
 * @param {number}   opts.cap         当前生效的 cap
 * @param {string}   opts.capSource   'env' | 'auto' | 'default' | 'user'
 */
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
      // ⭐ 三个数都是「常驻」这一件事的三个切面，别混：
      //   running_count  现在开着几台
      //   known_peak_mb  这几台**合计**的历史峰值（⚠ 含未在跑但量过的，见下）
      //   unknown_count  有几台**从来没量过** —— 这些才是风险最高的
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
    // ⭐ 一句人话。⛔ 数字都在上面，这句只是把「该不该担心」说清楚。
    headline: headline({ engines, running, unknown, freeMb, totalMb, residentPeakMb: running.reduce(
      (s, e) => s + (e.measured ? e.peak_mb : 0), 0) }),
  }
}

function safeCall(fn) {
  try { const v = fn(); return Number.isFinite(v) ? v : null } catch (_) { return null }
}

/**
 * 一句话总结。⭐ 分三档，因为「知不知道」比「多不多」更要紧：
 *   没量过任何一台  ⇒ 最危险的状态，要说清楚
 *   有没量过的 + 常驻 ⇒ 混合，说清楚哪几台没数
 *   全量过            ⇒ 才报总数
 */
function headline({ engines, running, unknown, freeMb, totalMb, residentPeakMb }) {
  if (!engines.length) return '这台机器上还没有装任何引擎。'
  if (!running.length) return `装了 ${engines.length} 台引擎，现在一台都没在跑（用到才起）。`

  const parts = [`${running.length} 台在跑`]
  if (residentPeakMb > 0) parts.push(`历史峰值合计约 ${fmtMb(residentPeakMb)}`)
  if (freeMb != null && totalMb != null) {
    parts.push(`系统剩余 ${fmtMb(freeMb)} / 共 ${fmtMb(totalMb)}`)
  }
  let s = parts.join('，') + '。'
  if (unknown.length) {
    const names = unknown.map((e) => e.id).join(' / ')
    s += `⚠ ${names} 从来没量过占用（第一次起会问你一次）`
    const unfinished = unknown.filter((e) => e.last_attempt_unfinished)
    if (unfinished.length) {
      s += `；其中 ${unfinished.map((e) => e.id).join(' / ')} **上次没活着回来**`
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
