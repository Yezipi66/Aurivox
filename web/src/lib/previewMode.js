import { useState, useEffect } from 'react'

// Global, persisted audio-preview mode shared by every result Player across the app.
//
// Why a bespoke store instead of usePersistentState: the toggle lives in the always-on
// status bar (ContextRow) while the players live on other pages/subtrees. A plain
// localStorage hook keeps per-instance state, so a toggle wouldn't re-render the
// players. This store keeps ONE in-memory value + a listener set, so flipping the mode
// updates every mounted player instantly (and persists + syncs across tabs).
//
//   'bar'      — compact seek bar (default; zero decode cost, zero regression)
//   'waveform' — decoded waveform with segment-boundary dividers

const KEY = 'tf.v1.ui.previewMode'

function read() {
  try { return localStorage.getItem(KEY) === 'waveform' ? 'waveform' : 'bar' } catch { return 'bar' }
}

let current = read()
const listeners = new Set()

export function getPreviewMode() { return current }

export function setPreviewMode(mode) {
  const m = mode === 'waveform' ? 'waveform' : 'bar'
  if (m === current) return
  current = m
  try { localStorage.setItem(KEY, m) } catch {}
  listeners.forEach(fn => fn(m))
}

export function usePreviewMode() {
  const [mode, setMode] = useState(current)
  useEffect(() => {
    const fn = (m) => setMode(m)
    listeners.add(fn)
    const onStorage = (e) => { if (e.key === KEY) { current = read(); setMode(current) } }
    window.addEventListener('storage', onStorage)
    // Re-sync in case the value changed between initial render and mount.
    if (current !== mode) setMode(current)
    return () => { listeners.delete(fn); window.removeEventListener('storage', onStorage) }
  }, [])   // eslint-disable-line
  return [mode, setPreviewMode]
}
