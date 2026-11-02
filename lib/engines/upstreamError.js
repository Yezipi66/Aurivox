'use strict'

// 上游推理失败：说出真正出事的那台引擎的名字。
// 承重放在属性上（upstreamStatus / upstreamBody / transport / engineId），文案只是给人看的。
// 名字取 label 不取 id：名片上 label 一定有（profile.js 保证 label || id）。
// 文案里那两个片段是 synthesisService.js 兜底正则认得的形状，改它们要连那边一起改；
// 漏改也只是正则失配，结构化字段仍然管用。
const FAILED = '/tts failed'
const STREAMING_FAILED = '/tts streaming failed'

// 名片上写的引擎名。兜底是为了防「压根没解析出名片」那种调用。
function engineName (profile) {
  const raw = profile && (profile.label || profile.id)
  return (typeof raw === 'string' && raw.trim()) ? raw.trim() : 'TTS engine'
}

// 上游返回了 >=400。err 上带 upstreamStatus / upstreamBody / engineId / engineLabel。
function upstreamFailure (profile, statusCode, body, opts = {}) {
  const text = body === undefined || body === null ? '' : String(body)
  const what = opts.streaming ? STREAMING_FAILED : FAILED
  const err = new Error(`${engineName(profile)} ${what} (${statusCode}): ${text}`)
  err.upstreamStatus = Number(statusCode)
  err.upstreamBody = text
  err.engineId = (profile && profile.id) || null
  err.engineLabel = engineName(profile)
  return err
}

// 传输层失败：引擎压根没回话，TCP 没建起来，没有上游正文可剥。
// 和上游失败分开是因为处置完全不同：upstreamStatus / upstreamBody 的含义仍然是
// 「上游回了话」，调用方靠这两个字段区分「引擎拒绝了请求」与「引擎不在」。
// Node 在传输层抛出来的 code，逐个给一句人话；列表之外的 code 不猜，
// 猜错的诊断信息比没有诊断信息更费时间。
const TRANSPORT_HINTS = Object.freeze({
  ECONNREFUSED: 'the engine is not running (nothing is listening on that address)',
  ENOTFOUND: 'the host name could not be resolved',
  EHOSTUNREACH: 'the host is unreachable',
  ENETUNREACH: 'the network is unreachable',
  ECONNRESET: 'the engine closed the connection mid-request',
  ETIMEDOUT: 'the engine did not respond in time',
  EPIPE: 'the connection was closed while sending the request',
  // 走 stdio 的引擎（engineChannel.js / stdioTransport.js）：没有 TCP，失败落在管道或进程上。
  ENGINE_NOT_RUNNING: 'the engine process is not running',
  ENGINE_STDIO_CLOSED: 'the engine process exited or its pipe closed (see logs/<engine id>.err.log)',
  ENGINE_STDIO_TIMEOUT: 'the engine did not respond in time',
})

// 这个错误是「没连上」而不是「连上了但被拒」吗？
// 超时有两个来源：Node socket 层的 ETIMEDOUT，以及 client.js 自己
// req.destroy() 后抛的 `Request timed out`（那个没有 code）。两个都算传输层失败，
// 否则自建超时那条路仍然不点名。
function isTransportError (err) {
  if (!err) return false
  if (typeof err.code === 'string' && Object.prototype.hasOwnProperty.call(TRANSPORT_HINTS, err.code)) return true
  return err.message === 'Request timed out'
}

// 连不上那台引擎。err 上带 transport / transportCode / engineId / engineLabel / baseUrl。
function transportFailure (profile, cause, opts = {}) {
  const code = (cause && typeof cause.code === 'string') ? cause.code : ''
  const where = opts.baseUrl || (profile && profile.base_url) || ''
  const hint = (TRANSPORT_HINTS[code] ||
    (cause && cause.message === 'Request timed out' ? TRANSPORT_HINTS.ETIMEDOUT : ''))
    .replace('<engine id>', (profile && profile.id) || '<engine id>')
  // 说清三件事：哪台引擎、哪个地址、什么毛病。缺哪件就不写哪件，不编。
  const parts = [`Cannot reach ${engineName(profile)}`]
  if (where) parts.push(`at ${where}`)
  else if (profile && profile.transport === 'stdio') parts.push('over its stdio pipe')
  const tail = hint || (cause && cause.message) || 'the connection failed'
  const err = new Error(`${parts.join(' ')} — ${tail}${code ? ` (${code})` : ''}`)
  err.transport = true
  err.transportCode = code || null
  err.engineId = (profile && profile.id) || null
  err.engineLabel = engineName(profile)
  err.baseUrl = where || null
  err.cause = cause
  return err
}

// 上游返回 200 但正文是空的：对调用方来说和失败没区别，同样要点名。
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
