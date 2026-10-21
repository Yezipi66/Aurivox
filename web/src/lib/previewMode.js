import { useState, useEffect } from 'react'

// 全局共享的音频预览模式，所有结果播放器共用一个值。
// 自己存一份而不复用 usePersistentState：开关在常驻状态条上，播放器在别的页面，
// localStorage hook 是按实例存状态的，改了开关不会让已挂载的播放器重绘。
// 这里只存一份内存值加一组监听者，改模式时所有已挂载播放器立刻跟着变，并跨标签页同步。
//   'bar'      紧凑进度条（默认，不解码，无回归）
//   'waveform' 解码后的波形，带分段边界

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
    // 挂载时重新对一次：初次渲染与挂载之间值可能已经变了。
    if (current !== mode) setMode(current)
    return () => { listeners.delete(fn); window.removeEventListener('storage', onStorage) }
  }, [])   // eslint-disable-line
  return [mode, setPreviewMode]
}
