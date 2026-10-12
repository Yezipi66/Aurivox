import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Select } from '../common/Select'
import { api } from '../../lib/api'
import { FsFilePicker } from '../common/Dialogs'
import { basename, TARGET_LANG_OPTIONS } from '../../lib/format'
import { usePreviewMode } from '../../lib/previewMode'
import { useT } from '../../lib/i18n'
import { usePersistentState } from '../../usePersistentState'
import { BrokerApiNoteCard, BrokerApiNotePill } from '../common/Fields'
import { modelCountsByEngine, paramsSummaryOf } from '../../lib/modelPickers.pure.js'

// ============================
// Compact workbench context / status row (Phase 1, Part 1.1)
// Frontend-only: derives from existing /api/assets, /api/health and the
// active training task. Missing data degrades to graceful placeholders.
export function ContextRow({ voices, selectedVoice, health, activeTaskId, activity }) {
  const [previewMode, setPreviewMode] = usePreviewMode()
  const [meta, setMeta] = useState(null)
  const [taskStatus, setTaskStatus] = useState(null)
  // Any in-place "Generate reference text" (Fill missing) job, from anywhere. These
  // run server-side independently of the Assets page, so the global Task slot must
  // reflect them too — not only training/inference. Backend is the source of truth
  // (GET /api/transcribe-jobs), so this lights up regardless of the current page.
  const [restoring, setRestoring] = useState(null) // null | { id }
  // Any running training-pipeline task, from anywhere — NOT only the formal Training
  // tab's task (activeTaskId). A dependency-driven Rebuild/Restore (slice/asr/preprocess/
  // train/finalize/publish) creates its own pipeline task whose id lives outside
  // activeTaskId, so without this the global Task slot would stay "None" while a rebuild
  // is clearly running on the Assets page. Backend /api/train/tasks lists them all.
  const [runningTask, setRunningTask] = useState(null) // null | { id, voiceId, currentStep }

  const voice = voices.find(v => v.id === selectedVoice)

  useEffect(() => {
    let dead = false
    const poll = () => {
      api('/api/transcribe-jobs').then(r => {
        if (dead || !r.ok) return
        const jobs = r.data?.jobs || {}
        const runningId = Object.keys(jobs).find(id => jobs[id].status === 'running')
        setRestoring(runningId ? { id: runningId } : null)
      }).catch(() => {})
      api('/api/train/tasks').then(r => {
        if (dead || !r.ok) return
        const tasks = r.data?.tasks || []
        const run = tasks.find(t => t && t.status === 'running')
        setRunningTask(run ? { id: run.id, voiceId: run.voiceId, currentStep: run.currentStep } : null)
      }).catch(() => {})
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { dead = true; clearInterval(t) }
  }, [])

  useEffect(() => {
    setMeta(null)
    if (!selectedVoice) return
    let dead = false
    api(`/api/assets/${selectedVoice}`).then(r => {
      if (!dead && r.ok && r.data.ok) setMeta(r.data.meta || null)
    }).catch(() => {})
    return () => { dead = true }
  }, [selectedVoice])

  useEffect(() => {
    setTaskStatus(null)
    if (!activeTaskId) return
    let dead = false
    const poll = () => {
      api(`/api/train/status/${activeTaskId}`).then(r => {
        if (!dead && r.ok) setTaskStatus(r.data)
      }).catch(() => {})
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { dead = true; clearInterval(t) }
  }, [activeTaskId])

  // 这个角色手上有哪几台引擎的模型、各几个。
  //
  // 以前这里是写死的两格（GPT / SoVITS），只有第一台引擎能填进去，
  //   别的引擎的模型在这条状态栏上一个字都看不到。现在**有几台引擎就几格**。
  const modelCounts = modelCountsByEngine(meta)

  const item = (k, v, placeholder) => (
    <span className="ctx-item">
      <span className="ctx-k">{k}</span>
      <span className={`ctx-v${placeholder ? ' placeholder' : ''}`}>{v}</span>
    </span>
  )

  // Task slot reflects, in priority order: the formal Training-tab task while running >
  // any OTHER running pipeline task (a dependency-driven Rebuild/Restore) > an in-place
  // reference-text restore (Fill missing / Generate reference text) > a live inference
  // (generation) activity > the last known training result > idle. Anything that
  // actually runs the training pipeline or an in-place ASR now lights this slot,
  // regardless of which page it was launched from.
  let taskLabel = 'None', taskPlaceholder = true, taskBusy = false
  const trainRunning = activeTaskId && taskStatus?.status === 'running'
  // A running pipeline task that is NOT the formal Training-tab task → a rebuild/repair.
  const rebuildRunning = runningTask && runningTask.id !== activeTaskId
  if (trainRunning) {
    taskLabel = `Tuning · ${taskStatus?.currentStep || '…'}`; taskPlaceholder = false; taskBusy = true
  } else if (rebuildRunning) {
    taskLabel = `Rebuilding · ${runningTask.voiceId || runningTask.currentStep || '…'}`; taskPlaceholder = false; taskBusy = true
  } else if (restoring) {
    taskLabel = `Restoring · ${restoring.id}`; taskPlaceholder = false; taskBusy = true
  } else if (activity) {
    taskLabel = activity.label || 'Generating'; taskPlaceholder = false; taskBusy = true
  } else if (activeTaskId) {
    const s = taskStatus?.status
    if (s === 'completed') { taskLabel = 'Completed'; taskPlaceholder = false }
    else if (s === 'failed') { taskLabel = 'Failed'; taskPlaceholder = false }
    else if (s === 'interrupted') { taskLabel = 'Interrupted'; taskPlaceholder = false }
    else if (s === 'cancelled') { taskLabel = 'Cancelled'; taskPlaceholder = false }
    else { taskLabel = 'Restoring…'; taskPlaceholder = false }
  }

  return (
    <div className="ctx-row">
      {item('Voice', voice ? (voice.display_name || voice.id) : 'none selected', !voice)}
      <span className="ctx-sep" />
      {item('Lang', voice ? String(voice.language || '—').toUpperCase() : '—', !voice)}
      <span className="ctx-sep" />
      {modelCounts.length === 0
        ? item('Models', 'none', true)
        : modelCounts.map(c => (
            <span key={c.engineId} style={{ display: 'contents' }}>
              {item(c.engineId, String(c.count), false)}
              <span className="ctx-sep" />
            </span>
          ))}
      {modelCounts.length === 0 && <span className="ctx-sep" />}
      {/* 上下文行显示引擎状态。
          最后一枚读 `health.engine_online`（往端口探活）的灯，已删。
          理由与 engines.js:engineBadge 那一处同一条：端口是第六项，
          引擎是用完即走的进程，"它现在在不在线"是一个不存在的问题；
          对命令行引擎这枚灯永远红，而红灯常亮 = 所有红灯失效。
          不许以任何形式重新加回来（包括改叫 "Ready" / "Idle"）。
          这一行的状态由「Task」那一格说，它说的是**这一次操作**。 */}
      <span className="ctx-item">
        <span className="ctx-k">Task</span>
        <span className={`badge ${taskPlaceholder ? 'badge-neutral' : taskStatus?.status === 'failed' ? 'badge-danger' : taskBusy ? 'badge-accent' : 'badge-info'}`}>{taskLabel}</span>
      </span>
      {/* Global audio-preview mode — applies to every result player app-wide. */}
      <span className="ctx-pvmode" title="Audio preview style for generated results">
        <button type="button"
          className={`ctx-pvmode-btn ${previewMode === 'bar' ? 'active' : ''}`}
          onClick={() => setPreviewMode('bar')} title="Compact bar (fastest)" aria-label="Compact bar preview">
          <svg width="15" height="12" viewBox="0 0 15 12" fill="none" aria-hidden="true">
            <rect x="1" y="5" width="13" height="2" rx="1" fill="currentColor" />
            <circle cx="5" cy="6" r="2" fill="currentColor" />
          </svg>
        </button>
        <button type="button"
          className={`ctx-pvmode-btn ${previewMode === 'waveform' ? 'active' : ''}`}
          onClick={() => setPreviewMode('waveform')} title="Waveform + segment dividers" aria-label="Waveform preview">
          <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor" aria-hidden="true">
            <rect x="1" y="4" width="1.6" height="4" rx="0.8" />
            <rect x="4" y="2" width="1.6" height="8" rx="0.8" />
            <rect x="7" y="0.5" width="1.6" height="11" rx="0.8" />
            <rect x="10" y="3" width="1.6" height="6" rx="0.8" />
            <rect x="13" y="4.5" width="1.6" height="3" rx="0.8" />
          </svg>
        </button>
      </span>
    </div>
  )
}