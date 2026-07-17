// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef } from 'react'
import { usePersistentState } from '../../usePersistentState'
import { API_BASE, api } from '../../lib/api'
import { LANG_LABEL, TextPrepModal, buildLangOverrides, buildPronPayload, hanOverrideDirection } from '../pron/PronProofing'
import { SaveRecipeModal } from '../common/Dialogs'
import { IconFolder, IconRerun, IconTrash } from '../common/Icons'
import { AudioPlayer, Player } from '../common/Player'
import { AuxReferencePicker, CrossRefPicker, CustomRefPicker, RefAudioList } from '../common/RefPickers'
import { REF_MAX_SEC, REF_MIN_SEC, TARGET_LANG_OPTIONS, basename, fmtRecentTime, normalizeLangFamily, refInRange, sameRefPath } from '../../lib/format'

// Compare Refs target-language options: the plain per-segment "auto" is dropped
// here (this page is decoupled from the Generate voice — no per-voice auto-detect),
// but the multilingual "auto_zh_ja" is kept for zh+ja shared-Han comparison.
const CMP_LANG_OPTIONS = TARGET_LANG_OPTIONS.filter(o => o.value !== 'auto')

// Reserved id of the built-in Base model (zero-shot pretrained-weights voice).
const BASE_VOICE_ID = '__base__'

// RefAudioTabs was hoisted to common/RefPickers.jsx as the shared RefAudioList
// (Patch #11). Compare's main reference now uses RefAudioList(single); auxiliary
// references use the shared AuxReferencePicker.

// ===========================
//  REFERENCE COMPARE TAB
// ===========================
function ReferenceCompareTab({ voices, selectedVoice, onActivity }) {
  // Persisted: a Compare Refs workspace must survive reloads / app restarts.
  // Generated audio is referenced by a server URL (result.audio_url) — not a blob —
  // so persisting results keeps the players working after a reload as long as the
  // backend keeps the output file. Transient flags are reset on rehydrate, and the
  // list is capped to avoid blowing the localStorage quota.
  const [rows, setRows] = usePersistentState('compare.rows', [], {
    // Legacy per-row target 'auto' (option removed) falls back to "use default".
    rehydrate: r => Array.isArray(r)
      ? r.map(x => ({ ...x, loading: false, error: null, textLang: x.textLang === 'auto' ? '' : x.textLang })).slice(0, 24)
      : [],
  })  // [{ id, refAudio, auxRefPaths, text, ...params, loading, result, error }]
  const [allAudioFiles, setAllAudioFiles] = useState([])
  const [voiceFiles, setVoiceFiles] = useState([])
  // PF-a: Compare's shared default text starts empty. An empty per-row Text means
  // "use this voice's own default text" on the backend, so the comparison isolates
  // the reference audio unless the user deliberately types a script.
  const [defaultText, setDefaultText] = usePersistentState('compare.defaultText', '')
  // Extra patch: the shared comparison text also supports reading proofing, applied to every row that doesn't override its own text.
  // #4: shared comparison-text reading proofing overrides (base bucket). Applied via
  // the Proof & language modal; no separate enable flag (removed with v5 cleanup).
  const [defaultPronOverrides, setDefaultPronOverrides] = usePersistentState('compare.defaultPronOverrides', {})
  // #4: per-character Han-character language overrides + reverse-language readings for
  // the shared comparison text (mirrors the Generate tab). Applied to every row that
  // doesn't override its own text.
  const [defaultHanForced, setDefaultHanForced] = usePersistentState('compare.defaultHanForced', [])
  const [defaultHanReadings, setDefaultHanReadings] = usePersistentState('compare.defaultHanReadings', {})
  const [showDefaultTextPrep, setShowDefaultTextPrep] = useState(false)
  const [availableModels, setAvailableModels] = useState([])  // [{ voiceId, voiceName, gptCheckpoint, sovitsModel, label }]
  const [rowModels, setRowModels] = usePersistentState('compare.rowModels', {})  // { rowId: { voiceId, gptCheckpoint, sovitsModel } }
  const [defaultParams, setDefaultParams] = useState(null)  // loaded from /api/advanced-params
  const [segmentsCache, setSegmentsCache] = useState({})  // { voiceId: segments[] }
  // Batch history — server-authoritative record of every "Generate All" run,
  // reconstructed from member meta.json (GET /api/outputs/batches). Shows how many
  // audios each comparison produced and which reference each member used.
  const [batches, setBatches] = useState([])
  const loadBatches = async () => {
    const r = await api('/api/outputs/batches?source=comparerefs')
    if (r.ok && r.data && Array.isArray(r.data.batches)) setBatches(r.data.batches)
  }
  useEffect(() => { loadBatches() }, [])
  // Clear the status-bar activity indicator when leaving the Compare tab.
  useEffect(() => () => onActivity?.(null), [])

  const selected = voices.find(v => v.id === selectedVoice)
  // Seed the row-id counter past any persisted rows so reloaded rows never collide.
  const nextId = useRef(rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1)

  // P1: Save-as-recipe from a compare row. Builds the recipe defaults from the
  // row's reference + params + its per-row model pick.
  const [saveRecipeDefaults, setSaveRecipeDefaults] = useState(null)
  const openSaveRecipe = (row) => {
    const rm = rowModels[row.id] || {}
    const dp = defaultParams || {}
    // Row's own model language (decoupled from the shared selectedVoice).
    const rmVoiceId = rm.voiceId || selectedVoice
    const rmVoiceLang = availableModels.find(m => m.voiceId === rmVoiceId)?.language
      || voices.find(v => (v.id || v.voiceId) === rmVoiceId)?.language || 'ja'
    // #4: pin this row's reading proofing exactly like the Generate recipe schema —
    // flat base overrides + lang_overrides + han_readings (server.js merges them).
    const rEff = row.textLang || defaultTextLang || rmVoiceLang || 'ja'
    const rDir = hanOverrideDirection(rEff, rmVoiceLang)
    const rLangOverrides = buildLangOverrides(rDir, row.hanForced || [])
    setSaveRecipeDefaults({
      reference_audio: row.refAudio || '',
      reference_text: row.promptText || '',
      language: row.textLang || defaultTextLang || rmVoiceLang || 'ja',
      params: {
        top_k: row.top_k, top_p: row.top_p, temperature: row.temperature, speed: row.speed_factor,
        // PA: pin the full contract. Fields Compare does not expose per-row
        // (advanced group) fall back to the shared defaults so the recipe still
        // reproduces the audition.
        text_split_method: row.text_split_method,
        repetition_penalty: row.repetition_penalty,
        seed: row.seed,
        sample_steps: dp.sample_steps,
        if_sr: dp.if_sr,
        batch_size: dp.batch_size,
        batch_threshold: dp.batch_threshold,
        split_bucket: dp.split_bucket,
        fragment_interval: dp.fragment_interval,
        parallel_infer: dp.parallel_infer,
        aux_ref_audio_paths: (row.auxRefPaths && row.auxRefPaths.length > 0) ? row.auxRefPaths : [],
        // P1-1 / #4: pin this row's own reading overrides (not a shared, cross-row set).
        pron_overrides: (row.pronOverrides && Object.keys(row.pronOverrides).length > 0) ? row.pronOverrides : {},
        lang_overrides: rLangOverrides || {},
        han_readings: (rDir && row.hanReadings && Object.keys(row.hanReadings).length > 0)
          ? Object.fromEntries(Object.entries(row.hanReadings).filter(([ch]) => (row.hanForced || []).includes(ch)))
          : {},
      },
      gpt_ckpt: rm.gptCheckpoint || '',
      sovits_pth: rm.sovitsModel || '',
    })
  }

  // Shared default target language (text_lang) + reading proofing for empty/uncustomized
  // rows — mirrors the Generate tab. Each row may still override its own target language.
  // Decoupled from the Generate voice: the comparison text's target language is a
  // free choice (default = multilingual auto), NOT auto-derived from the selected
  // voice, and it never auto-switches when the voice changes. Legacy persisted
  // 'auto' (removed here) migrates to the multilingual 'auto_zh_ja'.
  const [defaultTextLang, setDefaultTextLang] = usePersistentState('compare.defaultTextLang', 'auto_zh_ja', {
    rehydrate: v => (v === 'auto' || !v) ? 'auto_zh_ja' : v,
  })
  const voiceLang = selected?.language || 'ja'
  const _cmpBaseFam = String(voiceLang || '').replace(/^all_/, '')
  const _cmpTargetFam = normalizeLangFamily(defaultTextLang)
  // #4: shared comparison-text reading proofing + Han-character language payloads.
  const defaultPanelLang = _cmpTargetFam || _cmpBaseFam || 'ja'
  const defaultHanDir = hanOverrideDirection(defaultTextLang, voiceLang)
  const defaultLangOverrides = buildLangOverrides(defaultHanDir, defaultHanForced)
  const defaultPronPayload = buildPronPayload(defaultPronOverrides, defaultPanelLang, defaultHanDir, defaultHanForced, defaultHanReadings)

  // Load default advanced params from backend
  useEffect(() => {
    api('/api/advanced-params').then(r => {
      if (r.ok && r.data) setDefaultParams(r.data)
    }).catch(() => {})
  }, [])

  // Preload segments for selected voice
  useEffect(() => {
    if (!selectedVoice || segmentsCache[selectedVoice]) return
    api(`/api/assets/${selectedVoice}/segments`).then(r => {
      if (r.ok && r.data.segments) {
        setSegmentsCache(prev => ({ ...prev, [selectedVoice]: r.data.segments.segments || [] }))
      }
    }).catch(() => {})
  }, [selectedVoice])

  useEffect(() => {
    api('/api/audio-files?dir=no_slice').then(r => { if (r.ok) setAllAudioFiles(r.data.files) })
    api('/api/audio-files?dir=voices').then(r => { if (r.ok) setVoiceFiles(r.data.files) })
    // Load models from assets/ meta.json (source of truth) instead of voices.json.
    // Also pull the built-in Base model (GET /api/assets/__base__) so its pretrained
    // weights are selectable here for zero-shot reference comparison — it isn't in the
    // /api/assets roster (no folder on disk), so it must be fetched explicitly.
    const buildModels = (vid, meta, out) => {
      const ckpts = meta?.assets?.checkpoints || {}
      const gptList = ckpts.gpt || []
      const sovitsList = ckpts.sovits || []
      if (gptList.length === 0 || sovitsList.length === 0) return
      gptList.forEach(gpt => {
        sovitsList.forEach(sovits => {
          out.push({
            voiceId: vid,
            voiceName: meta.display_name || vid,
            language: meta.language || '',
            gptCheckpoint: gpt.path,
            sovitsModel: sovits.path,
            gptName: gpt.name || gpt.path,
            sovitsName: sovits.name || sovits.path,
            gptSteps: gpt.steps || '',
            sovitsSteps: sovits.steps || '',
            sovitsVersion: sovits.version || '',
            // Mark the recommended default combo (Base model → s1 + v2Pro) so the
            // Voice-ID switch pre-selects it. Fine-tuned voices carry no flag → falsy.
            default: !!(gpt.default && sovits.default),
            builtin: !!meta.builtin,
            label: `${meta.display_name || vid} / ${gpt.name}${gpt.steps ? ` (${gpt.steps})` : ''} / ${sovits.name}${sovits.version ? ` [${sovits.version}]` : ''}${sovits.steps ? ` (${sovits.steps})` : ''}`,
          })
        })
      })
    }
    Promise.all([
      api('/api/assets').catch(() => ({ ok: false })),
      api('/api/assets/__base__').catch(() => ({ ok: false })),
    ]).then(([r, rb]) => {
      const models = []
      // Base model first so it sits at the top of the Voice-ID dropdown.
      if (rb.ok && rb.data && rb.data.ok && rb.data.meta) buildModels(BASE_VOICE_ID, rb.data.meta, models)
      if (r.ok) Object.entries(r.data.assets || {}).forEach(([vid, meta]) => buildModels(vid, meta, models))
      setAvailableModels(models)
    }).catch(() => {})
  }, [])

  const addRow = (opts = {}) => {
    const rowId = nextId.current++
    // Default model: first available model for the selected voice, or first overall
    const defaultModel = availableModels.find(m => m.voiceId === selectedVoice && m.default)
      || availableModels.find(m => m.voiceId === selectedVoice) || availableModels[0]
    const modelForRow = defaultModel ? { voiceId: defaultModel.voiceId, gptCheckpoint: defaultModel.gptCheckpoint, sovitsModel: defaultModel.sovitsModel } : { voiceId: '', gptCheckpoint: '', sovitsModel: '' }
    setRowModels(prev => ({ ...prev, [rowId]: modelForRow }))
    // Use first matched segment from selected voice as default ref (unless an empty row was requested)
    const firstSeg = segmentsCache[selectedVoice]?.find(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
    const defaultRef = (!opts.empty && firstSeg) ? (() => {
      const raw = firstSeg.audio || firstSeg.audio_path || firstSeg.audio_filename
      const fn = raw ? raw.replace(/\\/g, '/').split('/').pop() : ''
      return fn ? `assets/${selectedVoice}/slicer_opt/${fn}` : ''
    })() : ''
    // The built-in Base model has no slices of its own — start such a row on the
    // cross-voice reference picker so the user can immediately borrow a reference.
    const startSource = (defaultModel && defaultModel.voiceId === BASE_VOICE_ID) ? 'cross' : undefined
    const dp = defaultParams || {}
    setRows(prev => [...prev, {
      id: rowId,
      refAudio: defaultRef,
      ...(startSource ? { refSource: startSource } : {}),
      auxRefPaths: [],
      text: defaultText,
      temperature: dp.temperature ?? 1.0,
      top_k: dp.top_k ?? 15,
      top_p: dp.top_p ?? 1.0,
      repetition_penalty: dp.repetition_penalty ?? 1.35,
      text_split_method: dp.text_split_method ?? 'cut5',
      speed_factor: dp.speed_factor ?? 1.0,
      seed: dp.seed ?? -1,
      // P1-1 / #4: per-row reading proofing state (isolated from other rows).
      pronOverrides: {},
      hanForced: [],
      hanReadings: {},
      loading: false,
      result: null,
      error: null,
    }])
  }

  const removeRow = (id) => {
    setRows(prev => prev.filter(r => r.id !== id))
  }

  const updateRow = (id, key, val) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, [key]: val } : r))
  }

  const addAuxToRow = (id, filePath) => {
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r
      if (r.auxRefPaths.includes(filePath)) return r
      return { ...r, auxRefPaths: [...r.auxRefPaths, filePath] }
    }))
  }

  const removeAuxFromRow = (id, idx) => {
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r
      const aux = [...r.auxRefPaths]
      aux.splice(idx, 1)
      return { ...r, auxRefPaths: aux }
    }))
  }

  const generateRow = async (row, batch) => {
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, loading: true, result: null, error: null } : r))
    // Live status-bar activity (ContextRow). A batch run drives its own progress
    // label ("Comparing · k/N") from generateAll; a lone Regenerate/Rerun shows a
    // plain "Generating" (parity with the Generate page) and clears when it ends.
    if (!batch) onActivity?.({ label: 'Generating' })
    const rowModel = rowModels[row.id] || {}
    // Decoupled from the Generate page's shared selectedVoice: this row's voice,
    // reference and every language default derive from THIS row's own model. Using
    // the shared voice here was the root of the "Chinese model auto-routes to
    // Chinese" bug (a JA reference was sent with prompt_lang=zh, mis-tokenising the
    // prompt and producing garbled / truncated audio).
    const rowVoiceId = rowModel.voiceId || selectedVoice
    const rowVoiceLang = availableModels.find(m => m.voiceId === rowVoiceId)?.language
      || voices.find(v => (v.id || v.voiceId) === rowVoiceId)?.language || 'ja'
    try {
      const body = {
        voice: rowVoiceId,
        text: row.text.trim() || defaultText,
        format: 'wav',
        source: 'comparerefs',
        split: true,
        concat: true,
        ref_audio: row.refAudio || undefined,
        aux_ref_audio_paths: row.auxRefPaths.length > 0 ? row.auxRefPaths : undefined,
        temperature: row.temperature,
        top_k: row.top_k,
        top_p: row.top_p,
        repetition_penalty: row.repetition_penalty,
        text_split_method: row.text_split_method,
        speed_factor: row.speed_factor,
        seed: row.seed,
      }
      // Batch tagging: when this row is part of a "Generate All", stamp the shared
      // batch id so the backend records all members as one comparison batch. A
      // lone per-row Generate carries no batch (it's a standalone run).
      if (batch && batch.id) {
        body.batch_id = batch.id
        body.batch_seq = batch.seq
        body.batch_total = batch.total
        body.batch_label = batch.label
      }
      if (rowModel.gptCheckpoint) body.gpt_model = rowModel.gptCheckpoint
      if (rowModel.sovitsModel) body.sovits_model = rowModel.sovitsModel
      // Per-row target text_lang (falls back to the shared default, then voice lang);
      // prompt_lang / reference transcript come from a cross/custom reference pick.
      body.text_lang = row.textLang || defaultTextLang || rowVoiceLang || 'ja'
      body.prompt_lang = row.promptLang || rowVoiceLang || 'ja'
      // Auto (Multilingual): kana-free CJK falls back to this row's model language.
      if (body.text_lang === 'auto_zh_ja') body.auto_base_lang = rowVoiceLang || 'zh'
      if (row.promptText) body.reference_text = row.promptText
      // P1-1 / #4: reading proofing is per-row — each row carries its own base
      // overrides + Han-character language forcing + reverse readings, so corrections
      // never leak between rows. A row that keeps the shared comparison text (empty
      // Text) and has no proofing of its own falls back to the shared comparison-text
      // overrides. Row-level always wins.
      const usingDefaultText = !(row.text && row.text.trim())
      const rEff = body.text_lang
      const rDir = hanOverrideDirection(rEff, rowVoiceLang)
      const rPanel = normalizeLangFamily(rEff) || String(rowVoiceLang || '').replace(/^all_/, '') || 'ja'
      const rLangOverrides = buildLangOverrides(rDir, row.hanForced || [])
      const rPronPayload = buildPronPayload(row.pronOverrides || {}, rPanel, rDir, row.hanForced || [], row.hanReadings || {})
      if (rPronPayload || rLangOverrides) {
        if (rPronPayload) body.pron_overrides = rPronPayload
        if (rLangOverrides) body.lang_overrides = rLangOverrides
      } else if (usingDefaultText) {
        if (defaultPronPayload) body.pron_overrides = defaultPronPayload
        if (defaultLangOverrides) body.lang_overrides = defaultLangOverrides
      }
      const r = await api('/api/generate', { method: 'POST', body })
      if (!r.ok) throw new Error(r.data.error || `Server error ${r.status}`)
      setRows(prev => prev.map(row2 => row2.id === row.id ? { ...row2, loading: false, result: r.data } : row2))
    } catch (err) {
      setRows(prev => prev.map(row2 => row2.id === row.id ? { ...row2, loading: false, error: err.message } : row2))
    } finally {
      // Batch runs are cleared by generateAll after the whole sequence.
      if (!batch) onActivity?.(null)
    }
  }

  const generateAll = async () => {
    // One "Generate All" = one recorded comparison batch. Mint a shared id up
    // front so every member lands under the same batch, then run rows in order.
    const runnable = rows.filter(r => !r.loading)
    if (runnable.length === 0) return
    const batchId = `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const label = (defaultText || '').trim().slice(0, 80)
    const batch = { id: batchId, total: runnable.length, label }
    let seq = 0
    try {
      for (const row of runnable) {
        // Progress in the status bar: "Comparing · k/N" advances as each member runs.
        onActivity?.({ label: `Comparing · ${seq + 1}/${runnable.length}` })
        await generateRow(row, { ...batch, seq })
        seq++
      }
    } finally {
      onActivity?.(null)
    }
    loadBatches()
  }

  return (
    <div>
      <div className="section" style={{ marginBottom: 12 }}>
        <div className="section-hdr">
          <span>Reference Audio Comparison</span>
        </div>
        <div className="section-body">
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
            Add as many rows as you like. Each row = a different reference audio configuration.
            Click <strong>Generate All</strong> to hear every combination side by side.
            The best one can be saved as the voice config.
          </p>

          <div className="field">
            {/* Extra patch: this is the "comparison text" — every row uses it by default so
                only the reference / model differs; a row can override it via its Text section. */}
            <label className="field-label">Comparison Text</label>
            <div className="field-hint" style={{ marginBottom: 4 }}>
              Every row uses this text by default, so you compare references / models on the same sentence. To give a row its own text, expand that row&apos;s <strong>Text</strong> section.
            </div>
            <textarea className="control" rows={3} value={defaultText} onChange={e => setDefaultText(e.target.value)}
              placeholder="Enter the text used across all rows for comparison…" />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                Default target language:
                <select
                  className="control" style={{ height: 22, fontSize: 11, padding: '0 4px', width: 'auto', minWidth: 0 }}
                  value={defaultTextLang} onChange={e => setDefaultTextLang(e.target.value)}
                >
                  {CMP_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </span>
            </div>
            {/* #4: reading proofing + per-character Han language for the comparison text —
                applied to every row that doesn't override its own text. A row's own
                proofing takes precedence. Opens in the shared Text preparation modal. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={() => setShowDefaultTextPrep(true)}>
                Proof &amp; language{'\u2026'}
              </button>
              {defaultHanDir && defaultHanForced.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--accent)' }}>{defaultHanForced.length} forced {LANG_LABEL[defaultHanDir.reverse]}</span>
              )}
              {Object.keys(defaultPronOverrides || {}).length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--accent)' }}>{Object.keys(defaultPronOverrides).length} reading override(s)</span>
              )}
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>applies to every row that doesn&apos;t override its own text</span>
            </div>
            {showDefaultTextPrep && (
              <TextPrepModal
                onClose={() => setShowDefaultTextPrep(false)}
                text={defaultText} setText={setDefaultText} panelLang={defaultPanelLang}
                pronOverrides={defaultPronOverrides || {}} setPronOverrides={setDefaultPronOverrides}
                hanDirection={defaultHanDir} hanForced={defaultHanForced} setHanForced={setDefaultHanForced}
                hanReadings={defaultHanReadings} setHanReadings={setDefaultHanReadings}
              />
            )}
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
              You can also proof a single row: expand that row&apos;s Text section and open its own <strong>Proof &amp; language</strong>.
            </div>
          </div>

          <div className="cmp-toolbar">
            <button className="btn btn-sm btn-primary" onClick={addRow}>+ Add Row</button>
            <button className="btn btn-sm" onClick={generateAll} disabled={rows.length === 0 || rows.some(r => r.loading)}>
              {rows.some(r => r.loading)
                ? `Generating… (${rows.filter(r => r.result && r.result.audio_url).length}/${rows.length})`
                : `Generate All (${rows.length})`}
            </button>
            {rows.length > 0 && (
              <span className="cmp-count">{rows.filter(r => r.result && r.result.audio_url).length}/{rows.length} ready</span>
            )}
          </div>
        </div>
      </div>

      {/* Rows */}
      {rows.map((row, rowIdx) => (
        <CompareRow
          key={row.id}
          row={row}
          index={rowIdx}
          allAudioFiles={allAudioFiles}
          voiceFiles={voiceFiles}
          onUpdate={updateRow}
          onAddAux={addAuxToRow}
          onRemoveAux={removeAuxFromRow}
          onGenerate={generateRow}
          onRemove={removeRow}
          onSaveRecipe={openSaveRecipe}
          availableModels={availableModels}
          rowModel={rowModels[row.id] || { voiceId: '', gptCheckpoint: '', sovitsModel: '' }}
          onModelChange={(model) => setRowModels(prev => ({ ...prev, [row.id]: model }))}
          defaultParams={defaultParams || {
            temperature: 1.0,
            top_k: 15,
            top_p: 1.0,
            repetition_penalty: 1.35,
            text_split_method: 'cut5',
            speed_factor: 1.0,
            seed: -1,
          }}
          selectedVoice={selectedVoice}
          voices={voices}
          voiceLang={voiceLang}
          defaultTextLang={defaultTextLang}
        />
      ))}

      {rows.length === 0 && (
        <div className="section">
          <div className="section-hdr"><span>Get Started</span></div>
          <div className="section-body">
            <div className="starter-grid">
              <div className="starter-card">
                <div className="sc-title">Use Current Reference</div>
                <div className="sc-desc">Create a row from <strong>{selected?.display_name || selectedVoice || 'the selected voice'}</strong>'s default reference audio.</div>
                <button className="btn btn-sm btn-primary" onClick={() => addRow()} disabled={!selectedVoice}>Use Current Reference</button>
              </div>
              <div className="starter-card">
                <div className="sc-title">Add Empty Row</div>
                <div className="sc-desc">Manually configure reference audio and prompt text from scratch.</div>
                <button className="btn btn-sm" onClick={() => addRow({ empty: true })}>Add Empty Row</button>
              </div>
              <div className="starter-card">
                <div className="sc-title">Load From Assets</div>
                <div className="sc-desc">Add a row, then pick existing slices / reference samples from voice assets in the row's picker.</div>
                <button className="btn btn-sm" onClick={() => addRow()} disabled={!selectedVoice}>Load From Assets</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Comparison results area (Part 5) */}
      {rows.length > 0 && !rows.some(r => r.result) && (
        <div className="empty-state" style={{ marginTop: 4, padding: 16 }}>
          <div className="es-sub" style={{ marginBottom: 0 }}>Generated comparison results will appear here.</div>
        </div>
      )}

      {/* Batch history — every "Generate All" recorded as one comparison batch. */}
      {batches.length > 0 && (
        <div className="section" style={{ marginTop: 16 }}>
          <div className="section-hdr">
            <span>Comparison Batches</span>
            <span className="cmp-count">{batches.length} recorded</span>
          </div>
          <div className="section-body">
            {batches.map(b => (
              <CompareBatchCard key={b.batch_id} batch={b}
                onDeleted={loadBatches} onReveal={async (id) => {
                  await api('/api/outputs/reveal', { method: 'POST', body: { id, source: 'comparerefs' } })
                }} />
            ))}
          </div>
        </div>
      )}

      <SaveRecipeModal
        open={!!saveRecipeDefaults}
        onClose={() => setSaveRecipeDefaults(null)}
        source="compare"
        role={selectedVoice}
        defaults={saveRecipeDefaults || {}}
        onSaved={() => setSaveRecipeDefaults(null)}
      />
    </div>
  )
}

// One recorded comparison batch (a single "Generate All"). Collapsible; shows
// each member's reference + seed + inline player, so you can tell exactly which
// audios were compared together and how many the batch produced.
function CompareBatchCard({ batch, onDeleted, onReveal }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const complete = batch.count >= (batch.total || batch.count)
  const deleteBatch = async () => {
    setBusy(true)
    for (const m of batch.members) {
      await api(`/api/outputs/${encodeURIComponent(m.id)}?source=comparerefs`, { method: 'DELETE' })
    }
    setBusy(false)
    onDeleted?.()
  }
  return (
    <div className="cmp-batch">
      <div className="cmp-batch-hdr" onClick={() => setOpen(o => !o)}>
        <span className="cmp-batch-caret">{open ? '▾' : '▸'}</span>
        <span className="cmp-batch-count">{batch.count}{batch.total && batch.total !== batch.count ? ` / ${batch.total}` : ''} audio{batch.count === 1 ? '' : 's'}</span>
        <span className="cmp-batch-label" title={batch.label}>{batch.label || '(voice default text)'}</span>
        {!complete && <span className="cmp-batch-partial" title="Some members were deleted or failed">partial</span>}
        <span className="cmp-batch-time">{fmtRecentTime(batch.createdAt)}</span>
        <button className="icon-btn icon-btn-danger" title="Delete every audio in this batch"
          onClick={(e) => { e.stopPropagation(); deleteBatch() }} disabled={busy}><IconTrash size={14} /></button>
      </div>
      {open && (
        <div className="cmp-batch-body">
          {batch.members.map((m, i) => (
            <div key={m.id} className="cmp-batch-member">
              <div className="cmp-batch-member-main">
                <span className="cmp-batch-idx">#{(m.batch_seq ?? i) + 1}</span>
                <span className="cmp-batch-ref" title={m.ref_audio || 'auto reference'}>{m.ref_audio ? basename(m.ref_audio) : 'auto ref'}</span>
                {(m.seed !== undefined && m.seed !== null && m.seed !== -1) && <span className="cmp-batch-seed">seed {m.seed}</span>}
                <button className="icon-btn" title="Show in file explorer"
                  onClick={() => onReveal?.(m.id)}><IconFolder size={13} /></button>
              </div>
              {m.audio_url && <div style={{ marginTop: 4 }}><Player src={`${API_BASE}${m.audio_url}`} size="sm" bounds={m.segment_bounds} duration={m.duration} /></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CompareRow({ row, index, allAudioFiles, voiceFiles, onUpdate, onAddAux, onRemoveAux, onGenerate, onRemove, onSaveRecipe, availableModels, rowModel, onModelChange, defaultParams, selectedVoice, voices, voiceLang, defaultTextLang }) {
  const [showPicker, setShowPicker] = useState(false)
  const [pickerTarget, setPickerTarget] = useState('main') // 'main' or 'aux'
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [segments, setSegments] = useState([])  // loaded from segments.json for current voice
  // PF-a: Auxiliary References and Text default to collapsed, auto-expanding only
  // when the row already carries a value so nothing is silently hidden.
  const [showAux, setShowAux] = useState(() => (row.auxRefPaths || []).length > 0)
  const [showText, setShowText] = useState(() => !!(row.text && row.text.trim()))
  // PF-b / D1: this voice's slices get an auditable list. After the redundant slice
  // <select> was removed (6.1), this audition list is the SOLE slice picker, so it
  // defaults to EXPANDED.
  const [showSlicePreview, setShowSlicePreview] = useState(true)
  // PF-c: auxiliary reference source/custom state now lives inside the shared
  // AuxReferencePicker (Patch #11), so CompareRow no longer tracks it locally.
  // 6.5: inline confirm for deleting a Compare result's audio from disk.
  const [cmpDelConfirm, setCmpDelConfirm] = useState(false)

  // Determine which voice this row uses
  const voiceId = rowModel.voiceId || selectedVoice
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

  // Advanced params (initialized from row or defaults)
  const [temperature, setTemperature] = useState(row.temperature ?? defaultParams?.temperature ?? 1.0)
  const [topK, setTopK] = useState(row.top_k ?? defaultParams?.top_k ?? 15)
  const [topP, setTopP] = useState(row.top_p ?? defaultParams?.top_p ?? 1.0)
  const [repPenalty, setRepPenalty] = useState(row.repetition_penalty ?? defaultParams?.repetition_penalty ?? 1.35)
  const [splitMethod, setSplitMethod] = useState(row.text_split_method ?? defaultParams?.text_split_method ?? 'cut5')
  const [speedFactor, setSpeedFactor] = useState(row.speed_factor ?? defaultParams?.speed_factor ?? 1.0)
  const [seed, setSeed] = useState(row.seed ?? defaultParams?.seed ?? -1)

  // Store advanced params back to row on change
  useEffect(() => { onUpdate(row.id, 'temperature', temperature) }, [temperature])
  useEffect(() => { onUpdate(row.id, 'top_k', topK) }, [topK])
  useEffect(() => { onUpdate(row.id, 'top_p', topP) }, [topP])
  useEffect(() => { onUpdate(row.id, 'repetition_penalty', repPenalty) }, [repPenalty])
  useEffect(() => { onUpdate(row.id, 'text_split_method', splitMethod) }, [splitMethod])
  useEffect(() => { onUpdate(row.id, 'speed_factor', speedFactor) }, [speedFactor])
  useEffect(() => { onUpdate(row.id, 'seed', seed) }, [seed])

  const allFiles = [...allAudioFiles, ...voiceFiles]

  // Derived row status + at-a-glance summary for the polished header (P2).
  // Pure-derived from existing row state — no new state, no logic change.
  const cmpStatus = row.loading ? 'running' : row.error ? 'error' : (row.result && row.result.audio_url) ? 'done' : 'idle'
  const cmpStatusLabel = cmpStatus === 'running' ? 'Generating…' : cmpStatus === 'done' ? 'Ready' : cmpStatus === 'error' ? 'Failed' : 'Not run'
  const cmpRefName = row.refAudio ? basename(row.refAudio) : null
  const cmpModelLabel = (availableModels.find(m => m.voiceId === rowModel.voiceId && m.gptCheckpoint === rowModel.gptCheckpoint && m.sovitsModel === rowModel.sovitsModel) || {}).label || null
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
        <select
          className="control"
          value={row.textLang || ''}
          onChange={e => onUpdate(row.id, 'textLang', e.target.value)}
        >
          <option value="">Use default ({defaultTextLang})</option>
          {CMP_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* 6.6/6.1: Model split into three cascading dropdowns [Voice ID][GPT][SoVITS]. Voice ID
          drives both the GPT/SoVITS candidate lists and the slice source below (natural linkage). */}
      {availableModels.length > 0 && (() => {
        const voiceOpts = []
        const seenV = new Set()
        availableModels.forEach(m => { if (!seenV.has(m.voiceId)) { seenV.add(m.voiceId); voiceOpts.push({ voiceId: m.voiceId, voiceName: m.voiceName }) } })
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
        const pickVoice = (vid) => {
          if (!vid) { onModelChange({ voiceId: '', gptCheckpoint: '', sovitsModel: '' }); return }
          // Prefer the voice's recommended default combo (Base model → s1 + v2Pro);
          // fine-tuned voices carry no default flag → fall back to the first combo.
          const first = availableModels.find(m => m.voiceId === vid && m.default)
            || availableModels.find(m => m.voiceId === vid)
          onModelChange({ voiceId: vid, gptCheckpoint: first ? first.gptCheckpoint : '', sovitsModel: first ? first.sovitsModel : '' })
          // Base model has no slices of its own — jump straight to the cross-voice
          // reference picker so the user can borrow a reference immediately.
          if (vid === BASE_VOICE_ID && (row.refSource || 'slices') === 'slices') setRefSource('cross')
        }
        return (
          <div className="cmp-model-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '0 1 170px', minWidth: 130, marginBottom: 0 }}>
              <label className="field-label">Voice ID</label>
              <select className="control" value={rowModel.voiceId || ''} onChange={e => pickVoice(e.target.value)}
                title={rowModel.voiceId || ''}>
                <option value="">— default —</option>
                {voiceOpts.map(v => <option key={v.voiceId} value={v.voiceId}>{v.voiceName}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '1 1 240px', minWidth: 180, marginBottom: 0 }}>
              <label className="field-label">GPT</label>
              <select className="control" value={rowModel.gptCheckpoint || ''} disabled={!rowModel.voiceId}
                title={rowModel.gptCheckpoint || ''}
                onChange={e => onModelChange({ voiceId: rowModel.voiceId, gptCheckpoint: e.target.value, sovitsModel: rowModel.sovitsModel })}>
                {gptOpts.length === 0 && <option value="">—</option>}
                {gptOpts.map(g => <option key={g.path} value={g.path}>{g.name}{g.steps ? ` (${g.steps})` : ''}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '1 1 240px', minWidth: 180, marginBottom: 0 }}>
              <label className="field-label">SoVITS</label>
              <select className="control" value={rowModel.sovitsModel || ''} disabled={!rowModel.voiceId}
                title={rowModel.sovitsModel || ''}
                onChange={e => onModelChange({ voiceId: rowModel.voiceId, gptCheckpoint: rowModel.gptCheckpoint, sovitsModel: e.target.value })}>
                {sovOpts.length === 0 && <option value="">—</option>}
                {sovOpts.map(s => <option key={s.path} value={s.path}>{s.name}{s.version ? ` [${s.version}]` : ''}{s.steps ? ` (${s.steps})` : ''}</option>)}
              </select>
            </div>
          </div>
        )
      })()}

      {/* Main reference audio — source selector: this voice / cross-voice / custom file */}
      <div className="field">
        <label className="field-label">Main Reference Audio</label>
        <select
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
        </select>
        {refSource === 'slices' && (
          <>
            {/* 6.1: the redundant slice dropdown was removed. The Audition list below is the sole
                reference picker (audition + click), expanded by default (D1). It also offers Raw audio.
                The 3–10s out-of-range hint now lives in the always-visible row header (covers every
                reference source); each audition item still carries its own inline ⚠ flag. */}
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
              <div>
                <label className="field-label">Temperature</label>
                <input type="number" className="control" step="0.05" min="0" max="2" value={temperature} onChange={e => setTemperature(parseFloat(e.target.value) || 1.0)} />
              </div>
              <div>
                <label className="field-label">Top K</label>
                <input type="number" className="control" step="1" min="1" max="100" value={topK} onChange={e => setTopK(parseInt(e.target.value) || 15)} />
              </div>
              <div>
                <label className="field-label">Top P</label>
                <input type="number" className="control" step="0.05" min="0" max="1" value={topP} onChange={e => setTopP(parseFloat(e.target.value) || 1.0)} />
              </div>
              <div>
                <label className="field-label">Repetition Penalty</label>
                <input type="number" className="control" step="0.05" min="0.5" max="2" value={repPenalty} onChange={e => setRepPenalty(parseFloat(e.target.value) || 1.35)} />
              </div>
              <div>
                <label className="field-label">Split Method</label>
                <select className="control" value={splitMethod} onChange={e => setSplitMethod(e.target.value)}>
                  <option value="cut0">cut0 (no split)</option>
                  <option value="cut1">cut1 (punctuation)</option>
                  <option value="cut2">cut2 (sentence)</option>
                  <option value="cut3">cut3 (paragraph)</option>
                  <option value="cut4">cut4 (length)</option>
                  <option value="cut5">cut5 (default)</option>
                </select>
              </div>
              <div>
                <label className="field-label">Speed Factor</label>
                <input type="number" className="control" step="0.1" min="0.5" max="2" value={speedFactor} onChange={e => setSpeedFactor(parseFloat(e.target.value) || 1.0)} />
              </div>
              <div>
                <label className="field-label">Seed (-1 = random)</label>
                <input type="number" className="control" value={seed} onChange={e => setSeed(parseInt(e.target.value) || -1)} />
              </div>
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

export {
  ReferenceCompareTab,
}
