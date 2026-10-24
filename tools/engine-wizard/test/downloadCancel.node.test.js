'use strict'
// 第 3 步的取消路径守卫。本文件守三件事，各有一条能变红的断言：
//   ① 类枚举：每一个「短前缀 + /cancel」的端点对，都必须在自己的短前缀 handler 里
//      显式排除子路径。短前缀 handler 对 cancel 也会返回 true，中间件是第一个赢的，
//      所以「把 cancel 排在前面」修不好这个问题，只有显式 return false 能修。
//   ② 真机路由：POST /wizard/download/cancel 必须经过中间件链拿到 JSON，
//      而不是掉进 vite 的 HTML fallback（200 + text/html）。
//   ③ 真下载取消：真的在下载中途取消，验证 HTTP 请求被中断、半截文件被删掉。
//
// 本文件不写真仓库的 engines/：所有落盘都在 mkdtemp 出来的临时目录里。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const BRIDGE = require('../core/wizardbridge.js')
const { downloadFileFromUrl } = require('../core/download.js')

// ---------------------------------------------------------------------------
// 中间件复刻（与 web/wizard.vite.config.mjs 的判定逻辑一致）
// ---------------------------------------------------------------------------

/**
 * connect 风格中间件：第一个返回 true 的 handler 接管请求。
 * handler 返回 Promise 视为已处理（vite 的中间件就是这么断的）。
 */
function wizardMiddleware (handlers) {
  return (req, res, next) => {
    let handled = false
    try {
      for (const h of handlers) {
        if (typeof h !== 'function') continue
        const r = h(req, res)
        if (r === true) { handled = true; break }
        if (r && typeof r.then === 'function') {
          r.then((ok) => { if (!ok) next() }).catch(() => { next() })
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

// vite 的 HTML fallback：没被 handler 接走的请求回 index.html。
function htmlFallback (req, res) {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><head></head><body></body></html>')
}

/** 起一个真 HTTP 服务器，把 req/res 包成中间件能吃的形状。 */
function serveWith (handlers, method, url, body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // 中间件必须在 body 到达之前调用：handler 里的 readBody 自己挂
      //   'data'/'end' 监听来读 body。等 body 读完再调用中间件，
      //   readBody 的回调就永远不会触发（事件已经发过了），请求会挂住。
      wizardMiddleware(handlers)(req, res, () => htmlFallback(req, res))
    })
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port
      const opts = {
        method,
        headers: { 'content-type': 'application/json' },
      }
      if (body !== undefined) opts.body = JSON.stringify(body)
      const resp = await fetch(`http://127.0.0.1:${port}${url}`, opts)
      const text = await resp.text()
      let json = null
      try { json = JSON.parse(text) } catch (e) { /* 不是 JSON */ }
      server.close()
      resolve({ status: resp.status, type: resp.headers.get('content-type'), text, json })
    })
  })
}

// ---------------------------------------------------------------------------
// ① 类枚举：短前缀 handler 必须显式排除自己的 /cancel 子路径
// ---------------------------------------------------------------------------

// 仓库里所有「短前缀 + /cancel」的端点对。
//   每一对都要：短前缀 handler 对 cancel URL 返回 false。
//   这是从「我这次踩的那个坑」推广到「这类坑」，
//   不是只测我新加的那一对。
const CANCEL_PAIRS = [
  { short: BRIDGE.handleClone, cancelPath: '/wizard/clone/cancel' },
  { short: BRIDGE.handleEnv, cancelPath: '/wizard/env/cancel' },
  { short: BRIDGE.handleDownload, cancelPath: '/wizard/download/cancel' },
]

test('类枚举：短前缀 handler 对自己的 /cancel 子路径返回 false', () => {
  for (const { short, cancelPath } of CANCEL_PAIRS) {
    const req = { method: 'POST', url: cancelPath, on: () => {}, headers: {} }
    const res = {
      writeHead: () => {},
      write: () => {},
      end: () => {},
    }
    const handled = short(req, res)
    assert.strictEqual(handled, false,
      `${cancelPath} 的短前缀 handler 必须显式 return false，否则中间件会把它吃掉`)
  }
})

// 变异检查：把排除删掉，守卫必须变红。
//   守卫测试自己也会坏：一个改坏了实现还照样绿的守卫，等于没有守卫。
//
//   变异后的模块必须放在 core/ 目录里：wizardbridge.js 内部用相对路径 require 同目录的模块，
//   写到临时目录会报「Cannot find module './resolve'」，测的就不是原逻辑了。
test('变异检查：去掉排除后上面的断言会变红', () => {
  const coreDir = path.join(__dirname, '..', 'core')
  const source = fs.readFileSync(path.join(coreDir, 'wizardbridge.js'), 'utf8')
  const lines = source.split('\n')

  // 定位 handleDownload 函数体内部的那一行排除。
  //   不能用「文件里第一个含这个字符串的行」：handleDownloadCancel 里也有同一个
  //   startsWith 字符串，命中它就等于变异了另一个函数，测不到 handleDownload。
  const fnStart = lines.findIndex((l) => /^function handleDownload \(/.test(l))
  assert.ok(fnStart >= 0, '应当能找到 handleDownload 的定义')
  const fnEnd = lines.findIndex((l, i) => i > fnStart && /^}\s*$/.test(l))
  assert.ok(fnEnd > fnStart, '应当能找到 handleDownload 的结尾')

  const idx = lines.findIndex((l, i) =>
    i > fnStart && i < fnEnd &&
    l.includes("startsWith('/wizard/download/cancel')") && l.includes('return false'))
  assert.ok(idx >= 0, 'handleDownload 里应当有排除 /wizard/download/cancel 的那一行')

  // 模拟「删掉排除」：把那一行换成注释
  const mutated = lines.slice()
  mutated[idx] = '// ' + mutated[idx]
  const mutatedSource = mutated.join('\n')

  const mutantPath = path.join(coreDir, `__mutant_wizardbridge_${process.pid}.js`)
  fs.writeFileSync(mutantPath, mutatedSource)
  try {
    const mutant = require(mutantPath)
    const req = { method: 'POST', url: '/wizard/download/cancel', on: () => {}, headers: {} }
    const res = { writeHead: () => {}, write: () => {}, end: () => {} }
    assert.strictEqual(mutant.handleDownload(req, res), true,
      '去掉排除后短前缀 handler 会接管 cancel —— 这正是守卫要防的那件事')
  } finally {
    fs.rmSync(mutantPath, { force: true })
  }
})

// ---------------------------------------------------------------------------
// ② 真机路由：cancel 端点必须经过中间件链拿到 JSON
// ---------------------------------------------------------------------------

test('真机路由：POST /wizard/download/cancel 经过中间件拿到 JSON，不是 HTML fallback', async () => {
  const handlers = [
    BRIDGE.handleDownloadFile, BRIDGE.handleDownloadFiles, BRIDGE.handleDownloadProgress,
    BRIDGE.handleDownloadCancel,
    BRIDGE.handleDownload,
  ]
  const r = await serveWith(handlers, 'POST', '/wizard/download/cancel', { id: 'nobody-here' })
  assert.ok(r.type && r.type.includes('application/json'),
    `cancel 端点必须回 JSON，实际是 ${r.type}：${r.text.slice(0, 120)}`)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.json.ok, true)
  // 没有在跑的下载时如实报「没找到」，不假装取消成功
  assert.strictEqual(r.json.cancelled, false)
})

test('真机路由：cancel 端点缺 id 时报 400，不静默 404', async () => {
  const handlers = [
    BRIDGE.handleDownloadFile, BRIDGE.handleDownloadFiles, BRIDGE.handleDownloadProgress,
    BRIDGE.handleDownloadCancel,
    BRIDGE.handleDownload,
  ]
  const r = await serveWith(handlers, 'POST', '/wizard/download/cancel', {})
  assert.strictEqual(r.status, 400)
  assert.ok(r.type && r.type.includes('application/json'),
    `cancel 端点必须回 JSON，实际是 ${r.type}`)
})

// ---------------------------------------------------------------------------
// ③ 真下载取消：真的下到一半取消，验证请求中断 + 半截文件被删
// ---------------------------------------------------------------------------

test('真下载取消：下载中途取消 ⇒ 报 CANCELLED、半截 .tmp 被删、不留下正式文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-dlcancel-'))
  const checkpointsDir = path.join(root, 'engines', 'demo', 'checkpoints')

  // 一个慢速服务器：每 100ms 才吐一点，足够让下载处于「进行中」
  let served = 0
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1000000' })
    const timer = setInterval(() => {
      served += 100
      if (served >= 1000000) {
        clearInterval(timer)
        res.end()
        return
      }
      res.write(Buffer.alloc(100))
    }, 20)
    res.on('close', () => clearInterval(timer))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/big.bin`

  const ac = new AbortController()
  const file = { name: 'big.bin', size: 1000000 }
  const p = downloadFileFromUrl(url, file, 'owner/repo', root, 'demo', null, null, 0, false, ac.signal)

  // 等服务器开始吐数据，确认下载真的在跑
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(served > 0, '服务器应该已经开始吐数据，否则测的不是「下载中途」')

  ac.abort()
  const result = await p

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.code, 'CANCELLED', `取消的返回码应当是 CANCELLED，实际是 ${result.code}`)

  const finalPath = path.join(checkpointsDir, 'big.bin')
  const tmpPath = finalPath + '.tmp'
  assert.ok(!fs.existsSync(finalPath), '取消后不应留下正式文件')
  assert.ok(!fs.existsSync(tmpPath), '取消后应删掉半截 .tmp（留着会被下次下载当成续传起点）')

  server.close()
})

test('真下载取消：信号在请求发出前就触发 ⇒ 什么都不做，直接报 CANCELLED', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-dlcancel2-'))
  const ac = new AbortController()
  ac.abort()
  const file = { name: 'never.bin', size: 10 }
  const r = await downloadFileFromUrl(
    'http://127.0.0.1:1/never.bin', file, 'owner/repo', root, 'demo', null, null, 0, false, ac.signal)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'CANCELLED')
  const dir = path.join(root, 'engines', 'demo', 'checkpoints')
  assert.ok(!fs.existsSync(path.join(dir, 'never.bin')))
})
