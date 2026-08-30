import { useEffect, useState, useMemo } from 'react'
import { api } from './api'
import { voiceOptions, weightOptions, audioOptions } from './selectSources.pure'

// ---------------------------------------------------------------------------
//  `select` + `source` 的候选表 —— 带 React 的那一半（只管取数）
// ---------------------------------------------------------------------------
//
// ⭐ 会出错的逻辑（挑、去重、fail-open）全在 selectSources.pure.js，那边有判据。
//    这个文件只剩「什么时候去取、取回来放哪」，⛔ 不要往这里加规则。

/**
 * 一个音色的参考音频（切片 + 原始）。
 *
 * ⚠ 走的是 RefAudioList 用的**同两个口**，⛔ 没有新开 API：多一个口就多一处
 *   会跟资产库漂开的地方。
 */
export function useAudioOptions(voiceId) {
  const [items, setItems] = useState([])

  useEffect(() => {
    let alive = true
    if (!voiceId) { setItems([]); return }
    Promise.all([
      api(`/api/assets/${voiceId}/segments`)
        .then(r => (r.ok && r.data.segments ? (r.data.segments.segments || []) : []))
        .catch(() => []),
      api(`/api/assets/${voiceId}/raw-list`)
        .then(r => (r.ok && r.data.raw ? r.data.raw : []))
        .catch(() => []),
    ]).then(([segs, raws]) => {
      if (alive) setItems(audioOptions(segs, raws))
    })
    return () => { alive = false }
  }, [voiceId])

  return items
}

/**
 * 一张「库名 → 候选项」的表，直接喂给 `optionsForField(field, sources)`。
 */
export function useSelectSources({ voices, knownModelPaths, audioVoiceId }) {
  const audio = useAudioOptions(audioVoiceId)
  const vs = useMemo(() => voiceOptions(voices), [voices])
  const ws = useMemo(() => weightOptions(knownModelPaths), [knownModelPaths])
  return useMemo(() => ({ voices: vs, weights: ws, audio }), [vs, ws, audio])
}
