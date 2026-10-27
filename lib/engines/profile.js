'use strict'

// 把「名片上写的」翻成「合成路径能用的」：连哪台、等多久、切多长、参考音频多长、换权重、采样率，唯一来源是
// engines/<id>/manifest.json。
// 本文件里不允许出现任何具体引擎的名字（profile.node.test.js 有守卫盯着）。
// 解析细节按职责拆在 profile/ 下；权重位的规整规则与磁盘约定在一起（lib/assets/modelLayout.js）：名片声明了几个位，那几个位在盘上就得叫什么目录。

const { requireEngine } = require('./registry')
const { normalizeWeightSlots } = require('../assets/modelLayout')
const {
  profileError, required, positiveInt, requiredBool,
  parseClipSeconds, plainObject, stringArray, relPath,
} = require('./profile/fields')
const {
  parseMethods, parseMaps, checkSlotSwitching, retireHotSwap, checkSlotParams,
} = require('./profile/maps')
const { parseModels, parseUpstream } = require('./profile/models')
const { checkTopKeys, checkMeasuredSources } = require('./profile/topkeys')
const { parseParamSchema, applyDefaultsEnv } = require('./profile/paramSchema')

// 环境变量覆盖：由名片自己指定变量名，平台不认识任何具体的变量名。
// 返回值里有两个地址：base_url 是「合成请求发到哪儿」（连），会被 base_url_env 顶掉；default_base_url 是「这台引擎自己该
// 监听哪儿」（听），永远是名片声明的那个，env 顶不动。两者必须分开，否则把 base_url_env 指向一台远程引擎的人，会在本地起出一台监听远程端口号的引擎。
function resolveBaseUrl(manifest, env) {
  // 故意不走 required()：base_url_env 命中时保持宽松（那条路径本来就不读 default_base_url），免得给只关心地址的调用方新增一个抛点。
  // default_base_url 是可选的：端口由平台分配，名片不必写监听地址。没写时 base_url 是 null：「连」地址由平台在 buildLaunchPlan({ port }) 那一步决定。
  const raw = manifest.default_base_url
  const declared_base_url = raw ? String(raw).replace(/\/+$/, '') : null

  const envKey = manifest.base_url_env
  if (envKey && env[envKey]) {
    return {
      base_url: String(env[envKey]).replace(/\/+$/, ''),
      source: `env:${envKey}`,
      declared_base_url,
    }
  }
  const declared = declared_base_url
  return {
    base_url: declared == null ? null : String(declared).replace(/\/+$/, ''),
    source: declared == null ? 'platform' : 'manifest',
    declared_base_url,
  }
}

// runtime，这台引擎的进程长什么样。平台只验不建：核对名片说的解释器/模块/类/方法在不在（本段 + envCheck.js），再按名片起进程、轮询
// ready（supervisor）。
// 不认识的键要抛错：`ready_endoint` 这种拼写错误被静默吃掉，表现是「轮询永远超时」。
const RUNTIME_KEYS = Object.freeze([
  'python', 'entry', 'args', 'cwd', 'checkpoints',
  'ready_endpoint', 'ready_timeout_ms', 'ready_timeout_ms_source', 'preload', 'verify',
])

const VERIFY_IMPORT_KEYS = Object.freeze(['module', 'class', 'methods', 'init_params'])

function parseVerify(manifest, value) {
  if (value === undefined || value === null) return null
  const v = plainObject(manifest, 'runtime.verify', value)

  const sysPath = stringArray(manifest, 'runtime.verify.sys_path', v.sys_path)
    .map((p, i) => relPath(manifest, `runtime.verify.sys_path[${i}]`, p))

  const rawImports = v.imports
  if (!Array.isArray(rawImports) || rawImports.length === 0) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 写了 runtime.verify 却没写 runtime.verify.imports` +
      '一条都不检查的校验等于没有校验，那还不如整段不写。',
      { id: manifest.id, key: 'runtime.verify.imports', value: rawImports })
  }

  const imports = rawImports.map((raw, i) => {
    const item = plainObject(manifest, `runtime.verify.imports.${i}`, raw)
    for (const k of Object.keys(item)) {
      if (!VERIFY_IMPORT_KEYS.includes(k)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 runtime.verify.imports.${i} 上有平台不认识的键 ${k}` +
          `认识的只有 ${VERIFY_IMPORT_KEYS.join(' / ')}。拼错了就改，真需要新键就先改契约。`,
          { id: manifest.id, key: `runtime.verify.imports.${i}.${k}` })
      }
    }
    const mod = required(manifest, `runtime.verify.imports.${i}.module`, item.module,
      '校验要 import 哪个模块')
    if (typeof mod !== 'string') {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 runtime.verify.imports.${i}.module 必须是模块名字符串`,
        { id: manifest.id, key: `runtime.verify.imports.${i}.module`, value: mod })
    }
    const cls = item.class === undefined || item.class === null ? null : String(item.class)
    const methods = stringArray(manifest, `runtime.verify.imports.${i}.methods`, item.methods)
    const initParams = stringArray(manifest, `runtime.verify.imports.${i}.init_params`, item.init_params)
    // 方法名/构造参数名都挂在类上，没有类就无处可挂：静默忽略会让「我明明写了要检查 infer」变成一句空话。
    if (!cls && (methods.length || initParams.length)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 runtime.verify.imports.${i} 写了 methods/init_params 却没写 class` +
        '这两样都挂在类上，没有类就检查不了。',
        { id: manifest.id, key: `runtime.verify.imports.${i}.class` })
    }
    return { module: mod, class: cls, methods, init_params: initParams }
  })

  return { sys_path: sysPath, imports }
}

// 名片里只有 5 项必须人答（call.bind 的 text / ref_audio / output_path，
// runtime.python，runtime.entry）。其余各项平台要么推得出、要么有保守默认，
// 缺了不抛。默认值走 profile.defaulted 如实报出去：界面要能区分「名片写的」
// 和「平台替你填的」，后者该由第 5 步试跑实测后写回名片（出处 measured）。
//
// 默认值都往「宁可慢、不会坏」那边取：
//   timeout_ms 300s        与通用宿主的单请求窗口一致（lib/engines/host.py）
//   max_chars 50           切得碎只是多几段，切得长会单段撑爆超时
//   ready_timeout_ms 240s  现有引擎冷启动 180s~240s 的上沿
const DEFAULTS = Object.freeze({
  timeout_ms: 300000,
  max_chars: 50,
  ready_timeout_ms: 240000,
})

// 平台通用宿主自带 /health；启动脚本是它时，就绪端点不用问。
function isSharedHost(entry) {
  return typeof entry === 'string' && /(^|[\\/])lib[\\/]engines[\\/]host\.py$/.test(entry)
}

function parseRuntime(manifest, defaulted = []) {
  const raw = manifest.runtime
  // 缺 runtime = 这台引擎不由平台起（作者自己起、或者还没接上电）。这是合法状态，不报错，但平台没法校验它，界面上要能看出这个区别，所以返回 null。
  if (raw === undefined || raw === null) return null
  const r = plainObject(manifest, 'runtime', raw)

  for (const k of Object.keys(r)) {
    if (!RUNTIME_KEYS.includes(k)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 manifest.json 里 runtime.${k} 平台不认识` +
        `认识的只有 ${RUNTIME_KEYS.join(' / ')}。` +
        '通常是拼写错误（拼写错误被静默忽略，表现是"平台反复查询却一直等到超时"而 manifest.json 看着完全正常）。',
        { id: manifest.id, key: `runtime.${k}` })
    }
  }

  const python = relPath(manifest, 'runtime.python',
    required(manifest, 'runtime.python', r.python,
      '平台不知道该用哪个解释器去核对这台引擎装没装'))
  const entry = relPath(manifest, 'runtime.entry',
    required(manifest, 'runtime.entry', r.entry,
      '平台不知道该跑哪个脚本把这台引擎起起来'))

  // 通用宿主 ⇒ 缺就是 /health；引擎自带服务脚本 ⇒ 平台答不出，照旧必填。
  const endpointMissing = r.ready_endpoint === undefined || r.ready_endpoint === null || r.ready_endpoint === ''
  if (endpointMissing && isSharedHost(entry)) defaulted.push('runtime.ready_endpoint')
  const readyEndpoint = endpointMissing && isSharedHost(entry)
    ? '/health'
    : required(manifest, 'runtime.ready_endpoint', r.ready_endpoint,
      '启动脚本不是平台通用宿主，平台不知道该访问哪个地址判断引擎起来没有')
  if (typeof readyEndpoint !== 'string' || !readyEndpoint.startsWith('/')) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 runtime.ready_endpoint 必须是以 / 开头的路径，` +
      `现在写的是 ${JSON.stringify(readyEndpoint)}`,
      { id: manifest.id, key: 'runtime.ready_endpoint', value: readyEndpoint })
  }

  if (r.ready_timeout_ms === undefined || r.ready_timeout_ms === null) defaulted.push('runtime.ready_timeout_ms')
  const readyTimeout = (r.ready_timeout_ms === undefined || r.ready_timeout_ms === null)
    ? DEFAULTS.ready_timeout_ms
    : positiveInt(manifest, 'runtime.ready_timeout_ms', r.ready_timeout_ms)

  return {
    python,
    entry,
    args: stringArray(manifest, 'runtime.args', r.args),
    cwd: r.cwd === undefined || r.cwd === null ? null : relPath(manifest, 'runtime.cwd', r.cwd),
    checkpoints: r.checkpoints === undefined || r.checkpoints === null
      ? null : relPath(manifest, 'runtime.checkpoints', r.checkpoints),
    ready_endpoint: readyEndpoint,
    ready_timeout_ms: readyTimeout,
    preload: r.preload === true,
    verify: parseVerify(manifest, r.verify),
  }
}

/** 读一张名片，产出合成路径要用的东西。缺一项就抛，不猜。id 是引擎目录名 = 引擎 id。 */
function resolveEngineProfile(id, env = process.env) {
  const manifest = requireEngine(id)          // 没装这个引擎 ⇒ FG_ENGINE_UNSUPPORTED
  // 先查顶层拼写，再查内容。顺序是故意的：`max_char` 拼错了，要报「顶层有个不认识的键 max_char，是不是想写 max_chars」，而不是报
  // 「缺少 max_chars」。
  checkTopKeys(manifest)
  checkMeasuredSources(manifest)
  const caps = manifest.capabilities || {}
  retireHotSwap(manifest, caps)

  const { base_url, source, declared_base_url } = resolveBaseUrl(manifest, env)

  // 平台替名片答了哪些键（见 DEFAULTS 上方的说明）。
  const defaulted = []
  const orDefault = (key, v) => {
    if (v === undefined || v === null) { defaulted.push(key); return DEFAULTS[key] }
    return positiveInt(manifest, key, v)
  }
  // 按「每一段」计，不是整篇
  const timeout_ms = orDefault('timeout_ms', manifest.timeout_ms)
  // 慢引擎要调小，否则单段就撑爆超时
  const max_chars = orDefault('max_chars', manifest.max_chars)

  // 参考音频时长：缺 = 不限制（null）。
  if (!('reference_clip_seconds' in caps)) defaulted.push('capabilities.reference_clip_seconds')

  // 要不要参考音频：没写就看 call.bind 绑没绑参考音频槽位。绑了 = 入口要一份参考录音。
  const rawCall = manifest.call && typeof manifest.call === 'object' ? manifest.call : {}
  const refBound = !!(rawCall.bind && rawCall.bind.ref_audio)
  if (caps.requires_reference_audio === undefined) defaulted.push('capabilities.requires_reference_audio')

  // 先算出来：param_schema 的默认值要从这里取。
  const defaults = applyDefaultsEnv(manifest,
    plainObject(manifest, 'defaults', manifest.defaults),
    manifest.defaults_env, env)

  // 模型位要在 capabilities 之前算出来；一次请求一个方法，界面上要有个下拉。方法那段不是给引擎进程读的（那条路是 hostProfile.js），是给
  // /api/engines 用的。单方法引擎（没写 call.methods）⇒ methods: null，不是 []：[] 的意思是「声明了但空的」（当场抛）。
  const weightSlots = checkSlotSwitching(manifest,
    checkSlotParams(manifest, normalizeWeightSlots(manifest.weights)))
  const call = plainObject(manifest, 'call', manifest.call)
  const { methods, default_method: defaultMethod } = call.methods
    ? parseMethods(manifest, call)
    : { methods: null, default_method: null }

  return {
    id: manifest.id,
    label: manifest.label || manifest.id,
    dir: manifest.dir,
    base_url,
    base_url_source: source,
    // base_url_env 交的是「名字」而不是读取结果：启动脚本要写它，起多台引擎时脚本里不能写死某一个引擎的变量名。
    base_url_env: manifest.base_url_env || null,
    // default_base_url 是「这台引擎自己该监听哪儿」。launchPlan.js 用它算启动端口：不能用上面那个 base_url，它可能是 env 指向的别人家的引擎。
    default_base_url: declared_base_url,
    timeout_ms,
    max_chars,
    // 硬上限 = 软上限 ×2，与 synthesisService 的算法一致。
    hard_max_chars: max_chars * 2,
    requires_reference_audio: caps.requires_reference_audio === undefined
      ? refBound
      : requiredBool(manifest, 'capabilities.requires_reference_audio',
        caps.requires_reference_audio, '平台不知道没有参考音频时该不该拦下来'),
    reference_clip_seconds: 'reference_clip_seconds' in caps
      ? parseClipSeconds(manifest, caps.reference_clip_seconds)
      : null,
    // hot_swap_models 已退休（见 retireHotSwap()），今天由 weight_slots[].applies_at 逐位回答。
    // 只是声明，拼接不靠它：段间静音按每一段 wav 头里的实际格式生成（lib/audio/concat.js）。
    // 缺 = null =「看实际输出」。
    output_sample_rate: caps.output_sample_rate === undefined || caps.output_sample_rate === null
      ? null
      : positiveInt(manifest, 'capabilities.output_sample_rate', caps.output_sample_rate),
    // 契约 v2 只管推理：这个键唯一的用途是决定训练页显不显示。没写 = false。
    supports_finetune: caps.supports_finetune === true,
    streaming: caps.streaming === true,
    param_keys: manifest.param_keys || [],
    // 拼请求体要用的三段：maps（平台的词 → 这台引擎的键名）/ payload_keys（cfg 透传白名单）/ defaults（这台引擎的默认值，只填没人填
    // 过的键）
    maps: parseMaps(manifest, manifest.maps),
    payload_keys: stringArray(manifest, 'payload_keys', manifest.payload_keys),
    defaults,
    // 界面长面板要用的那份，也只有这一处
    param_schema: parseParamSchema(manifest, defaults),
    // 界面上「这次走哪个推理方法」要用的那两个：交的是名字列表，不是方法配置。别把 call.methods 整个透出去：那是宿主契约，前端碰它就成了第二份
    // 「方法有哪些」的事实。
    methods,
    default_method: defaultMethod,
    // 缺 = null（合成不受影响）：进程与环境的宿主（缺 = 这台引擎不由平台起，合法）、源码从哪来、钉在哪一版、底模从哪来、齐不齐（这里只是名片上
    // 「声明」的那部分，盘上有没有是 checkpoints.js 的活）。
    runtime: parseRuntime(manifest, defaulted),
    // 平台替名片答的键（路径），界面据此标「平台默认」，第 5 步试跑后写回实测值。
    defaulted,
    upstream: parseUpstream(manifest),
    models: parseModels(manifest),
    // 这台引擎要用户选几个权重、各叫什么。名片里就写这一样（"weights": ["a", "b"] 两个位，或 "weights": 1 一个位），位置、后缀、版本都不用写。缺 =
    // 空数组 = 「这台引擎不需要用户选模型」，不是出错。一个位还可以带 param =「选中的那份用哪个参数名发给引擎」；不写 = 运行中换不了。
    weight_slots: weightSlots,
  }
}

// parseParamSchema 单独导出，是为了让那些「写重了/写漏了要抛」能被直接测到。
module.exports = { resolveEngineProfile, parseParamSchema, parseRuntime, parseUpstream, parseModels, DEFAULTS, isSharedHost }
