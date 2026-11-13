// 第 5 步（verify）：渲染平台四道校验的结果，各自独立呈现，不作为单一通过条件。
// 每项分别报 ok / fail / unknown；缺少素材时如实说明尚未检查，不用占位文案代替。

import React, { useState, useEffect } from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { Player } from '../../../web/src/components/common/Player'
import DeviceSelect from '../../../web/src/components/common/DeviceSelect'
import { MEASURE_POLL_MS, measureStageLabel, formatElapsed, measureRunning } from './measureProgress'
import { readSse } from './downloadRunner'

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
  // 名片声明的补齐命令：资源可能在运行期才发现缺，第 5 步给一个补齐后重跑前置的入口。
  const [postBusy, setPostBusy] = useState(false)
  const [postOut, setPostOut] = useState([])
  const postAbort = React.useRef(null)
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

  const runPostDownload = async () => {
    if (!id || postBusy) return
    setPostBusy(true)
    setPostOut([])
    const controller = new AbortController()
    postAbort.current = controller
    try {
      const resp = await fetch('/wizard/engine-download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ id, key: 'manifest', root: window.__PROJECT_ROOT__ || '' }),
      })
      if (!resp.ok) {
        let j = null
        try { j = await resp.json() } catch { /* 不是 JSON 就只报状态码 */ }
        setPostOut([(j && (j.errorZh || j.error)) || ('HTTP ' + resp.status)])
        return
      }
      let last = null
      await readSse(resp, (ev) => {
        if (!ev) return
        if (typeof ev.text === 'string') setPostOut((p) => [...p, ev.text].slice(-200))
        if ('ok' in ev || 'error' in ev) last = ev
      })
      if (last && last.ok === false) {
        setPostOut((p) => [...p, last.errorZh || last.error || String(last.code || 'FAILED')])
      }
      runChecks('B', null)
    } catch (e) {
      const stopped = e && e.name === 'AbortError'
      setPostOut((p) => [...p, stopped ? t('Stopped.', '已停止。') : String((e && e.message) || e)])
    } finally {
      postAbort.current = null
      setPostBusy(false)
    }
  }
  const stopPostDownload = () => { if (postAbort.current) postAbort.current.abort() }

  if (loading) {
    return <div className="msg msg-info">{t('Running checks…', '正在校验…')}</div>
  }

  if (!results) {
    return <div className="msg msg-danger">{t('Checks failed to load.', '校验加载失败。')}</div>
  }

  const checks = results.checks || {}

  const labelFor = {
    env_shallow: t('Environment integrity', '运行环境完整性'),
    env_deep: t('Engine import', '引擎模块可导入'),
    checkpoints: t('Model weights', '模型权重完整性'),
    audio: t('Speech synthesis', '语音合成可用性'),
  }

  const renderProblem = (p) => {
    if (typeof p === 'string') return p
    if (p && typeof p.message === 'string') return p.message
    if (p && typeof p.error === 'string') return p.error
    return t('Unknown problem', '未知问题')
  }

  // envCheck 的 info 是结构化对象，直接 String() 会显示 [object Object]。
  //   只取能佐证「环境确实可用」的几项，不把整份路径清单摊在界面上。
  const infoLines = (check) => {
    const i = check && check.info
    if (!i || typeof i !== 'object') return []
    const lines = []
    if (i.python && i.python.version) lines.push(t('Python version: ', 'Python 版本：') + i.python.version)
    if (i.paths && i.paths.python) lines.push(t('Interpreter: ', '解释器：') + i.paths.python)
    if (Array.isArray(i.checks)) {
      for (const c of i.checks) {
        if (!c) continue
        lines.push(`${c.module || c.class || ''} · ${c.ok ? t('imported', '导入通过') : t('import failed', '导入失败')}`
          + (c.detail ? ` · ${c.detail}` : ''))
      }
    }
    return lines
  }

  // 每道的标题与「这道在查什么」都从后端结果里取（平台四道的原话），前端不另造标签，
  //   避免与第 2 步「安装依赖」的结论混淆。
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

  // 三态只映射到项目已有的 badge 配色，不新造类。
  const badgeClass = (status) => status === 'ok' ? 'badge-ok'
    : status === 'fail' ? 'badge-danger' : 'badge-neutral'

  // 两层结论分开报：前置检查是静态核对，运行验证要有一次真实合成才算数。
  //   B 级只校验响应格式，不能计入「已通过」。
  const preflightKeys = ['env_shallow', 'env_deep', 'checkpoints']
  const preflightStates = preflightKeys.map((k) => statusOf(k, checks[k]))
  const preflightPassed = preflightStates.filter((s) => s === 'ok').length
  const preflightStatus = preflightStates.includes('fail') ? 'fail'
    : preflightStates.includes('unknown') ? 'unknown' : 'ok'
  const ranTierA = !!(checks.audio && checks.audio.level === 'A')
  const runtimeStatus = ranTierA ? statusOf('audio', checks.audio) : 'unknown'
  const runtimeLabel = runtimeStatus === 'ok' ? t('Passed', '通过')
    : runtimeStatus === 'fail' ? t('Failed', '未通过') : t('Not run', '待执行')
  const audioBadge = runtimeStatus === 'ok' ? t('Passed', '通过')
    : runtimeStatus === 'fail' ? t('Failed', '未通过') : t('Not run', '待执行')
  // B 级的诊断信息照实给出，但不冒充「真实合成未通过」。
  const tierBDiagnostic = !ranTierA && checks.audio
    ? (checks.audio.errorZh || checks.audio.error || '') : ''
  // 失败的合成要回答两个问题：为什么、接下来做什么。原文另给一份，
  //   它是唯一能让人自己判断的证据（缺模块名、权重路径、traceback 最后一行都在里面）。
  const audioFailed = !!(checks.audio && checks.audio.ok === false)
  const audioCause = audioFailed
    ? (checks.audio.cause || checks.audio.errorZh || checks.audio.error || '') : ''
  const audioHint = audioFailed ? (checks.audio.hint || '') : ''
  const audioRaw = audioFailed
    ? [checks.audio.detail, checks.audio.host_stderr].filter((s) => typeof s === 'string' && s.trim()).join('\n\n')
    : ''
  const runtimeHint = runtimeStatus === 'ok'
    ? t('A real synthesis produced a non-empty WAV. Audio information and waveform are shown below.',
      '已执行一次真实合成并取得非空 WAV 样本，音频信息与波形见下方。')
    : runtimeStatus === 'fail'
      ? t('The synthesis check failed. See the Speech synthesis section below for details.',
        '真实合成校验未通过，详情见下方「语音合成可用性」。')
      : t('Tier B checks the response format only. Run tier A below to record a real synthesis result.',
        'B 级仅校验响应格式。执行下方 A 级校验后，此处记录一次真实合成的结果。')

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
        weightLines.push(t('Missing files: ', '缺失文件：') + check.missing.join(', '))
      }
      if (typeof check.abs_path === 'string' && check.abs_path) {
        weightLines.push(t('Weights directory: ', '权重目录：') + check.abs_path)
      }
    }
    const shown = status === 'fail' || status === 'unknown'
      ? [...weightLines, ...problems.map(renderProblem)]
      : []
    const hasShown = shown.length > 0

    const badge = status === 'ok' ? t('Passed', '通过') : status === 'fail' ? t('Failed', '未通过') : t('Unknown', '未知')

    return (
      <div className="section" key={key}>
        <div className="section-hdr">
          <h2>
            {titleOf(key, check)}
            <span className={`badge ${badgeClass(status)}`}>{badge}</span>
          </h2>
        </div>
        <div className="section-body">
          {check && check.whyZh && (
            <div className="field-hint">{t(check.why, check.whyZh)}</div>
          )}
          {status === 'ok' ? (
            <div className="field-hint">
              {key === 'checkpoints'
                ? t('Every weights file named in the manifest is present. This is a static check only; run tier A below to verify synthesis.',
                  '名片声明的权重文件齐全。此项为静态核对，引擎能否合成语音需执行下方 A 级校验。')
                : key === 'env_shallow'
                  ? t('The interpreter, the entrypoint and verify.sys_path are on disk. This does not confirm that the environment was built from the manifest declaration, nor which package versions are installed.',
                    '解释器、推理入口与 verify.sys_path 都在盘上。此项不核对环境是否按名片声明建立，也不核对已安装的包版本。')
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
          {infoLines(check).map((line, i) => (
            <div className="field-hint" key={i} style={{ wordBreak: 'break-all' }}>{line}</div>
          ))}
          {key === 'checkpoints' && Array.isArray(check && check.external) && check.external.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="field-hint">
                {t(`${check.external.length} resource(s) are fetched by the engine on first run and are not part of this check.`,
                  `另有 ${check.external.length} 项资源由引擎首次推理时自行拉取，不在此项核对范围内。`)}
              </div>
              {check.external.map((h) => (
                <div className="plan-kv" key={`${h.repo}|${h.file}|${h.line}`}>
                  <span className="pk"><code>{h.repo}</code></span>
                  <span className="pv">
                    <span className="field-hint" style={{ marginLeft: 0 }}>{h.file}:{h.line} · {h.call}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="wz-stack">
      <div className="section">
        <div className="section-hdr">
          <h2>{t('Verification overview', '校验结论')}</h2>
        </div>
        <div className="section-body">
          <div className={`msg msg-${preflightStatus === 'ok' ? 'success' : preflightStatus === 'fail' ? 'danger' : 'warn'}`}>
            <strong>{t('Preflight checks', '接入前置检查')}</strong>
            {' · '}{preflightPassed}/{preflightKeys.length} {t('passed', '项通过')}
            <div className="field-hint" style={{ marginTop: 4 }}>
              {t('Static checks confirm the manifest, the environment and the files on disk. They do not prove that the engine can synthesise speech.',
                '接入前置检查用于确认名片声明、运行环境与盘上文件一致，不能证明引擎能够合成语音。')}
            </div>
          </div>
          <div className={`msg msg-${runtimeStatus === 'ok' ? 'success' : runtimeStatus === 'fail' ? 'danger' : 'info'}`}
            style={{ marginTop: 6 }}>
            <strong>{t('Runtime synthesis', '运行验证')}</strong>
            {' · '}{runtimeLabel}
            <div className="field-hint" style={{ marginTop: 4 }}>{runtimeHint}</div>
          </div>
          {results.post_download_available && (
            <div style={{ marginTop: 6 }}>
              <button className="btn btn-sm" type="button" disabled={postBusy}
                title={t('Run the engine-declared download command, then repeat the preflight checks.',
                  '执行名片声明的补齐命令，随后重新执行一遍前置检查。')}
                onClick={runPostDownload}>
                {postBusy ? t('Running', '运行中') : t('Complete engine resources and recheck', '按名片补齐并重新校验')}
              </button>
              {postBusy && (
                <button className="btn btn-sm btn-danger" type="button" style={{ marginLeft: 6 }}
                  onClick={stopPostDownload}>
                  {t('Stop', '停止')}
                </button>
              )}
              {postOut.length > 0 && (
                <pre className="rc-cmd-body" style={{ marginTop: 6, maxHeight: 180, overflow: 'auto' }}>
                  {postOut.join('\n')}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>

      {renderCheckBlock('env_shallow')}

      {renderCheckBlock('env_deep')}

      {renderCheckBlock('checkpoints')}

      <div className="section">
        <div className="section-hdr">
          <h2>
            {t('Speech synthesis', '语音合成可用性')}
            <span className={`badge ${badgeClass(runtimeStatus)}`}>{audioBadge}</span>
            <span className="badge" style={{ marginLeft: 6 }}>
              {ranTierA ? t('Tier A · real synthesis', 'A 级 · 真实合成') : t('Tier B · response format', 'B 级 · 响应格式')}
            </span>
          </h2>
        </div>
        <div className="section-body">
          <div className="field-hint">
            {t('Tier B checks the response format only; tier A performs a real synthesis and produces the sample used for audio information and waveform.',
              'B 级仅校验响应格式；A 级执行一次真实合成，并产出用于音频信息与波形的样本。')}
          </div>
          {tierBDiagnostic && (
            <div className="msg msg-warn" style={{ marginTop: 6, maxHeight: 120, overflow: 'auto' }}>
              {t('Tier B diagnostic (not a synthesis result): ', 'B 级诊断（非合成结果）：')}
              {tierBDiagnostic}
            </div>
          )}
          {audioFailed && (
            <div className="msg msg-danger" style={{ marginTop: 6 }}>
              <div>{checks.audio.error}</div>
              <div style={{ marginTop: 6 }}>
                <strong>{t('Why it failed', '失败原因')}</strong>
              </div>
              <div style={{ marginTop: 4 }}>{audioCause}</div>
              {audioHint && (
                <div className="field-hint" style={{ marginTop: 4 }}>
                  {t('Suggested next step: ', '建议：')}
                  {audioHint}
                </div>
              )}
            </div>
          )}
          {audioRaw && (
            <details style={{ marginTop: 6 }}>
              <summary className="field-hint" style={{ cursor: 'pointer' }}>
                {t('Raw output from the engine and the host', '引擎与宿主的原始输出')}
              </summary>
              <pre className="rc-cmd-body"
                style={{ marginTop: 6, maxHeight: 240, overflow: 'auto' }}>
                {audioRaw}
              </pre>
            </details>
          )}
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
            placeholder={t('Reference audio path (if the engine requires one)', '参考音频路径（引擎需要时填写）')}
            style={{ marginTop: 6 }}
          />
          <input
            className="control"
            type="text"
            value={refText}
            onChange={(e) => setRefText(e.target.value)}
            placeholder={t('Transcript of the reference audio (if the engine requires it)', '参考音频对应文本（引擎需要时填写）')}
            style={{ marginTop: 6 }}
          />
          <button
            className="btn btn-sm"
            type="button"
            disabled={measuring || !synthText.trim()}
            style={{ marginTop: 6, marginLeft: 6 }}
            onClick={runMeasure}
          >
            {t('Trial run and record timing baselines for this machine', '试运行并记录本机耗时基准')}
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
                  {t('On this machine', '本机')} {k}：{Math.round(measured.values[k] / 1000)} {t('s', '秒')}
                </div>
              ))}
              {measured.values && Object.keys(measured.values).length > 0 && (
                <div className="field-hint">
                  {t('Kept on this machine only, not written into the manifest; it overrides the manifest value here.',
                    '仅保存在本机，不写入名片；在本机上优先于名片中的取值。')}
                </div>
              )}
              {measured.measurement && Number.isFinite(measured.measurement.readyMs) && (
                <div className="field-hint">
                  {t('Cold start to ready', '冷启动至就绪')} {Math.round(measured.measurement.readyMs / 1000)}s
                  {Number.isFinite(measured.measurement.synthMs) && measured.measurement.synthOk
                    ? `，${t('single segment', '单段合成')}（${measured.measurement.chars} ${t('chars', '字')}）${Math.round(measured.measurement.synthMs / 1000)}s`
                    : ''}
                  {measured.measurement.sampleRate ? `，${measured.measurement.sampleRate} Hz` : ''}
                </div>
              )}
              {measured.ok === false && (
                <div className="msg msg-danger" style={{ marginTop: 6 }}>
                  <strong>{String(measured.error)}</strong>
                  {measured.measurement && measured.measurement.cause && (
                    <div style={{ marginTop: 4 }}>{measured.measurement.cause}</div>
                  )}
                  {measured.measurement && measured.measurement.hint && (
                    <div className="field-hint" style={{ marginTop: 4 }}>
                      {t('Suggested next step: ', '建议：')}{measured.measurement.hint}
                    </div>
                  )}
                  {(measured.measurement && (measured.measurement.detail || measured.measurement.log_tail)) && (
                    <pre className="rc-cmd-body" style={{ marginTop: 6, maxHeight: 240, overflow: 'auto' }}>
                      {measured.measurement.detail || measured.measurement.log_tail}
                    </pre>
                  )}
                </div>
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
                '暂无样本，完成一次合成后可查看音频信息。')}
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
                '暂无样本，完成一次合成后在此显示波形。')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
