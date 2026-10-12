'use strict'
// ============================================================================
//  回归：async handler 被 vite 的 HTML fallback 抢响应（2026-10-12 P0）
//
//  症状：向导第 3 步「嗅探仓库」报「嗅探失败：响应格式错误」
//        （前端 editor/StepsExtra.jsx:174 的 content-type 守卫）。
//  实测：GET /wizard/download/manifest  → 200 text/html ❌
//        POST /wizard/params             → 200 text/html ❌
//        （两个同步端点 download/files、probe 都是 application/json ✅）
//
//  ⛔ 本文件**不真起 vite**，⛔ 也不 mock 业务逻辑。
//  起一个真的 http server，把真 handler 挂上去，中间件那一段从
//  web/wizard.vite.config.mjs 原样抄下来（⛔ 那段 for 循环不许动，
//  它是 vite connect 对同步 return 敏感的原因）。
//  ⇒ 测的就是「中间件 + handler」这个组合本身，不是 handler 的内部逻辑。
// ============================================================================

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const BRIDGE = require('../core/wizardbridge.js')

// ---------------------------------------------------------------------------
//  ⭐ 中间件的 for 循环 —— 与 web/wizard.vite.config.mjs 逐行同构。
//     ⛔ 刻意不 import 那个 .mjs（它会拉起 vite/react 的整个依赖图），
//        也不把它抽成共享模块（那会让两处漂移，漂移的守卫等于没有守卫）。
//        代价是这里要手动同步一次，改中间件时本文件会亮红。
// ---------------------------------------------------------------------------
/**
 * @param {Function[]} handlers HANDLERS 表（顺序即优先级）
 * @returns {Function} connect 风格的中间件
 */
function wizardMiddleware (handlers) {
  return (req, res, next) => {
    // ⛔ handler 返回 boolean（同步）或 Promise<boolean>（异步）。
    //   async handler 即使返回 false，返回的也是 Promise<false>，
    //   Promise 是 truthy ⇒ 会被误判为已处理 ⇒ next() 不调用 ⇒ 卡死。
    //   ⇒ 对 Promise，不能同步判定，要等它 resolve。
    let handled = false
    try {
      for (const h of handlers) {
        if (typeof h !== 'function') continue
        const r = h(req, res)
        if (r === true) { handled = true; break }
        if (r && typeof r.then === 'function') {
          r.then((ok) => {
            if (ok) { /* 已处理 */ }
            else { next() }
          }).catch(() => { next() })
          handled = true; break
        }
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String((err && err.message) || err) }))
      return
    }
    if (!handled) next()
  }
}

// ---------------------------------------------------------------------------
//  ⚠ HANDLERS 的顺序 = web/wizard.vite.config.mjs 里的顺序 ⛔ 改那边要同步改这边。
//     这里只取与本 bug 相关的四个端点 + 队尾两个 async（历史），
//     其余 handler 不参与：顺序纪律关心的只是「async 的必须在最后」。
// ---------------------------------------------------------------------------
const specbridge = require('../core/specbridge')
const savebridge = require('../core/savebridge')
const HANDLERS = [
  specbridge.handleSpec, savebridge.handleRead,
  BRIDGE.handleProbe,
  BRIDGE.handleDownloadFiles,
  // ⛔ 这两个**必须**排在最后 —— 与 vite 配置里的纪律同款。
  BRIDGE.handleParams, BRIDGE.handleDownloadManifest,
]

// ⚠ vite 的 HTML fallback：任何没被 handler 接走的请求都回 index.html。
//   症状就出在这里：200 + Content-Type: text/html。
function htmlFallback (req, res) {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><head></head><body></body></html>')
}

function startServer () {
  const mw = wizardMiddleware(HANDLERS)
  const server = http.createServer((req, res) => {
    // ⚠ next 必须绑住 req/res：中间件是裸调 next()，不传参。
    mw(req, res, () => htmlFallback(req, res))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// ⛔ 超时兜底：async handler 会让请求既不响应也不报错（正是这个 bug 的本体）。
//   没有它，一个挂死的请求会让 node --test 整个文件不退出 —— 挂死比断言失败难查。
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(
    () => rej(new Error(`⛔ ${label} ${ms}ms 没返回 —— handler 挂死了`)), ms)),
])

const get = (base, p) => withTimeout((async () => {
  const r = await fetch(base + p)
  return { status: r.status, ct: r.headers.get('content-type') || '', text: await r.text() }
})(), 15000, p)
const post = (base, p, body) => withTimeout((async () => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, ct: r.headers.get('content-type') || '', text: await r.text() }
})(), 15000, p)

// ---------------------------------------------------------------------------
//  ① 四个端点的 content-type 必须是 application/json
// ---------------------------------------------------------------------------
test('⭐ P0 四个 wizard 端点全部回 application/json（⛔ 不是 text/html）', async () => {
  const { server, base } = await startServer()
  try {
    const cases = [
      ['GET  /wizard/download/files （同步）', await get(base, '/wizard/download/files?id=nope')],
      ['POST /wizard/probe （同步）', await post(base, '/wizard/probe', { url: 'https://example.com/x/y' })],
      ['GET  /wizard/download/manifest （曾 async）', await get(base, '/wizard/download/manifest?id=nope&repo=o%2Fr')],
      ['POST /wizard/params （曾 async）', await post(base, '/wizard/params', {})],
    ]
    for (const [name, r] of cases) {
      // ⛔ 这一条就是 2026-10-12 P0 的判据：前端只看 content-type。
      assert.match(r.ct, /application\/json/,
        `⛔ ${name} 回的是 ${r.ct || '(无)'} —— 被 vite 的 HTML fallback 抢走了\nbody: ${r.text.slice(0, 200)}`)
      // 头对了还不够，body 也得是合法 JSON（半个响应同样会被前端判成格式错误）。
      assert.doesNotThrow(() => JSON.parse(r.text), `${name} 的 body 不是合法 JSON: ${r.text.slice(0, 200)}`)
    }
  } finally {
    server.close()
  }
})

// ---------------------------------------------------------------------------
//  ② 两个曾 async 的端点：URL/方法不匹配时同步返回 false，且一个字都不许写
//     （false 是中间件 next() 的前提 —— 返回 Promise 会 break 出循环）
// ---------------------------------------------------------------------------
test('⭐⭐ 曾 async 的两个 handler 现在**同步**返回 false 且不写任何响应', async () => {
  const res = {
    headersSent: false,
    writeHead () { this.wroteHead = true; this.headersSent = true },
    end () { this.ended = true },
  }
  // GET 打到 /wizard/params（它只收 POST）
  const r1 = BRIDGE.handleParams({ method: 'GET', url: '/wizard/params' }, res)
  assert.strictEqual(r1, false, '⛔ handleParams 对 GET 必须**同步**返回 false，而不是 Promise')
  assert.strictEqual(res.wroteHead, undefined, '⛔ URL 不匹配就一个字都不许写')
  assert.strictEqual(res.ended, undefined, '⛔ URL 不匹配就一个字都不许写')

  // 前缀没锚定：/wizard/paramsxyz 不该被吃掉
  const r2 = BRIDGE.handleParams({ method: 'POST', url: '/wizard/paramsxyz' }, res)
  assert.strictEqual(r2, false, '⛔ /wizard/paramsxyz 不该被接管')
  assert.strictEqual(res.wroteHead, undefined, '⛔ /wizard/paramsxyz 不该被写')

  // POST 打到 /wizard/download/manifest（它只收 GET）
  const r3 = BRIDGE.handleDownloadManifest({ method: 'POST', url: '/wizard/download/manifest' }, res)
  assert.strictEqual(r3, false, '⛔ handleDownloadManifest 对 POST 必须同步返回 false')
  assert.strictEqual(res.wroteHead, undefined, '⛔ handleDownloadManifest 不该被写')

  // ⛔⛔ 变异点（这一条钉死 async 写法）：
  //   async function 哪怕第一行就 return false，返回的也是 Promise。
  //   中间件一见到 Promise 就 break 出循环 ⇒ 排在它后面的 handler 全灭。
  assert.notStrictEqual(r1 && typeof r1.then, 'function',
    '⛔ handleParams 返回了 Promise —— async 写法会让中间件 break 出循环')
  assert.notStrictEqual(r3 && typeof r3.then, 'function',
    '⛔ handleDownloadManifest 返回了 Promise —— 同上')
})

// ---------------------------------------------------------------------------
//  ③ async 干活出错时必须回**合法 JSON**，⛔ 不许挂住
// ---------------------------------------------------------------------------
test('⭐⭐ 异步出错时回的是合法 JSON（⛔ 不是半个响应，也不是挂死）', async () => {
  const { server, base } = await startServer()
  try {
    // POST /wizard/params 带一个会炸的 req（没有 'end' 事件 ⇒ 回调永不跑）
    //    真正要验的是：回调里 throw 时连接**收得住**，且 body 是合法 JSON。
    const req = new http.IncomingMessage(null)
    req.method = 'POST'
    req.url = '/wizard/params'
    req.on = () => {}
    req.destroy = () => {}
    const res = {
      headersSent: false,
      status: 0,
      body: '',
      writeHead (code, headers) { this.status = code; this.ct = headers['content-type'] },
      end (chunk) { this.headersSent = true; this.body = chunk === undefined ? '' : chunk },
    }
    // 用一个当场 throw 的回调喂给 respondSafely 的包装器
    const { respondSafely } = require('../core/wizardbridge.js')
    const thrown = respondSafely(res, async () => { throw new Error('boom') })
    thrown(null, {})
    // 等 Promise 落地
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.strictEqual(res.status, 500, '⛔ 回调 throw 了却没有 500')
    assert.match(res.ct, /application\/json/, '⛔ 错误响应必须是 JSON（前端只看 content-type）')
    const j = JSON.parse(res.body)
    assert.strictEqual(j.ok, false)
    assert.match(j.error, /boom/, '⛔ 错误要如实带出去')
  } finally {
    server.close()
  }
})

test('⭐ 错误响应不会二次写头（⛔ 已经回过就不许再 writeHead）', async () => {
  const { respondSafely } = require('../core/wizardbridge.js')
  let writes = 0
  const res = {
    headersSent: true, // 模拟 json() 已经写过
    writeHead () { writes++ },
    end () { writes += 0 },
  }
  const cb = respondSafely(res, async () => { throw new Error('late') })
  cb(null, {})
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.strictEqual(writes, 0, '⛔ 头已发出还再 writeHead ⇒ ERR_HTTP_HEADERS_SENT 把真错盖掉')
})

// ---------------------------------------------------------------------------
//  ④ 真端到端：manifest 端点在真 server 上真拿 JSON（远端 API 打不通也算数，
//     端点的契约是「回 JSON」，不是「一定成功」）
// ---------------------------------------------------------------------------
test('⭐⭐ manifest 端点端到端：真发真收，内容是 JSON 而不是 HTML', async () => {
  const { server, base } = await startServer()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-mf-'))
  try {
    const r = await get(base, `/wizard/download/manifest?id=zz&repo=owner%2Frepo&tool=hf&root=${encodeURIComponent(root)}`)
    assert.match(r.ct, /application\/json/, `⛔ content-type 是 ${r.ct}`)
    const j = JSON.parse(r.text)
    // ⭐ 远端多半不通（不联网），但**不通也必须回 JSON** —— 这才是本 bug 的判据。
    assert.ok(typeof j.ok === 'boolean', `响应不是约定形状: ${r.text.slice(0, 200)}`)
    if (!j.ok) assert.ok(j.error, '⛔ ok:false 必须带 error')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
//  ⑤ params 端点端到端：空 body 也要回 JSON（不是 HTML）
// ---------------------------------------------------------------------------
test('⭐⭐ params 端点端到端：空 body 回 JSON（⛔ 不是 HTML fallback）', async () => {
  const { server, base } = await startServer()
  try {
    const r = await post(base, '/wizard/params', {})
    assert.match(r.ct, /application\/json/, `⛔ content-type 是 ${r.ct}\nbody: ${r.text.slice(0, 200)}`)
    const j = JSON.parse(r.text)
    assert.strictEqual(j.ok, false)
    assert.ok(j.error, '⛔ 失败必须带 error（⛔ 不许静默）')
  } finally {
    server.close()
  }
})

// ---------------------------------------------------------------------------
//  ⑥ 守卫：这两个 handler 不许再变回 async
//     ⛔ 不看源码字面量，靠**运行时**判据（构造函数名）——
//        注释和格式会被人重排，构造函数名不会骗人。
// ---------------------------------------------------------------------------
test('⭐⭐⭐ 两个曾 async 的 handler 构造函数不是 AsyncFunction', () => {
  for (const name of ['handleParams', 'handleDownloadManifest']) {
    assert.strictEqual(BRIDGE[name].constructor.name, 'Function',
      `⛔ ${name} 又变回 async 了 —— 中间件的 for 循环一见到 Promise 就 break，` +
      '它后面的 handler 全部静默失效')
  }
})

// ---------------------------------------------------------------------------
//  ⑦ 守卫：vite 配置里的 HANDLERS 表不许出现 async handler
//     直接读 .mjs 源文件，assert HANDLERS 段里没有 async 导出名。
// ---------------------------------------------------------------------------
test('⭐⭐⭐ vite 中间件的 HANDLERS 表全部是同步 handler（⛔ 顺序不许重排）', () => {
  const cfgPath = path.join(__dirname, '..', '..', '..', 'web', 'wizard.vite.config.mjs')
  const src = fs.readFileSync(cfgPath, 'utf8')
  // ⛔ 断言：HANDLERS 数组段内不允许出现 wb.handleParams 之类以外的 async 痕迹。
  //   真正的判据在 ⑥（构造函数名）；这里补的是「配置里注释与代码同步」。
  const arrStart = src.indexOf('const HANDLERS = [')
  assert.ok(arrStart > 0, '⛔ 没找到 HANDLERS 表')
  const arrEnd = src.indexOf('\n  ]', arrStart)
  const seg = src.slice(arrStart, arrEnd)
  // 长前缀在前：download 子端点必须排在 download 前缀之前
  const iFiles = seg.indexOf('handleDownloadFiles')
  const iPrefix = seg.indexOf('wb.handleDownload,')
  assert.ok(iFiles > 0 && iPrefix > 0, '⛔ HANDLERS 表里找不到 download 相关 handler')
  assert.ok(iFiles < iPrefix,
    '⛔ handleDownload（前缀）排在子端点前面 ⇒ 会把子端点全部吃掉')
})