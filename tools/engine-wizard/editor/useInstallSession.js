// ============================================================================
//  安装会话：向导持久化的**唯一**实现
//
//  Owner 2026-10-12 裁决「统一重构持久化」，三条约束落在这里：
//    ① 完成状态（对勾）只由真实产物判 ⇒ 从来不写「点过什么」。
//    ② 探测结果 prep 不持久化到 localStorage，但退出网页 / 下一次扫描前
//       必须还在 ⇒ 放 sessionStorage（刷新不丢、关 tab 丢、换 URL 失效）。
//    ③ 克隆完成 = 引擎初步接入，prepare 未完成时后面四步不可点
//       ⇒ 门槛在 steps.js 的 needs + Pipeline 渲染层，不是点进去一片空。
//
//  关键设计：**键里含 id 与 url**。换 URL 或换引擎 ⇒ 旧会话段自动失效。
//    真机踩过的 bug：URL 改了却显示旧仓库的依赖列表（串号）。
//    判据：本地键形如 <前缀>:<id>:<urlHash>：换一个就换一把钥匙，
//    不许只按 id 分键。
//
//  三段各管什么：
//    持久段（localStorage） 用户输入与选择：url / id / cloneUrl / repoUrl
//                           + 当前展开哪一步。不再放探测结果。
//    会话段（sessionStorage）探测结果与各步瞬态：prep（res/probe/plan/cloneRes）
//                           + StepDeps 的 plan/preview/showNormal/backend/unlocked
//                           + 下载的 manifest/dedup/probeError。
//    busy / live / tail 这些真瞬态（执行中）一段都不存。
// ============================================================================

const NS = 'tf.v1.wizard.'
// 孤儿键（Owner 浏览器里有、代码里没人读）：一次性清掉，不留长期清理代码。
const ORPHAN_KEYS = [NS + 'repo']

export { NS }

/** 浏览器 / Node 测试两侧都能拿到的 storage（没有就静默失败，不抛） */
function pick (store) {
  if (typeof window !== 'undefined' && window[store]) return window[store]
  if (typeof global !== 'undefined' && global[store]) return global[store]
  return null
}

const local = () => pick('localStorage')
const session = () => pick('sessionStorage')

/**
 * url 摘要：会话键的第二段。
 *
 * 只用摘要不用原文：sessionStorage 的键虽然能放原文，但带 query/hash 的
 *   长 URL 会让键长得没法看；而且「同一个 id 换了个 URL」这件事本身只需要
 *   一个稳定的区分符。不许回退成「只按 id 分键」那就是串号的来源。
 */
function hashUrl (url) {
  const s = String(url || '')
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** 会话键：含 id 与 url，换任一个旧会话自动失效 */
function sessionKey (id, url) {
  return NS + 'sess:' + String(id || '') + ':' + hashUrl(url)
}

function read (store, key) {
  try {
    const s = pick(store)
    if (!s) return null
    const raw = s.getItem(key)
    if (!raw) return null
    return JSON.parse(raw)
  } catch (e) { return null }
}

function write (store, key, val) {
  try {
    const s = pick(store)
    if (!s) return
    s.setItem(key, JSON.stringify(val))
  } catch (e) { /* 配额满 / 不可用 ⇒ 静默失败，不许让向导崩 */ }
}

function drop (store, key) {
  try {
    const s = pick(store)
    if (!s) return
    s.removeItem(key)
  } catch (e) { /* 同上 */ }
}

/** 孤儿键一次性清理：读一次就删，不留长期清理代码 */
export function purgeOrphanKeys () {
  const s = local()
  if (!s) return
  for (const k of ORPHAN_KEYS) {
    try { if (s.getItem(k) !== null) s.removeItem(k) } catch (e) { /* 读不了就算了 */ }
  }
}

// ---------------------------------------------------------------------------
//  持久段：用户输入与选择（localStorage）
// ---------------------------------------------------------------------------
const PERSIST_KEY = NS + 'wz'

export const PERSIST_SHAPE = { url: '', id: '', cloneUrl: '', repoUrl: '' }

/** 读持久段（带消毒：缺字段补空串，不让半截对象进 state） */
export function loadPersist () {
  const v = read('localStorage', PERSIST_KEY)
  if (!v || typeof v !== 'object') return { ...PERSIST_SHAPE }
  return { ...PERSIST_SHAPE, url: v.url || '', id: v.id || '',
    cloneUrl: v.cloneUrl || '', repoUrl: v.repoUrl || '' }
}

/** 写持久段 */
export function savePersist (patch) {
  if (!patch || typeof patch !== 'object') return
  write('localStorage', PERSIST_KEY, { ...loadPersist(), ...patch })
}

/** 当前展开哪一步：也在持久段里（刷新后还在原步骤） */
export function loadPage () {
  const v = read('localStorage', NS + 'step')
  return typeof v === 'string' ? v : 'prepare'
}

export function savePage (page) {
  write('localStorage', NS + 'step', page || 'prepare')
}

// ---------------------------------------------------------------------------
//  会话段：探测结果与各步瞬态（sessionStorage，键含 id + url）
// ---------------------------------------------------------------------------

/**
 * 读会话段。
 *
 * 换 URL 或换引擎 ⇒ 键就换了 ⇒ 这里返回 null，调用方按「没有缓存」处理。
 *    这就是防串号的那一层：不许在读到 null 时去猜一个旧的键。
 *
 * @param {string} id
 * @param {string} url
 */
export function loadSession (id, url) {
  if (!id) return null
  const v = read('sessionStorage', sessionKey(id, url))
  if (!v || typeof v !== 'object') return null
  return {
    res: v.res || null,
    probe: v.probe || null,
    plan: v.plan || null,
    cloneRes: v.cloneRes || null,
    // ---- 第 2 步 ----
    depsPlan: v.depsPlan || null,
    depsPreview: v.depsPreview || null,
    showNormal: v.showNormal === true,
    backend: v.backend || null,
    unlocked: v.unlocked === true,
    depsResult: v.depsResult || null,
    depsProgress: v.depsProgress || null,
    // ---- 第 3 步 ----
    manifest: v.manifest || null,
    dedup: v.dedup !== false,
    probeError: v.probeError || null,
  }
}

/**
 * 写会话段（局部 patch，不整份覆盖：各组件各自写自己那几个键）。
 *
 * @param {string} id
 * @param {string} url
 * @param {object} patch 只写给出的键；值为 undefined 的键不动
 */
export function saveSession (id, url, patch) {
  if (!id || !patch || typeof patch !== 'object') return
  const key = sessionKey(id, url)
  const cur = read('sessionStorage', key) || {}
  const next = { ...cur }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    next[k] = v
  }
  write('sessionStorage', key, next)
}

/** 清掉这一段会话（换引擎 / 换 URL 时主动丢，不是必须：键一变自然失效） */
export function clearSession (id, url) {
  if (!id) return
  drop('sessionStorage', sessionKey(id, url))
}

/**
 * derive：会话段对哪些「变化」敏感。
 *
 * 返回一个新的键标识；调用方把它放进 useEffect 的依赖里，
 * 这样「换 URL / 换引擎」会立刻重新读会话段，不会读到换号前那一份。
 */
export function sessionStamp (id, url) {
  return String(id || '') + '|' + String(url || '')
}
