'use strict'
// 参考音频上传端点：第 5 步的「选择文件…」靠它把浏览器里的文件变成一条绝对路径。
// 页面脚本拿不到本机绝对路径，宿主又只认绝对路径，这一段必须在后端落地。
// 测试直接打 HTTP：真起一个 server 把 handler 挂上去，顺带验证它的接管判据。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const wb = require('../core/wizardbridge.js')

const ROOT = path.join(__dirname, '..', '..', '..')
const ID = 'unit-test-refupload'

async function withServer (fn) {
  const server = http.createServer((req, res) => {
    if (wb.handleRefUpload(req, res) === true) return
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const port = server.address().port
  try { return await fn(port) } finally { await new Promise((ok) => server.close(ok)) }
}

const post = (port, url, body) => new Promise((resolve, reject) => {
  const req = http.request(
    { host: '127.0.0.1', port, path: url, method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': body.length } },
    (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => {
        let j = null
        try { j = JSON.parse(b) } catch (e) { j = null }
        resolve({ status: res.statusCode, json: j })
      })
    })
  req.on('error', reject)
  req.end(body)
})

test('落一份副本，回传的是绝对路径', async () => {
  const bytes = Buffer.alloc(2048, 7)
  const r = await withServer((port) => post(port,
    `/wizard/ref-upload?id=${ID}&name=clip.wav`, bytes))
  assert.strictEqual(r.status, 200, JSON.stringify(r.json))
  assert.strictEqual(r.json.ok, true)
  assert.ok(path.isAbsolute(r.json.path), `回传的必须是绝对路径：${r.json.path}`)
  assert.ok(r.json.path.endsWith(path.join(ID, 'clip.wav')), r.json.path)
  const onDisk = fs.statSync(r.json.path)
  assert.strictEqual(onDisk.size, bytes.length, '落盘字节数要与上传的一致')
  fs.rmSync(path.dirname(r.json.path), { recursive: true, force: true })
})

test('文件名只取最后一段，不许跳出落点目录', async () => {
  const r = await withServer((port) => post(port,
    `/wizard/ref-upload?id=${ID}&name=${encodeURIComponent('../../escape.wav')}`, Buffer.from('x')))
  assert.strictEqual(r.status, 200, JSON.stringify(r.json))
  assert.ok(!r.json.path.includes('..'), `路径里不许出现上跳：${r.json.path}`)
  assert.ok(r.json.path.startsWith(path.join(ROOT, 'state', 'ref-audio')),
    `必须落在 state/ref-audio 下：${r.json.path}`)
  fs.rmSync(path.dirname(r.json.path), { recursive: true, force: true })
})

test('不是音频扩展名就拒绝，并说清认哪些', async () => {
  const r = await withServer((port) => post(port,
    `/wizard/ref-upload?id=${ID}&name=note.txt`, Buffer.from('x')))
  assert.strictEqual(r.status, 400)
  assert.strictEqual(r.json.ok, false)
  assert.match(r.json.errorZh || '', /wav/, '中文提示里要列出可用的格式')
})

test('id 非法直接拒绝，不建目录', async () => {
  const r = await withServer((port) => post(port,
    `/wizard/ref-upload?id=${encodeURIComponent('../etc')}&name=a.wav`, Buffer.from('x')))
  assert.strictEqual(r.status, 400)
  assert.strictEqual(r.json.ok, false)
  assert.ok(!fs.existsSync(path.join(ROOT, 'state', 'ref-audio', '..', 'etc')),
    '不许因为一个坏 id 建出目录')
})
