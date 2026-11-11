const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')

// 大权重文件在一次连接里传不完时，已经写入的字节仍然有效。这一组守卫
//   盯住两件事：瞬时网络故障要保留 .tmp 并从断点续传，取消与写盘错误
//   不能因此变成续传。

const ROOT = path.resolve(__dirname, '..', '..', '..')
const D = require(path.join(ROOT, 'tools', 'engine-wizard', 'core', 'download.js'))

test('只有连接重置一类的瞬时故障才触发续传', () => {
  assert.strictEqual(D.isTransientNetworkError({ code: 'ECONNRESET', message: 'read ECONNRESET' }), true)
  assert.strictEqual(D.isTransientNetworkError({ code: 'ETIMEDOUT' }), true)
  assert.strictEqual(D.isTransientNetworkError({ message: 'socket hang up' }), true)
  assert.strictEqual(D.isTransientNetworkError({ code: 'ENOENT', message: 'no such file' }), false)
  assert.strictEqual(D.isTransientNetworkError({}), false)
  assert.strictEqual(D.isTransientNetworkError(null), false)
})

function serveThenBreak (payload, onRange) {
  let broken = false
  const server = http.createServer((req, res) => {
    const range = req.headers.range
    if (!range && !broken) {
      broken = true
      res.writeHead(200, { 'content-length': String(payload.length), 'content-type': 'application/octet-stream' })
      res.write(payload.subarray(0, 4096))
      setTimeout(() => { try { res.socket.destroy() } catch (e) { /* 已关闭 */ } }, 20)
      return
    }
    const m = /bytes=(\d+)-/.exec(range || '')
    const start = m ? Number(m[1]) : 0
    if (start > 0) onRange(start)
    res.writeHead(start > 0 ? 206 : 200, {
      'content-length': String(payload.length - start),
      ...(start > 0 ? { 'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {}),
      'content-type': 'application/octet-stream',
    })
    res.end(payload.subarray(start))
  })
  return server
}

test('连接中断后从 .tmp 续传，最终文件完整', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-resume-'))
  const payload = crypto.randomBytes(64 * 1024)
  const ranges = []
  const server = serveThenBreak(payload, (n) => ranges.push(n))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${server.address().port}/big.bin`
    const lines = []
    const result = await D.downloadFileFromUrl(url,
      { name: 'big.bin', size: payload.length }, 'org/repo', root, 'demo',
      (t) => lines.push(t), null)
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    assert.ok((result.resumeRetries || 0) >= 1, '应当至少发生一次续传')
    assert.deepStrictEqual(ranges, [4096], '第二次请求必须从已写入的字节继续')
    const finalPath = D.destPath(root, 'demo', '', 'big.bin')
    assert.deepStrictEqual(fs.readFileSync(finalPath), payload)
    assert.ok(lines.some((t) => String(t).includes('继续')), '续传要给用户可见的提示')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('取消仍然删掉半截文件，不留下续传起点', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-resume-cancel-'))
  const payload = crypto.randomBytes(64 * 1024)
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': String(payload.length), 'content-type': 'application/octet-stream' })
    res.write(payload.subarray(0, 4096))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${server.address().port}/big.bin`
    const ac = new AbortController()
    const pending = D.downloadFileFromUrl(url,
      { name: 'big.bin', size: payload.length }, 'org/repo', root, 'demo',
      null, null, 0, false, ac.signal)
    setTimeout(() => ac.abort(), 40)
    const result = await pending
    assert.strictEqual(result.code, 'CANCELLED')
    const tmpPath = D.destPath(root, 'demo', '', 'big.bin') + '.tmp'
    assert.strictEqual(fs.existsSync(tmpPath), false)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
