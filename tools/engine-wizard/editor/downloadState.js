// downloadState.js — 下载状态门面（内部走 useInstallSession）
import { loadSession, saveSession, clearSession } from './useInstallSession.js'

const LIST_KEYS = ['pastedRepos', 'pastedFiles', 'removedCmds', 'removedLinks', 'sourceChoices']
const emptyOf = (key) => (key === 'sourceChoices' ? {} : [])

export function loadDownloadState (id, url) {
  if (!id) return null
  const s = loadSession(id, url)
  if (!s) return null
  // 读取错误是瞬时的，不跨会话保存；旧会话里的 probeError / listError 读完即弃。
  const hasLists = LIST_KEYS.some((k) => {
    const v = s[k]
    return Array.isArray(v) ? v.length > 0 : !!(v && Object.keys(v).length > 0)
  })
  if (s.manifest == null && s.dedup === true && !hasLists) return null
  const out = { manifest: s.manifest, dedup: s.dedup }
  for (const k of LIST_KEYS) out[k] = s[k] === undefined ? emptyOf(k) : s[k]
  return out
}

export function saveDownloadState (id, url, state) {
  if (!id || !state) return
  saveSession(id, url, {
    manifest: state.manifest === undefined ? undefined : state.manifest,
    dedup: state.dedup === undefined ? undefined : state.dedup,
    pastedRepos: state.pastedRepos,
    pastedFiles: state.pastedFiles,
    removedCmds: state.removedCmds,
    removedLinks: state.removedLinks,
    sourceChoices: state.sourceChoices,
  })
}

export function clearDownloadState (id, url) {
  if (!id) return
  clearSession(id, url)
}
