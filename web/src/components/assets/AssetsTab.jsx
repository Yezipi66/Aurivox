// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
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

// ============================
//  ASSETS TAB
// ============================
function AssetsTab({ voices, selectedVoice, setSelectedVoice, setPage, loadVoices, setTrainPrefill, setActiveTaskId, rebuildTask, setRebuildTask }) {
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
  // Patch #13: reference-transcript proofing modal target (edit existing text; no ASR).
  const [proofTarget, setProofTarget] = useState(null) // { id }
  // Patch #12: S2 acoustic refinement modal target (derive a new voice).
  const [refineTarget, setRefineTarget] = useState(null) // { id, displayName, baseVersion }
  const rebuildPollRef = useRef(null)
  // Live lightweight-pipeline progress for an in-flight Rebuild/Restore, so the
  // user can see which step (preprocess → S1/S2 → finalize → publish) is running
  // and read a clear error if one fails — instead of just listening to the fan.
  const [rebuildJob, setRebuildJob] = useState(null) // { id, phase, currentStep, steps, error, failedStep, stages }
  // In-place ASR ("generate reference text") jobs, keyed by asset id. Advisory-only
  // recovery: transcribes the asset's own raw/ and/or slicer_opt/ in place (no promote).
  const [transcribeJobs, setTranscribeJobs] = useState({}) // id -> { status, sources, done, error }
  const [txSource, setTxSource] = useState({}) // id -> 'missing'|'raw'|'slices'|'both'
  const [txOpen, setTxOpen] = useState({}) // id -> bool: show the compact transcribe controls
  const transcribePollRef = useRef({})
  useEffect(() => () => { Object.values(transcribePollRef.current).forEach(t => clearTimeout(t)) }, [])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('All')
  // Naming-note notice: ack persists; `noteOpen` re-expands the collapsed pill.
  const [noteAcked, setNoteAcked] = usePersistentState('assets.namingNoteAck', false)
  const [noteOpen, setNoteOpen] = useState(false)
  const noteExpanded = !noteAcked || noteOpen
  // Inline rename — renames display name AND id/folder together (kept in sync to
  // prevent the display≠id overwrite trap). Guarded server-side.
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  // Rename now changes id + folder too; sync selectedVoice if it was renamed.
  // Assets-directory config (decoupling): current path + picker/migration state.
  const [assetsConfig, setAssetsConfig] = useState(null) // { assetsRoot, assetsRootSource, envOverride, platform }
  const [configBusy, setConfigBusy] = useState(false)
  const [dirInput, setDirInput] = useState('')          // editable path (manual entry)
  const [migrateTarget, setMigrateTarget] = useState(null) // path pending copy/move/switch choice
  // In-app folder browser (reliable cross-platform replacement for a native dialog,
  // which cannot be launched reliably from the headless server process).
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browseData, setBrowseData] = useState(null)    // { path, parent, isDriveList, drives, dirs }
  const [browseBusy, setBrowseBusy] = useState(false)
  const [browseError, setBrowseError] = useState(null)
  // Background copy/move progress (copy → verify → delete pipeline).
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
        // Option A: rename is DISPLAY-ONLY. The canonical id/folder never moves,
        // so the selection stays valid; just refresh the display list.
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

  // A candidate directory was chosen (via picker or manual entry). Decide whether
  // we need to ask about migrating existing data, or can switch directly.
  const requestChangeDir = (p) => {
    const next = (p || '').trim()
    if (!next) return
    if (assetsConfig && next === assetsConfig.assetsRoot) {
      setScanMsg({ type: 'info', text: 'That is already the current assets directory.' }); return
    }
    if (Object.keys(assets).length > 0) {
      setMigrateTarget(next) // non-empty → ask copy/move/switch/cancel
    } else {
      applyAssetsDir(next, 'switch')
    }
  }

  // Load a directory listing into the in-app browser. path==='' asks the server
  // for the drive list (Windows) or filesystem root (POSIX).
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

  // Prompt for a name and create a sub-folder under the currently listed directory.
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
        // copy/move runs in the background → show the progress pipeline and poll.
        setMigrateTarget(null)
        setMigrateJob({ jobId: r.data.jobId, migration: r.data.migration, total: r.data.total || 0,
          phase: 'copying', current: 0, currentName: '', steps: { copy: 'running', verify: 'pending', delete: 'pending' }, done: false, error: null })
        pollMigration(r.data.jobId)
      } else {
        // instant switch
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
    try {
      const r = await api('/api/assets/scan', { method: 'POST' })
      if (r.ok) {
        setAssets(r.data.assets || {})
        setScanMsg({ type: 'success', text: `Scan complete - ${r.data.scanned || 0} voice(s) found` })
        if (loadVoices) loadVoices()
      } else {
        setScanMsg({ type: 'error', text: r.data?.error || 'Scan failed' })
      }
    } catch (e) {
      setScanMsg({ type: 'error', text: e.message })
    } finally {
      setScanning(false)
      setTimeout(() => setScanMsg(null), 4000)
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

  // In-place "generate reference text": run the shared ASR kernel over the asset's
  // own audio (raw and/or slices) and rescan — no promote, no training. Polls the
  // -status endpoint until done, then refreshes the asset so segments/text appear.
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
            // Invalidate the cached segments so a re-expand refetches the new text.
            setSegments(s => { const n = { ...s }; delete n[id]; return n })
            if (expandedId === id) {
              try {
                const sr = await api(`/api/assets/${id}/segments`)
                if (sr.ok) setSegments(s => ({ ...s, [id]: sr.data.segments }))
              } catch (_) {}
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
    try { await api(`/api/assets/${id}/transcribe`, { method: 'DELETE' }) } catch (_) {}
  }

  // Re-hydrate in-place transcribe jobs on mount. AssetsTab fully unmounts on page
  // switch, so a transcription started before navigating away would otherwise vanish
  // from the UI (status pill resets to "none", progress banner disappears) even though
  // the backend keeps running it. Pull the live jobs, seed state, resume polling for
  // any still running, and restore the banner — backend is the source of truth, so
  // this also survives a full page reload. Runs once per mount.
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

  // Rebuild = hand off to the Train tab with the input folder + voice name
  // prefilled (raw preferred, else the slices folder). Pure front-end: the user
  // confirms and starts training. Re-slicing / model rebuild happen in the
  // existing pipeline; no new backend endpoint is used.
  const handleRebuild = (id, asset) => {
    const a = asset.assets || {}
    const inputDir = a.raw?.dir || a.slices?.dir || ''
    if (setTrainPrefill) setTrainPrefill({ inputDir, voiceName: id })
    setPage('train')
  }

  // Poll a rebuild pipeline task to completion, then auto-rescan ALL assets so
  // the restored voice becomes usable without a manual "Scan All". The rebuild
  // pipeline (slice/asr/finalize/promote) runs server-side; we watch its status.
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
            await handleScan() // full re-scan (Scan All) so the asset is immediately usable
            setRebuildJob(prev => ({ ...(prev || {}), id, steps, phase: 'done', status: st }))
            if (setRebuildTask) setRebuildTask(null) // finished — stop persisting/resuming
            setTimeout(() => setRebuildJob(cur => (cur && cur.id === id && cur.phase === 'done') ? null : cur), 6000)
            return
          }
          if (['failed', 'cancelled', 'interrupted'].includes(st)) {
            // Surface the exact failing step + its error so the user knows what broke.
            let failedStep = r.data.currentStep, error = ''
            for (const [k, v] of Object.entries(steps)) {
              if (v && v.status === 'failed') { failedStep = k; error = v.error || ''; break }
            }
            setRebuildJob(prev => ({
              ...(prev || {}), id, taskId, stages, steps, phase: 'failed', status: st, failedStep,
              error: error || `Rebuild ${st} (no error detail reported).`,
            }))
            // Keep the failure visible AND persisted across navigation until the
            // user dismisses it (so they don't miss a failed repair).
            return
          }
        } else if (!r.ok && (r.status === 404 || r.status === 400)) {
          // Task no longer known to the server (e.g. process restarted) — stop.
          setRebuildJob(prev => (prev && prev.id === id) ? { ...prev, phase: 'failed', error: 'Rebuild task is no longer available on the server (it may have been restarted). Re-run the rebuild.', failedStep: prev.currentStep } : prev)
          return
        }
      } catch (_) { /* transient — keep polling */ }
      if (tries < 1800) rebuildPollRef.current = setTimeout(tick, 2000)
    }
    rebuildPollRef.current = setTimeout(tick, 1200)
  }

  useEffect(() => () => { if (rebuildPollRef.current) clearTimeout(rebuildPollRef.current) }, [])

  // Resume an in-flight rebuild after navigating back to Assets (or a reload):
  // the pipeline keeps running server-side; we just re-attach the progress panel.
  useEffect(() => {
    if (rebuildTask && rebuildTask.taskId && !rebuildPollRef.current) {
      setRebuildJob({ id: rebuildTask.id, taskId: rebuildTask.taskId, stages: rebuildTask.stages || [], phase: 'running', status: 'pending', currentStep: null, steps: {}, error: null })
      pollRebuild(rebuildTask.id, rebuildTask.taskId, rebuildTask.stages || [])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dismiss a finished/failed rebuild panel and stop persisting it.
  const dismissRebuild = () => { setRebuildJob(null); if (setRebuildTask) setRebuildTask(null) }

  // Called when the Restore modal kicks off a rebuild. A pipeline-backed rebuild
  // returns a taskId (poll it); a lightweight segments-only rebuild is synchronous.
  const handleRebuildStarted = (id, data) => {
    if (data && data.taskId) {
      if (setRebuildTask) setRebuildTask({ id, taskId: data.taskId, stages: data.stages || [] }) // persist for resume
      setRebuildJob({ id, taskId: data.taskId, stages: data.stages || [], phase: 'running', status: 'pending', currentStep: null, steps: {}, error: null })
      pollRebuild(id, data.taskId, data.stages || [])
    } else {
      // Lightweight (segments-only) rebuild is synchronous server-side — just rescan.
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
      // Refresh the global voice registry immediately so the Generate page
      // dropdown drops the deleted voice without waiting for the re-scan.
      if (loadVoices) loadVoices()
      setScanMsg({ type: 'success', text: `Deleted ${id}. Re-scanning...` })
      // Auto re-scan after delete
      setTimeout(async () => {
        try {
          const r = await api('/api/assets/scan', { method: 'POST' })
          if (r.ok) {
            setAssets(r.data.assets || {})
            if (loadVoices) loadVoices()
            setScanMsg({ type: 'success', text: `Deleted ${id}. Scan complete - ${r.data.scanned || 0} voice(s) found` })
          }
        } catch (_) {}
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
    // Scan all already syncs voices.json, so the voice should already be in the list.
    setSelectedVoice(assetId)
    setPage('generate')
  }

  const handleUseAsReference = (audioPath, text) => {
    // Switch to the expanded asset's voice and go to Generate page.
    // Reference audio + text are auto-loaded from segments.json.
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

  // Summary totals (Phase 1, Part 6) — derived entirely from existing /api/assets data
  const totals = assetEntries.reduce((acc, [, asset]) => {
    const a = asset.assets || {}
    acc.voices += 1
    acc.raw += (a.raw?.file_count || 0)
    acc.rawDur += (a.raw?.total_duration || 0)
    acc.slices += (a.slices?.file_count || 0)
    acc.gpt += (a.checkpoints?.gpt || []).length
    acc.sovits += (a.checkpoints?.sovits || []).length
    acc.segments += (asset.segment_total || 0)
    return acc
  }, { voices: 0, raw: 0, rawDur: 0, slices: 0, gpt: 0, sovits: 0, segments: 0 })

  // Derive a health badge for a voice from its available assets.
  // Color-blind friendly: every state carries a distinct shape glyph (sym),
  // so states stay distinguishable without relying on color alone.
  const voiceHealth = (asset) => {
    const a = asset.assets || {}
    const hasGpt = (a.checkpoints?.gpt || []).length > 0
    const hasSovits = (a.checkpoints?.sovits || []).length > 0
    const hasRaw = (a.raw?.file_count || 0) > 0
    const hasSlices = (a.slices?.file_count || 0) > 0
    const hasSegs = (asset.segment_total || 0) > 0
    const scanned = hasGpt || hasSovits || hasRaw || hasSlices || hasSegs
    if (!scanned) return { key: 'needscan', label: 'Needs Scan', cls: 'badge-muted', sym: '○' }
    if (!hasGpt || !hasSovits) {
      const which = (!hasGpt && !hasSovits) ? 'Models' : (!hasGpt ? 'GPT' : 'SoVITS')
      return { key: 'nomodel', label: `Missing ${which}`, cls: 'badge-danger', sym: '✕' }
    }
    if (!hasSegs) {
      if (!hasRaw && !hasSlices) {
        return { key: 'norefs', label: 'No Refs', cls: 'badge-danger2', sym: '■',
                 note: 'No raw / slices / segments — re-import audio to rebuild.' }
      }
      if (hasSlices) {
        // Slices still present → segments can be regenerated cheaply (no re-slice).
        return { key: 'noseg', label: 'No Segments', cls: 'badge-seg', sym: '▲',
                 note: 'Slices present — rebuild segments.json from them (no re-slicing, no training).' }
      }
      // Models present (passed the model check above) + raw, but slices/segments gone.
      // Still usable: raw works as reference audio. Restore text refs via ASR (no retrain).
      return { key: 'rawrefs', label: 'Raw Refs', cls: 'badge-ok2', sym: '◑',
               note: 'Usable now — raw serves as reference audio. Run ASR to restore text refs (no re-slicing, no retraining).' }
    }
    // "Complete" (green ●) is FULL health: models + segments + BOTH raw and slices.
    // If either raw or slices is missing (but models + segments remain), the asset is
    // still usable but not fully healthy → "Ready" (blue half ◐), with a source-aware
    // note. This keeps the badge honest: a normally-imported asset that later had its
    // slices removed no longer masquerades as green "Complete".
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

  // Search + filter (Part 6) — all derived from existing /api/assets data
  const healthCounts = assetEntries.reduce((acc, [, asset]) => {
    const l = voiceHealth(asset).label
    acc[l] = (acc[l] || 0) + 1
    return acc
  }, {})
  // Text Issues is an orthogonal axis (reference-text health, not model/segment health):
  // an asset that can be transcribed but has no usable text (none) or stale/broken
  // paths (invalid). Surfaced as its own chip so warnings live in the filter row
  // instead of a resident per-card banner.
  const hasTextIssue = (asset) => {
    const canTx = (asset.raw?.file_count || 0) > 0 || (asset.slices?.file_count || 0) > 0
    const st = asset.reference_text?.state
    return canTx && (st === 'none' || st === 'invalid')
  }
  const textIssueCount = assetEntries.reduce((n, [, a]) => n + (hasTextIssue(a) ? 1 : 0), 0)
  // Keep a stable filter order; only show chips for states that actually occur
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
          <button className="btn btn-sm btn-primary" onClick={handleScan} disabled={scanning}>
            {scanning ? 'Scanning...' : 'Scan All'}
          </button>
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
        {/* Collapsed pill with no summary bar to tuck into (empty asset list) */}
        {!noteExpanded && assetEntries.length === 0 && (
          <NamingNotePill onOpen={() => setNoteOpen(true)} />
        )}
        <RebuildProgress job={rebuildJob} onDismiss={dismissRebuild} />
        {assetEntries.length > 0 && (
          <div className="summary-bar">
            <span className="stat-pill"><span className="sp-v">{totals.voices}</span><span className="sp-k">voices</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.raw}</span><span className="sp-k">raw files</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.rawDur.toFixed(1)}s</span><span className="sp-k">raw dur</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.slices}</span><span className="sp-k">slices</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.gpt}</span><span className="sp-k">GPT ckpts</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.sovits}</span><span className="sp-k">SoVITS ckpts</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.segments}</span><span className="sp-k">segments</span></span>
            {/* Collapsed hint floats to the free space right of the stat pills */}
            {!noteExpanded && <NamingNotePill className="nn-in-bar" onOpen={() => setNoteOpen(true)} />}
          </div>
        )}
        {assetEntries.length > 0 && (
          <div className="assets-toolbar">
            <input
              className="control assets-search"
              type="text"
              placeholder="Search by voice name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <div className="filter-chips">
              {filterChips.map(f => {
                const count = f === 'Text Issues' ? textIssueCount : healthCounts[f]
                const warn = f === 'Text Issues'
                return (
                  <button
                    key={f}
                    className={`chip ${warn ? 'chip-warn' : ''} ${filter === f ? 'chip-on' : ''}`}
                    onClick={() => setFilter(f)}
                  >
                    {f}{f !== 'All' && count ? ` (${count})` : ''}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {assetEntries.length > 0 && filteredEntries.length === 0 && (
          <div className="msg" style={{ marginBottom: 10 }}>
            No voices match {q ? `“${search.trim()}”` : 'this filter'}.
            <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => { setSearch(''); setFilter('All') }}>Clear</button>
          </div>
        )}
        {assetEntries.length === 0 && (
          <div className="empty-state">
            <div className="es-title">No voice assets yet</div>
            <div className="es-sub">Scan your assets directory to detect voices, or fine-tune a new voice to get started.</div>
            <div className="empty-actions">
              <button className="btn btn-sm btn-primary" onClick={handleScan} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan Dataset'}</button>
              <button className="btn btn-sm" onClick={() => setPage('train')}>Start Tuning</button>
            </div>
          </div>
        )}
        {filteredEntries.map(([id, asset]) => {
          const a = asset.assets || {}
          const raw = a.raw || {}
          const slices = a.slices || {}
          const ckpts = a.checkpoints || {}
          const gptCount = (ckpts.gpt || []).length
          const sovitsCount = (ckpts.sovits || []).length
          const segCount = asset.segment_total || 0
          const h = voiceHealth(asset)
          const canRebuild = (raw.file_count || 0) > 0 || (slices.file_count || 0) > 0
          // Restore via the dependency planner (shortest path). Both "Raw Refs" and
          // "Missing Models" open the same modal: the planner reuses existing slices
          // and ASR, so e.g. a missing-model voice that still has slices+list only
          // runs preprocess+train — it never re-slices or re-transcribes.
          // Also offered for a "Ready" asset whose slices were removed but raw remains:
          // the same modal can re-slice from raw (sliceChoice='real') to restore full health.
          const canReslice = (raw.file_count || 0) > 0 && (slices.file_count || 0) === 0
          const showRestore = h.key === 'rawrefs' || h.key === 'nomodel' || (h.key === 'ready' && canReslice)
          // No Refs is a dead end (no raw/slices); keep the Train-tab fallback so the
          // user can re-import. No Segments is fixed by Scan alone (no training).
          const showRebuild = h.key === 'norefs'
          const isExpanded = expandedId === id
          const segData = segments[id]
          const isLoadingSegs = segmentsLoading[id]

          return (
            <div key={id} className="card" style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {renamingId === id ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <input
                          className="control"
                          style={{ fontSize: 13, padding: '3px 8px', width: 200 }}
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
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    Mode: {asset.mode || 'N/A'} &middot; ID: {id} &middot; Language: {String(asset.language || asset.text_lang || asset.lang || 'unknown').replace(/^all_/, '')}
                  </div>
                </div>
                <div className="asset-actions">
                  {/* Secondary actions */}
                  <div className="aa-group">
                    <button className="btn btn-sm btn-ghost" onClick={() => handleBrowse(id)}>
                      {isExpanded ? 'Collapse' : 'Browse'}
                    </button>
                    {showRestore ? (
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => setRestoreTarget({ id, displayName: asset.display_name || id })}
                        disabled={scanning}
                        title={h.key === 'nomodel'
                          ? 'Rebuild the missing model. Existing slices and transcripts are reused — only preprocess+train run (no re-slicing, no re-ASR).'
                          : h.key === 'ready'
                            ? 'Slices were removed. Re-slice from raw (choose "Re-slice") and transcribe to restore full health — models are kept unless you opt into retraining.'
                            : 'Choose how to restore: use raw as reference clips or re-slice, transcribe or not — models are kept unless you opt into retraining.'}
                      >
                        {h.key === 'nomodel' ? 'Rebuild…' : h.key === 'ready' ? 'Rebuild slices…' : 'Restore…'}
                      </button>
                    ) : (
                      <button
                        className={`btn btn-sm ${h.key === 'noseg' ? 'btn-primary' : 'btn-ghost'}`}
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
                    {gptCount > 0 && sovitsCount > 0 && (
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
                  {/* Danger action */}
                  <button className="btn btn-sm btn-ghost aa-danger" onClick={() => handleDeleteRequest(id, asset.display_name || id)} title="Delete Asset" style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 8px' }}>
                    <IconTrash size={14} color="var(--danger)" />
                  </button>
                  {/* Primary action */}
                  <button className="btn btn-sm btn-primary" onClick={() => handleSetAsVoice(id)}>
                    Set as Voice
                  </button>
                </div>
              </div>
              {(() => {
                // Reference-text status as a COMPACT pill in the stats row (no extra
                // full-width row → cards stay short). Clicking it reveals the in-place
                // transcribe controls on demand. Advisory-only: inference works without
                // text; a real content check (not mere file existence) drives the state.
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
                // State-derived advisory so the tooltip never lies (backend may omit it).
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
                      <span className="stat-pill"><span className="sp-v">{gptCount}</span><span className="sp-k">GPT</span></span>
                      <span className="stat-pill"><span className="sp-v">{sovitsCount}</span><span className="sp-k">SoVITS</span></span>
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
                            <button className="btn btn-sm btn-ghost" onClick={() => handleCancelTranscribe(id)}>
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
                          {/* Patch #13: proofread the EXISTING transcript (no ASR). */}
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

              {isExpanded && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  {isLoadingSegs && <div className="msg">Loading segments...</div>}
                  {segData && segData.error && <div className="msg msg-error">{segData.error}</div>}
                  {segData && segData.segments && segData.segments.length === 0 && <div className="msg">No segments found.</div>}
                  {segData && segData.segments && segData.segments.length > 0 && (
                    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                      <table className="table" style={{ width: '100%', fontSize: 12 }}>
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
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
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

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setDeleteConfirm(null)}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 320, maxWidth: 420,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <IconTrash size={20} color="var(--danger)" />
              <span style={{ fontWeight: 600, fontSize: 14 }}>Delete Asset</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
              Are you sure you want to delete <strong>{deleteConfirm.displayName}</strong>?
            </p>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
              This will permanently delete the asset folder and its voice configuration.
              This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={() => setDeleteConfirm(null)} disabled={deleting}>Cancel</button>
              <button className="btn btn-sm btn-danger" onClick={handleDeleteConfirm} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restore Asset Modal (dependency-driven repair with user-chosen options) */}
      {restoreTarget && (
        <RestoreModal
          id={restoreTarget.id}
          displayName={restoreTarget.displayName}
          onClose={() => setRestoreTarget(null)}
          onStarted={handleRebuildStarted}
        />
      )}

      {/* Patch #13: proofread the existing reference transcript (no ASR). */}
      {proofTarget && (
        <ReferenceTranscriptProofing
          voiceId={proofTarget.id}
          asrRunning={transcribeJobs[proofTarget.id]?.status === 'running'}
          onClose={() => setProofTarget(null)}
          onSaved={() => {
            setSegments(s => { const n = { ...s }; delete n[proofTarget.id]; return n })
            loadAssets()
          }}
          onRerunAsr={(source) => { setProofTarget(null); handleTranscribe(proofTarget.id, source) }}
        />
      )}

      {/* Patch #12: S2 acoustic refinement → derive a new voice. */}
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
            // Adopt the refine task so its progress — and the ASR proofreading panel
            // when "Pause after ASR" was requested — surface on the Train page (the
            // only place the review UI renders). Without this the paused task would
            // sit in awaiting_review with no way to proofread it.
            if (data && data.taskId && setActiveTaskId) {
              setActiveTaskId(data.taskId)
              setPage('train')
            }
          }}
        />
      )}

      {/* Assets-directory migration: current dir is non-empty, ask what to do. */}
      {migrateTarget && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => { if (!configBusy) setMigrateTarget(null) }}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 380, maxWidth: 520,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <IconFolder size={20} color="var(--accent)" />
              <span style={{ fontWeight: 600, fontSize: 14 }}>Change Assets Directory</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
              New directory:
            </p>
            <div style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--bg)', padding: '6px 8px', borderRadius: 4, wordBreak: 'break-all', marginBottom: 14 }}>
              {migrateTarget}
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
              The current assets directory contains <strong>{Object.keys(assets).length}</strong> voice{Object.keys(assets).length === 1 ? '' : 's'}.
              What should happen to that data? Changes take effect after a server restart.
            </p>
            <div className="migrate-advisory">
              <strong>Recommended:</strong> choose <em>Switch only</em>, then copy the data yourself
              in your file manager and restart. The built-in copy can stall or fail on files that are
              in use (a loaded model, an open Explorer/audio window), and such locks are hard to
              recover from. Use Copy/Move only when you're sure nothing here is open.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn btn-primary" disabled={configBusy} onClick={() => applyAssetsDir(migrateTarget, 'switch')}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
                ➡️ Switch only (recommended) — point at the new directory, migrate the data yourself
              </button>
              <button className="btn" disabled={configBusy} onClick={() => applyAssetsDir(migrateTarget, 'copy')}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
                📋 Copy — duplicate existing voices into the new directory (keep originals)
              </button>
              <button className="btn" disabled={configBusy} onClick={() => applyAssetsDir(migrateTarget, 'move')}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
                ✂️ Move — copy, verify, then delete originals (skips locked files check → may fail)
              </button>
              <button className="btn btn-ghost" disabled={configBusy} onClick={() => setMigrateTarget(null)}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
                ✕ Cancel
              </button>
            </div>
            {configBusy && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>Starting…</div>}
          </div>
        </div>
      )}

      {/* Background copy/move progress — simple copy → verify → delete pipeline. */}
      {migrateJob && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => { if (migrateJob.done) setMigrateJob(null) }}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 420, maxWidth: 560,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <IconFolder size={20} color="var(--accent)" />
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                {migrateJob.migration === 'move' ? 'Moving' : 'Copying'} assets
              </span>
            </div>
            <div className="migrate-steps">
              {['copy', ...(migrateJob.migration === 'move' ? ['verify', 'delete'] : [])].map(k => {
                const label = k === 'copy' ? 'Copy' : k === 'verify' ? 'Verify integrity' : 'Delete originals'
                const st = migrateJob.steps?.[k] || 'pending'
                const mark = st === 'done' ? '✓' : st === 'running' ? '⋯' : st === 'failed' ? '✕' : '○'
                return (
                  <div key={k} className={`migrate-step migrate-step-${st}`}>
                    <span className="migrate-step-mark">{mark}</span>
                    <span className="migrate-step-label">{label}</span>
                    {st === 'running' && migrateJob.total > 0 && (
                      <span className="migrate-step-count">{migrateJob.current}/{migrateJob.total}</span>
                    )}
                  </div>
                )
              })}
            </div>
            {!migrateJob.done && migrateJob.currentName && (
              <div className="migrate-current" title={migrateJob.currentName}>
                {migrateJob.phase}: {migrateJob.currentName}
              </div>
            )}
            {migrateJob.done && migrateJob.error && (
              <div className="msg msg-error" style={{ marginTop: 12 }}>
                {migrateJob.error}
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  Nothing was deleted from your current directory. Close anything using these files
                  (loaded models, open Explorer/audio windows) and retry, or use Switch only and copy manually.
                </div>
              </div>
            )}
            {migrateJob.done && !migrateJob.error && (
              <div className="msg msg-success" style={{ marginTop: 12 }}>{migrateJob.note || 'Done. Restart to apply.'}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-sm" disabled={!migrateJob.done} onClick={() => setMigrateJob(null)}>
                {migrateJob.done ? 'Close' : 'Working…'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-app folder browser — pick an assets directory reliably on any OS. */}
      {browseOpen && (
        <div className="fs-browser-overlay" onClick={() => setBrowseOpen(false)}>
          <div className="fs-browser" onClick={e => e.stopPropagation()}>
            <div className="fs-browser-hdr">
              <IconFolder size={18} color="var(--accent)" />
              <span className="fs-browser-title">Choose assets directory</span>
              <button className="btn-icon" title="Close" onClick={() => setBrowseOpen(false)}>✕</button>
            </div>
            <div className="fs-browser-path">
              <button className="btn btn-sm"
                title={browseData?.parent === '' ? 'Back to drive list' : 'Up one level'}
                disabled={browseBusy || browseData?.isDriveList || browseData?.parent == null}
                onClick={() => browseTo(browseData?.parent ?? '')}>
                {browseData?.parent === '' ? '↑ Drives' : '↑ Up'}
              </button>
              <input className="assets-dir-input" style={{ flex: 1 }}
                value={browseData?.isDriveList ? '' : (browseData?.path || '')}
                placeholder={browseData?.isDriveList ? 'Select a drive…' : 'Path…'}
                onChange={e => setBrowseData(d => ({ ...(d || {}), path: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') browseTo(e.target.value) }}
                title="Type a path and press Enter, or double-click a folder below" />
              <button className="btn btn-sm" disabled={browseBusy}
                onClick={() => browseTo(browseData?.path || '')}>Go</button>
              <button className="btn btn-sm" title="Create a new sub-folder here"
                disabled={browseBusy || browseData?.isDriveList || !browseData?.path}
                onClick={createSubfolder}>+ New</button>
            </div>
            <div className="fs-browser-list">
              {browseBusy && <div className="fs-browser-empty">Loading…</div>}
              {!browseBusy && browseError && (
                <div className="fs-browser-error">
                  <div>{browseError}</div>
                  {browseData?.path && !browseData?.isDriveList && (
                    <button className="btn btn-sm" style={{ marginTop: 8 }}
                      onClick={() => mkdirThenOpen(browseData.path)}>
                      Create “{browseData.path}”
                    </button>
                  )}
                </div>
              )}
              {!browseBusy && !browseError && browseData?.isDriveList && browseData.drives.map(d => (
                <div key={d.path} className="fs-browser-item" onClick={() => browseTo(d.path)}>
                  <IconFolder size={14} color="var(--muted)" /> <span>{d.name}</span>
                </div>
              ))}
              {!browseBusy && !browseError && !browseData?.isDriveList && (browseData?.dirs?.length
                ? browseData.dirs.map(d => (
                    <div key={d.path} className="fs-browser-item" onClick={() => browseTo(d.path)}>
                      <IconFolder size={14} color="var(--muted)" /> <span>{d.name}</span>
                    </div>
                  ))
                : <div className="fs-browser-empty">No sub-folders here.</div>)}
            </div>
            <div className="fs-browser-ftr">
              <span className="fs-browser-current" title={browseData?.path || ''}>
                {browseData?.isDriveList ? 'Pick a drive to open' : (browseData?.path || '')}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setBrowseOpen(false)}>Cancel</button>
                <button className="btn btn-primary btn-sm"
                  disabled={browseBusy || browseData?.isDriveList || !browseData?.path}
                  onClick={chooseBrowsedFolder}>Use this folder</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ===========================
//  BROKER TAB (P4 — MVP)
// ===========================
// The distribution surface: recipes grouped by voice, the OpenAI-compatible
// endpoint + a copyable example curl (voice = role/name), recipe deletion, and
// model re-bind (two avenues: project-query dropdowns backed by
// /api/recipes-models/:role, and a manual project-relative path field — the
// folder-icon fallback; a native file browser is a later polish).

export {
  AssetsTab,
}
