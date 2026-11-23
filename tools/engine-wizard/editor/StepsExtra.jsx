// 第 3 步下载模型及其余步骤面板。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { loadDownloadState, saveDownloadState } from './downloadState'
import { DEFAULT_CONCURRENCY } from './downloadQueue'
import { downloadFiles, readSse, fileSlot, fileLabel, attachDownloadProgress } from './downloadRunner'
import {
  NOT_DOWNLOADED, DOWNLOADING, DONE, INTERRUPTED,
  startedTask, progressTask, finishedTask, stateFromDisk, needsDownload,
} from './downloadTask'
import { sourceOf, buildCommand, choiceKey, repoPageUrl, repoLinkFromUrl, subdirOf, SOURCES, SOURCE_LABELS } from './downloadSource'
import { ConfirmDialog } from '../../../web/src/components/common/Dialogs'
import Select from '../../../web/src/components/common/Select'
import { BOX } from './boxStyle.js'

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
  // 已提交的全局目标是权威：会话 id 只在目标还没写下来时兜底。
  //   取 state.id 优先于 sessionId：切换引擎后 prep 那一帧还是上一台的
  //   会话，若取反则认了旧 id，下面的 effect 又把它写回全局目标，一次切换
  //   被静默回滚，而界面其它地方（含切换反馈）还停在用户选的那台。
  //   克隆完成时 StepPrepare 自己 onChange({id}) 把目标写好了，不需要这里补。
  const id = state.id || sessionId
  React.useEffect(() => {
    if (!state.id && sessionId && onFixId) onFixId(sessionId)
  }, [sessionId, state.id])

  // 下载清单来自 probe（第 1 步），不依赖 manifest。
  // /wizard/models 内部要调 describeModels → resolveEngineProfile，而它需要 manifest，
  // manifest 却要到第 4 步才写。
  const load = async () => {
    if (!id) return
    setBusy(true); setErr(null)
    try {
      // 重新检查 = 重新抓一遍来源（引擎自带入口 / 模型仓库 / 运行期资源），
      //   不是拿上次缓存的清单糊一遍。抓完再算完成状态（由按钮的 onChange 触发）。
      const r = await fetch(`/wizard/download-entries?id=${encodeURIComponent(id)}`)
      const j = await r.json().catch(() => null)
      if (j && j.ok) {
        setEngineEntries(Array.isArray(j.entries) ? j.entries : [])
        setRuntimeHints(Array.isArray(j.runtime_hints) ? j.runtime_hints : [])
        setRuntimeRepos(Array.isArray(j.repos) ? j.repos : [])
      }
      // 存放位置：后端按「名片 > 快照 > 默认」解析后回一个值，界面不自己算。
      const dr = await fetch(`/wizard/download-dir?id=${encodeURIComponent(id)}`)
      const dj = await dr.json().catch(() => null)
      if (dj && dj.ok) setDirValue(dj.dir)
      // 上游文档里的下载命令来自第 1 步的探测缓存，这里原样铺底（不重新探测）。
      const cmds = (probe && probe.downloader_cmds) || []
      const scripts = (probe && probe.downloader) || []
      setR({ ok: true, manifest: null, status: null, commands: [], downloader_cmds: cmds, downloader: scripts })
      setManifest(null)
      setListErrors({})
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  // 保存存放位置：写快照，然后重算清单（命令的 local_dir 跟着变）。
  const saveDir = async () => {
    if (!id) return
    setDirBusy(true)
    try {
      const resp = await fetch('/wizard/download-dir', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, dir: dirValue }),
      })
      const j = await resp.json().catch(() => null)
      if (j && j.ok) { setDirValue(j.dir); load() } else { setErr(j && j.error) }
    } catch (e) { setErr(e.message) } finally { setDirBusy(false) }
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

  // 每个文件一个任务对象，四态的唯一真相。
  // 声明必须在使用之前：下面的 useEffect 引用了这些状态，声明在后面会触发 TDZ。
  const [dlFiles, setDlFiles] = React.useState({})
  const [dlBusy, setDlBusy] = React.useState(false)

  // 表格行只读这两个函数：有任务记录就认任务状态，没有才用读盘的初始态。
  // 后端续传快照按文件名记，槽位按完整身份记。优先认槽位，快照作为回退。
  const taskOf = (f) => dlFiles[fileSlot(f)] || dlFiles[f.name] || null
  const viewOf = (f) => {
    const task = taskOf(f)
    return task ? task.state : stateFromDisk(f.status)
  }

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
  // 引擎源码里扫到的仓库：与「引擎自带入口」不同，它们没有现成命令可跑，
  //   但和上游命令里的仓库是同一件事，进同一张下载清单。
  const [runtimeRepos, setRuntimeRepos] = React.useState([])

  // 去重：默认按「来源 + 仓库 + 子目录」去掉重复条目，勾选后显示全部
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
  // 第 3 步「存放位置」：可改，写快照 engines/<id>/wizard.json。
  //   与第 4 步名片的 registration.runtime.checkpoints 由后端同一条链取值。
  const [dirValue, setDirValue] = React.useState('')
  const [dirBusy, setDirBusy] = React.useState(false)
  // 两块来源列表可折叠（标题保留、子项收起），默认展开。
  const [builtinOpen, setBuiltinOpen] = React.useState(true)
  const [scannedOpen, setScannedOpen] = React.useState(true)
  const [reposOpen, setReposOpen] = React.useState(true)
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
      if (saved.collapsedRepos) setCollapsedRepos(saved.collapsedRepos)
      if (saved.removedLinks) setRemovedLinks(saved.removedLinks)
      if (saved.sourceChoices) setSourceChoices(saved.sourceChoices)
    }
  }, [id, state.repoUrl])

  // 初次进来才从 probe 组装下载命令。切页回来时会话段里已有恢复的清单，
  //   再 load() 会把 setManifest(saved.manifest) 的结果用 setManifest(null) 冲掉。
  //   所以这里要先看会话段：有存档就不组装，让上面那条恢复 effect 的数据留住。
  React.useEffect(() => {
    if (!id || r || busy) return
    if (loadDownloadState(id, state.repoUrl || '')) return
    load() /* eslint-disable-line */
  }, [id, state.repoUrl])

  // 切页回来时，后端未完成的任务接回同一套状态：先摆出快照，再订阅后续。
  React.useEffect(() => {
    if (!id) return undefined
    let detach = null
    let alive = true
    fetch(`/wizard/download/progress?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive || !j || !j.ok) return
        const active = j.active || {}
        if (!Object.keys(active).length) return
        const restore = (files) => {
          if (!alive || !files) return
          setDlFiles((prev) => {
            const next = { ...prev }
            for (const [name, snap] of Object.entries(files)) {
              next[name] = progressTask(next[name], name, snap)
            }
            return next
          })
        }
        restore(active)
        setDlBusyBoth(true)
        detach = attachDownloadProgress(id, restore, (ok) => {
          if (!alive) return
          setDlFiles((prev) => {
            const next = { ...prev }
            for (const key of Object.keys(next)) {
              if (next[key].state === DOWNLOADING) {
                next[key] = finishedTask(next[key], next[key].label, { ok: ok !== false })
              }
            }
            return next
          })
          setDlBusyBoth(false)
        })
      })
      .catch(() => { /* 读不到进度文件 ⇒ 没有在途任务 */ })
    return () => { alive = false; if (detach) detach() }
  }, [id])

  // 跑上游脚本：同一时刻只跑一个，输出留在界面上。
  const [scriptBusy, setScriptBusy] = React.useState(null)
  const [scriptOut, setScriptOut] = React.useState([])
  const [scriptArgs, setScriptArgs] = React.useState({})
  const scriptAbort = React.useRef(null)
  // 第一档：引擎自带的下载 / 部署入口。平台只列出来、执行、显示进度。
  const [engineEntries, setEngineEntries] = React.useState([])
  const [entryBusy, setEntryBusy] = React.useState(null)
  const [entryOut, setEntryOut] = React.useState([])
  // 命令默认一行（超长省略），点「展开」才看全。命令里有解释器绝对路径，很长。
  const [expandedCmds, setExpandedCmds] = React.useState(() => new Set())
  const toggleCmdExpand = (k) => setExpandedCmds((s) => {
    const n = new Set(s)
    if (n.has(k)) n.delete(k); else n.add(k)
    return n
  })
  const entryAbort = React.useRef(null)
  React.useEffect(() => {
    if (!id) { setEngineEntries([]); setRuntimeHints([]); setRuntimeRepos([]); return undefined }
    let live = true
    fetch(`/wizard/download-entries?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!live || !j.ok) return
        setEngineEntries(Array.isArray(j.entries) ? j.entries : [])
        setRuntimeHints(Array.isArray(j.runtime_hints) ? j.runtime_hints : [])
        setRuntimeRepos(Array.isArray(j.repos) ? j.repos : [])
      })
      .catch(() => {
        if (live) { setEngineEntries([]); setRuntimeHints([]); setRuntimeRepos([]) }
      })
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
    } catch (e2) {
      const stopped = e2 && e2.name === 'AbortError'
      setEntryOut((p) => [...p, stopped ? t('Stopped.', '已停止。') : String((e2 && e2.message) || e2)])
    } finally {
      entryAbort.current = null
      setEntryBusy(null)
    }
  }
  const stopEngineEntry = () => { if (entryAbort.current) entryAbort.current.abort() }
  // 两个输入区各一栏，只填链接。仓库页与文件直链都进同一张下载清单，
  //   区别只留在条目的 kind 上，下载时由执行器分流。
  // 手填条目落在权重根：子目录只来自上游命令的 --local-dir，不在界面上让人写。
  const [repoUrl, setRepoUrl] = React.useState('')
  const [directUrl, setDirectUrl] = React.useState('')
  const [inputNote, setInputNote] = React.useState('')
  const [pastedFiles, setPastedFiles] = React.useState([])
  const [removedCmds, setRemovedCmds] = React.useState([])
  // 仓库行的展开与收起：按仓库键记，切页回来保持原样。
  const [collapsedRepos, setCollapsedRepos] = React.useState([])
  // 清单表的列宽：使用者拖表头右缘决定。只存前四列，最后一列是按钮区，
  //   宽度由按钮本身决定，拖它没有意义。
  const [fileColWidths, setFileColWidths] = React.useState([340, 190, 104, 96])
  const startColResize = (index, e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = fileColWidths[index]
    // 最后一列吸收剩余宽度，这里要给它留出位置：其余列加起来不能把它挤到看不见。
    const table = e.currentTarget.closest('table')
    const wrapWidth = table && table.parentElement ? table.parentElement.clientWidth : 0
    const othersWidth = fileColWidths.reduce((sum, w, i) => (i === index ? sum : sum + w), 0)
    const maxWidth = wrapWidth > 0
      ? Math.max(96, wrapWidth - othersWidth - 210)
      : Number.MAX_SAFE_INTEGER
    const onMove = (ev) => {
      const next = Math.max(64, Math.min(maxWidth, Math.round(startWidth + (ev.clientX - startX))))
      setFileColWidths((prev) => {
        const copy = prev.slice()
        copy[index] = next
        return copy
      })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  // 三种权重来源放在一个框里切换：前两种把文件加入清单，第三种执行引擎自己的命令。
  const [sourceTab, setSourceTab] = React.useState('engine')

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
    // 引擎源码里扫到的仓库走同一条路：它不是「入口」，没有现成命令，
    //   但可以列文件、可以按文件下载，因此进这一栏而不是待在说明文字里。
    ...runtimeRepos.map((r) => ({
      tool: r.tool || 'hf', repo: r.repo, dir: null, subdir: '', raw: '', from: 'runtime',
    })),
  ]

  // 引擎自带的东西有两类：可执行的下载命令，以及源码里写明的权重仓库。
  //   两者都是「引擎告诉我们要装什么」，页签上的数字要把仓库算进去：
  //   只数命令的话，扫到两个仓库、页签仍写 0，看着像什么都没找到。
  const engineProvided = engineEntries.length + runtimeRepos.length

  // 「引擎自带」与「扫出来的下载命令」是两块平行的东西：前者是既有实现（脚本/子命令），
  //   后者是平台扫文档/源码得到的下载命令（按本机环境转写）。两块各自成组，互不所属。
  const builtinEntries = engineEntries.filter((e) => e.kind !== 'cmd')
  const scannedEntries = engineEntries.filter((e) => e.kind === 'cmd')

  // 一组条目按来源文件分组：同一个文件里提出来的命令放一起，不逐条重复「来自 X」。
  //   boxed：独立成块时套 BOX；已经在外层 BOX 里时用细线分组，避免框套框。
  const renderEntryGroups = (list, boxed = true, prefix = '') => {
    const groups = []
    const byWhere = new Map()
    for (const e of list) {
      const k = e.where || ''
      if (!byWhere.has(k)) { byWhere.set(k, []); groups.push([k, byWhere.get(k)]) }
      byWhere.get(k).push(e)
    }
    return groups.map(([where, items]) => (
      <div key={prefix + (where || 'other')} style={{ marginTop: 'var(--sp-8)', paddingTop: 'var(--sp-8)', borderTop: '1px solid var(--border)' }}>
      {where && <div className="field-label" style={{ margin: '0 0 6px', fontWeight: 600 }}>{t('Source', '来源')}：{where}</div>}
      {items.map((e, i) => {
      const busy = entryBusy === e.key
      const expanded = expandedCmds.has(e.key)
      return (
      <div key={e.key} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-8)', flexWrap: 'wrap',
        padding: 'var(--sp-8) 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <pre className="rc-cmd-body" style={{
                flex: 1, margin: 0, minWidth: 180,
                whiteSpace: expanded ? 'pre-wrap' : 'nowrap',
                overflow: expanded ? 'visible' : 'hidden',
                textOverflow: expanded ? 'clip' : 'ellipsis',
                wordBreak: 'break-all',
              }}>
                {(e.argv || []).map(String).join(' ')}
              </pre>
              <button className="btn btn-sm" type="button"
                onClick={() => toggleCmdExpand(e.key)}>
                {expanded ? t('Collapse', '收起') : t('Expand', '展开')}
              </button>
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
          )
        })}
      </div>
    ))
  }

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

  // 文件直链的文件名只从网址末段取，落点固定在权重根。
  //   手填子目录已移除：子目录只来自上游命令的 --local-dir（引擎真实布局）。
  const nameFromUrl = (urlVal) => {
    try { return decodeURIComponent(new URL(urlVal).pathname.split('/').filter(Boolean).pop() || '') }
    catch { return '' }
  }

  // 模型仓库区：按主域名识别 Hugging Face 与魔搭。手贴仓库落在权重根，
  //   上游命令自带的 --local-dir 子目录仍由 subdirOf 解析，两者不冲突。
  const addRepo = () => {
    const link = repoLinkFromUrl(repoUrl.trim())
    if (!link) {
      setInputNote(t('Fill in a Hugging Face or ModelScope repo page.',
        '请填写 Hugging Face 或魔搭的模型仓库页。'))
      return
    }
    setPastedRepos((prev) => prev.some((x) => x.tool === link.tool && x.repo === link.repo)
      ? prev : [...prev, link])
    setRepoUrl('')
    const site = link.tool === 'hf' ? 'Hugging Face' : '魔搭'
    const siteEn = link.tool === 'hf' ? 'Hugging Face' : 'ModelScope'
    setInputNote(t(`The ${siteEn} repo ${link.repo} was added to the download list. Use "Probe repo" above to read its files.`,
      `已识别为 ${site} 仓库 ${link.repo}，已加入下载清单；在下方清单里点「列出文件」即可读取文件列表。`))
  }

  // 文件直链区：只收网址，文件名从网址末段取，落点固定在权重根。
  //   平台用自己的下载器执行，重定向、断点、大小核对、落点保护与仓库文件一致。
  //   nameHint 只给 release 资产用：它的名字来自 GitHub API，比网址末段可靠；
  //   手填直链没有尺寸信息，size 传 0。
  const addDirect = (urlVal, sizeVal, nameHint) => {
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
    const name = String(nameHint || '').trim() || nameFromUrl(raw)
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
      setInputNote(t('The file name cannot be read from this URL.',
        '这个链接读不出文件名。'))
      return
    }
    setPastedFiles((prev) => prev.some((x) => x.url === raw && x.name === name)
      ? prev : [...prev, {
        kind: 'url', url: raw, name, subdir: '', size: Number(sizeVal) || 0,
        repo: '', tool: 'url', status: 'missing', sha256: null,
      }])
    setDirectUrl('')
    setInputNote(t('Added to the download list. Use "Download unfinished" to fetch it.',
      '已加入下载清单，可执行「下载未完成」。'))
  }

  const releaseAssets = (probe && probe.release_assets) || null

  // 保存放在所有清单状态声明之后：依赖数组在渲染时求值，不能引用尚未初始化的 state。
  React.useEffect(() => {
    if (!id) return
    saveDownloadState(id, state.repoUrl || '', {
      manifest, dedup, pastedRepos, pastedFiles, removedCmds, removedLinks, sourceChoices,
      collapsedRepos,
    })
  }, [id, state.repoUrl, manifest, dedup, pastedRepos, pastedFiles,
    removedCmds, removedLinks, sourceChoices, collapsedRepos])

  const seenKeys = new Set()
  // 命令是从哪份文档里读到的：README 只写「去 docs 看」时，实际命令来自安装文档。
  //   来自引擎源码的仓库由下方单独一句说明，不混进「文档指路」这句话里。
  const cmdsFrom = [...new Set(upstreamCmds.map((c) => c && c.from)
    .filter((f) => f && f !== 'link' && f !== 'runtime'))]
  // 仓库条目的身份：来源 + 仓库 + 子目录。同一仓库有两个子目录时各占一行。
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
      for (const f of r.files) { out.push({ ...f, parentRepoKey: r.key }); claimed.add(f.key) }
    }
    for (const f of files) if (!claimed.has(f.key)) out.push(f)
    return out
  })()
  const rowKey = (f) => f.key
  const toggleRepo = (key) => {
    setCollapsedRepos((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]))
  }
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
      // 落点来自上游命令的 --local-dir；手贴仓库落在权重根。
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

  // 下载未完成：把没下完的文件一次性交给执行器，它按并发上限分批派。
  //   用 ref 追踪下载状态，避免闭包读到旧的 state 值。
  const dlBusyRef = React.useRef(false)
  // 暂停只停前端的派单，不终止在途的请求：当前文件下载中杀进程会留下不完整的文件，
  // 而远端下载器自带缓存，重跑同一条命令只补缺的部分。
  // 所以界面上必须写清楚「当前文件下载中，暂停将在当前文件完成后生效」，
  // 不写清楚就是让使用者以为点了就停。
  const dlPausedRef = React.useRef(false)
  const [dlPaused, setDlPaused] = React.useState(false)

  // 进度与结束都写同一个任务对象，状态只由这两个事件改变。
  const setFileProgress = (name, ev, slot, label) => {
    const key = slot || name
    setDlFiles((prev) => ({ ...prev, [key]: progressTask(prev[key], label || name, ev) }))
  }

  const setFileDone = (name, result, slot, label) => {
    const key = slot || name
    setDlFiles((prev) => ({ ...prev, [key]: finishedTask(prev[key], label || name, result) }))
    if (result && result.ok) {
      setPastedFiles((prev) => prev.map((f) => (fileSlot(f) === key ? { ...f, status: 'ok' } : f)))
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
    const filesToDownload = rows.filter((f) =>
      (f.kind === 'file' || f.kind === 'url') && needsDownload(viewOf(f)))
    if (filesToDownload.length === 0) return
    startDownloads(filesToDownload)
  }

  // 单个仓库再下载一遍：显式覆盖，盘上已有的同名文件也重取。
  const reDownloadRepo = (f) => {
    if (!f || !f.files.length) return
    startDownloads(f.files.map((x) => ({
      ...x, overwrite: true, repo: x.repo || f.repo, tool: x.tool || f.tool,
    })))
  }

  // 开一轮下载：先把这批文件标成正在下载，行内立刻有反馈。
  // 不清空任务表，上一轮已经完成的文件要留着绿勾。
  const startDownloads = (files) => {
    dlBusyRef.current = true
    dlPausedRef.current = false
    dlCancelRef.current = false
    setDlPaused(false)
    setDlBusyBoth(true)
    setDlFiles((prev) => {
      const next = { ...prev }
      for (const f of files) {
        const slot = fileSlot(f)
        next[slot] = startedTask(next[slot], fileLabel(f))
      }
      return next
    })
    runDownloads(files)
  }

  // 执行一批下载：单文件与「下载未完成」共用这一条路，界面逻辑因此是同一套。
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

  // 下载是「发射后不管」的后台任务：点击后启动下载，不阻塞 UI，
  // 用户可以随时进入第 4 步写 manifest（此时下载还在后台跑）。
  // 不用 await：await 会阻塞 UI，用户要等下载完成才能做其他事。
  const setDlBusyBoth = (v) => { dlBusyRef.current = v; setDlBusy(v) }
  // 单文件下载：与「下载未完成」共用 runDownloads，四态与进度因此是同一套。
  const runDownload = (c, file) => {
    if (!file || !file.name) return
    // 已完成或已中断后重新取，显式覆盖，后端不会把盘上的同名文件当成别人的而跳过。
    const view = viewOf(file)
    const overwrite = view === DONE || view === INTERRUPTED
    startDownloads([{ ...file, overwrite, repo: file.repo || c.repo, tool: file.tool || c.tool }])
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
            <h2>
              {t('Where the weights come from', '权重来源')}
            </h2>
          </div>
          <div className="section-body">
            {/* 来源切换：三个按钮是互斥的选项，成组摆在上面；
                下面的内容是「选中之后看到什么」，用一条分隔线与按钮组分开，
                否则按钮与说明文字挤在一起，看不出哪部分是开关、哪部分是内容。 */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[
                { key: 'engine', zh: `引擎自带（${engineProvided}）`, en: `From the engine (${engineProvided})` },
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

            <div style={{
              marginTop: 8,
              paddingTop: 8,
              borderTop: '1px solid var(--border)',
            }}>
            {sourceTab === 'engine' && (
              <>
                {builtinEntries.length > 0 && (
                  <div style={{ marginTop: 'var(--sp-8)' }}>
                    <div className="field-label" role="button" tabIndex={0}
                      onClick={() => setBuiltinOpen(!builtinOpen)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBuiltinOpen(!builtinOpen) }
                      }}
                      aria-expanded={builtinOpen}
                      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>{t('Weights the engine declares: a bundled download command can be run directly.',
                        '引擎声明的权重来源：自带下载命令可以直接运行。')}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="badge badge-neutral">{builtinEntries.length} {t('items', '项')}</span>
                        <span className="field-hint" style={{ marginTop: 0 }}>{builtinOpen ? '▾' : '▸'}</span>
                      </span>
                    </div>
                    {builtinOpen && (
                      <div style={{ ...BOX, width: '100%', boxSizing: 'border-box', marginTop: 6 }}>{renderEntryGroups(builtinEntries, false, 'b:')}</div>
                    )}
                  </div>
                )}
                {scannedEntries.length > 0 && (
                  <div style={{ marginTop: 'var(--sp-8)', ...(builtinEntries.length > 0
                    ? { borderTop: '1px solid var(--border)', paddingTop: 'var(--sp-8)' } : null) }}>
                    <div className="field-label" role="button" tabIndex={0}
                      onClick={() => setScannedOpen(!scannedOpen)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setScannedOpen(!scannedOpen) }
                      }}
                      aria-expanded={scannedOpen}
                      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>{t('Download commands declared by the engine, rewritten for this machine (platform environment).',
                        '引擎声明的下载命令；已按本机环境转写成可执行命令。')}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="badge badge-neutral">{scannedEntries.length} {t('items', '项')}</span>
                        <span className="field-hint" style={{ marginTop: 0 }}>{scannedOpen ? '▾' : '▸'}</span>
                      </span>
                    </div>
                    {scannedOpen && (
                      <div style={{ ...BOX, marginTop: 6 }}>{renderEntryGroups(scannedEntries, false, 's:')}</div>
                    )}
                  </div>
                )}
                {engineProvided === 0 && (
                  <div className="msg msg-info" style={{ marginTop: 6 }}>
                    {t('Nothing on disk: no download command, and no weight repo in the source. Add a model repo page or a direct file link above.',
                      '盘上没有自带下载命令，源码里也没找到权重仓库。可在上方切到「模型仓库」或「文件直链」手动添加。')}
                  </div>
                )}
                {runtimeRepos.length > 0 && (
                  <div style={{ marginTop: 'var(--sp-8)', ...((builtinEntries.length > 0 || scannedEntries.length > 0)
                    ? { borderTop: '1px solid var(--border)', paddingTop: 'var(--sp-8)' } : null) }}>
                    <div className="field-label" role="button" tabIndex={0}
                      onClick={() => setReposOpen(!reposOpen)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setReposOpen(!reposOpen) }
                      }}
                      aria-expanded={reposOpen}
                      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>{t('Repos named in the source', '源码里写明的仓库')}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="badge badge-neutral">{runtimeRepos.length} {t('items', '项')}</span>
                        <span className="field-hint" style={{ marginTop: 0 }}>{reposOpen ? '▾' : '▸'}</span>
                      </span>
                    </div>
                    {reposOpen && (
                      <div style={{ ...BOX, marginTop: 6 }}>
                        {runtimeRepos.map((r, i) => (
                          <div key={`${r.tool || 'hf'}|${r.repo}`}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                              padding: 'var(--sp-8) 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                            <span className="badge badge-neutral">
                              {r.tool === 'modelscope' ? 'ModelScope' : 'HuggingFace'}
                            </span>
                            <a href={repoPageUrl(r.tool, r.repo)} target="_blank" rel="noreferrer">
                              <code>{r.repo}</code>
                            </a>
                            <span className="field-hint" style={{ margin: 0 }}>{r.file}:{r.line}</span>
                            <span className="field-hint" style={{ margin: 0 }}>
                              {t('in the download list', '已加入下载清单')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {entryOut.length > 0 && (
                  <div className="log-view" style={{ marginTop: 6 }}>
                    {entryOut.map((l, i) => <div key={i} className="log-line">{l}</div>)}
                  </div>
                )}
              </>
            )}

            {sourceTab === 'repo' && (
              <>
                <div className="field-hint" style={{ marginTop: 0 }}>
                  {t('Paste a Hugging Face or ModelScope repo page. The host is detected automatically. Added repos join the download list below, where "List files" reads their files.',
                    '填写 Hugging Face 或魔搭的模型仓库页，按网址域名自动识别。加入后进入下方下载清单，点「列出文件」即可读取文件列表。')}
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
                  {t('Paste one http(s) file URL. The file name is taken from the last part of the URL and the file lands in the weights folder root. The platform fetches the file itself, with the same resume and size checks as repo files.',
                    '填写一条 http(s) 文件地址。文件名取网址末段，文件放在权重根目录。平台用自己的下载器取文件，断点续传与大小核对同仓库文件一致。')}
                </div>
                <div className="rc-cmd" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input className="control" style={{ flex: 1 }} value={directUrl}
                    placeholder="https://.../model.safetensors"
                    onChange={(e) => setDirectUrl(e.target.value)} />
                  <button className="btn btn-sm btn-primary" type="button"
                    disabled={!directUrl.trim()}
                    onClick={() => addDirect(directUrl.trim(), 0)}>
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
        </div>
      )}

      {/* 下载清单：仓库文件与文件直链同表。整表动作放在框头，与该表同框；
          行内只留逐条操作。落点与令牌是这个框的属性，一起收进来，
          不单独浮在两个框之间。 */}
      {rows.length > 0 && (
        <div className="section">
          <div className="section-hdr">
            <h2>
              {t(`Download list (${rows.length})`, `下载清单（${rows.length}）`)}
            </h2>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {repoCount > 0 && (
                <button className="btn btn-sm" type="button"
                  disabled={listingKeys.length > 0}
                  onClick={listAll}>
                  {t(`List all (${repoCount})`, `列出全部（${repoCount} 个）`)}
                </button>
              )}
              <button
                className="btn btn-sm"
                type="button"
                disabled={dlBusy}
                onClick={downloadAll}
              >
                {t('Download unfinished', '下载未完成')}
              </button>
              {/* 暂停只停前端的派单，不终止在途的请求。文案必须写清楚
                  「当前文件下载中，暂停将在当前文件完成后生效」，不写就是欺骗。 */}
              {dlBusy && (
                <button
                  className="btn btn-sm"
                  type="button"
                  disabled={dlPaused}
                  onClick={pauseDownload}
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
                >
                  {t('Cancel', '取消')}
                </button>
              )}
            </div>
          </div>
          <div className="section-body">
            {/* 存放位置与 HF 令牌是同一组「本步的落点与凭据」，合进同一个 .plan-kv：
                左列由 grid 定宽，两行天然对齐；拆成两个 .plan-kv 再夹提示，左列会错位。
                提示统一放在这两行之后，不插在中间打断对照。 */}
            <div className="plan-kv" style={{ rowGap: 'var(--sp-8)' }}>
              <span className="pk">{t('Stored at', '存放位置')}</span>
              <span className="pv">
                <input className="control" style={{ flex: '0 0 220px' }} value={dirValue}
                  onChange={(e) => setDirValue(e.target.value)}
                  placeholder={t('weights folder inside the engine', '引擎内的权重目录')} />
                <button className="btn btn-sm" type="button" disabled={dirBusy || !id}
                  onClick={saveDir}>{t('Save', '保存')}</button>
                <span className="field-hint" style={{ marginLeft: 6 }}>
                  {t('inside the engine folder; the card overrides it once declared',
                    '引擎目录内；名片声明后以名片为准')}
                </span>
              </span>
              {rows.some((f) => f.tool === 'hf') && (
                <>
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
                </>
              )}
            </div>
            {cmdsFrom.length > 0 && (
              <div className="field-hint" style={{ marginTop: 'var(--sp-6)' }}>
                {t('These repos come from ' + cmdsFrom.join(', ') + ': the README only points there.',
                  '这些仓库来自 ' + cmdsFrom.join('、') + '：README 只给了指路。')}
              </div>
            )}
            {linkCmdCount > 0 && (
              <div className="field-hint" style={{ marginTop: 'var(--sp-4)' }}>
                {t('Some entries come from model repo links in the upstream docs. The platform cannot tell which ones hold weights; remove the ones you do not need before probing.',
                  '部分条目来自上游文档中的模型仓库链接。平台无法判断哪些指向权重仓库，列出前请移除不需要的。')}
              </div>
            )}
            {upstreamCmds.length > 1 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <input type="checkbox" checked={dedup}
                  onChange={(e) => setDedup(e.target.checked)} />
                <span>{t('Deduplicate by repo and subfolder', '按仓库与子目录去重')}</span>
              </label>
            )}
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
            {/* 表格上方一条分隔线：上面的下载状态提示与下面的文件清单是两件事，
                状态在动、清单是结果，挨在一起看不出边界。 */}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }} />
            <div style={{ overflowX: 'auto' }}>
              {/* 列宽固定由左侧拖拽决定：table-layout 必须是 fixed，否则浏览器会按内容
                  重新分配宽度，拖完立刻弹回原样。最后一列不给宽度，让它吸收剩余空间。 */}
              <table className="table wz-file-table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                {fileColWidths.map((w, i) => <col key={`col-${i}`} style={{ width: w }} />)}
                <col />
              </colgroup>
              <thead>
                <tr>
                  {[t('File', '文件'), t('Source', '来源'), t('Size', '大小'), t('Status', '状态')]
                    .map((label, i) => (
                      <th key={label}>
                        {label}
                        <span className="wz-col-resizer" role="separator" aria-orientation="vertical"
                          title={t('Drag to resize this column', '拖动调整这一列的宽度')}
                          onMouseDown={(e) => startColResize(i, e)} />
                      </th>
                    ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => {
                  if (f.parentRepoKey && collapsedRepos.includes(f.parentRepoKey)) return null
                  if (f.kind === 'repo') {
                    const c = f.cmd
                    const { display, source } = buildCommand(c, sourceChoices)
                    const pickable = c.tool === 'snapshot' && !SOURCES.includes(c.source)
                    const page = repoPageUrl(f.tool, f.repo)
                    const busy = listingKeys.includes(f.cmdKey)
                    const rowError = listErrors[f.cmdKey]
                    const collapsed = collapsedRepos.includes(rowKey(f))
                    return (
                      <React.Fragment key={rowKey(f)}>
                      <tr>
                        <td title={display}>
                          <button className="btn btn-sm btn-ghost wz-row-toggle" type="button"
                            aria-expanded={!collapsed}
                            disabled={!f.files.length}
                            title={f.files.length
                              ? (collapsed
                                ? t('Expand the files this repo listed', '展开这个仓库列出的文件')
                                : t('Collapse the files this repo listed', '收起这个仓库列出的文件'))
                              : t('No files listed yet', '尚未列出文件')}
                            onClick={() => toggleRepo(rowKey(f))}>
                            {collapsed ? '▸' : '▾'}
                          </button>
                          <button className="btn btn-sm btn-ghost wz-row-remove" type="button"
                            aria-label={t('Remove', '移除')}
                            title={t('Remove this repo and the files it listed', '移除这个仓库及它列出的文件')}
                            onClick={() => removeCmd(c)}>
                            -
                          </button>
                          <strong>
                            {page
                              ? <a href={page} target="_blank" rel="noreferrer">{f.repo}</a>
                              : (f.repo || t('(unknown)', '（未知）'))}
                          </strong>
                          {f.subdir ? <span className="field-hint" style={{ marginLeft: 6 }}>{f.subdir}/</span> : null}
                        </td>
                        <td>
                          {pickable ? (
                            <Select className="control" value={source === 'unknown' ? '' : source}
                              title={t('The upstream code does not say which library this snapshot_download comes from.',
                                '无法从上游代码判断 snapshot_download 所属的库，请选择下载来源。')}
                              onChange={(e) => pickSource(c, e.target.value)}>
                              <option value="">{t('Choose source', '选择来源')}</option>
                              {SOURCES.map((x) => (
                                <option key={x} value={x}>{SOURCE_LABELS[x][lang === 'zh' ? 'zh' : 'en']}</option>
                              ))}
                            </Select>
                          ) : (
                            <span className="badge badge-neutral">
                              {SOURCE_LABELS[f.tool]
                                ? SOURCE_LABELS[f.tool][lang === 'zh' ? 'zh' : 'en']
                                : (f.tool || t('(unknown)', '（未知）'))}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="wz-num">
                            {(() => {
                              // 仓库行的大小是它已列出文件的总和；一个文件都没列时留空，
                              //   不写「（尚无）」这类看着像取值的占位。
                              const total = f.files.reduce((s, x) => s + (Number(x.size) || 0), 0)
                              return total > 0 ? `${(total / 1024 / 1024).toFixed(1)} MB` : '—'
                            })()}
                          </span>
                        </td>
                      <td>
                        {f.files.length
                          ? (
                            <span className="badge badge-ok" title={t('Files listed', '已列出文件')}>
                              {t(`${f.files.length} file(s)`, `${f.files.length} 个文件`)}
                            </span>
                          )
                          : <span className="field-hint" style={{ marginTop: 0 }}>{t('not listed yet', '尚未列出')}</span>}
                      </td>
                        <td>
                          <button className="btn btn-sm" type="button"
                            disabled={busy || source === 'unknown'}
                            onClick={() => loadManifest(c)}>
                            {busy ? t('Listing…', '读取中…') : t('List files', '列出文件')}
                          </button>
                          <button className="btn btn-sm" type="button" style={{ marginLeft: 6 }}
                            disabled={dlBusy || !f.files.length}
                            title={t('Download every file this repo listed again, overwriting what is on disk',
                              '把这个仓库列出的文件全部重新下载，覆盖盘上已有的文件')}
                            onClick={() => reDownloadRepo(f)}>
                            {t('Download all', '下载全部')}
                          </button>
                        </td>
                      </tr>
                      {rowError && (
                        <tr>
                          <td colSpan={5} style={{ paddingTop: 0 }}>
                            <div className="msg msg-danger" style={{ marginTop: 4 }}>{rowError}</div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    )
                  }
                  const cmd = { repo: f.repo || '', tool: f.tool || '' }
                  const task = taskOf(f)
                  const view = viewOf(f)
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
                        <span className="wz-num">
                          {f.size > 0
                            ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
                            : t('(unknown)', '（未知）')}
                        </span>
                      </td>
                      <td>
                        {(() => {
                          const percent = view === DONE ? 100 : ((task && task.percent) || 0)
                          const color = view === DONE
                            ? 'var(--success)'
                            : (view === INTERRUPTED ? 'var(--danger)' : 'var(--text)')
                          const hint = view === DONE
                            ? t('Downloaded', '下载完成')
                            : (view === INTERRUPTED
                              ? ((task && task.error) || t('Download interrupted', '下载中断'))
                              : (view === DOWNLOADING
                                ? t('Downloading', '正在下载')
                                : t('Not downloaded', '未下载')))
                          return (
                            <span className="wz-num" style={{ color }} title={hint}>
                              {percent}%
                            </span>
                          )
                        })()}
                      </td>
                      <td>
                        {view === NOT_DOWNLOADED && (
                          <button className="btn btn-sm" type="button"
                            disabled={dlBusy}
                            onClick={() => runDownload(cmd, f)}>
                            {t('Download', '下载')}
                          </button>
                        )}
                        {view === INTERRUPTED && (
                          <button className="btn btn-sm" type="button"
                            disabled={dlBusy}
                            onClick={() => runDownload(cmd, f)}>
                            {t('Retry', '重试')}
                          </button>
                        )}
                        {view === DONE && (
                          <button className="btn btn-sm" type="button"
                            disabled={dlBusy}
                            onClick={() => runDownload(cmd, f)}>
                            {t('Re-download', '重新下载')}
                          </button>
                        )}
                        {view === DOWNLOADING && (
                          <button className="btn btn-sm" type="button" disabled>
                            {t('Downloading…', '下载中…')}
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
            </div>
          </div>
        </div>
      )}

      {/* 运行期资源：不在上面的清单里，引擎第一次推理时才自行拉取。 */}
      {runtimeHints.length > 0 && (
        <div className="section" style={{ marginTop: 8 }}>
          <div className="section-hdr">
            <h2>
              {t('Fetched on first run', '运行期还会自行拉取')}
            </h2>
          </div>
          <div className="section-body">
            <div className="field-hint" style={{ marginTop: 0 }}>
              {t('The engine downloads these itself on its first inference, and it decides where they land. The repos among them are in the list above, so they can be downloaded into the weights folder first; the platform does not fetch the rest.',
                '以下资源由引擎在第一次推理时自行下载，落点由它的下载调用决定。其中的仓库已放进上方清单，可以先下到权重目录；其余条目平台不代为下载。')}
            </div>
            {runtimeHints.map((h) => (
              // 一行一条：仓库名长短差很多（nvidia/bigvgan_v2_22khz_80band_256x 比
              //   k2-fsa/ZipVoice 长三倍），两列布局（.plan-kv 的 120px 定宽左列）会让
              //   长仓库名横向压到右边出处那一串字上。第 5 步同一份数据也是这么摆的。
              <div className="field-hint" key={`${h.repo}|${h.file}|${h.line}`}
                style={{ marginLeft: 0, wordBreak: 'break-all' }}>
                <code>{h.repo}</code> · {h.file}:{h.line} · {h.call}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 上游附带的下载脚本（如果有）：平台按扩展名选解释器，在引擎目录里运行它。 */}
      {upstreamScripts.length > 0 && (
        <div className="section" style={{ marginTop: 4 }}>
          <div className="section-hdr">
            <h2>
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
            <h2>
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
                  onClick={() => addDirect(a.url, a.size, a.name)}>
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

      {/* 底部动作：重新检查不改动任何文件，从头重装会删权重目录。
          两者分到两端，删除按钮不挨着日常按钮；说明单独占一行。 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm" type="button"
          onClick={() => { load(); if (onChange) onChange() }}
          disabled={busy || !id}>
          {busy ? t('Checking…', '正在检查…') : t('Check again', '重新检查')}
        </button>
        {/* 从头重装本步：清下载记录并删掉权重目录里的文件，下一次下载会重新取。 */}
        {id && (
          <button className="btn btn-sm btn-danger" type="button"
            style={{ marginLeft: 'auto' }}
            disabled={dlBusy}
            onClick={() => setAskReset(true)}>
            {t('Reinstall this step from the start', '从头重装本步')}
          </button>
        )}
      </div>
      {/* 按钮的引注：分隔线之下，说明用「按钮名：解释」的写法，与第二步同一条规则。 */}
      {id && (
        <div style={{
          paddingTop: 8,
          borderTop: '1px solid var(--border)',
          marginLeft: 8,
          marginRight: 8,
        }}>
          <div className="field-hint" style={{ margin: 0 }}>
            {resetNote || t('Reinstall this step from the start: clears the record of finished '
              + 'downloads and deletes the files in the weights folder, so they are fetched again.',
              '从头重装本步：清除本步的下载记录，并删除权重目录里的文件，下一次下载会重新取。')}
          </div>
        </div>
      )}
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
