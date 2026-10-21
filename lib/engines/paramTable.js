'use strict'

// 参数表只有一份：平台侧的唯一入口（契约 C11）。「这台引擎有哪些参数 / 叫什么 / 默认多少 / 界面上怎么显示」
// 只有一个答案来源：名片。本文件里不许出现任何具体引擎的名字或参数名（契约 §5.5）。

const { listEngines, requireEngine } = require('./registry')
const { resolveEngineProfile } = require('./profile')
const { canonicalType, repeatOf } = require('./paramTypes')

// 平台自己的词汇：不是任何一台引擎的参数，是平台在把活派给引擎之前自己要读的东西。
// 这些键在一台引擎都没装的时候依然有意义，所以它们不在名片里。
const PLATFORM_REQUEST_KEYS = Object.freeze([
  'format', 'split', 'max_chars', 'concat', 'silence_ms',
  'media_type', 'engine_batch', 'voice_label',
  // 平台侧的调用身份与来源，从来不发给引擎
  'recipe_id', 'source',
  // 参考音频：平台负责解析成本机上的绝对路径，之后才按名片的 maps 改名送出去
  'ref_audio',
  // seed 由平台 resolveSeed() 把 -1 变成具体数字并写进 meta.json（Rerun 靠它复现），所以平台必须认识它。
  'seed',
  // 旧引擎接入实现：去哪台引擎、带哪包参数
  'engine_id', 'engine_params', 'memory_risk_confirmed',
  // 强制重新推理：跳过合成结果复用缓存的读。绝不能进 payload：进了就等于每勾一次就把整张缓存表作废。
  'force_resynth',
])

function engineParamKeys (engineId) {
  return requireEngine(engineId).param_keys.slice()
}

// 本机上所有已装引擎参数名的并集。调用它的地方（Flow 的入参白名单）在放行那一刻还不知道请求会跑到哪台
// 引擎上：取交集会把下游作者的参数静默吃掉。
function allEngineParamKeys () {
  const out = new Set()
  for (const m of listEngines()) {
    for (const k of m.param_keys || []) out.add(k)
  }
  return out
}

function acceptedRequestKeys () {
  const out = new Set(PLATFORM_REQUEST_KEYS)
  for (const k of allEngineParamKeys()) out.add(k)
  return out
}

// 这台引擎要在界面上长出来的格子（契约 §5.4 的 params.schema）：顺序 = 界面上的上下顺序。
function engineUiSchema (engineId, env = process.env) {
  return resolveEngineProfile(engineId, env).param_schema
}

// 这台引擎每个格子的默认值：{ 参数名: 默认值 }。默认值可能来自两处，语义不同（见 profile.js 里 schemaEntry
// 的注释）：defaults.<键> 每次合成都发；params.schema.<键>.default 只是界面初值。
function engineUiDefaults (engineId, env = process.env) {
  const out = {}
  for (const entry of engineUiSchema(engineId, env)) out[entry.name] = entry.default
  return out
}

// 这台引擎「一次合成用得上的全部可调值」及其默认值：{ 参数名: 默认值 }。
// = 名片 defaults（已过 defaults_env 旋钮）∪ 名片 params.schema 里只当界面初值的。
function engineParamDefaults (engineId, env = process.env) {
  const profile = resolveEngineProfile(engineId, env)
  const out = { ...profile.defaults }
  for (const entry of profile.param_schema) {
    if (!(entry.name in out)) out[entry.name] = entry.default
  }
  return out
}

// 把 cfg 里的引擎旋钮补进已拼好的请求体。拼请求体那一段会把空串 / null 过滤掉，而布尔 false
// 必须显式送达：不发和发 false 在引擎那边是两件事。
function applyEngineKnobs (payload, profile, cfg) {
  const { acceptsKey } = require('./payload')
  for (const entry of (profile.param_schema || [])) {
    const key = entry.name
    if (cfg[key] === undefined) continue
    if (!acceptsKey(profile, key)) continue
    payload[key] = cfg[key]
  }
  return payload
}

// 一个文件/路径值的形状判定，两种都收：裸字符串，或 { base:'asset'|'external', path } 这种平台
// 托管路径的可移植写法（pathResolver 按形状工作，不认字段名）。
function coerceFileValue (raw) {
  if (typeof raw === 'string') return raw === '' ? undefined : raw
  if (raw && typeof raw === 'object' && typeof raw.path === 'string' && raw.path !== '') {
    return raw
  }
  return undefined
}

// 五种预设样式各自的收取规则。只判形状。
function coerceScalar (entry, raw) {
  if (raw === undefined || raw === null || raw === '') return undefined

  // 名片里的老写法（integer / enum / path / string）在 profile.js 那一刻就折成了五种之一；这里仍然认老词，
  // 是因为本函数也被手写的 entry 调用：收取侧比声明侧宽一点。
  const type = canonicalType(entry.type) || entry.type

  if (type === 'number') {
    // 「是不是整数」是数字的一味，不是一种样式：int 那一味要 parseInt，不然 7.5 会悄悄发给只吃整数的引擎。
    if (entry.int === true || entry.type === 'integer') {
      const n = parseInt(raw, 10)
      return Number.isInteger(n) ? n : undefined
    }
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  if (type === 'boolean') {
    if (raw === 'false' || raw === '0') return false
    if (raw === 'true' || raw === '1') return true
    return typeof raw === 'boolean' ? raw : undefined
  }
  if (type === 'select') {
    // 名片写死了选项 ⇒ 只收在册的。选项来自平台托管库（source）时一律放行：那份名单要运行时
    // 扫盘才准，在这儿拿一份旧名单去卡，症状是选中的项不生效，而且不报错。
    if (entry.source) return coerceFileValue(raw) !== undefined ? raw : undefined
    const ok = (entry.choices || []).some((c) => c.value === raw)
    if (ok) return raw
    // 名片开了 allow_custom：库里没有的也让填。
    if (entry.allow_custom === true) return coerceFileValue(raw)
    return undefined
  }
  if (type === 'file') {
    return coerceFileValue(raw)
  }
  if (type === 'text') {
    // 文本原样送到引擎：不 trim、不截断、不换行归一（契约 §5.5）。
    return typeof raw === 'string' ? raw : String(raw)
  }
  return undefined
}

// 按名片声明的类型把一个外来的（HTTP body 里的）值转成该参数的形状。转不成就返回 undefined
// = 当作没填，绝不猜。repeat / multi 的值是数组，逐格按上面的标量规则收。
// repeat 的格子数由名片定死（情绪向量永远 8 维）⇒ 长度不匹配就整条不要，不补零也不截断：少一维
// 发过去，引擎通常会接受，然后声音不对而没人知道。multi 的勾选数由用户定 ⇒ 长度不限。
function coerceIncoming (entry, raw) {
  if (!entry) return undefined
  const repeat = repeatOf(entry)
  const wantsArray = repeat > 1 || entry.multi === true

  if (!wantsArray) return coerceScalar(entry, raw)

  if (!Array.isArray(raw)) return undefined
  const out = raw.map((x) => coerceScalar(entry, x))
  if (out.some((x) => x === undefined)) return undefined
  if (repeat > 1 && out.length !== repeat) return undefined
  if (out.length === 0) return undefined
  return out
}

module.exports = {
  PLATFORM_REQUEST_KEYS,
  engineParamDefaults,
  applyEngineKnobs,
  coerceIncoming,
  engineParamKeys,
  allEngineParamKeys,
  acceptedRequestKeys,
  engineUiSchema,
  engineUiDefaults,
}
