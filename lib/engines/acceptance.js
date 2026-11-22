'use strict'

// 第 5 步验收记录（acceptance）：磁盘上只有这一节记 A 级执行结果。
//
// 字段是收敛过的扁平标量，不嵌套字典、不设 schema（整张名片只有顶层
// contract_version 一个版本）。不写裸布尔、不存裸请求和绝对路径。
// 时效状态（unverified / stale）不落盘：那会变成一条会过期的假事实，
// 读取时拿当前契约指纹和记录里的比，现算。
//
// weights 不存哈希（大模型全量哈希太贵），只记「这次用了哪几份模型」：
// 位表复用平台的 weightSummary，值投影成相对引擎环境的相对路径。
// 本文件不出现任何具体引擎名。

const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const { isV011 } = require('./contract')

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

// 稳定序列化：键排序，数组保序。同一份对象无论字段顺序如何，哈希一致。
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k])
    return out
  }
  return value
}

/**
 * 契约指纹 = registration + invocation 的规范化哈希，排除 acceptance 防自指。
 * 名片改了任何注册/调用字段，哈希就变，旧验收记录当场过时。
 */
function contractHash(manifestV011) {
  const src = isV011(manifestV011) ? manifestV011 : null
  if (!src) return null
  return sha256(JSON.stringify(canonical({
    registration: src.registration || {},
    invocation: src.invocation || {},
  })))
}

// 请求摘要：只记键名和值的哈希，不存原文、不存绝对路径、不存参考音频内容。
function requestDigest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const keys = Object.keys(request).sort()
  const safe = {}
  for (const k of keys) {
    const v = request[k]
    // 值只留类型与长度/哈希，文本与音频路径都不原文落盘。
    if (typeof v === 'string') safe[k] = { type: 'string', sha256: sha256(v) }
    else if (typeof v === 'number' || typeof v === 'boolean') safe[k] = { type: typeof v }
    else if (v && typeof v === 'object') safe[k] = { type: 'object', sha256: sha256(JSON.stringify(canonical(v))) }
    else safe[k] = { type: 'null' }
  }
  return { keys, values: safe }
}

// 权重：把 weightSummary 的路径投影成相对引擎环境的相对路径。
// 引擎环境外的绝对路径不编相对路径，只留末段并标注 external。
function weightsOf(summary, engineCwd) {
  const list = Array.isArray(summary) ? summary : []
  const base = engineCwd ? String(engineCwd).replace(/\\/g, '/').replace(/\/+$/, '') : ''
  const out = {}
  for (const w of list) {
    if (!w || typeof w.name !== 'string') continue
    const p = String(w.path == null ? '' : w.path).replace(/\\/g, '/')
    if (!p) { out[w.name] = ''; continue }
    if (path.isAbsolute(p)) {
      out[w.name] = { external: true, value: p.split('/').filter(Boolean).pop() || '' }
      continue
    }
    if (base && (p === base || p.startsWith(base + '/'))) {
      out[w.name] = p.slice(base.length + (p === base ? 0 : 1))
    } else {
      // 相对项目根但不在引擎环境内（如 assets/...）：原样记，仍是相对路径。
      out[w.name] = p
    }
  }
  return out
}

// verifier 版本：verify_audio.py 内容的哈希前 12 位。校验器一改，判据就变，
// 记录要能说出当时是哪个判据跑出来的。这是真实文件，不编版本号。
function verifierOf(root) {
  const file = path.join(root, 'lib', 'engines', 'verify_audio.py')
  try {
    return sha256(fs.readFileSync(file, 'utf8')).slice(0, 12)
  } catch {
    return null
  }
}

/**
 * 构造一条验收记录。只在 A 级执行完成且拿到结论时调用。
 * @param {object} opts
 *   manifestV011  磁盘三节名片（投影前）
 *   profile       已解析的引擎 profile（拿 weight_slots）
 *   request       A 级真跑用的请求体（原始，不原文落盘）
 *   result        runAudioCheck 的返回（含 ok / duration_sec / error）
 *   engineCwd     唯一引擎环境目录（registration.environment.cwd）
 *   weightSummaryFn  权重汇总函数（注入，默认平台实现）
 *   root          项目根（算 verifier 哈希）
 */
function buildAcceptance(opts) {
  const o = opts || {}
  const result = o.result || {}
  const contract = contractHash(o.manifestV011)
  const summaryFn = typeof o.weightSummaryFn === 'function'
    ? o.weightSummaryFn : require('./weightSummary').weightSummary
  const summary = summaryFn((o.profile && o.profile.weight_slots) || [], o.request || {})
  const rec = {
    at: new Date().toISOString(),
    status: result.ok ? 'pass' : 'fail',
    contract,
    weights: weightsOf(summary, o.engineCwd),
    request: requestDigest(o.request),
    duration_sec: (typeof result.duration_sec === 'number' && Number.isFinite(result.duration_sec))
      ? result.duration_sec : null,
    verifier: verifierOf(o.root || path.resolve(__dirname, '..', '..')),
  }
  // 失败时记下探针报告的阶段；stage 直接取自探针返回值。
  if (!result.ok && result.stage) rec.error = String(result.stage)
  else if (!result.ok && result.code) rec.error = String(result.code)
  return rec
}

/**
 * 读取时效：unverified（没记录）/ stale（契约已变）/ pass / fail。
 * 只读现算，不写盘。
 */
function freshness(manifestV011) {
  const src = isV011(manifestV011) ? manifestV011 : null
  const acc = src && src.acceptance
  if (!acc || typeof acc !== 'object') return 'unverified'
  const current = contractHash(src)
  if (!acc.contract || acc.contract !== current) return 'stale'
  return acc.status === 'pass' ? 'pass' : (acc.status === 'fail' ? 'fail' : 'unverified')
}

module.exports = {
  buildAcceptance, contractHash, freshness, requestDigest, weightsOf, verifierOf, canonical,
}
