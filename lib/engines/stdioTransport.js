'use strict'

// stdio 传输的客户端（Node 侧）
//
//  一台引擎 = 一个子进程 = 一条长连接。HTTP/1.1 帧直接走
// child.stdin / child.stdout。零 TCP 端口（100 台引擎 ⇒ 0 个端口）。
//
//  ── 为什么自己实现帧解析，而不用 http.request ─────────────────────────────
// `http.request` 只认 socketPath / host+port，没有「走子进程管道」这个选项。
//     硬套 socketPath 会去连一个不存在的路径（ENOENT），
//       而那个错的提示完全不提「你想干嘛」，排查必然跑偏。
//     ⇒ 协议帧这一层自己写，换来「三平台同一个 API」。
//
// 请求行 + 头 + Content-Length 的字节数 + 空行 + body
//     响应按 Content-Length 切分（host.py 每个响应都显式写了它）。
// 不支持 chunked：引擎不会发，真发了要响亮地失败而不是猜，
//       猜错长度会把下一个响应当成本响应的一部分，症状是「随机的 200
//       里混着别人的 body」，那种 bug 现场就过去了。
//
// 严格串行，管道上一次只有一个请求。这不是保守，是协议决定的：
//     一条 stdin/stdout 上交错的两个 HTTP 响应无法区分（没有请求 id）。
//     「并发写出去然后按顺序猜」是错的。
//   调用方同时来两个请求时，第二个在这里排队，等第一个的响应到了才写进管道。
//   平台的合成本来就在一把全局锁里，这条队列兜的是锁外的少数请求（探活、手动起停）。
// 超时的那个请求，宿主还在算，它的响应迟早会来。等待者在这里换成一个「收了就扔」的占位，
//   不从队里删：删了，迟到的那份响应会被交给下一个请求，症状是「拿到了别人的音频」。
//   排在后面的请求照样等它到了再写，与走 HTTP 时「客户端断开、宿主照样算完」是同一个语义。
// 真要并发，正确做法是多开一个子进程：端口归零之后这很便宜。

function stdioError(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

class StdioConnection {
  constructor(child, opts = {}) {
    this.child = child
    this.id = opts.id || '?'
    this._buf = Buffer.alloc(0)
    // 已写进管道、在等响应的（最多一个）。
    this._onWire = null
    // 还没写进管道的。
    this._queue = []
    this._closed = false
    this._closeReason = null
    child.stdout.on('data', (chunk) => this._onData(chunk))
    child.stdout.on('end', () => this._failAll('engine ' + this.id + ' stdout closed'))
    child.stdout.on('error', (e) => this._failAll('engine ' + this.id + ' stdout error: ' + e.message))
    if (child.stdin && typeof child.stdin.on === 'function') {
      // 进程刚退出时往 stdin 写会抛 EPIPE。不接住它，整个后端会被一个未处理的 error 事件带走。
      child.stdin.on('error', (e) => this._failAll('engine ' + this.id + ' stdin error: ' + e.message))
    }
    child.on('exit', (code, signal) => {
      this._closeReason = 'engine ' + this.id + ' exited (code=' + code + ' signal=' + signal + ')'
      this._failAll(this._closeReason)
    })
  }

  get closed() { return this._closed }
  get closeReason() { return this._closeReason }

  _failAll(reason) {
    if (!this._closed) {
      this._closed = true
      if (!this._closeReason) this._closeReason = reason
    }
    const pending = (this._onWire ? [this._onWire] : []).concat(this._queue.splice(0))
    this._onWire = null
    for (const w of pending) {
      if (w.abandoned) continue
      w.reject(stdioError('ENGINE_STDIO_CLOSED', reason))
    }
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk
    for (;;) {
      let frame
      try {
        frame = this._takeFrame()
      } catch (e) {
        // 帧解析不下去 = 这条管道上的字节对不齐了，后面的每一个响应都不可信。整条作废。
        this._failAll(e.message)
        try { this.child.kill() } catch (_) { /* 已经退了 */ }
        return
      }
      if (!frame) break
      const w = this._onWire
      this._onWire = null
      if (w && !w.abandoned) w.resolve(frame)
      this._pump()
    }
  }

  _takeFrame() {
    const he = this._buf.indexOf('\r\n\r\n')
    if (he < 0) return null
    const head = this._buf.slice(0, he).toString('latin1')
    // 帧头必须以状态行开头。不是 = 有别的字节混进了管道（宿主那边见 stdio_transport.claim_stdout），
    //   照常解析会把它当成一个响应交给排在前面的请求，之后每个请求都错位一格。
    if (!/^HTTP\/1\.\d \d{3}/.test(head)) {
      throw stdioError('ENGINE_STDIO_GARBLED',
        'engine ' + this.id + ' wrote non-HTTP bytes to its stdout pipe: ' +
        JSON.stringify(head.slice(0, 80)))
    }
    if (/\bTransfer-Encoding:\s*chunked/i.test(head)) {
      throw stdioError('ENGINE_STDIO_CHUNKED',
        'engine ' + this.id + ' replied chunked; host.py never does that')
    }
    const m = /content-length:\s*(\d+)/i.exec(head)
    const len = m ? Number(m[1]) : 0
    if (this._buf.length < he + 4 + len) return null
    const status = Number((/HTTP\/1\.\d\s+(\d+)/.exec(head) || [])[1] || 0)
    const body = this._buf.slice(he + 4, he + 4 + len)
    this._buf = this._buf.slice(he + 4 + len)
    return { statusCode: status, body, headers: head }
  }

  // 管道空了就把队首写出去。
  _pump() {
    if (this._onWire || this._closed) return
    for (;;) {
      const w = this._queue.shift()
      if (!w) return
      if (w.abandoned) continue    // 排队时就超时了：从没写出去，不会有响应，直接丢
      this._onWire = w
      try {
        this.child.stdin.write(w.head)
        if (w.bodyBuf.length) this.child.stdin.write(w.bodyBuf)
      } catch (e) {
        this._failAll('engine ' + this.id + ' stdin write failed: ' + e.message)
      }
      return
    }
  }

  /**
   * @param {object} opts  method, path, payload（对象 / 字符串 / Buffer）, timeoutMs, headers, signal
   * @returns {Promise<{statusCode:number, body:Buffer, headers:string}>}
   *   失败时 err.code：ENGINE_STDIO_CLOSED（进程退出 / 管道断了）、ENGINE_STDIO_TIMEOUT、ENGINE_STDIO_ABORTED
   */
  request(opts) {
    const method = (opts && opts.method) || 'GET'
    const urlPath = opts && opts.path
    const payload = opts ? opts.payload : null
    const timeoutMs = (opts && opts.timeoutMs) || 120000
    const headers = (opts && opts.headers) || {}
    const signal = (opts && opts.signal) || null
    if (this._closed) {
      return Promise.reject(stdioError('ENGINE_STDIO_CLOSED',
        this._closeReason || ('engine ' + this.id + ' exited')))
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

    return new Promise((resolve, reject) => {
      const w = { head, bodyBuf, abandoned: false, resolve: null, reject: null }
      let timer = null
      const settle = (fn, v) => {
        if (w.abandoned) return
        w.abandoned = true
        clearTimeout(timer)
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
        fn(v)
      }
      w.resolve = (r) => settle(resolve, r)
      w.reject = (e) => settle(reject, e)
      // 放弃 = 标记 abandoned，不出队（见文件头）。
      timer = setTimeout(() => {
        w.reject(stdioError('ENGINE_STDIO_TIMEOUT',
          'engine ' + this.id + ' ' + urlPath + ' timed out after ' + timeoutMs + 'ms'))
      }, timeoutMs)
      let onAbort = null
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer)
          return reject(stdioError('ENGINE_STDIO_ABORTED', 'engine ' + this.id + ' ' + urlPath + ' aborted'))
        }
        onAbort = () => w.reject(stdioError('ENGINE_STDIO_ABORTED',
          'engine ' + this.id + ' ' + urlPath + ' aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this._queue.push(w)
      this._pump()
    })
  }

  dispose() {
    this._failAll('engine ' + this.id + ' connection closed')
    try { this.child.stdin.end() } catch (e) { /* already closed */ }
  }
}

function attachStdioTransport(child, plan) {
  const conn = new StdioConnection(child, { id: plan && plan.id })
  child.stdioConn = conn
  return conn
}

module.exports = { StdioConnection, attachStdioTransport }
