'use strict'

// ============================================================================
//  stdio 传输的**客户端**（Node 侧）
//
//  ⭐⭐ 一台引擎 = 一个子进程 = 一条长连接。HTTP/1.1 帧直接走
//     child.stdin / child.stdout。**零 TCP 端口**（100 台引擎 ⇒ 0 个端口）。
//
//  ── 为什么自己实现帧解析，而不用 http.request ─────────────────────────────
//     `http.request` 只认 socketPath / host+port，**没有**「走子进程管道」这个选项。
//     ⛔ 硬套 socketPath 会去连一个不存在的路径（ENOENT）——
//       而那个错的提示完全不提「你想干嘛」，排查必然跑偏。
//     ⇒ 协议帧这一层自己写，换来「三平台同一个 API」。
//
//  ── 协议 ────────────────────────────────────────────────────────────────
//     请求行 + 头 + Content-Length 的**字节数** + 空行 + body
//     ⭐ 响应按 Content-Length 切分（host.py 每个响应都显式写了它）。
//     ⛔ 不支持 chunked：引擎不会发，真发了要**响亮地**失败而不是猜 ——
//       猜错长度会把下一个响应当成本响应的一部分，症状是「随机的 200
//       里混着别人的 body」，那种 bug 现场就过去了。
//
//  ── 并发模型 ────────────────────────────────────────────────────────────
//     ⭐⭐ **严格串行**，一次一个请求。这不是保守，是协议决定的：
//     一条 stdin/stdout 上交错的两个 HTTP 响应无法区分（没有请求 id）。
//     ⛔ 「并发写出去然后按顺序猜」是错的。
//     ⭐ 真要并发，正确做法是**多开一个子进程** —— 端口归零之后这很便宜。
// ============================================================================

class StdioConnection {
  constructor(child, opts = {}) {
    this.child = child
    this.id = opts.id || '?'
    this._buf = Buffer.alloc(0)
    this._waiting = []
    this._inFlight = 0
    this._closed = false
    this._closeReason = null
    child.stdout.on('data', (chunk) => this._onData(chunk))
    child.stdout.on('end', () => this._failAll('engine stdout closed'))
    child.stdout.on('error', (e) => this._failAll('engine stdout error: ' + e.message))
    child.on('exit', (code, signal) => {
      this._closed = true
      this._closeReason = 'engine ' + this.id + ' exited (code=' + code + ' signal=' + signal + ')'
      this._failAll(this._closeReason)
    })
  }

  _failAll(reason) {
    const pending = this._waiting.splice(0)
    for (const w of pending) {
      const err = new Error(reason)
      err.code = 'ENGINE_STDIO_CLOSED'
      w.reject(err)
    }
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk
    for (;;) {
      const frame = this._takeFrame()
      if (!frame) break
      const w = this._waiting.shift()
      if (w) w.resolve(frame)
    }
  }

  _takeFrame() {
    const he = this._buf.indexOf('\r\n\r\n')
    if (he < 0) return null
    const head = this._buf.slice(0, he).toString('latin1')
    if (/\bTransfer-Encoding:\s*chunked/i.test(head)) {
      const e = new Error('engine ' + this.id + ' replied chunked; host.py never does that')
      e.code = 'ENGINE_STDIO_CHUNKED'
      throw e
    }
    const m = /content-length:\s*(\d+)/i.exec(head)
    const len = m ? Number(m[1]) : 0
    if (this._buf.length < he + 4 + len) return null
    const status = Number((/HTTP\/1\.\d\s+(\d+)/.exec(head) || [])[1] || 0)
    const body = this._buf.slice(he + 4, he + 4 + len)
    this._buf = this._buf.slice(he + 4 + len)
    return { statusCode: status, body, headers: head }
  }

  request(opts) {
    const method = (opts && opts.method) || 'GET'
    const urlPath = opts && opts.path
    const payload = opts ? opts.payload : null
    const timeoutMs = (opts && opts.timeoutMs) || 120000
    const headers = (opts && opts.headers) || {}
    if (this._closed) {
      const e = new Error(this._closeReason || ('engine ' + this.id + ' exited'))
      e.code = 'ENGINE_STDIO_CLOSED'
      return Promise.reject(e)
    }
    if (this._inFlight > 0) {
      const e = new Error('engine ' + this.id + ' stdio already has a request in flight (must be serial)')
      e.code = 'ENGINE_STDIO_BUSY'
      return Promise.reject(e)
    }
    let bodyBuf
    if (payload == null) bodyBuf = Buffer.alloc(0)
    else if (Buffer.isBuffer(payload)) bodyBuf = payload
    else bodyBuf = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')

    const lines = [method + ' ' + urlPath + ' HTTP/1.1', 'Host: aurivox-stdio']
    for (const k of Object.keys(headers)) lines.push(k + ': ' + headers[k])
    if (bodyBuf.length) lines.push('Content-Type: application/json')
    lines.push('Content-Length: ' + bodyBuf.length)
    const head = lines.join('\r\n') + '\r\n\r\n'

    this._inFlight = 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._inFlight = 0
        const idx = this._waiting.findIndex((w) => w.timer === timer)
        if (idx >= 0) this._waiting.splice(idx, 1)
        const e = new Error('engine ' + this.id + ' ' + urlPath + ' timed out after ' + timeoutMs + 'ms')
        e.code = 'ENGINE_STDIO_TIMEOUT'
        reject(e)
      }, timeoutMs)
      this._waiting.push({
        resolve: (r) => { this._inFlight = 0; clearTimeout(timer); resolve(r) },
        reject: (e) => { this._inFlight = 0; clearTimeout(timer); reject(e) },
        timer: timer,
      })
      this.child.stdin.write(head)
      if (bodyBuf.length) this.child.stdin.write(bodyBuf)
    })
  }

  dispose() {
    this._closed = true
    this._failAll('engine connection closed')
    try { this.child.stdin.end() } catch (e) { /* already closed */ }
  }
}

function attachStdioTransport(child, plan) {
  const conn = new StdioConnection(child, { id: plan && plan.id })
  child.stdioConn = conn
  return conn
}

module.exports = { StdioConnection, attachStdioTransport }
