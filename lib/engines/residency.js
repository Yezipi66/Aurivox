'use strict'

// 引擎常驻策略：开机预热、按需启动、空闲释放、启动前内存检查。纯计算，不认识具体引擎。
// 判据是模型位的 applies_at（契约 §5.8）：有 launch 位的引擎进程即占内存，按需启动、
// 空闲释放；只有 call 位的可预热、不释放。上限与时长由 supervisor.js 从环境变量读入。

// 内存数据完全不可用时的台数上限。只是护栏，不判断内存是否够用。
const DEFAULT_CAP = 2

const MB_PER_ENGINE = 8 * 1024
const MIN_AUTO_CAP = 1

/**
 * 按总内存每 8G 一台算上限，至少 1。用户显式设定优先，量不到时用 DEFAULT_CAP。
 * 用 totalMb 而非 freeMb，使上限不随其他程序的占用波动。
 */
function autoCapFor(totalMb) {
  if (!Number.isFinite(totalMb) || totalMb <= 0) return DEFAULT_CAP
  return Math.max(MIN_AUTO_CAP, Math.floor(totalMb / MB_PER_ENGINE))
}

// 进程树统计可能漏掉断链的子进程，内存需求乘此余量。
const DEFAULT_HEADROOM = 1.15

const DEFAULT_IDLE_MS = 10 * 60 * 1000

// applies_at 缺省按 launch：误判为 call 会静默失效，误判为 launch 只多重启一次。
function launchSlots(profile) {
  const slots = (profile && profile.weight_slots) || []
  return slots.filter((s) => s && s.applies_at !== 'call')
}

function callSlots(profile) {
  const slots = (profile && profile.weight_slots) || []
  return slots.filter((s) => s && s.applies_at === 'call')
}

function isOnDemand(profile) {
  return launchSlots(profile).length > 0
}

// 名片 runtime.preload 只能关闭预热，不能强制开启：现有名片多照模板写了 true。
function shouldPreload(profile) {
  if (!profile || !profile.runtime) return false
  if (profile.runtime.preload === false) return false
  return !isOnDemand(profile)
}

// 本次 launch 位选择的比较键。'' 表示没有 launch 位；有位未选时返回含空值的键。
function launchKeyOf(profile, selection) {
  const slots = launchSlots(profile)
  if (slots.length === 0) return ''
  const sel = selection || {}
  return slots.map((s) => s.name).sort().map((name) => {
    const v = sel[name]
    return `${name}=${v == null || v === '' ? '' : String(v)}`
  }).join('\u0000')
}

function stablePairs(value) {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.keys(obj).sort().map((name) => [name, obj[name]])
}

function startupKeyOf(profile, selection, loadParams) {
  const weights = launchKeyOf(profile, selection)
  const load = stablePairs(loadParams)
  if (!weights && load.length === 0) return ''
  return JSON.stringify({ weights, load })
}

// launch 位通过重定向唯一的底模目录生效，第二个位无处可送，因此超出即拒绝。
const MAX_LAUNCH_SLOTS = 1

/**
 * 决定本次请求复用、启动、重启、拒绝（busy）还是请用户确认，以及先关闭哪些引擎。
 * 纯函数，now 由调用方传入。
 * @param state { residents:[{id,key,busy,lastUsedAt,onDemand,rssMb}], id, key, cap, idleMs,
 *   now, freeMb, needMb, headroom, confirmed }
 *   needMb 是历史峰值：null 表示从未测量，0 表示不占内存，两者不可混同。
 * @returns {{ action:'reuse'|'start'|'relaunch'|'busy'|'needs_confirm', evict:string[], reason:string, mem?:object }}
 */
function planAdmission(state) {
  const residents = Array.isArray(state.residents) ? state.residents.slice() : []
  const cap = Number.isInteger(state.cap) && state.cap > 0 ? state.cap : DEFAULT_CAP
  const idleMs = Number.isInteger(state.idleMs) && state.idleMs > 0 ? state.idleMs : DEFAULT_IDLE_MS
  const now = Number.isFinite(state.now) ? state.now : 0
  const id = state.id
  const key = state.key == null ? '' : String(state.key)

  const me = residents.find((r) => r && r.id === id)

  // 重启会截断进行中的合成，因此拒绝，且不为失败的请求驱逐其他引擎。
  if (me && me.busy && me.key !== key) {
    return {
      action: 'busy',
      evict: [],
      reason: '这台引擎正在执行另一次合成，而这一次要的是另一份「进程启动时载入」的模型，切换它需要重启进程，会截断正在执行的那次合成',
    }
  }

  // 空闲超时的按需档引擎无论是否超限都释放；跳过目标自身和忙碌的引擎。
  const expired = residents
    .filter((r) => r && r.id !== id && r.onDemand && !r.busy &&
      Number.isFinite(r.lastUsedAt) && (now - r.lastUsedAt) >= idleMs)
    .map((r) => r.id)

  const evict = expired.slice()
  const survivors = residents.filter((r) => r && !evict.includes(r.id))

  let action
  let reason
  if (me && me.key === key) {
    action = 'reuse'
    reason = '这台引擎已在运行，而且加载的就是这一份模型'
  } else if (me) {
    action = 'relaunch'
    reason = '这台引擎在运行，但加载的不是这一份模型：它的模型在进程启动时载入，需要带着新的模型重启一次'
  } else {
    action = 'start'
    reason = '这台引擎尚未启动'
  }

  // 台数上限只在占用未知时生效；占用已知时由内存判据核对。relaunch 先关后开，不参与。
  if (action === 'start') {
    const needKnown = Number.isFinite(state.needMb) && state.needMb >= 0
    if (!needKnown) {
      const candidates = survivors
        .filter((r) => !r.busy)
        .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0))
      let count = survivors.length + 1
      for (const c of candidates) {
        if (count <= cap) break
        evict.push(c.id)
        count -= 1
      }
    }
  }

  // 内存判据：可用内存加待关闭引擎的当前占用，与峰值乘余量比较。
  if (action === 'start') {
    const headroom = Number.isFinite(state.headroom) && state.headroom >= 1
      ? state.headroom : DEFAULT_HEADROOM
    const free = Number.isFinite(state.freeMb) ? state.freeMb : null
    // 必须是 >= 0：0 表示不占内存，不能落入 null（未知）一支。
    const need = Number.isFinite(state.needMb) && state.needMb >= 0 ? state.needMb : null

    const freed = evict.reduce((sum, eid) => {
      const r = residents.find((x) => x && x.id === eid)
      return sum + (r && Number.isFinite(r.rssMb) && r.rssMb > 0 ? r.rssMb : 0)
    }, 0)

    if (free != null) {
      const budget = free + freed
      if (need == null) {
        // 不估算未测量的需求，请用户确认一次；确认前只释放已超时的引擎。
        if (!state.confirmed) {
          return {
            action: 'needs_confirm',
            evict: expired.slice(),
            reason: '这是第一次启动这台引擎，平台还不知道它要占用多少内存',
            mem: { freeMb: free, needMb: null, budgetMb: budget, headroom },
          }
        }
      } else {
        const want = Math.ceil(need * headroom)
        if (want > budget && !state.confirmed) {
          return {
            action: 'needs_confirm',
            evict: expired.slice(),
            reason: '系统内存可能不足：这台引擎历史上最多占用过 ' + need +
              ' MB（加余量后为 ' + want + ' MB），当前可用 ' + budget + ' MB',
            mem: { freeMb: free, needMb: need, wantMb: want, budgetMb: budget, headroom },
          }
        }
      }
    }
  }

  return { action, evict, reason }
}

// 定时清扫空闲超时的按需档引擎。规则同 planAdmission，但无需保护目标引擎。
function planSweep(residents, opts = {}) {
  const idleMs = Number.isInteger(opts.idleMs) && opts.idleMs > 0 ? opts.idleMs : DEFAULT_IDLE_MS
  const now = Number.isFinite(opts.now) ? opts.now : 0
  return (residents || [])
    .filter((r) => r && r.onDemand && !r.busy &&
      Number.isFinite(r.lastUsedAt) && (now - r.lastUsedAt) >= idleMs)
    .map((r) => r.id)
}

module.exports = {
  autoCapFor,
  MB_PER_ENGINE,
  DEFAULT_CAP,
  DEFAULT_HEADROOM,
  DEFAULT_IDLE_MS,
  MAX_LAUNCH_SLOTS,
  launchSlots,
  callSlots,
  isOnDemand,
  shouldPreload,
  launchKeyOf, startupKeyOf,
  planAdmission,
  planSweep,
}
