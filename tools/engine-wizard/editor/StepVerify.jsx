//  第 5 步（verify）—— 三项独立验证，各自报状态。
//
//  三项互不依赖，不绑成一个必须全过的门：
//    1. ffprobe 读音频信息（时长、采样率、声道）
//    2. 波形可视化（复用 Player.jsx）
//    3. ASR 反向识别（可选）
//
//  每一项有自己的 ok/fail/unknown 状态，任何一项未通过都不影响其余两项。
//  做不到的项如实写未实现并说明卡在哪一项，不用占位注释糊弄。

import React, { useState, useEffect } from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { Player } from '../../../web/src/components/common/Player'

export function StepVerify ({ id }) {
  const { t } = useT()
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!id) { setResults(null); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    fetch(`/wizard/verify/checks?id=${encodeURIComponent(id)}`)
      .then(r => r.json())
      .then(data => { if (!cancelled) { setResults(data); setLoading(false) } })
      .catch(() => { if (!cancelled) { setResults(null); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return <div className="msg msg-info">{t('Running checks...', '正在校验...')}</div>
  }

  if (!results) {
    return <div className="msg msg-info">{t('Checks failed to load.', '校验加载失败。')}</div>
  }

  const checks = results.checks || {}
  const audio = checks.audio

  return (
    <div>
      {/* 第 1 项：ffprobe 读音频信息 */}
      <div className="section">
        <div className="section-hdr">
          <h2 style={{ fontSize: 13 }}>
            {t('Audio information', '音频信息')}
          </h2>
        </div>
        {audio && audio.wav ? (
          <div>
            <div>
              {t('Duration', '时长')}: {audio.wav.duration_sec}s
            </div>
            <div>
              {t('Sample rate', '采样率')}: {audio.wav.sample_rate} Hz
            </div>
            <div>
              {t('Channels', '声道')}: {audio.wav.channels}
            </div>
          </div>
        ) : (
          <div className="field-hint">
            {t('No audio file available. Run Tier A synthesis first.',
              '没有音频文件。请先跑 A 级合成。')}
          </div>
        )}
      </div>

      {/* 第 2 项：波形可视化 */}
      <div className="section">
        <div className="section-hdr">
          <h2 style={{ fontSize: 13 }}>
            {t('Waveform', '波形')}
          </h2>
        </div>
        {audio && audio.audio_path ? (
          <Player src={`/wizard/verify/audio?id=${encodeURIComponent(id)}`} />
        ) : (
          <div className="field-hint">
            {t('No audio file available. Run Tier A synthesis first.',
              '没有音频文件。请先跑 A 级合成。')}
          </div>
        )}
      </div>

      {/* 第 3 项：ASR 反向识别（可选） */}
      <div className="section">
        <div className="section-hdr">
          <h2 style={{ fontSize: 13 }}>
            {t('ASR read-back (optional)', 'ASR 反向识别（可选）')}
          </h2>
        </div>
        <div className="field-hint">
          {t('Not implemented yet. This item is optional and does not block the others.',
            '尚未实现。此项可选，不阻塞其余项。')}
        </div>
      </div>
    </div>
  )
}
