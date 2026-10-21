import { useState, useEffect, useRef } from 'react'
import { Select } from '../common/Select'
import { useT } from '../../lib/i18n'
import { API_BASE, api } from '../../lib/api'
import { LANG_LABEL, TextPrepModal, hanOverrideDirection } from '../pron/PronProofing'
import { IconFolder, IconRerun, IconTrash } from '../common/Icons'
import { Player } from '../common/Player'
import { AuxReferencePicker, CrossRefPicker, CustomRefPicker, RefAudioList } from '../common/RefPickers'
import { REF_MAX_SEC, REF_MIN_SEC, refInRange } from '../../lib/refAudio'
import { basename } from '../../lib/pathText'
import { langLabel, normalizeLangFamily } from '../../lib/langOptions'
import { fieldsForTier, isFieldVisible, initialParamValues, coerceParamValue, paramsToSend, TIERS } from '../../lib/engines'
import { ParamField } from '../common/ParamField'
import { CMP_LANG_OPTIONS, BASE_VOICE_ID } from './compareConstants'

// `engineId` 用于行内的读音校对，要发 /pron/preview，
//   而那个接口现在 engine_id 必传。漏传的表现是"这一行的读音预览安静地不工作"。
function CompareRow({ row, index, allAudioFiles, voiceFiles, onUpdate, onAddAux, onRemoveAux, onGenerate, onRemove, onSaveRecipe, recipes, onLoadRecipe, availableModels, rowModel, onModelChange, defaultParams, selectedVoice, voices, voiceLang, defaultTextLang, masterEngineBatch, engineId, engine }) {
  const { t } = useT()
  const [showPicker, setShowPicker] = useState(false)
  const [recipeId, setRecipeId] = useState('')
  const [pickerTarget, setPickerTarget] = useState('main') // 'main' or 'aux'
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [segments, setSegments] = useState([])  // loaded from segments.json for current voice
  // PF-a: Auxiliary References and Text default to collapsed, auto-expanding only
  // when the row already carries a value so nothing is silently hidden.
  const [showAux, setShowAux] = useState(() => (row.auxRefPaths || []).length > 0)
  const [showText, setShowText] = useState(() => !!(row.text && row.text.trim()))
  // PF-b / D1: this voice's slices get an auditable list. After the redundant slice
  // <Select> was removed (6.1), this audition list is the SOLE slice picker, so it
  // defaults to EXPANDED.
  const [showSlicePreview, setShowSlicePreview] = useState(true)
  // PF-c: auxiliary reference source/custom state now lives inside the shared
  // AuxReferencePicker，CompareRow 不再在本地跟踪它。
  // 6.5: inline confirm for deleting a Compare result's audio from disk.
  const [cmpDelConfirm, setCmpDelConfirm] = useState(false)

  // Determine which voice this row uses. Reference audio, slices and language all
  // follow the SoVITS (timbre) source (C3), so a mixed A-GPT + B-SoVITS row browses
  // B's slices for its reference. The GPT source only affects the GPT checkpoint list.
  const voiceId = rowModel.sovitsVoiceId || rowModel.voiceId || selectedVoice
  // This row's own model language — the reading-proofing panel is keyed off THIS
  // row's model, not the Generate page's shared voice, so its Han-direction and
  // default readings match exactly what generateRow sends to the engine.
  const rowVoiceLang = availableModels.find(m => m.voiceId === voiceId)?.language
    || voices.find(v => (v.id || v.voiceId) === voiceId)?.language || voiceLang || 'ja'

  // Per-row target language: overrides the shared default; empty = follow default.
  const effTextLang = row.textLang || defaultTextLang || rowVoiceLang || 'ja'
  const _rowTargetFam = normalizeLangFamily(effTextLang)
  const _rowBaseFam = String(rowVoiceLang || '').replace(/^all_/, '')
  // Language family used by this row's reading-proofing panel (P1-1).
  const rowPronLang = _rowTargetFam || _rowBaseFam
  // #4: this row's per-character Han-character language direction (or null).
  const rowHanDir = hanOverrideDirection(effTextLang, rowVoiceLang)
  const rowHanForced = row.hanForced || []
  const [showRowTextPrep, setShowRowTextPrep] = useState(false)
  // Reference source: 'slices' (this voice, default) | 'cross' | 'custom'.
  const refSource = row.refSource || 'slices'
  const setRefSource = (v) => onUpdate(row.id, 'refSource', v)

  // Duration of the currently selected main reference, resolved across every
  // source (this-voice slice / cross-voice slice / raw / custom upload) so the
  // row can warn up-front when the clip is outside the engine's 3–10s hard limit.
  const [refDur, setRefDur] = useState(null)
  useEffect(() => {
    const ref = row.refAudio || ''
    setRefDur(null)
    if (!ref) return
    // Fast path: a this-voice slice already carries a server-measured duration.
    const slice = segments.find(s => {
      const raw = s.audio || s.audio_path || s.audio_filename
      const fn = raw ? raw.replace(/\\/g, '/').split('/').pop() : ''
      return ref === `assets/${voiceId}/slicer_opt/${fn}`
    })
    if (slice && typeof slice.duration === 'number' && slice.duration > 0) { setRefDur(slice.duration); return }
    // Otherwise measure any servable asset / custom-upload URL via a detached
    // <audio> element. Unknown sources (e.g. an absolute custom path with no
    // playable URL) stay null so we never raise a false warning.
    let url = null
    if (/^assets\//.test(ref)) url = `/${ref}`
    else if (row.customRef && row.customRef.url) url = row.customRef.url
    if (!url) return
    let cancelled = false
    const a = new Audio()
    a.preload = 'metadata'
    const onMeta = () => { if (!cancelled && isFinite(a.duration) && a.duration > 0) setRefDur(a.duration) }
    a.addEventListener('loadedmetadata', onMeta)
    a.src = url
    return () => { cancelled = true; a.removeEventListener('loadedmetadata', onMeta); a.src = '' }
  }, [row.refAudio, segments, voiceId, row.customRef])
  const refOutOfRange = refDur != null && !refInRange(refDur)

  // Load segments when voice changes
  useEffect(() => {
    if (!voiceId) return
    api(`/api/assets/${voiceId}/segments`).then(r => {
      if (r.ok && r.data.segments) setSegments(r.data.segments.segments || [])
    }).catch(() => setSegments([]))
  }, [voiceId])

  // Auto-select first matched segment as default ref when segments load
  useEffect(() => {
    if (segments.length === 0) return
    if ((row.refSource || 'slices') !== 'slices') return  // don't clobber cross/custom picks
    if (row.refAudio) return  // already set
    const first = segments.find(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
    if (first) {
      const raw = first.audio || first.audio_path || first.audio_filename
      if (!raw) return
      const filename = raw.replace(/\\/g, '/').split('/').pop()
      onUpdate(row.id, 'refAudio', `assets/${voiceId}/slicer_opt/${filename}`)
    }
  }, [segments, voiceId])

  // 超参不手抄：键名与类型都来自当前引擎的 param_schema。
  //
  // 换一台引擎 ⇒ 格子照常显示、填了发出去上游不认、不报错。
  //
  // 形状跟 GenerateTab 完全一致：
  //   paramValues   这一行的格子值（从名片默认值起步）
  //   touched       用户明确动过哪些，paramsToSend 只发这些
  //   touched 不能省。没动过的键是「界面建议」，不是「用户选的」；
  //     全发过去等于平台替用户决定上游默认值。
  const [paramValues, setParamValues] = useState(() => ({
    ...initialParamValues(engine),
    ...(row.params || {}),
  }))
  // row.params 里存着的都是用户动过的（它们当初就是从 touched 存下来的），
  //   所以从配方/旧行恢复出来的值天然算 touched。
  const [touched, setTouched] = useState(() => new Set(Object.keys(row.params || {})))
  const setParam = (name, raw) => {
    const field = (engine?.param_schema || []).find(f => f && f.name === name)
    setParamValues(v => ({ ...v, [name]: field ? coerceParamValue(field, raw) : raw }))
    setTouched(prev => {
      const next = new Set(prev); next.add(name); return next
    })
  }
  // 换引擎 ⇒ 上一台的格子名不匹配这台，重新从名片默认值起步。
  // touched 清空：那些键名是上一台引擎的，跟着过来就是「用户在新引擎上
  //   明确选过旧引擎的参数」，那不存在。
  useEffect(() => {
    setParamValues(initialParamValues(engine))
    setTouched(new Set())
  }, [engine?.id])

  // 存回 row：只存用户动过的那些（GenerateTab:643 同一条纪律）
  // 存两样：params（发出去的形状）+ touched（哪些是用户真动过的）。
  //   touched 必须是能还原的（数组），不能只活在本地 state 里，
  //   generateRow 在 tab 级读的是 row，它拿不到这一行的本地 state。
  useEffect(() => {
    const explicit = paramsToSend(engine, paramValues, touched)
    onUpdate(row.id, 'params', explicit)
    onUpdate(row.id, 'touched', Array.from(touched))
  }, [paramValues, touched, engine?.id])

  // seed 不属于任何一台引擎 ⇒ 不进 param_schema，是平台自己的 state
  //    （GenerateTab:201 同一条纪律）。判据：换一台引擎，这一格含义一个字不变。
  const [seed, setSeed] = useState(row.seed ?? defaultParams?.seed ?? -1)
  useEffect(() => { onUpdate(row.id, 'seed', seed) }, [seed])

  // 不能只取 common 一层：两台
  //   CosyVoice 的 param_schema 的 common 层是空的（6 项和 2 项全在
  //   advanced）⇒ 选它们时对比页画出零个格子，而界面上看不出任何异常。
  //
  //   修法跟 GenerateTab 一样：跟着 TIERS 两档都画，档位按钮也是 TIERS.map
  //，不写死 ['common','advanced']，那份名单在 web/src/lib/engines.js
  //   是唯一产地。
  const [advTier, setAdvTier] = useState('common')
  const visibleFields = (tier) => fieldsForTier(engine, tier)
    .filter(f => isFieldVisible(f, paramValues))
  // 某档一个格子都没有 ⇒ 不画那个档位按钮。画一个点开是空的标签页，
  //    比不画更糟（用户以为这一档坏了）。判据跟方法下拉同一条：名片没给的
  //    界面不许替它编一个。
  const tiersWithFields = TIERS.filter(t => visibleFields(t).length > 0)
  // 当前档被换引擎换空了 ⇒ 落到第一个有格子的档，别停在空档上。
  const effTier = tiersWithFields.includes(advTier) ? advTier : (tiersWithFields[0] || 'common')

  const allFiles = [...allAudioFiles, ...voiceFiles]

  // Derived row status + at-a-glance summary for the polished header (P2).
  // Pure-derived from existing row state — no new state, no logic change.
  const cmpStatus = row.loading ? 'running' : row.error ? 'error' : (row.result && row.result.audio_url) ? 'done' : 'idle'
  const cmpStatusLabel = cmpStatus === 'running' ? 'Generating…' : cmpStatus === 'done' ? 'Ready' : cmpStatus === 'error' ? 'Failed' : 'Not run'
  const cmpRefName = row.refAudio ? basename(row.refAudio) : null
  // For a same-asset stack use the pre-built combo label; for a cross-asset mix
  // (issue #3) compose the label from the GPT and SoVITS entries independently so
  // the header still reads e.g. "A / gpt.ckpt  ×  B / sovits.pth".
  const _gptEntry = availableModels.find(m => m.gptCheckpoint === rowModel.gptCheckpoint)
  const _sovEntry = availableModels.find(m => m.sovitsModel === rowModel.sovitsModel)
  const cmpModelLabel = (availableModels.find(m => m.voiceId === rowModel.voiceId && m.gptCheckpoint === rowModel.gptCheckpoint && m.sovitsModel === rowModel.sovitsModel) || {}).label
    || ([
        _gptEntry ? `${_gptEntry.voiceName} / ${_gptEntry.gptName}${_gptEntry.gptSteps ? ` (${_gptEntry.gptSteps})` : ''}` : null,
        _sovEntry ? `${_sovEntry.voiceName} / ${_sovEntry.sovitsName}${_sovEntry.sovitsVersion ? ` [${_sovEntry.sovitsVersion}]` : ''}` : null,
       ].filter(Boolean).join('  ×  ') || null)
  // 6.3: reference-character name — see at a glance whose reference audio a row uses. Derive the
  // real source from row.refAudio's assets/<voiceId>/ path (works for this-voice and cross-voice).
  // Custom uploads live outside assets/ → labelled Custom; no reference → fall back to model voice.
  const _refAssetVid = (() => {
    const s = String(row.refAudio || '').replace(/\\/g, '/')
    const m = s.match(/(?:^|\/)assets\/([^/]+)\//)
    return m ? m[1] : null
  })()
  const nameForVoiceId = (vid) => vid
    ? ((availableModels.find(m => m.voiceId === vid) || {}).voiceName
       || (voices || []).find(v => (v.id || v.voiceId) === vid)?.display_name
       || (voices || []).find(v => (v.id || v.voiceId) === vid)?.displayName
       || vid)
    : null
  const refVoiceName = _refAssetVid
    ? nameForVoiceId(_refAssetVid)
    : (row.refAudio ? 'Custom' : nameForVoiceId(rowModel.voiceId || selectedVoice))
  // 6.4: after generating, the editor collapses to audio-only for easy side-by-side comparison. Click the ▼ title to re-expand.
  const [editorOpen, setEditorOpen] = useState(() => !(row.result && row.result.audio_url))
  const lastResultUrlRef = useRef(row.result && row.result.audio_url)
  useEffect(() => {
    const url = row.result && row.result.audio_url
    if (url && url !== lastResultUrlRef.current) { setEditorOpen(false) }
    lastResultUrlRef.current = url
  }, [row.result && row.result.audio_url])

  const pickFile = (filePath) => {
    if (pickerTarget === 'main') {
      onUpdate(row.id, 'refAudio', filePath)
    } else {
      onAddAux(row.id, filePath)
    }
    setShowPicker(false)
  }

  return (
    <div className={`card cmp-row cmp-${cmpStatus}`} style={{ position: 'relative' }}>
      {/* Header — index badge + at-a-glance ref/model summary + status pill */}
      <div className="cmp-row-hdr">
        <span className="cmp-badge">{index + 1}</span>
        <div className="cmp-summary">
          <span className="cmp-summary-ref" title={row.refAudio || ''}>
            {cmpRefName || 'No reference selected'}
          </span>
          {/* 6.3: reference-character annotation */}
          {refVoiceName && (
            <span className="cmp-summary-voice" title={`Reference character: ${refVoiceName}`}
              style={{ fontSize: 11, color: 'var(--muted)' }}>🎭 {refVoiceName}</span>
          )}
          {cmpModelLabel && (
            <span className="cmp-summary-model" title={cmpModelLabel}>{cmpModelLabel}</span>
          )}
        </div>
        <span className={`cmp-status cmp-status-${cmpStatus}`}>{cmpStatusLabel}</span>
        <div className="cmp-row-actions">
          {/* 6.4: collapse / expand the editor */}
          <button className="btn btn-sm btn-ghost" onClick={() => setEditorOpen(o => !o)}
            title={editorOpen ? 'Collapse editor (keep audio only)' : 'Expand editor'}>
            {editorOpen ? '▲ Edit' : '▼ Edit'}
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => onGenerate(row)} disabled={row.loading}>
            {row.loading ? '…' : (cmpStatus === 'done' ? 'Regenerate' : 'Generate')}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => onSaveRecipe && onSaveRecipe(row)}
            disabled={!selectedVoice || !row.refAudio}
            title={!row.refAudio ? 'Pick a reference audio first' : 'Save this row as a reusable recipe'}>
            Save as recipe
          </button>
          <Select className="control" value={recipeId} onChange={e=>setRecipeId(e.target.value)} style={{width:155,height:30}}><option value="">Load recipe…</option>{(recipes||[]).map(r=><option key={r.id} value={r.id}>{r.display_name||r.id}</option>)}</Select>
          <button className="btn btn-sm btn-ghost" disabled={!recipeId} onClick={()=>onLoadRecipe?.(row,recipeId)}>Load</button>
          <button className="btn btn-sm btn-danger" onClick={() => onRemove(row.id)} title="Remove from comparison">×</button>
        </div>
      </div>

      {/* Always-visible reference-duration guard: the engine hard-limits reference
          audio to 3–10s, so an out-of-range clip almost certainly errors on run.
          Shown here (outside the collapsible editor) so it's visible even when a
          generated row is collapsed to audio-only. */}
      {refOutOfRange && (
        <div className="cmp-ref-range-warn" style={{ fontSize: 11, color: 'var(--warning)', margin: '0 0 8px' }}>
          {'\u26a0'} Reference audio is {refDur.toFixed(1)}s &mdash; outside the {REF_MIN_SEC}&ndash;{REF_MAX_SEC}s range. This row will likely error (engine hard limit); pick a {REF_MIN_SEC}&ndash;{REF_MAX_SEC}s clip.
        </div>
      )}

      {/* 6.4: editor (language / model / reference / advanced) — collapsed by default after generating. */}
      {editorOpen && (<>
      {/* D3: Target Language moved to the top of the item as a narrow single-row dropdown to save vertical space. */}
      <div className="field cmp-target-lang" style={{ maxWidth: 240, marginBottom: 8 }}>
        <label className="field-label">Target Language</label>
        <Select
          className="control"
          value={row.textLang || ''}
          onChange={e => onUpdate(row.id, 'textLang', e.target.value)}
        >
          <option value="">Use default ({langLabel(defaultTextLang)})</option>
          {CMP_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </div>

      {/* 6.6/6.1: Model split into three cascading dropdowns [Voice ID][GPT][SoVITS]. Voice ID
          drives both the GPT/SoVITS candidate lists and the slice source below (natural linkage). */}
      {availableModels.length > 0 && (() => {
        const voiceOpts = []
        const seenV = new Set()
        availableModels.forEach(m => { if (!seenV.has(m.voiceId)) { seenV.add(m.voiceId); voiceOpts.push({ voiceId: m.voiceId, voiceName: m.voiceName }) } })
        // Cross-asset mixing (issue #3): a "Mix models across assets" toggle. When ON,
        // the GPT and SoVITS dropdowns list EVERY model of EVERY asset (grouped by
        // voice), so the user can freely pair A's GPT with B's SoVITS. When OFF, both
        // dropdowns show only the primary Voice ID's own checkpoints.
        // Reference audio + language follow the SoVITS (timbre) side (C3).
        // Auto-enter mix mode for a stack that is already cross-asset (e.g. a recipe or
        // a persisted row from before the toggle existed) so its selections stay valid.
        const mix = !!rowModel.mix
          || (rowModel.gptVoiceId && rowModel.gptVoiceId !== rowModel.voiceId)
          || (rowModel.sovitsVoiceId && rowModel.sovitsVoiceId !== rowModel.voiceId)
        // Per-voice lists for non-mix mode (the primary Voice ID's own models).
        const gptOpts = []
        const seenG = new Set()
        availableModels.filter(m => m.voiceId === rowModel.voiceId).forEach(m => {
          if (!seenG.has(m.gptCheckpoint)) { seenG.add(m.gptCheckpoint); gptOpts.push({ path: m.gptCheckpoint, name: m.gptName, steps: m.gptSteps }) }
        })
        const sovOpts = []
        const seenS = new Set()
        availableModels.filter(m => m.voiceId === rowModel.voiceId).forEach(m => {
          if (!seenS.has(m.sovitsModel)) { seenS.add(m.sovitsModel); sovOpts.push({ path: m.sovitsModel, name: m.sovitsName, steps: m.sovitsSteps, version: m.sovitsVersion }) }
        })
        // Grouped lists for mix mode — one <optgroup> per voice, all its checkpoints.
        const gptGroupsC = voiceOpts.map(v => {
          const seen = new Set(); const items = []
          availableModels.filter(m => m.voiceId === v.voiceId).forEach(m => {
            if (!seen.has(m.gptCheckpoint)) { seen.add(m.gptCheckpoint); items.push({ path: m.gptCheckpoint, name: m.gptName, steps: m.gptSteps }) }
          })
          return { voiceId: v.voiceId, voiceName: v.voiceName, items }
        }).filter(g => g.items.length)
        const sovGroupsC = voiceOpts.map(v => {
          const seen = new Set(); const items = []
          availableModels.filter(m => m.voiceId === v.voiceId).forEach(m => {
            if (!seen.has(m.sovitsModel)) { seen.add(m.sovitsModel); items.push({ path: m.sovitsModel, name: m.sovitsName, steps: m.sovitsSteps, version: m.sovitsVersion }) }
          })
          return { voiceId: v.voiceId, voiceName: v.voiceName, items }
        }).filter(g => g.items.length)
        const ownerOfGpt = (p) => (availableModels.find(m => m.gptCheckpoint === p) || {}).voiceId || ''
        const ownerOfSov = (p) => (availableModels.find(m => m.sovitsModel === p) || {}).voiceId || ''
        const modelsMixed = (rowModel.gptVoiceId && rowModel.gptVoiceId !== rowModel.voiceId)
          || (rowModel.sovitsVoiceId && rowModel.sovitsVoiceId !== rowModel.voiceId)
        const firstGptOf = (vid) => (availableModels.find(m => m.voiceId === vid && m.default) || availableModels.find(m => m.voiceId === vid) || {}).gptCheckpoint || ''
        const firstSovOf = (vid) => (availableModels.find(m => m.voiceId === vid && m.default) || availableModels.find(m => m.voiceId === vid) || {}).sovitsModel || ''
        const pickVoice = (vid) => {
          if (!vid) { onModelChange({ voiceId: '', gptCheckpoint: '', sovitsModel: '', gptVoiceId: '', sovitsVoiceId: '', mix }); return }
          // Prefer the voice's recommended default combo (Base model → s1 + v2Pro);
          // fine-tuned voices carry no default flag → fall back to the first combo.
          // Switching the primary voice resets any cross-asset overrides.
          const first = availableModels.find(m => m.voiceId === vid && m.default)
            || availableModels.find(m => m.voiceId === vid)
          onModelChange({ voiceId: vid, gptCheckpoint: first ? first.gptCheckpoint : '', sovitsModel: first ? first.sovitsModel : '', gptVoiceId: '', sovitsVoiceId: '', mix })
          // Base model has no slices of its own — jump straight to the cross-voice
          // reference picker so the user can borrow a reference immediately.
          if (vid === BASE_VOICE_ID && (row.refSource || 'slices') === 'slices') setRefSource('cross')
        }
        // Mix mode: pick a GPT checkpoint from ANY asset; derive its owning voice so
        // the mixed-stack marker + reference-following logic stay correct.
        const pickGptModel = (p) => {
          const owner = ownerOfGpt(p)
          onModelChange({ ...rowModel, gptCheckpoint: p, gptVoiceId: owner && owner !== rowModel.voiceId ? owner : '' })
        }
        // Mix mode: pick a SoVITS checkpoint from ANY asset. Reference + language
        // follow this (timbre) side (C3), so the picker below re-homes onto its owner.
        const pickSovModel = (p) => {
          const owner = ownerOfSov(p)
          onModelChange({ ...rowModel, sovitsModel: p, sovitsVoiceId: owner && owner !== rowModel.voiceId ? owner : '' })
          if (owner === BASE_VOICE_ID && (row.refSource || 'slices') === 'slices') setRefSource('cross')
        }
        const toggleMix = (on) => {
          if (on) { onModelChange({ ...rowModel, mix: true }); return }
          // Leaving mix mode collapses the stack back onto the primary Voice ID.
          onModelChange({ ...rowModel, mix: false, gptVoiceId: '', sovitsVoiceId: '', gptCheckpoint: firstGptOf(rowModel.voiceId), sovitsModel: firstSovOf(rowModel.voiceId) })
        }
        return (
          <div className="cmp-model-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '0 1 170px', minWidth: 130, marginBottom: 0 }}>
              <label className="field-label">Voice ID</label>
              <Select className="control" value={rowModel.voiceId || ''} onChange={e => pickVoice(e.target.value)}
                title={rowModel.voiceId || ''}>
                <option value="">— default —</option>
                {voiceOpts.map(v => <option key={v.voiceId} value={v.voiceId}>{v.voiceName}</option>)}
              </Select>
            </div>
            <div className="field" style={{ flex: '1 1 240px', minWidth: 180, marginBottom: 0 }}>
              <label className="field-label">GPT{rowModel.gptVoiceId && rowModel.gptVoiceId !== rowModel.voiceId ? ' *' : ''}</label>
              <Select className="control" value={rowModel.gptCheckpoint || ''} disabled={!mix && !rowModel.voiceId}
                title={rowModel.gptCheckpoint || ''}
                onChange={e => (mix ? pickGptModel(e.target.value) : onModelChange({ ...rowModel, gptCheckpoint: e.target.value }))}>
                {mix
                  ? gptGroupsC.map(g => (
                      <optgroup key={g.voiceId} label={g.voiceName}>
                        {g.items.map(c => <option key={c.path} value={c.path}>{c.name}{c.steps ? ` (${c.steps})` : ''}</option>)}
                      </optgroup>
                    ))
                  : (gptOpts.length === 0
                      ? <option value="">—</option>
                      : gptOpts.map(g => <option key={g.path} value={g.path}>{g.name}{g.steps ? ` (${g.steps})` : ''}</option>))}
              </Select>
            </div>
            <div className="field" style={{ flex: '1 1 240px', minWidth: 180, marginBottom: 0 }}>
              <label className="field-label">SoVITS{rowModel.sovitsVoiceId && rowModel.sovitsVoiceId !== rowModel.voiceId ? ' *' : ''}</label>
              <Select className="control" value={rowModel.sovitsModel || ''} disabled={!mix && !rowModel.voiceId}
                title={rowModel.sovitsModel || ''}
                onChange={e => (mix ? pickSovModel(e.target.value) : onModelChange({ ...rowModel, sovitsModel: e.target.value }))}>
                {mix
                  ? sovGroupsC.map(g => (
                      <optgroup key={g.voiceId} label={g.voiceName}>
                        {g.items.map(s => <option key={s.path} value={s.path}>{s.name}{s.version ? ` [${s.version}]` : ''}{s.steps ? ` (${s.steps})` : ''}</option>)}
                      </optgroup>
                    ))
                  : (sovOpts.length === 0
                      ? <option value="">—</option>
                      : sovOpts.map(s => <option key={s.path} value={s.path}>{s.name}{s.version ? ` [${s.version}]` : ''}{s.steps ? ` (${s.steps})` : ''}</option>))}
              </Select>
            </div>
            <label className="cmp-mix-toggle" style={{ flexBasis: '100%', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 0, cursor: 'pointer' }}
              title={t('Mix models across assets — pick the GPT and SoVITS models from any voice independently (e.g. A’s GPT + B’s SoVITS).',
                       '跨资产混搭模型：GPT 与 SoVITS 可分别从任意音色中独立选择（例如 A 的 GPT + B 的 SoVITS）。')}>
              <input type="checkbox" checked={mix} onChange={e => toggleMix(e.target.checked)} />
              <span>{t('Mix models across assets', '跨资产混搭模型')}</span>
            </label>
            {modelsMixed && (
              <div className="field-hint" style={{ flexBasis: '100%', color: 'var(--warning)', marginBottom: 0 }}>
                {t('Mixed stack across assets — reference audio & language follow the SoVITS (timbre) side.',
                   '跨资产混搭：参考音频与语言跟随 SoVITS（音色）侧。')}
              </div>
            )}
          </div>
        )
      })()}

      {/* Main reference audio — source selector: this voice / cross-voice / custom file */}
      <div className="field">
        <label className="field-label">Main Reference Audio</label>
        <Select
          className="control"
          value={refSource}
          onChange={e => {
            const v = e.target.value
            setRefSource(v)
            // Switching source clears the current pick to avoid a stale cross/custom path.
            onUpdate(row.id, 'refAudio', '')
            onUpdate(row.id, 'promptText', '')
            onUpdate(row.id, 'promptLang', '')
            if (v !== 'custom') onUpdate(row.id, 'customRef', null)
          }}
          style={{ marginBottom: 6 }}
        >
          <option value="slices">This voice's slices</option>
          <option value="cross">Another voice's reference</option>
          <option value="custom">Custom file…</option>
        </Select>
        {refSource === 'slices' && (
          <>
            {/* 6.1: the redundant slice dropdown was removed. The Audition list below is the sole
                reference picker (audition + click), expanded by default (D1). It also offers Raw audio.
                The 3–10s out-of-range hint now lives in the always-visible row header (covers every
                reference source); each audition item still carries its own inline flag. */}
            <div className="collapsible" style={{ marginTop: 6 }}>
              <div className="collapsible-hdr" onClick={() => setShowSlicePreview(v => !v)}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Audition reference &mdash; Slices / Raw (click one to set it as the main reference)</span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showSlicePreview ? '\u25b2' : '\u25bc'}</span>
              </div>
              {showSlicePreview && (
                <div className="collapsible-body">
                  <RefAudioList
                    voiceId={voiceId}
                    selectMode="single"
                    activeRef={row.refAudio}
                    onPick={(path, text) => { onUpdate(row.id, 'refAudio', path); onUpdate(row.id, 'promptText', text || '') }}
                  />
                </div>
              )}
            </div>
          </>
        )}
        {refSource === 'cross' && (
          <CrossRefPicker
            voices={voices}
            currentVoiceId={voiceId}
            activeRef={row.refAudio}
            onPick={(path, text) => { onUpdate(row.id, 'refAudio', path); onUpdate(row.id, 'promptText', text || '') }}
          />
        )}
        {refSource === 'custom' && (
          <CustomRefPicker
            custom={row.customRef || null}
            onPick={(path, text, plang, obj) => {
              if (obj) onUpdate(row.id, 'customRef', obj)
              onUpdate(row.id, 'refAudio', path)
              onUpdate(row.id, 'promptText', text || '')
              onUpdate(row.id, 'promptLang', plang || '')
            }}
            onClear={() => { onUpdate(row.id, 'customRef', null); onUpdate(row.id, 'refAudio', ''); onUpdate(row.id, 'promptText', ''); onUpdate(row.id, 'promptLang', '') }}
          />
        )}
      </div>

      {/* Aux reference audio — collapsible (PF-a); sources: this voice / another
          voice / custom upload (PF-c). Selected aux entries have no preview. */}
      <div className="field">
        <div className="collapsible-hdr" style={{ padding: 0 }} onClick={() => setShowAux(v => !v)}>
          <label className="field-label" style={{ margin: 0, cursor: 'pointer' }}>
            Auxiliary References
            <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>
              (optional{row.auxRefPaths.length > 0 ? ` · ${row.auxRefPaths.length} selected` : ''})
            </span>
          </label>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showAux ? '▲' : '▼'}</span>
        </div>
        {showAux && (
          <AuxReferencePicker
            voiceId={voiceId}
            voices={voices}
            value={row.auxRefPaths}
            mainRef={row.refAudio}
            onAdd={(path) => onAddAux(row.id, path)}
            onRemove={(idx) => onRemoveAux(row.id, idx)}
          />
        )}
      </div>

      {/* Per-row text override — collapsible (PF-a), empty by default. */}
      <div className="field">
        <div className="collapsible-hdr" style={{ padding: 0 }} onClick={() => setShowText(v => !v)}>
          <label className="field-label" style={{ margin: 0, cursor: 'pointer' }}>
            Text
            <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>
              {row.text && row.text.trim() ? '(custom)' : '(leave empty for default)'}
            </span>
          </label>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showText ? '▲' : '▼'}</span>
        </div>
        {showText && (
          <>
            <input
              className="control"
              style={{ marginTop: 4 }}
              value={row.text}
              onChange={e => onUpdate(row.id, 'text', e.target.value)}
              placeholder="Enter test text (empty = this voice's default)…"
            />
            {/* P1-1 / #4: per-row reading proofing + Han-character language — this row's
                overrides are isolated from other rows and pinned when saved as a recipe.
                Opens in the shared Text preparation modal. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={() => setShowRowTextPrep(true)}>
                Proof &amp; language{'\u2026'}
              </button>
              {rowHanDir && rowHanForced.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--accent)' }}>{rowHanForced.length} forced {LANG_LABEL[rowHanDir.reverse]}</span>
              )}
              {Object.keys(row.pronOverrides || {}).length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--accent)' }}>{Object.keys(row.pronOverrides).length} reading override(s)</span>
              )}
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>this row only</span>
            </div>
            {showRowTextPrep && (
              <TextPrepModal
                onClose={() => setShowRowTextPrep(false)}
                text={row.text} setText={v => onUpdate(row.id, 'text', v)} panelLang={rowPronLang}
                pronOverrides={row.pronOverrides || {}} setPronOverrides={o => onUpdate(row.id, 'pronOverrides', o)}
                hanDirection={rowHanDir} hanForced={rowHanForced} setHanForced={f => onUpdate(row.id, 'hanForced', f)}
                hanReadings={row.hanReadings || {}} setHanReadings={r => onUpdate(row.id, 'hanReadings', r)}
                engineId={engineId}
              />
            )}
          </>
        )}
      </div>

      {/* Advanced Settings */}
      <div className="collapsible" style={{ margin: '6px 0' }}>
        <div className="collapsible-hdr" onClick={() => setShowAdvanced(!showAdvanced)}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Advanced Settings</span>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showAdvanced ? '▲' : '▼'}</span>
        </div>
        {showAdvanced && (
          <div className="collapsible-body">
            <div className="form-grid">
              {/* 按 engine.param_schema 循环，跟 GenerateTab:1016 同一个
                  <ParamField>，不许再在这里分叉出 f.type === '...' 的分支。
                  GSV 的 common 层拿到的正是 temperature/top_k/top_p/
                  repetition_penalty/text_split_method/speed_factor 六项（Seed
                  见下面那段注释）。手写 <input> 的做法换一台引擎就会
                  让格子照常显示、填了发出去上游不认、不报错。

                  两档都画（跟着 TIERS），不是只画 common。两台
                  CosyVoice 的 common 层是空的 ⇒ 只画 common 时选它们
                  一个格子都没有，而界面上看不出任何异常。

                  options 故意不传：ParamField:197 只在 `select + source`
                  时才用它（候选项要扫盘），写死 choices 的格子自取
                  field.choices（ParamField:90）。这一页不扫权重/音色/音频，
                  那是 GenerateTab 的活，这里没有 assets 上下文。 */}
              {/* 档位按钮从 TIERS 来（GenerateTab:987 同一个形状），
                  写死两档就是第二份「有几档」的事实。 */}
              {tiersWithFields.length > 1 && (
                <div style={{ display: 'flex', gap: 6, gridColumn: '1 / -1' }}>
                  {tiersWithFields.map(tier => (
                    <button key={tier} type="button" className="btn btn-sm"
                      onClick={() => setAdvTier(tier)}
                      style={{ background: effTier === tier ? 'var(--accent)' : 'var(--surface)',
                               color: effTier === tier ? '#fff' : 'var(--muted)' }}>
                      {tier}
                    </button>
                  ))}
                </div>
              )}

              {visibleFields(effTier).map(f => (
                <ParamField key={f.name}
                  field={f}
                  values={paramValues}
                  onChange={setParam}
                  lang={voiceLang}
                  t={t} />
              ))}

              {/* Seed 不在 param_schema 里：它不是任何一台引擎的参数，
                  是平台自己的开关（GenerateTab:1030 同一条纪律）。
                  判据：换一台引擎，这一格的含义一个字都不变。 */}
              <div>
                <label className="field-label">Seed (-1 = random)</label>
                <input type="number" className="control" value={seed} onChange={e => setSeed(parseInt(e.target.value) || -1)} />
              </div>
              <div title={t('Engine batch for THIS row. Inherit = follow the master switch above. On = whole text in one parallel-batched engine call (single audio, no per-segment files). Off = keep the sequential per-segment path.', '本行的引擎批量。继承=跟随上方总开关；开=整段一次性并行批量合成（单个音频、无分段文件）；关=保持逐段串行。')}>
                <label className="field-label">{t('Engine Batch (parallel)', '引擎批量并行')}</label>
                <Select className="control" value={row.engine_batch || 'inherit'} onChange={e => onUpdate(row.id, 'engine_batch', e.target.value)}>
                  <option value="inherit">{t(`Inherit (${masterEngineBatch ? 'On' : 'Off'})`, `继承（${masterEngineBatch ? '开' : '关'}）`)}</option>
                  <option value="on">{t('On', '开')}</option>
                  <option value="off">{t('Off', '关')}</option>
                </Select>
              </div>
              {/* 这一行走哪个推理方法（点 1 把 call.methods
                  交到了前端）。比如 CosyVoice2 的 zero_shot / instruct2 / vc，
                  同一段文本在同一个音色上走不同入口。

                  只有一个方法（engine.methods 为 null）⇒ 不画这个下拉：
                  没有第二个选项的下拉只是噪声。判据跟 schemaGap 一样，
                  名片没说的东西，界面不许替它编一个。 */}
              {Array.isArray(engine?.methods) && engine.methods.length > 0 && (
                <div title={t('Which inference entrypoint THIS row uses. Only engines whose manifest declares call.methods offer more than one.', '此行使用哪个推理入口。仅当引擎的清单声明了 call.methods 时才提供多个选项。')}>
                  <label className="field-label">{t('Method', '推理方法')}</label>
                  <Select className="control" value={row.method || engine.default_method || engine.methods[0]} onChange={e => onUpdate(row.id, 'method', e.target.value)}>
                    {engine.methods.map(m => <option key={m} value={m}>{m}</option>)}
                  </Select>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      </>)}

      {/* File picker dropdown */}
      {showPicker && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-soft)',
          maxHeight: 240, overflow: 'auto', marginBottom: 4,
        }}>
          <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)' }}>
            Select {pickerTarget === 'main' ? 'main reference' : 'auxiliary'} audio ({allFiles.length} files)
          </div>
          {allFiles.map(f => (
            <div
              key={f.path}
              onClick={() => pickFile(f.path)}
              style={{
                padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderBottom: '1px solid var(--border)',
              }}
              onMouseEnter={e => e.target.style.background = 'var(--accent-soft)'}
              onMouseLeave={e => e.target.style.background = 'transparent'}
            >
              <span>{f.name}</span>
              <span style={{ color: 'var(--muted)', fontSize: 11 }}>{f.duration.toFixed(1)}s</span>
            </div>
          ))}
        </div>
      )}

      {/* Result — 6.5: output management buttons (parity with the Generate page).
          /api/generate returns a real outputs/generate/<id>/, so reveal / delete can be reused.
          Rerun = regenerate with this row's current settings (same as the header's Regenerate). */}
      {row.result && row.result.audio_url && (
        <div className="cmp-result">
          <div className="cmp-result-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Result{refVoiceName ? ` · 🎭 ${refVoiceName}` : ''}</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {row.result.id && (
                <button className="icon-btn" title="Show in file explorer"
                  onClick={async () => { const r = await api('/api/outputs/reveal', { method: 'POST', body: { id: row.result.id, source: 'comparerefs' } }); if (!r.ok) onUpdate(row.id, 'error', (r.data && r.data.error) || 'Could not open the file location') }}>
                  <IconFolder size={15} /></button>
              )}
              <button className="icon-btn" title="Rerun with this row's current settings"
                disabled={row.loading} onClick={() => onGenerate(row)}>
                <IconRerun size={15} /></button>
              {row.result.id && (
                cmpDelConfirm
                  ? (
                    <>
                      <button className="icon-btn icon-btn-danger" title="Confirm delete"
                        onClick={async () => { const r = await api(`/api/outputs/${encodeURIComponent(row.result.id)}?source=comparerefs`, { method: 'DELETE' }); setCmpDelConfirm(false); if (!r.ok) { onUpdate(row.id, 'error', (r.data && r.data.error) || 'Failed to delete audio'); return } onUpdate(row.id, 'result', null) }}>✓</button>
                      <button className="icon-btn" title="Cancel" onClick={() => setCmpDelConfirm(false)}>✕</button>
                    </>
                  )
                  : (
                    <button className="icon-btn icon-btn-danger" title="Delete this audio from disk"
                      onClick={() => setCmpDelConfirm(true)}><IconTrash size={15} /></button>
                  )
              )}
            </div>
          </div>
          <Player src={`${API_BASE}${row.result.audio_url}`} size="sm" bounds={row.result.segment_bounds} duration={row.result.duration} />
          <div className="cmp-result-meta">
            <a href={`${API_BASE}${row.result.audio_url}`} download style={{ color: 'var(--accent)', fontSize: 12 }}>Download</a>
            {row.result.segments && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{row.result.segments.length} segments</span>}
          </div>
        </div>
      )}

      {row.error && (
        <div className="msg msg-error" style={{ marginTop: 6 }}>{row.error}</div>
      )}
    </div>
  )
}

export { CompareRow }
