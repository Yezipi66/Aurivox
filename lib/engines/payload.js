'use strict'

// ---------------------------------------------------------------------------
//  Engine payload — 把「平台的词」翻成「这台引擎的词」，然后拼成请求体
// ---------------------------------------------------------------------------
// 契约 v2 第 1c 步。在这个文件出现之前，请求体是在 server.js 的
// buildTtsPayload 里**按 GPT-SoVITS 的形状硬拼**的：
//
//   payload.text_lang / ref_audio_path / prompt_text / prompt_lang
//                                      ← 这四个键名是 GPT-SoVITS 的方言
//   TTS_PASS_THROUGH_KEYS（23 个）      ← 整张表全是 GPT-SoVITS 的词汇
//   14 行 `if (payload.x === undefined) payload.x = ...`
//                                      ← 平台在替 GPT-SoVITS 决定它的默认值
//
// 后果是可证的：IndexTTS2 的 shim 对不认识的键**直接 400**
// （engines/indextts2/shim.py:382-392「未知键拦下不放行」），所以那个
// GPT-SoVITS 形状的请求体发过去，会被一次性列出二十来个 unknown parameter。
// 配方能存 indextts2，但调不动 —— 割线就卡在这里。
//
// 从这里开始，三件事的唯一来源是 engines/<id>/manifest.json：
//
//   maps         平台的词 → 这台引擎的键名。没写的词 = 这台引擎没这个概念，不发。
//   payload_keys 允许从 cfg 透传过去的**引擎原生**键名白名单。
//   defaults     这台引擎的默认值（引擎原生键名），只填没人填过的键。
//
// ⚠ 本文件里**不允许出现任何具体引擎的名字或任何一台引擎的私有键名**
//   （和 registry.js / profile.js 同一条纪律，payload.node.test.js 有守卫盯着）。
//   下面 CANONICAL_KEYS 里的名字是**平台自己的词**，不是谁家的方言。

// ---------------------------------------------------------------------------
//  平台词汇表
// ---------------------------------------------------------------------------
// 这是平台唯一认识的一组概念。加引擎不加词，加引擎只是给这些词换一个说法。
//
// 分成两组，因为它们的"空值"含义不同 —— 这个区分不是洁癖，它决定了搬家前后
// 行为一不一致：
//
//   CORE     只要名片映射了就一定发，**哪怕值是空字符串**。
//            搬家前 buildTtsPayload 的头五行就是无条件写死这五个键的，
//            其中 prompt_text 在没有参考文本时就是 ""，而且确实发了出去。
//            若照 OPTIONAL 的规矩把空值丢掉，请求体会少一个键 —— 那是改行为。
//
//   OPTIONAL undefined / null / "" 一律不发，交给 defaults 或引擎自己兜。
//            搬家前它们走的是白名单透传那一段，那段的过滤条件正是这三样。
const CORE_KEYS = ['text', 'text_lang', 'reference_audio', 'reference_text', 'reference_lang']
const OPTIONAL_KEYS = ['aux_reference_audio', 'speed', 'seed', 'media_type', 'streaming']
const CANONICAL_KEYS = [...CORE_KEYS, ...OPTIONAL_KEYS]

function payloadError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// 搬家前那段白名单透传的过滤条件，原样保留：
//   if (cfg[key] !== undefined && cfg[key] !== null && cfg[key] !== "")
// ⚠ 注意 false 和 0 是要发的（split_bucket:false、seed:0 都有意义），
//   所以这里**不能**写成 `if (v)`。搬家时这一步最容易顺手写错。
function isSendable(v) {
  return v !== undefined && v !== null && v !== ''
}

/**
 * 按名片把一次调用拼成这台引擎的请求体。
 *
 * 叠加顺序（后面的盖前面的）：
 *   1. canonical  平台的词，按 maps 换名
 *   2. cfg 透传   payload_keys 白名单内的引擎原生键
 *   3. engineParams  用户在配方 engine_params[<id>] 格子里写的，**不过滤**
 *   4. defaults   只填还没人填过的键
 *
 * 第 3 步为什么不过滤：Owner 2026-08-23 定的规矩 —— 平台只校验格子非空，
 * 不看里面。键名写错了引擎自己会报错，那个报错比我们瞎猜的准（IndexTTS2 的
 * shim 就会把拼错的键名逐个列出来）。平台是搬运工，不是翻译。
 *
 * 第 4 步为什么放在最后而不是最前：defaults 的语义是「没人管的时候用它」，
 * 搬家前那 14 行也是 `if (payload.x === undefined)`。放最前会变成「默认值
 * 优先」，那是反的。
 *
 * @param {object}   profile       resolveEngineProfile 的产物
 * @param {object}   canonical     平台词汇表里的值，见 CANONICAL_KEYS
 * @param {object}   [cfg]         合成配置（键名是引擎原生的，历史形状）
 * @param {object}   [engineParams] 配方里这台引擎的参数格子
 * @throws ENGINE_MANIFEST_INCOMPLETE 名片没说 text 该叫什么
 */
function assembleEnginePayload({ profile, canonical = {}, cfg = {}, engineParams = {} }) {
  const maps = (profile && profile.maps) || {}
  const payloadKeys = (profile && profile.payload_keys) || []
  const defaults = (profile && profile.defaults) || {}

  // text 是唯一一个「没有它就没有这次调用」的词。名片不说它叫什么，我们连
  // 请求体的第一个键都拼不出来 —— 这时候报错，比发一个引擎看不懂的东西过去
  // 然后收一句模糊的上游 400 有用得多。
  if (!maps.text) {
    throw payloadError('ENGINE_MANIFEST_INCOMPLETE',
      `引擎 ${(profile && profile.id) || '?'} 的名片缺少 maps.text —— ` +
      '平台不知道「要合成的文本」在这台引擎那里叫什么键名。' +
      `请在 ${(profile && profile.dir) || 'engines/<id>'}/manifest.json 的 maps 段里补上这一行。`,
      { id: profile && profile.id, missing: 'maps.text' })
  }

  const payload = {}

  // 1) 平台的词 → 引擎的键名。名片没映射的词 = 这台引擎没这个概念，直接跳过。
  //    跳过不是"丢弃"：把 text_lang 发给一台没有语言概念的引擎，好一点的当场
  //    400，差一点的静默忽略 —— 后者正是我们花了整整一刀去消灭的那类失败。
  for (const key of CORE_KEYS) {
    const target = maps[key]
    if (!target) continue
    const v = canonical[key]
    if (v === undefined) continue
    payload[target] = v
  }
  for (const key of OPTIONAL_KEYS) {
    const target = maps[key]
    if (!target) continue
    const v = canonical[key]
    if (!isSendable(v)) continue
    payload[target] = v
  }

  // 2) cfg 白名单透传（引擎原生键名）
  for (const key of payloadKeys) {
    const v = cfg[key]
    if (!isSendable(v)) continue
    payload[key] = v
  }

  // 3) 配方里这台引擎的参数格子 —— 原样盖上去，一个键都不看
  if (engineParams && typeof engineParams === 'object' && !Array.isArray(engineParams)) {
    for (const [k, v] of Object.entries(engineParams)) {
      if (v === undefined) continue
      payload[k] = v
    }
  }

  // 4) 名片上的默认值，只填没人填过的
  for (const [k, v] of Object.entries(defaults)) {
    if (payload[k] === undefined) payload[k] = v
  }

  return payload
}

/**
 * 某个平台词在这台引擎那里叫什么。没这个概念时返回 ""。
 *
 * 给平台侧那几处「拼完之后还要再动一下请求体」的地方用（流式分支要改容器、
 * 辅助参考音频要解析成绝对路径）。它们过去直接写引擎的键名，现在问名片要。
 */
function engineKey(profile, canonicalKey) {
  const maps = (profile && profile.maps) || {}
  return maps[canonicalKey] || ''
}

/** 这个引擎原生键名允不允许从平台侧透传过去。不在白名单上就别发。 */
function acceptsKey(profile, engineNativeKey) {
  const keys = (profile && profile.payload_keys) || []
  return keys.includes(engineNativeKey)
}

module.exports = {
  assembleEnginePayload,
  engineKey,
  acceptsKey,
  CANONICAL_KEYS,
  CORE_KEYS,
  OPTIONAL_KEYS,
}
