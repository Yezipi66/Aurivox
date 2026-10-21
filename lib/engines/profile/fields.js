'use strict'

// profile 解析的字段原语：缺字段报错、形状规整、路径相对性
// 这里每个函数只回答「这一个字段对不对」，不读名片里别的段、不做跨字段判断。
// 拆出来是为了让 lib/engines/profile.js 只留下解析流程本身。
// 纪律同 profile.js 顶部那条：本文件里不许出现任何具体引擎的名字。

function profileError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// 缺字段就报错，不回落。
// 理由不是洁癖：回落到默认值意味着「名片写错了」和「名片写对了」表现完全
// 一样，作者不会发现，直到有一天连到了别人的引擎上。报错是这里唯一能给出
// 「你少写了哪一行」这个信息的时刻，错过了就再也没有了。
function required(manifest, keyPath, value, hint) {
  if (value === undefined || value === null || value === '') {
    throw profileError('ENGINE_MANIFEST_INCOMPLETE',
      `引擎 ${manifest.id} 的 manifest.json 缺少 ${keyPath}：${hint}。` +
      `请在 ${manifest.dir}/manifest.json 中补充该字段；` +
      '平台不为其提供默认值（默认值会导致「写错」与「未写」表现一致）。',
      { id: manifest.id, missing: keyPath })
  }
  return value
}

function positiveInt(manifest, keyPath, value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 必须是正整数，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  return n
}

// 布尔位必须显式写 true/false。缺了要报错，所以不能用 `|| false` 兜。
function requiredBool(manifest, keyPath, value, hint) {
  if (typeof value !== 'boolean') {
    throw profileError(
      value === undefined ? 'ENGINE_MANIFEST_INCOMPLETE' : 'ENGINE_MANIFEST_INVALID_VALUE',
      value === undefined
        ? `引擎 ${manifest.id} 的 manifest.json 缺少 ${keyPath}：${hint}。请写明 true 或 false。`
        : `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 必须是 true 或 false，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  return value
}

// 参考音频时长约束。三种写法含义不同，不能混为一谈：
// null：明确声明「不限制」
// [min, max]：闭区间，秒
// 缺这个键：报错。「忘了写」和「不限制」必须能区分开，否则一个漏写
// 会静默变成「什么音频都收」，等到合成失败才发现。
function parseClipSeconds(manifest, value) {
  if (value === null) return null
  if (!Array.isArray(value) || value.length !== 2) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 capabilities.reference_clip_seconds 要么写 null（不限制），` +
      `要么写 [最短秒, 最长秒]，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: 'capabilities.reference_clip_seconds', value })
  }
  const min = Number(value[0])
  const max = Number(value[1])
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max <= min) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 reference_clip_seconds 区间不成立：${JSON.stringify(value)}（要求 0 ≤ 最短 < 最长）`,
      { id: manifest.id, key: 'capabilities.reference_clip_seconds', value })
  }
  return { min, max }
}

// 名片上的 maps / payload_keys / defaults：第 1c 步新增的三段。
// 这三段不在这里报"缺"，而是缺省成空。理由是它们的缺失有一个更靠后、
// 更准确的报错点：真正要拼请求体的时候（payload.js 会因为缺 maps.text 而抛，
// 并且能把「你少写了哪一行」指到具体文件）。在这里提前拦，会让一批只关心
// 地址和超时的调用方（换权重、健康检查）也被迫写全这三段。
// 但"缺省成空"不等于"随便"：realManifests.node.test.js 有一条体检，
// 盯着盘上每一张真名片都必须把这三段写全。空是给测试夹具用的，不是给真引擎的。
function plainObject(manifest, keyPath, value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 必须是一个对象，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  return value
}

function stringArray(manifest, keyPath, value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((k) => typeof k !== 'string' || !k)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 必须是一个非空字符串数组，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  return value.slice()
}

function relPath(manifest, keyPath, value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 必须是一段非空路径，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  // 绝对路径会让名片只在作者那台机器上成立，这正是契约 C3 禁止的事。
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(value)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 写成了绝对路径（${value}）` +
      'manifest.json 要能跟着项目复制到别的机器，路径必须是相对的（python/cwd 相对项目根，entry 相对 manifest.json 所在目录）。',
      { id: manifest.id, key: keyPath, value })
  }
  return value
}

module.exports = {
  profileError, required, positiveInt, requiredBool,
  parseClipSeconds, plainObject, stringArray, relPath,
}
