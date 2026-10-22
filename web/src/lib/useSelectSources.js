import { useEffect, useState, useMemo } from 'react'
import { api } from './api'
import { voiceOptions, weightOptions, audioOptions } from './selectSources.pure'

// `select + source` 的候选表，只管取数。
// 挑选、去重、fail-open 全在 selectSources.pure.js，那边有判据；这一层不加规则。

// 一个音色的参考音频（切片 + 原始）。走 RefAudioList 用的同两个口，不另开 API。
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

// 一张「库名 → 候选项」的表，喂给 optionsForField(field, sources)。
export function useSelectSources({ voices, knownModelPaths, audioVoiceId }) {
  const audio = useAudioOptions(audioVoiceId)
  const vs = useMemo(() => voiceOptions(voices), [voices])
  const ws = useMemo(() => weightOptions(knownModelPaths), [knownModelPaths])
  return useMemo(() => ({ voices: vs, weights: ws, audio }), [vs, ws, audio])
}
