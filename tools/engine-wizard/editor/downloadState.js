// downloadState.js — localStorage 读写工具
// 用于持久化第 3 步的下载状态（manifest、probeError、dedup）
//
// ⭐ 设计原则：
//   - 不同引擎状态隔离（用 id 作为 key）
//   - localStorage 不可用时静默失败
//   - 只保存需要持久化的状态（manifest、probeError、dedup）
//   - 不保存临时状态（dlLive、dlTail、dlBusy、fileList）

const STORAGE_KEY_PREFIX = 'wizard:download:'

function getStorage () {
  // 浏览器环境
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  // Node 环境（测试）
  if (typeof global !== 'undefined' && global.localStorage) return global.localStorage
  return null
}

function getKey (id) {
  return STORAGE_KEY_PREFIX + id
}

/**
 * 从 localStorage 读取下载状态
 * @param {string} id - 引擎 ID
 * @returns {Object|null} - 保存的状态，如果没有则返回 null
 */
export function loadDownloadState (id) {
  if (!id) return null
  try {
    const storage = getStorage()
    if (!storage) return null
    const key = getKey(id)
    const raw = storage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

/**
 * 保存下载状态到 localStorage
 * @param {string} id - 引擎 ID
 * @param {Object} state - 要保存的状态（manifest、probeError、dedup）
 */
export function saveDownloadState (id, state) {
  if (!id) return
  try {
    const storage = getStorage()
    if (!storage) return
    const key = getKey(id)
    const raw = JSON.stringify(state)
    storage.setItem(key, raw)
  } catch (e) {
    // localStorage 不可用时静默失败
  }
}

/**
 * 清除下载状态
 * @param {string} id - 引擎 ID
 */
export function clearDownloadState (id) {
  if (!id) return
  try {
    const storage = getStorage()
    if (!storage) return
    const key = getKey(id)
    storage.removeItem(key)
  } catch (e) {
    // localStorage 不可用时静默失败
  }
}
