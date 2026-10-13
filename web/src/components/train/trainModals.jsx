// AUTO-EXTRACTED from TrainingTab.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef } from 'react'
import { useT } from '../../lib/i18n'
import { api } from '../../lib/api'
import { buildSliceParams, buildAsrParams, buildTrainingParams } from './trainParams'
import { REBUILD_PARAM_DEFAULTS } from './trainConstants'
import { SliceParamFields, AsrParamFields, TrainParamFields } from './ParamCols'

// Styled in-app prompt for naming a saved UVR5 preset — replaces window.prompt()
// (whose native chrome looks like a browser error). Reuses .modal-overlay/.confirm-card.
function PresetNameModal({ open, existingNames = [], onSave, onClose, example = 'my-preset' }) {
  const { t: tr } = useT()
  const [name, setName] = useState('')
  useEffect(() => { if (open) setName('') }, [open])
  if (!open) return null
  const trimmed = name.trim()
  const exists = existingNames.includes(trimmed)
  const submit = () => { if (trimmed) onSave(trimmed) }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card" onClick={e => e.stopPropagation()}>
        <div className="confirm-hdr"><span>{tr('Save as preset', '保存为预设')}</span></div>
        <div className="confirm-body">
          <div className="field">
            <label className="field-label">{tr('Preset name', '预设名称')}</label>
            <input className="control" value={name} autoFocus
                   placeholder={tr(`e.g. ${example}`, `例如 ${example}`)}
                   onChange={e => setName(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose() }} />
            {exists && (
              <div className="field-hint" style={{ color: 'var(--warning, var(--accent))' }}>
                {tr('A preset with this name exists and will be overwritten.', '已存在同名预设，将被覆盖。')}
              </div>
            )}
          </div>
        </div>
        <div className="confirm-actions">
          <button className="btn btn-sm" onClick={onClose}>{tr('Cancel', '取消')}</button>
          <button className="btn btn-sm btn-primary" disabled={!trimmed} onClick={submit}>
            {exists ? tr('Overwrite', '覆盖') : tr('Save', '保存')}
          </button>
        </div>
      </div>
    </div>
  )
}

// Second-level confirm for irreversible actions (preset delete, etc.). A preset is
// a small user asset — an accidental click should not silently destroy it.
function ConfirmModal({ open, title, message, confirmLabel, onConfirm, onClose }) {
  const { t: tr } = useT()
  if (!open) return null
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card" onClick={e => e.stopPropagation()}>
        <div className="confirm-hdr"><span>{title}</span></div>
        <div className="confirm-body">
          <p style={{ fontSize: 13, margin: 0 }}>{message}</p>
        </div>
        <div className="confirm-actions">
          <button className="btn btn-sm" onClick={onClose}>{tr('Cancel', '取消')}</button>
          <button className="btn btn-sm btn-danger" onClick={onConfirm}>{confirmLabel || tr('Delete', '删除')}</button>
        </div>
      </div>
    </div>
  )
}

// ============================
//  RESTORE ASSET MODAL
// ============================
// Secondary menu for dependency-driven asset repair. Instead of silently
// executing the backend's shortest path, this lets the user choose HOW to
// restore (re-slice vs. use raw as-is, transcribe or not, retrain or not) and
// tune the slice / training parameters that the chosen path will use. The
// backend planner stays authoritative: it re-plans on every option change
// (execute:false) so the live "Plan" preview always reflects what will run.
function RestoreModal({ id, displayName, onClose, onStarted }) {
  const { t: tr } = useT()
  const [state, setState] = useState(null)        // { R, S, L, Seg, M }
  const [plan, setPlan] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState(null)
  // User intent (drives the planner)
  const [sliceChoice, setSliceChoice] = useState('noslice') // 'noslice' (raw is the source) | 'real' (re-slice)
  const [doAsr, setDoAsr] = useState(true)
  // S1 (GPT) and S2 (SoVITS) are independent — the user can retrain either, both, or
  // neither. Seeded from which weights are actually missing (state.Mg / state.Ms).
  const [trainS1, setTrainS1] = useState(false)
  const [trainS2, setTrainS2] = useState(false)
  const seeded = useRef(false)
  // Parameter overrides — share the exact same field set & panels as the Training
  // page, so the rebuild flow exposes every parameter the formal flow does.
  const [showSliceParams, setShowSliceParams] = useState(false)
  const [showAsrParams, setShowAsrParams] = useState(false)
  const [showTrainParams, setShowTrainParams] = useState(false)
  const [form, setForm] = useState({ ...REBUILD_PARAM_DEFAULTS })
  const setField = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const buildOpts = () => {
    const o = {
      reslice: sliceChoice === 'real',
      skipAsr: !doAsr,
      mode: (trainS1 || trainS2) ? 'full' : 'safe',
    }
    // Only send explicit per-model flags once we know a model is missing, so the
    // safe-mode deferral path (no modal) keeps its "confirm before training" behavior.
    if (state && !state.M) { o.trainS1 = trainS1; o.trainS2 = trainS2 }
    return o
  }

  // Assemble customParams shaped for the training pipeline. Only include the
  // sections whose stage actually runs, so we never override unrelated defaults.
  const buildParams = (stages) => {
    const params = {}
    const steps = {}
    if (stages.includes('slice') && sliceChoice === 'real') {
      steps.slice = { params: buildSliceParams(form) }
    }
    if (stages.includes('asr')) {
      steps.asr = { params: buildAsrParams(form) }
    }
    if (Object.keys(steps).length) params.steps = steps
    if (stages.includes('train_s1') || stages.includes('train_s2')) {
      params.training = buildTrainingParams(form)
    }
    return params
  }

  // Re-plan (dry run) whenever the intent options change so the preview stays truthful.
  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr(null)
    api(`/api/assets/${id}/rebuild`, { method: 'POST', body: { execute: false, ...buildOpts() } })
      .then(r => {
        if (cancelled) return
        const data = r.data || {}
        setState(data.state || null)
        setPlan(data)
        if (!r.ok) setErr(data.error || 'Failed to plan rebuild')
        // Seed choices once from the backend's default shortest path.
        if (!seeded.current && data.state) {
          seeded.current = true
          if (!data.state.S) setSliceChoice(data.slice_mode === 'slice' ? 'real' : 'noslice')
          // Missing weights → arm retrain of ONLY the missing model(s) so the plan
          // shows the shortest path (reuse existing slices/ASR, train what's absent).
          if (data.state.Mg === false) setTrainS1(true)
          if (data.state.Ms === false) setTrainS2(true)
        }
      })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sliceChoice, doAsr, trainS1, trainS2])

  const submit = async () => {
    setSubmitting(true); setErr(null)
    try {
      const params = buildParams(plan?.stages || [])
      const r = await api(`/api/assets/${id}/rebuild`, {
        method: 'POST',
        body: { execute: true, ...buildOpts(), params },
      })
      if (r.ok) { onStarted(id, r.data); onClose() }
      else setErr(r.data?.error || 'Rebuild failed')
    } catch (e) { setErr(e.message) }
    finally { setSubmitting(false) }
  }

  const stages = plan?.stages || []
  const asrInPlan = stages.includes('asr')
  const asrForced = asrInPlan && !doAsr // backend forced it despite the toggle (e.g. retrain)
  const trainInPlan = stages.includes('train_s1') || stages.includes('train_s2')
  const realSliceInPlan = stages.includes('slice') && sliceChoice === 'real'
  const hasWork = stages.length > 0 || plan?.needs_segments
  const isNoop = !!plan?.noop

  const planLabel = loading ? tr('Computing…', '计算中…')
    : isNoop ? tr('Already complete — nothing to rebuild.', '已完整：无需重建。')
    : stages.length ? stages.join('  →  ')
    : plan?.needs_segments ? 'generateSegments'
    : tr('No steps for the selected options.', '当前所选选项没有需要执行的步骤。')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card restore-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-hdr">
          <div>
            <div className="modal-title">{tr('Restore Asset', '恢复资源')}</div>
            <div className="modal-subtitle">{displayName || id}</div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={submitting}>✕</button>
        </div>

        <p className="modal-desc">
          {tr('Choose how to rebuild the missing artifacts. The shortest safe path is preselected; existing models are always kept unless you opt into retraining.',
              '选择如何重建缺失的产物。已默认选中最短的安全路径；除非主动选择重新训练，否则始终保留现有模型。')}
        </p>

        {/* Current asset state */}
        {state && (
          <div className="asset-state-row">
            {[['R', tr('Raw', '原始')], ['S', tr('Slices', '切片')], ['L', tr('Transcript', '转写文本')], ['Seg', tr('Segments', '分段')], ['Mg', 'GPT'], ['Ms', 'SoVITS']].map(([k, label]) => (
              <span key={k} className={`state-pip ${state[k] ? 'on' : 'off'}`}>
                <span className="state-pip-sym">{state[k] ? '✓' : '–'}</span>{label}
              </span>
            ))}
          </div>
        )}

        {/* Slicing choice — only meaningful when slices are missing */}
        {state && !state.S && state.R && (
          <div className="restore-group">
            <div className="restore-group-title">{tr('Slicing', '切片')}</div>
            <label className="radio-row">
              <input type="radio" name="slice" checked={sliceChoice === 'noslice'} onChange={() => setSliceChoice('noslice')} />
              <span>{tr('Use raw as reference audio', '使用原始音频作为参考音频')} <span className="hint">{tr('— fastest, no slicing; ASR writes raw_opt.list', '最快，不切片；ASR 写入 raw_opt.list')}</span></span>
            </label>
            <label className="radio-row">
              <input type="radio" name="slice" checked={sliceChoice === 'real'} onChange={() => setSliceChoice('real')} />
              <span>{tr('Re-slice raw into clips', '将原始音频重新切成片段')} <span className="hint">{tr('— cleaner cuts, slower; forces re-transcribe', '切分效果更佳，但更慢；会强制重新转写')}</span></span>
            </label>

            {/* Slice parameters — only when real slicing is selected */}
            {realSliceInPlan && (
              <div className="collapsible" style={{ marginTop: 10 }}>
                <div className="collapsible-hdr" onClick={() => setShowSliceParams(v => !v)}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{tr('Slice Parameters', '切片参数')}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showSliceParams ? '▲' : '▼'}</span>
                </div>
                {showSliceParams && (
                  <div className="collapsible-body" style={{ padding: 12 }}>
                    <SliceParamFields form={form} setField={setField} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ASR choice */}
        {state && (!state.L || !state.S) && (
          <div className="restore-group">
            <div className="restore-group-title">{tr('Transcribe (ASR)', '转写 (ASR)')}</div>
            <label className="toggle-row">
              <input type="checkbox" checked={doAsr || asrForced} disabled={asrForced} onChange={e => setDoAsr(e.target.checked)} />
              <span>
                {tr('Run ASR to (re)generate the transcript & segments', '运行 ASR 以（重新）生成转写文本与分段')}
                {asrForced && <span className="hint"> {tr('— required for the selected options', '所选选项需要此步骤')}</span>}
                {!doAsr && !asrForced && <span className="hint-warn"> {tr('— skipped: reference-text-free', '已跳过：不使用参考文本')}</span>}
              </span>
            </label>

            {/* ASR parameters — only when ASR actually runs */}
            {asrInPlan && (
              <div className="collapsible" style={{ marginTop: 10 }}>
                <div className="collapsible-hdr" onClick={() => setShowAsrParams(v => !v)}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{tr('ASR Parameters', 'ASR 参数')}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showAsrParams ? '▲' : '▼'}</span>
                </div>
                {showAsrParams && (
                  <div className="collapsible-body" style={{ padding: 12 }}>
                    <AsrParamFields form={form} setField={setField} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Retrain choice + training parameters — only when a weight is missing.
            S1 (GPT) and S2 (SoVITS) are independent steps, so each can be retrained
            on its own; the missing one is preselected. */}
        {state && !state.M && (
          <div className="restore-group">
            <div className="restore-group-title">{tr('Models', '模型')}</div>
            <label className="toggle-row">
              <input type="checkbox" checked={trainS1} onChange={e => setTrainS1(e.target.checked)} />
              <span>
                Train S1 (GPT)
                {state.Mg === false
                  ? <span className="hint-warn"> {tr('— missing', '缺失')}</span>
                  : <span className="hint"> {tr('— already present, retrain to overwrite', '已存在，重新训练将覆盖')}</span>}
              </span>
            </label>
            <label className="toggle-row">
              <input type="checkbox" checked={trainS2} onChange={e => setTrainS2(e.target.checked)} />
              <span>
                Train S2 (SoVITS)
                {state.Ms === false
                  ? <span className="hint-warn"> {tr('— missing', '缺失')}</span>
                  : <span className="hint"> {tr('— already present, retrain to overwrite', '已存在，重新训练将覆盖')}</span>}
              </span>
            </label>

            {trainInPlan && (
              <div className="collapsible" style={{ marginTop: 10 }}>
                <div className="collapsible-hdr" onClick={() => setShowTrainParams(v => !v)}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{tr('Training Parameters', '训练参数')}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showTrainParams ? '▲' : '▼'}</span>
                </div>
                {showTrainParams && (
                  <div className="collapsible-body" style={{ padding: 12 }}>
                    <TrainParamFields form={form} setField={setField}
                      part={trainS1 && trainS2 ? 'both' : trainS1 ? 's1' : 's2'} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Plan preview */}
        <div className="plan-preview">
          <div className="plan-preview-label">PLAN</div>
          <div className={`plan-preview-body ${loading ? 'muted' : ''}`}>{planLabel}</div>
          {(plan?.warnings || []).map((w, i) => (
            <div key={i} className="plan-warn">⚠ {w}</div>
          ))}
        </div>

        {err && <div className="msg msg-error" style={{ marginBottom: 10 }}>{err}</div>}

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-sm btn-primary" onClick={submit} disabled={submitting || loading || !hasWork || isNoop}>
            {submitting ? tr('Starting…', '启动中…') : (trainInPlan ? 'Rebuild & Train' : 'Restore')}
          </button>
        </div>
      </div>
    </div>
  )
}

export {
  PresetNameModal,
  ConfirmModal,
  RestoreModal,
}
