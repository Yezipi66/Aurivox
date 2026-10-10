// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef, useMemo } from 'react'
import { Select } from '../common/Select'
import { usePersistentState } from '../../usePersistentState'
import { API_BASE, api } from '../../lib/api'
import { LANG_LABEL, TextPrepModal, buildLangOverrides, buildPronPayload, hanOverrideDirection, countOverrides, parseLangOverrides, pruneForced } from '../pron/PronProofing'
import { ConfirmDialog, SaveRecipeModal } from '../common/Dialogs'
import { IconFolder, IconPlay, IconRerun, IconTrash } from '../common/Icons'
import { AudioPlayer, Player } from '../common/Player'
import { AuxReferencePicker, CrossRefPicker, CustomRefPicker, refMatches } from '../common/RefPickers'
import { useAssetsWithModels } from '../../lib/models'
// 模型下拉的一切（有几个、里面装什么、选中的怎么发出去）都在这里。
// ⛔ 这个组件里不许再出现任何引擎名字或模型位名字。
import { slotsOf, candidatesForSlot, flattenGroups, itemLabel,
         reconcileSelection, weightsToSend, launchWeightsToSend, weightsFromParams,
         slotsNeedingRelaunch, voicesForEngine, modelNotesFor,
         describeGeneration } from '../../lib/modelPickers.pure.js'
import { REF_MAX_SEC, REF_MIN_SEC, TARGET_LANG_OPTIONS, VOICE_LANG_LABEL, basename, defaultTargetLang, effectiveBaseLang, fmtRecentTime, langLabel, normalizeLangFamily, outputsError, pickDefaultRef, refBasename, refInRange, sameRefPath, statusBadge } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { recipeToGenerateParams, weightsToRecipeFields } from '../../lib/recipes'
// ⚠ fieldLabel / fieldHelp / recipePath 曾经在这里 —— 三个写死的类型分支换成
//   <ParamField> 之后它们只在 ParamField 里用了，留着就是空引用。
import { fieldsForTier, schemaGap, initialParamValues, coerceParamValue, paramsToSend, paramsByPhase, hasMappedKey, isFieldVisible, TIERS } from '../../lib/engines'
import { ParamField, ToggleField } from '../common/ParamField'
import { useSelectSources } from '../../lib/useSelectSources'
import { optionsForField } from '../../lib/selectSources.pure'

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

function GenerateTab({ engine, voices, selectedVoice, setSelectedVoice, onEditVoice, onSwitchToCompare, onVoiceUpdate, selectedRefAudio, selectedRefText, selectedPromptLang, onSelectRef, onActivity }) {
  // ⚠ 这里必须叫 uiLang，不能叫 lang：这个文件里 `lang` 早就是**音色的语言**
  //   （合成时发给引擎的 prompt_lang），跟「界面显示中文还是英文」是两件事。
  //   参数格子的名字取哪一种语言，问的是后者。
  const { t, lang: uiLang } = useT()
  const [text, setText] = usePersistentState('generate.text', '')
  const [loading, setLoading] = useState(false)
  const [memoryRisk, setMemoryRisk] = useState(null)
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
  // 强制重新推理：跳过合成结果复用缓存的读。
  //
  // ⭐ 走 usePersistentState（浏览器本地），**不**进 /api/advanced-params。
  //   那个端点存的是**引擎参数表**，而这是平台自己的开关（一台引擎都没装
  //   的时候它依然有意义）—— 混进去正是契约 C11 禁止的第二份参数表，
  //   而且 loadAdvancedParams 是「盘上赢」，会把它变成所有调用方的默认值。
  //
  // ⚠ 默认 false：勾选是用户主动的动作，不勾就享受复用。
  //   面板默认折叠（下面 showAdvanced），所以勾上之后用户不一定看得见自己
  //   勾着 —— Owner 已判定这可接受（勾是他自己动的手），此处留痕备查。
  const [forceResynth, setForceResynth] = usePersistentState('generate.forceResynth', false)

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
  const [advTier, setAdvTier] = useState('common')

  // ============================================================
  //  引擎参数：一份字典，键名来自当前引擎的 manifest.json
  // ============================================================
  //
  // ⛔ 这里原本是 13 个写死的 useState（temperature / topK / topP /
  //    repPenalty / splitMethod / speedFactor / batchSize / batchThreshold /
  //    splitBucket / fragmentInterval / parallelInfer / sampleSteps /
  //    superSampling），下面还配着 13 段一模一样的 <input> ——
  //    那是一台引擎的参数表被手抄进了前端。装第二台引擎时，这 13 个名字
  //    没有一个对得上，界面照样把它们发出去（服务端静默忽略），
  //    真正该有的格子一个也长不出来。契约 §12 第 3 步要收的就是这个。
  //
  // 现在：面板长什么样、发哪些键，全部来自 engine.param_schema。
  //   ⚠ 只装引擎参数。平台自己的开关（force re-synthesis / engine batch /
  //     media type / seed）不在这里 —— 它们不属于任何一台引擎，见各自注释。
  const [paramValues, setParamValues] = useState({})
  // 用户亲手动过哪些格子。只有动过才发出去 ——
  // 「没动」和「设成了跟默认值一样的数」在请求体里必须长得不一样，否则
  // 平台无法区分「用户要这个值」和「用户没管」。
  const [touchedParams, setTouchedParams] = useState(() => new Set())

  // 换引擎（或第一次拿到引擎）⇒ 面板整个换成新引擎的格子和默认值。
  // ⛔ 不保留上一台引擎的值：键名可能撞车而含义完全不同。
  useEffect(() => {
    if (!engine) return
    setParamValues(initialParamValues(engine))
    setTouchedParams(new Set())
  }, [engine && engine.id])

  const setParam = (name, raw) => {
    const field = (engine?.param_schema || []).find(f => f.name === name)
    if (!field) return
    setParamValues(v => ({ ...v, [name]: coerceParamValue(field, raw) }))
    setTouchedParams(s => { const n = new Set(s); n.add(name); return n })
  }

  // 这个页面走 /api/generate，它等的是一份**做完的**音频（runGenerate 读的是
  // audio_url），消费不了流。所以只对流式输出有意义的那几个参数，在这一页上
  // 长出来也是摆设 —— 2026-08-23 就是因为这个把它们撤掉的（全文见下面 :145）。
  // ⛔ 这不是一份引擎名单，是**这个页面自己的能力声明**：换哪台引擎都成立。
  //    ⚠ 悬着的问题：这三个键名毕竟还是写在前端的。更干净的做法是让名片
  //      说清「这个参数只在流式路径上有意义」，但那要给 schema 加字段 ——
  //      没有裁决之前不擅自加。
  // 界面上要说出引擎名字的地方用它。⛔ 不退到任何一台引擎的名字 ——
  // 「还没读出来」说成某台引擎的名字，就是在撒谎（同 App.jsx:210 那处）。
  const engineName = engine?.label || engine?.id || t('the engine', '引擎')

  const STREAM_ONLY = ['streaming_mode', 'overlap_length', 'min_chunk_length']
  // ⭐ only_when 在这里就滤掉，⛔ 不留一个空的 <div> 占着格子 —— 否则
  //    .form-grid 会在两列里留下一个洞，看起来像「有一格没画出来」。
  //    isFieldVisible 是 fail-open：名片写了个不存在的键，照常显示。
  const visibleFields = (tier) => fieldsForTier(engine, tier)
    .filter(f => !STREAM_ONLY.includes(f.name))
    .filter(f => isFieldVisible(f, paramValues))

  // 平台自己的参数，不属于任何一台引擎，所以不进 param_schema。
  const [seed, setSeed] = useState(-1)
  const [mediaType, setMediaType] = usePersistentState('generate.mediaType', 'wav')
  // ⛔ 这里原本还有 streamingMode / overlapLength / minChunkLength 三个 state。
  //
  // 撤掉的理由不是「没用」，是**放错了地方**（2026-08-23 查实）：
  //   1. Workbench 走 /api/generate，它拿到音频后是普通 JSON 响应（runGenerate
  //      等的是 audio_url），**根本消费不了流** —— 这个界面上开「流式」开不出流式。
  //   2. 这三个键写进 advanced_params.json 后，本组件挂载时**从来不读回来**
  //      （挂载时那段 useEffect 只读 7 个键：temperature / top_k / top_p /
  //      repetition_penalty / text_split_method / speed_factor / seed）
  //      ⇒ 拧一次、刷新即丢。
  //   3. 它们唯一的真实去处是 /v1/audio/speech 的兜底（speechService 读 advParams）
  //      ⇒ 等于「藏在合成界面里的另一个端点的配置项」，名字、位置、反馈全在骗人。
  //   4. streaming_mode 还有真危害：/v1/audio/speech:84 判定要不要流式**只看
  //      req.body**，但存盘的 true 照样会进 payload ⇒ broker 不流、却告诉引擎流。
  //
  // 撤掉后的落点（已核对名片）：
  //   streaming_mode  在 manifest.defaults ⇒ 每次仍发 false（行为不变，且不再可能
  //                   被盘上的陈年 true 污染）
  //   overlap_length / min_chunk_length 只在 params.schema 里有 default（＝界面初值），
  //                   不在 defaults ⇒ 不再出现在 payload 里，与 OpenAI 口 / Flow 一致。
  //
  // ⚠ 撤的是**界面格子**，不是 API 能力：lib/services/synthesisService.js:107-109
  //   仍然解析这三个入参，第三方和 Flow 可以显式传（契约 §7 逃生门）。
  // A-1 engine-batch mode (1.0.6): hand the whole text to the engine in one call
  // so it splits + batches in parallel (batch_size), instead of the broker
  // synthesising each split segment sequentially. Produces a single audio (no
  // per-segment files). Off by default to preserve the current segmented output.
  const [engineBatch, setEngineBatch] = useState(false)

  useEffect(() => { api('/api/recipes').then(r => { if (r.ok) setRecipes(r.data?.recipes || []) }).catch(() => {}) }, [])

  // Load advanced params from backend.
  //
  // ⭐⭐⭐ 刀 A1/A2（2026-08-31）：这里过去是 `api('/api/advanced-params')`
  //   一个裸地址、依赖数组 `[]`（只在挂载时跑一次）。
  //   后端删掉 legacyDefault 之后，**不带 engine_id 就不再回落到任何一台名片**
  //   （`lib/routes/pron.js:17-22`）⇒ 不改这一行的后果是：真机上高级设置里
  //   所有"用户没拧过"的格子全部变空 —— 而且不报错。
  //
  // ⚠ 依赖数组从 `[]` 改成 `[engine?.id]`，这是**故意的行为变化**：
  //   默认值本来就属于那张名片，换一台引擎就该重新问一次。
  //   ⛔ 不许改回 `[]` —— 挂载那一刻 engine 往往还没加载完，
  //     那会退化成"永远拿不到默认值"。
  useEffect(() => {
    if (!engine?.id) return
    api(`/api/advanced-params?engine_id=${encodeURIComponent(engine.id)}`).then(r => {
      if (r.ok && r.data) {
        const p = r.data
        // 盘上存着的那份「上次拧到哪」。⛔ 只认当前引擎名片里有的键 ——
        // 这个文件是全局的（不分引擎），换引擎之后里面会留着上一台的键名，
        // 原样灌进去就等于把别人的参数发给这台引擎。
        setParamValues(prev => {
          const known = new Set((engine?.param_schema || []).map(f => f.name))
          const next = { ...prev }
          for (const [k, v] of Object.entries(p)) if (known.has(k)) next[k] = v
          return next
        })
        if (p.seed !== undefined) setSeed(p.seed)
      }
    }).catch(() => {})
  }, [engine?.id])

  // ══ 模型选择 ═══════════════════════════════════════════════════════════
  //
  // ⭐⭐ 2026-08-30 大改。这里以前写死着两个下拉（GPT / SoVITS）—— 那是第一台
  //   引擎的形状。结果第二台引擎装上了、名片也写了、界面上也能选，但在
  //   「有哪些模型可用」这份清单里一个入口都没有。
  //
  //   现在：**下拉有几个，是这台引擎的名片说的**；每个下拉里装什么，是
  //   「这台引擎的底模 ∪ 当前角色下这台引擎的模型」这个二维筛选说的。
  //
  // ⛔ 跨资产混搭没了（原来那个 "Mix models across assets" 开关）。挑别人的
  //   权重会把参考音频一起带走，用户看不见也管不着；而且它天然只对两个位的
  //   引擎成立。要用别人的模型，就切到那个角色去。
  const assetsWithModels = useAssetsWithModels()
  // 这台引擎有几个模型位（名片说的）。⛔ 名片没写 = 一个下拉都不长，不是两个。
  const weightSlots = useMemo(() => slotsOf(engine), [engine])
  // 这几个位换一份就得让引擎带着它重开一次 —— 界面要为此提醒一句"要多等"。
  const relaunchSlots = useMemo(() => slotsNeedingRelaunch(weightSlots), [weightSlots])
  // 每个位各自的候选（按角色分组，底模那一组永远在最前）。
  const groupsBySlot = useMemo(() => {
    const out = {}
    for (const s of weightSlots) {
      out[s.name] = candidatesForSlot(assetsWithModels, engine?.id, s.name, selectedVoice)
    }
    return out
  }, [weightSlots, assetsWithModels, engine, selectedVoice])
  // ⭐⭐ 音色下拉里该出现谁：底模 ∪「在这台引擎下每个位都有自己模型」的角色。
  //
  // ⛔ 只筛**下拉**，不筛 voices 本身 —— 底下那个「使用其他音色的参考音频」
  //    要能挑到所有角色。筛掉一个角色的意思是"这台引擎没有它的模型"，
  //    不是"这个角色不存在"。
  const voiceOptions = useMemo(
    () => voicesForEngine(voices, assetsWithModels, engine?.id, weightSlots),
    [voices, assetsWithModels, engine, weightSlots])

  // 换引擎之后，上一台引擎选中的角色可能已经不在下拉里了。
  // ⚠ 不收拾的话下拉会显示成空白，而 selectedVoice 还是老值 —— 看着没选，
  //   一按生成却按老角色发出去。回落到第一条（底模永远在）。
  useEffect(() => {
    if (!voiceOptions.length) return
    if (voiceOptions.some(v => v.id === selectedVoice)) return
    setSelectedVoice(voiceOptions[0].id)
  }, [voiceOptions, selectedVoice, setSelectedVoice])

  // 每个位当前选中的路径：{ 位名: 路径 }
  const [selWeights, setSelWeights] = useState({})
  // 持久化：每个 引擎 × 角色 各自记住上次每个位选了什么，刷新后只要还在候选里就恢复。
  // ⚠ 存的时候按 引擎id → 角色 → 位名 分三层，否则换引擎会把上一台的路径捡回来。
  // ⚠ 换了名字（原来叫 generate.modelChoice）：老浏览器里存着的是**两个位的老形状**，
  //   用同一个名字读出来会得到一坨对不上的数据。换名 ⇒ 老的自然作废，
  //   最多是"上次选的没记住"，不会把一条别的形状的路径摆到下拉里。
  const [modelChoice, setModelChoice] = usePersistentState('generate.modelChoice.byEngine', {})
  const modelChoiceRef = useRef(modelChoice)
  modelChoiceRef.current = modelChoice
  const generateAbortRef = useRef(null)

  // 平台已经扫到的所有模型文件，**不分位、不分引擎**，给 type: 'path' 的格子当候选。
  //
  // ⭐ 为什么不分：位名是各家引擎自己的说法，平台在这里只回答「我知道盘上有
  //    哪些模型文件」。哪个文件该填进哪一格，是引擎自己在名片里说清楚的事
  //    （靠那一格的 label / help），不是平台来配对。
  // ⚠ 这只是候选，不是限制 —— 那一格可以直接打字填绝对路径。
  const knownModelPaths = useMemo(() => {
    const all = []
    for (const a of (assetsWithModels || [])) {
      for (const byEngine of Object.values(a.models || {})) {
        for (const list of Object.values(byEngine || {})) {
          for (const m of (list || [])) {
            const p = typeof m === 'string' ? m : (m && m.path)
            if (p) all.push(p)
          }
        }
      }
    }
    return [...new Set(all)]
  }, [assetsWithModels])

  // 参考音频跟着当前角色走。
  // ⚠ 这里以前是「跟着 SoVITS 那一侧的模型所属角色走」—— 跨资产混搭没了之后
  //   这句话就不成立了，也不需要了：候选里根本不会出现别人的模型。
  const refVoiceId = selectedVoice

  // `select + source` 那种格子的候选表（voices / weights / audio）。
  // ⭐ 平台扫盘的结果在这里汇总一次，ParamField 只管画 —— 它不知道这三个库
  //    是什么，也不该知道。
  // ⛔⛔ 这一段**必须**放在 refVoiceId 声明之后。我第一版把它写在 :302，
  //     而 refVoiceId 是 :318 的 const ⇒ 暂时性死区，一进这一页就 ReferenceError
  //     白屏。沙箱里没有 node_modules，build 跑不了，这种错**只能靠读**。
  //     ⇒ 往这个函数体里插新的 const 时，先确认它依赖的每一个名字都在上面。
  const selectSources = useSelectSources({
    voices,
    knownModelPaths,
    audioVoiceId: refVoiceId,
  })
  const selectOptions = (f) => optionsForField(f, selectSources)
  // 当前这一套的一句话摘要：「角色 / 第一个位选的 / 第二个位选的 / …」。
  // ⭐ 位有几个就写几段 —— 以前这里写死两段。
  const selectedItems = useMemo(() => weightSlots.map(s => {
    const flat = flattenGroups(groupsBySlot[s.name] || [])
    return flat.find(x => x.path === selWeights[s.name]) || null
  }), [weightSlots, groupsBySlot, selWeights])
  const modelSummary = selected ? [
    selected.display_name || selected.id,
    ...selectedItems.map(it => it ? itemLabel(it) : null),
  ].filter(Boolean).join('  /  ') : ''
  // ⭐⭐ 后端对这个角色 × 这台引擎有没有话要说（放错了一层、目录名不是权重位名、
  //    有文件没被列进来……）。⛔ 前端不判断、不拼话：整句是后端生成的。
  //    这句话存在的唯一理由是：在它之前，「没有模型」和「放错了」在界面上
  //    长得一模一样，都是一个空下拉，且没有任何一处解释为什么。
  const modelNotes = useMemo(
    () => modelNotesFor(assetsWithModels, engine?.id, selectedVoice),
    [assetsWithModels, engine, selectedVoice])
  // ⭐ 选中的这几份里，有哪几份按名片点名的东西是**不齐**的。
  //   ⚠ 只收 false —— null 是"说不出来"（单文件的候选／名片没写 required），
  //     ⛔ 不许把"说不出来"画成"有问题"。
  const incompleteItems = useMemo(
    () => selectedItems.filter(it => it && it.complete === false),
    [selectedItems])
  const [lang, setLang] = useState(selected?.language || 'ja')
  // 目标合成语言（text_lang），独立于 prompt_lang；默认 = 微调源语言，切换音色时重置。
  const [textLang, setTextLang] = useState(() => defaultTargetLang(selected?.language || 'ja'))
  const _baseLangFam = String(lang || '').replace(/^all_/, '')
  const _targetFam = normalizeLangFamily(textLang)
  const langMismatch = !!_targetFam && _targetFam !== _baseLangFam   // 目标语言与微调语言不符
  const panelLang = _targetFam || _baseLangFam                        // 读音校对面板跟随目标语言
  const hanDir = hanOverrideDirection(textLang, lang)                 // #4: reverse-lang direction (or null)
  // The overrides are persisted but stored as absolute character indices, so
  // editing the text strands them: index 0 may now hold a kana. Prune on read
  // (below) AND heal the stored copy (effect), so the badge, the picker and the
  // request payload can never disagree about how many are in force.
  const hanForcedLive = useMemo(() => pruneForced(hanForced, text), [hanForced, text])
  useEffect(() => {
    if (hanForcedLive.length !== (hanForced || []).length) setHanForced(hanForcedLive)
  }, [hanForcedLive, hanForced, setHanForced])
  const langOverrides = buildLangOverrides(hanDir, hanForcedLive, text)   // #4: {char->lang} payload, pruned against the live text
  const pronPayload = buildPronPayload(pronOverrides, panelLang, hanDir, hanForcedLive, hanReadings) // #4: base + reverse readings
  const [auxRefs, setAuxRefs] = useState([])  // selected aux reference audio paths
  const [segments, setSegments] = useState([])  // loaded from API for aux ref picker

  // 换角色 / 换引擎时，先把上次记住的选择摆上去（还有没有效，交给下面那条对齐）。
  // ⚠ 记的时候是按 引擎 → 角色 分开记的，否则换引擎会把上一台的路径捡回来 ——
  //   那条路径在新引擎的候选里根本不存在，对齐时会被弹掉，看起来像"选择丢了"。
  useEffect(() => {
    if (!selectedVoice || !engine?.id) return
    const saved = (modelChoiceRef.current[engine.id] || {})[selectedVoice]
    if (saved && typeof saved === 'object') setSelWeights(saved)
    else setSelWeights({})
  }, [selectedVoice, engine && engine.id])

  // 参考音频 / 参考片段跟着当前角色走。
  useEffect(() => {
    if (!refVoiceId) { setSegments([]); return }
    api(`/api/assets/${refVoiceId}/segments`).then(r => {
      if (r.ok && r.data.segments) setSegments(r.data.segments.segments || [])
      else setSegments([])
    }).catch(() => setSegments([]))
  }, [refVoiceId])

  // 把每个位的选择跟候选对齐：还有效的留住，失效的换成默认/第一条。
  //
  // ⚠ 候选还没到齐（异步）时**不动**：否则清单从空变满的那一瞬间会把刚恢复的
  //   选择弹回第一条。这是原来两条对齐 effect 就有的守卫，一个字都不能少。
  // ⛔ 失效的必须换掉 —— 换了引擎之后留着上一台的路径，等于把别人的权重发出去。
  useEffect(() => {
    if (!weightSlots.length) return
    const ready = weightSlots.every(s => (groupsBySlot[s.name] || []).length > 0)
    if (!ready) return
    setSelWeights(prev => {
      const next = reconcileSelection(weightSlots, groupsBySlot, prev)
      const same = weightSlots.every(s => next[s.name] === prev[s.name])
      return same ? prev : next
    })
  }, [weightSlots, groupsBySlot])

  // 记住当前 引擎 × 角色 的选择。只在每个选择都还在候选里时才写入，
  // 避免切换的一瞬间把上一套的路径落到新的名下。
  useEffect(() => {
    if (!selectedVoice || !engine?.id || !weightSlots.length) return
    const allValid = weightSlots.every(s => {
      const v = selWeights[s.name]
      if (!v) return false
      return flattenGroups(groupsBySlot[s.name] || []).some(x => x.path === v)
    })
    if (!allValid) return
    setModelChoice(prev => {
      const byEngine = prev[engine.id] || {}
      const cur = byEngine[selectedVoice] || {}
      const next = {}
      for (const s of weightSlots) next[s.name] = selWeights[s.name]
      const same = weightSlots.every(s => cur[s.name] === next[s.name]) &&
                   Object.keys(cur).length === Object.keys(next).length
      if (same) return prev
      return { ...prev, [engine.id]: { ...byEngine, [selectedVoice]: next } }
    })
  }, [selectedVoice, engine && engine.id, weightSlots, selWeights, groupsBySlot])

  // 语言跟着当前角色。
  // ⚠ 这里以前还有第二条 effect，让 prompt_lang 跟着「SoVITS 那一侧模型所属的
  //   角色」走 —— 那是跨资产混搭的配套。混搭没了，模型必属当前角色，
  //   refVoiceId 恒等于 selectedVoice，那条 effect 永远不会触发 ⇒ 删掉。
  useEffect(() => {
    const v = voices.find(x => x.id === selectedVoice)
    if (v?.language) { setLang(v.language); setTextLang(defaultTargetLang(v.language)) }
  }, [selectedVoice, voices])

  // Advanced params are global (from /api/advanced-params), not per-voice — no sync needed on voice change

  // 选中的模型如果带着版本号，就查一下那一版的底模在盘上齐不齐（缺了会出电流声）。
  //
  // ⭐ 判据从「SoVITS 那个位」改成「**任何一个**带版本号的选择」：版本号是扫盘
  //   时认出来的一个可选属性，谁带就查谁。别的引擎的模型不带版本号 ⇒ 不查，
  //   也不需要为它写一条分支。⛔ 这里不许再出现任何一个具体位的名字。
  const [genBaseWarn, setGenBaseWarn] = useState(null);
  const versionInUse = selectedItems.find(it => it && it.version)?.version || '';
  useEffect(() => {
    const ver = versionInUse;
    if (!ver || ver === 'v1') { setGenBaseWarn(null); return; }
    let cancelled = false;
    api(`/api/models/status?version=${encodeURIComponent(ver)}`)
      .then(r => { if (!cancelled) setGenBaseWarn(r.ok && r.data && !r.data.ok ? r.data : null); })
      .catch(() => { if (!cancelled) setGenBaseWarn(null); });
    return () => { cancelled = true; };
  }, [versionInUse]);

  // Clear any live activity indicator when leaving the Generate tab.
  useEffect(() => () => onActivity?.(null), [])

  useEffect(() => {
    if (!selectedVoice) return
    // ⭐ 点名当前引擎：问的是「**这台**引擎开工要的东西齐没齐」。
    //   ⛔ 不点名会把装着的每一台都答一遍 —— 那是给别的界面用的，不是这里。
    const q = engine?.id ? `?engine_id=${encodeURIComponent(engine.id)}` : ''
    api(`/api/voices/${selectedVoice}/validate${q}`).then(r => {
      if (r.ok && r.data.ok) setValidation(r.data.checks)
    }).catch(() => setValidation(null))
  }, [selectedVoice, voices, engine?.id])

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
    const t = typeof body.text === 'string' ? body.text : ''
    const willSplit = !!body.split && t.length > (body.max_chars || 30)
    const estChunks = Math.max(1, Math.ceil(t.length / Math.max(1, body.max_chars || 30)))
    onActivity?.({ label: willSplit ? `Generating · ${estChunks} chunks` : 'Generating' })
    const ctrl = new AbortController()
    generateAbortRef.current = ctrl
    try {
      const r = await api('/api/generate', { method: 'POST', body, signal: ctrl.signal })
      if (!r.ok && r.data?.code === 'ENGINE_MEMORY_CONFIRM_REQUIRED' && !body.memory_risk_confirmed) {
        setMemoryRisk({ body, meta, message: r.data.message, details: r.data.details || {} })
        return null
      }
      if (!r.ok) throw new Error(r.data?.message || r.data?.error || `Server error ${r.status}`)
      setResult(r.data)
      if (r.data.audio_url) { loadRecent() }
      return r.data
    } catch (err) { setError(err.message); return null }
    finally { setLoading(false); onActivity?.(null) }
  }

  const handleCancelGenerate = useCallback(() => {
    if (generateAbortRef.current) {
      generateAbortRef.current.abort()
      generateAbortRef.current = null
    }
    setLoading(false)
    onActivity?.(null)
  }, [onActivity])

  const cancelMemoryRisk = () => setMemoryRisk(null)
  const continueMemoryRisk = () => {
    const pending = memoryRisk
    setMemoryRisk(null)
    if (!pending) return
    runGenerate({ ...pending.body, memory_risk_confirmed: true }, pending.meta)
  }

  const handleGenerate = async () => {
    if (!selectedVoice) { setError('Select a voice first'); return }
    // Only the truly empty string is invalid. Whitespace is meaningful to some
    // TTS engines (for example as an intentional pause), so never trim here.
    if (text === '') { setError('Enter text to synthesize'); return }
    const explicitEngineParams = paramsToSend(engine, paramValues, touchedParams)
    const phasedEngineParams = paramsByPhase(engine, paramValues, touchedParams)
    const body = {
      voice: selectedVoice, text, format: 'wav',
      ref_audio: currentRefAudio || undefined,
      reference_text: effectiveRefText || undefined,
      split: splitEnabled, max_chars: maxChars,
      concat: concatEnabled, silence_ms: silenceMs,
      // 引擎参数：只发这台引擎名片里有的键，且只有用户动过的才发。
      // ⛔ 名片没写的键一个都不发 —— 服务端会静默忽略，症状是
      //    「我明明调了却没效果」，最难查的那一类。
      // ⭐⭐⭐ 这一次要连哪台引擎 —— 由**界面上选中的那台**说了算。
      //   ⛔ 少了这一句的后果就是这一刀要修的那个 bug：请求不点名，
      //     服务端就去名片里找 legacy_default 那台认领（见
      //     lib/engines/legacyDefault.js）。于是界面按 A 引擎画格子、
      //     按 A 引擎发参数、按 A 引擎选权重，请求却打到 B 引擎身上，
      //     用户看到的是 B 引擎的原话「tts failed」。
      //   ⛔ 也不许写成 `engine?.id || '某个默认值'` —— 引擎没选出来时
      //     要空着让服务端报「你没说连哪台」，而不是替用户挑一台。
      engine_id: engine?.id,
      // 这台引擎的参数格子。⭐ 点名了引擎，就把参数装进**它自己那一格**，
      //   服务端据此核对「你发的这袋参数是不是这台引擎的」。
      //   平铺那一份（下一行）是老路径还在读的形状，暂时并存。
      engine_params: engine?.id ? { [engine.id]: phasedEngineParams.call } : undefined,
      engine_load_params: engine?.id && Object.keys(phasedEngineParams.load).length
        ? { [engine.id]: phasedEngineParams.load }
        : undefined,
      ...phasedEngineParams.call,
      seed,
      engine_batch: engineBatch,
      media_type: mediaType,
      // 选中的模型：用哪个参数名发，是**这台引擎的名片**说的。
      // ⛔ 名片没说的位一个字节都不发 —— 那台引擎运行中换不了权重，
      //    发一个它不读的键不会报错，只会让人以为换了而声音没变。
      ...weightsToSend(weightSlots, selWeights),
      // ⭐⭐⭐ 开进程那一刻才吃得进去的那些模型，选择走这一个平台级的键。
      //   它不是引擎参数（引擎那道出门关也会把它拦下），收件人是平台：
      //   平台拿它决定要不要带着这一份把引擎重开一次。
      //   ⛔ 少了这一句的后果就是这一刀要修的那个 bug ——
      //     下拉能选、后端连"你选过"都看不见、声音没变、而且不报错。
      launch_weights: launchWeightsToSend(weightSlots, selWeights),
      text_lang: textLang, prompt_lang: selectedPromptLang || lang,
      // Auto (Multilingual): kana-free CJK falls back to the voice's metadata language.
      auto_base_lang: textLang === 'auto_zh_ja_yue' ? (selected?.language || lang || undefined) : undefined,
      aux_ref_audio_paths: auxRefs.length > 0 ? auxRefs : undefined,
      pron_overrides: pronPayload,
      lang_overrides: langOverrides,
      source: 'generate', voice_label: selected?.display_name || selectedVoice,
      // 平台开关，不是引擎参数：只在这一次请求里有效，服务端也不会把它存进 recipe
      // （否则 Rerun 会被永久钉成强制重推）。
      force_resynth: forceResynth,
    }
    const data = await runGenerate(body, { voiceLabel: selected?.display_name || selectedVoice })
    if (data) {
      // 成功合成后回存「上次拧到哪」。
      //
      // ⭐⭐ 只存**读得回来的键**。原来这里存 18 个，而全前端只读得回 7 个
      //    （本组件 :163 起、ReferenceCompareTab:737-743，两处用的正是同一组 7 个）。
      //    另外 11 个是**只写不读**，它们唯一的去处是 /v1/audio/speech 的兜底
      //    —— 而 loadAdvancedParams() 是 { ...名片默认值, ...盘上文件 }，**盘上赢**。
      //
      //    后果是实测出来的：盘上文件盖掉了 6 个名片默认值，包括
      //      batch_size 名片 4 → 盘上 1     （用户从没在界面上碰过这一格，
      //                                      是这里后台悄悄写进去的）
      //      seed       名片 -1 → 盘上 2769901998
      //                                     （某次合成 resolve 出的一次性随机种子
      //                                      被回存成了永久默认值）
      //      version v2Pro→v2 / is_half true→false（**启动期**设置被合成参数文件盖掉）
      //    ⇒ 契约 C11 的默认值在真机上等于失效。收窄到 7 个之后，用户没拧过的键
      //      盘上不再有，自动退回名片 —— 名片才是默认值的唯一产地。
      //
      // ⚠ 第 10 步（前端按 param_schema 循环渲染）会把这张表也改成名片驱动，
      //   届时判据是「这一格在界面上存在」，不再是写死的键名。
      // 只回存用户**亲手动过**的格子 + seed。
      // ⛔ 不回存整份 paramValues：没动过的键回存下去就等于把名片默认值
      //    抄进盘上文件，从此名片改了也不生效（:460 那一段实测过的坑）。
      api('/api/advanced-params', {
        method: 'POST',
        body: {
          ...Object.fromEntries(
            Object.entries(paramValues).filter(([k]) => touchedParams.has(k))),
          seed,
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
    // 历史条目里存的是当时那台引擎的参数。回填时只认当前引擎名片里有的键，
    // 并且标成「动过」—— 用户明确要求重放这一条，那就是他要的值。
    // ⛔ 认不出的键直接丢：换引擎之后老条目里的键名对不上，硬塞会发出去。
    {
      const known = new Map((engine?.param_schema || []).map(f => [f.name, f]))
      const picked = {}
      const hit = []
      for (const [k, v] of Object.entries(p)) {
        if (!known.has(k)) continue
        picked[k] = coerceParamValue(known.get(k), v)
        hit.push(k)
      }
      if (hit.length > 0) {
        setParamValues(prev => ({ ...prev, ...picked }))
        setTouchedParams(s => { const n = new Set(s); for (const k of hit) n.add(k); return n })
      }
    }
    if (p.seed !== undefined) setSeed(p.seed)
    // ⛔ if_sr 原本在这里单独回填一次。现在它是名片里的普通一格，
    //    上面那个循环已经收了 —— 留着会写进一个不再存在的 state。
    if (p.media_type !== undefined) setMediaType(p.media_type)
    // streaming_mode / overlap_length / min_chunk_length 的格子已撤（见 :134 注释）。
    // 老历史记录里可能还存着这三个键，回填时直接忽略 —— 没有格子可以放它们了。
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
      setHanForced(parseLangOverrides(p.lang_overrides))
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
    // 从那一次实际发出去的参数里，把每个位当时选的模型认回来。
    //
    // ⭐ 认的依据是**名片说这个位走哪个参数名** —— 反查一次即可，位有几个就
    //    认几个。没写参数名的位当时本来就没发出去，自然也认不回来（那台引擎
    //    的权重是启动时定的，重跑时装的是哪一份由它自己决定）。
    // ⛔ 这里以前靠路径长相倒推「这份权重是谁的」来还原跨资产混搭。混搭没了，
    //    倒推也一起没了 —— 路径本身仍然是发给引擎的那个事实来源。
    const restored = weightsFromParams(weightSlots, p)
    setTimeout(() => {
      if (Object.keys(restored).length) setSelWeights(prev => ({ ...prev, ...restored }))
      if (p.prompt_lang !== undefined) setLang(p.prompt_lang)
      if (p.text_lang !== undefined) setTextLang(p.text_lang)
      onSelectRef?.(p.ref_audio || '', p.reference_text || '', p.prompt_lang || '')
    }, 0)
  }

  const loadRecipeIntoGenerate = () => {
    const recipe = recipes.find(r => r.id === loadRecipeId)
    if (!recipe) return
    setError(null)
    // 传引擎 id：配方里每台引擎的参数各有一格，不说是哪台就只能退到
    // 配方自己记的那台（老配方连那个都没有）。
    handleReload({ params: recipeToGenerateParams(recipe, text, engine?.id || '') })
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
      <ConfirmDialog
        open={!!memoryRisk}
        title={t('System memory risk', '系统内存风险')}
        message={memoryRisk ? (
          <>
            <div>{memoryRisk.message}</div>
            <div style={{ marginTop: 10 }}>
              {memoryRisk.details.historical_peak_mb != null && <div>{t('Historical peak', '历史峰值')}: {memoryRisk.details.historical_peak_mb} MB</div>}
              {memoryRisk.details.required_mb != null && <div>{t('Estimated with headroom', '包含余量的估算')}: {memoryRisk.details.required_mb} MB</div>}
              {memoryRisk.details.free_mb != null && <div>{t('Currently available', '当前可用')}: {memoryRisk.details.free_mb} MB</div>}
            </div>
          </>
        ) : null}
        confirmLabel={t('Try this time', '本次仍然尝试')}
        cancelLabel={t('Cancel', '取消')}
        onConfirm={continueMemoryRisk}
        onCancel={cancelMemoryRisk}
      />
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
                    {voiceOptions.map(v => <option key={v.id} value={v.id}>{voiceOptionLabel(v)}</option>)}
                    {voiceOptions.length === 0 && <option value="">{t('No voices available', '没有可用的音色')}</option>}
                  </Select>
                </div>
                {/* ⭐⭐ 下拉有几个，是这台引擎的名片说的 —— 这里一个引擎名字都
                    不许出现。名片没写模型位 ⇒ 一个下拉都不长（不是长两个）。
                    每个下拉里按角色分组，底模那一组由候选计算排在最前。 */}
                {weightSlots.map(s => {
                  const groups = groupsBySlot[s.name] || []
                  if (!groups.length) return null
                  return (
                    <div className="gen-model-col" key={s.name}>
                      <label className="field-label" title={s.help || ''}>{s.label || s.name}</label>
                      <Select className="control" value={selWeights[s.name] || ''}
                        onChange={e => setSelWeights(prev => ({ ...prev, [s.name]: e.target.value }))}>
                        {groups.map(g => (
                          <optgroup key={g.voiceId} label={g.displayName}>
                            {g.items.map(c => (
                              <option key={c.path} value={c.path}>{itemLabel(c)}</option>
                            ))}
                          </optgroup>
                        ))}
                      </Select>
                    </div>
                  )
                })}
              </div>
              {modelSummary && (
                <div className="gen-model-summary" title={modelSummary}>{modelSummary}</div>
              )}
              {/* ⭐⭐⭐ 这句话以前写的是「在这里切换不会生效」—— 那是实话，但它
                  描述的是一个 bug，不是一个特性：能点、点完什么都不发生的下拉，
                  比不给选更糟。现在平台会带着选中的那一份把引擎重开一次，所以
                  它**真的生效了**，代价是要等。⇒ 这里改成说清那个代价。
                  ⛔ 别退回上一版文案：那等于把已经修好的功能重新说成坏的。 */}
              {relaunchSlots.length > 0 && (
                <div className="field-hint" style={{ marginTop: 4 }}>
                  {t('Changing the model above restarts this engine with it — the first generation after a change takes longer while the model loads.',
                     '在上面换模型会让这台引擎带着它重新启动一次 —— 换过之后的第一次生成要多等一会儿，等它把模型装进内存。')}
                </div>
              )}
              {/* ⭐⭐⭐ 2026-08-30：盘上放了模型、下拉却是空的，而且没有一个字解释
                  为什么 —— 「这个角色没有模型」「放错了一层」「目录名不是权重位名」
                  三件事在界面上长得一模一样。静默是这个仓库最难查的一种坏法。
                  ⛔ 这里**不加指示灯**（顶栏那笔账刚清过）：话说在它出问题的
                     那个下拉旁边，看完就没用了，不该占一个常驻格子。
                  ⛔ 前端不判断也不拼话：整句是后端生成的，它才知道名片写了什么。 */}
              {modelNotes.map((n, i) => (
                <div className="field-hint" key={`${n.engine}-${n.code}-${i}`}
                     style={{ marginTop: 4, color: 'var(--warn, #d08700)' }}>
                  {n.text}
                </div>
              ))}
              {incompleteItems.map((it, i) => (
                <div className="msg msg-error" key={`missing-${it.path}-${i}`}
                     style={{ marginTop: 4, color: 'var(--danger, #d05353)' }}
                     title={(it.missing || []).join('\n')}>
                  {it.missing_text}
                </div>
              ))}
            </div>

            <div className="field">
              <label className="field-label">Text</label>
              <textarea
                className="control" rows={5} placeholder={t('Enter text to synthesize...', '输入要合成的文本…')}
                value={text} onChange={e => { setText(e.target.value); }}
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span>Characters: <span style={{ color: 'var(--text)' }}>{text.length}</span></span>
                {splitEnabled && (
                  <span>Estimated chunks: <span style={{ color: 'var(--text)' }}>{Math.max(1, Math.ceil(text.length / Math.max(1, maxChars)))}</span></span>
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
                  Proof &amp; language{'…'}
                </button>
                {hanDir && hanForcedLive.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--accent)' }}>{hanForcedLive.length} Han override(s)</span>
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
                  hanDirection={hanDir} hanForced={hanForcedLive} setHanForced={setHanForced}
                  hanReadings={hanReadings} setHanReadings={setHanReadings}
                  engineId={engine?.id}
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
                  {/* Tier tabs —— 档位也来自名片（TIERS），不是写死两个按钮 */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                    {TIERS.map(tier => (
                      <button key={tier} type="button" className="btn btn-sm" onClick={() => setAdvTier(tier)}
                        style={{ background: advTier === tier ? 'var(--accent)' : 'var(--surface)', color: advTier === tier ? '#fff' : 'var(--muted)', textTransform: 'capitalize' }}>
                        {tier}
                      </button>
                    ))}
                  </div>

                  {/* 名片里一个参数都没描述时，说清是哪一种「没有」。
                      ⛔ 静默画一个空面板会让人以为这台引擎调不了 —— 真机上
                         确实有 param_keys 有 12 个、params.schema 却是空的引擎。 */}
                  {(() => {
                    const gap = schemaGap(engine)
                    return gap ? (
                      <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>{gap.message}</div>
                    ) : null
                  })()}

                  {/* ⬇ 这里原本是两档共 13 个写死的 <input>。全部换成按
                      engine.param_schema 循环 —— 装一台谁都没见过的引擎，
                      这段代码一个字都不用改（契约 §11 判据 9）。 */}
                  {TIERS.map(tier => advTier === tier && (
                    <div className="form-grid" key={tier}>
                      {/* ⭐ 五种预设样式全部走同一个 <ParamField>。
                          ⛔ 这里不许再出现 f.type === '...' 的分支：一旦分叉，
                             「换一台引擎，同一种参数长得不一样」就会回来，而且
                             以后生成出来的每台引擎的页面还会各自再抄一份。
                          候选项（select + source）由 selectOptions 扫盘给进来 ——
                          ParamField 不知道 voices/weights/audio 是什么。 */}
                      {visibleFields(tier).map(f => (
                        <ParamField key={f.name}
                          field={f}
                          values={paramValues}
                          onChange={setParam}
                          lang={uiLang}
                          options={selectOptions(f)}
                          t={t} />
                      ))}


                      {/* ⬇ 平台自己的开关。它们**不属于任何一台引擎**，所以不在
                          param_schema 里，也就不能跟着上面那个循环长出来。
                          判据很简单：换一台引擎，这几格的含义一个字都不变。 */}
                      {tier === 'common' && (
                        <div>
                          <label className="field-label">Seed (-1 = random)</label>
                          <input type="number" className="control" value={seed} onChange={e => setSeed(parseInt(e.target.value) || -1)} />
                        </div>
                      )}
                      {tier === 'common' && (
                        <div>
                          {/*
                            强制重新推理。放 Common 档是 Owner 定的（"比较基础"）。
                            ⚠ 它与同排其它格子**不是一类东西**：那些是引擎参数，会存进
                              /api/advanced-params；这一个是平台开关，存在浏览器本地
                              （generate.forceResynth），绝不进引擎参数表 —— 详见
                              状态声明处的注释。
                          */}
                          {/* ⭐ 走 ToggleField —— 跟名片长出来的那些勾选框是**同一个组件**。
                              ⛔ 不要在这儿手写 <input type="checkbox">：那正是
                                「一个左上一个右下」的来历（见 ToggleField 的注释）。 */}
                          <ToggleField
                            label={t('Force re-synthesis', '强制重新推理')}
                            help={t('Ignore cached audio and re-run inference', '忽略缓存音频，重新跑一遍推理')}
                            checked={forceResynth}
                            onChange={setForceResynth} />
                        </div>
                      )}
                      {tier === 'advanced' && (
                        <div title={t('Engine batch: send the whole text to the engine in ONE call and let the engine split and batch it itself, instead of the platform synthesising each segment one by one. Faster for long text; produces a single audio file with no per-segment files.', '引擎批量：整段文本一次性交给引擎，由引擎自己切分并批量推理，而不是由平台逐段合成。长文本更快；输出为单个音频、无分段文件。')}>
                          <ToggleField
                            label={t('Engine Batch (parallel)', '引擎批量并行')}
                            checked={engineBatch}
                            onChange={setEngineBatch} />
                        </div>
                      )}
                      {tier === 'advanced' && (
                        <div>
                          <label className="field-label">Media Type</label>
                          <Select className="control" value={mediaType} onChange={e => setMediaType(e.target.value)}>
                            <option value="wav">WAV</option>
                            <option value="ogg">OGG</option>
                            <option value="aac">AAC</option>
                            <option value="raw">RAW</option>
                          </Select>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Streaming Mode / Overlap Length / Min Chunk Length 三个格子
                      已于 2026-08-23 撤除 —— 它们配的是 /v1/audio/speech 的行为，
                      却长在一个消费不了流的界面上，且存了从不读回。理由全文见 :134。
                      名片里仍然写着这三个参数（引擎确实支持），由上面的
                      STREAM_ONLY 拦在这一页之外。 */}

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

                  {/* ⛔ 这句话原本写死「发送给 GPT-SoVITS」。换一台引擎它还是那么说 ——
                      界面公然告诉用户参数发去了一台他没选的引擎。名字问 engine 要。 */}
                  <div className="field-hint" style={{ marginTop: 6 }}>
                    {t(`These parameters are sent to ${engineName} for this generation only. They do not change the voice config.`,
                       `这些参数仅用于本次生成并发送给 ${engineName}，不会更改语音配置。`)}
                  </div>

                  {/* Auxiliary Reference Audio — shared AuxReferencePicker (Patch #11):
                      This voice (Slices/Raw) · Another voice · Custom files, multi-select
                      + audio preview. Identical interaction to Compare Refs.

                      ⭐ 这一格是**平台的词**（aux_reference_audio），不是引擎参数，
                        所以它不在 param_schema 里、不跟着上面那个循环长。它的开关
                        在名片 maps 上：铺了映射才发得出去。
                      ⛔ 之前无条件画：真机上 indextts2 的 maps 没有这一条，用户
                        照样选得出一堆辅助参考音频，然后它们被静默丢掉。 */}
                  {hasMappedKey(engine, 'aux_reference_audio') && (
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
                  )}
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
              {loading && (
                <button className="btn btn-sm" onClick={handleCancelGenerate}>
                  {t('Cancel', '取消')}
                </button>
              )}
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
                // 这台配方是给哪台引擎存的。⛔ 不填的话后端只能把参数收进
                // 一个叫 _unassigned 的占位格，下次开就未必认得回来。
                engine_id: engine?.id || '',
                // ⭐ 引擎自己的参数存进它自己的格子，原样存原样取，平台不认识
                //    里面任何一个键名。换一台引擎，这里存的就是那台的参数。
                engine_params: engine?.id
                  ? { [engine.id]: paramsToSend(engine, paramValues, touchedParams) }
                  : {},
                params: {
                  // PA: pin the full inference contract so the recipe reproduces
                  // the exact audition when distributed via /v1/audio/speech.
                  // ⚠ 这一份是**给老配方和老前端留的兼容底**：后端仍按 v3 的键集
                  //    往 params 里写一份。真正权威的是上面的 engine_params。
                  ...paramsToSend(engine, paramValues, touchedParams),
                  seed,
                  aux_ref_audio_paths: auxRefs.length > 0 ? auxRefs : [],
                  pron_overrides: (Object.keys(pronOverrides).length > 0) ? pronOverrides : {},
                  lang_overrides: langOverrides || {},
                  han_readings: (hanDir && Object.keys(hanReadings).length > 0)
                    ? Object.fromEntries(Object.entries(hanReadings).filter(([key]) => hanForcedLive.some(x => x && typeof x === 'object' && key === `@${x.index}:${x.char}`)))
                    : {},
                  auto_base_lang: textLang === 'auto_zh_ja_yue' ? (selected?.language || lang) : undefined,
                },
                // 配方顶层那两个权重字段。⚠ 配方格式这轮不动 ⇒ 这两个字段只装得下
                //    两个位、而且名字是第一台引擎的形状。哪个位落进哪个字段的知识
                //    收在配方那个文件里一处，这里不重复。⚠ 配方升级时改那一处即可。
                ...weightsToRecipeFields(weightsToSend(weightSlots, selWeights)),
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
              {result.warning && <div className="msg msg-warn" style={{ marginTop: 8 }}>{result.warning}</div>}
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
                      {/* ⭐⭐ 这里以前是写死的 `GPT {item.gpt} / SoVITS {item.sovits}` ——
                          跑 IndexTTS2 也照样印「GPT - / SoVITS -」，两个它没有的位。
                          现在整段由 describeGeneration 按后端存下的位表拼，位名、
                          位数、引擎名全部来自名片。⛔ 这里不许再出现任何位名。 */}
                      {item.voice} · {langLabel(item.lang)}
                      {describeGeneration(item) ? ` · ${describeGeneration(item)}` : ''}
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
            {/* ⭐⭐⭐ 刀 3：这里过去写死两行「GPT Model / SoVITS Model」——
                那是一台引擎的零件清单被抄进了平台。换一台引擎，这两行要么
                恒为红叉（它其实什么都不缺），要么答非所问（IndexTTS2 只有
                一个位，界面却追问它 SoVITS 在不在）。
                现在：**几行、叫什么，是这台引擎的名片说的**，前端一个位名
                都不认识 —— 后端 /api/voices/:id/validate 直接给 slots[]。
                ⛔ 别再往这里加任何具体名字。 */}
            <div className="validity-list">
              {(validation.slots || []).map(s => (
                <div className="validity-row" key={`${s.engine_id}:${s.name}`}>
                  <span>{s.label || s.name}</span>{statusBadge(s.present)}
                </div>
              ))}
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
