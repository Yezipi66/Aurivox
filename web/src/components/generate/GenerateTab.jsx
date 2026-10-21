// 合成页：文本、音色与模型选择、参考音频、引擎参数面板、生成与最近生成。
// 引擎参数与模型下拉都来自当前引擎的 manifest.json，文件里不写引擎名、参数名或位名。
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Select } from '../common/Select'
import { usePersistentState } from '../../usePersistentState'
import { api } from '../../lib/api'
import { TextPrepModal, buildLangOverrides, buildPronPayload, hanOverrideDirection, countOverrides, parseLangOverrides, pruneForced } from '../pron/PronProofing'
import { ConfirmDialog, SaveRecipeModal } from '../common/Dialogs'
import { IconRerun, IconTrash } from '../common/Icons'
import { useAssetsWithModels } from '../../lib/models'
// 模型下拉的算法都在 modelPickers.pure.js：这个组件只管画。
import { slotsOf, candidatesForSlot, flattenGroups, itemLabel,
         reconcileSelection, weightsToSend, launchWeightsToSend, weightsFromParams,
         slotsNeedingRelaunch, voicesForEngine, modelNotesFor } from '../../lib/modelPickers.pure.js'
import { TARGET_LANG_OPTIONS, defaultTargetLang, normalizeLangFamily } from '../../lib/langOptions'
import { outputsError } from '../../lib/apiError'
import { pickDefaultRef, sameRefPath } from '../../lib/refAudio'
import { useT } from '../../lib/i18n'
import { recipeToGenerateParams, weightsToRecipeFields } from '../../lib/recipes'
// fieldLabel / fieldHelp / recipePath 不在这里：换成 <ParamField> 之后它们只在那边用了。
import { fieldsForTier, initialParamValues, coerceParamValue, paramsToSend, paramsByPhase, hasMappedKey, isFieldVisible } from '../../lib/engines'
import { useSelectSources } from '../../lib/useSelectSources'
import { optionsForField } from '../../lib/selectSources.pure'
import { CollapsibleSegments } from './GenerateBits'
import { VoiceSidebar } from './VoiceSidebar'
import { GenerationResult, RecentGenerations } from './RecentGenerations'
import { AdvancedParamsPanel } from './AdvancedParamsPanel'
import { ModelPickRow } from './ModelPickRow'

function GenerateTab({ engine, voices, selectedVoice, setSelectedVoice, onEditVoice, onSwitchToCompare, onVoiceUpdate, selectedRefAudio, selectedRefText, selectedPromptLang, onSelectRef, onActivity }) {
  // 这里必须叫 uiLang，不能叫 lang：这个文件里 lang 是音色的语言（合成时发给引擎的
  // prompt_lang），跟「界面显示中文还是英文」是两件事。参数格子的名字取后者。
  const { t, lang: uiLang } = useT()
  const [text, setText] = usePersistentState('generate.text', '')
  const [loading, setLoading] = useState(false)
  const [memoryRisk, setMemoryRisk] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  // result 与 recent 都持久化：音频引用的是服务端 URL（audio_url）而不是 blob，
  // 刷新之后播放器照样能用。
  const [result, setResult] = usePersistentState('generate.result', null)
  const [validation, setValidation] = useState(null)
  // Recent Generations 以服务端为准（GET /api/outputs）。每一项都是一个真实的资产目录
  // （outputs/generate/<id>/ 带 meta.json），所以 Rerun、Show in Explorer、Delete all
  // 都按 id 走后端。「Clear History」只在本地隐藏条目（dismissed ids），音频文件留在盘上。
  const [recentAll, setRecentAll] = useState([])
  const [dismissed, setDismissed] = usePersistentState('generate.dismissed', [], {
    rehydrate: r => (Array.isArray(r) ? r : []),
  })
  const recent = recentAll.filter(x => !dismissed.includes(x.id))
  const [showAllRecent, setShowAllRecent] = useState(false)
  const [genConfirm, setGenConfirm] = useState(null)       // 二次确认弹窗的内容
  const [genConfirmBusy, setGenConfirmBusy] = useState(false)
  const [showSaveRecipe, setShowSaveRecipe] = useState(false)   // 存为配方的弹窗
  const [recipes, setRecipes] = useState([])
  const [loadRecipeId, setLoadRecipeId] = useState('')

  const [splitEnabled, setSplitEnabled] = usePersistentState('generate.splitEnabled', true)
  const [maxChars, setMaxChars] = usePersistentState('generate.maxChars', 30)
  const [concatEnabled, setConcatEnabled] = usePersistentState('generate.concatEnabled', true)
  const [silenceMs, setSilenceMs] = usePersistentState('generate.silenceMs', 300)
  // 强制重新推理：跳过合成结果复用缓存的读。走 usePersistentState（浏览器本地），
  // 不进 /api/advanced-params：那个端点存的是引擎参数表，而这是平台自己的开关
  // （一台引擎都没装的时候它依然有意义），混进去正是契约 C11 禁止的第二份参数表，
  // 而且 loadAdvancedParams 是「盘上赢」，会把它变成所有调用方的默认值。
  // 默认 false：勾选是用户主动的动作，不勾就享受复用。
  const [forceResynth, setForceResynth] = usePersistentState('generate.forceResynth', false)

  // 读音校对：本次覆盖仅内存态。走 Proof & language 弹窗，无需单独的启用开关
  // （弹窗内无条件渲染校对面板，overrides 直接进 payload）。
  const [pronOverrides, setPronOverrides] = useState({})
  // 逐字强制反向语言的汉字列表。持久化；请求组装时转成 {char->lang}。
  const [hanForced, setHanForced] = usePersistentState('generate.hanForced', [])
  // 被强制汉字的反向语言读音（假名或拼音），按字索引。请求组装时并进 pron_overrides。
  const [hanReadings, setHanReadings] = usePersistentState('generate.hanReadings', {})
  const [showTextPrep, setShowTextPrep] = useState(false)

  const selected = voices.find(v => v.id === selectedVoice)

  // 高级设置，从 /api/advanced-params 读（全局，不分音色）。
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showLongTextSplit, setShowLongTextSplit] = useState(false)
  const [advTier, setAdvTier] = useState('common')

  // 引擎参数：一份字典，键名来自当前引擎的 manifest.json。
  //
  // 面板长什么样、发哪些键，全部来自 engine.param_schema。写死的键名会让界面对
  // 任何一台别的引擎都不对得上（服务端静默忽略），该长的格子也长不出来。
  // 这里只装引擎参数。平台自己的开关（force re-synthesis / engine batch /
  // media type / seed）不在这里，它们不属于任何一台引擎，见各自注释。
  const [paramValues, setParamValues] = useState({})
  // 用户手动改过哪些格子。只有改过才发出去：「没改」和「设成了跟默认值一样的数」
  // 在请求体里必须长得不一样，否则平台无法区分「用户要这个值」和「用户没管」。
  const [touchedParams, setTouchedParams] = useState(() => new Set())

  // 换引擎（或第一次拿到引擎）⇒ 面板整个换成新引擎的格子和默认值。
  // 不保留上一台引擎的值：键名可能撞车而含义完全不同。
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

  // 这个页面走 /api/generate，它等的是一份做完的音频（runGenerate 读的是 audio_url），
  // 消费不了流。所以只对流式输出有意义的那几个参数，在这一页上长出来也是摆设。
  // 引擎名取自当前选中的引擎；还没选出来时用泛称，不说任何一台引擎的名字。
  const engineName = engine?.label || engine?.id || t('the engine', '引擎')

  const STREAM_ONLY = ['streaming_mode', 'overlap_length', 'min_chunk_length']
  // only_when 在这里就滤掉，不留一个空的 <div> 占着格子，否则 .form-grid 会在两列里
  // 留下一个洞，看起来像「有一格没画出来」。isFieldVisible 是 fail-open：
  // 名片写了个不存在的键，照常显示。
  const visibleFields = (tier) => fieldsForTier(engine, tier)
    .filter(f => !STREAM_ONLY.includes(f.name))
    .filter(f => isFieldVisible(f, paramValues))

  // 平台自己的参数，不属于任何一台引擎，所以不进 param_schema。
  const [seed, setSeed] = useState(-1)
  const [mediaType, setMediaType] = usePersistentState('generate.mediaType', 'wav')
  // 这三个键（streaming_mode / overlap_length / min_chunk_length）不在这个界面上。
  // 撤掉的是界面格子，不是 API 能力：lib/services/synthesisService.js 仍然解析这三个入参，
  // 第三方和 Flow 可以显式传（契约 §7 逃生门）。
  // streaming_mode 在 manifest.defaults 里 ⇒ 每次仍发 false，且不再可能被盘上的陈年 true 污染；
  // overlap_length / min_chunk_length 只在 params.schema 里有 default（＝界面初值），
  // 不在 defaults ⇒ 不再出现在 payload 里，与 OpenAI 口和 Flow 一致。
  // 引擎批处理模式：把整段文本一次交给引擎，由它自己切分并按 batch_size 并行合成，
  // 而不是 broker 逐段顺序合成。产出单个音频（没有分段文件）。默认关闭，
  // 保持现有的分段输出。
  const [engineBatch, setEngineBatch] = useState(false)

  useEffect(() => { api('/api/recipes').then(r => { if (r.ok) setRecipes(r.data?.recipes || []) }).catch(() => {}) }, [])

  // 读取高级参数。
  // 这里不能是裸地址 api('/api/advanced-params') 配依赖数组 []（只在挂载时跑一次）：
  // 后端不带 engine_id 就不回落到任何一台名片 ⇒ 实际部署里高级设置里所有
  // 「用户没拧过」的格子全部变空，而且不报错。
  // 依赖数组是 [engine?.id]，这是故意的行为变化：默认值本来就属于该名片，
  // 换一台引擎就该重新问一次。不许改回 []，挂载那一刻 engine 往往还没加载完，
  // 那会退化成永远拿不到默认值。
  useEffect(() => {
    if (!engine?.id) return
    api(`/api/advanced-params?engine_id=${encodeURIComponent(engine.id)}`).then(r => {
      if (r.ok && r.data) {
        const p = r.data
        // 盘上存着的那份「上次拧到哪」。只认当前引擎名片里有的键：盘上这份是全局的
        // （不分引擎），换引擎之后里面留着上一台的键名，原样灌进去就等于把别人的参数发给这台引擎。
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

  // 模型选择。
  // 下拉有几个，是这台引擎的名片说的；每个下拉里装什么，是
  // 「这台引擎的底模 ∪ 当前角色下这台引擎的模型」这个二维筛选说的。
  // 候选只在当前角色里挑：挑别人的权重会把参考音频一起带走，用户看不见也管不着。
  // 要用别人的模型，就切到那个角色去。
  const assetsWithModels = useAssetsWithModels()
  // 这台引擎有几个模型位（名片说的）。名片没写 = 一个下拉都不长，不是两个。
  const weightSlots = useMemo(() => slotsOf(engine), [engine])
  // 这几个位换一份就得让引擎带着它重开一次，界面要为此提醒一句「要多等」。
  const relaunchSlots = useMemo(() => slotsNeedingRelaunch(weightSlots), [weightSlots])
  // 每个位各自的候选（按角色分组，底模那一组永远在最前）。
  const groupsBySlot = useMemo(() => {
    const out = {}
    for (const s of weightSlots) {
      out[s.name] = candidatesForSlot(assetsWithModels, engine?.id, s.name, selectedVoice)
    }
    return out
  }, [weightSlots, assetsWithModels, engine, selectedVoice])
  // 音色下拉里该出现谁：底模 ∪「在这台引擎下每个位都有自己模型」的角色。
  // 只筛下拉，不筛 voices 本身，底下那个「使用其他音色的参考音频」要能挑到所有角色。
  // 筛掉一个角色的意思是「这台引擎没有它的模型」，不是「这个角色不存在」。
  const voiceOptions = useMemo(
    () => voicesForEngine(voices, assetsWithModels, engine?.id, weightSlots),
    [voices, assetsWithModels, engine, weightSlots])

  // 换引擎之后，上一台引擎选中的角色可能已经不在下拉里了。不收拾的话下拉会显示成空白，
  // 而 selectedVoice 还是老值，看着没选，一按生成却按老角色发出去。回落到第一条。
  useEffect(() => {
    if (!voiceOptions.length) return
    if (voiceOptions.some(v => v.id === selectedVoice)) return
    setSelectedVoice(voiceOptions[0].id)
  }, [voiceOptions, selectedVoice, setSelectedVoice])

  // 每个位当前选中的路径：{ 位名: 路径 }
  const [selWeights, setSelWeights] = useState({})
  // 持久化：每个 引擎 × 角色 各自记住上次每个位选了什么，刷新后只要还在候选里就恢复。
  // 存的时候按 引擎id → 角色 → 位名 分三层，否则换引擎会把上一台的路径捡回来。
  const [modelChoice, setModelChoice] = usePersistentState('generate.modelChoice.byEngine', {})
  const modelChoiceRef = useRef(modelChoice)
  modelChoiceRef.current = modelChoice
  const generateAbortRef = useRef(null)

  // 平台已经扫到的所有模型文件，不分位、不分引擎，给 type: 'path' 的格子当候选。
  // 为什么不分：位名是各家引擎自己的说法，平台在这里只回答「我知道盘上有哪些模型文件」。
  // 哪个文件该填进哪一格，是引擎自己在名片里说清楚的事（靠那一格的 label / help），
  // 不是平台来配对。这只是候选，不是限制，那一格可以直接打字填绝对路径。
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

  // 参考音频跟着当前角色走：候选里根本不会出现别人的模型。
  const refVoiceId = selectedVoice

  // `select + source` 那种格子的候选表（voices / weights / audio）。
  // 平台扫盘的结果在这里汇总一次，ParamField 只管画，它不知道这三个库是什么。
  // 这一段必须放在 refVoiceId 声明之后：refVoiceId 是 const，暂时性死区，
  // 放在它前面会一进这一页就 ReferenceError 白屏。
  // ⇒ 往这个函数体里插新的 const 时，先确认它依赖的每一个名字都在上面。
  const selectSources = useSelectSources({
    voices,
    knownModelPaths,
    audioVoiceId: refVoiceId,
  })
  const selectOptions = (f) => optionsForField(f, selectSources)
  // 当前这一套的一句话摘要：「角色 / 第一个位选的 / 第二个位选的 / …」。
  // 位有几个就写几段。
  const selectedItems = useMemo(() => weightSlots.map(s => {
    const flat = flattenGroups(groupsBySlot[s.name] || [])
    return flat.find(x => x.path === selWeights[s.name]) || null
  }), [weightSlots, groupsBySlot, selWeights])
  const modelSummary = selected ? [
    selected.display_name || selected.id,
    ...selectedItems.map(it => it ? itemLabel(it) : null),
  ].filter(Boolean).join('  /  ') : ''
  // 后端对这个角色 × 这台引擎有没有话要说（放错了一层、目录名不是权重位名、
  // 有文件没被列进来等等）。前端不判断、不拼话，整句是后端生成的。
  // 它存在的唯一理由是：在它之前，「没有模型」和「放错了」在界面上长得一模一样，
  // 都是一个空下拉，且没有任何一处解释为什么。
  const modelNotes = useMemo(
    () => modelNotesFor(assetsWithModels, engine?.id, selectedVoice),
    [assetsWithModels, engine, selectedVoice])
  // 选中的这几份里，有哪几份按名片点名的东西是不齐的。
  // 只收 false；null 表示「说不出来」（单文件的候选或名片没写 required），
  // 不把「说不出来」画成「有问题」。
  const incompleteItems = useMemo(
    () => selectedItems.filter(it => it && it.complete === false),
    [selectedItems])
  const [lang, setLang] = useState(selected?.language || 'ja')
  // 目标合成语言（text_lang），独立于 prompt_lang；默认 = 微调源语言，切换音色时重置。
  const [textLang, setTextLang] = useState(() => defaultTargetLang(selected?.language || 'ja'))
  const _baseLangFam = String(lang || '').replace(/^all_/, '')
  const _targetFam = normalizeLangFamily(textLang)
  const langMismatch = !!_targetFam && _targetFam !== _baseLangFam    // 目标语言与微调语言不符
  const panelLang = _targetFam || _baseLangFam                         // 读音校对面板跟随目标语言
  const hanDir = hanOverrideDirection(textLang, lang)                  // 反向语言的方向（或 null）
  // 这些覆盖是持久化的，存的是绝对字符下标，所以改了文本就错位（下标 0 可能已经是一个假名）。
  // 读的时候剪枝，同时把存的那份也治好，
  // 于是徽章、选择器和请求体不会对「有几条生效」各说各话。
  const hanForcedLive = useMemo(() => pruneForced(hanForced, text), [hanForced, text])
  useEffect(() => {
    if (hanForcedLive.length !== (hanForced || []).length) setHanForced(hanForcedLive)
  }, [hanForcedLive, hanForced, setHanForced])
  const langOverrides = buildLangOverrides(hanDir, hanForcedLive, text)    // {char->lang} 请求体，按当前文本剪过枝
  const pronPayload = buildPronPayload(pronOverrides, panelLang, hanDir, hanForcedLive, hanReadings)  // 基础读音 + 反向读音
  const [auxRefs, setAuxRefs] = useState([])   // 选中的辅助参考音频路径
  const [segments, setSegments] = useState([])   // 辅助参考选择器用的，从 API 读

  // 换角色 / 换引擎时，先把上次记住的选择摆上去（还有没有效，交给下面那条对齐）。
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

  // 把每个位的选择跟候选对齐：还有效的留住，失效的换成默认或第一条。
  // 候选还没到齐（异步）时不动：否则清单从空变满的那一瞬间会把刚恢复的选择弹回第一条。
  // 失效的必须换掉，换了引擎之后留着上一台的路径，等于把别人的权重发出去。
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

  // 语言跟着当前角色：模型必属当前角色，refVoiceId 恒等于 selectedVoice。
  useEffect(() => {
    const v = voices.find(x => x.id === selectedVoice)
    if (v?.language) { setLang(v.language); setTextLang(defaultTargetLang(v.language)) }
  }, [selectedVoice, voices])

  // 高级参数是全局的（来自 /api/advanced-params），不分音色，换音色时不用同步。

  // 选中的模型如果带着版本号，就查一下那一版的底模在盘上齐不齐（缺了会出电流声）。
  // 判据是「任何一个带版本号的选择」：版本号是扫盘时认出来的一个可选属性，谁带就查谁。
  // 这里不出现任何具体的位名。
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

  // 离开 Generate 页时清掉活动指示。
  useEffect(() => () => onActivity?.(null), [])

  useEffect(() => {
    if (!selectedVoice) return
    // 点名当前引擎：问的是「这台引擎启动要的东西齐没齐」。
    //   不点名会把装着的每一台都答一遍，那是给别的界面用的，不是这里。
    const q = engine?.id ? `?engine_id=${encodeURIComponent(engine.id)}` : ''
    api(`/api/voices/${selectedVoice}/validate${q}`).then(r => {
      if (r.ok && r.data.ok) setValidation(r.data.checks)
    }).catch(() => setValidation(null))
  }, [selectedVoice, voices, engine?.id])

  // 用用户选的参考（来自 VoiceSidebar），没有就退回自动挑的一段切片：
  // 那段切片在盘上确实存在（服务端实时查 exists），且尽量落在引擎合适的时长区间里，
  // 免得默认合成因为切片太短被 400。
  const defaultRef = segments.length > 0 ? pickDefaultRef(segments) : null
  const currentRefAudio = selectedRefAudio || (defaultRef ? (defaultRef.audio || defaultRef.audio_path || defaultRef.audio_filename) : '')
  // 用户明确选了参考之后，它的文本原样照用，包括原始片段的空串（它没有对齐过的转写）。
  // 只有什么都没选时才退回自动挑的切片文本，否则选了一段原始素材还会继续发旧的转写。
  const currentRefText = selectedRefAudio ? selectedRefText : (defaultRef ? (defaultRef.text || '') : '')

  // 参考文本覆盖（只对这一次生效）。让用户改或补发给引擎的提示转写，不动任何文件：
  // raw_opt.list / segments.json 原样保留（不调用任何保存端点）。
  // null 表示跟随当前参考自己的文本；字符串（含空串）表示这次原样用它。
  const [refTextOverride, setRefTextOverride] = useState(null)
  // 换参考或换音色时丢掉覆盖：为一段参考做的改动不会悄悄落到另一段上。
  useEffect(() => { setRefTextOverride(null) }, [selectedVoice, selectedRefAudio])
  const effectiveRefText = refTextOverride != null ? refTextOverride : currentRefText

  // 读服务端为准的 Recent Generations 列表。
  const loadRecent = async () => {
    const r = await api('/api/outputs')
    if (r.ok && r.data && Array.isArray(r.data.items)) setRecentAll(r.data.items)
  }
  useEffect(() => { loadRecent() }, [])

  // 生成按钮与 Recent → Rerun 共用的生成入口。
  // 那一次请求体原样存进每条 recent 项，Rerun 才能用完全相同的设置复现音频，
  // 而不只是把文字填回来。
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
    // 只有真正的空串算非法。空白对有些 TTS 引擎是有意义的（比如当停顿用），所以这里不 trim。
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
      // 名片没写的键一个都不发，服务端会静默忽略，症状是
      // 「我明明调了却没效果」，最难查的那一类。
      // 这一次要连哪台引擎，由界面上选中的那台说了算。少了这一句，请求不点名，
      // 服务端就去认领 legacy_default 那台：界面按 A 引擎画格子、按 A 引擎发参数、
      // 按 A 引擎选权重，请求却打到 B 引擎身上。
      // engine?.id 不给默认值：引擎没选出来时留空，
      // 让服务端报「你没说连哪台」，而不是替用户挑一台。
      engine_id: engine?.id,
      // 这台引擎的参数格子。点名了引擎，就把参数装进它自己那一格，
      // 服务端据此核对「你发的这袋参数是不是这台引擎的」。
      // 平铺那一份（下一行）是老路径还在读的形状，暂时并存。
      engine_params: engine?.id ? { [engine.id]: phasedEngineParams.call } : undefined,
      engine_load_params: engine?.id && Object.keys(phasedEngineParams.load).length
        ? { [engine.id]: phasedEngineParams.load }
        : undefined,
      ...phasedEngineParams.call,
      seed,
      engine_batch: engineBatch,
      media_type: mediaType,
      // 选中的模型：用哪个参数名发，是这台引擎的名片说的。
      // 名片没说的位一个字节都不发，那台引擎运行中换不了权重，
      // 发一个它不读的键不会报错，只会让人以为换了而声音没变。
      ...weightsToSend(weightSlots, selWeights),
      // 开进程那一刻才吃得进去的那些模型，选择走这一个平台级的键。
      // 它不是引擎参数（引擎那道出门关也会把它拦下），收件人是平台：
      // 平台拿它决定要不要带着这一份把引擎重开一次。
      // 少了这一句，下拉能选、后端连「你选过」都看不见、声音没变、而且不报错。
      launch_weights: launchWeightsToSend(weightSlots, selWeights),
      text_lang: textLang, prompt_lang: selectedPromptLang || lang,
      // Auto（多语种）：不含假名的 CJK 回落到音色元数据里的语言。
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
      // 成功合成后回存「上次拧到哪」。只回存用户手动改过的格子 + seed。
      // 不回存整份 paramValues：没动过的键回存下去就等于把名片默认值抄进盘上文件，
      // 从此名片改了也不生效。而 loadAdvancedParams() 是 { ...名片默认值, ...盘上文件 }，
      // 盘上赢：只写不读的键沉在盘上文件里会压住名片默认值，契约 C11 的默认值
      // 在实际部署里就等于失效。
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

  // Recent Generations 的真实管理（重跑、显示、删除、批量）。
  const handleRerun = async (item) => {
    if (loading) return
    if (!item) return
    if (!item.params) {
      // 早期历史条目没有记录生成设置：只能把文字填回来，
      // 用户自己再按 Generate 用当前的音色和设置合成。
      setText(item.text || '')
      setError('This entry was saved before settings capture, so only its text was loaded into the editor above. Press Generate to synthesize it with the current voice and settings. Newly generated items rerun automatically with their exact original settings.')
      return
    }
    setError(null)
    await runGenerate(item.params, { voiceLabel: item.voice })
  }

  // 重载配方：把历史条目里记录的请求体（音色、模型、语言、参考、辅助参考、文本、
  // 每一个参数、读音覆盖）全部覆盖进编辑器，但不合成。用户核对或微调后再按 Generate。
  // 依赖音色的字段（模型、语言、参考）在下一个 tick 才应用，
  // 这样它们盖得住换音色时那些会重置它们的 effect。
  const handleReload = (item) => {
    if (!item) return
    if (!item.params) {
      // 早期历史条目没有记录设置：只有文字可用。填回文字，并告诉用户其余的恢复不了。
      setText(item.text || '')
      setError('This is an older history entry saved before full settings capture, so only its text was reloaded into the editor. Choose a voice and adjust settings, then press Generate.')
      return
    }
    const p = item.params
    setError(null)
    // 不依赖音色、不会被换音色的 effect 重置的字段可以立即应用。
    if (p.text !== undefined) setText(p.text)
    if (p.split !== undefined) setSplitEnabled(!!p.split)
    if (p.max_chars !== undefined) setMaxChars(p.max_chars)
    if (p.concat !== undefined) setConcatEnabled(!!p.concat)
    if (p.silence_ms !== undefined) setSilenceMs(p.silence_ms)
    // 历史条目里存的是当时那台引擎的参数。回填时只认当前引擎名片里有的键，
    // 并且标成「动过」，用户明确要求重放这一条，那就是他要的值。
    // 认不出的键直接丢：换引擎之后老条目里的键名不匹配，硬塞会发出去。
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
    // if_sr 现在是名片里的普通一格，上面那个循环已经收了。
    if (p.media_type !== undefined) setMediaType(p.media_type)
    // streaming_mode / overlap_length / min_chunk_length 这三个格子不在这个界面上，
    // 老历史记录里可能还存着这三个键，回填时直接忽略，没有格子可以放它们了。
    if (p.engine_batch !== undefined) setEngineBatch(!!p.engine_batch)
    if (Array.isArray(p.aux_ref_audio_paths)) setAuxRefs(p.aux_ref_audio_paths)
    else setAuxRefs([])
    if (p.pron_overrides && Object.keys(p.pron_overrides).length > 0) {
      setPronOverrides(p.pron_overrides)
    } else {
      setPronOverrides({})
    }
    // 回填逐字强制反向语言的汉字列表（只回填字，反向语言由 text_lang 与音色重新推）。
    if (p.lang_overrides && typeof p.lang_overrides === 'object' && !Array.isArray(p.lang_overrides)) {
      setHanForced(parseLangOverrides(p.lang_overrides))
    } else {
      setHanForced([])
    }
    // 回填被强制汉字的反向语言读音（假名或拼音）。
    if (p.han_readings && typeof p.han_readings === 'object' && !Array.isArray(p.han_readings)) {
      setHanReadings(p.han_readings)
    } else {
      setHanReadings({})
    }
    // 需要时先切音色；换音色的 effect 会重置模型、语言、参考，
    // 所以下面在下一个 tick 里再应用一遍。
    if (p.voice && p.voice !== selectedVoice) setSelectedVoice(p.voice)
    // 从那一次实际发出去的参数里，把每个位当时选的模型认回来。
    // 认的依据是名片说这个位走哪个参数名，反查一次即可，位有几个就认几个。
    // 没写参数名的位当时本来就没发出去，自然也认不回来
    // （那台引擎的权重是启动时定的，重跑时装的是哪一份由它自己决定）。
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
            {/* 音色与模型位排在同一行；模型栈的摘要留在下一行。 */}
            <ModelPickRow
              selectedVoice={selectedVoice}
              onSelectVoice={setSelectedVoice}
              voiceOptions={voiceOptions}
              weightSlots={weightSlots}
              groupsBySlot={groupsBySlot}
              selWeights={selWeights}
              onSelectWeight={(name, path) => setSelWeights(prev => ({ ...prev, [name]: path }))}
              modelSummary={modelSummary}
              relaunchHint={relaunchSlots.length > 0}
              modelNotes={modelNotes}
              incompleteItems={incompleteItems}
            />

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

            <div className="collapsible" style={{ margin: '6px 0' }}>
              <div className="collapsible-hdr" onClick={() => setShowLongTextSplit(!showLongTextSplit)}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Long-Text Splitting</span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showLongTextSplit ? '▲' : '▼'}</span>
              </div>
              {showLongTextSplit && (
                <div className="collapsible-body">
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
              )}
            </div>

            {/* 高级设置。 */}
            <AdvancedParamsPanel
              showAdvanced={showAdvanced}
              onToggle={() => setShowAdvanced(!showAdvanced)}
              advTier={advTier}
              onTier={setAdvTier}
              engine={engine}
              engineName={engineName}
              visibleFields={visibleFields}
              paramValues={paramValues}
              onParam={setParam}
              uiLang={uiLang}
              selectOptions={selectOptions}
              seed={seed}
              onSeed={setSeed}
              forceResynth={forceResynth}
              onForceResynth={setForceResynth}
              engineBatch={engineBatch}
              onEngineBatch={setEngineBatch}
              mediaType={mediaType}
              onMediaType={setMediaType}
              hasAuxRefs={hasMappedKey(engine, 'aux_reference_audio')}
              auxRefs={auxRefs}
              currentRefAudio={currentRefAudio}
              refVoiceId={refVoiceId}
              voices={voices}
              onAuxRefAdd={(p) => setAuxRefs(prev => prev.some(x => sameRefPath(x, p)) ? prev : [...prev, p])}
              onAuxRefRemove={(i) => setAuxRefs(prev => prev.filter((_, idx) => idx !== i))}
            />

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
                // 红色：终止一个已经开始的合成。
                <button className="btn btn-sm btn-danger" onClick={handleCancelGenerate}>
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
                // 这台配方是给哪台引擎存的。不填的话后端只能把参数收进
                // 一个叫 _unassigned 的占位格，下次开就未必认得回来。
                engine_id: engine?.id || '',
                // 引擎自己的参数存进它自己的格子，原样存原样取，平台不认识
                // 里面任何一个键名。换一台引擎，这里存的就是那台的参数。
                engine_params: engine?.id
                  ? { [engine.id]: paramsToSend(engine, paramValues, touchedParams) }
                  : {},
                params: {
                  // 把完整的推理契约钉住，配方经 /v1/audio/speech 分发时才能复现同一次试音。
                  // 这一份是给老配方和老前端留的兼容底：后端仍按 v3 的键集往 params 里写一份。
                  // 真正权威的是上面的 engine_params。
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
                // 配方顶层那两个权重字段。配方格式不动 ⇒ 这两个字段只装得下两个位、
                // 而且名字是第一台引擎的形状。哪个位落进哪个字段的知识收在配方那个文件里一处，
                // 这里不重复：配方升级时改那一处即可。
                ...weightsToRecipeFields(weightsToSend(weightSlots, selWeights)),
              }}
              onSaved={(rec) => setError(null)}
            />

            {notice && <div className="msg msg-success">{notice}</div>}
            {error && <div className="msg msg-error"><strong>Error:</strong> {error}</div>}
          </div>
        </div>

        {/* 合成结果。 */}
        <GenerationResult result={result} />

        {/* 分段。 */}
        {result && result.segments && result.segments.length > 1 && (
          <CollapsibleSegments segments={result.segments} />
        )}

        {/* 最近生成：持久化的列表，带真实的文件管理。 */}
        <RecentGenerations
          recent={recent}
          showAll={showAllRecent}
          onShowAll={() => setShowAllRecent(true)}
          onClearHistory={askClearHistory}
          onCleanAll={askCleanAll}
          onReveal={revealItem}
          onReload={handleReload}
          onRerun={handleRerun}
          onDelete={askDeleteItem}
          loading={loading}
        />

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

      {/* 右侧栏：音色信息。 */}
      <div className="workspace-right">
        {selected && <VoiceSidebar voice={selected} refVoiceId={refVoiceId} voices={voices} validation={validation} onVoiceUpdate={onVoiceUpdate} selectedRefAudio={selectedRefAudio} selectedRefText={selectedRefText} selectedPromptLang={selectedPromptLang} onSelectRef={onSelectRef} refTextOverride={refTextOverride} onRefTextOverride={setRefTextOverride} />}
      </div>
    </div>
  )
}

export {
  GenerateTab,
}
