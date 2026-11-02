'use strict'

// 平台给一台引擎发合成请求，走哪条路。两条路，判据是名片推出来的 profile.transport：
//   http   照旧按 base_url 发（引擎自带服务、或名片写了监听地址的）
//   stdio  经平台拉起的那个子进程的管道发（启动脚本是通用宿主、名片没写地址的），零端口
// 两条路的请求与响应形状完全一样（{ statusCode, body }），上层的报错、缓存、转码一行不用分叉。
//
// stdio 的进程只在 supervisor 手里：调用方在合成锁里先 ensure()，这里再向 supervisor 要管道。
// 要不到 = 进程不在（没 ensure、或刚退出），报一个传输层错误，upstreamError.js 认得它的 code。

const { Readable } = require('node:stream')

function usesStdio(profile) {
  return !!profile && profile.transport === 'stdio'
}

function channelError(code, message, details = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, details)
  return e
}

// 这台走 stdio 的引擎此刻的管道。没有就抛 ENGINE_NOT_RUNNING。
function stdioConnectionOf(profile, supervisor) {
  const conn = supervisor && typeof supervisor.connectionOf === 'function'
    ? supervisor.connectionOf(profile.id)
    : null
  if (!conn || conn.closed) {
    throw channelError('ENGINE_NOT_RUNNING',
      `engine ${profile.id} is not running` +
      (conn && conn.closeReason ? ` (${conn.closeReason})` : '') +
      '; the platform starts it on demand before a synthesis',
      { engineId: profile.id })
  }
  return conn
}

/**
 * 发一次 POST 给这台引擎。返回 { statusCode, body }，与 lib/gsv/client.js 的 gsvPost 同形。
 * @param {object} o
 * @param {object} o.profile     resolveEngineProfile 的产物
 * @param {object} [o.supervisor]  EngineSupervisor：stdio 那条路要它给管道
 * @param {Function} o.httpPost  http 那条路用的发送函数（gsvPost），由调用方注入，不在这里 require：
 *   测试里替换的是它
 * @param {string} o.path
 * @param {object} o.payload
 * @param {number} [o.timeoutMs]  缺省用 profile.timeout_ms（本机测得 > 名片 > 默认，见 profile.js）
 * @param {AbortSignal} [o.signal]
 */
async function postToEngine(o) {
  const { profile, supervisor, httpPost, path, payload, signal } = o
  const timeoutMs = o.timeoutMs || profile.timeout_ms
  if (!usesStdio(profile)) {
    return httpPost(path, payload, { signal: signal || null, baseUrl: profile.base_url, reqTimeout: timeoutMs })
  }
  const conn = stdioConnectionOf(profile, supervisor)
  return conn.request({ method: 'POST', path, payload, timeoutMs, signal: signal || null })
}

/**
 * 流式那一支用的：返回 { statusCode, stream }，与 gsvStream 同形。
 * stdio 上没有分块：响应整个到了才交出去，包成一条只有一块的流。上层照旧 pipe。
 */
async function streamFromEngine(o) {
  const { profile, supervisor, httpStream, path, payload } = o
  const timeoutMs = o.timeoutMs || profile.timeout_ms
  if (!usesStdio(profile)) {
    return httpStream(path, payload, 0, { baseUrl: profile.base_url, reqTimeout: timeoutMs })
  }
  const conn = stdioConnectionOf(profile, supervisor)
  const r = await conn.request({ method: 'POST', path, payload, timeoutMs })
  return { statusCode: r.statusCode, headers: {}, stream: Readable.from([r.body]) }
}

module.exports = { usesStdio, postToEngine, streamFromEngine, stdioConnectionOf }
