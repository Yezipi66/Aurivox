// 音色资产页：扫描与浏览磁盘上的音色资产、重命名、修复与重建、参考文本转写与校对、声学精修。
// 判据全部来自 /api/assets 返回的资产清单与当前引擎的 manifest.json；页面不维护第二份事实。
import { useState, useEffect, useRef, useCallback } from 'react'
import { Select } from '../common/Select'
import { usePersistentState } from '../../usePersistentState'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { NamingNoteCard, NamingNotePill } from '../common/Fields'
import { IconFolder, IconFolderSearch, IconPencil, IconTrash } from '../common/Icons'
import { RebuildProgress, RestoreModal } from '../train/TrainingTab'
import ReferenceTranscriptProofing from './ReferenceTranscriptProofing'
import RefineModal from './RefineModal'
import { modelCountsByEngine, countModelsInMeta, modelsFromMeta } from '../../lib/modelPickers.pure.js'
import { MigrateChoiceDialog, MigrateProgressDialog, FolderBrowser } from './AssetsDirManager'
import { AssetsSummaryBar, AssetsToolbar } from './AssetsToolbar'
import { DeleteAssetDialog, AssetsEmptyState } from './AssetsDialogs'

// 音色资产页
function AssetsTab({ engine, voices, selectedVoice, setSelectedVoice, setPage, loadVoices, setTrainPrefill, setActiveTaskId, rebuildTask, setRebuildTask }) {
  const { t } = useT()
  const [assets, setAssets] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [segments, setSegments] = useState({})
  const [segmentsLoading, setSegmentsLoading] = useState({})
  const [deleteConfirm, setDeleteConfirm] = useState(null) // { id, displayName }
  const [deleting, setDeleting] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState(null) // { id, displayName }
  // 参考文本校对弹窗目标（编辑已有文本，不做 ASR）。
  const [proofTarget, setProofTarget] = useState(null) // { id }
  // S2 声学精修弹窗目标（衍生新音色）。
  const [refineTarget, setRefineTarget] = useState(null) // { id, displayName, baseVersion }
  const rebuildPollRef = useRef(null)
  const scanAbortRef = useRef(null)
  // 正在进行的重建或修复任务的进度，显示当前跑到哪一步（预处理、S1/S2、收尾、发布）以及失败那一步的错误。
  // 进度状态：{ id, phase, currentStep, steps, error, failedStep, stages }
  const [rebuildJob, setRebuildJob] = useState(null) // { id, phase, currentStep, steps, error, failedStep, stages }
  // 原地 ASR（生成参考文本）任务，按资产 id 记录。
  // 只转写这个资产自己的 raw/ 与 slicer_opt/，不发布、不训练。
  const [transcribeJobs, setTranscribeJobs] = useState({}) // id -> { status, sources, done, error }
  const [txSource, setTxSource] = useState({}) // id -> 'missing'|'raw'|'slices'|'both'
  const [txOpen, setTxOpen] = useState({}) // id -> bool: 是否显示紧凑的转写控件
  const transcribePollRef = useRef({})
  useEffect(() => () => { Object.values(transcribePollRef.current).forEach(t => clearTimeout(t)) }, [])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('All')
  // 命名说明的提示：确认状态持久化，noteOpen 用来重新展开折叠后的胶囊。
  const [noteAcked, setNoteAcked] = usePersistentState('assets.namingNoteAck', false)
  const [noteOpen, setNoteOpen] = useState(false)
  const noteExpanded = !noteAcked || noteOpen
  // 行内重命名：只改显示名。资产的 id 与目录不动，改名由服务端守卫。
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  // 显示名改了不影响 id，选中音色仍然有效。
  // 资产目录配置：当前路径与迁移状态。
  const [assetsConfig, setAssetsConfig] = useState(null) // { assetsRoot, assetsRootSource, envOverride, platform }
  const [configBusy, setConfigBusy] = useState(false)
  const [dirInput, setDirInput] = useState('')          // 可编辑的路径（手工输入）
  const [migrateTarget, setMigrateTarget] = useState(null) // 等待用户选择复制、迁移或直接切换的路径
  // 内置目录浏览器：服务端进程无法可靠拉起原生目录选择框，所以自带一个。
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browseData, setBrowseData] = useState(null)    // { path, parent, isDriveList, drives, dirs }
  const [browseBusy, setBrowseBusy] = useState(false)
  const [browseError, setBrowseError] = useState(null)
  // 后台复制或迁移的进度（复制、校验、删除三步）。
  const [migrateJob, setMigrateJob] = useState(null)
  const migratePollRef = useRef(null)
  useEffect(() => () => { if (migratePollRef.current) clearInterval(migratePollRef.current) }, [])

  const loadAssets = useCallback(() => {
    api('/api/assets').then(r => {
      if (r.ok) setAssets(r.data.assets || {})
    }).catch(() => {})
  }, [])

  useEffect(() => { loadAssets() }, [loadAssets])
  useEffect(() => {
    api('/api/config').then(r => { if (r.ok) { setAssetsConfig(r.data); setDirInput(r.data.assetsRoot || '') } }).catch(() => {})
  }, [])

  const startRename = (id, current) => { setRenamingId(id); setRenameValue(current || id) }
  const cancelRename = () => { setRenamingId(null); setRenameValue('') }
  const commitRename = async (id) => {
    const name = renameValue.trim()
    if (!name) { cancelRename(); return }
    setRenameBusy(true); setScanMsg(null)
    try {
      const r = await api(`/api/assets/${id}/rename`, { method: 'PATCH', body: { display_name: name } })
      if (r.ok) {
        // 重命名只改显示名：id 与目录不动，选中项因此仍然有效，只需刷新列表。
        loadAssets()
        if (loadVoices) loadVoices()
        const dupNote = Array.isArray(r.data.duplicates) && r.data.duplicates.length > 0
          ? ` (display name shared with ${r.data.duplicates.length} other voice${r.data.duplicates.length > 1 ? 's' : ''}; id stays "${id}")`
          : ''
        setScanMsg({ type: 'success', text: `Renamed to "${name}"${dupNote}.` })
        setTimeout(() => setScanMsg(null), 4000)
        cancelRename()
      } else {
        setScanMsg({ type: 'error', text: r.data?.error || 'Rename failed' })
      }
    } catch (e) {
      setScanMsg({ type: 'error', text: e.message })
    } finally { setRenameBusy(false) }
  }

  // 用户选定了一个候选目录（选择器或手工输入）。判断是否需要先问迁移，还是可以直接切换。
  const requestChangeDir = (p) => {
    const next = (p || '').trim()
    if (!next) return
    if (assetsConfig && next === assetsConfig.assetsRoot) {
      setScanMsg({ type: 'info', text: 'That is already the current assets directory.' }); return
    }
    if (Object.keys(assets).length > 0) {
      setMigrateTarget(next) // 非空 ⇒ 问复制、迁移、切换还是取消
    } else {
      applyAssetsDir(next, 'switch')
    }
  }

  // 读一份目录列表给内置浏览器。路径为空时服务端返回盘符列表（Windows）或文件系统根（POSIX）。
  const browseTo = async (p) => {
    setBrowseBusy(true); setBrowseError(null)
    try {
      const r = await api(`/api/fs/browse?path=${encodeURIComponent(p || '')}`)
      if (r.ok) setBrowseData(r.data)
      else setBrowseError(r.data?.error || 'Could not open that folder')
    } catch (e) {
      setBrowseError(e.message)
    } finally { setBrowseBusy(false) }
  }

  const pickAssetsDir = () => {
    setBrowseOpen(true)
    setBrowseError(null)
    browseTo(dirInput || assetsConfig?.assetsRoot || '')
  }

  const chooseBrowsedFolder = () => {
    const chosen = browseData?.path
    if (!chosen) return
    setBrowseOpen(false)
    setDirInput(chosen)
    requestChangeDir(chosen)
  }

  const mkdirThenOpen = async (targetPath) => {
    setBrowseBusy(true); setBrowseError(null)
    try {
      const r = await api('/api/fs/mkdir', { method: 'POST', body: { path: targetPath } })
      if (r.ok) { await browseTo(r.data.path) }
      else { setBrowseError(r.data?.error || 'Could not create folder'); setBrowseBusy(false) }
    } catch (e) {
      setBrowseError(e.message); setBrowseBusy(false)
    }
  }

  // 询问名称，在当前列出的目录下新建子目录。
  const createSubfolder = () => {
    const cur = browseData?.path || ''
    if (!cur) { setBrowseError('Open a drive or folder first.'); return }
    const name = (typeof window !== 'undefined' ? window.prompt('New folder name:', 'assets') : '')
    const clean = (name || '').trim()
    if (!clean) return
    const sep = /\\/.test(cur) ? '\\' : '/'
    mkdirThenOpen(cur.replace(/[\\/]+$/, '') + sep + clean)
  }

  const applyAssetsDir = async (p, migration) => {
    setConfigBusy(true); setScanMsg(null)
    try {
      const r = await api('/api/config/assets-root', { method: 'POST', body: { path: p, migration } })
      if (!r.ok) {
        setScanMsg({ type: 'error', text: r.data?.error || 'Failed to save assets directory' })
        setConfigBusy(false); setMigrateTarget(null); return
      }
      if (r.data.async && r.data.jobId) {
        // 复制或迁移在后台执行 ⇒ 显示进度面板并轮询。
        setMigrateTarget(null)
        setMigrateJob({ jobId: r.data.jobId, migration: r.data.migration, total: r.data.total || 0,
          phase: 'copying', current: 0, currentName: '', steps: { copy: 'running', verify: 'pending', delete: 'pending' }, done: false, error: null })
        pollMigration(r.data.jobId)
      } else {
        // 直接切换
        setAssetsConfig(cfg => ({ ...(cfg || {}), assetsRoot: r.data.assetsRoot, pendingRestart: true }))
        setDirInput(r.data.assetsRoot)
        setScanMsg({ type: r.data.envOverride ? 'warning' : 'success', text: r.data.note || 'Saved. Restart to apply.' })
        setMigrateTarget(null)
      }
    } catch (e) {
      setScanMsg({ type: 'error', text: e.message }); setMigrateTarget(null)
    } finally { setConfigBusy(false) }
  }

  const pollMigration = (jobId) => {
    if (migratePollRef.current) clearInterval(migratePollRef.current)
    migratePollRef.current = setInterval(async () => {
      try {
        const r = await api(`/api/config/migrate-status/${jobId}`)
        if (!r.ok) {
          clearInterval(migratePollRef.current); migratePollRef.current = null
          setMigrateJob(j => j ? { ...j, done: true, error: r.data?.error || 'Migration job is no longer available (server may have restarted).', phase: 'error' } : j)
          return
        }
        setMigrateJob(r.data)
        if (r.data.done) {
          clearInterval(migratePollRef.current); migratePollRef.current = null
          if (!r.data.error) {
            setAssetsConfig(cfg => ({ ...(cfg || {}), assetsRoot: r.data.assetsRoot, pendingRestart: true }))
            setDirInput(r.data.assetsRoot)
            setScanMsg({ type: r.data.envOverride ? 'warning' : 'success', text: r.data.note || 'Saved. Restart to apply.' })
          }
        }
      } catch (e) {
        clearInterval(migratePollRef.current); migratePollRef.current = null
        setMigrateJob(j => j ? { ...j, done: true, error: e.message, phase: 'error' } : j)
      }
    }, 700)
  }

  const handleScan = async () => {
    setScanning(true); setScanMsg(null)
    const ctrl = new AbortController()
    scanAbortRef.current = ctrl
    try {
      const r = await fetch('/api/assets/scan', { method: 'POST', signal: ctrl.signal }).then(async r => {
        const data = await r.json().catch(() => null)
        return { ok: r.ok, status: r.status, data }
      })
      if (r.ok) {
        setAssets(r.data.assets || {})
        setScanMsg({ type: 'success', text: `Scan complete - ${r.data.scanned || 0} voice(s) found` })
        if (loadVoices) loadVoices()
      } else {
        setScanMsg({ type: 'error', text: r.data?.error || 'Scan failed' })
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        setScanMsg({ type: 'info', text: 'Scan cancelled' })
      } else {
        setScanMsg({ type: 'error', text: e.message })
      }
    } finally {
      scanAbortRef.current = null
      setScanning(false)
      setTimeout(() => setScanMsg(null), 4000)
    }
  }

  const handleCancelScan = () => {
    if (scanAbortRef.current) {
      scanAbortRef.current.abort()
      scanAbortRef.current = null
    }
  }

  const handleScanOne = async (id) => {
    setScanMsg(null)
    try {
      const r = await api(`/api/assets/${id}/scan`, { method: 'POST' })
      if (r.ok) {
        loadAssets()
        setScanMsg({ type: 'success', text: `Scan complete for ${id}` })
        if (loadVoices) loadVoices()
      } else {
        setScanMsg({ type: 'error', text: r.data?.error || 'Scan failed' })
      }
    } catch (e) {
      setScanMsg({ type: 'error', text: e.message })
    } finally {
      setTimeout(() => setScanMsg(null), 4000)
    }
  }

  // 原地生成参考文本：对资产自己的音频（原始音频与切片）跑 ASR，然后重新扫描，不发布也不训练。
  // 轮询状态端点直到完成，再刷新该资产，切片与文本才会出现。
  const pollTranscribe = (id) => {
    const tick = async () => {
      try {
        const r = await api(`/api/assets/${id}/transcribe-status`)
        const job = r.data || {}
        setTranscribeJobs(prev => ({ ...prev, [id]: job }))
        if (job.status === 'running') {
          transcribePollRef.current[id] = setTimeout(tick, 2000)
        } else {
          delete transcribePollRef.current[id]
          if (job.status === 'done') {
            setScanMsg({ type: 'success', text: `Reference text generated for ${id} (${(job.done || []).join(', ')})` })
            loadAssets()
            // 作废缓存的切片，重新展开时才会取到新文本。
            setSegments(s => { const n = { ...s }; delete n[id]; return n })
            if (expandedId === id) {
              try {
                const sr = await api(`/api/assets/${id}/segments`)
                if (sr.ok) setSegments(s => ({ ...s, [id]: sr.data.segments }))
              } catch (e) {
                console.warn('[assets] failed to refresh segments:', e.message)
              }
            }
          } else if (job.status === 'cancelled') {
            setScanMsg({ type: 'info', text: `Transcription cancelled for ${id}` })
          } else if (job.status === 'error') {
            setScanMsg({ type: 'error', text: `Transcription failed: ${job.error || 'unknown error'}` })
          }
          setTimeout(() => setScanMsg(null), 5000)
        }
      } catch (e) {
        delete transcribePollRef.current[id]
        setScanMsg({ type: 'error', text: e.message })
      }
    }
    transcribePollRef.current[id] = setTimeout(tick, 1000)
  }

  const handleTranscribe = async (id, source) => {
    setScanMsg(null)
    try {
      const r = await api(`/api/assets/${id}/transcribe`, { method: 'POST', body: { source } })
      if (r.ok && r.data?.started) {
        setTranscribeJobs(prev => ({ ...prev, [id]: { status: 'running', sources: r.data.sources || [], done: [] } }))
        setScanMsg({ type: 'info', text: `Transcribing ${id} (${(r.data.sources || []).join(', ')})…` })
        pollTranscribe(id)
      } else {
        setScanMsg({ type: 'error', text: r.data?.error || 'Could not start transcription' })
        setTimeout(() => setScanMsg(null), 5000)
      }
    } catch (e) {
      setScanMsg({ type: 'error', text: e.message })
    }
  }

  const handleCancelTranscribe = async (id) => {
    try { await api(`/api/assets/${id}/transcribe`, { method: 'DELETE' }) } catch (e) { console.warn('[assets] cancel transcribe failed:', e.message) }
  }

  // 挂载时恢复进行中的转写任务。切换页面会让本组件整个卸载，
  // 挂载前启动的转写否则会从界面上消失（状态胶囊回到 none、进度横幅不见），
  // 而服务端仍在执行它。拉取服务端记录的实时任务，写回状态，对仍在执行的继续轮询，
  // 并恢复进度横幅：服务端是事实来源，所以整页刷新后也照样恢复。每次挂载跑一次。
  useEffect(() => {
    let cancelled = false
    api('/api/transcribe-jobs').then(r => {
      if (cancelled || !r.ok) return
      const jobs = r.data?.jobs || {}
      const ids = Object.keys(jobs)
      if (ids.length === 0) return
      setTranscribeJobs(prev => ({ ...prev, ...jobs }))
      const runningIds = ids.filter(id => jobs[id].status === 'running')
      for (const id of runningIds) {
        if (!transcribePollRef.current[id]) pollTranscribe(id)
      }
      if (runningIds.length) {
        const first = runningIds[0]
        setScanMsg({ type: 'info', text: `Transcribing ${first} (${(jobs[first].sources || []).join(', ')})…` })
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 重建：把输入目录与音色名预填后交给训练页。
  // 纯前端：训练由用户确认后开始，切分与模型重建走既有训练管线，不新增后端端点。
  const handleRebuild = (id, asset) => {
    const a = asset.assets || {}
    const inputDir = a.raw?.dir || a.slices?.dir || ''
    if (setTrainPrefill) setTrainPrefill({ inputDir, voiceName: id })
    setPage('train')
  }

  // 轮询重建管线任务直到完成，随后自动重新扫描全部资产，这样修复好的音色不必再手动点一次扫描。重建管线（切片、ASR、收尾、发布）在服务端跑，这里只读它的状态。
  const pollRebuild = (id, taskId, stages) => {
    if (rebuildPollRef.current) { clearTimeout(rebuildPollRef.current); rebuildPollRef.current = null }
    let tries = 0
    const tick = async () => {
      tries += 1
      try {
        const r = await api(`/api/train/status/${taskId}`)
        if (r.ok && r.data) {
          const st = r.data.status
          const steps = r.data.steps || {}
          setRebuildJob(prev => ({
            ...(prev || {}), id, taskId, stages,
            phase: 'running', status: st, currentStep: r.data.currentStep, steps,
          }))
          if (st === 'completed') {
            setRebuildJob(prev => ({ ...(prev || {}), id, steps, phase: 'scanning', status: st }))
            await handleScan() // 全量重新扫描（Scan All），让该资产立刻可用
            setRebuildJob(prev => ({ ...(prev || {}), id, steps, phase: 'done', status: st }))
            if (setRebuildTask) setRebuildTask(null) // 完成了，不再持久化或恢复
            setTimeout(() => setRebuildJob(cur => (cur && cur.id === id && cur.phase === 'done') ? null : cur), 6000)
            return
          }
          if (['failed', 'cancelled', 'interrupted'].includes(st)) {
            // 报出失败的那一步与它的错误，让用户知道坏在哪里。
            let failedStep = r.data.currentStep, error = ''
            for (const [k, v] of Object.entries(steps)) {
              if (v && v.status === 'failed') { failedStep = k; error = v.error || ''; break }
            }
            setRebuildJob(prev => ({
              ...(prev || {}), id, taskId, stages, steps, phase: 'failed', status: st, failedStep,
              error: error || `Rebuild ${st} (no error detail reported).`,
            }))
            // 失败信息保持可见并持久化，跨页面也不丢，直到用户手动关掉。
            return
          }
        } else if (!r.ok && (r.status === 404 || r.status === 400)) {
          // 服务端已不认识这个任务（例如进程重启过），停止轮询。
          setRebuildJob(prev => (prev && prev.id === id) ? { ...prev, phase: 'failed', error: 'Rebuild task is no longer available on the server (it may have been restarted). Re-run the rebuild.', failedStep: prev.currentStep } : prev)
          return
        }
      } catch (_) { /* 暂时性故障，继续轮询 */ }
      if (tries < 1800) rebuildPollRef.current = setTimeout(tick, 2000)
    }
    rebuildPollRef.current = setTimeout(tick, 1200)
  }

  useEffect(() => () => { if (rebuildPollRef.current) clearTimeout(rebuildPollRef.current) }, [])

  // 回到资产页或刷新后恢复进行中的重建：管线仍在服务端跑，这里只是把进度面板接回来。
  useEffect(() => {
    if (rebuildTask && rebuildTask.taskId && !rebuildPollRef.current) {
      setRebuildJob({ id: rebuildTask.id, taskId: rebuildTask.taskId, stages: rebuildTask.stages || [], phase: 'running', status: 'pending', currentStep: null, steps: {}, error: null })
      pollRebuild(rebuildTask.id, rebuildTask.taskId, rebuildTask.stages || [])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 关掉已完成或已失败的重建面板，并停止持久化它。
  const dismissRebuild = () => { setRebuildJob(null); if (setRebuildTask) setRebuildTask(null) }

  // 修复弹窗启动重建时调用。走训练管线的重建返回 taskId（轮询它），只重建切片的轻量重建是同步的。
  const handleRebuildStarted = (id, data) => {
    if (data && data.taskId) {
      if (setRebuildTask) setRebuildTask({ id, taskId: data.taskId, stages: data.stages || [] }) // 持久化，供恢复用
      setRebuildJob({ id, taskId: data.taskId, stages: data.stages || [], phase: 'running', status: 'pending', currentStep: null, steps: {}, error: null })
      pollRebuild(id, data.taskId, data.stages || [])
    } else {
      // 轻量重建（只重建切片）在服务端同步完成，重新扫描即可。
      setScanMsg({ type: 'info', text: `Restored ${id} — scanning…` })
      handleScan()
    }
  }

  const handleOpenExplorer = async (id) => {
    try {
      await api(`/api/assets/${id}/open`, { method: 'POST' })
    } catch (e) {
      setScanMsg({ type: 'error', text: `Failed to open folder: ${e.message}` })
      setTimeout(() => setScanMsg(null), 3000)
    }
  }

  const handleDeleteRequest = (id, displayName) => {
    setDeleteConfirm({ id, displayName })
  }

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return
    const { id } = deleteConfirm
    setDeleting(true)
    setDeleteConfirm(null)
    try {
      await api(`/api/assets/${id}`, { method: 'DELETE' })
      // 立即刷新全局音色表，生成页的下拉不必等重新扫描就摘掉被删的音色。
      if (loadVoices) loadVoices()
      setScanMsg({ type: 'success', text: `Deleted ${id}. Re-scanning...` })
      // 删除后自动重新扫描
      setTimeout(async () => {
        try {
          const r = await api('/api/assets/scan', { method: 'POST' })
          if (r.ok) {
            setAssets(r.data.assets || {})
            if (loadVoices) loadVoices()
            setScanMsg({ type: 'success', text: `Deleted ${id}. Scan complete - ${r.data.scanned || 0} voice(s) found` })
          }
        } catch (e) {
          console.warn('[assets] rescan failed:', e.message)
        }
        setTimeout(() => setScanMsg(null), 4000)
      }, 500)
    } catch (e) {
      setScanMsg({ type: 'error', text: `Delete failed: ${e.message}` })
      setTimeout(() => setScanMsg(null), 3000)
    } finally {
      setDeleting(false)
    }
  }

  const handleBrowse = async (id) => {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    if (segments[id]) return
    setSegmentsLoading(s => ({ ...s, [id]: true }))
    try {
      const r = await api(`/api/assets/${id}/segments`)
      if (r.ok) setSegments(s => ({ ...s, [id]: r.data.segments }))
    } catch (e) {
      setSegments(s => ({ ...s, [id]: { error: e.message } }))
    } finally {
      setSegmentsLoading(s => ({ ...s, [id]: false }))
    }
  }

  const handleSetAsVoice = (assetId) => {
    // 扫描已经把音色同步进 voices.json，这个音色应当已经在列表里。
    setSelectedVoice(assetId)
    setPage('generate')
  }

  const handleUseAsReference = (audioPath, text) => {
    // 切到展开的资产所属的音色并转到生成页。
    // 参考音频与文本从 segments.json 自动带过去。
    if (expandedId) setSelectedVoice(expandedId)
    setPage('generate')
  }

  if (!assets) {
    return (
      <div className="section">
        <div className="section-hdr"><h2>Assets</h2></div>
        <div className="section-body"><div className="msg">Loading assets...</div></div>
      </div>
    )
  }

  const assetEntries = Object.entries(assets).sort((a, b) => (a[1].display_name || a[0]).localeCompare(b[1].display_name || b[0]))

  // 汇总统计，全部由 /api/assets 的资产清单推导。
  const totals = assetEntries.reduce((acc, [, asset]) => {
    const a = asset.assets || {}
    acc.voices += 1
    acc.raw += (a.raw?.file_count || 0)
    acc.rawDur += (a.raw?.total_duration || 0)
    acc.slices += (a.slices?.file_count || 0)
    // 模型总数按引擎分开数：每台引擎的模型在这排统计上各有一个数字。
    for (const c of modelCountsByEngine(asset)) {
      acc.byEngine[c.engineId] = (acc.byEngine[c.engineId] || 0) + c.count
    }
    acc.segments += (asset.segment_total || 0)
    return acc
  }, { voices: 0, raw: 0, rawDur: 0, slices: 0, byEngine: {}, segments: 0 })

  // 由资产现有的内容推导健康徽章。
  // 每种状态配一个形状符号，状态不依赖颜色也能分辨。
  const voiceHealth = (asset) => {
    const a = asset.assets || {}
    // 判据是「有没有任何模型」，不是「某两个位是不是都有」。
    //   成套要求属于具体引擎，搬到别的引擎上，只有另一台引擎模型的角色会一直挂红叉，而它完全能用。
    //   要不要成套由那台引擎的 manifest 决定，不由这排徽章决定。
    const hasModels = countModelsInMeta(asset) > 0
    const hasRaw = (a.raw?.file_count || 0) > 0
    const hasSlices = (a.slices?.file_count || 0) > 0
    const hasSegs = (asset.segment_total || 0) > 0
    const scanned = hasModels || hasRaw || hasSlices || hasSegs
    if (!scanned) return { key: 'needscan', label: 'Needs Scan', cls: 'badge-muted', sym: '○' }
    if (!hasModels) {
      return { key: 'nomodel', label: 'Missing Models', cls: 'badge-danger', sym: '✕' }
    }
    if (!hasSegs) {
      if (!hasRaw && !hasSlices) {
        return { key: 'norefs', label: 'No Refs', cls: 'badge-danger2', sym: '■',
                 note: 'No raw / slices / segments — re-import audio to rebuild.' }
      }
      if (hasSlices) {
        // 切片还在 ⇒ 切片表可以重新生成，不必重新切分。
        return { key: 'noseg', label: 'No Segments', cls: 'badge-seg', sym: '▲',
                 note: 'Slices present — rebuild segments.json from them (no re-slicing, no training).' }
      }
      // 模型与原始音频都在，切片与切片表没了。
      // 仍然可用：原始音频可以当参考音频。文本参考用 ASR 补回，不必重新训练。
      return { key: 'rawrefs', label: 'Raw Refs', cls: 'badge-ok2', sym: '◑',
               note: 'Usable now — raw serves as reference audio. Run ASR to restore text refs (no re-slicing, no retraining).' }
    }
    // 「Complete」是完好的状态：模型、切片表、原始音频与切片都在。
    // 缺了原始音频或切片（模型与切片表仍在）时仍然可用但不算完好，标为「Ready」并按缺的是哪一项给出说明：这样导入正常的资产后来被删掉切片时，不会继续显示成绿色的「Complete」。
    if (!hasRaw || !hasSlices) {
      const note = !hasRaw && !hasSlices
        ? 'Models + segments present; raw and slices removed (still usable).'
        : !hasSlices
          ? 'Slices removed; raw + segments present (still usable). Re-slice to restore full health.'
          : 'Raw removed; slices + segments present (still usable).'
      return { key: 'ready', label: 'Ready', cls: 'badge-ok2', sym: '◐', note }
    }
    return { key: 'complete', label: 'Complete', cls: 'badge-ok', sym: '●' }
  }

  // 搜索与筛选，全部由 /api/assets 的资产清单推导。
  const healthCounts = assetEntries.reduce((acc, [, asset]) => {
    const l = voiceHealth(asset).label
    acc[l] = (acc[l] || 0) + 1
    return acc
  }, {})
  // 文本问题是另一根轴（参考文本的健康，不是模型或切片的健康）：
  // 可以转写却没有可用文本（none），或者路径失效（invalid）。
  // 单列成一个筛选项，警告留在筛选行里，不做成每张卡片上常驻的横幅。
  const hasTextIssue = (asset) => {
    const canTx = (asset.raw?.file_count || 0) > 0 || (asset.slices?.file_count || 0) > 0
    const st = asset.reference_text?.state
    return canTx && (st === 'none' || st === 'invalid')
  }
  const textIssueCount = assetEntries.reduce((n, [, a]) => n + (hasTextIssue(a) ? 1 : 0), 0)
  // 筛选顺序保持稳定，只显示实际出现过的状态。
  const FILTER_ORDER = ['Complete', 'Ready', 'Raw Refs', 'No Segments', 'Missing Models', 'Missing GPT', 'Missing SoVITS', 'No Refs', 'Needs Scan']
  const filterChips = ['All', ...FILTER_ORDER.filter(l => healthCounts[l]), ...(textIssueCount ? ['Text Issues'] : [])]
  const q = search.trim().toLowerCase()
  const filteredEntries = assetEntries.filter(([id, asset]) => {
    if (filter === 'Text Issues') { if (!hasTextIssue(asset)) return false }
    else if (filter !== 'All' && voiceHealth(asset).label !== filter) return false
    if (q && !((asset.display_name || id).toLowerCase().includes(q) || id.toLowerCase().includes(q))) return false
    return true
  })

  return (
    <div className="section">
      <div className="section-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Voice Assets</h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {assetsConfig && (
            <div className="assets-dir" title={`Assets directory (${assetsConfig.assetsRootSource})${assetsConfig.envOverride ? ' — set by ASSETS_ROOT env var' : ''}`}>
              <input
                className="assets-dir-input"
                value={dirInput}
                placeholder="Assets directory path…"
                disabled={configBusy || assetsConfig.envOverride}
                onChange={e => setDirInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') requestChangeDir(dirInput) }}
                title={assetsConfig.envOverride ? 'Locked by ASSETS_ROOT env var' : 'Type or paste an absolute path, then Enter / Change'}
              />
              <button
                className="btn-icon assets-dir-pick"
                title="Browse for an assets directory…"
                disabled={configBusy || assetsConfig.envOverride}
                onClick={pickAssetsDir}
              >
                <IconFolder size={15} color="var(--muted)" />
              </button>
              <button
                className="btn btn-sm"
                disabled={configBusy || assetsConfig.envOverride || !dirInput.trim() || dirInput.trim() === assetsConfig.assetsRoot}
                onClick={() => requestChangeDir(dirInput)}
              >{configBusy ? '…' : 'Change'}</button>
              {assetsConfig.pendingRestart && <span className="assets-dir-flag" title="Restart the server to apply">restart</span>}
            </div>
          )}
          <button className="btn btn-sm" onClick={loadAssets} disabled={scanning}>Refresh</button>
          {scanning ? (
            <button className="btn btn-sm btn-danger" onClick={handleCancelScan}>
              Cancel Scan
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={handleScan}>
              Scan All
            </button>
          )}
        </div>
      </div>
      <div className="section-body">
        {scanMsg && <div className={`msg msg-${scanMsg.type}`} style={{ marginBottom: 10 }}>{scanMsg.text}</div>}
        {noteExpanded && (
          <NamingNoteCard
            acked={noteAcked}
            onAck={() => { setNoteAcked(true); setNoteOpen(false) }}
            onCollapse={() => setNoteOpen(false)}
          />
        )}
        {/* 资产列表为空时，折叠的提示胶囊没有汇总栏可挂。 */}
        {!noteExpanded && assetEntries.length === 0 && (
          <NamingNotePill onOpen={() => setNoteOpen(true)} />
        )}
        <RebuildProgress job={rebuildJob} onDismiss={dismissRebuild} />
        {assetEntries.length > 0 && (
          <AssetsSummaryBar
            totals={totals}
            noteExpanded={noteExpanded}
            onOpenNote={() => setNoteOpen(true)}
          />
        )}
        {assetEntries.length > 0 && (
          <AssetsToolbar
            filterChips={filterChips}
            healthCounts={healthCounts}
            textIssueCount={textIssueCount}
            filter={filter}
            onFilter={setFilter}
            search={search}
            onSearch={setSearch}
          />
        )}
        {assetEntries.length > 0 && filteredEntries.length === 0 && (
          <div className="msg" style={{ marginBottom: 10 }}>
            No voices match {q ? `“${search.trim()}”` : 'this filter'}.
            <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => { setSearch(''); setFilter('All') }}>Clear</button>
          </div>
        )}
        {assetEntries.length === 0 && (
          <AssetsEmptyState
            scanning={scanning}
            onCancelScan={handleCancelScan}
            onScan={handleScan}
            onStartTuning={() => setPage('train')}
          />
        )}
        {filteredEntries.map(([id, asset]) => {
          const a = asset.assets || {}
          const raw = a.raw || {}
          const slices = a.slices || {}
          // 这个角色手上有哪几台引擎的模型、各几个（有几台就显示几格）。
          const modelCounts = modelCountsByEngine(asset)
          // 「精修」是训练管线自己的事：它要继续训的正是它自己产出的那两份权重。
          // 引擎名写死在这里，因此这一页只对那一种模型形状成立。
          const canRefine = modelsFromMeta(asset, 'gpt-sovits', 'gpt').length > 0
                         && modelsFromMeta(asset, 'gpt-sovits', 'sovits').length > 0
          const segCount = asset.segment_total || 0
          const h = voiceHealth(asset)
          const canRebuild = (raw.file_count || 0) > 0 || (slices.file_count || 0) > 0
          // 修复走依赖规划器（取最短路径）。「Raw Refs」与「Missing Models」开同一个弹窗：
          // 规划器复用已有的切片与 ASR 结果，所以只有切片与列表、缺模型的角色只跑预处理与训练，
          // 既不重新切片也不重新转写。
          // 切片被删但原始音频还在的「Ready」资产也开这个弹窗：
          // 同一弹窗可以从原始音频重新切片（sliceChoice='real'），把健康度补回来。
          const canReslice = (raw.file_count || 0) > 0 && (slices.file_count || 0) === 0
          const showRestore = h.key === 'rawrefs' || h.key === 'nomodel' || (h.key === 'ready' && canReslice)
          // 「No Refs」是死路（既没有原始音频也没有切片），保留训练页的入口让用户重新导入。
          // 「No Segments」扫一次就能修好，不必训练。
          const showRebuild = h.key === 'norefs'
          const isExpanded = expandedId === id
          const segData = segments[id]
          const isLoadingSegs = segmentsLoading[id]

          return (
            <div key={id} className="card asset-card" style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 'var(--fs-14)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {renamingId === id ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <input
                          className="control"
                          style={{ fontSize: 'var(--fs-13)', padding: '3px 8px', width: 200 }}
                          value={renameValue}
                          autoFocus
                          disabled={renameBusy}
                          onChange={e => setRenameValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') commitRename(id); if (e.key === 'Escape') cancelRename() }}
                        />
                        <button className="btn btn-sm btn-primary" disabled={renameBusy} onClick={() => commitRename(id)}>{renameBusy ? '…' : 'Save'}</button>
                        <button className="btn btn-sm btn-ghost" disabled={renameBusy} onClick={cancelRename}>Cancel</button>
                      </span>
                    ) : (
                      <>
                        {asset.display_name || id}
                        <button
                          className="btn-icon"
                          title="Rename (updates display name and id/folder)"
                          onClick={() => startRename(id, asset.display_name || id)}
                          style={{ display: 'inline-flex', alignItems: 'center' }}
                        >
                          <IconPencil size={13} color="var(--muted)" />
                        </button>
                        <span className={`badge ${h.cls}`} title={h.note || ''}>
                          <span className="badge-sym">{h.sym}</span>{h.label}
                        </span>
                        {asset.refinement && (asset.refinement.generation || 0) > 0 && (() => {
                          const ref = asset.refinement
                          const nameOf = (vid) => (vid && assets[vid] && (assets[vid].display_name || vid)) || vid || '—'
                          const rootN = nameOf(ref.root_voice_id)
                          const parentN = nameOf(ref.parent_voice_id)
                          const mode = ref.data_mode === 'own' ? 'own-data / 自备数据' : 'reuse / 复用数据集'
                          const chain = `Gen ${ref.generation} · ${rootN} → … → ${parentN} → ${asset.display_name || id}\nType: ${ref.refinement_type || '—'} · ${mode}`
                          return (
                            <span className="badge badge-muted" title={chain} style={{ cursor: 'help' }}>
                              <span className="badge-sym">⑂</span>Gen {ref.generation}
                            </span>
                          )
                        })()}
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', marginTop: 2 }}>
                    Mode: {asset.mode || 'N/A'} &middot; ID: {id} &middot; Language: {String(asset.language || asset.text_lang || asset.lang || 'unknown').replace(/^all_/, '')}
                  </div>
                </div>
                <div className="asset-actions">
                  {/* 次要操作。 */}
                  <div className="aa-group">
                    {/* 这一格要么 Scan，要么这一行缺东西时的修复动作，两者互斥、同一种样式：
                        缺什么由左边的健康徽章说，按钮不负责催。 */}
                    {showRestore ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setRestoreTarget({ id, displayName: asset.display_name || id })}
                        disabled={scanning}
                        title={h.key === 'nomodel'
                          ? 'Rebuild the missing model. Existing slices and transcripts are reused — only preprocess+train run (no re-slicing, no re-ASR).'
                          : h.key === 'ready'
                            ? 'Slices were removed. Re-slice from raw (choose "Re-slice") and transcribe to restore full health — models are kept unless retraining is selected.'
                            : 'Choose how to restore: use raw as reference clips or re-slice, transcribe or not — models are kept unless retraining is selected.'}
                      >
                        {h.key === 'nomodel' ? 'Rebuild' : h.key === 'ready' ? 'Rebuild slices' : 'Restore'}
                      </button>
                    ) : (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => handleScanOne(id)}
                        disabled={scanning}
                        title={h.key === 'noseg'
                          ? 'Rebuild segments.json from existing slices — no re-training'
                          : 'Re-scan this voice and refresh its assets'}
                      >
                        {h.key === 'noseg' ? 'Rebuild Segments' : 'Scan'}
                      </button>
                    )}
                    {showRebuild && (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => canRebuild && handleRebuild(id, asset)}
                        disabled={!canRebuild}
                        title={canRebuild
                          ? 'Re-train from existing raw / slices (opens Train with values prefilled)'
                          : 'No raw or slices to rebuild from — re-import audio first'}
                      >
                        Rebuild
                      </button>
                    )}
                    {canRefine && (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setRefineTarget({ id, displayName: asset.display_name || id, baseVersion: asset.base_version, parentLanguage: asset.language || asset.text_lang || 'auto' })}
                        title={t('Refinement: continue S1 and/or S2 training from this Voice into a new derived Voice (the original is preserved)', '精修：从该音色继续 S1 和/或 S2 训练，派生为一个新音色（原音色会被保留）')}
                      >
                        Refine
                      </button>
                    )}
                    <button className="btn btn-sm btn-ghost" onClick={() => handleOpenExplorer(id)} title="Open in Explorer" style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 8px' }}>
                      <IconFolderSearch size={14} color="var(--muted)" />
                    </button>
                  </div>
                  {/* 危险操作。 */}
                  <button className="btn btn-sm btn-danger" onClick={() => handleDeleteRequest(id, asset.display_name || id)} title="Delete Asset" style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 8px' }}>
                    <IconTrash size={14} />
                  </button>
                  {/* 主要操作。 */}
                  <button className="btn btn-sm btn-primary" onClick={() => handleSetAsVoice(id)}>
                    Set as Voice
                  </button>
                </div>
              </div>
              {(() => {
                // 参考文本状态显示为统计行里的紧凑胶囊（不另占一行，卡片保持短）。
                // 点它按需展开原地转写控件。
                // 只是提示：推理不需要文本，状态由内容检查（不只是文件存在）决定。
                const rt = asset.reference_text || {}
                const hasRawAudio = (raw.file_count || 0) > 0
                const hasSliceAudio = (slices.file_count || 0) > 0
                const canTranscribe = hasRawAudio || hasSliceAudio
                const TEXT_STATE = {
                  both:    { label: 'OK',      cls: 'tp-ok',   sym: '✓' },
                  slices:  { label: 'Slices',  cls: 'tp-warn', sym: '◑' },
                  raw:     { label: 'Raw',     cls: 'tp-warn', sym: '◑' },
                  none:    { label: 'None',    cls: 'tp-none', sym: '–' },
                  invalid: { label: 'Invalid', cls: 'tp-bad',  sym: '!' },
                }
                const ts = TEXT_STATE[rt.state] || TEXT_STATE.none
                // 提示文案由状态推导，服务端没给时也不写错。
                const TEXT_ADVICE = {
                  both:    'Reference text present for raw and slices.',
                  slices:  'Reference text present for slices only — raw has none.',
                  raw:     'Reference text present for raw only — slices have none.',
                  none:    'No reference text yet (optional — inference works without it).',
                  invalid: 'Reference list paths are stale/broken. Re-run ASR to overwrite.',
                }
                const advice = rt.advisory || TEXT_ADVICE[rt.state] || TEXT_ADVICE.none
                const tx = transcribeJobs[id]
                const running = tx && tx.status === 'running'
                const open = !!txOpen[id]
                const sel = txSource[id] || 'missing'
                return (
                  <>
                    <div className="asset-stats">
                      <span className="stat-pill"><span className="sp-v">{raw.file_count || 0}</span><span className="sp-k">raw</span></span>
                      <span className="stat-pill"><span className="sp-v">{(raw.total_duration || 0).toFixed(1)}s</span><span className="sp-k">dur</span></span>
                      <span className="stat-pill"><span className="sp-v">{slices.file_count || 0}</span><span className="sp-k">slices</span></span>
                      {modelCounts.map(c => (
                        <span className="stat-pill" key={c.engineId}><span className="sp-v">{c.count}</span><span className="sp-k">{c.engineId}</span></span>
                      ))}
                      <span className="stat-pill"><span className="sp-v">{segCount}</span><span className="sp-k">segments</span></span>
                      {canTranscribe && (
                        <button
                          type="button"
                          className={`stat-pill text-pill ${ts.cls} ${open ? 'is-open' : ''}`}
                          onClick={() => setTxOpen(s => ({ ...s, [id]: !s[id] }))}
                          title={advice}
                        >
                          <span className="tp-sym">{running ? '…' : ts.sym}</span>
                          <span className="sp-k">text</span>
                          <span className="sp-v">{running ? '…' : ts.label}</span>
                        </button>
                      )}
                    </div>

                    {canTranscribe && open && (
                      <div className="reftext-controls">
                        {rt.state === 'invalid'
                          ? <span className="rtc-msg rtc-warn">⚠ {advice}</span>
                          : <span className="rtc-msg" />}
                        <div className="rtc-actions">
                          <Select
                            className="control control-sm"
                            value={sel}
                            disabled={running}
                            onChange={e => setTxSource(s => ({ ...s, [id]: e.target.value }))}
                            title="Choose which audio to transcribe"
                          >
                            <option value="missing">Fill missing</option>
                            {hasRawAudio && <option value="raw">Raw</option>}
                            {hasSliceAudio && <option value="slices">Slices</option>}
                            {hasRawAudio && hasSliceAudio && <option value="both">Both</option>}
                          </Select>
                          {running ? (
                            // 终止一个已经开始的转写。
                            <button className="btn btn-sm btn-danger" onClick={() => handleCancelTranscribe(id)}>
                              Cancel{(tx.done || []).length ? ` (${tx.done.join(', ')} done)` : ''}
                            </button>
                          ) : (
                            <button
                              className="btn btn-sm btn-primary"
                              onClick={() => handleTranscribe(id, sel)}
                              title="Run ASR over this asset's own audio in place (no publish, no training)"
                            >
                              Generate reference text
                            </button>
                          )}
                          {/* 校对已有文本，不做 ASR。 */}
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={running}
                            onClick={() => setProofTarget({ id })}
                            title="Edit and proofread the existing reference transcript. Does not modify or retrain S1/S2 checkpoints."
                          >
                            Proofread Reference Transcript
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )
              })()}

              {/* 展开这一行看原始文件 / 切片 / 模型。它是个披露开关，不是动作，
                  所以从动作组里拿出来，放到卡片右下角，用一枚三角形指代。 */}
              <button
                type="button"
                className={`asset-disclose${isExpanded ? ' is-open' : ''}`}
                onClick={() => handleBrowse(id)}
                aria-expanded={isExpanded}
                aria-label={isExpanded ? t('Collapse', '收起') : t('Show raw files, slices and models', '展开查看原始文件、切片与模型')}
                title={isExpanded ? t('Collapse', '收起') : t('Show raw files, slices and models', '展开查看原始文件、切片与模型')}
              />

              {isExpanded && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  {isLoadingSegs && <div className="msg">Loading segments...</div>}
                  {segData && segData.error && <div className="msg msg-error">{segData.error}</div>}
                  {segData && segData.segments && segData.segments.length === 0 && <div className="msg msg-info">No segments found.</div>}
                  {segData && segData.segments && segData.segments.length > 0 && (
                    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                      <table className="table" style={{ width: '100%', fontSize: 'var(--fs-12)' }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Scene</th>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Text</th>
                            <th style={{ textAlign: 'right', padding: '4px 6px' }}>Duration</th>
                            <th style={{ textAlign: 'center', padding: '4px 6px' }}>Ref</th>
                          </tr>
                        </thead>
                        <tbody>
                          {segData.segments.map((seg, i) => (
                            <tr key={i}>
                              <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{seg.scene} #{seg.index}</td>
                              <td style={{ padding: '4px 6px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{seg.text}</td>
                              <td style={{ padding: '4px 6px', textAlign: 'right' }}>{(seg.duration || 0).toFixed(1)}s</td>
                              <td style={{ padding: '4px 6px', textAlign: 'center' }}>
                                <button className="btn btn-sm" onClick={() => handleUseAsReference(seg.audio_path, seg.text)} title={seg.audio_path}>
                                  Use as Ref
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', marginTop: 4 }}>
                        Showing {segData.matched || segData.segments.length} of {segData.total} segments
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 删除确认弹窗。 */}
      <DeleteAssetDialog
        target={deleteConfirm}
        deleting={deleting}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteConfirm(null)}
      />

      {/* 修复弹窗（按依赖规划修复，修复方式由用户选择）。 */}
      {restoreTarget && (
        <RestoreModal
          id={restoreTarget.id}
          displayName={restoreTarget.displayName}
          onClose={() => setRestoreTarget(null)}
          onStarted={handleRebuildStarted}
        />
      )}

      {/* 校对已有参考文本，不做 ASR。 */}
      {proofTarget && (
        <ReferenceTranscriptProofing
          voiceId={proofTarget.id}
          engineId={engine?.id}
          asrRunning={transcribeJobs[proofTarget.id]?.status === 'running'}
          onClose={() => setProofTarget(null)}
          onSaved={() => {
            setSegments(s => { const n = { ...s }; delete n[proofTarget.id]; return n })
            loadAssets()
          }}
          onRerunAsr={(source) => { setProofTarget(null); handleTranscribe(proofTarget.id, source) }}
        />
      )}

      {/* S2 声学精修，衍生出新音色。 */}
      {refineTarget && (
        <RefineModal
          voiceId={refineTarget.id}
          parentDisplayName={refineTarget.displayName}
          parentVersion={refineTarget.baseVersion}
          parentLanguage={refineTarget.parentLanguage}
          onClose={() => setRefineTarget(null)}
          onStarted={(data) => {
            setRefineTarget(null)
            setScanMsg({ type: 'success', text: `Refinement started → ${data.displayName} (${data.voiceId})` })
            setTimeout(() => setScanMsg(null), 6000)
            loadVoices && loadVoices()
            loadAssets()
            // 接管精修任务，让它的进度以及请求过「ASR 后暂停」时的校对面板
            //   出现在训练页（校对界面只在那里渲染）。不接管的话，暂停的任务会
            //   停在 awaiting_review，没有办法校对。
            if (data && data.taskId && setActiveTaskId) {
              setActiveTaskId(data.taskId)
              setPage('train')
            }
          }}
        />
      )}

      {/* 资产目录迁移：当前目录非空，先问用户要做什么。 */}
      <MigrateChoiceDialog
        migrateTarget={migrateTarget}
        assetCount={Object.keys(assets || {}).length}
        configBusy={configBusy}
        onApply={applyAssetsDir}
        onCancel={() => setMigrateTarget(null)}
      />

      {/* 后台复制或迁移的进度：复制、校验、删除三步。 */}
      <MigrateProgressDialog migrateJob={migrateJob} onClose={() => setMigrateJob(null)} />

      {/* 内置目录浏览器：在任何系统上都能可靠地选资产目录。 */}
      <FolderBrowser
        open={browseOpen}
        browseData={browseData}
        browseBusy={browseBusy}
        browseError={browseError}
        onBrowseTo={browseTo}
        onPathChange={p => setBrowseData(d => ({ ...(d || {}), path: p }))}
        onCreateSubfolder={createSubfolder}
        onMkdirThenOpen={mkdirThenOpen}
        onChoose={chooseBrowsedFolder}
        onClose={() => setBrowseOpen(false)}
      />
    </div>
  )
}


export {
  AssetsTab,
}
