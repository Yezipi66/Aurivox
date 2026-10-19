import { useState, useEffect, useRef } from 'react'
import { Select } from '../common/Select'
import { usePersistentState } from '../../usePersistentState'
import { API_BASE, api } from '../../lib/api'
import { LANG_LABEL, TextPrepModal, buildLangOverrides, buildPronPayload, hanOverrideDirection, parseLangOverrides } from '../pron/PronProofing'
import { SaveRecipeModal } from '../common/Dialogs'
import { IconFolder, IconRerun, IconTrash } from '../common/Icons'
import { AudioPlayer, Player } from '../common/Player'
import { AuxReferencePicker, CrossRefPicker, CustomRefPicker, RefAudioList } from '../common/RefPickers'
import { REF_MAX_SEC, REF_MIN_SEC, TARGET_LANG_OPTIONS, basename, fmtRecentTime, langLabel, normalizeLangFamily, refInRange, sameRefPath } from '../../lib/format'
import { fieldsForTier, isFieldVisible, initialParamValues, coerceParamValue, paramsToSend, TIERS } from '../../lib/engines'
import { ParamField } from '../common/ParamField'
import { migrateRow } from '../../lib/compareRowMigrate'
import { useT } from '../../lib/i18n'
import { recipePath } from '../../lib/recipes'
import { modelsFromMeta } from '../../lib/modelPickers.pure.js'
import { CMP_LANG_OPTIONS, BASE_VOICE_ID } from './compareConstants'
import { CompareRow } from './CompareRow'
import { CompareBatchCard } from './CompareBatchCard'

// RefAudioTabs was hoisted to common/RefPickers.jsx as the shared RefAudioList
// Compare 的主参考现在用 RefAudioList(single)；辅助
// references use the shared AuxReferencePicker.

// ===========================
//  REFERENCE COMPARE TAB
// ===========================
function ReferenceCompareTab({ engine, voices, selectedVoice, onActivity }) {
  const { t } = useT()
  // Persisted: a Compare Refs workspace must survive reloads / app restarts.
  // Generated audio is referenced by a server URL (result.audio_url) — not a blob —
  // so persisting results keeps the players working after a reload as long as the
  // backend keeps the output file. Transient flags are reset on rehydrate, and the
  // list is capped to avoid blowing the localStorage quota.
  const [rows, setRows] = usePersistentState('compare.rows', [], {
    // Legacy per-row target 'auto' (option removed) falls back to "use default".
    rehydrate: r => Array.isArray(r)
      ? r.map(x => migrateRow(x)).slice(0, 24)
      : [],
  })  // [{ id, refAudio, auxRefPaths, text, params, touched, method, seed, loading, result, error }]
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
  // A-1 engine-batch MASTER switch (1.0.6). Each row's own three-state control
  // (inherit / on / off) resolves against this. Inherit => follow this master.
  const [cmpEngineBatch, setCmpEngineBatch] = usePersistentState('compare.engineBatch', false)
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
  useEffect(() => { api('/api/recipes').then(r => { if (r.ok) setRecipes(r.data?.recipes || []) }).catch(() => {}) }, [])
  // Clear the status-bar activity indicator when leaving the Compare tab.
  useEffect(() => () => onActivity?.(null), [])

  const selected = voices.find(v => v.id === selectedVoice)
  // Seed the row-id counter past any persisted rows so reloaded rows never collide.
  const nextId = useRef(rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1)

  // P1: Save-as-recipe from a compare row. Builds the recipe defaults from the
  // row's reference + params + its per-row model pick.
  const [saveRecipeDefaults, setSaveRecipeDefaults] = useState(null)
  const [recipes, setRecipes] = useState([])
  const openSaveRecipe = (row) => {
    const rm = rowModels[row.id] || {}
    const dp = defaultParams || {}
    // Row's own model language (decoupled from the shared selectedVoice).
    // Reference + language follow the SoVITS (timbre) side when models are mixed (C3).
    const rmVoiceId = rm.sovitsVoiceId || rm.voiceId || selectedVoice
    const rmVoiceLang = availableModels.find(m => m.voiceId === rmVoiceId)?.language
      || voices.find(v => (v.id || v.voiceId) === rmVoiceId)?.language || 'ja'
    // #4: pin this row's reading proofing exactly like the Generate recipe schema —
    // flat base overrides + lang_overrides + han_readings (server.js merges them).
    const rEff = row.textLang || defaultTextLang || rmVoiceLang || 'ja'
    const rDir = hanOverrideDirection(rEff, rmVoiceLang)
    // The row's own text when it has one, otherwise the shared default -- that is
    // exactly the body this recipe will be replayed against, and the body the
    // stored `@N` indices have to still line up with.
    const rText = (row.text && row.text.trim()) ? row.text : defaultText
    const rLangOverrides = buildLangOverrides(rDir, row.hanForced || [], rText)
    setSaveRecipeDefaults({
      reference_audio: row.refAudio || '',
      reference_text: row.promptText || '',
      language: row.textLang || defaultTextLang || rmVoiceLang || 'ja',
      params: {
        // 参数只存当前引擎名片上、且这一行用户明确动过的那些
        //   （跟请求体走的是同一个 paramsToSend，配方和实际发出去的东西
        //   形状一致）。硬编码键名的话，换一台引擎存下来的就是一堆
        //   上游不认的键，存的时候不报错，回放的时候也不报错。
        ...paramsToSend(engine, row.params, row.touched),
        // PA: pin the full contract. Fields Compare does not expose per-row
        // (advanced group) fall back to the shared defaults so the recipe still
        // reproduces the audition.
        //
        // 凡是在当前引擎名片上的参数（不论 common 还是 advanced 层），
        //   都按「这行没动过 ⇒ 取共享默认 / 动过 ⇒ 取这一行的」补齐，
        //   这样配方仍然是「完整合同」（回放得出一模一样的结果），
        //   而键名一个都不写死。
        ...(() => {
          const known = (engine?.param_schema || [])
          const shared = defaultParams || {}
          const out = {}
          for (const f of known) {
            if (!f || !f.name) continue
            if (Object.prototype.hasOwnProperty.call(row.params || {}, f.name)) continue  // 上面已写
            if (Object.prototype.hasOwnProperty.call(shared, f.name)) out[f.name] = shared[f.name]
          }
          return out
        })(),
        // seed 是平台自己的开关，不在任何引擎的 param_schema 上，但配方
        //   必须把它钉住，否则回放不是同一个结果。
        seed: row.seed,
        aux_ref_audio_paths: (row.auxRefPaths && row.auxRefPaths.length > 0) ? row.auxRefPaths : [],
        // P1-1 / #4: pin this row's own reading overrides (not a shared, cross-row set).
        pron_overrides: (row.pronOverrides && Object.keys(row.pronOverrides).length > 0) ? row.pronOverrides : {},
        lang_overrides: rLangOverrides || {},
        han_readings: (rDir && row.hanReadings && Object.keys(row.hanReadings).length > 0)
          ? Object.fromEntries(Object.entries(row.hanReadings).filter(([key]) => (row.hanForced || []).some(x => x && typeof x === 'object' && key === `@${x.index}:${x.char}`)))
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
  // 'auto' (removed here) migrates to the multilingual 'auto_zh_ja_yue'.
  const [defaultTextLang, setDefaultTextLang] = usePersistentState('compare.defaultTextLang', 'auto_zh_ja_yue', {
    rehydrate: v => (v === 'auto' || !v) ? 'auto_zh_ja_yue' : v,
  })
  const voiceLang = selected?.language || 'ja'
  const _cmpBaseFam = String(voiceLang || '').replace(/^all_/, '')
  const _cmpTargetFam = normalizeLangFamily(defaultTextLang)
  // #4: shared comparison-text reading proofing + Han-character language payloads.
  const defaultPanelLang = _cmpTargetFam || _cmpBaseFam || 'ja'
  const defaultHanDir = hanOverrideDirection(defaultTextLang, voiceLang)
  const defaultLangOverrides = buildLangOverrides(defaultHanDir, defaultHanForced, defaultText)
  const defaultPronPayload = buildPronPayload(defaultPronOverrides, defaultPanelLang, defaultHanDir, defaultHanForced, defaultHanReadings)

  // Load default advanced params from backend
  // 当前用 `/api/advanced-params` 加上 engine_id，
  //   后端在没有 engine_id 时会挑一台"默认引擎"顶上（legacyDefault）。那条路已经删了
  //   ⇒ 现在必须带上 engine_id，且 engine 还没到就一个字节都不发。
  //   不许在这里塞任何回落引擎，回落回来的默认值属于另一台引擎，
  //     它会安静地写进这一页的默认参数里，直到某次合成报出一个谁都不匹配的错。
  useEffect(() => {
    if (!engine?.id) return
    api(`/api/advanced-params?engine_id=${encodeURIComponent(engine.id)}`).then(r => {
      if (r.ok && r.data) setDefaultParams(r.data)
    }).catch(() => {})
  }, [engine?.id])

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
      .catch(err => console.error('audio-files?dir=no_slice 取不到，这一组参照音频留空：', err))
    api('/api/audio-files?dir=voices').then(r => { if (r.ok) setVoiceFiles(r.data.files) })
      .catch(err => console.error('audio-files?dir=voices 取不到，这一组参照音频留空：', err))
    // Load models from assets/ meta.json (source of truth) instead of voices.json.
    // Also pull the built-in Base model (GET /api/assets/__base__) so its pretrained
    // weights are selectable here for zero-shot reference comparison — it isn't in the
    // /api/assets roster (no folder on disk), so it must be fetched explicitly.
    // 这一页整页都是「两份权重两两组合去试听」的形状，它问的是那条特定的
    //   合成链路，所以引擎名在这里是这一页自己的题目，不是平台写死了一台引擎。
    //   取值层级用新结构，形状原样不动。
    // 挂账：这一页要变成通用的，得按「当前引擎有几个位」重画，连带整行的
    //   混搭开关一起动。那是独立一件事，本轮不做。
    // 引擎名不写死成 `CMP_ENGINE = 'gpt-sovits'`，位名也不写死
    //   成 'gpt' / 'sovits'，否则连文件选择器的扩展名都会被钉成 .ckpt / .pth。
    //   后果：一台别的引擎的资产在这页里连一个模型位都列不出来，
    //   而界面上看起来只是「这个音色没模型」，没有任何一句说「因为这里写死了引擎」。
    //
    //   按当前引擎的两个位名取权重：GSV 的位名就还叫 gpt/sovits，
    //   所以 GSV 用户看到的下拉一个字都没变；别的引擎名下名片给什么位名就取
    //   什么位名，取不到就只有 0 个组合，行自己退化成「用当前音色」，
    //   而不是画一个空下拉。
    //
    //   真正的「每行不同引擎并排」仍是计划里的遗留 L3（那要重画整行的
    //   混搭开关，不是本刀）。这里只是不再按引擎身份分叉。
    const buildModels = (vid, meta, out) => {
      // 位名也来自名片，不写死 'gpt'/'sovits'
      // （weight_slots 是 [{name,label,param,applies_at}]，这里只要 name）。
      const slots = (engine?.weight_slots || []).map(s => s && s.name).filter(Boolean)
      const gptSlot = slots.length > 0 ? slots[0] : null
      const sovitsSlot = slots.length > 1 ? slots[1] : null
      // 不足两个位 ⇒ 造不出「两份权重两两组合」这种行，一组都不造。
      //   静默造 0 组 = 行画出来是空的、用户不知道为什么。
      if (!gptSlot || !sovitsSlot) return
      const gptList = modelsFromMeta(meta, engine?.id, gptSlot)
      const sovitsList = modelsFromMeta(meta, engine?.id, sovitsSlot)
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
    // 依赖里必须有 engine.id：buildModels 现在按当前引擎的位名取权重。
    //   少了这一项 ⇒ 换引擎后这个下拉还是上一台引擎的权重，而且是安静地
    //   错，界面上没有任何一处会告诉你它没跟着换。
  }, [engine?.id])

  const addRow = (opts = {}) => {
    const rowId = nextId.current++
    // Default model: first available model for the selected voice, or first overall
    const defaultModel = availableModels.find(m => m.voiceId === selectedVoice && m.default)
      || availableModels.find(m => m.voiceId === selectedVoice) || availableModels[0]
    const modelForRow = defaultModel
      ? { voiceId: defaultModel.voiceId, gptCheckpoint: defaultModel.gptCheckpoint, sovitsModel: defaultModel.sovitsModel, gptVoiceId: '', sovitsVoiceId: '' }
      : { voiceId: '', gptCheckpoint: '', sovitsModel: '', gptVoiceId: '', sovitsVoiceId: '' }
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
    // 参数值和 touched 由 CompareRow 按当前引擎的 param_schema 自己起步
    //   （initialParamValues），行的诞生不再知道任何一台引擎的参数叫什么。
    //   method 用名片给的默认值，不许在这里「取第一个」。
    const methodDefault = (engine?.methods && engine.methods.length > 0)
      ? (engine.default_method || null)
      : null
    setRows(prev => [...prev, {
      id: rowId,
      refAudio: defaultRef,
      ...(startSource ? { refSource: startSource } : {}),
      auxRefPaths: [],
      text: defaultText,
      params: {},
      touched: [],
      ...(methodDefault ? { method: methodDefault } : {}),
      seed: dp.seed ?? -1,
      // A-1 engine-batch three-state: 'inherit' (follow master) | 'on' | 'off'.
      engine_batch: 'inherit',
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

  const loadRecipeIntoRow = (row, recipeId) => {
    const rec=recipes.find(r=>r.id===recipeId); if(!rec)return; const p=rec.params||{}
    setRows(prev=>prev.map(r=>r.id===row.id?{...r,refAudio:recipePath(rec.reference_audio),promptText:rec.reference_text||'',auxRefPaths:(p.aux_ref_audio_paths||[]).map(recipePath).filter(Boolean),textLang:rec.language||'',// 配方回放出来的键都标成用户动过（touched =
      //   配方里出现的键名），配方回放本来就是用户显式存下来的选择。
      ...(() => {
        const known = new Set((engine?.param_schema || []).map(f => f && f.name))
        const picked = {}
        for (const [k, v] of Object.entries(p)) {
          // seed 不在 param_schema 里（平台自己的开关），在下面单独处理。
          if (known.has(k) && v !== undefined) picked[k] = v
        }
        return { params: { ...(r.params || {}), ...picked },
                 touched: Array.from(new Set([...(r.touched || []), ...Object.keys(picked)])) }
      })(),
      seed:p.seed??r.seed,pronOverrides:p.pron_overrides||{},hanForced:parseLangOverrides(p.lang_overrides),hanReadings:p.han_readings||{},result:null,error:null}:r))
    setRowModels(prev=>({...prev,[row.id]:{voiceId:rec.role||selectedVoice,gptCheckpoint:recipePath(rec.gpt_ckpt),sovitsModel:recipePath(rec.sovits_pth)}}))
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
    // Reference + language follow the SoVITS (timbre) side when models are mixed (C3);
    // the GPT may be sourced from a different asset without moving the reference.
    const rowVoiceId = rowModel.sovitsVoiceId || rowModel.voiceId || selectedVoice
    const rowVoiceLang = availableModels.find(m => m.voiceId === rowVoiceId)?.language
      || voices.find(v => (v.id || v.voiceId) === rowVoiceId)?.language || 'ja'
    try {
      const body = {
        voice: rowVoiceId,
        text: row.text.trim() || defaultText,
        format: 'wav',
        // 和 Generate 页同一件事：这一次要连哪台引擎，由界面上选中的那台
        //   说了算，不让服务端去 legacy_default 里认领。
        engine_id: engine?.id,
        source: 'comparerefs',
        split: true,
        concat: true,
        ref_audio: row.refAudio || undefined,
        aux_ref_audio_paths: row.auxRefPaths.length > 0 ? row.auxRefPaths : undefined,
        // 参数只发用户明确动过的那些。键名写死的话，换一台引擎这些键上游
        //   不认，而请求照发，不报错，用户看到的是「参数调了没反应」。
        //   键名和类型都来自当前引擎的 param_schema（paramsToSend 是
        //   web/src/lib/engines.js 的权威实现，GenerateTab 用的是同一个
        //   函数，不是新写一份）。
        ...paramsToSend(engine, row.params, row.touched),
        // 这一行走哪个推理方法（点 1：profile.methods 交到前端）。
        //   只交名字：方法内部怎么绑参数、要不要参考音频，是 host.py 的事，
        //   前端不复制那份规则（那是第二份会漂移的事实）。
        //   单方法引擎 methods 为 null ⇒ 不发这个键，让后端用名片上的固定入口。
        ...(row.method ? { method: row.method } : {}),
        seed: row.seed,
        // A-1: resolve this row's three-state engine-batch against the master.
        engine_batch: (row.engine_batch === 'on') ? true
          : (row.engine_batch === 'off') ? false
          : !!cmpEngineBatch,
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
      if (body.text_lang === 'auto_zh_ja_yue') body.auto_base_lang = rowVoiceLang || 'zh'
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
      // body.text is the exact string this request will synthesise, so prune the
      // stored `@N` indices against it and nothing else.
      const rLangOverrides = buildLangOverrides(rDir, row.hanForced || [], body.text)
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
            {t(
              <>Add as many rows as you like. Each row = a different reference audio configuration.
              Click <strong>Generate All</strong> to hear every combination side by side.
              The best one can be saved as the voice config.</>,
              <>可以添加任意多行，每行 = 一种不同的参考音频配置。点击 <strong>Generate All</strong> 即可并排试听所有组合，最满意的一个可保存为该音色的配置。</>)}
          </p>

          <div className="field">
            {/* Extra patch: this is the "comparison text" — every row uses it by default so
                only the reference / model differs; a row can override it via its Text section. */}
            <label className="field-label">{t('Comparison Text', '对比文本')}</label>
            <div className="field-hint" style={{ marginBottom: 4 }}>
              {t(
                <>Every row uses this text by default, so you compare references / models on the same sentence. To give a row its own text, expand that row&apos;s <strong>Text</strong> section.</>,
                <>默认所有行都使用这段文本，以便在同一句话上对比参考音频 / 模型。若想让某一行使用自己的文本，可展开该行的 <strong>Text</strong> 区域。</>)}
            </div>
            <textarea className="control" rows={3} value={defaultText} onChange={e => setDefaultText(e.target.value)}
              placeholder="Enter the text used across all rows for comparison…" />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {t('Default target language:', '默认目标语言：')}
                <Select
                  className="control" style={{ height: 22, fontSize: 11, padding: '0 4px', width: 'auto', minWidth: 0 }}
                  value={defaultTextLang} onChange={e => setDefaultTextLang(e.target.value)}
                >
                  {CMP_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
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
                <span style={{ fontSize: 11, color: 'var(--accent)' }}>{t(`${defaultHanForced.length} forced ${LANG_LABEL[defaultHanDir.reverse]}`, `已强制 ${defaultHanForced.length} 个字为 ${LANG_LABEL[defaultHanDir.reverse]}`)}</span>
              )}
              {Object.keys(defaultPronOverrides || {}).length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--accent)' }}>{t(`${Object.keys(defaultPronOverrides).length} reading override(s)`, `${Object.keys(defaultPronOverrides).length} 处读音覆盖`)}</span>
              )}
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('applies to every row that doesn\u2019t override its own text', '对所有未使用自有文本的行生效')}</span>
            </div>
            {showDefaultTextPrep && (
              <TextPrepModal
                onClose={() => setShowDefaultTextPrep(false)}
                text={defaultText} setText={setDefaultText} panelLang={defaultPanelLang}
                pronOverrides={defaultPronOverrides || {}} setPronOverrides={setDefaultPronOverrides}
                hanDirection={defaultHanDir} hanForced={defaultHanForced} setHanForced={setDefaultHanForced}
                hanReadings={defaultHanReadings} setHanReadings={setDefaultHanReadings}
                engineId={engine?.id}
              />
            )}
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
              {t(
                <>You can also proof a single row: expand that row&apos;s Text section and open its own <strong>Proof &amp; language</strong>.</>,
                <>也可以只校对单独一行：展开该行的 Text 区域，打开它自己的 <strong>Proof &amp; language</strong>。</>)}
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, cursor: 'pointer' }}
            title={t('Master switch: send each row\u2019s whole text to the engine in ONE call so it splits and batches chunks in parallel (batch_size). Faster; single audio per row, no per-segment files. Each row can override this (Advanced Settings \u2192 Engine Batch).', '总开关：把每一行的整段文本一次性交给引擎，由引擎切分并按 batch_size 并行推理。更快；每行输出单个音频、无分段文件。各行可在「Advanced Settings → Engine Batch」单独覆盖。')}>
            <input type="checkbox" checked={cmpEngineBatch} onChange={e => setCmpEngineBatch(e.target.checked)} />
            <span>{t('Engine Batch (parallel) \u2014 all rows', '引擎批量并行：全部行（总开关）')}</span>
          </label>

          <div className="cmp-toolbar">
            <button className="btn btn-sm btn-primary" onClick={addRow}>+ Add Row</button>
            <button className="btn btn-sm" onClick={generateAll} disabled={rows.length === 0 || rows.some(r => r.loading)}>
              {rows.some(r => r.loading)
                ? t(`Generating… (${rows.filter(r => r.result && r.result.audio_url).length}/${rows.length})`, `生成中… (${rows.filter(r => r.result && r.result.audio_url).length}/${rows.length})`)
                : `Generate All (${rows.length})`}
            </button>
            {rows.length > 0 && (
              <span className="cmp-count">{t(`${rows.filter(r => r.result && r.result.audio_url).length}/${rows.length} ready`, `${rows.filter(r => r.result && r.result.audio_url).length}/${rows.length} 就绪`)}</span>
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
          engineId={engine?.id}
          // 传整个 engine 对象（param_schema / methods / …），
          //   只传 engineId 的话这一页就没法按名片长格子，名字拿不到形状。
          engine={engine}
          allAudioFiles={allAudioFiles}
          voiceFiles={voiceFiles}
          onUpdate={updateRow}
          onAddAux={addAuxToRow}
          onRemoveAux={removeAuxFromRow}
          onGenerate={generateRow}
          onRemove={removeRow}
          onSaveRecipe={openSaveRecipe}
          recipes={recipes}
          onLoadRecipe={loadRecipeIntoRow}
          availableModels={availableModels}
          rowModel={rowModels[row.id] || { voiceId: '', gptCheckpoint: '', sovitsModel: '' }}
          onModelChange={(model) => setRowModels(prev => ({ ...prev, [row.id]: model }))}
          defaultParams={defaultParams}
          selectedVoice={selectedVoice}
          voices={voices}
          voiceLang={voiceLang}
          defaultTextLang={defaultTextLang}
          masterEngineBatch={cmpEngineBatch}
        />
      ))}

      {rows.length === 0 && (
        <div className="section">
          <div className="section-hdr"><span>{t('Get Started', '开始使用')}</span></div>
          <div className="section-body">
            <div className="starter-grid">
              <div className="starter-card">
                <div className="sc-title">{t('Use Current Reference', '使用当前参考音频')}</div>
                <div className="sc-desc">{t(
                  <>Create a row from <strong>{selected?.display_name || selectedVoice || 'the selected voice'}</strong>'s default reference audio.</>,
                  <>使用 <strong>{selected?.display_name || selectedVoice || '所选音色'}</strong> 的默认参考音频创建一行。</>)}</div>
                <button className="btn btn-sm btn-primary" onClick={() => addRow()} disabled={!selectedVoice}>{t('Use Current Reference', '使用当前参考音频')}</button>
              </div>
              <div className="starter-card">
                <div className="sc-title">{t('Add Empty Row', '添加空行')}</div>
                <div className="sc-desc">{t('Manually configure reference audio and prompt text from scratch.', '从零开始手动配置参考音频和提示文本。')}</div>
                <button className="btn btn-sm" onClick={() => addRow({ empty: true })}>{t('Add Empty Row', '添加空行')}</button>
              </div>
              <div className="starter-card">
                <div className="sc-title">{t('Load From Assets', '从资源加载')}</div>
                <div className="sc-desc">{t("Add a row, then pick existing slices / reference samples from voice assets in the row's picker.", '先添加一行，然后在该行的选择器中从音色资源里挑选已有的切片 / 参考样本。')}</div>
                <button className="btn btn-sm" onClick={() => addRow()} disabled={!selectedVoice}>{t('Load From Assets', '从资源加载')}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Comparison results area (Part 5) */}
      {rows.length > 0 && !rows.some(r => r.result) && (
        <div className="empty-state" style={{ marginTop: 4, padding: 16 }}>
          <div className="es-sub" style={{ marginBottom: 0 }}>{t('Generated comparison results will appear here.', '生成的对比结果会显示在这里。')}</div>
        </div>
      )}

      {/* Batch history — every "Generate All" recorded as one comparison batch. */}
      {batches.length > 0 && (
        <div className="section" style={{ marginTop: 16 }}>
          <div className="section-hdr">
            <span>{t('Comparison Batches', '对比批次')}</span>
            <span className="cmp-count">{t(`${batches.length} recorded`, `已记录 ${batches.length} 次`)}</span>
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

export { ReferenceCompareTab }
