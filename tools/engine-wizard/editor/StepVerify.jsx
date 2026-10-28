//  第 5 步（verify）：渲染平台四道校验的结果，互不依赖，不绑成一个必须全过的门。
//  每项各自报 ok / fail / unknown，缺素材时如实说还没有，不用占位文案糊弄。

import React, { useState, useEffect } from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { Player } from '../../../web/src/components/common/Player'
import { MEASURE_POLL_MS, measureStageLabel, formatElapsed, measureRunning } from './measureProgress'

export function StepVerify ({ id }) {
  const { t } = useT()
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [audioLevel, setAudioLevel] = useState('B')
  const [synthText, setSynthText] = useState('')
  // 参考音频与参考文本：要参考音频的引擎，A 级与试运行都得带上，否则宿主当场 400。
  //   这里填的是平台的词，后端照名片 maps 换成引擎的参数名（core/measure.js 的 toEngineWords）。
  const [refAudio, setRefAudio] = useState('')
  const [refText, setRefText] = useState('')
  // 试运行是后台任务：job 是服务端的任务快照（阶段、已用时间、结束后的结果），轮询刷新。
  const [job, setJob] = useState(null)
  const [measureError, setMeasureError] = useState(null)
  const measuring = measureRunning(job)

  const synthRequest = () => {
    const r = { text: synthText.trim() }
    if (refAudio.trim()) r.reference_audio = refAudio.trim()
    if (refText.trim()) r.reference_text = refText.trim()
    return r
  }

  // 试运行：真起一次引擎，量冷启动与合成一段的耗时，按余量定本机上的超时。
  //   存在本机（state/ 下），不写名片：名片要能分享，「本机多快」不该跟着走。
  //   POST 只起任务，进度靠 GET /wizard/verify/measure/progress 轮询。
  const runMeasure = () => {
    if (!id || !synthText.trim()) return
    setMeasureError(null)
    fetch('/wizard/verify/measure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, request: synthRequest() }),
    })
      .then(r => r.json())
      .then((j) => {
        if (j && j.job) setJob(j.job)
        if (!j || !j.ok) setMeasureError((j && j.error) || t('Could not start the trial run', '试运行未能启动'))
      })
      .catch((e) => setMeasureError(String(e)))
  }

  const cancelMeasure = () => {
    if (!id) return
    fetch('/wizard/verify/measure/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
      .then(r => r.json())
      .then((j) => { if (j && j.job) setJob(j.job) })
      .catch((e) => setMeasureError(String(e)))
  }

  // 换引擎或刚进这一步：先读一次，接上可能还进行中的任务（刷新页面不丢进度）。
  useEffect(() => {
    setJob(null)
    setMeasureError(null)
    if (!id) return undefined
    let live = true
    fetch(`/wizard/verify/measure/progress?id=${encodeURIComponent(id)}`)
      .then(r => r.json())
      .then((j) => { if (live && j && j.ok) setJob(j.job) })
      .catch(() => {})
    return () => { live = false }
  }, [id])

  // 任务进行中就按固定间隔轮询；结束（done / failed）即停。
  useEffect(() => {
    if (!id || !measuring) return undefined
    let live = true
    const timer = setInterval(() => {
      fetch(`/wizard/verify/measure/progress?id=${encodeURIComponent(id)}`)
        .then(r => r.json())
        .then((j) => { if (live && j && j.ok && j.job) setJob(j.job) })
        .catch(() => {})
    }, MEASURE_POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [id, measuring])

  const measured = job && !measuring ? job.result : null

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
    return <div className="msg msg-info">{t('Running checks...', '正在校验…')}</div>
  }

  if (!results) {
    return <div className="msg msg-danger">{t('Checks failed to load.', '校验加载失败。')}</div>
  }

  const checks = results.checks || {}

  const labelFor = {
    env_shallow: t('Environment: installed', '环境：已安装'),
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
          <h2 style={{ fontSize: 'var(--fs-13)' }}>
            {labelFor[key]}
            <span className={`badge badge-${status}`}>{badge}</span>
          </h2>
        </div>
        <div className="section-body">
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
          <h2 style={{ fontSize: 'var(--fs-13)' }}>
            {t('Audio: playable', '音频：可播放')}
            <span className={`badge badge-${statusFor(checks.audio)}`}>
              {statusFor(checks.audio) === 'ok' ? t('Done', '已完成') : statusFor(checks.audio) === 'fail' ? t('Failed', '失败') : t('Unknown', '未知')}
            </span>
          </h2>
        </div>
        <div className="section-body">
          <div className="field-hint">
            {t('The audio information and the waveform both need a real sample. ' +
              'Fill in the text to synthesise, then run tier A.',
              '音频信息与波形都需要一份真实样本。填入要合成的文本，然后执行 A 级校验。')}
          </div>
          <textarea
            className="control"
            value={synthText}
            onChange={(e) => setSynthText(e.target.value)}
            placeholder={t('Text to synthesise', '要合成的文本')}
            rows={3}
            style={{ marginTop: 6 }}
          />
          <button
            className="btn btn-sm btn-primary"
            type="button"
            disabled={loading || !synthText.trim()}
            style={{ marginTop: 6 }}
            onClick={() => runChecks('A', synthRequest())}
          >
            {loading ? t('Running...', '正在运行…') : t('Run tier A', '执行 A 级校验')}
          </button>
          <input
            className="control"
            type="text"
            value={refAudio}
            onChange={(e) => setRefAudio(e.target.value)}
            placeholder={t('Reference audio path (if the engine needs one)', '参考音频路径（引擎需要时填）')}
            style={{ marginTop: 6 }}
          />
          <input
            className="control"
            type="text"
            value={refText}
            onChange={(e) => setRefText(e.target.value)}
            placeholder={t('What the reference audio says (if the engine reads it)', '参考音频说的话（引擎要时填）')}
            style={{ marginTop: 6 }}
          />
          <button
            className="btn btn-sm"
            type="button"
            disabled={measuring || !synthText.trim()}
            style={{ marginTop: 6, marginLeft: 6 }}
            onClick={runMeasure}
          >
            {t('Trial run and set timeouts for this machine', '试运行并更新本机超时')}
          </button>
          {measuring && (
            <button className="btn btn-sm" type="button" style={{ marginTop: 6, marginLeft: 6 }}
              onClick={cancelMeasure}>
              {t('Cancel', '取消')}
            </button>
          )}
          {job && (
            <div className="field-hint" style={{ marginTop: 6 }}>
              <span className="badge">{measureStageLabel(job.stage, t)}</span>
              {' '}{t('elapsed', '已用时间')} {formatElapsed(job.elapsed_ms)}
            </div>
          )}
          {measureError && <div className="msg msg-danger" style={{ marginTop: 6 }}>{String(measureError)}</div>}
          {measured && (
            <div style={{ marginTop: 6 }}>
              {measured.values && Object.keys(measured.values).map((k) => (
                <div key={k} className="field-hint">
                  {t('This machine', '本机')} {k} = {Math.round(measured.values[k] / 1000)}s
                </div>
              ))}
              {measured.values && Object.keys(measured.values).length > 0 && (
                <div className="field-hint">
                  {t('Kept on this machine only, not written into the manifest; it overrides the manifest value here.',
                    '只存在本机上，不写进名片；在本机上优先于名片里写的值。')}
                </div>
              )}
              {measured.measurement && Number.isFinite(measured.measurement.readyMs) && (
                <div className="field-hint">
                  {t('Cold start to ready', '冷启动到就绪')} {Math.round(measured.measurement.readyMs / 1000)}s
                  {Number.isFinite(measured.measurement.synthMs) && measured.measurement.synthOk
                    ? `，${t('one segment', '一段')}（${measured.measurement.chars} ${t('chars', '字')}）${Math.round(measured.measurement.synthMs / 1000)}s`
                    : ''}
                  {measured.measurement.sampleRate ? `，${measured.measurement.sampleRate} Hz` : ''}
                </div>
              )}
              {measured.ok === false && measured.error && (
                <div className="msg msg-danger">{String(measured.error)}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 时长/采样率/声道由后端解 WAV 头给出，这里不引 ffmpeg。 */}
      <div className="section">
        <div className="section-hdr">
          <h2 style={{ fontSize: 'var(--fs-13)' }}>{t('Audio information', '音频信息')}</h2>
        </div>
        <div className="section-body">
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
      </div>

      {/* 复用主界面那个 Player，不另画播放器。 */}
      <div className="section">
        <div className="section-hdr">
          <h2 style={{ fontSize: 'var(--fs-13)' }}>{t('Waveform', '波形')}</h2>
        </div>
        <div className="section-body">
          {checks.audio && checks.audio.audio_path ? (
            <Player src={`/wizard/verify/audio?id=${encodeURIComponent(id)}`} />
          ) : (
            <div className="field-hint">
              {t('No sample yet. The waveform appears here once one exists.',
                '还没有样本。有样本后这里会显示波形。')}
            </div>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-hdr">
          <h2 style={{ fontSize: 'var(--fs-13)' }}>{t('ASR read-back (optional)', 'ASR 反向识别（可选）')}</h2>
        </div>
        <div className="section-body">
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
    </div>
  )
}
