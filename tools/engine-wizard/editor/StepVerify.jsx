//  第 5 步（verify）：渲染平台四道校验的结果，互不依赖，不绑成一个必须全过的门。
//  每项各自报 ok / fail / unknown，缺素材时如实说还没有，不用占位文案糊弄。

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
    return <div className="msg msg-danger">{t('Checks failed to load.', '校验加载失败。')}</div>
  }

  const checks = results.checks || {}

  const labelFor = {
    env_shallow: t('Environment: installed', '环境：已装'),
    env_deep: t('Environment: startable', '环境：可启动'),
    checkpoints: t('Weights: complete', '权重：完整'),
    audio: t('Audio: playable', '音频：可播放'),
  }

  const statusFor = (check) => {
    if (check === undefined || check === null) return 'unknown'
    return check.ok === true ? 'ok' : 'fail'
  }

  const renderProblem = (p) => {
    if (typeof p === 'string') return p
    if (p && typeof p.message === 'string') return p.message
    if (p && typeof p.error === 'string') return p.error
    return t('Unknown problem', '未知问题')
  }

  const renderCheckBlock = (key) => {
    const check = checks[key]
    const status = statusFor(check)
    const problems = Array.isArray(check && check.problems) ? check.problems : []
    const hasProblem = problems.length > 0

    const badge = status === 'ok' ? t('Done', '已完成') : status === 'fail' ? t('Failed', '失败') : t('Unknown', '未知')

    return (
      <div className="section" key={key}>
        <div className="section-hdr">
          <h2 style={{ fontSize: 13 }}>
            {labelFor[key]}
            <span className={`badge badge-${status}`}>{badge}</span>
          </h2>
        </div>
        {status === 'unknown' ? (
          <div className="field-hint">{t('Not checked yet.', '尚未检查。')}</div>
        ) : status === 'ok' ? (
          <div className="field-hint">{t('No problems found.', '未发现问题。')}</div>
        ) : (
          <>
            {hasProblem ? (
              <>
                {problems.map((p, i) => (
                  <div key={i} className="field-hint">{renderProblem(p)}</div>
                ))}
              </>
            ) : (
              <div className="field-hint">{t('Unknown problem.', '未知问题。')}</div>
            )}
            {check && check.info && (
              <div className="field-hint">{String(check.info)}</div>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div>
      {renderCheckBlock('env_shallow')}

      {renderCheckBlock('env_deep')}

      {renderCheckBlock('checkpoints')}

      <div className="section">
        <div className="section-hdr">
          <h2 style={{ fontSize: 13 }}>
            {t('Audio: playable', '音频：可播放')}
            <span className={`badge badge-${statusFor(checks.audio)}`}>
              {statusFor(checks.audio) === 'ok' ? t('Done', '已完成') : statusFor(checks.audio) === 'fail' ? t('Failed', '失败') : t('Unknown', '未知')}
            </span>
          </h2>
        </div>
        <div className="field-hint">
          {t('The audio information and the waveform both need a real sample. ' +
            'Fill in the text to synthesise, then run tier A.',
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

      {/* 时长/采样率/声道由后端解 WAV 头给出，这里不引 ffmpeg。 */}
      <div className="section">
        <div className="section-hdr">
          <h2 style={{ fontSize: 13 }}>{t('Audio information', '音频信息')}</h2>
        </div>
        {checks.audio && checks.audio.wav ? (
          <div>
            <div>
              {t('Duration', '时长')}: {checks.audio.wav.duration_sec}s
            </div>
            <div>
              {t('Sample rate', '采样率')}: {checks.audio.wav.sample_rate} Hz
            </div>
            <div>
              {t('Channels', '声道')}: {checks.audio.wav.channels}
            </div>
          </div>
        ) : (
          <div className="field-hint">
            {t('No sample yet. Synthesise one above to see the audio information.',
              '还没有样本。在上方合成一段就能看到音频信息。')}
          </div>
        )}
      </div>

      {/* 复用主界面那个 Player，不另画播放器。 */}
      <div className="section">
        <div className="section-hdr">
          <h2 style={{ fontSize: 13 }}>{t('Waveform', '波形')}</h2>
        </div>
        {checks.audio && checks.audio.audio_path ? (
          <Player src={`/wizard/verify/audio?id=${encodeURIComponent(id)}`} />
        ) : (
          <div className="field-hint">
            {t('No sample yet. The waveform appears here once one exists.',
              '还没有样本。有样本后这里会显示波形。')}
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-hdr">
          <h2 style={{ fontSize: 13 }}>{t('ASR read-back (optional)', 'ASR 反向识别（可选）')}</h2>
        </div>
        <div className="field-hint">
          {t('Not implemented. The platform has ASR models and a working transcription ' +
            'step, but that step takes a directory of training material and a training ' +
            'config. There is no entry point that reads back one arbitrary audio clip, ' +
            'and no manifest field declares an ASR endpoint on the engine. ' +
            'This item is optional and does not block the other two.',
            '尚未实现。平台有 ASR 模型与可用的转写步骤，但那个步骤要的是一段训练素材目录' +
            '加一份训练配置，没有「把任意一段音频读回来」的入口，名片里也没有声明 ASR 端点的字段。' +
            '此项可选，不阻塞其余两项。')}
        </div>
      </div>
    </div>
  )
}
