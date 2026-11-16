// 第 5 步（verify）：渲染平台四道校验的结果，各自独立呈现，不作为单一通过条件。
// 每项分别报 ok / fail / unknown；缺少素材时如实说明尚未检查，不用占位文案代替。

import React, { useState, useEffect } from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { Player, AudioPlayer } from '../../../web/src/components/common/Player'
import { getPreviewMode, setPreviewMode } from '../../../web/src/lib/previewMode'
import { cleanPathInput, refInRange } from '../../../web/src/lib/refAudio'
import DeviceSelect from '../../../web/src/components/common/DeviceSelect'
import { MEASURE_POLL_MS, measureStageLabel, formatElapsed, measureRunning } from './measureProgress'
import { readSse } from './downloadRunner'

// 一份校验结果里，语音那道跑的是哪一级（'A' | 'B'）。取不到就当空串：
//   没有 audio 段的结果按「没有档位」处理，不比大小。
const levelOf = (r) => (r && r.checks && r.checks.audio && r.checks.audio.level) || ''

export function StepVerify ({ id }) {
  const { t } = useT()
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  // 正在执行的是哪一级。首屏会自动执行 B 级，那期间 A 级按钮不能跟着显示「正在运行…」：
  //   人没点它，它却在转，是这页最容易误导的一处。
  const [runningLevel, setRunningLevel] = useState(null)
  // 这一次校验什么时候起的、上一次的结论是什么。
  //   A 级要真起一次宿主（本机 8 秒起步，冷启动更久），不给计时的话，
  //   两次一模一样的失败看起来就是「点了没反应」：界面闪一下，结论一字未变。
  const [startedAt, setStartedAt] = useState(0)
  const [lastRun, setLastRun] = useState(null)
  // 只用来每秒重算一次「已用时间」，不参与任何判断。
  const [, setPulse] = useState(0)
  const [audioLevel, setAudioLevel] = useState('B')
  const [synthText, setSynthText] = useState('')
  // 参考音频与参考文本：要参考音频的引擎，A 级与试运行都得带上，否则宿主当场 400。
  //   这里填的是平台的词，后端照名片 maps 换成引擎的参数名（core/measure.js 的 toEngineWords）。
  const [refAudio, setRefAudio] = useState('')
  const [refText, setRefText] = useState('')
  // 资产里的可用切片清单（/wizard/verify/refs，与预填同一份读盘判定）：
  // 点选一条就把参考音频与参考文本一起填进上面两个输入框，文本由平台代给。
  // 清单只负责代填，输入框始终由使用者持有，点选之后照旧可以手改。
  const [refs, setRefs] = useState([])
  // 参考音频用真文件选：宿主只认绝对路径，而浏览器不给脚本绝对路径，
  //   所以选中的字节交给后端落一份、由后端回传路径（见 core/wizardbridge.js 的 ref-upload）。
  const [refBusy, setRefBusy] = useState(false)
  const [refError, setRefError] = useState(null)
  const refFileInput = React.useRef(null)
  // 试运行是后台任务：job 是服务端的任务快照（阶段、已用时间、结束后的结果），轮询刷新。
  const [job, setJob] = useState(null)
  const [measureError, setMeasureError] = useState(null)
  // 名片声明的补齐命令：资源可能在运行期才发现缺，第 5 步给一个补齐后重跑前置的入口。
  const [postBusy, setPostBusy] = useState(false)
  const [postOut, setPostOut] = useState([])
  const postAbort = React.useRef(null)
  const measuring = measureRunning(job)

  // 运行设备：本机有哪几块卡只有后端知道，这里只负责摆成下拉。
  //   名片没声明 role="device" 的引擎 device_declared=false，这一格不出现。
  const [devices, setDevices] = useState([])
  const [device, setDevice] = useState({ kind: 'auto' })
  const [deviceDeclared, setDeviceDeclared] = useState(null)
  useEffect(() => {
    let alive = true
    fetch('/wizard/hardware' + (id ? `?engine=${encodeURIComponent(id)}` : ''))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j) return
        if (Array.isArray(j.device_options)) setDevices(j.device_options)
        setDeviceDeclared(j.device_declared === undefined ? null : j.device_declared)
      })
      .catch(() => { /* 探测失败就保持空列表，下拉退化成「自动」 */ })
    return () => { alive = false }
  }, [id])

  const synthRequest = () => {
    const r = { text: synthText.trim() }
    // 路径在提交前再清洗一次：输入框可能还留着没触发 onBlur 的引号与空格。
    const ref = cleanPathInput(refAudio)
    if (ref) r.reference_audio = ref
    if (refText.trim()) r.reference_text = refText.trim()
    // 设备按「选了什么」原样送回去，不在这里转成命令行写法
    if (device && device.kind && device.kind !== 'auto') r.device = device
    return r
  }

  // 试听区要给出波形本身。平台的预览模式开关在状态条上，向导没有那一栏，
  //   默认的进度条形态在这里与用途不符，所以进这一步直接切到波形。
  //   向导与平台不同源（端口不同），这里的取值不会改到平台那边。
  useEffect(() => {
    if (getPreviewMode() !== 'waveform') setPreviewMode('waveform')
  }, [])

  // 选中一个参考音频就上传到后端，拿回它的绝对路径填进这一格。
  //   不把 File 对象留在前端：宿主要的是路径，能在命令行上出现的那个。
  const pickRefAudio = (e) => {
    const file = e.target.files && e.target.files[0]
    // 同一个文件连选两次也要触发：清掉 input 的值，下一次 change 才会来。
    try { e.target.value = '' } catch { /* 只读输入框，忽略 */ }
    if (!file || !id) return
    setRefError(null)
    setRefBusy(true)
    const q = new URLSearchParams({ id, name: file.name })
    file.arrayBuffer()
      .then((buf) => fetch(`/wizard/ref-upload?${q.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: buf,
      }))
      .then((r) => r.json())
      .then((j) => {
        if (j && j.ok && j.path) { setRefAudio(j.path); return }
        setRefError((j && (j.errorZh || j.error)) || t('Could not read that file', '这个文件读不进来'))
      })
      .catch((err) => setRefError(String((err && err.message) || err)))
      .finally(() => setRefBusy(false))
  }

  // 试运行：真起一次引擎，量冷启动与合成一段的耗时，按余量定本机上的超时。  //   存在本机（state/ 下），不写名片：名片要能分享，「本机多快」不该跟着走。
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
    setRefs([])
    fetch(`/wizard/verify/ref?id=${encodeURIComponent(id)}`)
      .then(r => r.json())
      .then((j) => {
        if (j && j.ok && j.reference_audio) setRefAudio(j.reference_audio)
        if (j && j.ok && j.reference_text) setRefText(j.reference_text)
      })
      .catch(() => {})
    fetch(`/wizard/verify/refs?id=${encodeURIComponent(id)}`)
      .then(r => r.json())
      .then((j) => { if (j && j.ok && Array.isArray(j.refs)) setRefs(j.refs) })
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

  // 已经渲染的那份结果。B 级是首屏自动跑的，它同样要起一次临时宿主（stdio / cli 形态
  //   尤其慢），响应可能比使用者点的 A 级更晚回来。晚到的 B 级不许把 A 级结论盖回去：
  //   盖回去之后页面回到「没有样本」的样子，看起来就是 A 级点了没反应。
  // 判据只读 ref，不读 state：runChecks 的依赖必须保持 [id]，否则首屏那条 effect
  //   会跟着重跑，又发一次 B 级。
  const resultsRef = React.useRef(null)

  const runChecks = React.useCallback((level, request, force = false) => {
    if (!id) return
    const t0 = Date.now()
    setLoading(true)
    setRunningLevel(level)
    setStartedAt(t0)
    const q = new URLSearchParams({ id, audio: level })
    if (request) q.set('request', JSON.stringify(request))
    fetch(`/wizard/verify/checks?${q.toString()}`)
      .then(r => r.json())
      .then((j) => {
        // 晚到的 B 级不许覆盖已经拿到的 A 级结论。补齐权重之后重跑前置要例外：
        //   那时 A 级的结论已经过期，调用方会显式要求覆盖。
        if (!force && levelOf(resultsRef.current) === 'A' && levelOf(j) === 'B') return
        resultsRef.current = j
        setResults(j)
        setLastRun({
          level,
          at: t0,
          ms: Date.now() - t0,
          ok: !!(j && j.checks && j.checks.audio && j.checks.audio.ok),
        })
      })
      .catch(() => {
        setResults(null)
        resultsRef.current = null
        setLastRun({ level, at: t0, ms: Date.now() - t0, ok: false })
      })
      .finally(() => { setLoading(false); setRunningLevel(null) })
  }, [id])

  // 运行中就按半秒一支表：A 级跑几分钟时，界面必须能看出它仍在运行。
  useEffect(() => {
    if (!loading) return undefined
    const timer = setInterval(() => setPulse((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [loading])

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
      runChecks('B', null, true)
    } catch (e) {
      const stopped = e && e.name === 'AbortError'
      setPostOut((p) => [...p, stopped ? t('Stopped.', '已停止。') : String((e && e.message) || e)])
    } finally {
      postAbort.current = null
      setPostBusy(false)
    }
  }
  const stopPostDownload = () => { if (postAbort.current) postAbort.current.abort() }

  // 面板常驻，任何时刻都不整块替换。
  //   首屏的 B 级要跑十几秒（env_deep 得真起一次解释器），这段时间里整步
  //   只剩一行字、按钮也不在；换一次引擎再进来又重来一遍，看起来就像页面
  //   被重新加载了。没有结论就按「尚未检查」渲染，加载进度写在结论区顶上。
  const checks = (results && results.checks) || {}

  // 试听区的元信息取自后端解出的 WAV 头，不由前端算：浏览器解码出的时长
  //   与引擎写盘时的采样率不是同一件事，两边各算一次会得到两个不一致的值。
  const wav = (checks.audio && checks.audio.wav) || null
  // 只认 A 级：B 级不合成，但磁盘上可能留着上一轮的产物（端点在找不到 audio_path
  //   时会补一份），照它显示试听等于把旧样本当成这次的结果。
  const hasSample = !!(checks.audio && checks.audio.level === 'A' && checks.audio.ok
    && (wav || checks.audio.audio_path))
  const wavInfo = wav
    ? [
        `${wav.duration_sec}s`,
        `${wav.sample_rate} Hz`,
        wav.channels === 1
          ? t('mono', '单声道')
          : wav.channels === 2
            ? t('stereo', '立体声')
            : `${wav.channels} ${t('channels', '声道')}`,
      ].join(' · ')
    : ''

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
    ? t('A real synthesis produced a non-empty WAV. It is available for playback below.',
      '已执行一次真实合成并取得非空 WAV 样本，可在下方试听。')
    : runtimeStatus === 'fail'
      ? t('The synthesis check failed. See the Speech synthesis section below for details.',
        '真实合成校验未通过，详情见下方「语音合成可用性」。')
      : t('Tier B checks the response format only. Run tier A below to record a real synthesis result.',
        'B 级仅校验响应格式。执行下方 A 级校验后，此处记录一次真实合成的结果。')

  // 这一次已经跑了多久；不在运行中就为 0。
  const elapsedMs = loading && startedAt ? Date.now() - startedAt : 0
  const clockOf = (ms) => {
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  const renderCheckBlock = (key) => {
    const check = checks[key]
    const status = statusOf(key, check)
    const problems = Array.isArray(check && check.problems) ? check.problems : []
    // 权重道不吃 problems：平台给它的是 note / missing / abs_path。
    //   目录不在、缺哪些文件、目录在哪，平台都查明了，读出来给使用者看，
    //   不让这些落成一句「未知问题」。
    //   缺失清单可能有几十条：数量和来源摊成一句话，名字收进可展开的块，
    //   否则一条 66 个文件名的长句谁也读不下去。
    const weightLines = []
    let weightMissing = []
    if (key === 'checkpoints' && check) {
      weightMissing = Array.isArray(check.missing) ? check.missing : []
      const declared = Array.isArray(check.required) ? check.required.length : 0
      if (weightMissing.length > 0) {
        weightLines.push(t(
          `The manifest declares ${declared} file(s); ${weightMissing.length} of them are not on disk.`,
          `名片声明了 ${declared} 个文件，其中 ${weightMissing.length} 个不在盘上。`))
        // 这份清单的来源必须说清：它是第 4 步按「当时盘上有什么」自动填的快照，
        //   目录内容变了不会自己跟着改，于是第 5 步会一直缺同一批早已不存在的文件名。
        weightLines.push(t(
          'That list is a snapshot auto-filled in step 4 from what was on disk then. If the folder has changed since, edit models.required in step 4 (JSON view) and run the checks again.',
          '这份清单是第 4 步按当时的盘上文件自动填的快照，目录内容变了它不会跟着改。'
            + '若目录已经变过，回第 4 步切到 JSON 视图把 models.required 改成盘上实际的文件，再回来重算。'))
      } else if (typeof check.note === 'string' && check.note) {
        weightLines.push(check.note)
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
          {weightMissing.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary className="field-hint" style={{ cursor: 'pointer' }}>
                {t('Declared but missing on disk', '名片声明了、盘上没有的文件')}（{weightMissing.length}）
              </summary>
              <pre className="rc-cmd-body" style={{ marginTop: 6, maxHeight: 200, overflow: 'auto' }}>
                {weightMissing.join('\n')}
              </pre>
            </details>
          )}
          {key === 'checkpoints' && Array.isArray(check && check.external) && check.external.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="field-hint">
                {t(`${check.external.length} resource(s) are fetched by the engine on first run and are not part of this check.`,
                  `另有 ${check.external.length} 项资源由引擎首次推理时自行拉取，不在此项核对范围内。`)}
              </div>
              {check.external.map((h) => (
                // 一行一条：仓库名长短差很多（charactr/vocos-mel-24khz 比 k2-fsa/ZipVoice 长一倍），
                //   两列布局（.plan-kv 的 120px 定宽左列）会让长仓库名压到右边的时间行上。
                <div className="field-hint" key={`${h.repo}|${h.file}|${h.line}`}
                  style={{ marginLeft: 0, wordBreak: 'break-all' }}>
                  <code>{h.repo}</code> · {h.file}:{h.line} · {h.call}
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
          {loading && !results && (
            <div className="msg msg-info" style={{ marginBottom: 6 }}>
              {t('Running checks…', '正在校验…')}{' '}
              <span className="field-hint" style={{ marginLeft: 0 }}>
                {formatElapsed(elapsedMs)}
              </span>
            </div>
          )}
          {!loading && !results && (
            <div className="msg msg-warn" style={{ marginBottom: 6 }}>
              {t('Checks failed to load. Reload the page, or run the checks again with the button below.',
                '校验结果没有取回来。可以重新加载页面，或用下方按钮再跑一次。')}
            </div>
          )}
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
            {/* 同一份失败连跑两次，结论一字不变 ⇒ 必须留一条「刚刚跑过」的痕迹，
                否则使用者无法判断点击是否生效。 */}
            {lastRun && lastRun.level === 'A' && !loading && (
              <div className="field-hint" style={{ marginTop: 4 }}>
                {t('Last tier A run at ', 'A 级最近一次运行：')}{clockOf(lastRun.at)}
                {' · '}{t('took ', '用时 ')}{formatElapsed(lastRun.ms)}
                {' · '}{lastRun.ok ? t('passed', '通过') : t('failed', '未通过')}
              </div>
            )}
          </div>
          {results && results.post_download_available && (
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
            {t('Tier B checks the response format only; tier A performs a real synthesis and produces the sample shown in the preview below.',
              'B 级仅校验响应格式；A 级执行一次真实合成，并产出下方试听区所用的样本。')}
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
          {deviceDeclared === true && (
            <DeviceSelect
              options={devices}
              value={device}
              onChange={setDevice}
              id={`device-${id || 'engine'}`}
              disabled={loading || measuring}
            />
          )}
          <textarea
            className="control"
            value={synthText}
            onChange={(e) => setSynthText(e.target.value)}
            placeholder={t('Text to synthesise', '要合成的文本')}
            rows={3}
            style={{ marginTop: 6 }}
          />
          {/* 参考音频与文本放在按钮上面：它们留空时宿主当场 400，
              而按钮排在它们上面时，人点完才知道是下面这两格没填。 */}
          {/* 路径框 + 右侧文件夹按钮，与 9886 参数面板的 file 类参数同一套：框是 .field-file-input，
              按钮是 .field-file-pick。差别只在按钮做什么。那边展开素材库清单，这边开系统对话框，
              因为宿主要的是本机绝对路径，而浏览器不给脚本绝对路径（见 ref-upload）。 */}
          <div className="field-file" style={{ marginTop: 6 }}>
            <input
              className="control field-file-input"
              type="text"
              value={refAudio}
              onChange={(e) => setRefAudio(e.target.value)}
              // 离开输入框时把粘贴带上来的引号与首尾空格去掉：留着会让后端把它
              //   当相对路径拼到项目根后面，报出的路径与填进去的完全不像。
              onBlur={() => setRefAudio((cur) => cleanPathInput(cur))}
              placeholder={t('Reference audio path (if the engine requires one)', '参考音频路径（引擎需要时填写）')}
            />
            <button
              className="btn btn-sm field-file-pick"
              type="button"
              disabled={refBusy || !id}
              aria-label={t('Choose the reference audio file', '选择参考音频文件')}
              title={refBusy ? t('Reading the file…', '正在读取文件…') : t('Choose the reference audio file', '选择参考音频文件')}
              onClick={() => { if (refFileInput.current) refFileInput.current.click() }}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.2 1.5H14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1.5 1.5 0 0 1-1.5-1.5z"
                  fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
            </button>
            <input
              ref={refFileInput}
              type="file"
              accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a"
              style={{ display: 'none' }}
              onChange={pickRefAudio}
            />
          </div>
          <div className="field-hint" style={{ marginTop: 'var(--sp-4)', marginLeft: 0 }}>
            {t('Pick a 3–10 second clip of the voice to clone, then fill in its transcript below. Absolute paths are used as-is; relative paths resolve against the project root.',
              '选一段 3~10 秒的真人语音用于克隆音色，并在下面填上这段录音的文字；绝对路径原样使用，相对路径以项目根为准。')}
          </div>
          {refError && (
            <div className="msg msg-danger" style={{ marginTop: 6 }}>{refError}</div>
          )}
          <input
            className="control"
            type="text"
            value={refText}
            onChange={(e) => setRefText(e.target.value)}
            placeholder={t('Transcript of the reference audio (if the engine requires it)', '参考音频对应文本（引擎需要时填写）')}
            style={{ marginTop: 6 }}
          />
          {refs.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="field-hint">
                {t('Or pick one from platform assets; its transcript is filled in too.',
                   '或从平台资产里点选一条，参考文本会一并代填。')}
              </div>
              <div className="ref-list" style={{ maxHeight: 220, overflowY: 'auto' }}>
                {refs.map((r, i) => {
                  const active = refAudio.trim() !== '' && r.reference_audio === refAudio.trim()
                  const oor = r.duration != null && !refInRange(r.duration)
                  return (
                    <div key={`${r.reference_audio}-${i}`}
                      className={`ref-item ${active ? 'active' : ''}`}
                      style={{ cursor: 'pointer' }}
                      title={r.reference_text || r.name}
                      onClick={() => { setRefAudio(r.reference_audio); setRefText(r.reference_text) }}>
                      <div className="ref-item-row">
                        <span className="ref-item-name">{r.name}</span>
                        {r.duration != null && (
                          <span className={`ref-item-dur ${oor ? 'ref-dur-warn' : ''}`}>
                            {r.duration.toFixed(1)}s{oor ? ' \u26a0' : ''}
                          </span>
                        )}
                        <span className="ref-item-mark" style={{ color: active ? 'var(--accent)' : 'var(--muted)' }}>{active ? '\u2713' : '\u2192'}</span>
                      </div>
                      {r.reference_text && (
                        <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.reference_text}
                        </div>
                      )}
                      <AudioPlayer src={`/wizard/verify/ref-file?id=${encodeURIComponent(id || '')}&idx=${i}`} />
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          <button
            className="btn btn-sm btn-primary"
            type="button"
            disabled={loading || !synthText.trim()}
            style={{ marginTop: 6 }}
            onClick={() => runChecks('A', synthRequest())}
          >
            {runningLevel === 'A' ? t('Running…', '正在运行…') : t('Run tier A', '执行 A 级校验')}
          </button>
          {runningLevel === 'A' && (
            <span className="field-hint" style={{ marginLeft: 6 }}>
              {t('elapsed', '已用时间')} {formatElapsed(elapsedMs)}
            </span>
          )}
          <button
            className="btn btn-sm"
            type="button"
            disabled={loading || measuring || !synthText.trim()}
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

      {/* 试听：与平台的生成结果用同一套呈现。一个 section，播放器在上（波形由
          Player 按预览模式画），时长与采样率在框头右侧，下载链接在播放器下方。
          不另立「音频信息」与「波形」两块：平台没有那种分法，两块拼起来也还是这一件事。 */}
      <div className="section">
        <div className="section-hdr">
          <span>{t('Preview', '试听')}</span>
          {wavInfo && (
            // 框头带 text-transform: uppercase，数字与单位跟着变成 1.127S / 24000 HZ。
            //   这一行是数值而不是标签，单独关掉大小写转换。
            <span style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', textTransform: 'none' }}>
              {wavInfo}
            </span>
          )}
        </div>
        <div className="section-body">
          {hasSample ? (
            <div>
              <Player
                src={`/wizard/verify/audio?id=${encodeURIComponent(id)}`}
                duration={checks.audio.wav && checks.audio.wav.duration_sec}
              />
              <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
                <a
                  href={`/wizard/verify/audio?id=${encodeURIComponent(id)}`}
                  download
                  style={{ color: 'var(--accent)', fontSize: 'var(--fs-13)' }}
                >
                  {t('Download WAV', '下载 WAV')}
                </a>
              </div>
            </div>
          ) : (
            <div className="field-hint">
              {t('No sample yet. Run tier A above to produce one.',
                '暂无样本，先执行上方的 A 级校验。')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
