// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef, useCallback } from 'react'
import { Select } from '../common/Select'
import { api } from '../../lib/api'
import { FsFilePicker } from '../common/Dialogs'
import { basename } from '../../lib/format'
import { usePreviewMode } from '../../lib/previewMode'
import { useT } from '../../lib/i18n'

// PC — Broker model re-bind with a two-level selector:
//   1. primary  = every voice that owns a model of this type (voices-with-models)
//   2. secondary = that voice's GPT ckpts / SoVITS pths (recipes-models/:voiceId)
// plus a "— custom path below —" escape hatch that opens the file picker.
function RecipeModelRebind({ recipe, onSaved }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [voicesList, setVoicesList] = useState(null)   // [{voiceId, displayName, hasGpt, hasSovits}]
  const [gpt, setGpt] = useState(recipe.gpt_ckpt || '')
  const [sovits, setSovits] = useState(recipe.sovits_pth || '')
  // 7.1: a single shared Voice ID drives both the GPT and SoVITS model lists (one row, three dropdowns).
  // Cross-voice mixing is still possible via each model slot's "custom path" escape hatch (D2).
  const [voice, setVoice] = useState(recipe.role || '')
  const [gptModels, setGptModels] = useState([])
  const [sovitsModels, setSovitsModels] = useState([])
  const [gptCustom, setGptCustom] = useState(false)
  const [sovitsCustom, setSovitsCustom] = useState(false)
  const [pickGpt, setPickGpt] = useState(false)
  const [pickSovits, setPickSovits] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)
  const modelCache = useRef({})

  const loadVoiceModels = async (voiceId) => {
    if (!voiceId) return { gpt: [], sovits: [] }
    if (modelCache.current[voiceId]) return modelCache.current[voiceId]
    const r = await api(`/api/recipes-models/${encodeURIComponent(voiceId)}`)
    const m = r.ok ? { gpt: r.data.gpt || [], sovits: r.data.sovits || [] } : { gpt: [], sovits: [] }
    modelCache.current[voiceId] = m
    return m
  }

  const load = async () => {
    if (voicesList) return
    const r = await api('/api/assets/voices-with-models')
    setVoicesList(r.ok ? (r.data.voices || []) : [])
    // Seed both slots from the recipe's own voice; if the pinned file isn't one
    // of that voice's known models, start in custom mode.
    const m = await loadVoiceModels(recipe.role)
    setGptModels(m.gpt); setSovitsModels(m.sovits)
    setGptCustom(!(recipe.gpt_ckpt && m.gpt.some(x => x.path === recipe.gpt_ckpt)))
    setSovitsCustom(!(recipe.sovits_pth && m.sovits.some(x => x.path === recipe.sovits_pth)))
  }

  // Selecting a Voice ID refreshes both the GPT and SoVITS lists, each defaulting to its first entry
  // (kept if the current path still belongs to this voice). Leaves custom mode.
  const onVoiceChange = async (v) => {
    setVoice(v)
    const m = await loadVoiceModels(v)
    setGptModels(m.gpt); setSovitsModels(m.sovits)
    setGptCustom(false); setSovitsCustom(false)
    if (m.gpt.length > 0 && !m.gpt.some(x => x.path === gpt)) setGpt(m.gpt[0].path)
    if (m.sovits.length > 0 && !m.sovits.some(x => x.path === sovits)) setSovits(m.sovits[0].path)
  }

  // PC-3: when a picked model lives outside the project the server refuses with
  // code:"external". We surface a strong warning and require a second, explicit
  // confirmation before re-sending with allow_external_models:true.
  const [extConfirm, setExtConfirm] = useState(null) // { field } | null

  const save = async (allowExternal) => {
    setBusy(true); setError(null); setMsg(null)
    try {
      const body = { gpt_ckpt: gpt, sovits_pth: sovits }
      if (allowExternal) body.allow_external_models = true
      const r = await api(`/api/recipes/${encodeURIComponent(recipe.role)}/${encodeURIComponent(recipe.name)}`, {
        method: 'PUT', body,
      })
      if (!r.ok) {
        if (r.data && r.data.code === 'external') {
          // Pause and ask for an explicit confirmation instead of failing.
          setExtConfirm({ field: r.data.field || 'model' })
          return
        }
        throw new Error((r.data && r.data.error) || `Server error ${r.status}`)
      }
      setExtConfirm(null)
      setMsg('Models updated'); onSaved && onSaved(r.data.recipe)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  if (!open) {
    return <button className="btn btn-sm btn-ghost" onClick={() => { setOpen(true); load() }}>{t('Change models', '更换模型')}</button>
  }

  const modelVoices = (voicesList || []).filter(v => v.hasGpt || v.hasSovits)

  return (
    <div className="rebind">
      {/* 7.1: one row, three dropdowns — Voice ID (shared) · GPT checkpoint · SoVITS model.
          Each model slot keeps a "custom path…" escape hatch (cross-voice / outside the project) (D2/D4). */}
      <div className="rebind-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: '0 1 170px', minWidth: 130 }}>
          <label className="field-label">Voice ID</label>
          <Select className="control" value={voice} onChange={e => onVoiceChange(e.target.value)}>
            {!modelVoices.some(v => v.voiceId === voice) && <option value={voice}>{voice || '— select —'}</option>}
            {modelVoices.map(v => <option key={v.voiceId} value={v.voiceId}>{v.displayName}</option>)}
          </Select>
        </div>
        <div className="field" style={{ flex: '1 1 260px', minWidth: 200 }}>
          <label className="field-label">GPT checkpoint</label>
          <Select className="control"
            value={gptCustom ? '__custom__' : (gptModels.some(m => m.path === gpt) ? gpt : '')}
            title={gptCustom ? gpt : ''}
            onChange={e => { const v = e.target.value; if (v === '__custom__') { setGptCustom(true) } else { setGptCustom(false); setGpt(v) } }}>
            {!gptCustom && !gptModels.some(m => m.path === gpt) && <option value="">— select a checkpoint —</option>}
            {gptModels.map(m => <option key={m.path} value={m.path}>{m.name}{m.steps ? ` (${m.steps})` : ''}</option>)}
            <option value="__custom__">— custom path… —</option>
          </Select>
          {gptCustom && (
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <input className="control" value={gpt} onChange={e => setGpt(e.target.value)}
                placeholder="assets/<voice>/gpt_checkpoints/....ckpt" />
              <button className="btn btn-sm" title="Browse for a .ckpt file" onClick={() => setPickGpt(true)}>📁</button>
            </div>
          )}
        </div>
        <div className="field" style={{ flex: '1 1 260px', minWidth: 200 }}>
          <label className="field-label">SoVITS model</label>
          <Select className="control"
            value={sovitsCustom ? '__custom__' : (sovitsModels.some(m => m.path === sovits) ? sovits : '')}
            title={sovitsCustom ? sovits : ''}
            onChange={e => { const v = e.target.value; if (v === '__custom__') { setSovitsCustom(true) } else { setSovitsCustom(false); setSovits(v) } }}>
            {!sovitsCustom && !sovitsModels.some(m => m.path === sovits) && <option value="">— select a model —</option>}
            {sovitsModels.map(m => <option key={m.path} value={m.path}>{m.name}{m.version ? ` [${m.version}]` : ''}</option>)}
            <option value="__custom__">— custom path… —</option>
          </Select>
          {sovitsCustom && (
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <input className="control" value={sovits} onChange={e => setSovits(e.target.value)}
                placeholder="assets/<voice>/sovits_models/....pth" />
              <button className="btn btn-sm" title="Browse for a .pth file" onClick={() => setPickSovits(true)}>📁</button>
            </div>
          )}
        </div>
      </div>
      {error && <div className="msg msg-error">{error}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}
      {extConfirm && (
        <div className="msg msg-warn">
          <strong>⚠️ {t('This model file is outside the project (not under assets/).', '该模型文件不在项目内（不在 assets/ 目录下）。')}</strong>
          <div style={{ marginTop: 6 }}>
            {t(<>It will be pinned as an <strong>absolute path</strong>. Consequences:</>,
               <>它将以<strong>绝对路径</strong>方式固定。这会带来以下后果：</>)}
            <ul style={{ margin: '4px 0 0 18px' }}>
              <li>{t(<>The original file <strong>must not be moved or renamed</strong> — otherwise every request using this recipe will fail.</>,
                     <>原始文件<strong>不能被移动或重命名</strong>——否则每个使用该 recipe 的请求都会失败。</>)}</li>
              <li>{t(<>The path is tied to <strong>this machine</strong>; the recipe is no longer self-contained.</>,
                     <>该路径与<strong>本机</strong>绑定；此 recipe 不再是自包含的。</>)}</li>
              <li>{t('To distribute it you must ship these model files to the other machine as well (just like the voice assets).',
                     '若要分发，必须把这些模型文件一并拷贝到目标机器（与音色资源一样）。')}</li>
            </ul>
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => save(true)}>
              {busy ? t('Saving…', '保存中…') : t('I understand — pin absolute path', '我已了解——固定为绝对路径')}
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setExtConfirm(null)}>{t('Cancel', '取消')}</button>
          </div>
        </div>
      )}
      <p className="field-hint">{t(
        <>ⓘ Saving rebinds this recipe's model. Every future API call to voice "{recipe.id}" on this endpoint will use the new checkpoint/model; requests already in flight are unaffected.</>,
        <>ⓘ 保存后将重新绑定该 recipe 的模型。此后对该 endpoint 上音色 “{recipe.id}” 的每次 API 调用都会使用新的 checkpoint/模型；已在处理中的请求不受影响。</>)}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-sm btn-primary" disabled={busy || !!extConfirm} onClick={() => save(false)}>{busy ? t('Saving…', '保存中…') : t('Save models', '保存模型')}</button>
        <button className="btn btn-sm" disabled={busy} onClick={() => setOpen(false)}>{t('Close', '关闭')}</button>
      </div>
      <FsFilePicker open={pickGpt} exts={['.ckpt', '.pt']} title="Select a GPT checkpoint (.ckpt)"
        onPick={(p) => setGpt(p)} onClose={() => setPickGpt(false)} />
      <FsFilePicker open={pickSovits} exts={['.pth', '.pt']} title="Select a SoVITS model (.pth)"
        onPick={(p) => setSovits(p)} onClose={() => setPickSovits(false)} />
    </div>
  )
}

function RecipeCard({ recipe, endpoint, onChanged }) {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState(false)
  // 7.3: Example call is collapsed and single-line by default. Windows PS/CMD handle `\` line
  // continuations poorly, so a single line (no continuations) is easiest to copy; expand for full multi-line.
  const [cmdOpen, setCmdOpen] = useState(false)
  // Whole recipe card is collapsed by default; header toggles it open.
  const [open, setOpen] = useState(false)
  // i18n-neutral sample line (follows the UI language) instead of a hardcoded Japanese greeting.
  const sampleInput = t('Hello! This is a sample line.', '你好，这是一段示例文本。')
  const cmd = `curl -X POST ${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $API_KEY" \\
  -d '{"model":"tts-1","voice":"${recipe.id}","input":"${sampleInput}"}' \\
  --output out.wav`
  const cmdOneLine = cmd.replace(/\\\s*\n\s*/g, ' ')

  const copy = () => {
    // Copy the currently displayed form: single line when collapsed (Windows-friendly), full multi-line when expanded.
    try { navigator.clipboard.writeText(cmdOpen ? cmd : cmdOneLine); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch (_) {}
  }
  const del = async () => {
    setBusy(true)
    try {
      const r = await api(`/api/recipes/${encodeURIComponent(recipe.role)}/${encodeURIComponent(recipe.name)}`, { method: 'DELETE' })
      if (r.ok) onChanged && onChanged()
    } finally { setBusy(false); setConfirmDel(false) }
  }

  return (
    <div className="recipe-card">
      <div className="rc-hdr">
        <div className="rc-title" onClick={() => setOpen(o => !o)} style={{ cursor: 'pointer', userSelect: 'none' }}
          title={open ? t('Collapse', '收起') : t('Expand', '展开')}>
          <span style={{ marginRight: 6, fontSize: 11, color: 'var(--muted)' }}>{open ? '▼' : '▶'}</span>
          <span className="rc-display">{recipe.display_name}</span>
          <code className="rc-id">{recipe.id}</code>
        </div>
        <div className="rc-actions">
          {/* Deleting from a collapsed card opens it so the confirm prompt (inside the body) is visible. */}
          <button className="btn btn-sm btn-danger" onClick={() => { setOpen(true); setConfirmDel(true) }} disabled={busy}>Delete</button>
        </div>
      </div>
      {open && (
      <div className="rc-body">
        <div className="rc-grid">
          <div><span className="rc-k">{t('Reference', '参考音频')}</span><span className="rc-v" title={recipe.reference_audio}>{basename(recipe.reference_audio)}</span></div>
          <div><span className="rc-k">{t('Language', '语言')}</span><span className="rc-v">{recipe.language}</span></div>
          <div><span className="rc-k">GPT</span><span className="rc-v" title={recipe.gpt_ckpt}>{recipe.gpt_ckpt ? basename(recipe.gpt_ckpt) : t('(none)', '（无）')}</span></div>
          <div><span className="rc-k">SoVITS</span><span className="rc-v" title={recipe.sovits_pth}>{recipe.sovits_pth ? basename(recipe.sovits_pth) : t('(none)', '（无）')}</span></div>
          <div><span className="rc-k">{t('Params', '参数')}</span><span className="rc-v">top_k {recipe.params?.top_k} · temp {recipe.params?.temperature} · speed {recipe.params?.speed}</span></div>
          <div><span className="rc-k">{t('Source', '来源')}</span><span className="rc-v">{recipe.meta?.source || '—'}{recipe.meta?.notes ? ` · ${recipe.meta.notes}` : ''}</span></div>
        </div>
        <div className="rc-cmd">
          <div className="rc-cmd-hdr">
            <span onClick={() => setCmdOpen(o => !o)} style={{ cursor: 'pointer', userSelect: 'none' }}
              title={cmdOpen ? t('Collapse', '收起') : t('Expand full multi-line command', '展开完整的多行命令')}>
              <span style={{ marginRight: 6, fontSize: 11, color: 'var(--muted)' }}>{cmdOpen ? '▼' : '▶'}</span>
              {t('Example call (OpenAI-compatible)', '调用示例（兼容 OpenAI）')}
            </span>
            <button className="btn btn-sm btn-ghost" onClick={copy}>{copied ? t('Copied', '已复制') : t('Copy command', '复制命令')}</button>
          </div>
          {cmdOpen
            ? <pre className="rc-cmd-body">{cmd}</pre>
            : <pre className="rc-cmd-body" title="Click the title to expand" style={{ whiteSpace: 'pre', overflowX: 'auto' }}>{cmdOneLine}</pre>}
        </div>
        <RecipeModelRebind recipe={recipe} onSaved={() => onChanged && onChanged()} />
        {confirmDel && (
          <div className="msg msg-warn">
            {t(<>Delete recipe <strong>{recipe.id}</strong>? This cannot be undone.</>,
               <>确定删除 recipe <strong>{recipe.id}</strong>？此操作无法撤销。</>)}
            <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={del}>{t('Delete', '删除')}</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => setConfirmDel(false)}>{t('Cancel', '取消')}</button>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  )
}

function BrokerTab() {
  const { t, lang } = useT()
  const [recipes, setRecipes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const endpoint = (typeof window !== 'undefined' ? window.location.origin : '') + '/v1/audio/speech'

  const load = useCallback(() => {
    setLoading(true)
    api('/api/recipes').then(r => {
      if (r.ok && Array.isArray(r.data.recipes)) { setRecipes(r.data.recipes); setError(null) }
      else setError((r.data && r.data.error) || `Server error ${r.status}`)
    }).catch(e => setError(e.message)).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  // Group recipes by role for display.
  const groups = {}
  for (const rec of recipes) { (groups[rec.role] = groups[rec.role] || []).push(rec) }
  const roleKeys = Object.keys(groups).sort()

  return (
    <div>
      <div className="section" style={{ marginBottom: 12 }}>
        <div className="section-hdr"><span>Broker — Distribution</span>
          <button className="btn btn-sm" onClick={load}>{t('Refresh', '刷新')}</button>
        </div>
        <div className="section-body">
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            {t(
              <>Recipes are exposed through the OpenAI-compatible speech endpoint. Set the
              request's <code>voice</code> field to a recipe id (<code>role/name</code>) to synthesize with that
              recipe's pinned models, reference and parameters. Standard OpenAI clients work unchanged.</>,
              <>Recipe 通过兼容 OpenAI 的语音 endpoint 对外暴露。将请求的 <code>voice</code> 字段设为某个 recipe id（<code>role/name</code>），即可使用该 recipe 固定的模型、参考音频与参数进行合成。标准 OpenAI 客户端无需改动即可使用。</>)}
          </p>
          <div className="broker-endpoint">
            <span className="be-k">Endpoint</span>
            <code className="be-url">POST {endpoint}</code>
          </div>
        </div>
      </div>

      {loading && <div className="empty-state" style={{ padding: 16 }}><div className="es-sub">{t('Loading recipes…', '正在加载 recipe…')}</div></div>}
      {error && <div className="msg msg-error">{error}</div>}

      {!loading && !error && recipes.length === 0 && (
        <div className="empty-state" style={{ padding: 20 }}>
          <div className="es-title">{t('No recipes yet', '暂无 recipe')}</div>
          <div className="es-sub">{t(<>Create one with <strong>Save as recipe</strong> on the Generate or Compare Refs page.</>,
                                     <>可在 Generate 或 Compare Refs 页面点击 <strong>Save as recipe</strong> 创建。</>)}</div>
        </div>
      )}

      {roleKeys.map(role => (
        <div className="section" key={role} style={{ marginBottom: 12 }}>
          <div className="section-hdr"><span>{role.toUpperCase()}</span>
            <span className="cmp-count">{groups[role].length} recipe{lang === 'zh' ? '' : (groups[role].length > 1 ? 's' : '')}</span>
          </div>
          <div className="section-body">
            <div className="recipe-list">
              {groups[role].map(rec => (
                <RecipeCard key={rec.id} recipe={rec} endpoint={endpoint} onChanged={load} />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ============================
// Compact workbench context / status row (Phase 1, Part 1.1)
// Frontend-only: derives from existing /api/assets, /api/health and the
// active training task. Missing data degrades to graceful placeholders.
function ContextRow({ voices, selectedVoice, health, activeTaskId, activity }) {
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

  // Pick the "latest" checkpoint (highest step for GPT, last for SoVITS) as
  // the model that Generate would auto-select for this voice.
  const ckpts = meta?.assets?.checkpoints || {}
  const gptList = ckpts.gpt || []
  const sovitsList = ckpts.sovits || []
  const latestGpt = gptList.length
    ? [...gptList].sort((a, b) => (Number(b.steps) || 0) - (Number(a.steps) || 0))[0]
    : null
  const latestSovits = sovitsList.length ? sovitsList[sovitsList.length - 1] : null

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
      {item('GPT', latestGpt ? latestGpt.name : 'not selected', !latestGpt)}
      <span className="ctx-sep" />
      {item('SoVITS', latestSovits ? latestSovits.name : 'not selected', !latestSovits)}
      <span className="ctx-sep" />
      <span className="ctx-item">
        <span className={`badge ${health === null ? 'badge-neutral' : health?.engine_online ? 'badge-ok' : 'badge-danger'}`}>
          {health === null ? '…' : health?.engine_online ? 'Connected' : 'Unreachable'}
        </span>
      </span>
      <span className="ctx-sep" />
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

export {
  BrokerTab,
  ContextRow,
}
