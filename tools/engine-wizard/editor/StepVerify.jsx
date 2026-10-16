//  第 5 步（verify）：三项独立验证，各自报状态。
//
//  三项互不依赖，不绑成一个必须全过的门：
//    1. 读音频信息（时长、采样率、声道，由 A 级合成产出的音频而来）
//    2. 波形可视化（复用 Player.jsx，同一份音频）
//    3. ASR 反向识别（可选）
//
//  前两项要有一份真实音频才有内容，所以页面给一个「跑 A 级合成」的入口：
//  A 级要用户填合成文本与参考音频，平台不编请求体（编出来的验不了
//  声音对不对）。没跑过 A 级时前两项如实说「还没有音频」。
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
  const [audioLevel, setAudioLevel] = useState('B')
  const [synthText, setSynthText] = useState('')

  const runChecks = React.useCallback((level, request) => {
    if (!id) return
    setLoading(true)
    const q = new URLSearchParams({ id, audio: level })
    if (request) q.set('request', JSON.stringify(request))
    fetch(`/wizard/verify/checks?${q.toString()}`)
      .then(r => r.json())
      .then(setResults)
      .catch(() => setResults(null))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    runChecks('B', null)
  }, [runChecks])

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
      {/* 前两项要有一份真实音频才有内容。给一个跑 A 级合成的入口：
          A 级要用户填合成文本，平台不编请求体（编出来的验不了声音对不对）。 */}
      <div className="section">
        <div className="section-hdr">
          <h2 style={{ fontSize: 13 }}>
            {t('Synthesise a sample', '合成一段样本')}
          </h2>
        </div>
        <div className="field-hint">
          {t('The audio information and the waveform both need a real sample. '
            + 'Fill in the text to synthesise, then run tier A.',
            '音频信息与波形都需要一份真实样本。填入要合成的文本，然后跑 A 级。')}
        </div>
        <textarea
          value={synthText}
          onChange={(e) => setSynthText(e.target.value)}
          placeholder={t('Text to synthesise', '要合成的文本')}
          rows={3}
          style={{ width: '100%', marginTop: 6 }}
        />
        <button
          className="btn btn-sm btn-primary"
          type="button"
          disabled={loading || !synthText.trim()}
          style={{ marginTop: 6 }}
          onClick={() => runChecks('A', { text: synthText.trim() })}
        >
          {loading ? t('Running...', '正在运行...') : t('Run tier A', '跑 A 级')}
        </button>
      </div>
      {/* 第 1 项：读音频信息。用 stdlib 的 wave 解析 WAV 头，
          拿到时长、采样率、声道数。 */}
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
            {t('No sample yet. Synthesise one above to see the audio information.',
              '还没有样本。在上方合成一段就能看到音频信息。')}
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
            {t('No sample yet. The waveform appears here once one exists.',
              '还没有样本。有样本后这里会显示波形。')}
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
          {t('Not implemented. The platform has ASR models and a working transcription '
            + 'step, but that step takes a directory of training material and a training '
            + 'config. There is no entry point that reads back one arbitrary audio clip, '
            + 'and no manifest field declares an ASR endpoint on the engine. '
            + 'This item is optional and does not block the other two.',
            '尚未实现。平台有 ASR 模型与可用的转写步骤，但那个步骤要的是一段训练素材目录'
            + '加一份训练配置，没有「把任意一段音频读回来」的入口，名片里也没有声明 ASR 端点的字段。'
            + '此项可选，不阻塞其余两项。')}
        </div>
      </div>
    </div>
  )
}
