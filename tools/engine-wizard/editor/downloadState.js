// downloadState.js — 下载状态门面（内部走 useInstallSession）
import { loadSession, saveSession, clearSession } from './useInstallSession.js'

export function loadDownloadState (id, url) {
  if (!id) return null
  const s = loadSession(id, url)
  if (!s) return null
  // 旧会话里这个键叫 probeError。读取时兼容一次，写入统一用 listError。
  const err = s.listError === undefined ? s.probeError : s.listError
  if (s.manifest == null && err == null && s.dedup === true) return null
  return { manifest: s.manifest, listError: err, dedup: s.dedup }
}

export function saveDownloadState (id, url, state) {
  if (!id || !state) return
  saveSession(id, url, {
    manifest: state.manifest === undefined ? undefined : state.manifest,
    listError: state.listError === undefined ? undefined : state.listError,
    dedup: state.dedup === undefined ? undefined : state.dedup,
  })
}

export function clearDownloadState (id, url) {
  if (!id) return
  clearSession(id, url)
}
