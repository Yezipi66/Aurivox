'use strict'
// 直链兜底：真起一个本地 HTTP 服务下一个小文件，确认它落在声明的权重目录里。
//   同时钉住几道拒绝：非 http(s)、读不出文件名、越界的 id。
//   不联网、不碰真实引擎目录，临时目录用完即删。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { PassThrough } = require('node:stream')

const { handleDownloadUrl } = require('../core/wizardbridge.js')

function callUrl (body, opts = {}) {
  return new Promise((resolve) => {
    const req = new PassThrough()
    req.method = opts.method || 'POST'
    req.url = opts.url || '/wizard/download/url'
    const chunks = []
    const res = {
      headersSent: false,
      writeHead (code) { this.status = code; this.headersSent = true },
      write (s) { chunks.push(String(s)) },
      end (chunk) { if (chunk) chunks.push(String(chunk)); resolve({ status: this.status, body: chunks.join('') }) },
    }
    assert.strictEqual(handleDownloadUrl(req, res), true, '这个 URL 应该由它接管')
    req.end(JSON.stringify(body))
  })
}

function tmpRoot () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-url-'))
  fs.mkdirSync(path.join(root, 'engines', 'demo'), { recursive: true })
  return root
}

function drop (root) {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch (e) { /* 清理失败不影响断言 */ }
}

test('非 http(s) 链接：不写盘，直接 400', async () => {
  const root = tmpRoot()
  const r = await callUrl({ id: 'demo', root, url: 'ftp://example.com/model.bin' })
  assert.strictEqual(r.status, 400)
  assert.match(r.body, /BAD_URL/)
  drop(root)
})

test('越界 id：不写盘，直接 400', async () => {
  const root = tmpRoot()
  const r = await callUrl({ id: '../outside', root, url: 'http://127.0.0.1:1/model.bin' })
  assert.strictEqual(r.status, 400)
  assert.match(r.body, /BAD_ID/)
  drop(root)
})

test('链接里读不出文件名：不写盘，直接 400', async () => {
  const root = tmpRoot()
  const r = await callUrl({ id: 'demo', root, url: 'http://127.0.0.1:1/' })
  assert.strictEqual(r.status, 400)
  assert.match(r.body, /BAD_NAME/)
  drop(root)
})

test('真下一个文件：落在名片声明的权重目录，名字与内容都对', async () => {
  const root = tmpRoot()
  const payload = Buffer.from('wizard-direct-link')
  const server = http.createServer((req, res) => {
    if (req.url === '/model.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(payload)
      return
    }
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<html>not found</html>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const r = await callUrl({ id: 'demo', root, url: `http://127.0.0.1:${port}/model.bin` })
    assert.strictEqual(r.status, 200)
    assert.match(r.body, /"ok":true/)
    const dest = path.join(root, 'engines', 'demo', 'checkpoints', 'model.bin')
    assert.ok(fs.existsSync(dest), '文件要落在 weightsDir 下')
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), payload.toString())
  } finally {
    await new Promise((r) => server.close(r))
    drop(root)
  }
})

test('404 的 HTML 页面不许当权重落盘', async () => {
  const root = tmpRoot()
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<html>not found</html>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const r = await callUrl({ id: 'demo', root, url: `http://127.0.0.1:${port}/missing.bin` })
    assert.match(r.body, /HTTP_404/)
    assert.ok(!fs.existsSync(path.join(root, 'engines', 'demo', 'checkpoints', 'missing.bin')))
  } finally {
    await new Promise((r) => server.close(r))
    drop(root)
  }
})
