'use strict'

// ===========================================================================
//  上游推理失败 —— 说出真正出事的那台引擎的名字
// ===========================================================================
//
// 契约 v2 第 3 步（甲）。这句话过去在三个地方各写了一遍，而且都把引擎名
// 硬编码成了 "GPT-SoVITS"：
//
//   server.js:890            老合成路径（webui）
//   lib/routes/synthesis.js  /v1/audio/speech 的非流式与流式两支
//
// 为什么是缺陷：请求今天已经按名片发给任意一台引擎了（第 1b/1c 步），
// 但一出错，平台一律自称 GPT-SoVITS。下游作者接了别的引擎，外部调用方
// （SillyTavern 这类走 OpenAI 兼容接口的）看到的报错会把他指向一台**可能
// 根本没启动、甚至没装**的引擎。诊断信息指错人，比没有诊断信息更费时间。
//
// ⭐⭐ 但这句话不只是给人看的：`services/synthesisService.js` 过去靠正则
//    匹配 "GPT-SoVITS /tts failed (\d+):" 把上游的原始报错从外壳里抠出来。
//    也就是说**一句人类可读的文案同时充当了机器接口**。只改文案不改正则，
//    后果是正则静默失配 ⇒ webui 不再剥壳、用户看到一坨带前缀的原文，
//    而且没有任何东西会喊一声。
//
//    所以这里的做法是：**把承重从字符串搬到属性上**。文案随人怎么写，
//    机器读 err.upstreamStatus / err.upstreamBody。正则留在那边当兜底，
//    一个字都不改 —— 老的、第三方的、还没接过来的抛错点仍然管用。
//
// 名字取 `label`，不取 `id`，也不写成 "Label (id)"：老路径引擎的名片上
// label 就是 "GPT-SoVITS"，所以对今天的用户来说**这几句话一个字节都没变**。
// 「行为不变」有据可查，比多印一个 id 值钱。

// 文案里这两个片段是 synthesisService.js 那条兜底正则认得的形状。
// 改它们要连那边一起改 —— 但现在即使漏改，结构化字段也已经先一步接住了。
const FAILED = '/tts failed'
const STREAMING_FAILED = '/tts streaming failed'

/**
 * 名片上写的引擎名。名片一定有 label（profile.js 保证 `label || id`），
 * 这里的兜底是为了防「压根没解析出名片」那种调用。
 */
function engineName (profile) {
  const raw = profile && (profile.label || profile.id)
  return (typeof raw === 'string' && raw.trim()) ? raw.trim() : 'TTS engine'
}

/**
 * 上游返回了 >=400。
 *
 * @param {object} profile   引擎名片（解析失败时给 null 也行）
 * @param {number} statusCode 上游 HTTP 状态码
 * @param {*}      body       上游响应正文（Buffer / string 都收）
 * @param {{streaming?: boolean}} [opts]
 * @returns {Error} 带 upstreamStatus / upstreamBody / engineId / engineLabel
 */
function upstreamFailure (profile, statusCode, body, opts = {}) {
  const text = body === undefined || body === null ? '' : String(body)
  const what = opts.streaming ? STREAMING_FAILED : FAILED
  const err = new Error(`${engineName(profile)} ${what} (${statusCode}): ${text}`)
  // ⭐ 承重的是这两个字段，不是上面那句话。
  err.upstreamStatus = Number(statusCode)
  err.upstreamBody = text
  err.engineId = (profile && profile.id) || null
  err.engineLabel = engineName(profile)
  return err
}

// ===========================================================================
//  传输层失败 —— 引擎压根没回话
// ===========================================================================
//
// ⛔ 甲刀（上面那两个函数）的承重是 `err.upstreamBody`：引擎**回了话但报错**
//    时，把它的原话剥出来。可 ECONNREFUSED / ETIMEDOUT / EHOSTUNREACH 是
//    **传输层**失败 —— TCP 都没建起来，根本没有 upstreamBody 可剥。
//
//    于是这类错误绕过了甲刀，一路落到通用兜底，用户看到的是：
//        {"error":"Internal server error"}
//    而服务端日志里明明白白写着 `connect ECONNREFUSED 127.0.0.1:9880`。
//
//    2026-08-23 实测撞到：引擎没启动时平台什么都不说。这恰恰是**新用户和
//    下游插件作者第一次会撞到的错误** —— 装了自己的引擎、忘了启动，平台
//    既不说是哪台引擎，也不说是哪个地址连不上。对「下游作者零代码接引擎」
//    这个目标来说，这比报错文案写错更伤。
//
// ⭐ 和甲刀同一个手法：承重放属性（transport / engineId / baseUrl），
//    文案只是给人看的。这里**新增**字段而不改 upstreamStatus/upstreamBody
//    的语义 —— 那两个字段的含义仍然是「上游回了话」，调用方靠它们区分
//    「引擎拒绝了请求」和「引擎不在」是两种完全不同的处置。

// Node 在传输层抛出来的 code，逐个给一句人话。列表之外的 code 不猜，
// 原样带上 —— 猜错的诊断信息比没有诊断信息更费时间。
const TRANSPORT_HINTS = Object.freeze({
  ECONNREFUSED: 'the engine is not running (nothing is listening on that address)',
  ENOTFOUND: 'the host name could not be resolved',
  EHOSTUNREACH: 'the host is unreachable',
  ENETUNREACH: 'the network is unreachable',
  ECONNRESET: 'the engine closed the connection mid-request',
  ETIMEDOUT: 'the engine did not respond in time',
  EPIPE: 'the connection was closed while sending the request',
})

/**
 * 这个错误是「没连上」而不是「连上了但被拒」吗？
 *
 * ⚠ 超时有两个来源：Node socket 层的 ETIMEDOUT，以及 client.js:70 自己
 *   `req.destroy()` 后抛的 `Request timed out`（那个没有 code）。两个都算
 *   传输层失败，否则自建超时那条路仍然不点名。
 */
function isTransportError (err) {
  if (!err) return false
  if (typeof err.code === 'string' && Object.prototype.hasOwnProperty.call(TRANSPORT_HINTS, err.code)) return true
  return err.message === 'Request timed out'
}

/**
 * 连不上那台引擎。
 *
 * @param {object} profile 引擎名片（解析失败给 null 也行）
 * @param {Error}  cause   Node 抛出来的原始错误
 * @param {{baseUrl?: string}} [opts] 实际尝试连接的地址（名片上的 base_url）
 * @returns {Error} 带 transport / transportCode / engineId / engineLabel / baseUrl
 */
function transportFailure (profile, cause, opts = {}) {
  const code = (cause && typeof cause.code === 'string') ? cause.code : ''
  const where = opts.baseUrl || (profile && profile.base_url) || ''
  const hint = TRANSPORT_HINTS[code] ||
    (cause && cause.message === 'Request timed out' ? TRANSPORT_HINTS.ETIMEDOUT : '')
  // 说清三件事：哪台引擎、哪个地址、什么毛病。缺哪件就不写哪件，不编。
  const parts = [`Cannot reach ${engineName(profile)}`]
  if (where) parts.push(`at ${where}`)
  const tail = hint || (cause && cause.message) || 'the connection failed'
  const err = new Error(`${parts.join(' ')} — ${tail}${code ? ` (${code})` : ''}`)
  // ⭐ 承重的是这几个字段。
  err.transport = true
  err.transportCode = code || null
  err.engineId = (profile && profile.id) || null
  err.engineLabel = engineName(profile)
  err.baseUrl = where || null
  err.cause = cause
  return err
}

/**
 * 上游返回 200 但正文是空的 —— 对调用方来说和失败没区别，同样要点名。
 */
function emptyAudioFailure (profile) {
  const err = new Error(`${engineName(profile)} returned empty audio`)
  err.engineId = (profile && profile.id) || null
  err.engineLabel = engineName(profile)
  return err
}

module.exports = {
  engineName,
  upstreamFailure,
  emptyAudioFailure,
  isTransportError,
  transportFailure,
  TRANSPORT_HINTS,
  FAILED,
  STREAMING_FAILED,
}
