// 第 5 步（verify）：渲染平台四道校验的结果，各自独立呈现，不作为单一通过条件。
// 每项分别报 ok / fail / unknown；缺少素材时如实说明尚未检查，不用占位文案代替。

import React, { useState, useEffect } from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { Player, AudioPlayer } from '../../../web/src/components/common/Player'
import { getPreviewMode, setPreviewMode } from '../../../web/src/lib/previewMode'
import { cleanPathInput, refInRange } from '../../../web/src/lib/refAudio'
import { api } from '../../../web/src/lib/api'
import DeviceSelect from '../../../web/src/components/common/DeviceSelect'
import Stage from './Stage'
import StepCard from './StepCard'
import { REF_MIME } from './paramDrop'
import { MEASURE_POLL_MS, measureStageLabel, formatElapsed, measureRunning } from './measureProgress'
import { readSse } from './downloadRunner'
import { loadSession, saveSession } from './useInstallSession'
import { BOX, BOX_GAP } from './boxStyle'

// 一份校验结果里，语音那道跑的是哪一级（'A' | 'B'）。取不到就当空串：
//   没有 audio 段的结果按「没有档位」处理，不比大小。
const levelOf = (r) => (r && r.checks && r.checks.audio && r.checks.audio.level) || ''

export function StepVerify ({ id, escape, frame }) {
  const { t, lang } = useT()
  // 步骤大框的头由外层按固定步骤传进来；单测直接渲染本组件时不传，给一份等价兜底。
  const stepFrame = frame || { title: t('Verify', '检查'), done: false, onClose: () => {} }
  // 第 5 步的会话段：使用者填的文本与视图开合按引擎存，切页重挂后接回来。
  //   只在挂载时读一次；校验结果与进度是派生数据，不存、靠重取。
  const saved = loadSession(id) || {}
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  // 静态核对（fast）读取中：它比声音检查快得多，但也不能让首屏静默。
  const [preflightLoading, setPreflightLoading] = useState(false)
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
  const [synthText, setSynthText] = useState(saved.synthText || '')
  // 参考音频与参考文本：要参考音频的引擎，A 级与试运行都得带上，否则宿主当场 400。
  //   这里填的是平台的词，后端照名片 maps 换成引擎的参数名（core/measure.js 的 toEngineWords）。
  const [refAudio, setRefAudio] = useState(saved.refAudio || '')
  const [refText, setRefText] = useState(saved.refText || '')
  // 右侧参考音频侧栏：资产在 assets/<voice>/ 下，向导直接读盘（/wizard/assets/*），
  //   不要求平台后端（9886）已启动。取法与 9886 侧栏一致：切片自带对齐文本，
  //   原始音频按文件名取 raw_opt.list 的转写。
  //   每条可拖到左侧参考音频框，路径与文本一次写回，不必手填逐字稿。
  const [voices, setVoices] = useState([])
  const [assetVoice, setAssetVoice] = useState('')
  const [assetSegs, setAssetSegs] = useState([])
  const [assetRaw, setAssetRaw] = useState([])
  const [assetTab, setAssetTab] = useState('slices')
  const [assetSearch, setAssetSearch] = useState('')
  const [assetLoading, setAssetLoading] = useState(false)
  // 取不到资产列表：多数是平台后端（9886）未启动。这一格拿不到东西时要说清原因，
  //   否则界面只剩一个空列表，看起来像「这个资产没有切片」。
  const [assetDown, setAssetDown] = useState(false)
  // 两块机械式检验各自开合：证据默认收起（展开只为看三块原始输出），
  //   结论默认展开（它是进来最想看的结果，收起就回到「刚进来什么也没有」）。
  const [checksOpen, setChecksOpen] = useState(saved.checksOpen === true)
  const [overviewOpen, setOverviewOpen] = useState(saved.overviewOpen !== false)
  // A 级校验的实时输出：点击后立刻开框，一行一行往上堆。
  //   不这样做的话，几十秒的加载与合成期间界面完全静止，
  //   人分不清「正在运行」和「已经卡住」。
  //   每行带 err 标记：stderr 用 .log-line.error 染红，正常的引擎输出保持原色。
  const [streamLines, setStreamLines] = useState([])
  const [streamRunning, setStreamRunning] = useState(false)
  const streamAbort = React.useRef(null)
  // 右侧参考音频抽屉：与第 4 步同一套 Stage Drawer（可收起 / 拖宽 / 全屏）。
  const [rightOpen, setRightOpen] = useState(saved.rightOpen !== false)
  const [rightFull, setRightFull] = useState(saved.rightFull === true)
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
  const [device, setDevice] = useState(saved.device || { kind: 'auto' })
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

  // 右侧栏拖过来的一条参考音频：path 是平台词（assets/<音色>/<目录>/<文件>），
  //   text 来自资产转写。一次写两个 state，与 9886 点选同一语义。
  const applyRef = (path, text) => {
    if (!path) return
    setRefAudio(path)
    setRefText(text || '')
  }
  const onRefDrop = (e) => {
    e.preventDefault()
    let payload = null
    try { payload = JSON.parse(e.dataTransfer.getData(REF_MIME) || '{}') } catch { /* 不是本侧栏拖来的，忽略 */ }
    if (payload && payload.path) applyRef(payload.path, payload.text)
  }
  const refDragStart = (e, path, text) => {
    e.dataTransfer.setData(REF_MIME, JSON.stringify({ path, text: text || '' }))
    e.dataTransfer.effectAllowed = 'copy'
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
  //   只填空的那几格：切页重挂时会话段里已有使用者填的值，不能被默认盖回去。
  //   换引擎时 id 变、重挂读到的是新引擎的会话段，该空就空，预填照常。
  useEffect(() => {
    if (!id) return undefined
    const had = loadSession(id) || {}
    if (!had.synthText) setSynthText(t('Hello! This is a sample line.', '你好，这是一段示例文本。'))
    if (!had.refAudio && !had.refText) {
      fetch(`/wizard/verify/ref?id=${encodeURIComponent(id)}`)
        .then(r => r.json())
        .then((j) => {
          if (j && j.ok && j.reference_audio) setRefAudio(j.reference_audio)
          if (j && j.ok && j.reference_text) setRefText(j.reference_text)
        })
        .catch(() => {})
    }
    return undefined
  }, [id])

  // 写回会话段：使用者填的与视图开合按引擎存，切页重挂接回来。
  //   id 由空变真（刚克隆完）时首帧还没有可归属的引擎，等下一帧再写。
  useEffect(() => {
    if (!id) return
    saveSession(id, '', {
      synthText, refAudio, refText, device,
      checksOpen, overviewOpen, rightOpen, rightFull,
    })
  }, [id, synthText, refAudio, refText, device, checksOpen, overviewOpen, rightOpen, rightFull])

  // 侧栏的音色列表：读平台的注册表 data/voices.json（/wizard/assets/voices 直接读盘）。
  //   底模没有资产目录，默认落到第一个音色，进这一步右侧就有东西可拖，不必先选一次。
  useEffect(() => {
    let live = true
    api('/wizard/assets/voices')
      .then((j) => {
        if (!live || !j) return
        // 形状不对也算「读不到」：只看 HTTP 成功的话，别的版本或别的服务回一份
        //   结构不同的 JSON，会静默变成空列表，看起来像这个项目没有音色资产。
        if (!j.ok || !j.data || !Array.isArray(j.data.voices)) { setAssetDown(true); return }
        setAssetDown(false)
        const usable = j.data.voices.filter((v) => !v.builtin)
        setVoices(usable)
        setAssetVoice((cur) => cur || (usable[0] && usable[0].id) || '')
      })
      .catch(() => { if (live) setAssetDown(true) })
    return () => { live = false }
  }, [])

  // 选中音色后拉它的切片与原始音频：都是向导自己的端点，平台进程不必启动。
  useEffect(() => {
    if (!assetVoice) { setAssetSegs([]); setAssetRaw([]); return undefined }
    let live = true
    setAssetLoading(true)
    Promise.all([
      api(`/wizard/assets/segments?voice=${encodeURIComponent(assetVoice)}`)
        .then((j) => (j && j.ok && j.data.segments && Array.isArray(j.data.segments.segments))
          ? j.data.segments.segments : [])
        .catch(() => []),
      api(`/wizard/assets/raw-list?voice=${encodeURIComponent(assetVoice)}`)
        .then((j) => (j && j.ok && Array.isArray(j.data.raw)) ? j.data.raw : [])
        .catch(() => []),
    ]).then(([segs, raw]) => {
      if (!live) return
      setAssetSegs(segs.filter((s) => s && s.exists !== false
        && (s.audio || s.audio_path || s.audio_filename)))
      setAssetRaw(raw)
    }).finally(() => { if (live) setAssetLoading(false) })
    return () => { live = false }
  }, [assetVoice])

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

  // 结论的「贵贱」顺序：静态核对 < B 级 < A 级。
  //   先回的快结果（静态）不许覆盖已经拿到的更贵结论，
  //   否则先到的 A 级会被后到的静态结论抹掉声音那一项。
  const LEVEL_RANK = { '': 0, B: 1, A: 2 }
  const rankOf = (r) => LEVEL_RANK[levelOf(r)] || 0

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
        // 晚到的、或更便宜的结论不许覆盖已经拿到的更贵结论。补齐权重之后重跑前置要例外：
        //   那时 A 级的结论已经过期，调用方会显式要求覆盖。
        if (!force && rankOf(j) < rankOf(resultsRef.current)) return
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

  // A 级校验的流式版本：点击即开框，边跑边把宿主的输出堆上去。
  //   普通 JSON 端点要等几十秒才回一个响应，那段时间界面完全静止，
  //   人分不清「正在运行」和「已经卡住」。
  const runAudioStream = React.useCallback((request) => {
    if (!id) return
    const t0 = Date.now()
    setLoading(true)
    setRunningLevel('A')
    setStartedAt(t0)
    setStreamLines([])
    setStreamRunning(true)
    if (streamAbort.current) {
      try { streamAbort.current.abort() } catch { /* 旧的已经断了 */ }
    }
    const ctrl = new AbortController()
    streamAbort.current = ctrl
    const q = new URLSearchParams({ id })
    if (request) q.set('request', JSON.stringify(request))

    const handleEvent = (ev, payload) => {
      if (ev === 'line') {
        // 一个 chunk 可能带多行：拆成一行一个节点，染色才落得到行上。
        //   只留最近 600 行：整段日志的价值在「刚刚发生了什么」，
        //   无限堆下去会把内存和滚动条一起拖垮。
        const parts = String(payload.text || '')
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
        if (parts.length) {
          const err = !!payload.err
          setStreamLines((cur) => [
            ...cur.slice(-600),
            ...parts.map((text) => ({ text, err })),
          ])
        }
      } else if (ev === 'result' && payload && payload.checks) {
        const prev = resultsRef.current || {}
        const next = { ...prev, checks: { ...(prev.checks || {}), ...payload.checks } }
        resultsRef.current = next
        setResults(next)
        const audio = payload.checks.audio || {}
        setLastRun({ level: 'A', at: t0, ms: Date.now() - t0, ok: audio.ok === true })
      }
    }

    fetch(`/wizard/verify/audio-stream?${q.toString()}`, { signal: ctrl.signal })
      .then(async (resp) => {
        if (!resp.body || !resp.body.getReader) throw new Error('stream is not supported here')
        const reader = resp.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          // SSE 以空行分隔事件；一次读可能拿到半个，攒够再切。
          let cut = buf.indexOf('\n\n')
          while (cut >= 0) {
            const chunk = buf.slice(0, cut)
            buf = buf.slice(cut + 2)
            let ev = 'message'
            let data = ''
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event: ')) ev = line.slice(7)
              else if (line.startsWith('data: ')) data += line.slice(6)
            }
            if (data) {
              try { handleEvent(ev, JSON.parse(data)) } catch { /* 不完整的 JSON 丢掉 */ }
            }
            cut = buf.indexOf('\n\n')
          }
        }
      })
      .catch((e) => {
        if (e && e.name === 'AbortError') return
        setStreamLines((cur) => [...cur, `\n${String((e && e.message) || e)}\n`])
      })
      .finally(() => {
        setLoading(false)
        setRunningLevel(null)
        setStreamRunning(false)
        streamAbort.current = null
      })
  }, [id])

  // 先读状态：只做纯查盘的两道（解释器/入口在不在、权重齐不齐），本机毫秒级。
  //   读取期间也要有加载提示：哪怕只要一秒，静默的首屏看起来和「刷新了」没有分别。
  const runPreflight = React.useCallback(() => {
    if (!id) return
    setPreflightLoading(true)
    fetch(`/wizard/verify/checks?id=${encodeURIComponent(id)}&fast=1`)
      .then(r => r.json())
      .then((j) => {
        if (rankOf(j) < rankOf(resultsRef.current)) return
        resultsRef.current = j
        setResults(j)
      })
      .catch(() => { /* 静态核对失败不打断后面的检验 */ })
      .finally(() => setPreflightLoading(false))
  }, [id])

  // 「重新检验」只重跑这一框的三道静态核对（解释器/入口、模块导入、权重），
  //   不碰语音合成：那一项有自己的 A 级按钮，重跑它要几十秒，混进来就成了「点了没反应」。
  //   端点用 audio=none 而不是 fast=1：fast 会跳过模块导入那道，重新检验就不能漏掉它。
  const recheckEnvironment = React.useCallback(() => {
    if (!id) return
    setPreflightLoading(true)
    fetch(`/wizard/verify/checks?id=${encodeURIComponent(id)}&audio=none`)
      .then((r) => r.json())
      .then((j) => {
        if (!j || !j.checks) return
        const prev = resultsRef.current || {}
        // 合成那项是另一框的结论，重跑静态核对不许把它抹掉：
        //   以旧结果为底，只覆盖三道静态核对，合成一项原样留下。
        const next = { ...prev, checks: { ...(prev.checks || {}), ...j.checks } }
        resultsRef.current = next
        setResults(next)
      })
      // 请求失败时不覆盖已有结果，避免把已经显示的检查项清成空白。
      .catch(() => {})
      .finally(() => setPreflightLoading(false))
  }, [id])

  // 运行中就按半秒一支表：A 级跑几分钟时，界面必须能看出它仍在运行。
  useEffect(() => {
    if (!loading) return undefined
    const timer = setInterval(() => setPulse((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [loading])

  // 进这一步的顺序：先读状态，再检验。
  //   静态核对先回，界面立刻有「环境 / 模块 / 权重」三项结论；
  //   声音检查随后自己发起，完成后只补 audio 那一项。
  //   反过来做（先检验）会让界面在十几秒里一片空白，像是没读到任何东西。
  useEffect(() => {
    runPreflight()
    runChecks('B', null)
  }, [runPreflight, runChecks])

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
          + (c.detail ? ` · ${pickLang(c.detail, c.detailZh || c.detail)}` : ''))
      }
    }
    return lines
  }

  // env_deep 的三种语义分层：stdout 原文进黑框，诊断结论与办法各占一层，
  //   环境事实单独一组。它们落在 problems 里、用 field-hint 平铺时是一整段，
  //   分不清哪句是引擎输出、哪句是平台判断，所以按后端的结构化副本分开摆。
  const renderImportFindings = (check) => {
    const findings = Array.isArray(check && check.import_diagnostics)
      ? check.import_diagnostics : []
    if (!findings.length) return null
    const info = (check && check.info) || {}

    // 逐条导入结论是探针 JSON 里的 checks 项，不是进程 stdout：探针的 stdout
    //   是协议通道，模块顶层的 print 在导入期被吞。它和另外两道静态核对的明细
    //   性质相同，用同一种 field-hint 平铺，不造一个「输出」黑框冒充原始输出。
    const detailLines = []
    for (const c of (Array.isArray(info.checks) ? info.checks : [])) {
      if (!c) continue
      detailLines.push(
        `${c.module || c.class || ''} · ${c.ok ? t('imported', '导入通过') : t('import failed', '导入失败')}`
        + (c.detail ? ` · ${pickLang(c.detail, c.detailZh || c.detail)}` : ''))
    }
    const causes = findings.map((f) => pickLang(f.causeEn, f.cause)).filter(Boolean)
    const hints = findings.map((f) => pickLang(f.hintEn, f.hint)).filter(Boolean)
    const factLines = []
    if (info.python && info.python.version) factLines.push(t('Python version: ', 'Python 版本：') + info.python.version)
    if (info.paths && info.paths.python) factLines.push(t('Interpreter: ', '解释器：') + info.paths.python)
    // 缺包的安装命令用第 2 步同款命令框给出：venv 路径是探针查到的真实路径，
    //   包名来自诊断结论。两者都在此处填进模板，界面上不留下花括号占位符。
    const venvPython = info.paths && info.paths.python ? info.paths.python : ''
    const installCommands = findings
      .map((f) => f.missingPackage && venvPython
        ? `uv pip install --python ${venvPython} ${f.missingPackage}` : '')
      .filter(Boolean)

    return (
      <>
        {detailLines.map((line, i) => (
          <div className="field-hint" key={`detail-${i}`} style={{ wordBreak: 'break-all' }}>{line}</div>
        ))}
        {causes.map((cause, i) => (
          <div key={`cause-${i}`} className="msg msg-danger" style={{ marginTop: 6 }}>{cause}</div>
        ))}
        {hints.map((hint, i) => (
          <div key={`hint-${i}`} className="field-hint" style={{ marginTop: 4 }}>
            {t('Suggested next step: ', '建议：')}{hint}
          </div>
        ))}
        {installCommands.length > 0 && (
          <div className="rc-cmd" style={{ marginTop: 6 }}>
            <div className="rc-cmd-body" style={{ wordBreak: 'break-all' }}>
              {installCommands.join('\n')}
            </div>
          </div>
        )}
        {factLines.map((line, i) => (
          <div key={`fact-${i}`} className="field-hint" style={{ marginTop: 4, wordBreak: 'break-all' }}>
            {line}
          </div>
        ))}
      </>
    )
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
  // 后端的错误详情是一对字段（英文 + 中文），按当前语言取。
  //   只有中文的老字段作后备：缺了英文时仍显示中文，不显示空白。
  const pickLang = (en, zh) => (lang === 'en' ? (en || zh) : (zh || en))
  // B 级的诊断信息照实给出，但不冒充「真实合成未通过」。
  const tierBDiagnostic = !ranTierA && checks.audio
    ? pickLang(checks.audio.error, checks.audio.errorZh || checks.audio.error) : ''
  // 失败的合成要回答两个问题：为什么、接下来做什么。原文另给一份，
  //   它是唯一能让人自己判断的证据（缺模块名、权重路径、traceback 最后一行都在里面）。
  const audioFailed = !!(checks.audio && checks.audio.ok === false)
  // 三种来源都要认：causeEn/causeZh（新字段成对）、cause/hint 只有中文（老字段）、
  //   error/errorZh（宿主启动失败那条）。英文位优先取 *En，再退到老字段。
  const audioCause = audioFailed
    ? pickLang(
      checks.audio.causeEn || checks.audio.cause || checks.audio.error,
      checks.audio.causeZh || checks.audio.cause || checks.audio.errorZh || checks.audio.error)
    : ''
  const audioHint = audioFailed
    ? pickLang(
      checks.audio.hintEn || checks.audio.hint,
      checks.audio.hintZh || checks.audio.hint) : ''
  // 输出的唯一数据源：运行中用流里的行，结束后（或从后端重取）用结果里那两路拼。
  //   两者都是 {text, err} 行数组，渲染只用一块 .log-view，视觉上不分叉：
  //   结束后不换组件、不换样式，只是不再有新行进来。
  //   detail 是宿主返回的错误响应体，流里没有这一份，所以单独作为一行块排在前面。
  const audioCheck = checks.audio || {}
  // 每次渲染直接算：只有几百行字符串，缓存省不下什么，
  //   而 useMemo 在依赖不变时会复用旧值：热更之后组件还在，
  //   屏幕上留着的仍是依赖未变时缓存下来的旧行（打包文本还原不了）。
  const outputLines = (() => {
    if (streamLines.length) return streamLines
    if (!audioFailed) return []
    const rows = []
    // 有些来源交上来的是序列化过的文本：换行是两个字符（反斜杠 + n），
    //   整段挤成一行。判据是「一个真换行都没有，却含字面转义」才还原，
    //   正常的代码片段里带一个 \n 不会被误拆。
    const unescapeIfPacked = (text) => {
      const raw = String(text)
      if (raw.includes('\n')) return raw
      if (!/\\[rnt]/.test(raw)) return raw
      return raw
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
    }
    const push = (text, err) => {
      // 逐段还原，不能整段判断：一份 detail 里常常前半段是真换行、
      //   后半段（引擎的 traceback）是打包的字面转义。整段看一眼「已经有换行了」
      //   就跳过，后半段会原样留下一串 \r\n。
      for (const segment of String(text).split(/\r?\n/)) {
        for (const line of unescapeIfPacked(segment).split(/\r?\n/)) {
          if (line.length) rows.push({ text: line, err })
        }
      }
    }
    if (audioCheck.detail) push(audioCheck.detail, true)
    if (audioCheck.host_stdout) {
      rows.push({ text: '── stdout ──', err: false })
      push(audioCheck.host_stdout, false)
    }
    if (audioCheck.host_stderr) {
      rows.push({ text: '── stderr ──', err: false })
      push(audioCheck.host_stderr, true)
    }
    return rows
  })()
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
    let weightPartial = []
    if (key === 'checkpoints' && check) {
      weightMissing = Array.isArray(check.missing) ? check.missing : []
      weightPartial = Array.isArray(check.partial) ? check.partial : []
      const staleTmp = Array.isArray(check.stale_tmp) ? check.stale_tmp : []
      const declaredTmp = Array.isArray(check.declared_tmp) ? check.declared_tmp : []
      const declared = Array.isArray(check.required) ? check.required.length : 0
      // 「没下完」与「从没下过」分开说：盘上只有 .tmp 时继续下载即可，
      //   不必从头再取一遍；两样都没有才是真需要下载。
      if (weightPartial.length > 0) {
        weightLines.push(t(
          `${weightPartial.length} of the ${declared} declared file(s) are only partially downloaded: `
          + 'a .tmp resume marker is on disk but the file itself is not. Resume the download in step 3.',
          `名片声明了 ${declared} 个文件，其中 ${weightPartial.length} 个还没下完：`
            + '盘上只有 .tmp 续传标记，正式文件不在。到第 3 步继续下载即可，不必从头重下。'))
      }
      if (weightMissing.length > 0) {
        weightLines.push(t(
          `${weightMissing.length} of the ${declared} declared file(s) are not on disk.`,
          `名片声明了 ${declared} 个文件，其中 ${weightMissing.length} 个不在盘上。`))
        // 这份清单的来源必须说清：它是第 4 步按「当时盘上有什么」自动填的快照，
        //   目录内容变了不会自己跟着改，于是第 5 步会一直缺同一批早已不存在的文件名。
        weightLines.push(t(
          'That list is a snapshot auto-filled in step 4 from what was on disk then. If the folder has changed since, edit models.required in step 4 (JSON view) and run the checks again.',
          '这份清单是第 4 步按当时的盘上文件自动填的快照，目录内容变了它不会跟着改。'
            + '若目录已经变过，回第 4 步切到 JSON 视图把 models.required 改成盘上实际的文件，再回来重算。'))
      }
      if (declaredTmp.length > 0) {
        weightLines.push(t(
          `The manifest lists temporary download names (${declaredTmp.join(', ')}). `
          + 'Those files never exist after a finished download; edit models.required in step 4 to the real file names.',
          `名片里写的是下载临时文件名（${declaredTmp.join('、')}），下载完成后这些名字不会存在。`
            + '回第 4 步把 models.required 改成正式文件名。'))
      }
      if (staleTmp.length > 0) {
        weightLines.push(t(
          `${staleTmp.length} file(s) are present and also have a leftover .tmp next to them. `
          + 'This does not affect the check; the .tmp files can be deleted.',
          `有 ${staleTmp.length} 个文件已就位，旁边还留着 .tmp 临时文件。`
            + '这不影响判定，.tmp 可以删掉。'))
      }
      if (weightPartial.length === 0 && weightMissing.length === 0
        && staleTmp.length === 0 && declaredTmp.length === 0
        && typeof check.note === 'string' && check.note) {
        weightLines.push(pickLang(check.note, check.noteZh || check.note))
      }
      if (typeof check.abs_path === 'string' && check.abs_path) {
        weightLines.push(t('Weights directory: ', '权重目录：') + check.abs_path)
      }
    }
    // env_deep 走结构化分层：stdout 原文、诊断结论、办法与环境事实各占一层。
    //   其余三道没有 import_diagnostics，照旧用 problems 平铺。
    const importFindings = renderImportFindings(check)
    const shown = importFindings
      ? []
      : status === 'fail' || status === 'unknown'
        ? [...weightLines, ...problems.map(renderProblem)]
        : []
    const hasShown = shown.length > 0

    const badge = status === 'ok' ? t('Passed', '通过') : status === 'fail' ? t('Failed', '未通过') : t('Unknown', '未知')

    return (
      <div key={key} style={{ ...BOX, marginTop: 0 }}>
        <div className="field-label" style={{ margin: '0 0 6px', fontWeight: 600 }}>
          {titleOf(key, check)}
          <span className={`badge ${badgeClass(status)}`} style={{ marginLeft: 6 }}>{badge}</span>
        </div>
        <div>
          {check && check.whyZh && (
            <div className="field-hint">{t(check.why, check.whyZh)}</div>
          )}
          {importFindings ? importFindings : status === 'ok' ? (
            <div className="field-hint">
              {key === 'checkpoints'
                ? t('Every weights file named in the manifest is present.',
                  '名片声明的权重文件齐全。')
                : key === 'env_shallow'
                  ? t('The interpreter, the entrypoint and verify.sys_path named in the manifest are on disk.',
                    '名片声明的解释器、推理入口与 verify.sys_path 都在盘上。')
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
          {!importFindings && infoLines(check).map((line, i) => (
            <div className="field-hint" key={i} style={{ wordBreak: 'break-all' }}>{line}</div>
          ))}
          {weightPartial.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary className="field-hint" style={{ cursor: 'pointer' }}>
                {t('Partially downloaded (only .tmp on disk)', '下载未完成（盘上只有 .tmp）')}（{weightPartial.length}）
              </summary>
              <pre className="rc-cmd-body" style={{ marginTop: 6, maxHeight: 200, overflow: 'auto' }}>
                {weightPartial.join('\n')}
              </pre>
            </details>
          )}
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
                {t(`${check.external.length} resource(s) are fetched by the engine on its first inference and are listed here for reference.`,
                  `另有 ${check.external.length} 项资源由引擎首次推理时自行拉取，列举如下。`)}
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

  // 右侧栏：9886 参考音频选择器的向导版。取的是同一份磁盘资产（向导自己读，
  //   见 core/assetsbridge.js），差别只在交付方式：9886 点选，这里额外支持拖到左侧输入框。
  const renderRefSidebar = () => {
    const q = assetSearch.trim().toLowerCase()
    const shownSegs = q
      ? assetSegs.filter((s) => `${s.scene || ''} #${s.index || 0} ${s.text || ''}`.toLowerCase().includes(q))
      : assetSegs
    const shownRaw = q
      ? assetRaw.filter((r) => `${r.filename || ''} ${r.text || ''}`.toLowerCase().includes(q))
      : assetRaw
    const activeName = refAudio.trim() ? refAudio.trim().replace(/\\/g, '/').split('/').pop() : ''
    const segPath = (s) => {
      const fn = String(s.audio || s.audio_path || s.audio_filename || '').replace(/\\/g, '/').split('/').pop()
      return fn ? `assets/${assetVoice}/slicer_opt/${fn}` : ''
    }
    const rawPath = (r) => (r && r.filename) ? `assets/${assetVoice}/raw/${r.filename}` : ''
    // 试听也走向导自己：5199 没有代理 /assets，直接用平台的静态路径会拿到 HTML。
    const fileUrl = (area, name) => `/wizard/assets/file?voice=${encodeURIComponent(assetVoice)}`
      + `&area=${area}&name=${encodeURIComponent(name)}`
    return (
      <div className="wz-drawer-stack">
        <div className="section">
          <div className="section-hdr">
            <span>{t('Reference audio assets', '参考音频资产')}</span>
            <span style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>
              {t('from platform assets', '取自平台资产')}
            </span>
          </div>
          <div className="section-body">
            {assetDown && (
              // 说清是「取不到」而不是「没有」：读不到注册表时这一栏只会是空的，
              //   看起来像这个资产真的没有切片。
              <div className="msg msg-warning" style={{ marginTop: 0, marginBottom: 8 }}>
                {t('Could not read the voice list (data/voices.json); the reference audio path can still be filled in directly.',
                  '读不到音色清单（data/voices.json）；参考音频路径仍可直接填写。')}
              </div>
            )}
            <div className="field">
              <label className="field-label">{t('Voice', '音色')}</label>
              <select className="control" value={assetVoice}
                onChange={(e) => setAssetVoice(e.target.value)}
                disabled={assetLoading || voices.length === 0}>
                {voices.length === 0 && <option value="">{t('No voice assets', '没有音色资产')}</option>}
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>{v.display_name || v.id}</option>
                ))}
              </select>
            </div>
            {assetVoice && (
              <>
                <div className="field">
                  <div className="ref-hdr">
                    <label className="field-label" style={{ margin: 0 }}>{t('Reference', '参考音频')}</label>
                    <div className="ref-tabs">
                      <button className={`ref-tab ${assetTab === 'slices' ? 'active' : ''}`}
                        type="button" onClick={() => setAssetTab('slices')}>
                        {t('Slices', '切片')} <span className="ref-tab-count">{assetSegs.length}</span>
                      </button>
                      <button className={`ref-tab ${assetTab === 'raw' ? 'active' : ''}`}
                        type="button" onClick={() => setAssetTab('raw')}>
                        {t('Raw', '原始')} <span className="ref-tab-count">{assetRaw.length}</span>
                      </button>
                    </div>
                  </div>
                  <input className="control" value={assetSearch}
                    onChange={(e) => setAssetSearch(e.target.value)}
                    placeholder={t('Search name or transcript…', '搜索文件名或转写文本…')}
                    style={{ margin: '4px 0 6px', fontSize: 'var(--fs-12)' }} />
                </div>
                {assetLoading && (
                  <div className="field-hint">{t('Loading reference audio…', '正在加载参考音频…')}</div>
                )}
                {!assetLoading && assetTab === 'slices' && (
                  <div className="ref-list">
                    {shownSegs.length === 0 && <div className="ref-col-empty">{t('No slices', '没有切片')}</div>}
                    {shownSegs.map((s, i) => {
                      const p = segPath(s)
                      const fn = p.split('/').pop()
                      const oor = typeof s.duration === 'number' && !refInRange(s.duration)
                      const active = !!activeName && activeName === fn
                      return (
                        <div key={`${p}-${i}`} className={`ref-item ${active ? 'active' : ''}`}
                          draggable
                          title={oor ? `${s.text || fn}\n⚠ ${s.duration.toFixed(1)}s` : (s.text || fn)}
                          onDragStart={(e) => refDragStart(e, p, s.text || '')}
                          onClick={() => applyRef(p, s.text || '')}
                          style={{ cursor: 'grab' }}>
                          <div className="ref-item-row">
                            <span className="ref-item-name">{s.scene} #{s.index}</span>
                            {typeof s.duration === 'number' && (
                              <span className={`ref-item-dur ${oor ? 'ref-dur-warn' : ''}`}>
                                {s.duration.toFixed(1)}s{oor ? ' ⚠' : ''}
                              </span>
                            )}
                            <span className="ref-item-mark" style={{ color: active ? 'var(--accent)' : 'var(--muted)' }}>
                              {active ? '✓' : '↗'}
                            </span>
                          </div>
                          {s.text && (
                            <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {s.text}
                            </div>
                          )}
                          <AudioPlayer src={fileUrl('slicer_opt', fn)} />
                        </div>
                      )
                    })}
                  </div>
                )}
                {!assetLoading && assetTab === 'raw' && (
                  <div className="ref-list">
                    {shownRaw.length === 0 && <div className="ref-col-empty">{t('No raw audio', '没有原始音频')}</div>}
                    {shownRaw.map((r, i) => {
                      const p = rawPath(r)
                      const active = !!activeName && activeName === r.filename
                      return (
                        <div key={`${p}-${i}`} className={`ref-item ${active ? 'active' : ''}`}
                          draggable
                          title={r.text || r.filename || ''}
                          onDragStart={(e) => refDragStart(e, p, r.text || '')}
                          onClick={() => applyRef(p, r.text || '')}
                          style={{ cursor: 'grab' }}>
                          <div className="ref-item-row">
                            <span className="ref-item-name">{r.filename}</span>
                            <span className="ref-item-mark" style={{ color: active ? 'var(--accent)' : 'var(--muted)' }}>
                              {active ? '✓' : '↗'}
                            </span>
                          </div>
                          {r.text && (
                            <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r.text}
                            </div>
                          )}
                          <AudioPlayer src={fileUrl('raw', r.filename)} />
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className="field-hint" style={{ marginTop: 6, marginLeft: 0 }}>
                  {t('Drag an item onto the reference audio field on the left; its transcript is filled in with it.',
                    '把条目拖到左侧的参考音频输入框，转写文本会一并带上。')}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <Stage
      left={null}
      center={
        <div className="wz-stage-main-inner">
        <StepCard title={stepFrame.title} done={stepFrame.done} onClose={stepFrame.onClose}>
          <div className="wz-stack">
          {escape && (
            <div className="section">
              <div className="section-body">{escape}</div>
            </div>
          )}
          {/* 机械式检验收进同一个大框：先列详细证据，后列结论。
              两块都是机器自动跑出来的检查，与下面要人手填文本、点合成的
              「语音合成可用性」不是一回事，所以合成单独成框。 */}
          <div className="section">
            <div className="section-hdr">
              <h2>{t('Engine runtime checks', '引擎运行环境检验')}</h2>
              <button className="btn btn-sm" type="button"
                disabled={!id || preflightLoading || loading}
                title={t('Re-run the three static environment checks (interpreter, import, weights). This does not run speech synthesis.',
                  '重跑解释器、模块导入与权重三道静态核对，不执行语音合成。')}
                onClick={recheckEnvironment}>
                {preflightLoading
                  ? t('Rechecking…', '重新检验中…')
                  : t('Recheck', '重新检验')}
              </button>
            </div>
            <div className="section-body">
              {/* 证据默认收起：结论就在下面直接给出，展开只为看三块证据。
                  有未通过项时子标题上的徽标照常显示。 */}
              <div className="field-label" role="button" tabIndex={0}
                onClick={() => setChecksOpen(!checksOpen)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setChecksOpen(!checksOpen) }
                }}
                aria-expanded={checksOpen}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{t('Detailed checks', '详细校验项')}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className={`badge ${preflightStatus === 'ok' ? 'badge-ok'
                    : preflightStatus === 'fail' ? 'badge-danger' : 'badge-warn'}`}>
                    {preflightPassed}/{preflightKeys.length} {t('passed', '项通过')}
                  </span>
                  <span className="field-hint" style={{ marginTop: 0 }}>{checksOpen ? '▾' : '▸'}</span>
                </span>
              </div>
              {checksOpen && (
                <div style={{ marginTop: 6 }}>
                  {['env_shallow', 'env_deep', 'checkpoints'].map((key, i) => (
                    <div key={key} style={{ marginTop: i > 0 ? BOX_GAP : 0 }}>
                      {renderCheckBlock(key)}
                    </div>
                  ))}
                </div>
              )}

              {/* 分隔线：上面是详细证据，下面是结论。两块都能折叠，
                  线让「这是两件事」在收起态也看得出来。与第 2/3/4 步同一条横线。 */}
              <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />

              {/* 结论：同样可折叠，默认展开（它是进来最想看的结果）。 */}
              <div className="field-label" role="button" tabIndex={0}
                onClick={() => setOverviewOpen(!overviewOpen)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOverviewOpen(!overviewOpen) }
                }}
                aria-expanded={overviewOpen}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{t('Verification overview', '校验结论')}</span>
                <span className="field-hint" style={{ marginTop: 0 }}>{overviewOpen ? '▾' : '▸'}</span>
              </div>
              {overviewOpen && (
              <div style={{ marginTop: 6 }}>
                {/* 只要有请求未完成就提示：先到的静态结论不等于「校验结束」，
                    声音那一项仍在进行。缺少这条提示时，已有前置结论的界面看起来是静止的。 */}
                {(loading || preflightLoading) && (
                  <div className="msg msg-info" style={{ marginBottom: 6 }}>
                    {t('Running checks…', '正在校验…')}{' '}
                    <span className="field-hint" style={{ marginLeft: 0 }}>
                      {formatElapsed(elapsedMs)}
                    </span>
                  </div>
                )}
                {!loading && !preflightLoading && !results && (
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
              )}
            </div>
          </div>
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
                  <div>{pickLang(checks.audio.error, checks.audio.errorZh || checks.audio.error)}</div>
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
              {/* 输出只有一块：点击「执行 A 级校验」立刻出现，结束后留在原地。
                  不折起来：这一步就是让人看着它在做什么，藏进 details 等于没给。
                  流与结果共用同一个 .log-view，所以结束后不换样子。 */}
              {(streamRunning || outputLines.length > 0) && (
                <div style={{ marginTop: 6 }}>
                  <div className="field-hint" style={{ marginBottom: 4 }}>
                    {t('Live output', '实时输出')}
                  </div>
                  <div className="log-view">
                    {outputLines.length
                      ? outputLines.map((line, i) => (
                        <div key={i} className={`log-line${line.err ? ' error' : ''}`}>
                          {line.text}
                        </div>
                      ))
                      : (
                        <div className="log-line">
                          {t('Starting the host…', '正在启动宿主…')}
                        </div>
                        )}
                  </div>
                </div>
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
              <div className="field-file" style={{ marginTop: 6 }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
                onDrop={onRefDrop}
                title={t('Drop a reference from the right sidebar, or choose a file.', '可从右侧栏拖入参考音频，或选择文件。')}>
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
                {t('Pick a 3–10 second clip of the voice to clone, then fill in its transcript below. Absolute paths are used as-is; relative paths resolve against the project root. You can also drag a reference from the right sidebar; its transcript is filled in for you.',
                  '选一段 3~10 秒的真人语音用于克隆音色，并在下面填上这段录音的文字；绝对路径原样使用，相对路径以项目根为准。也可从右侧栏拖入参考音频，转写文本会一并带上。')}
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
              <button
                className="btn btn-sm btn-primary"
                type="button"
                disabled={loading || !synthText.trim()}
                style={{ marginTop: 6 }}
                onClick={() => runAudioStream(synthRequest())}
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
        </StepCard>
        </div>
      }
      right={renderRefSidebar()}
      open={{ left: false, right: rightOpen }}
      onToggle={(k) => { if (k === 'right') setRightOpen((v) => !v) }}
      full={rightFull}
      onFull={setRightFull}
    />
  )
}
