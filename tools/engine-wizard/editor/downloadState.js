// downloadState.js — 下载状态门面（内部走 useInstallSession）
import { loadSession, saveSession, clearSession } from './useInstallSession.js'

export function loadDownloadState (id, url) {
  if (!id) return null
  const s = loadSession(id, url)
  if (!s) return null
  if (s.manifest == null && s.probeError == null && s.dedup === true) return null
  return { manifest: s.manifest, probeError: s.probeError, dedup: s.dedup }
}

export function saveDownloadState (id, url, state) {
  if (!id || !state) return
  saveSession(id, url, {
    manifest: state.manifest === undefined ? undefined : state.manifest,
    probeError: state.probeError === undefined ? undefined : state.probeError,
    dedup: state.dedup === undefined ? undefined : state.dedup,
  })
}

export function clearDownloadState (id, url) {
  if (!id) return
  clearSession(id, url)
}
