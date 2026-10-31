// 参考音频对比页：每一行是一种参考音频配置，逐行或整批并排试听。
// 参考音频的挑选与列表来自共享组件 common/RefPickers.jsx；每一行能用的模型、参数与语种都取自当前引擎的名单。
// 行数据经 usePersistentState 持久化（rehydrate 时做迁移与截断），生成结果引用服务端 URL 而不是 blob，所以刷新后仍可播放。

import { useState, useEffect, useRef } from 'react'
import { Select } from '../common/Select'
import { usePersistentState } from '../../usePersistentState'
import { API_BASE, api } from '../../lib/api'
import { LANG_LABEL, TextPrepModal, buildLangOverrides, buildPronPayload, hanOverrideDirection, parseLangOverrides } from '../pron/PronProofing'
import { SaveRecipeModal } from '../common/Dialogs'
import { IconFolder, IconRerun, IconTrash } from '../common/Icons'
import { AudioPlayer, Player } from '../common/Player'
import { AuxReferencePicker, CrossRefPicker, CustomRefPicker, RefAudioList } from '../common/RefPickers'
import { REF_MAX_SEC, REF_MIN_SEC, refInRange, sameRefPath } from '../../lib/refAudio'
import { TARGET_LANG_OPTIONS, langLabel, normalizeLangFamily } from '../../lib/langOptions'
import { basename, fmtRecentTime } from '../../lib/pathText'
import { fieldsForTier, isFieldVisible, initialParamValues, coerceParamValue, paramsToSend, TIERS } from '../../lib/engines'
import { ParamField } from '../common/ParamField'
import { migrateRow } from '../../lib/compareRowMigrate'
import { useT } from '../../lib/i18n'
import { recipePath, weightsToRecipeFields } from '../../lib/recipes'
import { modelsFromMeta, slotsOf, weightsFromParams, weightsToSend } from '../../lib/modelPickers.pure.js'
import {
  MODEL_COMBO_LIMIT, modelCombos, normalizeRowModel, referenceVoiceOf, weightRequestFields, slotItemText,
} from './compareModelPicks.pure.js'
import { CMP_LANG_OPTIONS, BASE_VOICE_ID } from './compareConstants'
import { CompareRow } from './CompareRow'
import { CompareBatchCard } from './CompareBatchCard'

function ReferenceCompareTab({ engine, voices, selectedVoice, onActivity }) {
  const { t } = useT()
  // 对比页的参考配置工作区要能扛住刷新与应用重启。
  // 生成出来的音频按服务端 URL 引用（result.audio_url），不是 blob：
  // 所以只要后端还留着输出文件，持久化结果就能让播放器在刷新后照常工作。
  // 临时状态在重新载入时重置，列表设上限，避免撑爆 localStorage 配额。
  const [rows, setRows] = usePersistentState('compare.rows', [], {
    // 旧的每行目标语种 'auto'（该选项已下线）落到「用默认」。
    rehydrate: r => Array.isArray(r)
      ? r.map(x => migrateRow(x)).slice(0, 24)
      : [],
  })  // [{ id, refAudio, auxRefPaths, text, params, touched, method, seed, loading, result, error }]
  const [allAudioFiles, setAllAudioFiles] = useState([])
  const [voiceFiles, setVoiceFiles] = useState([])
  // 共享的默认文本一开始是空的。一行文本为空时后端会理解成
  // 「用这个音色自带的默认文本」，这样对比就只隔离参考音频，
  // 除非用户特意写了脚本。
  const [defaultText, setDefaultText] = usePersistentState('compare.defaultText', '')
  // 共享的对比文本也支持读音校对，作用于所有没有自备文本的行。
  // 通过读音与语种弹窗设置，没有单独的开关。
  const [defaultPronOverrides, setDefaultPronOverrides] = usePersistentState('compare.defaultPronOverrides', {})
  // 共享对比文本的逐字汉语言种覆盖与反查读音（与生成页一致），
  // 作用于所有没有自备文本的行。
  const [defaultHanForced, setDefaultHanForced] = usePersistentState('compare.defaultHanForced', [])
  const [defaultHanReadings, setDefaultHanReadings] = usePersistentState('compare.defaultHanReadings', {})
  const [showDefaultTextPrep, setShowDefaultTextPrep] = useState(false)
  const [availableModels, setAvailableModels] = useState([])  // [{ voiceId, voiceName, picks, items, label }]
  // 每行的模型选择按位名索引：picks 存路径，owners 存跨角色选择时那一侧的角色。
  const [rowModels, setRowModels] = usePersistentState('compare.rowModels', {}, {
    // 旧形状把两个位写死成 gptCheckpoint/sovitsModel，读回时搬进 picks。
    rehydrate: v => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
      const out = {}
      for (const [rowId, rm] of Object.entries(v)) out[rowId] = normalizeRowModel(rm)
      return out
    },
  })
  // 模型组合超过上限时被丢弃的数量，用于界面提示。
  const [modelComboDropped, setModelComboDropped] = useState(0)
  const [defaultParams, setDefaultParams] = useState(null)  // 从 /api/advanced-params 读
  // 引擎批量推理的总开关。每行自己的三态（继承 / 开 / 关）都对着它解析，
  // 「继承」就是跟着这个总开关走。
  const [cmpEngineBatch, setCmpEngineBatch] = usePersistentState('compare.engineBatch', false)
  const [segmentsCache, setSegmentsCache] = useState({})  // { voiceId: segments[] }
  // 批量历史：服务端记的每一次「全部生成」的记录，从成员 meta.json 重建
  // （GET /api/outputs/batches）。它显示每次对比产出了几个音频、每个成员用了哪份参考。
  const [batches, setBatches] = useState([])
  const loadBatches = async () => {
    const r = await api('/api/outputs/batches?source=comparerefs')
    if (r.ok && r.data && Array.isArray(r.data.batches)) setBatches(r.data.batches)
  }
  useEffect(() => { loadBatches() }, [])
  useEffect(() => { api('/api/recipes').then(r => { if (r.ok) setRecipes(r.data?.recipes || []) }).catch(() => {}) }, [])
  // 离开对比页时清掉状态栏的活动指示。
  useEffect(() => () => onActivity?.(null), [])

  const selected = voices.find(v => v.id === selectedVoice)
  // 行 id 计数器要越过任何已持久化的行，载入的行才不会撞号。
  const nextId = useRef(rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1)

  // 从对比页这一行另存为配方：用这一行的参考音频、参数与该行选的模型来建配方默认值。
  const [saveRecipeDefaults, setSaveRecipeDefaults] = useState(null)
  const [recipes, setRecipes] = useState([])
  const openSaveRecipe = (row) => {
    const slots = slotsOf(engine)
    const rm = normalizeRowModel(rowModels[row.id])
    const dp = defaultParams || {}
    // 这一行自己的模型语种（与共享的 selectedVoice 无关）。
    // 混搭时参考音频与语种跟随名片里第一个能换的位（GSV 是 SoVITS）。
    const rmVoiceId = referenceVoiceOf(rm, slots, selectedVoice)
    const rmVoiceLang = availableModels.find(m => m.voiceId === rmVoiceId)?.language
      || voices.find(v => (v.id || v.voiceId) === rmVoiceId)?.language || 'ja'
    // 按生成页的配方结构钉住读音校对：
    // 平铺的基础覆盖 + lang_overrides + han_readings（服务端负责合并）。
    const rEff = row.textLang || defaultTextLang || rmVoiceLang || 'ja'
    const rDir = hanOverrideDirection(rEff, rmVoiceLang)
    // 这一行自己的文本，没有就用共享的默认文本：
    // 那正是这份配方回放时面对的正文，也是存下来的 @N 下标要对齐的正文。
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
        // 对比页不逐行暴露的那些字段（advanced 层）回落到共享默认值，
        // 这样配方仍能复现出同一次试听。
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
        // 钉住这一行自己的读音覆盖（不是跨行共享的那一套）。
        pron_overrides: (row.pronOverrides && Object.keys(row.pronOverrides).length > 0) ? row.pronOverrides : {},
        lang_overrides: rLangOverrides || {},
        han_readings: (rDir && row.hanReadings && Object.keys(row.hanReadings).length > 0)
          ? Object.fromEntries(Object.entries(row.hanReadings).filter(([key]) => (row.hanForced || []).some(x => x && typeof x === 'object' && key === `@${x.index}:${x.char}`)))
          : {},
      },
      // 配方顶层只装得下两个权重字段（历史格式），能装下的位由 weightsToRecipeFields 决定。
      ...weightsToRecipeFields(weightsToSend(slots, rm.picks)),
    })
  }

  // 共享的默认目标语种（text_lang）与读音校对，供空行与未定制的行使用，
  // 与生成页一致。每行仍可覆盖自己的目标语种。
  // 它与生成页选中的音色解耦：对比文本的目标语种是自由选择（默认多语种 auto），
  // 不由选中的音色推导，音色换了也不会自动跟着变。
  // 旧的持久化值 'auto'（已下线）迁移到多语种的 'auto_zh_ja_yue'。
  const [defaultTextLang, setDefaultTextLang] = usePersistentState('compare.defaultTextLang', 'auto_zh_ja_yue', {
    rehydrate: v => (v === 'auto' || !v) ? 'auto_zh_ja_yue' : v,
  })
  const voiceLang = selected?.language || 'ja'
  const _cmpBaseFam = String(voiceLang || '').replace(/^all_/, '')
  const _cmpTargetFam = normalizeLangFamily(defaultTextLang)
  // 共享对比文本的读音校对与逐字汉语言种载荷。
  const defaultPanelLang = _cmpTargetFam || _cmpBaseFam || 'ja'
  const defaultHanDir = hanOverrideDirection(defaultTextLang, voiceLang)
  const defaultLangOverrides = buildLangOverrides(defaultHanDir, defaultHanForced, defaultText)
  const defaultPronPayload = buildPronPayload(defaultPronOverrides, defaultPanelLang, defaultHanDir, defaultHanForced, defaultHanReadings)

  // 从后端取默认的 advanced 参数。
  // 请求必须带 engine_id：后端不带 engine_id 时不回落到任何一台引擎，
  //   拿回来的默认值就可能属于另一台引擎，它会安静地写进这一页的默认参数里，
  //   直到某次合成报出一个谁都不匹配的错。engine 还没到就一个字节都不发。
  useEffect(() => {
    if (!engine?.id) return
    api(`/api/advanced-params?engine_id=${encodeURIComponent(engine.id)}`).then(r => {
      if (r.ok && r.data) setDefaultParams(r.data)
    }).catch(() => {})
  }, [engine?.id])

  // 预加载选中音色的切片
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
      .catch(err => console.error('audio-files?dir=no_slice 读取失败，该组参考音频留空：', err))
    api('/api/audio-files?dir=voices').then(r => { if (r.ok) setVoiceFiles(r.data.files) })
      .catch(err => console.error('audio-files?dir=voices 读取失败，该组参考音频留空：', err))
    // 模型从 assets/ 的 meta.json 读（那是事实来源），不从 voices.json 读。
    // 另外拉内置的 Base 模型（GET /api/assets/__base__），好让它的预训练权重
    // 也能在这里被选到，用于零样本参考对比：它不在 /api/assets 的名单里。
    // 引擎名与位名都不写死：位名取自当前引擎的 weight_slots，别的引擎给什么位名就取什么位名，
    //   否则连文件选择器的扩展名都会被钉死，别的引擎的资产在这页里一个模型位都列不出来，
    //   而界面上只显示「这个音色没模型」，没有任何一句说「因为这里写死了引擎」。
    //
    //   每个角色的候选按全部权重位取笛卡尔积：任何一个位没有候选就不造组合，
    //   行自己退化成「用当前音色」，而不是画一个空下拉。
    //
    //   真正的「每行不同引擎并排」仍未实现（那要重画整行的混搭开关）。这里只是不再按引擎身份分叉。
    let droppedTotal = 0
    const buildModels = (vid, meta, out) => {
      const slots = slotsOf(engine)
      if (slots.length === 0) return
      const listsBySlot = {}
      for (const s of slots) {
        const list = modelsFromMeta(meta, engine?.id, s.name)
        if (list.length === 0) return
        listsBySlot[s.name] = list
      }
      const { combos, dropped } = modelCombos(slots, listsBySlot, MODEL_COMBO_LIMIT)
      droppedTotal += dropped
      for (const c of combos) {
        out.push({
          voiceId: vid,
          voiceName: meta.display_name || vid,
          language: meta.language || '',
          picks: c.picks,
          items: c.items,
          // 标出推荐的默认组合（Base 模型 → s1 + v2Pro），让音色下拉预先选中它。
          // 微调出来的音色不带这个标记，所以它是假值。
          default: slots.every(s => !!(c.items[s.name] && c.items[s.name].default)),
          builtin: !!meta.builtin,
          label: `${meta.display_name || vid} / ${slots.map(s => slotItemText(c.items[s.name])).join(' / ')}`,
        })
      }
    }
    Promise.all([
      api('/api/assets').catch(() => ({ ok: false })),
      api('/api/assets/__base__').catch(() => ({ ok: false })),
    ]).then(([r, rb]) => {
      const models = []
      // Base 模型排在最前，让它在音色下拉里位于顶部。
      if (rb.ok && rb.data && rb.data.ok && rb.data.meta) buildModels(BASE_VOICE_ID, rb.data.meta, models)
      if (r.ok) Object.entries(r.data.assets || {}).forEach(([vid, meta]) => buildModels(vid, meta, models))
      setAvailableModels(models)
      setModelComboDropped(droppedTotal)
    }).catch(() => {})
    // 依赖里必须有 engine.id：buildModels 按当前引擎的位名取权重。
    //   少了这一项 ⇒ 换引擎后这个下拉还是上一台引擎的权重，而且是安静地
    //   错，界面上没有任何一处会告诉你它没跟着换。
  }, [engine?.id])

  const addRow = (opts = {}) => {
    const rowId = nextId.current++
    // 默认模型：选中音色的第一个可用模型，没有就取全局第一个。
    const defaultModel = availableModels.find(m => m.voiceId === selectedVoice && m.default)
      || availableModels.find(m => m.voiceId === selectedVoice) || availableModels[0]
    const modelForRow = defaultModel
      ? { voiceId: defaultModel.voiceId, picks: { ...(defaultModel.picks || {}) }, owners: {}, mix: false }
      : { voiceId: '', picks: {}, owners: {}, mix: false }
    setRowModels(prev => ({ ...prev, [rowId]: modelForRow }))
    // 选中音色的第一条匹配切片作为默认参考（除非这一行明确要空行）。
    const firstSeg = segmentsCache[selectedVoice]?.find(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
    const defaultRef = (!opts.empty && firstSeg) ? (() => {
      const raw = firstSeg.audio || firstSeg.audio_path || firstSeg.audio_filename
      const fn = raw ? raw.replace(/\\/g, '/').split('/').pop() : ''
      return fn ? `assets/${selectedVoice}/slicer_opt/${fn}` : ''
    })() : ''
    // 内置的 Base 模型自己没有切片：这样的行从跨音色参考选择器起步，
    // 用户立刻就能借一条参考。
    const startSource = (defaultModel && defaultModel.voiceId === BASE_VOICE_ID) ? 'cross' : undefined
    const dp = defaultParams || {}
    // 参数值与 touched 由 CompareRow 按当前引擎的 param_schema 自己起步
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
      // 引擎批量三态：'inherit'（跟总开关）| 'on' | 'off'。
      engine_batch: 'inherit',
      // 这一行自己的读音校对状态（与其他行互不影响）。
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
    // 配方顶层只装得下两个权重字段（历史格式）：按参数名翻回名片上的位。
    const recipePicks = weightsFromParams(slotsOf(engine), {
      gpt_model: recipePath(rec.gpt_ckpt),
      sovits_model: recipePath(rec.sovits_pth),
    })
    setRowModels(prev => ({ ...prev, [row.id]: { voiceId: rec.role || selectedVoice, picks: recipePicks, owners: {}, mix: false } }))
  }

  const generateRow = async (row, batch) => {
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, loading: true, result: null, error: null } : r))
    // 状态栏的实时活动提示。批量运行由 generateAll 自己推进进度文案
    // （"Comparing · k/N"），单行重新生成显示普通的 "Generating"，结束后清掉。
    if (!batch) onActivity?.({ label: 'Generating' })
    const slots = slotsOf(engine)
    const rowModel = normalizeRowModel(rowModels[row.id])
    // 与生成页共享的 selectedVoice 解耦：这一行的音色、参考音频与所有语种默认值
    // 都由这一行自己的模型决定。用共享音色会让中文模型被自动按中文路由：
    // 送了 prompt_lang=zh 的日文参考音频，转写会错，声音也乱。
    // 混搭时参考音频与语种跟随名片里第一个能换的位（GSV 是 SoVITS），
    // 另一个位可以来自别的资产而不带走参考音频。
    const rowVoiceId = referenceVoiceOf(rowModel, slots, selectedVoice)
    const rowVoiceLang = availableModels.find(m => m.voiceId === rowVoiceId)?.language
      || voices.find(v => (v.id || v.voiceId) === rowVoiceId)?.language || 'ja'
    try {
      const body = {
        voice: rowVoiceId,
        text: row.text.trim() || defaultText,
        format: 'wav',
        // 和生成页同一件事：这一次要连哪台引擎，由界面上选中的那台
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
        //   web/src/lib/engines.js 的权威实现，生成页用的是同一个
        //   函数，不是新写一份）。
        ...paramsToSend(engine, row.params, row.touched),
        // 这一行走哪个推理方法。
        //   只交名字：方法内部怎么绑参数、要不要参考音频，是 host.py 的事，
        //   前端不复制那份规则（那是第二份会漂移的事实）。
        //   单方法引擎 methods 为 null ⇒ 不发这个键，让后端用名片上的固定入口。
        ...(row.method ? { method: row.method } : {}),
        seed: row.seed,
        // 这一行的引擎批量三态对着总开关解析。
        engine_batch: (row.engine_batch === 'on') ? true
          : (row.engine_batch === 'off') ? false
          : !!cmpEngineBatch,
      }
      // 批量打标：这一行属于「全部生成」时，盖上共享的批次 id，
      // 让后端把全部成员记成同一个对比批次。单行生成没有批次（那是独立一次）。
      if (batch && batch.id) {
        body.batch_id = batch.id
        body.batch_seq = batch.seq
        body.batch_total = batch.total
        body.batch_label = batch.label
      }
      // 权重位全部来自名片：有 param 的位按参数名平铺，launch 位交给平台。
      // 位名、参数名与个数都不写死，换一台引擎不需要改这里。
      const weightFields = weightRequestFields(slots, rowModel.picks)
      Object.assign(body, weightFields.params)
      if (Object.keys(weightFields.launch_weights).length > 0) body.launch_weights = weightFields.launch_weights
      // 每一行自己的目标语种（回落到共享默认，再回落到音色语种）；
      // prompt_lang / 参考转写来自跨音色或自定义的参考选择。
      body.text_lang = row.textLang || defaultTextLang || rowVoiceLang || 'ja'
      body.prompt_lang = row.promptLang || rowVoiceLang || 'ja'
      // Auto（多语种）：不含假名的 CJK 回落到这一行模型的语种。
      if (body.text_lang === 'auto_zh_ja_yue') body.auto_base_lang = rowVoiceLang || 'zh'
      if (row.promptText) body.reference_text = row.promptText
      // 读音校对是逐行的：每一行带自己的基础覆盖、逐字汉语言种强制与反查读音，
      // 所以校对不会在行之间串味。
      // 用共享对比文本（文本为空）且自己没做校对的行，回落到共享对比文本的覆盖，
      // 行内的永远优先。
      const usingDefaultText = !(row.text && row.text.trim())
      const rEff = body.text_lang
      const rDir = hanOverrideDirection(rEff, rowVoiceLang)
      const rPanel = normalizeLangFamily(rEff) || String(rowVoiceLang || '').replace(/^all_/, '') || 'ja'
      // body.text 就是这次请求要合成的那个字符串，所以存下来的 @N 下标
      // 只按它来剪。
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
      // 批量运行的状态栏提示由 generateAll 在整批结束后清掉。
      if (!batch) onActivity?.(null)
    }
  }

  const generateAll = async () => {
    // 一次「全部生成」 = 一个被记录下来的对比批次。先生成共享 id，
    // 让每个成员都落在同一个批次下，然后按顺序跑各行。
    const runnable = rows.filter(r => !r.loading)
    if (runnable.length === 0) return
    const batchId = `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const label = (defaultText || '').trim().slice(0, 80)
    const batch = { id: batchId, total: runnable.length, label }
    let seq = 0
    try {
      for (const row of runnable) {
        // 状态栏进度："Comparing · k/N" 随每个成员推进。
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
          <p style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', marginBottom: 10 }}>
            {t(
              <>Add as many rows as needed. Each row = a different reference audio configuration.
              Click <strong>Generate All</strong> to hear every combination side by side.
              The best one can be saved as the voice config.</>,
              <>可以添加任意多行，每行 = 一种不同的参考音频配置。点击 <strong>Generate All</strong> 即可并排试听所有组合，效果最佳的一项可保存为该音色的配置。</>)}
          </p>

          <div className="field">
            {/* 对比文本：每一行默认都用它，这样对比的是参考音频与模型；某一行可以在自己的 Text 区域里改写。 */}
            <label className="field-label">{t('Comparison Text', '对比文本')}</label>
            <div className="field-hint" style={{ marginBottom: 4 }}>
              {t(
                <>Every row uses this text by default, so references / models are compared on the same sentence. To give a row its own text, expand that row&apos;s <strong>Text</strong> section.</>,
                <>默认所有行都使用这段文本，以便在同一句话上对比参考音频 / 模型。若想让某一行使用自己的文本，可展开该行的 <strong>Text</strong> 区域。</>)}
            </div>
            <textarea className="control" rows={3} value={defaultText} onChange={e => setDefaultText(e.target.value)}
              placeholder="Enter the text used across all rows for comparison…" />
            <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {t('Default target language:', '默认目标语言：')}
                <Select
                  className="control" style={{ height: 22, fontSize: 'var(--fs-11)', padding: '0 4px', width: 'auto', minWidth: 0 }}
                  value={defaultTextLang} onChange={e => setDefaultTextLang(e.target.value)}
                >
                  {CMP_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </span>
            </div>
            {/* 对比文本的读音校对与逐字汉语言种，作用于所有没有自备文本的行；某一行自己的校对优先。通过共享的读音与语种弹窗设置。 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={() => setShowDefaultTextPrep(true)}>
                Proof &amp; language{'\u2026'}
              </button>
              {defaultHanDir && defaultHanForced.length > 0 && (
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--accent)' }}>{t(`${defaultHanForced.length} forced ${LANG_LABEL[defaultHanDir.reverse]}`, `已强制 ${defaultHanForced.length} 个字为 ${LANG_LABEL[defaultHanDir.reverse]}`)}</span>
              )}
              {Object.keys(defaultPronOverrides || {}).length > 0 && (
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--accent)' }}>{t(`${Object.keys(defaultPronOverrides).length} reading override(s)`, `${Object.keys(defaultPronOverrides).length} 处读音覆盖`)}</span>
              )}
              <span style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>{t('applies to every row that doesn\u2019t override its own text', '对所有未使用自有文本的行生效')}</span>
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
            <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', marginTop: 8 }}>
              {t(
                <>To proof a single row: expand that row&apos;s Text section and open its own <strong>Proof &amp; language</strong>.</>,
                <>也可以只校对单独一行：展开该行的 Text 区域，打开它自己的 <strong>Proof &amp; language</strong>。</>)}
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 'var(--fs-12)', cursor: 'pointer' }}
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
          {modelComboDropped > 0 && (
            <div className="field-hint" style={{ color: 'var(--warning)', fontSize: 'var(--fs-11)', marginTop: 6 }}>
              {t(
                `Model combinations are capped at ${MODEL_COMBO_LIMIT} per character; ${modelComboDropped} combinations were truncated.`,
                `每个角色的模型组合最多 ${MODEL_COMBO_LIMIT} 组，已截断 ${modelComboDropped} 组。`)}
            </div>
          )}
        </div>
      </div>

      {/* 行列表。 */}
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
          rowModel={rowModels[row.id] || { voiceId: '', picks: {}, owners: {} }}
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

      {/* 对比结果区。 */}
      {rows.length > 0 && !rows.some(r => r.result) && (
        <div className="empty-state" style={{ marginTop: 4, padding: 16 }}>
          <div className="es-sub" style={{ marginBottom: 0 }}>{t('Generated comparison results will appear here.', '生成的对比结果会显示在这里。')}</div>
        </div>
      )}

      {/* 批量历史：每一次「全部生成」记成一个对比批次。 */}
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
