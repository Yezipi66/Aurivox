// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef, useMemo } from 'react'
import { Select } from '../common/Select'
import { usePersistentState } from '../../usePersistentState'
import { API_BASE, api } from '../../lib/api'
import { LANG_LABEL, TextPrepModal, buildLangOverrides, buildPronPayload, hanOverrideDirection, countOverrides } from '../pron/PronProofing'
import { ConfirmDialog, SaveRecipeModal } from '../common/Dialogs'
import { IconFolder, IconPlay, IconRerun, IconTrash } from '../common/Icons'
import { AudioPlayer, Player } from '../common/Player'
import { AuxReferencePicker, CrossRefPicker, CustomRefPicker, refMatches } from '../common/RefPickers'
import { assetIdFromCkptPath, useAssetsWithModels, gptGroups, sovitsGroups } from '../../lib/models'
import { REF_MAX_SEC, REF_MIN_SEC, TARGET_LANG_OPTIONS, basename, defaultTargetLang, fmtRecentTime, normalizeLangFamily, outputsError, pickDefaultRef, refBasename, refInRange, sameRefPath, statusBadge } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { recipeToGenerateParams } from '../../lib/recipes'

// Voice dropdown label. Builtin voices show only their display name. For a
// fine-tuned voice we append the id ONLY when it differs from the display name —
// otherwise the option reads redundantly as "Akafuyu (Akafuyu) [zh]" (item 14).
function voiceOptionLabel(v) {
  if (!v) return ''
  if (v.builtin) return v.display_name
  const name = v.display_name || v.id
  const idPart = (v.id && v.id !== name) ? ` (${v.id})` : ''
  const langPart = v.language ? ` [${v.language}]` : ''
  return `${name}${idPart}${langPart}`
}

// Cross-asset model source picker (issue #3). A compact secondary dropdown under a
// GPT / SoVITS selector that lets the checkpoint be sourced from ANY asset that has
// that model kind, enabling mixes like "A's GPT + B's SoVITS". '' = this voice.
// Reproducibility: a small inline badge that displays the RESOLVED seed (the
// concrete value the engine actually used, never -1) with one-click copy.
// Renders nothing for a missing/random seed.
function SeedBadge({ seed }) {
  const [copied, setCopied] = useState(false)
  if (seed === undefined || seed === null || seed === -1) return null
  const copy = () => {
    try {
      navigator.clipboard?.writeText(String(seed))
      setCopied(true); setTimeout(() => setCopied(false), 1200)
    } catch { /* ignore */ }
  }
  return (
    <span className="seed-badge" title="Resolved seed used for this generation — click to copy">
      <span className="seed-badge-label">seed</span>
      <button type="button" className="seed-badge-val" onClick={copy}
        title="Click to copy this seed">{seed}{copied ? ' ✓' : ''}</button>
    </span>
  )
}

// Compact inline seed for dense meta lines: bold, hover-highlighted, click-to-copy.
function SeedInline({ seed }) {
  const [copied, setCopied] = useState(false)
  if (seed === undefined || seed === null || seed === -1) return null
  const copy = (e) => {
    e.stopPropagation()
    try {
      navigator.clipboard?.writeText(String(seed))
      setCopied(true); setTimeout(() => setCopied(false), 1200)
    } catch { /* ignore */ }
  }
  return (
    <button type="button" className="seed-inline" onClick={copy}
      title="Resolved seed for this generation — click to copy">
      seed <strong>{seed}</strong>{copied ? ' ✓' : ''}
    </button>
  )
}

function GenerateTab({ voices, selectedVoice, setSelectedVoice, onEditVoice, onSwitchToCompare, onVoiceUpdate, selectedRefAudio, selectedRefText, selectedPromptLang, onSelectRef, onActivity }) {
  const { t } = useT()
  const [text, setText] = usePersistentState('generate.text', '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  // result + recent are persisted: audio is referenced by a server URL (audio_url),
  // not a blob, so the players keep working after a reload.
  const [result, setResult] = usePersistentState('generate.result', null)
  const [validation, setValidation] = useState(null)
  // Recent Generations — server-authoritative (GET /api/outputs). Each entry is
  // a real asset folder (outputs/generate/<id>/ with meta.json), so Rerun / Show
  // in Explorer / Delete all act on the backend by id. "Clear History" only hides
  // entries locally (dismissed ids); the audio files stay on disk.
  const [recentAll, setRecentAll] = useState([])
  const [dismissed, setDismissed] = usePersistentState('generate.dismissed', [], {
    rehydrate: r => (Array.isArray(r) ? r : []),
  })
  const recent = recentAll.filter(x => !dismissed.includes(x.id))
  const [genConfirm, setGenConfirm] = useState(null)      // secondary-confirm modal payload
  const [genConfirmBusy, setGenConfirmBusy] = useState(false)
  const [showSaveRecipe, setShowSaveRecipe] = useState(false)  // P1: Save as recipe modal
  const [recipes, setRecipes] = useState([])
  const [loadRecipeId, setLoadRecipeId] = useState('')

  const [splitEnabled, setSplitEnabled] = usePersistentState('generate.splitEnabled', true)
  const [maxChars, setMaxChars] = usePersistentState('generate.maxChars', 30)
  const [concatEnabled, setConcatEnabled] = usePersistentState('generate.concatEnabled', true)
  const [silenceMs, setSilenceMs] = usePersistentState('generate.silenceMs', 300)

  // 读音校对（task6）：本次覆盖仅内存态。#4 起改用 Proof & language 弹窗，无需
  // 单独的启用开关（弹窗内无条件渲染校对面板，overrides 直接进 payload）。
  const [pronOverrides, setPronOverrides] = useState({})
  // #4: per-character Han-character language overrides (list of chars forced to the
  // reverse language). Persisted; converted to {char->lang} at request build time.
  const [hanForced, setHanForced] = usePersistentState('generate.hanForced', [])
  // #4: reverse-language readings (kana / pinyin) for the forced characters, keyed
  // by character. Merged into pron_overrides at request build time.
  const [hanReadings, setHanReadings] = usePersistentState('generate.hanReadings', {})
  const [showTextPrep, setShowTextPrep] = useState(false)

  const selected = voices.find(v => v.id === selectedVoice)

  // Advanced settings — loaded from /api/advanced-params (global, not per-voice)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [temperature, setTemperature] = useState(1.0)
  const [topK, setTopK] = useState(15)
  const [topP, setTopP] = useState(1.0)
  const [repPenalty, setRepPenalty] = useState(1.35)
  const [splitMethod, setSplitMethod] = useState('cut5')
  const [speedFactor, setSpeedFactor] = useState(1.0)
  const [seed, setSeed] = useState(-1)

  // Advanced TTS inference params (used by advanced settings panel + /tts payload)
  const [advTier, setAdvTier] = useState('common')
  const [batchSize, setBatchSize] = useState(1)
  const [batchThreshold, setBatchThreshold] = useState(0.75)
  const [splitBucket, setSplitBucket] = useState(true)
  const [fragmentInterval, setFragmentInterval] = useState(0.3)
  const [parallelInfer, setParallelInfer] = useState(true)
  const [sampleSteps, setSampleSteps] = useState(32)
  const [superSampling, setSuperSampling] = useState(false)
  const [mediaType, setMediaType] = usePersistentState('generate.mediaType', 'wav')
  const [streamingMode, setStreamingMode] = useState(false)
  const [overlapLength, setOverlapLength] = useState(2)
  const [minChunkLength, setMinChunkLength] = useState(16)
  // A-1 engine-batch mode (1.0.6): hand the whole text to the engine in one call
  // so it splits + batches in parallel (batch_size), instead of the broker
  // synthesising each split segment sequentially. Produces a single audio (no
  // per-segment files). Off by default to preserve the current segmented output.
  const [engineBatch, setEngineBatch] = useState(false)

  useEffect(() => { api('/api/recipes').then(r => { if (r.ok) setRecipes(r.data?.recipes || []) }).catch(() => {}) }, [])

  // Load advanced params from backend on mount
  useEffect(() => {
    api('/api/advanced-params').then(r => {
      if (r.ok && r.data) {
        const p = r.data
        if (p.temperature !== undefined) setTemperature(p.temperature)
        if (p.top_k !== undefined) setTopK(p.top_k)
        if (p.top_p !== undefined) setTopP(p.top_p)
        if (p.repetition_penalty !== undefined) setRepPenalty(p.repetition_penalty)
        if (p.text_split_method !== undefined) setSplitMethod(p.text_split_method)
        if (p.speed_factor !== undefined) setSpeedFactor(p.speed_factor)
        if (p.seed !== undefined) setSeed(p.seed)
      }
    }).catch(() => {})
  }, [])

  // Model selection
  const [checkpoints, setCheckpoints] = useState({ gpt: [], sovits: [] })
  const [selGpt, setSelGpt] = useState('')
  const [selSovits, setSelSovits] = useState('')
  // 持久化「模型选择」：每个音色各自记住上次选的 GPT / SoVITS checkpoint，
  // 刷新后恢复(仍存在于该音色列表时)，避免每次都被重置回默认档。
  const [modelChoice, setModelChoice] = usePersistentState('generate.modelChoice', {})
  const modelChoiceRef = useRef(modelChoice)
  modelChoiceRef.current = modelChoice

  // Cross-asset model mixing (issue #3): a single "Mix models across assets" toggle.
  // When ON, the GPT and SoVITS dropdowns list EVERY model of EVERY asset that owns
  // that kind (grouped by asset), so the user can freely pair A's GPT with B's SoVITS.
  // When OFF, each dropdown shows only the selected voice's own checkpoints.
  const assetsWithModels = useAssetsWithModels()
  const [mixMode, setMixMode] = usePersistentState('generate.mixMode', false)
  // Grouped option sources for the mix-mode dropdowns. Safety net: if the assets
  // list hasn't loaded yet (or the endpoint returned nothing) fall back to a single
  // group built from the selected voice's own checkpoints, so enabling mix mode can
  // never make the GPT/SoVITS dropdowns disappear.
  const gptGroupList = useMemo(() => {
    const g = gptGroups(assetsWithModels)
    if (g.length) return g
    return (checkpoints.gpt || []).length
      ? [{ voiceId: selectedVoice, displayName: (selected?.display_name || selectedVoice), items: checkpoints.gpt }]
      : []
  }, [assetsWithModels, checkpoints, selectedVoice, selected])
  const sovitsGroupList = useMemo(() => {
    const g = sovitsGroups(assetsWithModels)
    if (g.length) return g
    return (checkpoints.sovits || []).length
      ? [{ voiceId: selectedVoice, displayName: (selected?.display_name || selectedVoice), items: checkpoints.sovits }]
      : []
  }, [assetsWithModels, checkpoints, selectedVoice, selected])
  // Effective flat checkpoint lists (used for reconcile validity + selected-meta lookup).
  // In mix mode these are the union across all assets; otherwise the selected voice's own.
  const gptList = mixMode ? gptGroupList.flatMap(g => g.items) : (checkpoints.gpt || [])
  const sovitsList = mixMode ? sovitsGroupList.flatMap(g => g.items) : (checkpoints.sovits || [])
  // The owning asset of each selected checkpoint (derived from its path). In mix mode
  // this is how we know whether the stack is cross-asset and where the timbre comes from.
  const gptSrcVoice = mixMode ? assetIdFromCkptPath(selGpt) : ''
  const sovitsSrcVoice = mixMode ? assetIdFromCkptPath(selSovits) : ''
  // Is the current stack mixed across assets? (the two models come from different voices)
  const _gptOwner = gptSrcVoice || selectedVoice
  const _sovitsOwner = sovitsSrcVoice || selectedVoice
  const modelsMixed = mixMode && !!gptSrcVoice && !!sovitsSrcVoice && _gptOwner !== _sovitsOwner
  // Timbre follows the SoVITS side (C3): the reference browser + prompt_lang default
  // track the SoVITS model's owning asset when it differs from the primary voice.
  const refVoiceId = (sovitsSrcVoice && sovitsSrcVoice !== selectedVoice) ? sovitsSrcVoice : selectedVoice
  // Item 14: one-line summary of the active voice/model stack (mirrors the Compare
  // Refs row header) — "voice / gpt.ckpt (steps) / sovits.pth [version]".
  const _selGptC = gptList.find(c => c.path === selGpt)
  const _selSovitsC = sovitsList.find(c => c.path === selSovits)
  const modelSummary = selected ? [
    selected.display_name || selected.id,
    _selGptC ? `${_selGptC.name}${_selGptC.steps != null ? ` (${_selGptC.steps})` : ''}` : null,
    _selSovitsC ? `${_selSovitsC.name}${_selSovitsC.version ? ` [${_selSovitsC.version}]` : ''}` : null,
  ].filter(Boolean).join('  /  ') : ''
  const [lang, setLang] = useState(selected?.language || 'ja')
  // 目标合成语言（text_lang），独立于 prompt_lang；默认 = 微调源语言，切换音色时重置。
  const [textLang, setTextLang] = useState(() => defaultTargetLang(selected?.language || 'ja'))
  const _baseLangFam = String(lang || '').replace(/^all_/, '')
  const _targetFam = normalizeLangFamily(textLang)
  const langMismatch = !!_targetFam && _targetFam !== _baseLangFam   // 目标语言与微调语言不符
  const panelLang = _targetFam || _baseLangFam                        // 读音校对面板跟随目标语言
  const hanDir = hanOverrideDirection(textLang, lang)                 // #4: reverse-lang direction (or null)
  const langOverrides = buildLangOverrides(hanDir, hanForced)         // #4: {char->lang} payload
  const pronPayload = buildPronPayload(pronOverrides, panelLang, hanDir, hanForced, hanReadings) // #4: base + reverse readings
  const [auxRefs, setAuxRefs] = useState([])  // selected aux reference audio paths
  const [segments, setSegments] = useState([])  // loaded from API for aux ref picker

  // Load checkpoints + segments when voice changes. Also restore any persisted
  // cross-asset selection (issue #3) so a mixed A-GPT + B-SoVITS stack survives a
  // reload; if a saved checkpoint belongs to another asset, re-enable mix mode so
  // the grouped dropdowns keep that selection valid. selGpt/selSovits are reconciled
  // against the effective (union) lists by the effect below.
  useEffect(() => {
    if (!selectedVoice) return
    const saved = modelChoiceRef.current[selectedVoice] || {}
    const crossGpt = saved.gptVoice && saved.gptVoice !== selectedVoice
    const crossSovits = saved.sovitsVoice && saved.sovitsVoice !== selectedVoice
    if (crossGpt || crossSovits) setMixMode(true)
    // Seed selections from persistence (may point at cross-asset paths; validated later).
    if (saved.gpt) setSelGpt(saved.gpt)
    if (saved.sovits) setSelSovits(saved.sovits)
    api(`/api/assets/${selectedVoice}`).then(r => {
      if (r.ok && r.data.ok && r.data.meta?.assets?.checkpoints) {
        const c = r.data.meta.assets.checkpoints
        setCheckpoints({ gpt: c.gpt || [], sovits: c.sovits || [] })
      }
    }).catch(() => {})
  }, [selectedVoice])

  // Reference segments follow the timbre (SoVITS) voice (C3): when SoVITS is sourced
  // from another asset, the default/auxiliary reference clips come from THAT asset,
  // not the primary voice — otherwise a mixed stack would pair B's SoVITS with A's
  // reference audio (a timbre mismatch).
  useEffect(() => {
    if (!refVoiceId) { setSegments([]); return }
    api(`/api/assets/${refVoiceId}/segments`).then(r => {
      if (r.ok && r.data.segments) setSegments(r.data.segments.segments || [])
      else setSegments([])
    }).catch(() => setSegments([]))
  }, [refVoiceId])

  // Reconcile the GPT selection against the effective list (selected voice OR an
  // overridden cross-asset source). Keep a still-valid selection (so a restored
  // cross-asset path survives once its source finishes loading), else fall back to
  // the list's default / first. Guarded on a non-empty list so the async load gap
  // of an overridden source never clobbers a valid restored selection.
  useEffect(() => {
    if (!gptList.length) return
    setSelGpt(prev => gptList.some(x => x.path === prev) ? prev
      : ((gptList.find(x => x.default) || gptList[0])?.path || ''))
  }, [gptList])
  useEffect(() => {
    if (!sovitsList.length) return
    setSelSovits(prev => sovitsList.some(x => x.path === prev) ? prev
      : ((sovitsList.find(x => x.default) || sovitsList[0])?.path || ''))
  }, [sovitsList])

  // 记住当前音色的 checkpoint 选择 + 跨资产来源。仅在选择与其【有效来源】列表匹配时
  // 才写入，避免切换音色时把上一个音色的路径短暂落到新音色名下。
  useEffect(() => {
    if (!selectedVoice) return
    if (!selGpt) return
    const gptOk = gptList.some(x => x.path === selGpt)
    const sovitsOk = !selSovits || sovitsList.some(x => x.path === selSovits)
    if (!gptOk || !sovitsOk) return
    setModelChoice(prev => {
      const cur = prev[selectedVoice] || {}
      const next = { gpt: selGpt, sovits: selSovits, gptVoice: gptSrcVoice || '', sovitsVoice: sovitsSrcVoice || '' }
      if (cur.gpt === next.gpt && cur.sovits === next.sovits && (cur.gptVoice || '') === next.gptVoice && (cur.sovitsVoice || '') === next.sovitsVoice) return prev
      return { ...prev, [selectedVoice]: next }
    })
  }, [selectedVoice, selGpt, selSovits, gptSrcVoice, sovitsSrcVoice, gptList, sovitsList])

  // Set language from voice config. Target language (text_lang) follows the primary
  // voice; prompt_lang (the reference audio's language) follows the timbre voice.
  useEffect(() => {
    const v = voices.find(x => x.id === selectedVoice)
    if (v?.language) { setLang(v.language); setTextLang(defaultTargetLang(v.language)) }
  }, [selectedVoice, voices])
  // prompt_lang follows the SoVITS (timbre) voice when models are mixed across assets.
  useEffect(() => {
    if (refVoiceId === selectedVoice) return
    const rv = voices.find(x => x.id === refVoiceId)
    if (rv?.language) setLang(rv.language)
  }, [refVoiceId, voices])

  // Advanced params are global (from /api/advanced-params), not per-voice — no sync needed on voice change

  // Base-model availability for the selected SoVITS model's version — warns about
  // electrical-noise risk when that version's base/SV models are missing on disk.
  const [genBaseWarn, setGenBaseWarn] = useState(null);
  useEffect(() => {
    // Version availability is keyed on the SoVITS side (C3): the vocoder / base+SV
    // requirement comes from the SoVITS model, not the GPT model.
    const sel = sovitsList.find(c => c.path === selSovits);
    const ver = sel && sel.version;
    if (!ver || ver === 'v1') { setGenBaseWarn(null); return; }
    let cancelled = false;
    api(`/api/models/status?version=${encodeURIComponent(ver)}`)
      .then(r => { if (!cancelled) setGenBaseWarn(r.ok && r.data && !r.data.ok ? r.data : null); })
      .catch(() => { if (!cancelled) setGenBaseWarn(null); });
    return () => { cancelled = true; };
  }, [selSovits, sovitsList]);

  // Clear any live activity indicator when leaving the Generate tab.
  useEffect(() => () => onActivity?.(null), [])

  useEffect(() => {
    if (!selectedVoice) return
    api(`/api/voices/${selectedVoice}/validate`).then(r => {
      if (r.ok && r.data.ok) setValidation(r.data.checks)
    }).catch(() => setValidation(null))
  }, [selectedVoice, voices])

  // Use user-selected ref (from VoiceSidebar) or fall back to an auto-picked slice
  // that still exists on disk (server's live `exists` check) and preferably sits in
  // the engine's 3~10s window, so default generation doesn't 400 on a too-short slice.
  const defaultRef = segments.length > 0 ? pickDefaultRef(segments) : null
  const currentRefAudio = selectedRefAudio || (defaultRef ? (defaultRef.audio || defaultRef.audio_path || defaultRef.audio_filename) : '')
  // Once the user explicitly picks a ref, honour its text verbatim — including the
  // empty string for a raw clip (which has no aligned transcript). Only fall back to
  // the auto-picked slice's text when nothing has been selected yet, otherwise a raw
  // pick would silently keep sending the stale slice transcript.
  const currentRefText = selectedRefAudio ? selectedRefText : (defaultRef ? (defaultRef.text || '') : '')

  // Reference-text override (THIS RUN ONLY). Lets the user tweak or add the prompt
  // transcript sent to the engine without touching any file — raw_opt.list /
  // segments.json stay intact (no save endpoint is ever called). null = follow the
  // active reference's own text; a string (incl. '') = use it verbatim this session.
  const [refTextOverride, setRefTextOverride] = useState(null)
  // Drop the override whenever the active reference or the voice changes, so an edit
  // made for one reference never silently leaks onto a different one.
  useEffect(() => { setRefTextOverride(null) }, [selectedVoice, selectedRefAudio])
  const effectiveRefText = refTextOverride != null ? refTextOverride : currentRefText

  // Load the server-authoritative Recent Generations list.
  const loadRecent = async () => {
    const r = await api('/api/outputs')
    if (r.ok && r.data && Array.isArray(r.data.items)) setRecentAll(r.data.items)
  }
  useEffect(() => { loadRecent() }, [])

  // Core generation runner shared by the Generate button and Recent → Rerun.
  // The exact request body is captured into each recent item so Rerun can
  // reproduce the audio with identical settings (not just reload the text).
  const runGenerate = async (body, meta) => {
    setLoading(true); setError(null); setResult(null)
    const t = (body.text || '').trim()
    const willSplit = !!body.split && t.length > (body.max_chars || 30)
    const estChunks = Math.max(1, Math.ceil(t.length / Math.max(1, body.max_chars || 30)))
    onActivity?.({ label: willSplit ? `Generating · ${estChunks} chunks` : 'Generating' })
    try {
      const r = await api('/api/generate', { method: 'POST', body })
      if (!r.ok) throw new Error(r.data.error || `Server error ${r.status}`)
      setResult(r.data)
      if (r.data.audio_url) { loadRecent() }
      return r.data
    } catch (err) { setError(err.message); return null }
    finally { setLoading(false); onActivity?.(null) }
  }

  const handleGenerate = async () => {
    if (!selectedVoice) { setError('Select a voice first'); return }
    if (!text.trim()) { setError('Enter text to synthesize'); return }
    const body = {
      voice: selectedVoice, text: text.trim(), format: 'wav',
      ref_audio: currentRefAudio || undefined,
      reference_text: effectiveRefText || undefined,
      split: splitEnabled, max_chars: maxChars,
      concat: concatEnabled, silence_ms: silenceMs,
      temperature, top_k: topK, top_p: topP,
      repetition_penalty: repPenalty, text_split_method: splitMethod,
      speed_factor: speedFactor, seed,
      batch_size: batchSize, batch_threshold: batchThreshold,
      split_bucket: splitBucket, fragment_interval: fragmentInterval,
      parallel_infer: parallelInfer, engine_batch: engineBatch,
      sample_steps: sampleSteps, if_sr: superSampling,
      media_type: mediaType, streaming_mode: streamingMode,
      overlap_length: overlapLength, min_chunk_length: minChunkLength,
      gpt_model: selGpt, sovits_model: selSovits,
      text_lang: textLang, prompt_lang: selectedPromptLang || lang,
      // Auto (Multilingual): kana-free CJK falls back to the voice's metadata language.
      auto_base_lang: textLang === 'auto_zh_ja' ? (selected?.language || lang || undefined) : undefined,
      aux_ref_audio_paths: auxRefs.length > 0 ? auxRefs : undefined,
      pron_overrides: pronPayload,
      lang_overrides: langOverrides,
      source: 'generate', voice_label: selected?.display_name || selectedVoice,
    }
    const data = await runGenerate(body, { voiceLabel: selected?.display_name || selectedVoice })
    if (data) {
      // Auto-save advanced params after a successful UI-driven generation.
      api('/api/advanced-params', {
        method: 'POST',
        body: {
          temperature, top_k: topK, top_p: topP,
          repetition_penalty: repPenalty, text_split_method: splitMethod,
          speed_factor: speedFactor, seed,
          batch_size: batchSize, batch_threshold: batchThreshold,
          split_bucket: splitBucket, fragment_interval: fragmentInterval,
          parallel_infer: parallelInfer, engine_batch: engineBatch,
          sample_steps: sampleSteps, if_sr: superSampling,
          media_type: mediaType, streaming_mode: streamingMode,
          overlap_length: overlapLength, min_chunk_length: minChunkLength,
        },
      }).catch(() => {})
    }
  }

  // Recent Generations — real management (rerun / reveal / delete + bulk).
  const handleRerun = async (item) => {
    if (loading) return
    if (!item) return
    if (!item.params) {
      // Legacy history entry saved before generation settings were captured: we
      // can only reload its text. The user then presses Generate to synthesize it
      // with the currently selected voice and settings.
      setText(item.text || '')
      setError('This entry was saved before settings capture, so only its text was loaded into the editor above. Press Generate to synthesize it with the current voice and settings. Newly generated items rerun automatically with their exact original settings.')
      return
    }
    setError(null)
    await runGenerate(item.params, { voiceLabel: item.voice })
  }

  // PD: Reload recipe — overwrite ALL editor inputs from a recent item's captured
  // request body (voice / model / language / reference / aux / text / every param /
  // pron overrides) WITHOUT synthesizing. The user reviews/tweaks then presses
  // Generate. Voice-dependent fields (model, language, reference) are applied on the
  // next tick so they win over the voice-change effects that reset them.
  const handleReload = (item) => {
    if (!item) return
    if (!item.params) {
      // PD-2: legacy history entry saved before settings capture — only the text
      // is available. Reload it and tell the user the rest can't be restored.
      setText(item.text || '')
      setError('This is an older history entry saved before full settings capture, so only its text was reloaded into the editor. Choose a voice and adjust settings, then press Generate.')
      return
    }
    const p = item.params
    setError(null)
    // Fields with no voice-dependent reset effect can be applied immediately.
    if (p.text !== undefined) setText(p.text)
    if (p.split !== undefined) setSplitEnabled(!!p.split)
    if (p.max_chars !== undefined) setMaxChars(p.max_chars)
    if (p.concat !== undefined) setConcatEnabled(!!p.concat)
    if (p.silence_ms !== undefined) setSilenceMs(p.silence_ms)
    if (p.temperature !== undefined) setTemperature(p.temperature)
    if (p.top_k !== undefined) setTopK(p.top_k)
    if (p.top_p !== undefined) setTopP(p.top_p)
    if (p.repetition_penalty !== undefined) setRepPenalty(p.repetition_penalty)
    if (p.text_split_method !== undefined) setSplitMethod(p.text_split_method)
    if (p.speed_factor !== undefined) setSpeedFactor(p.speed_factor)
    if (p.seed !== undefined) setSeed(p.seed)
    if (p.batch_size !== undefined) setBatchSize(p.batch_size)
    if (p.batch_threshold !== undefined) setBatchThreshold(p.batch_threshold)
    if (p.split_bucket !== undefined) setSplitBucket(!!p.split_bucket)
    if (p.fragment_interval !== undefined) setFragmentInterval(p.fragment_interval)
    if (p.parallel_infer !== undefined) setParallelInfer(!!p.parallel_infer)
    if (p.sample_steps !== undefined) setSampleSteps(p.sample_steps)
    if (p.if_sr !== undefined) setSuperSampling(!!p.if_sr)
    if (p.media_type !== undefined) setMediaType(p.media_type)
    if (p.streaming_mode !== undefined) setStreamingMode(!!p.streaming_mode)
    if (p.overlap_length !== undefined) setOverlapLength(p.overlap_length)
    if (p.min_chunk_length !== undefined) setMinChunkLength(p.min_chunk_length)
    if (p.engine_batch !== undefined) setEngineBatch(!!p.engine_batch)
    if (Array.isArray(p.aux_ref_audio_paths)) setAuxRefs(p.aux_ref_audio_paths)
    else setAuxRefs([])
    if (p.pron_overrides && Object.keys(p.pron_overrides).length > 0) {
      setPronOverrides(p.pron_overrides)
    } else {
      setPronOverrides({})
    }
    // #4: restore per-character Han-character language overrides (chars only; the
    // reverse language is re-derived from the applied text_lang / voice).
    if (p.lang_overrides && typeof p.lang_overrides === 'object' && !Array.isArray(p.lang_overrides)) {
      setHanForced(Object.entries(p.lang_overrides).map(([char, lang]) => ({ char, lang })))
    } else {
      setHanForced([])
    }
    // #4: restore the forced characters' reverse-language readings (kana / pinyin).
    if (p.han_readings && typeof p.han_readings === 'object' && !Array.isArray(p.han_readings)) {
      setHanReadings(p.han_readings)
    } else {
      setHanReadings({})
    }
    // Switch voice first if needed; the voice-change effects will reset model /
    // language / reference, so re-apply those (below) on the next tick.
    if (p.voice && p.voice !== selectedVoice) setSelectedVoice(p.voice)
    // Restore a cross-asset stack (issue #3) from the checkpoint paths so a mixed
    // A-GPT + B-SoVITS stack is reproduced exactly on Rerun, not collapsed back onto
    // the primary voice. The absolute paths remain the source of truth for the engine;
    // when either model belongs to another asset we re-enable mix mode so the grouped
    // dropdowns keep both selections valid.
    const gptOwner = assetIdFromCkptPath(p.gpt_model)
    const sovitsOwner = assetIdFromCkptPath(p.sovits_model)
    const primary = p.voice || selectedVoice
    const wasMixed = (gptOwner && gptOwner !== primary) || (sovitsOwner && sovitsOwner !== primary)
      || (gptOwner && sovitsOwner && gptOwner !== sovitsOwner)
    setTimeout(() => {
      if (wasMixed) setMixMode(true)
      if (p.gpt_model !== undefined) setSelGpt(p.gpt_model)
      if (p.sovits_model !== undefined) setSelSovits(p.sovits_model)
      if (p.prompt_lang !== undefined) setLang(p.prompt_lang)
      if (p.text_lang !== undefined) setTextLang(p.text_lang)
      onSelectRef?.(p.ref_audio || '', p.reference_text || '', p.prompt_lang || '')
    }, 0)
  }

  const loadRecipeIntoGenerate = () => {
    const recipe = recipes.find(r => r.id === loadRecipeId)
    if (!recipe) return
    setError(null)
    handleReload({ params: recipeToGenerateParams(recipe, text) })
    setNotice(`Loaded recipe ${recipe.id}. Review the editor, then press Generate.`)
  }

  const revealItem = async (item) => {
    const r = await api('/api/outputs/reveal', { method: 'POST', body: { id: item.id } })
    if (!r.ok) setError(outputsError(r, 'Could not open the file location'))
  }

  const askClearHistory = () => setGenConfirm({
    title: 'Clear history',
    message: 'Remove all entries from this list? Your generated audio files stay on disk — only the history shown here is cleared.',
    confirmLabel: 'Clear history',
    danger: false,
    icon: <IconRerun size={18} color="var(--accent)" />,
    onConfirm: () => { setDismissed(prev => Array.from(new Set([...prev, ...recentAll.map(x => x.id)]))); setGenConfirm(null) },
  })

  const askCleanAll = () => setGenConfirm({
    title: 'Clean all audio',
    message: 'Permanently delete EVERY generated audio file in the outputs folder and clear this list. This cannot be undone.',
    confirmLabel: 'Delete files',
    danger: true,
    icon: <IconTrash size={18} color="var(--danger)" />,
    onConfirm: async () => {
      setGenConfirmBusy(true)
      const r = await api('/api/outputs/clear-all', { method: 'POST' })
      setGenConfirmBusy(false)
      if (!r.ok) { setError(outputsError(r, 'Failed to clean output files')); setGenConfirm(null); return }
      setDismissed([]); setResult(null); setGenConfirm(null); loadRecent()
    },
  })

  const askDeleteItem = (item) => setGenConfirm({
    title: 'Delete this audio',
    message: 'Permanently delete this generated audio file from disk and remove it from the list. This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
    icon: <IconTrash size={18} color="var(--danger)" />,
    onConfirm: async () => {
      setGenConfirmBusy(true)
      const r = await api(`/api/outputs/${encodeURIComponent(item.id)}?source=${encodeURIComponent(item.source || 'generate')}`, { method: 'DELETE' })
      setGenConfirmBusy(false)
      if (!r.ok) { setError(outputsError(r, 'Failed to delete audio')); setGenConfirm(null); return }
      setGenConfirm(null); loadRecent()
    },
  })

  return (
    <div className="workspace-grid">
      <div className="workspace-left">
        <div className="section">
          <div className="section-hdr"><span>Generate</span></div>
          <div className="section-body">
            {/* Item 14: Voice / GPT / SoVITS on a single compact row (Edit + Compare Refs
                buttons removed); the model-stack summary stays on the line below. */}
            <div className="field">
              <div className="gen-model-row">
                <div className="gen-model-col">
                  <label className="field-label">Voice</label>
                  <Select className="control" value={selectedVoice} onChange={e => setSelectedVoice(e.target.value)}>
                    {voices.map(v => <option key={v.id} value={v.id}>{voiceOptionLabel(v)}</option>)}
                    {voices.length === 0 && <option value="">{t('No voices available', '没有可用的音色')}</option>}
                  </Select>
                </div>
                {gptList.length > 0 && (
                  <div className="gen-model-col">
                    <label className="field-label">GPT Model{gptSrcVoice && gptSrcVoice !== selectedVoice ? ' *' : ''}</label>
                    <Select className="control" value={selGpt} onChange={e => setSelGpt(e.target.value)}>
                      {mixMode
                        ? gptGroupList.map(g => (
                            <optgroup key={g.voiceId} label={g.displayName}>
                              {g.items.map(c => (
                                <option key={c.path} value={c.path}>{c.name}{c.steps != null ? ` (step ${c.steps})` : ''}</option>
                              ))}
                            </optgroup>
                          ))
                        : gptList.map(c => (
                            <option key={c.path} value={c.path}>{c.name}{c.steps != null ? ` (step ${c.steps})` : ''}</option>
                          ))}
                    </Select>
                  </div>
                )}
                {sovitsList.length > 0 && (
                  <div className="gen-model-col">
                    <label className="field-label">SoVITS Model{sovitsSrcVoice && sovitsSrcVoice !== selectedVoice ? ' *' : ''}</label>
                    <Select className="control" value={selSovits} onChange={e => setSelSovits(e.target.value)}>
                      {mixMode
                        ? sovitsGroupList.map(g => (
                            <optgroup key={g.voiceId} label={g.displayName}>
                              {g.items.map(c => (
                                <option key={c.path} value={c.path}>{c.name}{c.version ? ` · ${c.version}` : ''}</option>
                              ))}
                            </optgroup>
                          ))
                        : sovitsList.map(c => (
                            <option key={c.path} value={c.path}>{c.name}{c.version ? ` · ${c.version}` : ''}</option>
                          ))}
                    </Select>
                  </div>
                )}
              </div>
              <label className="gen-mix-toggle" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, cursor: 'pointer' }}
                title={t('Mix models across assets — pick the GPT and SoVITS models from any voice independently (e.g. A’s GPT + B’s SoVITS).',
                         '跨资产混搭模型 —— GPT 与 SoVITS 可分别从任意音色中独立选择（例如 A 的 GPT + B 的 SoVITS）。')}>
                <input type="checkbox" checked={mixMode} onChange={e => setMixMode(e.target.checked)} />
                <span>{t('Mix models across assets', '跨资产混搭模型')}</span>
              </label>
              {modelSummary && (
                <div className="gen-model-summary" title={modelSummary}>{modelSummary}</div>
              )}
              {modelsMixed && (
                <div className="field-hint" style={{ color: 'var(--warning)', marginTop: 4 }}>
                  {t('⚠ Cross-asset model mix — GPT and SoVITS come from different voices. Timbre follows the SoVITS side; results may vary. Reference audio defaults to the SoVITS voice.',
                     '⚠ 跨资产模型混搭 —— GPT 与 SoVITS 来自不同音色。音色以 SoVITS 侧为准，效果可能有差异。参考音频默认取 SoVITS 侧音色。')}
                </div>
              )}
            </div>

            <div className="field">
              <label className="field-label">Text</label>
              <textarea
                className="control" rows={5} placeholder={t('Enter text to synthesize...', '输入要合成的文本…')}
                value={text} onChange={e => { setText(e.target.value); }}
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span>Characters: <span style={{ color: 'var(--text)' }}>{text.trim().length}</span></span>
                {splitEnabled && (
                  <span>Estimated chunks: <span style={{ color: 'var(--text)' }}>{Math.max(1, Math.ceil(text.trim().length / Math.max(1, maxChars)))}</span></span>
                )}
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Target language:
                  <Select
                    className="control" style={{ height: 22, fontSize: 11, padding: '0 4px', width: 'auto', minWidth: 0 }}
                    value={textLang} onChange={e => setTextLang(e.target.value)}
                  >
                    {TARGET_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                </span>
              </div>
              {langMismatch && (
                <div className="field-hint" style={{ color: 'var(--warning)', marginTop: 4 }}>
                  Target language differs from the fine-tuned language ({String(lang || '').toUpperCase()}). Inference quality may be affected.
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-sm" onClick={() => setShowTextPrep(true)}>
                  Proof &amp; language{'\u2026'}
                </button>
                {hanDir && hanForced.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--accent)' }}>{hanForced.length} Han override(s)</span>
                )}
                {countOverrides(pronOverrides) > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--accent)' }}>{countOverrides(pronOverrides)} reading override(s)</span>
                )}
              </div>
              {showTextPrep && (
                <TextPrepModal
                  onClose={() => setShowTextPrep(false)}
                  text={text} setText={setText} panelLang={panelLang}
                  pronOverrides={pronOverrides} setPronOverrides={setPronOverrides}
                  hanDirection={hanDir} hanForced={hanForced} setHanForced={setHanForced}
                  hanReadings={hanReadings} setHanReadings={setHanReadings}
                />
              )}
            </div>

            <div className="section" style={{ margin: '6px 0' }}>
              <div className="section-hdr"><span>Long-Text Splitting</span></div>
              <div className="section-body">
                <div className="form-grid">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={splitEnabled} onChange={e => setSplitEnabled(e.target.checked)} />
                    Split long text
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>Max chars:</span>
                    <input type="number" className="control" style={{ width: 60, height: 26, padding: '0 6px', fontSize: 12 }} value={maxChars} min={10} max={200} onChange={e => setMaxChars(parseInt(e.target.value) || 30)} />
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={concatEnabled} onChange={e => setConcatEnabled(e.target.checked)} disabled={!splitEnabled} />
                    Concatenate
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>Silence (ms):</span>
                    <input type="number" className="control" style={{ width: 60, height: 26, padding: '0 6px', fontSize: 12 }} value={silenceMs} min={0} max={2000} step={50} onChange={e => setSilenceMs(parseInt(e.target.value) || 300)} />
                  </div>
                </div>
                {splitEnabled && text.length > maxChars && (
                  <div className="field-hint" style={{ marginTop: 6, color: 'var(--warning)' }}>
                    {t(`Text (${text.length} chars) will be split into segments of ~${maxChars} chars each.`,
                       `文本（${text.length} 字符）将被拆分为每段约 ${maxChars} 字符的片段。`)}
                  </div>
                )}
              </div>
            </div>

            {/* Advanced Settings */}
            <div className="collapsible" style={{ margin: '6px 0' }}>
              <div className="collapsible-hdr" onClick={() => setShowAdvanced(!showAdvanced)}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Advanced Settings</span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showAdvanced ? '▲' : '▼'}</span>
              </div>
              {showAdvanced && (
                <div className="collapsible-body">
                  {/* Tier tabs */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                    <button type="button" className="btn btn-sm" onClick={() => setAdvTier('common')} style={{ background: advTier === 'common' ? 'var(--accent)' : 'var(--surface)', color: advTier === 'common' ? '#fff' : 'var(--muted)' }}>Common</button>
                    <button type="button" className="btn btn-sm" onClick={() => setAdvTier('advanced')} style={{ background: advTier === 'advanced' ? 'var(--accent)' : 'var(--surface)', color: advTier === 'advanced' ? '#fff' : 'var(--muted)' }}>Advanced</button>
                  </div>

                  {advTier === 'common' && (
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
                        <Select className="control" value={splitMethod} onChange={e => setSplitMethod(e.target.value)}>
                          <option value="cut0">cut0 (no split)</option>
                          <option value="cut1">cut1 (punctuation)</option>
                          <option value="cut2">cut2 (sentence)</option>
                          <option value="cut3">cut3 (paragraph)</option>
                          <option value="cut4">cut4 (length)</option>
                          <option value="cut5">cut5 (default)</option>
                        </Select>
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
                  )}

                  {advTier === 'advanced' && (
                    <div className="form-grid">
                      <div>
                        <label className="field-label">Batch Size</label>
                        <input type="number" className="control" step="1" min="1" max="8" value={batchSize} onChange={e => setBatchSize(parseInt(e.target.value) || 1)} />
                      </div>
                      <div>
                        <label className="field-label">Batch Threshold</label>
                        <input type="number" className="control" step="0.05" min="0" max="1" value={batchThreshold} onChange={e => setBatchThreshold(parseFloat(e.target.value) || 0.75)} />
                      </div>
                      <div>
                        <label className="field-label">Split Bucket</label>
                        <input type="checkbox" checked={splitBucket} onChange={e => setSplitBucket(e.target.checked)} />
                      </div>
                      <div>
                        <label className="field-label">Fragment Interval (s)</label>
                        <input type="number" className="control" step="0.05" min="0" max="2" value={fragmentInterval} onChange={e => setFragmentInterval(parseFloat(e.target.value) || 0.3)} />
                      </div>
                      <div>
                        <label className="field-label">Parallel Infer</label>
                        <input type="checkbox" checked={parallelInfer} onChange={e => setParallelInfer(e.target.checked)} />
                      </div>
                      <div title={t('Engine batch: send the whole text to the engine in ONE call so it splits and runs chunks through the model in parallel (batch_size). Faster for long text; produces a single audio file with no per-segment files.', '引擎批量：整段文本一次性交给引擎，由引擎切分并按 batch_size 并行推理。长文本更快；输出为单个音频、无分段文件。')}>
                        <label className="field-label">{t('Engine Batch (parallel)', '引擎批量并行')}</label>
                        <input type="checkbox" checked={engineBatch} onChange={e => setEngineBatch(e.target.checked)} />
                      </div>
                      <div>
                        <label className="field-label">Sample Steps (v3)</label>
                        <input type="number" className="control" step="4" min="4" max="64" value={sampleSteps} onChange={e => setSampleSteps(parseInt(e.target.value) || 32)} />
                      </div>
                      <div>
                        <label className="field-label">Super Sampling (v3)</label>
                        <input type="checkbox" checked={superSampling} onChange={e => setSuperSampling(e.target.checked)} />
                      </div>
                      <div>
                        <label className="field-label">Media Type</label>
                        <Select className="control" value={mediaType} onChange={e => setMediaType(e.target.value)}>
                          <option value="wav">WAV</option>
                          <option value="ogg">OGG</option>
                          <option value="aac">AAC</option>
                          <option value="raw">RAW</option>
                        </Select>
                      </div>
                      <div>
                        <label className="field-label">Streaming Mode</label>
                        <Select className="control" value={streamingMode ? 1 : 0} onChange={e => setStreamingMode(!!parseInt(e.target.value))}>
                          <option value={0}>Disabled</option>
                          <option value={1}>Enabled (best quality)</option>
                        </Select>
                      </div>
                      <div>
                        <label className="field-label">Overlap Length</label>
                        <input type="number" className="control" step="1" min="0" max="10" value={overlapLength} onChange={e => setOverlapLength(parseInt(e.target.value) || 2)} />
                      </div>
                      <div>
                        <label className="field-label">Min Chunk Length</label>
                        <input type="number" className="control" step="4" min="4" max="64" value={minChunkLength} onChange={e => setMinChunkLength(parseInt(e.target.value) || 16)} />
                      </div>
                    </div>
                  )}

                  {/* Engine-level params - planned for future release */}
                  {/*
                  <details style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                    <summary style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', cursor: 'pointer' }}>
                      Engine Settings (require restart)
                    </summary>
                    <div className="form-grid" style={{ marginTop: 6 }}>
                      <div>
                        <label className="field-label">Model Version</label>
                        <Select className="control" value={modelVersion || 'v2Pro'} onChange={e => setModelVersion(e.target.value)}>
                          <option value="v2Pro">v2Pro (recommended)</option>
                          <option value="v2ProPlus">v2ProPlus</option>
                          <option value="v2">v2</option>
                          <option value="v3">v3</option>
                          <option value="v4">v4</option>
                        </Select>
                      </div>
                      <div>
                        <label className="field-label">Half Precision</label>
                        <input type="checkbox" checked={isHalf !== false} onChange={e => setIsHalf(e.target.checked)} />
                      </div>
                      <div>
                        <label className="field-label">Device</label>
                        <Select className="control" value={inferDevice || 'cuda'} onChange={e => setInferDevice(e.target.value)}>
                          <option value="cuda">CUDA (GPU)</option>
                          <option value="cpu">CPU</option>
                        </Select>
                      </div>
                    </div>
                    <p style={{ fontSize: 11, color: 'var(--warning)', marginTop: 6 }}>
                      Changing these requires restarting the GPT-SoVITS engine (port 9880) to take effect.
                    </p>
                  </details>
                  */}

                  <div className="field-hint" style={{ marginTop: 6 }}>
                    {t('These parameters are sent to GPT-SoVITS for this generation only. They do not change the voice config.',
                       '这些参数仅用于本次生成并发送给 GPT-SoVITS，不会更改语音配置。')}
                  </div>

                  {/* Auxiliary Reference Audio — shared AuxReferencePicker (Patch #11):
                      This voice (Slices/Raw) · Another voice · Custom files, multi-select
                      + audio preview. Identical interaction to Compare Refs. */}
                  <div style={{ marginTop: 10 }}>
                    <label className="field-label">
                      Auxiliary References
                      <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>
                        {t(`(optional, multi-select${auxRefs.length > 0 ? ` · ${auxRefs.length} selected` : ''})`,
                           `（可选，多选${auxRefs.length > 0 ? ` · 已选 ${auxRefs.length} 项` : ''}）`)}
                      </span>
                    </label>
                    <AuxReferencePicker
                      voiceId={refVoiceId}
                      voices={voices}
                      value={auxRefs}
                      mainRef={currentRefAudio}
                      onAdd={(p) => setAuxRefs(prev => prev.some(x => sameRefPath(x, p)) ? prev : [...prev, p])}
                      onRemove={(i) => setAuxRefs(prev => prev.filter((_, idx) => idx !== i))}
                    />
                  </div>
                </div>
              )}
            </div>

            {genBaseWarn && (
              <div className="msg msg-warn" style={{ marginBottom: 8 }}>
                ⚠ This voice uses a <strong>{genBaseWarn.version}</strong> model, but its base/SV models are
                missing on disk. Synthesis may produce electrical noise or low quality.
                {' '}Run: <code>python download_models.py --set {String(genBaseWarn.version).toLowerCase()}</code>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn btn-primary" onClick={handleGenerate} disabled={loading}>
                {loading ? 'Generating...' : 'Generate'}
              </button>
              <button className="btn btn-ghost" disabled={!selectedVoice || !currentRefAudio}
                title={!currentRefAudio ? 'Pick a reference audio first' : 'Save this reference + parameters as a reusable recipe'}
                onClick={() => setShowSaveRecipe(true)}>
                Save as recipe
              </button>
              <Select className="control" value={loadRecipeId} onChange={e=>setLoadRecipeId(e.target.value)} style={{width:220}}><option value="">Load recipe…</option>{recipes.map(r=><option key={r.id} value={r.id}>{r.display_name||r.id}</option>)}</Select>
              <button className="btn btn-ghost" disabled={!loadRecipeId} onClick={loadRecipeIntoGenerate}>Load</button>
            </div>

            <SaveRecipeModal
              open={showSaveRecipe}
              onClose={() => setShowSaveRecipe(false)}
              source="generate"
              role={selectedVoice}
              defaults={{
                reference_audio: currentRefAudio,
                reference_text: currentRefText,
                language: textLang || lang,
                params: {
                  top_k: topK, top_p: topP, temperature, speed: speedFactor,
                  // PA: pin the full inference contract so the recipe reproduces
                  // the exact audition when distributed via /v1/audio/speech.
                  text_split_method: splitMethod,
                  repetition_penalty: repPenalty,
                  sample_steps: sampleSteps,
                  if_sr: superSampling,
                  batch_size: batchSize,
                  batch_threshold: batchThreshold,
                  split_bucket: splitBucket,
                  fragment_interval: fragmentInterval,
                  parallel_infer: parallelInfer,
                  seed,
                  aux_ref_audio_paths: auxRefs.length > 0 ? auxRefs : [],
                  pron_overrides: (Object.keys(pronOverrides).length > 0) ? pronOverrides : {},
                  lang_overrides: langOverrides || {},
                  han_readings: (hanDir && Object.keys(hanReadings).length > 0)
                    ? Object.fromEntries(Object.entries(hanReadings).filter(([ch]) => hanForced.some(x => (typeof x === 'string' ? x : x.char) === ch)))
                    : {},
                  auto_base_lang: textLang === 'auto_zh_ja' ? (selected?.language || lang) : undefined,
                },
                gpt_ckpt: selGpt,
                sovits_pth: selSovits,
              }}
              onSaved={(rec) => setError(null)}
            />

            {notice && <div className="msg msg-ok">{notice}</div>}
            {error && <div className="msg msg-error"><strong>Error:</strong> {error}</div>}
          </div>
        </div>

        {/* Result */}
        {result && result.audio_url && (
          <div className="section">
            <div className="section-hdr">
              <span>{result.split ? (result.concat ? `Combined (${result.segments?.length} segments)` : `Segments (${result.segments?.length})`) : 'Result'}</span>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {result.silence_ms !== undefined && <span style={{ fontSize: 11, color: 'var(--muted)' }}>silence: {result.silence_ms}ms | {result.concat_method || ''}</span>}
                <SeedBadge seed={result.seed} />
              </span>
            </div>
            <div className="section-body">
              <Player src={`${API_BASE}${result.audio_url}`} bounds={result.segment_bounds} duration={result.duration} />
              <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
                <a href={`${API_BASE}${result.audio_url}`} download style={{ color: 'var(--accent)', fontSize: 13 }}>Download WAV</a>
              </div>
              {result.warning && <div className="msg msg-warning" style={{ marginTop: 8 }}>{result.warning}</div>}
            </div>
          </div>
        )}

        {/* Segments */}
        {result && result.segments && result.segments.length > 1 && (
          <CollapsibleSegments segments={result.segments} />
        )}

        {/* Recent Generations — persistent list with real file management */}
        <div className="section">
          <div className="section-hdr">
            <span>Recent Generations</span>
            {recent.length > 0 && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-ghost" onClick={askClearHistory}>Clear History</button>
                <button className="btn btn-sm btn-danger" onClick={askCleanAll}>Clean All</button>
              </div>
            )}
          </div>
          <div className="section-body">
            {recent.length === 0 ? (
              <div className="empty-state" style={{ padding: 16 }}>
                <div className="es-sub" style={{ marginBottom: 0 }}>{t('Generated audio will appear here.', '生成的音频将显示在这里。')}</div>
              </div>
            ) : (
              recent.map(item => (
                <div key={item.id} className="recent-row">
                  <div className="rr-main">
                    <div className="rr-text" title={item.text}>{item.text || '(empty)'}</div>
                    <div className="rr-meta">
                      {item.voice} · <span style={{ textTransform: 'uppercase' }}>{item.lang}</span> · GPT {item.gpt} / SoVITS {item.sovits}
                      {item.segments > 1 ? ` · ${item.segments} seg` : ''}
                      {refBasename(item) ? ` · ref ${refBasename(item)}` : ''} · {fmtRecentTime(item.createdAt)}
                      {(item.seed ?? item.params?.seed) !== undefined && (item.seed ?? item.params?.seed) !== null && (item.seed ?? item.params?.seed) !== -1 && (
                        <> · <SeedInline seed={item.seed ?? item.params?.seed} /></>
                      )}
                    </div>
                    <div style={{ marginTop: 6 }}><Player src={`${API_BASE}${item.audio_url}`} size="sm" bounds={item.segment_bounds} duration={item.duration} /></div>
                  </div>
                  <div className="rr-actions">
                    <button className="icon-btn" title={t('Show in file explorer', '在文件资源管理器中显示')} onClick={() => revealItem(item)}><IconFolder size={15} /></button>
                    <button className="icon-btn" title={t('Reload these settings into the editor (voice, model, language, reference, text and all parameters) without generating', '将这些设置重新载入编辑器（音色、模型、语言、参考、文本及所有参数），但不生成')} onClick={() => handleReload(item)} disabled={loading}><IconRerun size={15} /></button>
                    <button className="icon-btn" title={t('Rerun now with the original settings', '使用原始设置立即重新生成')} onClick={() => handleRerun(item)} disabled={loading}><IconPlay size={14} /></button>
                    <button className="icon-btn icon-btn-danger" title={t('Delete this audio', '删除此音频')} onClick={() => askDeleteItem(item)}><IconTrash size={15} /></button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <ConfirmDialog
          open={!!genConfirm}
          title={genConfirm?.title}
          message={genConfirm?.message}
          confirmLabel={genConfirm?.confirmLabel}
          danger={genConfirm?.danger}
          icon={genConfirm?.icon}
          busy={genConfirmBusy}
          onConfirm={genConfirm?.onConfirm}
          onCancel={() => { if (!genConfirmBusy) setGenConfirm(null) }}
        />
      </div>

      {/* Right sidebar: voice info */}
      <div className="workspace-right">
        {selected && <VoiceSidebar voice={selected} refVoiceId={refVoiceId} voices={voices} validation={validation} onVoiceUpdate={onVoiceUpdate} selectedRefAudio={selectedRefAudio} selectedRefText={selectedRefText} selectedPromptLang={selectedPromptLang} onSelectRef={onSelectRef} refTextOverride={refTextOverride} onRefTextOverride={setRefTextOverride} />}
      </div>
    </div>
  )
}

function VoiceSidebar({ voice, refVoiceId, voices, validation, onVoiceUpdate, selectedRefAudio, selectedRefText, selectedPromptLang, onSelectRef, refTextOverride, onRefTextOverride }) {
  const { t } = useT()
  // Reference clips are loaded from the timbre (SoVITS) voice (C3); it equals the
  // primary voice unless the SoVITS model was sourced from another asset.
  const rvid = refVoiceId || voice.id
  const refVoice = voices.find(v => v.id === rvid)
  const mixedRef = rvid !== voice.id
  const [segments, setSegments] = useState(null)
  const [rawRefs, setRawRefs] = useState(null)
  const [segLoading, setSegLoading] = useState(false)
  const [refTab, setRefTab] = useState('slices') // 'slices' | 'raw'
  const [refSearch, setRefSearch] = useState('') // main reference search box
  // Client-measured raw durations (filename -> seconds). Raw clips are often mp3,
  // whose length the server can't read from a WAV header, so the <audio> element
  // reports it on loadedmetadata — used for the same 3–10s guard as slices.
  const [rawDurations, setRawDurations] = useState({})
  // 跨选/自选参考音频（本次会话内有效，切换音色时重置；不写入音色配置）。
  const [crossMode, setCrossMode] = useState(false)
  const [customRef, setCustomRef] = useState(null) // { path, url, name } | null

  useEffect(() => {
    if (!rvid) return
    setSegLoading(true)
    setRawDurations({})
    setCrossMode(false)
    setCustomRef(null)
    setRefSearch('')
    Promise.all([
      api(`/api/assets/${rvid}/segments`).then(r => {
        setSegments(r.ok && r.data.segments ? (r.data.segments.segments || []) : [])
      }).catch(() => setSegments([])),
      api(`/api/assets/${rvid}/raw-list`).then(r => {
        setRawRefs(r.ok && r.data.raw ? r.data.raw : [])
      }).catch(() => setRawRefs([])),
    ]).finally(() => setSegLoading(false))
  }, [rvid])

  const pickSlice = (seg) => {
    const audioPath = seg.audio || seg.audio_path || seg.audio_filename
    if (!audioPath) return
    const filename = audioPath.replace(/\\/g, '/').split('/').pop()
    onSelectRef(`assets/${rvid}/slicer_opt/${filename}`, seg.text || '')
  }
  const pickRaw = (rf) => {
    // Reference text comes from asr_opt/raw_opt.list (server-enriched rf.text);
    // may be empty if the raw list hasn't been transcribed yet.
    onSelectRef(`assets/${rvid}/raw/${rf.filename}`, rf.text || '')
  }
  // Cross-voice pick: prompt_lang stays = current voice language (decision: do NOT
  // switch it), just warn. Custom pick: carries an optional prompt_lang override.
  const handleCrossPick = (path, text) => onSelectRef(path, text)
  const handleCustomPick = (path, text, plang, obj) => { if (obj) setCustomRef(obj); onSelectRef(path, text, plang) }
  const handleCustomClear = () => { setCustomRef(null); onSelectRef('', '', '') }
  // Effective duration for a raw clip: server WAV-header value, else client-measured.
  const rawDur = (rf) => (rf.duration && rf.duration > 0 ? rf.duration : rawDurations[rf.filename])

  // Privacy: only offer slices whose .wav still exists on disk right now
  // (server sets `exists` via a live re-check; deleted slices are excluded).
  const availableRefs = segments && Array.isArray(segments)
    ? segments.filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
    : []
  const availableRaw = Array.isArray(rawRefs) ? rawRefs : []
  // Search-filtered views (name + transcript). Empty query => unchanged lists.
  const shownRefs = availableRefs.filter(s => refMatches(refSearch, `${s.scene} #${s.index}`, s.text))
  const shownRaw = availableRaw.filter(rf => refMatches(refSearch, rf.filename, rf.text))

  // Active ref: user selection (from App) > auto-picked in-range slice
  const firstRef = pickDefaultRef(availableRefs)
  const activeRef = selectedRefAudio || (firstRef ? (firstRef.audio || firstRef.audio_path || firstRef.audio_filename) : '')
  // Explicit selection wins verbatim (empty for raw); only auto-fill from the picked
  // slice when the user hasn't chosen anything, so raw picks clear the transcript.
  const activeRefText = selectedRefAudio ? selectedRefText : (firstRef?.text || '')
  const activeFilename = activeRef ? activeRef.replace(/\\/g, '/').split('/').pop() : ''
  const activeIsRaw = /\/raw\//.test(activeRef)

  return (
    <div className="section">
      <div className="section-hdr"><span>{voice.display_name}</span><span style={{ fontSize: 11, color: 'var(--muted)' }}>{voice.id}</span></div>
      <div className="section-body">
        <div className="field">
          <label className="field-label">Language</label>
          <div style={{ fontSize: 13 }}>{voice.language || '?'}</div>
        </div>

        {mixedRef && (
          <div className="field-hint" style={{ color: 'var(--warning)', marginBottom: 6 }}>
            {t(`Reference audio is sourced from the SoVITS voice “${refVoice?.display_name || rvid}” (timbre side).`,
               `参考音频取自 SoVITS 音色「${refVoice?.display_name || rvid}」（音色侧）。`)}
          </div>
        )}

        {/* Reference Audio selector — Slices (default) / Raw as tabs to avoid crowding */}
        <div className="field">
          <div className="ref-hdr">
            <label className="field-label" style={{ margin: 0 }}>Reference Audio</label>
            {!crossMode && (
              <div className="ref-tabs">
                <button
                  className={`ref-tab ${refTab === 'slices' ? 'active' : ''}`}
                  onClick={() => setRefTab('slices')}
                >Slices <span className="ref-tab-count">{availableRefs.length}</span></button>
                <button
                  className={`ref-tab ${refTab === 'raw' ? 'active' : ''}`}
                  onClick={() => setRefTab('raw')}
                >Raw <span className="ref-tab-count">{availableRaw.length}</span></button>
              </div>
            )}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '4px 0 6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={crossMode} onChange={e => {
              const on = e.target.checked
              setCrossMode(on)
              // PE-1: leaving cross-voice mode drops any cross/custom selection so the
              // reference falls back to this voice's own slices, avoiding a stale ref.
              if (!on) { setCustomRef(null); onSelectRef('', '', '') }
            }} />
            {t('Use reference from another voice', '使用其他音色的参考音频')}
          </label>
          {activeRef && (
            <div style={{ fontSize: 12, color: 'var(--text)', background: 'var(--bg)', padding: '6px 8px', borderRadius: 4, wordBreak: 'break-all', marginBottom: activeRefText ? 2 : 6 }}>
              {basename(activeRef)}
            </div>
          )}
          {(() => {
            // Out-of-range warning for the ACTIVE ref — works for both a slice and
            // a raw clip (raw duration may be client-measured, so only warn once known).
            let dur = null
            if (activeIsRaw) {
              const rf = availableRaw.find(r => r.filename === activeFilename)
              if (rf) dur = rawDur(rf)
            } else {
              const activeSeg = availableRefs.find(s => {
                const p = s.audio || s.audio_path || s.audio_filename
                return p && p.replace(/\\/g, '/').split('/').pop() === activeFilename
              })
              if (activeSeg) dur = activeSeg.duration
            }
            if (typeof dur === 'number' && dur > 0 && !refInRange(dur)) {
              return (
                <div className="ref-range-warn">
                  {t(`⚠ Reference is ${dur.toFixed(1)}s — the engine requires ${REF_MIN_SEC}–${REF_MAX_SEC}s. Pick another ${activeIsRaw ? 'clip' : 'slice'} or generation will fail.`,
                     `⚠ 参考音频为 ${dur.toFixed(1)} 秒 —— 引擎要求 ${REF_MIN_SEC}–${REF_MAX_SEC} 秒。请另选一个${activeIsRaw ? '片段' : '切片'}，否则生成将失败。`)}
                </div>
              )
            }
            return null
          })()}
          {activeRef ? (
            // Editable reference transcript (THIS RUN ONLY): edits change the prompt
            // text sent to the engine but never modify the source file. Seeded with the
            // active ref's own text; the override lives in the parent (effectiveRefText).
            <div style={{ marginBottom: 6 }}>
              <textarea
                className="control"
                rows={2}
                style={{ fontSize: 11, width: '100%', fontStyle: refTextOverride != null ? 'normal' : 'italic', whiteSpace: 'pre-wrap' }}
                value={refTextOverride != null ? refTextOverride : activeRefText}
                onChange={e => onRefTextOverride?.(e.target.value)}
                placeholder={activeIsRaw ? t('No aligned transcript — type a reference text for this run (optional)…', '没有对齐的转写文本 —— 可为本次生成输入一段参考文本（可选）…') : t('Reference text…', '参考文本…')}
              />
              <div style={{ fontSize: 10, color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 2 }}>
                <span>
                  {refTextOverride != null
                    ? t('✎ Edited for this run only — the source file is unchanged.', '✎ 仅对本次生成有效 —— 源文件不会被修改。')
                    : (activeIsRaw && !activeRefText
                        ? t('Raw audio has no aligned reference text — type one to guide this run (optional).', '原始音频没有对齐的参考文本 —— 可输入一段以引导本次生成（可选）。')
                        : t('Reference transcript — edits here affect only this run, not the file.', '参考转写文本 —— 此处的修改仅影响本次生成，不会改动文件。'))}
                </span>
                {refTextOverride != null && (
                  <button type="button" className="btn btn-sm" style={{ padding: '0 6px', height: 18, fontSize: 10, flex: '0 0 auto' }}
                    onClick={() => onRefTextOverride?.(null)}>Reset</button>
                )}
              </div>
            </div>
          ) : null}
          {!crossMode && segLoading && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t('Loading reference audio…', '正在加载参考音频…')}</div>}
          {!crossMode && !segLoading && availableRefs.length === 0 && availableRaw.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t('No reference audio available', '没有可用的参考音频')}</div>
          )}
          {!crossMode && !segLoading && (availableRefs.length > 0 || availableRaw.length > 0) && (
            <input
              className="control"
              value={refSearch}
              onChange={e => setRefSearch(e.target.value)}
              placeholder={t('Search reference audio (name or transcript)…', '搜索参考音频（文件名或文本）…')}
              style={{ margin: '4px 0 6px', fontSize: 12 }}
            />
          )}
          {!crossMode && !segLoading && refTab === 'slices' && (
            <div className="ref-list">
              {availableRefs.length === 0 && <div className="ref-col-empty">{t('No slices available', '没有可用的切片')}</div>}
              {availableRefs.length > 0 && shownRefs.length === 0 && <div className="ref-col-empty">{t('No slices match your search', '没有匹配搜索的切片')}</div>}
              {shownRefs.map((seg, i) => {
                const rawPath = seg.audio || seg.audio_path || seg.audio_filename
                const segFilename = rawPath ? rawPath.replace(/\\/g, '/').split('/').pop() : ''
                const isActive = activeFilename === segFilename && !!activeRef
                const outOfRange = !refInRange(seg.duration)
                return (
                  <div key={segFilename || i} className={`ref-item ${isActive ? 'active' : ''}`} title={outOfRange ? `${seg.text || ''}\n⚠ ${(seg.duration || 0).toFixed(1)}s is outside the engine's ${REF_MIN_SEC}–${REF_MAX_SEC}s reference window` : (seg.text || '')} onClick={() => pickSlice(seg)}>
                    <div className="ref-item-row">
                      <span className="ref-item-name">{seg.scene} #{seg.index}</span>
                      <span className={`ref-item-dur ${outOfRange ? 'ref-dur-warn' : ''}`}>{(seg.duration || 0).toFixed(1)}s{outOfRange ? ' ⚠' : ''}</span>
                      <span className="ref-item-mark" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }}>{isActive ? '✓' : '→'}</span>
                    </div>
                    <AudioPlayer src={`/assets/${rvid}/slicer_opt/${segFilename}`} />
                  </div>
                )
              })}
            </div>
          )}
          {!crossMode && !segLoading && refTab === 'raw' && (
            <div className="ref-list">
              {availableRaw.length === 0 && <div className="ref-col-empty">{t('No raw audio available', '没有可用的原始音频')}</div>}
              {availableRaw.length > 0 && shownRaw.length === 0 && <div className="ref-col-empty">{t('No raw audio matches your search', '没有匹配搜索的原始音频')}</div>}
              {shownRaw.map((rf, i) => {
                const isActive = activeFilename === rf.filename && !!activeRef
                const dur = rawDur(rf)
                const known = typeof dur === 'number' && dur > 0
                const outOfRange = known && !refInRange(dur)
                const durTitle = known
                  ? (outOfRange ? `\n⚠ ${dur.toFixed(1)}s is outside the engine's ${REF_MIN_SEC}–${REF_MAX_SEC}s reference window` : '')
                  : ''
                return (
                  <div key={rf.filename || i} className={`ref-item ${isActive ? 'active' : ''}`} title={`${rf.text || rf.filename}${durTitle}`} onClick={() => pickRaw(rf)}>
                    <div className="ref-item-row">
                      <span className="ref-item-name">{rf.filename}</span>
                      {known && (
                        <span className={`ref-item-dur ${outOfRange ? 'ref-dur-warn' : ''}`}>{dur.toFixed(1)}s{outOfRange ? ' ⚠' : ''}</span>
                      )}
                      <span className="ref-item-mark" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }}>{isActive ? '✓' : '→'}</span>
                    </div>
                    <AudioPlayer
                      src={rf.url}
                      onDuration={d => setRawDurations(prev => (prev[rf.filename] ? prev : { ...prev, [rf.filename]: d }))}
                    />
                  </div>
                )
              })}
            </div>
          )}
          {crossMode && (
            <CrossRefPicker voices={voices} currentVoiceId={rvid} onPick={handleCrossPick} activeRef={selectedRefAudio} />
          )}
          {/* PE: the custom-file picker only makes sense as a cross-voice/external
              reference, so it is shown only while "Use reference from another voice"
              is checked. Unchecking clears any custom pick (see checkbox handler). */}
          {crossMode && (
            <CustomRefPicker custom={customRef} onPick={handleCustomPick} onClear={handleCustomClear} />
          )}
        </div>

        {validation && (
          <div className="field" style={{ marginTop: 8 }}>
            <label className="field-label">Model Validity</label>
            <div className="validity-list">
              <div className="validity-row"><span>GPT Model</span>{statusBadge(validation.gpt_model_exists)}</div>
              <div className="validity-row"><span>SoVITS Model</span>{statusBadge(validation.sovits_model_exists)}</div>
              <div className="validity-row"><span>Reference Audio</span>{statusBadge(validation.reference_audio_exists)}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function CollapsibleSegments({ segments }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="collapsible">
      <div className="collapsible-hdr" onClick={() => setOpen(!open)}>
        <span>Segments ({segments.length})</span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="collapsible-body">
          {segments.map(seg => (
            <div key={seg.index} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>Segment {seg.index}</div>
              <div style={{ fontSize: 13, marginBottom: 6 }}>{seg.text}</div>
              <Player src={`${API_BASE}${seg.audio_url}`} size="sm" />
              <a href={`${API_BASE}${seg.audio_url}`} download style={{ color: 'var(--accent)', fontSize: 12, display: 'inline-block', marginTop: 4 }}>Download</a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export {
  GenerateTab,
}
