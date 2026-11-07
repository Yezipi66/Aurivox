//  第 5 步（verify）：渲染平台四道校验的结果，互不依赖，不绑成一个必须全过的门。
//  每项各自报 ok / fail / unknown，缺素材时如实说还没有，不用占位文案糊弄。

import React, { useState, useEffect } from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { Player } from '../../../web/src/components/common/Player'
import DeviceSelect from '../../../web/src/components/common/DeviceSelect'
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

  // 运行设备：本机有哪几块卡只有后端知道，这里只负责摆成下拉。
  //   选中的值随请求一起送回去，换算成引擎认的写法由后端做（lib/engines/deviceValue.js）。
  const [devices, setDevices] = useState([])
  const [device, setDevice] = useState({ kind: 'auto' })
  useEffect(() => {
    let alive = true
    fetch('/wizard/hardware')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j && Array.isArray(j.device_options)) setDevices(j.device_options)
      })
      .catch(() => { /* 探测失败就保持空列表，下拉退化成「自动」 */ })
    return () => { alive = false }
  }, [])

  const synthRequest = () => {
    const r = { text: synthText.trim() }
    if (refAudio.trim()) r.reference_audio = refAudio.trim()
    if (refText.trim()) r.reference_text = refText.trim()
    // 设备按「选了什么」原样送回去，不在这里转成命令行写法
    if (device && device.kind && device.kind !== 'auto') r.device = device
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

  // 预填：平台能代填的就不让使用者从零开始。
  //   默认试音文本与 web/src/components/common/Fields.jsx 的示例文本同句（平台已有，不另造）。
  //   参考音频与文本问后端要（资产的第一个可用切片，与合成主链路同一个取法），有才填，没有留空。
  //   只在进这一步与换引擎时填一次：填过之后这三个输入框由使用者持有，不会被覆盖。
  useEffect(() => {
    if (!id) return undefined
    setSynthText(t('Hello! This is a sample line.', '你好，这是一段示例文本。'))
    setRefAudio('')
    setRefText('')
    fetch(`/wizard/verify/ref?id=${encodeURIComponent(id)}`)
      .then(r => r.json())
      .then((j) => {
        if (j && j.ok && j.reference_audio) setRefAudio(j.reference_audio)
        if (j && j.ok && j.reference_text) setRefText(j.reference_text)
      })
      .catch(() => {})
    return undefined
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
    return <div className="msg msg-info">{t('Running checks…', '正在校验…')}</div>
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

  const renderProblem = (p) => {
    if (typeof p === 'string') return p
    if (p && typeof p.message === 'string') return p.message
    if (p && typeof p.error === 'string') return p.error
    return t('Unknown problem', '未知问题')
  }

  // 每道的标题与「这道在查什么」都从后端结果里取（平台四道的原话），前端不再另造标签：
  //   「装没装」「起不起来」若贴上自己造的「环境：已安装」「环境：可启动」，
  //   使用者会把它们当成第 2 步「装依赖」的结论，而它们查的是名片的声明与引擎的入口。
  const titleOf = (key, check) => (check && check.titleZh)
    ? t(check.titleEn, check.titleZh)
    : labelFor[key]

  // 状态三态：权重道按 ready（null 是「说不出来」，不是「失败」），其余按 ok。
  const statusOf = (key, check) => {
    if (!check) return 'unknown'
    if (key === 'checkpoints') {
      return check.ready === true ? 'ok' : check.ready === false ? 'fail' : 'unknown'
    }
    return check.ok === true ? 'ok' : check.ok === false ? 'fail' : 'unknown'
  }

  const renderCheckBlock = (key) => {
    const check = checks[key]
    const status = statusOf(key, check)
    const problems = Array.isArray(check && check.problems) ? check.problems : []
    // 权重道不吃 problems：平台给它的是 note / missing / abs_path。
    //   目录不在、缺哪些文件、目录在哪，平台都查明了，读出来给使用者看，
    //   不让这些落成一句「未知问题」。
    const weightLines = []
    if (key === 'checkpoints' && check) {
      if (typeof check.note === 'string' && check.note) weightLines.push(check.note)
      if (Array.isArray(check.missing) && check.missing.length) {
        weightLines.push(t('Missing: ', '缺：') + check.missing.join(', '))
      }
      if (typeof check.abs_path === 'string' && check.abs_path) {
        weightLines.push(t('Weights directory: ', '权重目录：') + check.abs_path)
      }
    }
    const shown = status === 'fail' || status === 'unknown'
      ? [...weightLines, ...problems.map(renderProblem)]
      : []
    const hasShown = shown.length > 0

    const badge = status === 'ok' ? t('Done', '已完成') : status === 'fail' ? t('Failed', '失败') : t('Unknown', '未知')

    return (
      <div className="section" key={key}>
        <div className="section-hdr">
          <h2>
            {titleOf(key, check)}
            <span className={`badge badge-${status}`}>{badge}</span>
          </h2>
        </div>
        <div className="section-body">
          {check && check.whyZh && (
            <div className="field-hint">{t(check.why, check.whyZh)}</div>
          )}
          {status === 'ok' ? (
            <div className="field-hint">
              {key === 'checkpoints'
                ? t('The files this manifest names are all present. That does not mean the engine can speak; run tier A below to find out.',
                  '名片点名的文件都在。这不代表能出声，用下面的 A 级校验真跑一次。')
                : t('No problems found.', '未发现问题。')}
            </div>
          ) : hasShown ? (
            shown.map((line, i) => (
              <div key={i} className="field-hint">{line}</div>
            ))
          ) : status === 'fail' ? (
            <div className="field-hint">{t('Unknown problem.', '未知问题。')}</div>
          ) : (
            <div className="field-hint">{t('Not checked yet.', '尚未检查。')}</div>
          )}
          {check && check.info && (
            <div className="field-hint">{String(check.info)}</div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="wz-stack">
      {renderCheckBlock('env_shallow')}

      {renderCheckBlock('env_deep')}

      {renderCheckBlock('checkpoints')}

      <div className="section">
        <div className="section-hdr">
          <h2>
            {t('Audio: playable', '音频：可播放')}
            <span className={`badge badge-${statusOf('audio', checks.audio)}`}>
              {statusOf('audio', checks.audio) === 'ok' ? t('Done', '已完成') : statusOf('audio', checks.audio) === 'fail' ? t('Failed', '失败') : t('Unknown', '未知')}
            </span>
          </h2>
        </div>
        <div className="section-body">
          <div className="field-hint">
            {t('The audio information and the waveform both need a real sample. ' +
              'Fill in the text to synthesise, then run tier A.',
              '音频信息与波形都需要一份真实样本。填入要合成的文本，然后执行 A 级校验。')}
          </div>
          <DeviceSelect
            options={devices}
            value={device}
            onChange={setDevice}
            id={`device-${id || 'engine'}`}
            disabled={loading || measuring}
          />
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
            {loading ? t('Running…', '正在运行…') : t('Run tier A', '执行 A 级校验')}
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
          <h2>{t('Audio information', '音频信息')}</h2>
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
                '暂无样本。在上方合成一段即可查看音频信息。')}
            </div>
          )}
        </div>
      </div>

      {/* 复用主界面那个 Player，不另画播放器。 */}
      <div className="section">
        <div className="section-hdr">
          <h2>{t('Waveform', '波形')}</h2>
        </div>
        <div className="section-body">
          {checks.audio && checks.audio.audio_path ? (
            <Player src={`/wizard/verify/audio?id=${encodeURIComponent(id)}`} />
          ) : (
            <div className="field-hint">
              {t('No sample yet. The waveform appears here once one exists.',
                '暂无样本。有样本后此处会显示波形。')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
