'use strict'

// ---------------------------------------------------------------------------
//  参数表只有一份 —— 平台侧的唯一入口（契约 C11）
// ---------------------------------------------------------------------------
//
// C11 的原文（docs/ENGINE_CONTRACT.md §8）：
//
//   「参数表只有一份。判据：lib\ 和 server.js 里搜不到任何引擎参数名的
//     硬编码清单。加一条守卫测试：仓库里再出现第二份写死的参数清单就变红。」
//
// 那条守卫测试今天才补上（param_table_guard.node.test.js），所以在此之前
// 副本一直在无声地长。开工前实测：lib/ + server.js 里 **92 处 / 7 个文件**
// 各自抄了一份 GPT-SoVITS 的参数清单。
//
// ⛔ 重复本身不是问题，问题是它们会**各自漂移，而漂移不报错**。已经漂出来的：
//
//   batch_size 的默认值一共有四份 ——
//     engines/gpt-sovits/manifest.json  4   ← 我们自己的调优决策，配了
//                                             AURIVOX_TTS_BATCH_SIZE 旋钮
//     server.js DEFAULT_ADVANCED_PARAMS 跟着旋钮走（唯一对的那份）
//     lib/recipeStore.js:289            1   ← 存配方时又写死了 1
//     web GenerateTab.jsx useState      1   ← 无条件发出去，把上面全盖掉
//
//   ⇒ 那个 4 和那个旋钮在 webui 路径上**从来没有生效过**，而且没有任何
//     一条测试会因此变红。这就是 C11 要杀的东西。
//
// 从今天起，「这台引擎有哪些参数 / 叫什么 / 默认多少 / 界面上怎么显示」
// 只有一个答案来源：**名片**。本文件是平台读名片的唯一入口。
//
// ⛔ 本文件里不允许出现任何具体引擎的名字，也不允许出现任何具体参数名
//    （契约 §5.5：平台只搬运，不翻译）。守卫测试会扫。

const { listEngines, requireEngine } = require('./registry')
const { resolveEngineProfile } = require('./profile')

// 平台自己的词汇。这些**不是**任何一台引擎的参数：它们是平台在把活派给
// 引擎之前自己要读的东西（怎么切、切完怎么拼、存哪、算哪条配方）。
//
// 它们凭什么写在这儿而不是名片里：名片描述的是「这台引擎认得什么」，而
// 这些键在**一台引擎都没装**的时候依然有意义。实测两张名片的 param_keys
// 交集是 8 个词，前 8 项就是它们。
const PLATFORM_REQUEST_KEYS = Object.freeze([
  'format', 'split', 'max_chars', 'concat', 'silence_ms',
  'media_type', 'engine_batch', 'voice_label',
  // 平台侧的调用身份与来源，从来不发给引擎
  'recipe_id', 'source',
  // 参考音频：平台负责把它解析成这台机器上的绝对路径，之后才按名片的
  // maps 改名送出去
  'ref_audio',
  // seed 由平台 resolveSeed() 把 -1 变成具体数字并写进 meta.json（Rerun
  // 靠它复现），所以平台必须认识它，即便引擎没有 seed 概念
  'seed',
  // 引擎契约 v2：去哪台引擎、带哪包参数
  'engine_id', 'engine_params',
])

/** 这台引擎认得的参数名（名片 param_keys 原样）。 */
function engineParamKeys (engineId) {
  return requireEngine(engineId).param_keys.slice()
}

/**
 * 这台机器上**所有已装引擎**参数名的并集。
 *
 * ⭐ 取并集而不是「当前选中那台的」，是因为调用这个函数的地方（Flow 的入参
 * 白名单）在放行的那一刻还不知道图会跑到哪台引擎上 —— 选引擎是别的节点的
 * 事。取交集或取某一台的，会把下游作者的参数在白名单上**静默吃掉**：节点上
 * 填了、跑起来没有。乙那一刀在 flowgraph/service.js 里踩过同一个问题，
 * 结论一样。
 */
function allEngineParamKeys () {
  const out = new Set()
  for (const m of listEngines()) {
    for (const k of m.param_keys || []) out.add(k)
  }
  return out
}

/** Flow / 老合成路径的入参白名单：平台词 + 所有已装引擎认得的词。 */
function acceptedRequestKeys () {
  const out = new Set(PLATFORM_REQUEST_KEYS)
  for (const k of allEngineParamKeys()) out.add(k)
  return out
}

/**
 * 这台引擎要在界面上长出来的那些格子（契约 §5.4 的 params.schema）。
 * 返回数组，顺序 = 名片里的书写顺序 = 界面上从上到下的顺序。
 */
function engineUiSchema (engineId, env = process.env) {
  return resolveEngineProfile(engineId, env).param_schema
}

/**
 * 这台引擎每个格子的默认值 —— { 参数名: 默认值 }。
 *
 * ⭐ 默认值可能来自两处，语义不同（见 profile.js 里 schemaEntry 的注释）：
 *   defaults.<键>              平台每次合成都发这个值，界面开没开都发
 *   params.schema.<键>.default 只是界面格子的初值，不因此多发一个键
 * 这里把两者摊平成「界面/存档该用哪个数」，因为对**这个**问题两者答案相同。
 * 需要区分时看条目上的 sends_always。
 */
function engineUiDefaults (engineId, env = process.env) {
  const out = {}
  for (const entry of engineUiSchema(engineId, env)) out[entry.name] = entry.default
  return out
}

/**
 * 这台引擎「一次合成用得上的全部可调值」及其默认值 —— { 参数名: 默认值 }。
 *
 * = 名片 defaults（平台每次都发的那些，已过 defaults_env 环境变量旋钮）
 * ∪ 名片 params.schema 里那些只当界面初值的
 *
 * 谁用它：advanced_params.json 的兜底、存配方时的兜底、存音色时的兜底。
 * 这三处原本各写了一份，值还不一样（batch_size 一处 4 一处 1）。
 */
function engineParamDefaults (engineId, env = process.env) {
  const profile = resolveEngineProfile(engineId, env)
  const out = { ...profile.defaults }
  for (const entry of profile.param_schema) {
    // schema 里只当界面初值的，defaults 里没有，补上；两边都有的以
    // defaults 为准（值本来就相同 —— profile.js 强制二选一）。
    if (!(entry.name in out)) out[entry.name] = entry.default
  }
  return out
}

/**
 * 把 cfg 里的引擎旋钮补进已拼好的请求体。
 *
 * 为什么需要「补」：拼请求体那一段会把空串 / null 过滤掉，而布尔 false 必须
 * 显式送达（不发和发 false 在引擎那边是两件事）。
 *
 * 这段逻辑原本在**三个地方**各写了一遍，而且每处都只补了两三个写死的键
 * （server.js 补 2 个、synthesis.js 的流式分支补 2+2 个、非流式分支补 2 个）。
 * 结果就是：同一个参数，webui 发得出去、流式发不出去，没人知道。
 *
 * ⭐ 名片没有这个概念（不在 payload_keys 上）就不发 —— 硬塞过去，宽松的引擎
 *   静默忽略、严格的引擎当场 400，两种都不是我们要的。
 */
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

/**
 * 按名片声明的类型把一个外来的（HTTP body 里的）字符串转成该参数的形状。
 * 转不成就返回 undefined = 当作没填，绝不猜。
 */
function coerceIncoming (entry, raw) {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (entry.type === 'integer') {
    const n = parseInt(raw, 10)
    return Number.isInteger(n) ? n : undefined
  }
  if (entry.type === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  if (entry.type === 'boolean') {
    if (raw === 'false' || raw === '0') return false
    if (raw === 'true' || raw === '1') return true
    return typeof raw === 'boolean' ? raw : undefined
  }
  if (entry.type === 'enum') {
    const ok = (entry.choices || []).some((c) => c.value === raw)
    return ok ? raw : undefined
  }
  return undefined
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
