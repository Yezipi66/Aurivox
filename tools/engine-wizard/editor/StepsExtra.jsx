// 第 3 步下载模型及其余步骤面板。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { loadDownloadState, saveDownloadState } from './downloadState'
import { DEFAULT_CONCURRENCY } from './downloadQueue'
import { downloadFiles, readSse, fileSlot } from './downloadRunner'
import { sourceOf, buildCommand, choiceKey, repoPageUrl, repoLinkFromUrl, subdirOf, SOURCES, SOURCE_LABELS } from './downloadSource'
import { ConfirmDialog } from '../../../web/src/components/common/Dialogs'

// 第 3 步（下载模型）：列出远端仓库的文件清单，逐个下载，并显示每个文件在盘上的状态。
// 清单来自上游仓库 API 与第 1 步探测到的仓库地址，不依赖 manifest。
// 落盘路径统一由后端决定（engines/<id>/checkpoints/），前端只传原始命令。

// 下载来源（HF / 魔搭）的判定只有一处：downloadSource.js 的 sourceOf。
//   显示的命令、列清单用的 tool、清单逐行回写的 tool 都从它取。

export function StepModels ({ state, onChange, probe, prep, onFixId, weightsPath }) {
  const { t, lang } = useT()
  const [r, setR] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  // 「从头重装本步」：删的是权重目录里的文件，不可撤回，所以走确认弹窗。
  const [askReset, setAskReset] = React.useState(false)
  const [resetBusy, setResetBusy] = React.useState(false)
  const [resetNote, setResetNote] = React.useState(null)
  const sessionId = (prep && prep.res && prep.res.id) || ''
  React.useEffect(() => {
    if (sessionId && sessionId !== state.id && onFixId) onFixId(sessionId)
  }, [sessionId, state.id])
  const id = sessionId || state.id

  // 下载清单来自 probe（第 1 步），不依赖 manifest。
  // /wizard/models 内部要调 describeModels → resolveEngineProfile，而它需要 manifest，
  // manifest 却要到第 4 步才写。
  const load = async () => {
    if (!id) return
    setBusy(true); setErr(null)
    try {
      // 第 1 步没有探测结果时仍然可以手填模型仓库页或文件直链，
      // 因此这里只取已有数据，不把探测缺失当成整步不可用的错误。
      const cmds = (probe && probe.downloader_cmds) || []
      const scripts = (probe && probe.downloader) || []
      setR({ ok: true, manifest: null, status: null, commands: [], downloader_cmds: cmds, downloader: scripts })
      // 清空之前列出的仓库文件
      setManifest(null)
      setListErrors({})
      setFileList(null)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  // 从头重装：清记录 + 删权重目录。端点回报删了没有与路径，界面据此说结果。
  const doResetStep = async () => {
    if (!id) return
    setResetBusy(true)
    try {
      const resp = await fetch('/wizard/reset-progress', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, section: 'models', removeWeights: true }),
      })
      const j = await resp.json().catch(() => null)
      if (j && j.ok) {
        setResetNote(j.weightsRemoved
          ? t('Cleared the record and deleted ' + (j.weightsPath || weightsPath || '') + '.',
            '已清除下载记录并删除 ' + (j.weightsPath || weightsPath || '') + '。')
          : t('Cleared the record. There was no weights folder on disk, so nothing was deleted.',
            '已清除下载记录；磁盘上没有权重目录，没有文件被删。'))
        load()
        if (onChange) onChange()
      } else {
        setResetNote(t((j && j.error) || 'Reset failed; the record is unchanged.',
          (j && (j.noteZh || j.error)) || '重置失败，记录没有被清掉。'))
      }
    } catch (e) {
      setResetNote(t('Could not reach the wizard backend; the record is unchanged.',
        '连不上向导后端，记录没有被清掉。'))
    }
    setResetBusy(false)
    setAskReset(false)
  }

  // 下载状态（SSE 流式）。
  // 声明必须在使用之前：下面的 useEffect 引用了 dlLive，
  // 声明在后面会触发 TDZ（Cannot access 'dlLive' before initialization）。
  //
  // 下载活动按文件分槽记在 dlFiles 里：一个文件名对应一条。
  //   为什么不记成一条全局的进度：同时下几个文件时，全局那条会被后到的进度盖掉，
  //   界面上只剩最后一个文件的进度，其余几个看着像没动。
  //   单文件下载也走这张表（只有一个条目），两处逻辑因此是同一套。
  const [dlFiles, setDlFiles] = React.useState({})
  const [dlBusy, setDlBusy] = React.useState(false)
  const [dlSummary, setDlSummary] = React.useState(null)

  // 整轮下载的汇总（单文件下载时是那一个文件的结果）。
  // dlLive 是它的旧名字，保留是为了少改调用点：内容仍是一句话的状态。
  const dlLive = dlSummary

  // 进行中的文件条目：每个文件一条进度。
  //   同时下几个文件时，只有一条全局进度的话，界面上只剩最后一个文件的进度，
  //   其余几个看着像没动。所以进度按文件名分槽，各占一行。
  const dlEntries = Object.entries(dlFiles)

  // 取消：前端只发取消信号，真正的中断由后端做。
  //   前端自己 abort fetch 是不够的：SSE 断了不代表后端的请求停了。
  const dlCancelRef = React.useRef(false)

  // 远端文件列表（来自 /wizard/download/manifest）
  const [manifest, setManifest] = React.useState(null)
  // 列出文件按仓库分槽：同时列多个仓库时，按钮状态与错误各自归属，
  //   不会出现所有行一起显示「读取中」、错误只剩最后一条。
  const [listingKeys, setListingKeys] = React.useState([])
  const [listErrors, setListErrors] = React.useState({})
  const [runtimeHints, setRuntimeHints] = React.useState([])

  // 去重：默认按「来源 + 仓库 + 下载位置」去掉重复条目，勾选后显示全部
  const [dedup, setDedup] = React.useState(true)

  // 来源判不出的命令（snapshot_download 且同一段代码里看不出是哪个库）由使用者手选。
  //   键见 downloadSource.js 的 choiceKey。
  const [sourceChoices, setSourceChoices] = React.useState({})
  const pickSource = (c, source) => {
    setSourceChoices((prev) => ({ ...prev, [choiceKey(c)]: source }))
  }

  // HF 访问令牌：只知道配置了没有（null = 还没问过后端），令牌本身不进前端状态。
  //   tokenDialog 不为 null 时显示弹窗：{ info: 后端的 GATED 结果或 null, retry: 保存后要重做的事 }。
  const [hfConfigured, setHfConfigured] = React.useState(null)
  const [tokenDialog, setTokenDialog] = React.useState(null)
  React.useEffect(() => {
    fetch('/wizard/hf-token')
      .then((r) => r.json())
      .then((j) => { if (j && j.ok) setHfConfigured(!!j.configured) })
      .catch(() => { /* 端点不通 ⇒ 状态未知，弹窗里照样能填 */ })
  }, [])

  // 持久化：从会话段恢复状态（sessionStorage，键含 id 与 url）。
  // 懒初始化读一次；换 URL / 换引擎 ⇒ 键变 ⇒ 恢复到的是另一段会话。
  React.useEffect(() => {
    if (!id) return
    const saved = loadDownloadState(id, state.repoUrl || '')
    if (saved) {
      if (saved.manifest) setManifest(saved.manifest)
      if (typeof saved.dedup === 'boolean') setDedup(saved.dedup)
      if (saved.pastedRepos) setPastedRepos(saved.pastedRepos)
      if (saved.pastedFiles) setPastedFiles(saved.pastedFiles)
      if (saved.removedCmds) setRemovedCmds(saved.removedCmds)
      if (saved.removedLinks) setRemovedLinks(saved.removedLinks)
      if (saved.sourceChoices) setSourceChoices(saved.sourceChoices)
    }
  }, [id, state.repoUrl])

  React.useEffect(() => { if (id && !r && !busy) load() /* eslint-disable-line */ }, [id])

  // 断点续传：页面加载时读进度文件，恢复「已下载」状态。不依赖 manifest。
  React.useEffect(() => {
    if (!id) return
    fetch(`/wizard/download/progress?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && Array.isArray(j.done) && j.done.length > 0) {
          // 有已完成的命令 → 标记为「已下载」
          setDlSummary({ stage: 'done', ok: true })
        }
      })
      .catch(() => { /* 读不到进度文件 ⇒ 没有已下载的 */ })
  }, [id])

  // 逐文件校验：下载完成后自动调 /wizard/download/files 读文件列表。
  // 不依赖 manifest：直接列 engines/<id>/checkpoints/ 下的文件。
  // 三态：已下载（文件存在且大小 > 0）/ 未下载（文件不存在）/ 不完整（大小为 0）。
  const [fileList, setFileList] = React.useState(null)
  // 跑上游脚本：同一时刻只跑一个，输出留在界面上。
  const [scriptBusy, setScriptBusy] = React.useState(null)
  const [scriptOut, setScriptOut] = React.useState([])
  const [scriptArgs, setScriptArgs] = React.useState({})
  const scriptAbort = React.useRef(null)
  // 第一档：引擎自带的下载 / 部署入口。平台只列出来、执行、显示进度。
  const [engineEntries, setEngineEntries] = React.useState([])
  const [entryBusy, setEntryBusy] = React.useState(null)
  const [entryOut, setEntryOut] = React.useState([])
  const entryAbort = React.useRef(null)
  React.useEffect(() => {
    if (!id) { setEngineEntries([]); return undefined }
    let live = true
    fetch(`/wizard/download-entries?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!live || !j.ok) return
        setEngineEntries(Array.isArray(j.entries) ? j.entries : [])
        setRuntimeHints(Array.isArray(j.runtime_hints) ? j.runtime_hints : [])
      })
      .catch(() => { if (live) { setEngineEntries([]); setRuntimeHints([]) } })
    return () => { live = false }
  }, [id])
  const runEngineEntry = async (e) => {
    if (!id || !e || entryBusy) return
    setEntryBusy(e.key)
    setEntryOut([])
    const controller = new AbortController()
    entryAbort.current = controller
    try {
      const resp = await fetch('/wizard/engine-download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ id, key: e.key, root: window.__PROJECT_ROOT__ || '' }),
      })
      if (!resp.ok) {
        let j = null
        try { j = await resp.json() } catch { /* 不是 JSON 就只报状态码 */ }
        setEntryOut([(j && (j.errorZh || j.error)) || ('HTTP ' + resp.status)])
        return
      }
      let last = null
      await readSse(resp, (ev) => {
        if (!ev) return
        if (typeof ev.text === 'string') setEntryOut((p) => [...p, ev.text].slice(-400))
        if ('ok' in ev || 'error' in ev) last = ev
      })
      if (last && last.ok === false) {
        setEntryOut((p) => [...p, last.errorZh || last.error || `${last.code || 'FAILED'}（退出码 ${String(last.status)}）`])
      }
      refreshFileList()
    } catch (e2) {
      const stopped = e2 && e2.name === 'AbortError'
      setEntryOut((p) => [...p, stopped ? t('Stopped.', '已停止。') : String((e2 && e2.message) || e2)])
    } finally {
      entryAbort.current = null
      setEntryBusy(null)
    }
  }
  const stopEngineEntry = () => { if (entryAbort.current) entryAbort.current.abort() }
  // 两个输入区各两栏：链接与下载位置。仓库页与文件直链都进同一张下载清单，
  //   区别只留在条目的 kind 上，下载时由执行器分流。
  const [repoUrl, setRepoUrl] = React.useState('')
  const [repoDir, setRepoDir] = React.useState('')
  const [directUrl, setDirectUrl] = React.useState('')
  const [directDest, setDirectDest] = React.useState('')
  const [inputNote, setInputNote] = React.useState('')
  const [pastedFiles, setPastedFiles] = React.useState([])
  const [removedCmds, setRemovedCmds] = React.useState([])
  // 三种权重来源放在一个框里切换：前两种把文件加入清单，第三种执行引擎自己的命令。
  const [sourceTab, setSourceTab] = React.useState('engine')
  const refreshFileList = () => {
    if (!id) return
    fetch(`/wizard/download/files?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => { if (j.ok) setFileList(j.files) })
      .catch(() => { /* 读不到 ⇒ 保持原样 */ })
  }
  React.useEffect(() => {
    if (!id || !dlLive || dlLive.stage !== 'done') return
    fetch(`/wizard/download/files?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => { if (j.ok) setFileList(j.files) })
      .catch(() => { /* 读不到 ⇒ 空列表 */ })
  }, [id, dlLive])

  // 远端文件列表：用户点击「列出文件」按钮后加载。
  // 不自动加载：用户主动触发，避免不必要的网络请求。

  const M = (r && r.manifest) || null
  const upstreamScripts = (probe && probe.downloader) || []
  const repoLinks = (probe && probe.repo_links) || []
  // 模型页链接形状固定，识别出来就直接是下载清单里的一条，不必再点一次「加入」。
  //   平台仍不判断哪个链接装的是权重：逐条可移除，也不替人自动下载。
  const [pastedRepos, setPastedRepos] = React.useState([])
  const [removedLinks, setRemovedLinks] = React.useState([])
  const linkCmd = (l) => ({ tool: l.tool, repo: l.repo, dir: null, subdir: l.subdir || '', raw: l.url, from: 'link' })
  const keepLink = (l) => !removedLinks.includes(`${l.tool}|${l.repo}`)
  const upstreamCmds = [
    ...((probe && probe.downloader_cmds) || []),
    ...[...repoLinks, ...pastedRepos].filter(keepLink).map(linkCmd),
  ]

  // 上游脚本按扩展名选解释器：.py 用引擎自己的 venv（依赖装在那里），.sh 用 bash，.js 用 node。
  //   界面只显示解释器种类，绝对路径由服务端决定，不往界面上塞一长串本机路径。
  const sizeLabel = (n) => {
    const v = Number(n) || 0
    if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
    if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`
    return `${v} B`
  }

  const scriptCommand = (file) => {
    const ext = String(file || '').toLowerCase().split('.').pop()
    if (ext === 'sh') return 'bash'
    if (ext === 'js') return 'node'
    return 'python'
  }

  // 跑一个上游脚本：输出逐行透传，执行结束后重读盘上文件。
  const runScript = async (d) => {
    if (!id || !d || !d.file) return
    setScriptBusy(d.file)
    setScriptOut([])
    const controller = new AbortController()
    scriptAbort.current = controller
    try {
      const raw = String(scriptArgs[d.file] || '').trim()
      const resp = await fetch('/wizard/run-script', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          id,
          root: window.__PROJECT_ROOT__ || '',
          file: d.file,
          args: raw ? raw.split(/\s+/) : [],
        }),
      })
      if (!resp.ok) {
        let j = null
        try { j = await resp.json() } catch (e) { /* 不是 JSON 就只报状态码 */ }
        setScriptOut([(j && (j.errorZh || j.error)) || ('HTTP ' + resp.status)])
        return
      }
      let last = null
      await readSse(resp, (ev) => {
        if (!ev) return
        if (typeof ev.text === 'string') setScriptOut((prev) => [...prev, ev.text].slice(-400))
        if ('ok' in ev || 'error' in ev) last = ev
      })
      if (last && last.ok === false) {
        const why = last.errorZh || last.error || `${last.code || 'FAILED'}（退出码 ${String(last.status)}）`
        setScriptOut((prev) => [...prev, why])
      }
      refreshFileList()
    } catch (e) {
      const stopped = e && e.name === 'AbortError'
      const text = stopped ? t('Stopped.', '已停止。') : String((e && e.message) || e)
      setScriptOut((prev) => [...prev, text])
    } finally {
      scriptAbort.current = null
      setScriptBusy(null)
    }
  }

  const stopScript = () => {
    if (scriptAbort.current) scriptAbort.current.abort()
  }

  // 下载位置是相对权重目录的路径：末段带扩展名时当文件名，前面是子目录；
  //   不写文件名就按网址末段命名。带 .. 或绝对路径的一律拒绝，不交给后端猜。
  const splitDest = (raw, urlVal) => {
    const dest = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
    let name = ''
    let subdir = dest
    if (dest) {
      const last = dest.split('/').pop()
      if (/\.[A-Za-z0-9]{1,8}$/.test(last)) {
        name = last
        subdir = dest.slice(0, dest.length - last.length).replace(/\/$/, '')
      }
    }
    if (!name) {
      try { name = decodeURIComponent(new URL(urlVal).pathname.split('/').filter(Boolean).pop() || '') }
      catch { name = '' }
    }
    return { name, subdir }
  }

  const badDest = (subdir) => String(subdir || '').split('/').some((x) => x === '..')
    || /^[A-Za-z]:/.test(String(subdir || ''))

  // 模型仓库区：按主域名识别 Hugging Face 与魔搭，下载位置带进清单条目，
  //   之后列文件时由 subdir 决定这一仓库的文件落在权重目录的哪一层。
  const addRepo = () => {
    const link = repoLinkFromUrl(repoUrl.trim())
    if (!link) {
      setInputNote(t('Fill in a Hugging Face or ModelScope repo page.',
        '请填写 Hugging Face 或魔搭的模型仓库页。'))
      return
    }
    const subdir = repoDir.trim().replace(/\\/g, '/').replace(/^\/+/, '')
    if (badDest(subdir)) {
      setInputNote(t('The destination must stay inside the weights folder.',
        '下载位置只能在权重目录内。'))
      return
    }
    setPastedRepos((prev) => prev.some((x) => x.tool === link.tool && x.repo === link.repo && x.subdir === subdir)
      ? prev : [...prev, { ...link, subdir }])
    setRepoUrl('')
    setRepoDir('')
    const site = link.tool === 'hf' ? 'Hugging Face' : '魔搭'
    const siteEn = link.tool === 'hf' ? 'Hugging Face' : 'ModelScope'
    setInputNote(t(`The ${siteEn} repo ${link.repo} was added to the download list. Use "Probe repo" above to read its files.`,
      `已识别为 ${site} 仓库 ${link.repo}，已加入下载清单；在下方清单里点「列出文件」即可读取文件列表。`))
  }

  // 文件直链区：只收网址与落点，不解析整条命令。
  //   平台用自己的下载器执行，重定向、断点、大小核对、落点保护与仓库文件一致。
  const addDirect = (urlVal, destVal, sizeVal) => {
    const raw = String(urlVal || '').trim()
    if (!raw) return
    if (repoLinkFromUrl(raw)) {
      setInputNote(t('This is a model repo page. Use the model repo box above.',
        '这是模型仓库页，请在上方「模型仓库」区填写。'))
      return
    }
    let u = null
    try { u = new URL(raw) } catch { /* 下面按错误提示处理 */ }
    if (!u || !['http:', 'https:'].includes(u.protocol)) {
      setInputNote(t('Fill in an http(s) file URL.', '请填写 http(s) 文件地址。'))
      return
    }
    const { name, subdir } = splitDest(destVal, raw)
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
      setInputNote(t('The file name cannot be read from this URL. Fill in a destination with a file name.',
        '这个链接读不出文件名，请在下载位置补一个文件名。'))
      return
    }
    if (badDest(subdir)) {
      setInputNote(t('The destination must stay inside the weights folder.',
        '下载位置只能在权重目录内。'))
      return
    }
    setPastedFiles((prev) => prev.some((x) => x.url === raw && x.name === name && x.subdir === subdir)
      ? prev : [...prev, {
        kind: 'url', url: raw, name, subdir, size: Number(sizeVal) || 0,
        repo: '', tool: 'url', status: 'missing', sha256: null,
      }])
    setDirectUrl('')
    setDirectDest('')
    setInputNote(t('Added to the download list. Use "Download all" to fetch it.',
      '已加入下载清单，可执行「下载全部」。'))
  }

  const releaseAssets = (probe && probe.release_assets) || null

  // 保存放在所有清单状态声明之后：依赖数组在渲染时求值，不能引用尚未初始化的 state。
  React.useEffect(() => {
    if (!id) return
    saveDownloadState(id, state.repoUrl || '', {
      manifest, dedup, pastedRepos, pastedFiles, removedCmds, removedLinks, sourceChoices,
    })
  }, [id, state.repoUrl, manifest, dedup, pastedRepos, pastedFiles,
    removedCmds, removedLinks, sourceChoices])

  const seenKeys = new Set()
  // 命令是从哪份文档里读到的：README 只写「去 docs 看」时，实际命令来自安装文档。
  const cmdsFrom = [...new Set(upstreamCmds.map((c) => c && c.from).filter((f) => f && f !== 'link'))]
  // 仓库条目的身份：来源 + 仓库 + 下载位置。同一仓库有两个下载位置时各占一行。
  //   用 c.tool 而不是解析后的来源，来源选择变化不会让已移除的条目重新出现。
  const repoKeyOf = (tool, repo, subdir) => `${tool || ''}|${repo || ''}|${subdir || ''}`
  const cmdKey = (c) => repoKeyOf(c && c.tool, c && c.repo, (c && (c.subdir || subdirOf(c))) || '')
  const visibleCmds = upstreamCmds.filter((c) => {
    if (removedCmds.includes(cmdKey(c))) return false
    if (!dedup) return true
    const key = cmdKey(c)
    if (seenKeys.has(key)) return false
    seenKeys.add(key)
    return true
  })
  const nothingFound = upstreamScripts.length === 0 && visibleCmds.length === 0 &&
    pastedFiles.length === 0 && !(releaseAssets && releaseAssets.assets.length > 0)
  // 一张清单同时容纳三类行：待列文件的仓库、仓库列出的文件、文件直链。
  //   顺序按「仓库 → 它的文件」排，让先列出再下载在一处完成。
  const rows = (() => {
    const files = [
      ...(manifest || []).map((f) => ({
        ...f, kind: 'file', key: 'file:' + repoKeyOf(f.tool, f.repo, f.subdir || '') + '|' + f.name,
      })),
      ...pastedFiles.map((f) => ({
        ...f, key: 'url:' + (f.url || '') + '|' + f.name + '|' + (f.subdir || ''),
      })),
    ]
    const repoRows = visibleCmds.map((c) => {
      const tool = sourceOf(c, sourceChoices)
      const subdir = c.subdir || subdirOf(c) || ''
      const key = repoKeyOf(tool, c.repo, subdir)
      return {
        kind: 'repo', key: 'repo:' + key, cmd: c, cmdKey: cmdKey(c), repo: c.repo, tool, subdir,
        files: files.filter((f) => repoKeyOf(f.tool, f.repo, f.subdir || '') === key),
      }
    })
    const claimed = new Set()
    const out = []
    for (const r of repoRows) {
      out.push(r)
      for (const f of r.files) { out.push(f); claimed.add(f.key) }
    }
    for (const f of files) if (!claimed.has(f.key)) out.push(f)
    return out
  })()
  const rowKey = (f) => f.key
  const removeRow = (f) => {
    if (f.kind === 'url') {
      setPastedFiles((prev) => prev.filter((x) => !(x.url === f.url && x.name === f.name && x.subdir === f.subdir)))
      return
    }
    setManifest((prev) => (prev || []).filter((x) => !(x.name === f.name
      && (x.repo || '') === (f.repo || '') && (x.subdir || '') === (f.subdir || ''))))
  }
  // 移除一个仓库条目：它列出的文件一起下掉，避免留下没有归属的行。
  const removeCmd = (c) => {
    const key = cmdKey(c)
    setRemovedCmds((prev) => (prev.includes(key) ? prev : [...prev, key]))
    const sub = c.subdir || subdirOf(c) || ''
    setManifest((prev) => (prev || []).filter((f) => repoKeyOf(f.tool, f.repo, f.subdir || '')
      !== repoKeyOf(sourceOf(c, sourceChoices), c.repo, sub)))
    if (c.from === 'link') {
      const lk = `${c.tool}|${c.repo}`
      setRemovedLinks((prev) => (prev.includes(lk) ? prev : [...prev, lk]))
      setPastedRepos((prev) => prev.filter((p) => `${p.tool}|${p.repo}` !== lk))
    }
  }
  const linkCmdCount = visibleCmds.filter((c) => c && c.from === 'link').length

  // 列出文件：调 /wizard/download/manifest 获取文件列表。
  // 追加不覆盖：点某个仓库的按钮显示该仓库的文件，再点另一个仓库的按钮追加到列表后面。
  // 同仓库去重：同一个仓库重复点击按钮，忽略。
  const loadManifest = async (c) => {
    const key = cmdKey(c)
    const fail = (msg) => setListErrors((prev) => ({ ...prev, [key]: msg }))
    if (!id || !c || !c.repo) {
      fail(t('Repository information is missing. Please check the upstream README.',
        '仓库信息缺失，请检查上游 README。'))
      return
    }
    const tool = sourceOf(c, sourceChoices)
    if (tool === 'unknown') {
      fail(t('Choose where this command downloads from first (Hugging Face or ModelScope).',
        '请先选择这条命令的下载来源（Hugging Face 或魔搭）。'))
      return
    }
    setListingKeys((prev) => (prev.includes(key) ? prev : [...prev, key]))
    setListErrors((prev) => ({ ...prev, [key]: null }))
    try {
      // 上游把模型放在子目录里时（README 写 --local-dir checkpoints/s2-pro），
      //   清单核对与落盘都要在同一层看：把那一层带给后端。
      // 手填的下载位置直接生效；上游命令里的 --local-dir 仍按原有判据解析。
      const sub = (c && c.subdir) || subdirOf(c)
      const resp = await fetch(`/wizard/download/manifest?id=${encodeURIComponent(id)}&repo=${encodeURIComponent(c.repo)}&tool=${tool}&subdir=${encodeURIComponent(sub)}&root=${encodeURIComponent(window.__PROJECT_ROOT__ || '')}`)
      // 守卫：检查响应是否是有效的 JSON（防止 HTML 错误页面导致 JSON 解析失败）
      if (!resp.ok) {
        fail(t(`Could not list files: HTTP ${resp.status}`, `读取文件列表失败：HTTP ${resp.status}`))
        return
      }
      const contentType = resp.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        fail(t('Could not list files: invalid response', '读取文件列表失败：响应格式错误'))
        return
      }
      const j = await resp.json()
      if (j.ok) {
        setManifest((prev) => {
          // 同仓库去重：如果已经列出过这个仓库，忽略
          if (prev && prev.some((f) => f.repo === c.repo)) return prev
          // 追加：把新文件加到列表后面，带上 repo 与来源。来源写判定后的 hf / modelscope，
          //   不写命令形态（snapshot）：下载时后端只认这两个值。
          const newFiles = j.files.map((f) => ({ ...f, repo: c.repo, tool, subdir: f.subdir || sub }))
          return [...(prev || []), ...newFiles]
        })
      } else if (j.code === 'GATED') {
        // 私有仓库不带令牌连清单都列不出：弹窗填令牌，保存后重新列。
        setTokenDialog({ info: j, retry: () => loadManifest(c) })
      } else {
        // 显示错误信息，让用户知道读取失败
        fail(j.error || t('Could not list files', '读取文件列表失败'))
      }
    } catch (e) {
      fail(e.message || t('Could not list files', '读取文件列表失败'))
    } finally { setListingKeys((prev) => prev.filter((x) => x !== key)) }
  }

  // manifest 刷新：把新状态合并回旧表，不整表覆盖。
  // 刷新响应可能缺 repo/tool（旧后端），而旧表里每一项都带着来源：
  // 整表覆盖会把「这个文件属于哪个仓库」抹掉，重下与续传按钮随之失效。
  // 以「仓库 + 文件名」为键：命中就更新状态，不动其他仓库的行。
  const mergeManifest = (prev, fresh, repo, tool) => {
    const freshList = (fresh || []).map((f) => ({
      ...f,
      repo: f.repo || repo,
      tool: f.tool || tool,
    }))
    if (!Array.isArray(prev) || prev.length === 0) return freshList
    // 用传入的 repo 作为 fallback，确保 prev 里的文件也有 repo
    const key = (f) => `${f.repo || repo}|${f.name}`
    const byKey = new Map(freshList.map((f) => [key(f), f]))
    const merged = prev.map((f) => {
      const freshFile = byKey.get(key(f))
      if (!freshFile) {
        return {
          ...f,
          repo: f.repo || repo,
          tool: f.tool || tool,
        }
      }
      // 保留旧的 sha256 值（当新值为 null 时）
      return {
        ...freshFile,
        sha256: freshFile.sha256 || f.sha256 || null,
      }
    })
    const seen = new Set(prev.map(key))
    for (const f of freshList) if (!seen.has(key(f))) merged.push(f)
    return merged
  }

  // 下载全部：把没下载完的文件一次性交给执行器，它按并发上限分批派。
  //   用 ref 追踪下载状态，避免闭包读到旧的 state 值。
  const dlBusyRef = React.useRef(false)
  // 暂停只停前端的派单，不终止在途的请求：当前文件下载中杀进程会留下不完整的文件，
  // 而远端下载器自带缓存，重跑同一条命令只补缺的部分。
  // 所以界面上必须写清楚「当前文件下载中，暂停将在当前文件完成后生效」，
  // 不写清楚就是让使用者以为点了就停。
  const dlPausedRef = React.useRef(false)
  const [dlPaused, setDlPaused] = React.useState(false)

  // 进度按文件的完整身份分槽：同名文件来自不同仓库或不同下载位置时互不覆盖。
  const setFileProgress = (name, ev, slot, label) => {
    const key = slot || name
    setDlFiles((prev) => ({
      ...prev,
      [key]: { ...(prev[key] || {}), label: label || name,
        percent: ev.percent, downloaded: ev.downloaded, total: ev.total },
    }))
  }

  // 某个文件结束：记下结果，成功就把这一行的状态改成「已下载」。
  const setFileDone = (name, result, slot, label) => {
    const key = slot || name
    setDlFiles((prev) => ({
      ...prev,
      [key]: { ...(prev[key] || {}), label: label || name,
        done: true, ok: result && result.ok === true, code: result && result.code,
        noteZh: result && result.noteZh, error: result && result.error },
    }))
    if (result && result.ok) {
      setPastedFiles((prev) => prev.map((f) => (fileSlot(f) === key ? { ...f, status: 'ok' } : f)))
    }
    if (result && result.ok && id) {
      // 下载完成后自动刷新清单（合并刷新，不整表覆盖）
      fetch(`/wizard/download/files?id=${encodeURIComponent(id)}`)
        .then((r) => r.json())
        .then((j) => { if (j.ok) setFileList(j.files) })
        .catch(() => { /* 读不到 ⇒ 空列表 */ })
    }
  }

  // 一次列出上游 README 给的每个仓库。README 常把权重拆在多个仓库里
  // （主模型一个、辅助模型另一个），逐个点「列出文件」时容易只点第一个，
  // 后面的仓库与它的文件就整个漏掉。同仓库去重由 loadManifest 负责。
  const listAll = async () => {
    const seen = new Set()
    for (const c of visibleCmds) {
      const tool = sourceOf(c, sourceChoices)
      if (!c || !c.repo || tool === 'unknown') continue
      const key = `${tool}:${c.repo}`
      if (seen.has(key)) continue
      seen.add(key)
      await loadManifest(c)
    }
  }

  // 上游给了几个仓库（按来源与仓库去重）。只有一个时不显示「列出全部」。
  const repoCount = (() => {
    const seen = new Set()
    for (const c of visibleCmds) {
      const tool = sourceOf(c, sourceChoices)
      if (!c || !c.repo || tool === 'unknown') continue
      seen.add(`${tool}:${c.repo}`)
    }
    return seen.size
  })()

  const downloadAll = () => {
    if (rows.length === 0) return
    // 仓库文件按三态挑未完成的；直链条目由前端记完成状态，同样不重复下。
    const filesToDownload = rows.filter((f) => (f.kind === 'url'
      ? f.status !== 'ok'
      : (f.kind === 'file' && (f.status === 'missing' || f.status === 'partial'))))
    if (filesToDownload.length === 0) return
    startDownloads(filesToDownload)
  }

  // 开一轮下载：清掉上一轮的状态再交给 runDownloads。下载全部、单文件、令牌保存后的重试都走这里。
  const startDownloads = (files) => {
    dlBusyRef.current = true
    dlPausedRef.current = false
    dlCancelRef.current = false
    setDlPaused(false)
    setDlBusyBoth(true)
    setDlSummary({ stage: 'start' })
    setDlFiles({})
    runDownloads(files)
  }

  // 执行一批下载：单文件与「下载全部」共用这一条路，界面逻辑因此是同一套。
  const runDownloads = (files) => {
    downloadFiles({
      id,
      root: window.__PROJECT_ROOT__ || '',
      files,
      concurrency: DEFAULT_CONCURRENCY,
      shouldStop: () => dlPausedRef.current || dlCancelRef.current,
      onProgress: setFileProgress,
      onDone: setFileDone,
    }).then((r) => {
      dlBusyRef.current = false
      setDlBusyBoth(false)
      // HF 以授权错误拒绝的文件：弹窗让使用者填令牌（或去接受许可协议），之后只重下这几个。
      const gated = (r.results || []).filter((x) => x && x.code === 'GATED')
      if (gated.length > 0 && !dlCancelRef.current) {
        const names = new Set(gated.map((x) => x.name))
        const again = files.filter((f) => names.has(f.name))
        setTokenDialog({ info: gated[0], retry: () => startDownloads(again) })
      }
      if (dlCancelRef.current) {
        setDlSummary({ stage: 'cancelled' })
      } else if (dlPausedRef.current) {
        setDlSummary({ stage: 'paused' })
      } else if (r.ok) {
        setDlSummary({ stage: 'done', ok: true })
      } else {
        setDlSummary({ stage: 'done', ok: false, error: r.firstError, errorZh: r.firstErrorZh })
      }
    })
  }

  const pauseDownload = () => {
    dlPausedRef.current = true
    setDlPaused(true)
  }

  // 取消：停掉整轮下载。
  //   前端只负责不再派新任务并通知后端；真正的中断由后端做
  //   （前端 abort fetch 只是断了 SSE，后端的请求照跑）。
  const cancelDownload = () => {
    dlCancelRef.current = true
    dlPausedRef.current = true
    setDlPaused(true)
    fetch('/wizard/download/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => { /* 取消信号发不出去也不影响界面状态 */ })
  }

  // 删掉一个不完整的文件，让它回到「未下载」。走同一个 checkFileStatus 判据（后端），
  // 不在这里按大小猜；判为 ok 的不会被删。
  const removePartial = async (f) => {
    if (!f || !f.name) return
    try {
      const resp = await fetch('/wizard/download/file', {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id, name: f.name,
          size: f.size || null, sha256: f.sha256 || null, subdir: f.subdir || '',
          root: window.__PROJECT_ROOT__ || '',
        }),
      })
      const j = await resp.json()
      // 缺信息不等于残缺：没有 sha 可比对时后端不删，如实告诉使用者
      if (j.ok && (j.deleted || []).includes(f.name)) {
        setFileList((list) => list.map((x) => (x.name === f.name
          ? { ...x, status: 'missing', size: 0, sha256: null, shaVerified: false }
          : x)))
      } else {
        setErr(lang === 'zh' ? (j.errorZh || j.error || '未能删除该文件。') : (j.error || 'Could not delete this file.'))
      }
    } catch (e) {
      setErr(lang === 'zh' ? '删除失败，请手动删除该文件。' : 'Delete failed; remove the file manually.')
    }
  }

  // 下载是「发射后不管」的后台任务：点击后启动下载，不阻塞 UI，
  // 用户可以随时进入第 4 步写 manifest（此时下载还在后台跑）。
  // 不用 await：await 会阻塞 UI，用户要等下载完成才能做其他事。
  const setDlBusyBoth = (v) => { dlBusyRef.current = v; setDlBusy(v) }
  // 单文件下载：表格里的「下载 / 续传 / 重下」按钮走这里。
  //   与「下载全部」共用 runDownloads，因此进度分槽、取消、收口是同一套逻辑。
  const runDownload = (c, file) => {
    if (!file || !file.name) return
    // 直链已经下过时，这个按钮是「重新下载」：显式覆盖；首次下载不会覆盖盘上的同名文件。
    const overwrite = file.kind === 'url' && file.status === 'ok' ? { overwrite: true } : {}
    startDownloads([{ ...file, ...overwrite, repo: file.repo || c.repo, tool: file.tool || c.tool }])
  }

  // 令牌弹窗的三个动作。后端只回 { ok, configured }，令牌不回传，前端也不留副本。
  const [tokenBusy, setTokenBusy] = React.useState(false)
  const [tokenErr, setTokenErr] = React.useState(null)
  const closeTokenDialog = () => { setTokenDialog(null); setTokenErr(null) }
  const retryAfterToken = () => {
    const retry = tokenDialog && tokenDialog.retry
    closeTokenDialog()
    if (retry) retry()
  }
  const saveToken = async (token) => {
    setTokenBusy(true); setTokenErr(null)
    try {
      const resp = await fetch('/wizard/hf-token', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const j = await resp.json()
      if (j && typeof j.configured === 'boolean') setHfConfigured(j.configured)
      if (!j || !j.ok) {
        setTokenErr(lang === 'zh' ? ((j && j.errorZh) || '令牌保存失败。') : ((j && j.error) || 'Could not save the token.'))
        return
      }
      retryAfterToken()
    } catch (e) {
      setTokenErr(lang === 'zh' ? '令牌保存失败。' : 'Could not save the token.')
    } finally { setTokenBusy(false) }
  }
  const clearToken = async () => {
    setTokenBusy(true); setTokenErr(null)
    try {
      const resp = await fetch('/wizard/hf-token', { method: 'DELETE' })
      const j = await resp.json()
      if (j && typeof j.configured === 'boolean') setHfConfigured(j.configured)
    } catch (e) {
      setTokenErr(lang === 'zh' ? '令牌清除失败。' : 'Could not remove the token.')
    } finally { setTokenBusy(false) }
  }

  // 统一落盘：所有下载命令的 local_dir 都替换成 engines/<id>/checkpoints/。
  // 不删原目录：hf / modelscope 的缓存在那里，删了要重下。
  // 不替用户决定路径：这是平台统一落盘策略，不是用户可选的。

  return (
    <div className="wz-stack">
      {err && <div className="msg msg-danger">{err}</div>}
      {!id && (
        <div className="msg msg-info">
          {t('Fill in the link first — the model list comes from the upstream README.',
            '请先填写链接，需要下载的模型从上游 README 中提取。')}
        </div>
      )}

      {/* 权重来源：三种入口同属一步动作，放在一个框里切换。
          引擎自带入口执行外部命令、落点由引擎决定；模型仓库与文件直链都把文件加入下方清单。 */}
      {id && (
        <div className="section" style={{ marginTop: 0 }}>
          <div className="section-hdr">
            <h2 style={{ fontSize: 'var(--fs-13)' }}>
              {t('Where the weights come from', '权重来源')}
            </h2>
          </div>
          <div className="section-body">
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
              {[
                { key: 'engine', zh: `引擎自带入口（${engineEntries.length}）`, en: `Engine entries (${engineEntries.length})` },
                { key: 'repo', zh: '模型仓库', en: 'Model repo' },
                { key: 'direct', zh: '文件直链', en: 'Direct file link' },
              ].map((tab) => (
                <button key={tab.key} type="button"
                  className={`btn btn-sm${sourceTab === tab.key ? ' btn-primary' : ''}`}
                  onClick={() => setSourceTab(tab.key)}>
                  {lang === 'zh' ? tab.zh : tab.en}
                </button>
              ))}
            </div>

            {sourceTab === 'engine' && (
              <>
                <div className="field-hint" style={{ marginTop: 0 }}>
                  {t('If the engine ships its own download or setup entry, run it here: the engine knows which extra files it needs and where they go.',
                    '引擎自带下载或部署入口时优先用它，缺哪些运行期资源、文件放在哪里都由引擎自己判断。')}
                </div>
                {engineEntries.length === 0 && (
                  <div className="field-hint">
                    {t('No engine-provided entry was found on disk. Switch to "Model repo" or "Direct file link" above.',
                      '盘上没有找到引擎自带入口，可在上方切到「模型仓库」或「文件直链」。')}
                  </div>
                )}
                {engineEntries.map((e) => {
                  const busy = entryBusy === e.key
                  return (
                    <div key={e.key} style={{ marginTop: 6 }}>
                      <div className="rc-cmd" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <pre className="rc-cmd-body" style={{ flex: 1, margin: 0, minWidth: 180 }}>
                          {(e.argv || []).map(String).join(' ')}
                        </pre>
                        {e.already_deployed && (
                          <span className="badge badge-warn"
                            title={lang === 'zh' ? e.noteZh : e.noteEn}>
                            {t('possibly already deployed in step 2', '第 2 步可能已部署')}
                          </span>
                        )}
                        <button className="btn btn-sm btn-primary" type="button"
                          disabled={!!entryBusy || !id}
                          onClick={() => runEngineEntry(e)}>
                          {busy ? t('Running', '运行中') : t('Run', '运行')}
                        </button>
                        {busy && (
                          <button className="btn btn-sm btn-danger" type="button" onClick={stopEngineEntry}>
                            {t('Stop', '停止')}
                          </button>
                        )}
                      </div>
                      {((lang === 'zh' ? e.noteZh : e.noteEn) || e.noteZh) && (
                        <div className="field-hint" style={{ marginTop: 4 }}>
                          {lang === 'zh' ? (e.noteZh || e.noteEn) : (e.noteEn || e.noteZh)}
                        </div>
                      )}
                    </div>
                  )
                })}
                {entryOut.length > 0 && (
                  <pre className="rc-cmd-body" style={{ marginTop: 6, maxHeight: 220, overflow: 'auto' }}>
                    {entryOut.join('\n')}
                  </pre>
                )}
              </>
            )}

            {sourceTab === 'repo' && (
              <>
                <div className="field-hint" style={{ marginTop: 0 }}>
                  {t('Paste a Hugging Face or ModelScope repo page. The host is detected automatically. The download location is a folder inside the weights folder; added repos join the download list below, where "List files" reads their files.',
                    '填写 Hugging Face 或魔搭的模型仓库页，按网址域名自动识别。下载位置是权重目录内的子目录；加入后进入下方下载清单，点「列出文件」即可读取文件列表。')}
                </div>
                {nothingFound && (
                  <div className="msg msg-warn" style={{ marginTop: 6 }}>
                    {t('No download command, script, repo link or release asset was found in the upstream docs. Add a model repo page or a direct file link here. Many engines fetch weights on first run; use step 5 to check.',
                      '上游文档里没有找到下载命令、脚本、模型仓库链接或 release 资产。可在这里填写模型仓库页或文件直链；很多引擎会在首次推理时自行拉取权重，请用第 5 步校验。')}
                  </div>
                )}
                <div className="rc-cmd" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input className="control" style={{ flex: 1 }} value={repoUrl}
                    placeholder="https://huggingface.co/org/model"
                    onChange={(e) => setRepoUrl(e.target.value)} />
                  <input className="control" style={{ flex: '0 0 200px' }} value={repoDir}
                    placeholder={t('download location (optional)', '下载位置（可空）')}
                    onChange={(e) => setRepoDir(e.target.value)} />
                  <button className="btn btn-sm btn-primary" type="button"
                    disabled={!repoUrl.trim()} onClick={addRepo}>
                    {t('Import repo', '引入仓库')}
                  </button>
                </div>
              </>
            )}

            {sourceTab === 'direct' && (
              <>
                <div className="field-hint" style={{ marginTop: 0 }}>
                  {t('Paste one http(s) file URL. The download location may include a file name, for example sub/model.safetensors; leave it empty to use the file name from the URL and the weights folder root. The platform fetches the file itself, with the same resume and size checks as repo files.',
                    '填写一条 http(s) 文件地址。下载位置可写到文件名，例如 sub/model.safetensors；留空则按网址末段命名并放在权重根目录。平台用自己的下载器取文件，断点续传与大小核对同仓库文件一致。')}
                </div>
                <div className="rc-cmd" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input className="control" style={{ flex: 1 }} value={directUrl}
                    placeholder="https://.../model.safetensors"
                    onChange={(e) => setDirectUrl(e.target.value)} />
                  <input className="control" style={{ flex: '0 0 200px' }} value={directDest}
                    placeholder={t('download location (optional)', '下载位置（可空）')}
                    onChange={(e) => setDirectDest(e.target.value)} />
                  <button className="btn btn-sm btn-primary" type="button"
                    disabled={!directUrl.trim()}
                    onClick={() => addDirect(directUrl.trim(), directDest.trim(), 0)}>
                    {t('Add to list', '加入清单')}
                  </button>
                </div>
              </>
            )}

            {inputNote && (
              <div className="msg msg-info" style={{ marginTop: 6 }}>{inputNote}</div>
            )}
          </div>
        </div>
      )}

      {/* 下载清单表格：仓库文件与文件直链同表，逐行可移除，一次下载全部 */}
      {rows.length > 0 && (
        <>
          <div className="plan-kv">
            <span className="pk">{t('Stored at', '存放位置')}</span>
            <span className="pv">
              <code>engines/{id}/checkpoints/</code>
              <span className="field-hint" style={{ marginLeft: 6 }}>
                {t('or the runtime.checkpoints the manifest declares',
                  '（名片声明了 runtime.checkpoints 时按名片）')}
              </span>
            </span>
          </div>
          {cmdsFrom.length > 0 && (
            <div className="field-hint" style={{ marginTop: 0 }}>
              {t('These repos come from ' + cmdsFrom.join(', ') + ': the README only points there.',
                '这些仓库来自 ' + cmdsFrom.join('、') + '：README 只给了指路。')}
            </div>
          )}
          {linkCmdCount > 0 && (
            <div className="field-hint" style={{ marginTop: 0 }}>
              {t('Some entries come from model repo links in the upstream docs. The platform cannot tell which ones hold weights; remove the ones you do not need before probing.',
                '部分条目来自上游文档中的模型仓库链接。平台无法判断哪些指向权重仓库，列出前请移除不需要的。')}
            </div>
          )}
          {rows.some((f) => f.tool === 'hf') && (
            <div className="plan-kv">
              <span className="pk">{t('HF token', 'HF 令牌')}</span>
              <span className="pv">
                {hfConfigured === true
                  ? t('Configured', '已配置')
                  : hfConfigured === false ? t('Not configured', '未配置') : t('Unknown', '未知')}
                {' '}
                <button className="btn btn-sm" type="button"
                  onClick={() => setTokenDialog({ info: null, retry: null })}>
                  {hfConfigured ? t('Change or clear', '更换或清除') : t('Set', '设置')}
                </button>
              </span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, gap: 8 }}>
            {repoCount > 0 && (
              <button className="btn btn-sm" type="button"
                disabled={listingKeys.length > 0}
                onClick={listAll}
                style={{ flexShrink: 0 }}>
                {t(`List all (${repoCount})`, `列出全部（${repoCount} 个）`)}
              </button>
            )}
            <button
              className="btn btn-sm"
              type="button"
              disabled={dlBusy}
              onClick={downloadAll}
              style={{ flexShrink: 0 }}
            >
              {t('Download all', '下载全部')}
            </button>
            {/* 暂停只停前端的派单，不终止在途的请求。文案必须写清楚
                「当前文件下载中，暂停将在当前文件完成后生效」，不写就是欺骗。 */}
            {dlBusy && (
              <button
                className="btn btn-sm"
                type="button"
                disabled={dlPaused}
                onClick={pauseDownload}
                style={{ flexShrink: 0 }}
              >
                {t('Pause', '暂停')}
              </button>
            )}
            {/* 取消与暂停是两件事：取消会终止在途的请求，
                已经下载完成的文件保留，未完成的文件不保留。 */}
            {dlBusy && (
              <button
                className="btn btn-sm btn-danger"
                type="button"
                disabled={dlCancelRef.current}
                onClick={cancelDownload}
                style={{ flexShrink: 0 }}
              >
                {t('Cancel', '取消')}
              </button>
            )}
          </div>
          {dlBusy && (
            <div className="field-hint" style={{ marginBottom: 8 }}>
              {t(`Downloading up to ${DEFAULT_CONCURRENCY} files at a time. `
                + 'Pausing takes effect after the current files finish — '
                + 'the download requests are not terminated, so resuming reuses '
                + 'what has already been fetched.',
                `同时最多下载 ${DEFAULT_CONCURRENCY} 个文件。`
                + '暂停将在当前这些文件下载完成后生效。'
                + '暂停不会终止下载请求，因此续跑时会复用已下载的部分。')}
            </div>
          )}
          {dlLive && dlLive.stage === 'paused' && (
            <div className="msg msg-info">
              {t('Paused. The remaining files are still marked as not downloaded.',
                '已暂停。剩余文件仍标记为未下载。')}
            </div>
          )}
          {dlLive && dlLive.stage === 'cancelled' && (
            <div className="msg msg-info">
              {t('Cancelled. Files that finished downloading are kept; '
                + 'the ones that did not are marked as not downloaded.',
                '已取消。已下载完成的文件保留，未完成的文件标记为未下载。')}
            </div>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>{t('File', '文件')}</th>
                <th>{t('Source', '来源')}</th>
                <th>{t('Size', '大小')}</th>
                <th>{t('SHA-256', 'SHA-256')}</th>
                <th>{t('Status', '状态')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                if (f.kind === 'repo') {
                  const c = f.cmd
                  const { display, source } = buildCommand(c, sourceChoices)
                  const pickable = c.tool === 'snapshot' && !SOURCES.includes(c.source)
                  const page = repoPageUrl(f.tool, f.repo)
                  const busy = listingKeys.includes(f.cmdKey)
                  const rowError = listErrors[f.cmdKey]
                  return (
                    <React.Fragment key={rowKey(f)}>
                    <tr>
                      <td title={display}>
                        <strong>
                          {page
                            ? <a href={page} target="_blank" rel="noreferrer">{f.repo}</a>
                            : (f.repo || t('(unknown)', '（未知）'))}
                        </strong>
                        {f.subdir ? <span className="field-hint" style={{ marginLeft: 6 }}>{f.subdir}/</span> : null}
                      </td>
                      <td>
                        {pickable ? (
                          <select className="control" value={source === 'unknown' ? '' : source}
                            title={t('The upstream code does not say which library this snapshot_download comes from.',
                              '无法从上游代码判断 snapshot_download 所属的库，请选择下载来源。')}
                            onChange={(e) => pickSource(c, e.target.value)}>
                            <option value="">{t('Choose source', '选择来源')}</option>
                            {SOURCES.map((x) => (
                              <option key={x} value={x}>{SOURCE_LABELS[x][lang === 'zh' ? 'zh' : 'en']}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="badge badge-neutral">
                            {SOURCE_LABELS[f.tool]
                              ? SOURCE_LABELS[f.tool][lang === 'zh' ? 'zh' : 'en']
                              : (f.tool || t('(unknown)', '（未知）'))}
                          </span>
                        )}
                      </td>
                      <td>
                        {f.files.length
                          ? t(`${f.files.length} file(s)`, `${f.files.length} 个文件`)
                          : t('(none yet)', '（尚无）')}
                      </td>
                      <td>{t('(repo)', '（仓库）')}</td>
                      <td>
                        {f.files.length
                          ? <span className="badge badge-ok" title={t('Files listed', '已列出文件')} />
                          : <span className="field-hint" style={{ marginTop: 0 }}>{t('not listed yet', '尚未列出')}</span>}
                      </td>
                      <td>
                        <button className="btn btn-sm" type="button"
                          disabled={busy || source === 'unknown'}
                          onClick={() => loadManifest(c)}>
                          {busy ? t('Listing…', '读取中…') : t('List files', '列出文件')}
                        </button>
                        <button className="btn btn-sm" type="button" style={{ marginLeft: 6 }}
                          title={t('Remove this repo and the files it listed', '移除这个仓库及它列出的文件')}
                          onClick={() => removeCmd(c)}>
                          {t('Remove', '移除')}
                        </button>
                      </td>
                    </tr>
                    {rowError && (
                      <tr>
                        <td colSpan={6} style={{ paddingTop: 0 }}>
                          <div className="msg msg-danger" style={{ marginTop: 4 }}>{rowError}</div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  )
                }
                const cmd = { repo: f.repo || '', tool: f.tool || '' }
                const page = f.kind === 'url' ? null : repoPageUrl(f.tool, f.repo)
                let host = ''
                if (f.kind === 'url') {
                  try { host = new URL(f.url).hostname } catch { host = '' }
                }
                return (
                  <tr key={rowKey(f)}>
                    <td style={{ paddingLeft: 28 }}>
                      <code>{f.name || ''}</code>
                      {f.subdir ? <span className="field-hint" style={{ marginLeft: 6 }}>{f.subdir}/</span> : null}
                    </td>
                    <td>
                      {f.kind === 'url'
                        ? <span>{t('Direct link', '文件直链')}<span className="field-hint" style={{ marginLeft: 6 }}>{host}</span></span>
                        : (
                          <span>
                            {page ? (
                              <a href={page} target="_blank" rel="noreferrer">
                                {f.repo}
                              </a>
                            ) : (f.repo || t('(unknown)', '（未知）'))}
                            {SOURCE_LABELS[f.tool] ? (
                              <span className="field-hint" style={{ marginLeft: 6 }}>
                                {SOURCE_LABELS[f.tool][lang === 'zh' ? 'zh' : 'en']}
                              </span>
                            ) : null}
                          </span>
                        )}
                    </td>
                    <td>
                      {f.size > 0
                        ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
                        : t('(unknown)', '（未知）')}
                    </td>
                    <td>
                      {f.sha256
                        ? <code style={{ fontSize: 'var(--fs-11)' }} title={f.sha256}>{f.sha256.slice(0, 16)}...</code>
                        : t('(unknown)', '（未知）')}
                    </td>
                    <td>
                      {f.status === 'ok' && <span className="badge badge-ok" title={t('Done', '已完成')} />}
                      {f.status === 'partial' && (
                        <span title={
                          lang === 'zh'
                            ? (f.noteZh || '文件不完整，需要续传或重新下载。')
                            : (f.note || 'The file is incomplete — resume or re-download it.')
                        }>⌛</span>
                      )}
                      {f.status === 'missing' && <span className="badge badge-danger" title={t('Missing', '未下载')} />}
                    </td>
                    <td>
                      {f.status === 'partial' && (
                        <button className="btn btn-sm" type="button"
                          disabled={dlBusy}
                          onClick={() => runDownload(cmd, f)}>
                          {t('Resume', '续传')}
                        </button>
                      )}
                      {f.status === 'missing' && (
                        <button className="btn btn-sm" type="button"
                          disabled={dlBusy}
                          onClick={() => runDownload(cmd, f)}>
                          {t('Download', '下载')}
                        </button>
                      )}
                      {f.status === 'ok' && (
                        <button className="btn btn-sm" type="button"
                          disabled={dlBusy}
                          onClick={() => runDownload(cmd, f)}>
                          {t('Re-download', '重新下载')}
                        </button>
                      )}
                      <button className="btn btn-sm" type="button" style={{ marginLeft: 6 }}
                        disabled={dlBusy}
                        title={t('Remove this row from the download list', '从下载清单中移除这一项')}
                        onClick={() => removeRow(f)}>
                        {t('Remove', '移除')}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      {/* 运行期资源：不在上面的清单里，引擎第一次推理时才自行拉取。 */}
      {runtimeHints.length > 0 && (
        <div className="section" style={{ marginTop: 8 }}>
          <div className="section-hdr">
            <h2 style={{ fontSize: 'var(--fs-13)' }}>
              {t('Fetched on first run', '运行期还会自行拉取')}
            </h2>
          </div>
          <div className="section-body">
            <div className="field-hint" style={{ marginTop: 0 }}>
              {t('The engine downloads these on its first inference. They are not in the list above, and the platform does not fetch them. To follow the progress, declare models.post_download.command in the manifest.',
                '引擎第一次推理时会自行下载以下资源。它们不在上方清单里，平台不替引擎下载；需要看到进度，就在名片里声明 models.post_download.command。')}
            </div>
            {runtimeHints.map((h) => (
              <div className="plan-kv" key={`${h.repo}|${h.file}|${h.line}`}>
                <span className="pk"><code>{h.repo}</code></span>
                <span className="pv">
                  <span className="field-hint" style={{ marginLeft: 0 }}>{h.file}:{h.line} · {h.call}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 去重复选框 */}
      {upstreamCmds.length > 1 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <input type="checkbox" checked={dedup}
            onChange={(e) => setDedup(e.target.checked)} />
          <span>{t('Deduplicate by repo and destination', '按仓库与下载位置去重')}</span>
        </label>
      )}

      {/* 进度条：每个文件一条。同时下几个文件时，一条全局进度
          会让其余几个看着像没动，所以这里按文件名分槽。 */}
      {dlBusy && (
        <div className="preflight" style={{ marginTop: 8 }}>
          <div className="layer-label">
            {dlEntries.length > 0
              ? t(`Downloading ${dlEntries.length} file(s)…`, `正在下载 ${dlEntries.length} 个文件…`)
              : t('Starting…', '启动中…')}
          </div>
          {dlEntries.length > 0
            ? dlEntries.map(([key, p]) => {
              const name = p.label || key
              return (
              <div key={key} style={{ marginTop: 6 }}>
                <div className="field-hint" style={{ marginTop: 0 }}>
                  {p.done
                    ? (p.ok && p.code === 'KEPT_EXISTING'
                      ? t(`${name} — already present, kept`, `${name}：已存在，保留未覆盖`)
                      : (p.ok
                        ? t(`${name} — done`, `${name}：完成`)
                        : t(`${name} — failed: ${p.error || ''}`, `${name}：失败（${p.error || ''}）`)))
                    : t(`Downloading ${name} (${p.percent || 0}%)`, `正在下载 ${name} (${p.percent || 0}%)`)}
                </div>
                {!p.done && (
                  <div className="wz-progress">
                    <div className="wz-progress-bar" style={{ width: `${p.percent || 0}%` }} />
                  </div>
                )}
              </div>
              )
            })
            : (
              <div className="wz-progress wz-progress-indeterminate">
                <div className="wz-progress-bar" />
              </div>
            )}
        </div>
      )}
      {dlLive && dlLive.stage === 'done' && (
        <div className={`msg ${dlLive.ok ? 'msg-info' : 'msg-danger'}`}>
          {dlLive.ok
            ? t('Download finished. Re-check to verify.', '下载完成，请重新检查确认。')
            : t('Download failed:', '下载失败：') + ' ' + (lang === 'zh' && dlLive.errorZh ? dlLive.errorZh : (dlLive.error || ''))}
        </div>
      )}

      {/* 逐文件校验结果：三态显示 */}
      {fileList && fileList.length > 0 && (
        <div className="preflight" style={{ marginTop: 8 }}>
          <div className="layer-label">{t('Files on disk', '磁盘上的文件')}</div>
          {fileList.map((f, i) => {
            // 三态由后端判（大小 + 上游 sha），不在这里看大小猜：
            // 大小对但 sha 不符的必须报不完整，只看大小会当成好的。
            // shaVerified 为 false 时不能声称「已校验」。
            const state = f.status === 'ok' ? 'ok' : 'partial'
            const checked = f.shaVerified === true
            return (
              <div key={i} className="pf-row">
                <span className={`badge badge-${state}`}>
                  {state === 'ok' ? '✓' : '◐'}
                </span>
                <span className="pf-val"><code>{f.name}</code></span>
                <span className="field-hint" style={{ marginTop: 0 }}>
                  {f.size > 0
                    ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
                    : t('(empty / partial)', '（空 / 不完整）')}
                  {state === 'ok' && checked
                    ? t(' (sha256 verified)', '（SHA-256 已校验）')
                    : state === 'ok'
                      ? t(' (sha256 not provided by the remote)', '（远端未提供 SHA-256，未校验）')
                      : ''}
                </span>
                {state === 'partial' && (
                  <button className="btn btn-sm" onClick={() => removePartial(f)}>
                    {t('Delete partial and re-download', '删除不完整文件并重新下载')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 上游附带的下载脚本（如果有）：平台按扩展名选解释器，在引擎目录里运行它。 */}
      {upstreamScripts.length > 0 && (
        <div className="section" style={{ marginTop: 4 }}>
          <div className="section-hdr">
            <h2 style={{ fontSize: 'var(--fs-13)' }}>
              {t('Scripts the project ships', '上游附带脚本')}
            </h2>
          </div>
          <div className="section-body">
            <div className="field-hint" style={{ marginTop: 0 }}>
              {t('The script knows where the weights go. Run it in the engine folder; the file list below is refreshed when it ends.',
                '脚本自身包含权重存放位置。在引擎目录内运行，执行结束后将重新读取下方文件清单。')}
            </div>
            {upstreamScripts.map((d) => {
              const cmd = scriptCommand(d.file)
              const busy = scriptBusy === d.file
              return (
                <div key={d.file} style={{ marginTop: 6 }}>
                  <div className="rc-cmd" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <pre className="rc-cmd-body" style={{ flex: 1, margin: 0 }}>{`${cmd} ${d.file}`}</pre>
                    <input className="control" style={{ flex: '0 0 180px' }}
                      value={scriptArgs[d.file] || ''}
                      placeholder={t('extra arguments (optional)', '附加参数（可空）')}
                      disabled={busy}
                      onChange={(e) => setScriptArgs((prev) => ({ ...prev, [d.file]: e.target.value }))} />
                    <button className="btn btn-sm btn-primary" type="button"
                      disabled={!!scriptBusy || !id}
                      onClick={() => runScript(d)}>
                      {busy ? t('Running', '运行中') : t('Run', '运行')}
                    </button>
                    {busy && (
                      <button className="btn btn-sm btn-danger" type="button" onClick={stopScript}>
                        {t('Stop', '停止')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            {scriptOut.length > 0 && (
              <pre className="rc-cmd-body" style={{ marginTop: 6, maxHeight: 220, overflow: 'auto' }}>
                {scriptOut.join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}

      {releaseAssets && releaseAssets.assets.length > 0 && (
        <div className="section" style={{ marginTop: 4 }}>
          <div className="section-hdr">
            <h2 style={{ fontSize: 'var(--fs-13)' }}>
              {t('Packed in the latest release', '上游打包在最新 release 里')}
              {releaseAssets.tag ? ` · ${releaseAssets.tag}` : ''}
            </h2>
          </div>
          <div className="section-body">
            <div className="field-hint" style={{ marginTop: 0 }}>
              {t('These are the files the project attached to its latest release. Download the ones you need into the weights folder.',
                '以下为上游最新 release 附带的文件，可按需下载到权重目录。')}
            </div>
            {releaseAssets.assets.map((a) => (
              <div className="rc-cmd" key={a.url}
                style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <pre className="rc-cmd-body" style={{ flex: 1, margin: 0 }}>{a.name}</pre>
                <span className="field-hint" style={{ margin: 0 }}>{sizeLabel(a.size)}</span>
                <button className="btn btn-sm btn-primary" type="button"
                  disabled={!id}
                  onClick={() => addDirect(a.url, a.name, a.size)}>
                  {t('Add to list', '加入清单')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {tokenDialog && (
        <HfTokenDialog
          info={tokenDialog.info}
          canRetry={!!tokenDialog.retry}
          configured={hfConfigured}
          busy={tokenBusy}
          error={tokenErr}
          onSave={saveToken}
          onClear={clearToken}
          onRetry={retryAfterToken}
          onClose={closeTokenDialog}
        />
      )}

      <ConfirmDialog
        open={askReset}
        danger
        busy={resetBusy}
        title={t('Reinstall this step from the start?', '从头重装本步？')}
        message={t('This clears the record of finished downloads and deletes every file under '
          + (weightsPath || ('engines/' + id + '/checkpoints')) + ', including files you put there yourself. '
          + 'The next download fetches them again.',
          '这会清除本步的下载记录，并删除 ' + (weightsPath || ('engines/' + id + '/checkpoints'))
          + ' 下的全部文件（包括你手动放进去的）；下一次下载会重新取。')}
        confirmLabel={t('Delete and reinstall', '删除文件并重装')}
        onCancel={() => { if (!resetBusy) setAskReset(false) }}
        onConfirm={doResetStep}
      />

      {/* 命令：平台只填好占位符打印出来，不代下载。
          下载清单来自 probe，不依赖 manifest。*/}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm" type="button"
          onClick={() => { load(); if (onChange) onChange() }}
          disabled={busy || !id}>
          {busy ? t('Checking…', '正在检查…') : t('Check again', '重新检查')}
        </button>
        {/* 从头重装本步：清下载记录并删掉权重目录里的文件，下一次下载会重新取。 */}
        {id && (
          <>
            <button className="btn btn-sm btn-danger" type="button"
              disabled={dlBusy}
              onClick={() => setAskReset(true)}>
              {t('Reinstall this step from the start', '从头重装本步')}
            </button>
            <span className="field-hint">
              {t('Clears the record of finished downloads and deletes the files in the weights '
                + 'folder, so they are fetched again.',
                '清除本步的下载记录，并删除权重目录里的文件，下一次下载会重新取。')}
            </span>
          </>
        )}
        {resetNote && (
          <div className="field-hint" style={{ flexBasis: '100%' }}>{resetNote}</div>
        )}
      </div>
    </div>
  )
}

// HF 访问令牌弹窗。形态复用主界面的 .modal-overlay / .modal-card。
//   info 是后端的 GATED 结果（reason 三种，见 core/download.js 的 gatedResult），手动打开时为 null。
//   输入框是受控的局部状态，弹窗关掉就丢；保存走父组件的 onSave，父组件不留副本。
function HfTokenDialog ({ info, canRetry, configured, busy, error, onSave, onClear, onRetry, onClose }) {
  const { t, lang } = useT()
  const [token, setToken] = React.useState('')
  const zh = lang === 'zh'
  const reason = info && info.reason
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card"
        style={{ maxWidth: 560, padding: 20 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="confirm-hdr">
          <span>{t('Hugging Face authorization', 'Hugging Face 授权')}</span>
        </div>
        <div className="confirm-body">
          {info && (
            <p style={{ marginTop: 0 }}>{zh ? (info.errorZh || info.error) : info.error}</p>
          )}
          {reason === 'LICENSE_NOT_ACCEPTED' && info.repoPage && (
            <p>
              <a href={info.repoPage} target="_blank" rel="noreferrer">
                {t('Open the repository page', '打开仓库页面')}
              </a>
              {t(' to accept the license, then retry. Or download the ModelScope mirror instead.',
                '，登录并接受许可后点击「重试」，或改用魔搭镜像。')}
            </p>
          )}
          {reason !== 'LICENSE_NOT_ACCEPTED' && (
            <p style={info ? undefined : { marginTop: 0 }}>
              {t('Create a read token at ', '在 ')}
              <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">
                huggingface.co/settings/tokens
              </a>
              {t('. Enter it only once; failed files are retried after it is saved.',
                ' 创建一个只读令牌。只需填写一次，保存后会自动重试失败的文件。')}
            </p>
          )}
          <div className="field-hint" style={{ marginTop: 0 }}>
            {t('The token is stored only on this computer and is never written to the manifest.',
              '令牌只保存在本机，不会写进名片。')}
            {' '}
            {configured === true
              ? t('Status: configured.', '状态：已配置。')
              : configured === false ? t('Status: not configured.', '状态：未配置。') : ''}
          </div>
          <input className="control" type="password" autoComplete="off" spellCheck={false}
            placeholder={configured ? t('Enter a new token to replace the saved one', '填写新令牌以更换已保存的令牌')
              : t('hf_…', 'hf_…')}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ width: '100%', marginTop: 8 }} />
          {error && <div className="msg msg-danger" style={{ marginTop: 8 }}>{error}</div>}
        </div>
        <div className="confirm-actions">
          <button className="btn btn-sm" type="button" onClick={onClose} disabled={busy}>
            {t('Close', '关闭')}
          </button>
          {configured && (
            <button className="btn btn-sm btn-danger" type="button" onClick={onClear} disabled={busy}>
              {t('Clear token', '清除令牌')}
            </button>
          )}
          {canRetry && reason === 'LICENSE_NOT_ACCEPTED' && (
            <button className="btn btn-sm" type="button" onClick={onRetry} disabled={busy}>
              {t('Retry', '重试')}
            </button>
          )}
          <button className="btn btn-sm btn-primary" type="button"
            disabled={busy || !token.trim()}
            onClick={() => onSave(token.trim())}>
            {canRetry ? t('Save and retry', '保存并重试') : t('Save', '保存')}
          </button>
        </div>
      </div>
    </div>
  )
}



// StepVerify 已移出本文件：它现在自己管三项独立验证，各报各的状态。
export { StepVerify } from './StepVerify'

// 流程条只有五步，不设「装完了怎么用」那一步。
// 它属于文档，不占一个流程步骤：一个只放说明、不执行任何动作的格子是流程条上的一格空话，
// 而且它往往要把内部术语（engines/、Manifest、weights[]）摆到界面上。
// 判据：新增步骤前先问它有没有执行任何动作；没有 ⇒ 那是文档。
