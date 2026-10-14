const NS = 'tf.v1.wizard.'
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
 * url 摘要：会话键的第二段。只用摘要不用原文，换一个 url 就换一把键。
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

export function purgeOrphanKeys () {
  const s = local()
  if (!s) return
  for (const k of ORPHAN_KEYS) {
    try { if (s.getItem(k) !== null) s.removeItem(k) } catch (e) { /* 读不了就算了 */ }
  }
}

const PERSIST_KEY = NS + 'wz'

export const PERSIST_SHAPE = { url: '', id: '', cloneUrl: '', repoUrl: '' }

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

/**
 * 读会话段。换 URL 或换引擎 ⇒ 键就换了 ⇒ 这里返回 null。
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

export function clearSession (id, url) {
  if (!id) return
  drop('sessionStorage', sessionKey(id, url))
}

/** derive：调用方放进 useEffect 依赖里，换 URL / 换引擎会重新读会话段。 */
export function sessionStamp (id, url) {
  return String(id || '') + '|' + String(url || '')
}
