'use strict'

// 把「平台的词」翻成「这台引擎的词」，然后拼成请求体。
// 三件事的唯一来源是 engines/<id>/manifest.json：maps（平台的词 → 这台引擎的键名，
// 没写的词 = 这台引擎没这个概念，不发）、payload_keys（cfg 透传白名单）、defaults
// （这台引擎的默认值，只填没人填过的键）。
// 本文件里不允许出现任何具体引擎的名字或私有键名（payload.node.test.js 有守卫盯着）。

// 平台词汇表：平台唯一认识的一组概念。加引擎不加词，加引擎只是给这些词换一个说法。
// 分成两组，因为它们的空值含义不同，这个区分决定行为一不一致：CORE 只要名片映射了
// 就一定发，哪怕值是空字符串；OPTIONAL 的 undefined / null / "" 一律不发。
const CORE_KEYS = ['text', 'text_lang', 'reference_audio', 'reference_text', 'reference_lang']
const OPTIONAL_KEYS = ['aux_reference_audio', 'speed', 'seed', 'media_type', 'streaming']
const CANONICAL_KEYS = [...CORE_KEYS, ...OPTIONAL_KEYS]

function payloadError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// 可发送的判据：undefined / null / "" 不发。
// 注意 false 和 0 是要发的（布尔开关与随机种子都有意义），所以不能写成 `if (v)`。
function isSendable(v) {
  return v !== undefined && v !== null && v !== ''
}

// 按名片把一次调用拼成这台引擎的请求体。
// 叠加顺序（后面的盖前面的）：canonical（按 maps 换名）→ cfg 白名单透传 → 配方里这台
// 引擎的参数格子（跳过 maps 的值）→ defaults（只填没人填过的键）。
// 第 3 步只跳一张名单：maps 的值 = 这张名片里由平台占用的键。格子带着同名键时不许
// 反超平台算好的值（否则 meta 记平台 seed、引擎收格子 seed，Rerun 复现不了）。
// 名单之外一个键都不看：平台只校验格子非空，键名写错了引擎自己会报错，那比瞎猜准。
// 第 4 步放在最后：defaults 的语义是「没人管的时候用它」，放最前就反了。
function assembleEnginePayload({ profile, canonical = {}, cfg = {}, engineParams = {} }) {
  const maps = (profile && profile.maps) || {}
  const payloadKeys = (profile && profile.payload_keys) || []
  const defaults = (profile && profile.defaults) || {}

  // text 是唯一一个「没有它就没有这次调用」的词。名片不说它叫什么，请求体的第一个键
  // 就拼不出来：这时候报错比发一个引擎看不懂的东西过去有用得多。
  if (!maps.text) {
    throw payloadError('ENGINE_MANIFEST_INCOMPLETE',
      `引擎 ${(profile && profile.id) || '?'} 的 manifest.json 缺少 maps.text：` +
      '平台不知道「待合成文本」在该引擎中对应的键名。' +
      `请在 ${(profile && profile.dir) || 'engines/<id>'}/manifest.json 的 maps 段中补充该字段。`,
      { id: profile && profile.id, missing: 'maps.text' })
  }

  const payload = {}

  // 1) 平台的词 → 引擎的键名。名片没映射的词 = 这台引擎没这个概念，直接跳过。
  //    跳过不是「丢弃」：把 text_lang 发给一台没有语言概念的引擎，好一点的当场 400，
  //    差一点的静默忽略，后者正是要消灭的那类失败。
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

  // 3) 配方里这台引擎的参数格子：原样盖上去，但 maps 的值是平台占用的键，格子不许反超。
  const ownedKeys = new Set(Object.values(maps))
  if (engineParams && typeof engineParams === 'object' && !Array.isArray(engineParams)) {
    for (const [k, v] of Object.entries(engineParams)) {
      if (v === undefined) continue
      if (ownedKeys.has(k)) continue
      payload[k] = v
    }
  }

  // 4) 名片上的默认值，只填没人填过的
  for (const [k, v] of Object.entries(defaults)) {
    if (payload[k] === undefined) payload[k] = v
  }

  return payload
}

// 某个平台词在这台引擎那里叫什么。没这个概念时返回 ""。
// 给平台侧「拼完之后还要再动一下请求体」的地方用：它们一律问名片要键名。
function engineKey(profile, canonicalKey) {
  const maps = (profile && profile.maps) || {}
  return maps[canonicalKey] || ''
}

// 这个引擎原生键名允不允许从平台侧透传过去。不在白名单上就别发。
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
