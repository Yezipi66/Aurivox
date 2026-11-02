'use strict'

// stdio 传输（stdioTransport.js）与合成请求的分路（engineChannel.js）。
// 用假子进程测：stdin 收到什么、stdout 回什么全由用例控制，不起 Python。
// 钉住的几件事都是「走真引擎很难复现」的：两个请求同时来、超时之后旧响应才到、进程中途退出。

const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')

const { StdioConnection } = require('./stdioTransport')
const { usesStdio, postToEngine, streamFromEngine } = require('./engineChannel')
const { transportFailure, isTransportError } = require('./upstreamError')

// 假子进程：stdin 上写进来的每个请求记下来，回包由用例调 reply() 写进 stdout。
function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.written = []
  let buf = ''
  child.stdin.on('data', (c) => {
    buf += c.toString('latin1')
    for (;;) {
      const he = buf.indexOf('\r\n\r\n')
      if (he < 0) return
      const head = buf.slice(0, he)
      const len = Number((/content-length:\s*(\d+)/i.exec(head) || [])[1] || 0)
      if (buf.length < he + 4 + len) return
      child.written.push({ line: head.split('\r\n')[0], body: buf.slice(he + 4, he + 4 + len) })
      buf = buf.slice(he + 4 + len)
    }
  })
  child.reply = (status, body) => {
    const b = Buffer.from(body)
    child.stdout.write(`HTTP/1.1 ${status} OK\r\nContent-Length: ${b.length}\r\n\r\n`)
    child.stdout.write(b)
  }
  child.kill = () => child.emit('exit', null, 'SIGTERM')
  return child
}

const tick = () => new Promise((r) => setImmediate(r))

test('stdio：两个请求同时来，第二个排队，第一个的响应到了才写进管道', async () => {
  const child = fakeChild()
  const conn = new StdioConnection(child, { id: 'e' })
  const a = conn.request({ method: 'POST', path: '/tts', payload: { n: 1 }, timeoutMs: 5000 })
  const b = conn.request({ method: 'GET', path: '/health', timeoutMs: 5000 })
  await tick()
  assert.equal(child.written.length, 1, '管道上同一时刻只许有一个请求')
  assert.equal(child.written[0].line, 'POST /tts HTTP/1.1')
  child.reply(200, 'AUDIO')
  const ra = await a
  assert.equal(ra.body.toString(), 'AUDIO')
  await tick()
  assert.equal(child.written.length, 2)
  assert.equal(child.written[1].line, 'GET /health HTTP/1.1')
  child.reply(200, '{"ready":true}')
  assert.equal((await b).statusCode, 200)
})

test('⛔ stdio：超时的那个请求，迟到的响应不许交给下一个请求', async () => {
  const child = fakeChild()
  const conn = new StdioConnection(child, { id: 'e' })
  const slow = conn.request({ method: 'POST', path: '/tts', payload: {}, timeoutMs: 20 })
  await assert.rejects(slow, (e) => e.code === 'ENGINE_STDIO_TIMEOUT')
  const next = conn.request({ method: 'POST', path: '/tts', payload: { n: 2 }, timeoutMs: 5000 })
  await tick()
  assert.equal(child.written.length, 1, '旧请求的响应还没到，新请求只能排队')
  child.reply(200, 'OLD')          // 超时那次的响应现在才到
  await tick()
  assert.equal(child.written.length, 2, '旧响应到了才轮到新请求上管道')
  child.reply(200, 'NEW')
  assert.equal((await next).body.toString(), 'NEW', '拿到的必须是自己的响应')
})

test('stdio：排队时就超时的请求从没写出去，不占管道', async () => {
  const child = fakeChild()
  const conn = new StdioConnection(child, { id: 'e' })
  const first = conn.request({ method: 'POST', path: '/tts', payload: {}, timeoutMs: 5000 })
  const queued = conn.request({ method: 'GET', path: '/health', timeoutMs: 10 })
  await assert.rejects(queued, (e) => e.code === 'ENGINE_STDIO_TIMEOUT')
  child.reply(200, 'A')
  await first
  await tick()
  assert.equal(child.written.length, 1, '排队超时的那个不该再被写出去')
})

test('stdio：进程退出时，在等的与排队的都以 ENGINE_STDIO_CLOSED 失败，之后的请求当场失败', async () => {
  const child = fakeChild()
  const conn = new StdioConnection(child, { id: 'e' })
  const a = conn.request({ method: 'POST', path: '/tts', payload: {}, timeoutMs: 5000 })
  const b = conn.request({ method: 'GET', path: '/health', timeoutMs: 5000 })
  child.emit('exit', 1, null)
  await assert.rejects(a, (e) => e.code === 'ENGINE_STDIO_CLOSED' && /code=1/.test(e.message))
  await assert.rejects(b, (e) => e.code === 'ENGINE_STDIO_CLOSED')
  assert.equal(conn.closed, true)
  await assert.rejects(conn.request({ method: 'GET', path: '/health' }),
    (e) => e.code === 'ENGINE_STDIO_CLOSED')
})

test('⛔ stdio：管道里混进了非 HTTP 的字节 ⇒ 整条作废，不许当成一个响应交给在等的请求', async () => {
  const child = fakeChild()
  let killed = false
  child.kill = () => { killed = true; child.emit('exit', null, 'SIGTERM') }
  const conn = new StdioConnection(child, { id: 'e' })
  const a = conn.request({ method: 'POST', path: '/tts', payload: {}, timeoutMs: 5000 })
  await tick()
  // Windows 上上游 print 两个空行就是这串字节：形状正好是一个帧头的结尾。
  child.stdout.write('step 1\r\n\r\n')
  await assert.rejects(a, (e) => e.code === 'ENGINE_STDIO_CLOSED' && /non-HTTP bytes/.test(e.message))
  assert.equal(killed, true, '字节对不齐的进程要杀掉，下一次合成重新拉起')
  assert.equal(conn.closed, true)
})

test('engineChannel：transport 不是 stdio 的引擎照旧走 httpPost，参数原样', async () => {
  const calls = []
  const httpPost = async (p, payload, opts) => { calls.push({ p, payload, opts }); return { statusCode: 200, body: Buffer.from('x') } }
  const profile = { id: 'h', transport: 'http', base_url: 'http://127.0.0.1:9', timeout_ms: 1234 }
  assert.equal(usesStdio(profile), false)
  const r = await postToEngine({ profile, httpPost, path: '/tts', payload: { text: 'a' } })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(calls[0], { p: '/tts', payload: { text: 'a' },
    opts: { signal: null, baseUrl: 'http://127.0.0.1:9', reqTimeout: 1234 } })
})

test('engineChannel：stdio 的引擎经 supervisor 给的管道发，超时取名片解析出的 timeout_ms', async () => {
  const child = fakeChild()
  const conn = new StdioConnection(child, { id: 's' })
  const profile = { id: 's', transport: 'stdio', base_url: null, timeout_ms: 4321 }
  const supervisor = { connectionOf: (id) => (id === 's' ? conn : null) }
  const httpPost = () => assert.fail('stdio 的引擎不许走 HTTP')
  const p = postToEngine({ profile, supervisor, httpPost, path: '/tts', payload: { text: 'a' } })
  await tick()
  assert.equal(child.written[0].line, 'POST /tts HTTP/1.1')
  assert.deepEqual(JSON.parse(child.written[0].body), { text: 'a' })
  child.reply(200, 'WAV')
  assert.equal((await p).body.toString(), 'WAV')

  // 流式那一支：stdio 上没有分块，整段包成一条流交出去。
  const sp = streamFromEngine({ profile, supervisor, httpStream: () => assert.fail('不许走 HTTP'),
    path: '/tts', payload: {} })
  await tick()
  child.reply(200, 'STREAMED')
  const up = await sp
  const chunks = []
  for await (const c of up.stream) chunks.push(c)
  assert.equal(Buffer.concat(chunks).toString(), 'STREAMED')
})

test('engineChannel：stdio 的引擎没在运行 ⇒ 传输层错误，报错点名引擎、说明走的是管道', async () => {
  const profile = { id: 's', label: 'S', transport: 'stdio', base_url: null, timeout_ms: 10 }
  let err
  try {
    await postToEngine({ profile, supervisor: { connectionOf: () => null }, httpPost: null, path: '/tts', payload: {} })
  } catch (e) { err = e }
  assert.equal(err.code, 'ENGINE_NOT_RUNNING')
  assert.equal(isTransportError(err), true, 'upstreamError 要认得它，否则落到通用兜底')
  const f = transportFailure(profile, err)
  assert.match(f.message, /Cannot reach S over its stdio pipe/)
  assert.match(f.message, /not running/)
})

test('upstreamError：进程退出的提示带上这台引擎的日志文件名', () => {
  const profile = { id: 'abc', label: 'ABC', transport: 'stdio' }
  const cause = Object.assign(new Error('engine abc exited (code=1 signal=null)'), { code: 'ENGINE_STDIO_CLOSED' })
  const f = transportFailure(profile, cause)
  assert.match(f.message, /logs\/abc\.err\.log/)
})
