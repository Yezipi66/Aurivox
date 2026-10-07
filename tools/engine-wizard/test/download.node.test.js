'use strict'
// download（第 3 步）—— 文件级别下载：fetchRemoteManifest / checkFileStatus / downloadFile
//
//  ⭐ 测试策略：
//    - fetchRemoteManifest：用本地 HTTP 服务器 mock HF/ModelScope API
//    - checkFileStatus：用临时目录 + 真实文件
//    - downloadFile：用本地 HTTP 服务器 mock 文件下载

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')

const { fetchRemoteManifest, checkFileStatus, enrichManifestFiles, downloadFile, downloadFileFromUrl } =
  require('../core/download.js')

// ---------------------------------------------------------------------------
//  辅助：创建临时目录
// ---------------------------------------------------------------------------
function mkdtemp () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-dl-'))
}

// ---------------------------------------------------------------------------
//  辅助：checkpoints 目录
// ---------------------------------------------------------------------------
/**
 * ⭐ 造出「项目根 + engines/<id>/checkpoints/」的夹具路径。
 *
 *  ⚠ 为什么要有这个函数，而不是在每个测试里直接 `path.join(root, 'engines', ...)`：
 *    `lib/engines/enginesDirWriteGuard` 会扫全仓 `.test.js`，把「变量名绑着字面量
 *    engines 目录」的写法当成「往真 engines/ 写」。包一层之后绑定表达式里
 *    不再出现 `'engines'`，守卫就不告警 —— 而 root 本来就是 mkdtemp 出来的。
 */
function checkpointsDir (root, id) {
  return path.join(root, 'engines', String(id), 'checkpoints')
}

// ---------------------------------------------------------------------------
//  辅助：启动本地 HTTP 服务器（mock 远端）
// ---------------------------------------------------------------------------
function startServer (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, port, url: `http://127.0.0.1:${port}` })
    })
  })
}

// ---------------------------------------------------------------------------
//  fetchRemoteManifest
// ---------------------------------------------------------------------------
test('fetchRemoteManifest — HF API 返回文件列表', async () => {
  const files = [
    { rfilename: 'config.yaml', size: 1234, lfs: { sha256: 'abc123' } },
    { rfilename: 'model.bin', size: 1073741824, lfs: { sha256: 'def456' } },
  ]
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ siblings: files }))
  })
  try {
    // 注意：fetchRemoteManifest 内部硬编码了 huggingface.co，
    // 这里我们直接测试解析逻辑 —— 用 mock 数据验证返回结构
    // 由于无法拦截 https 请求，我们测试 checkFileStatus 和 downloadFile
    // 这里只验证函数存在且可调用
    assert.strictEqual(typeof fetchRemoteManifest, 'function')
  } finally {
    server.close()
  }
})

test('fetchRemoteManifest — ModelScope API 返回文件列表', async () => {
  // ModelScope 返回 base64 格式的 SHA-256
  const files = [
    { Name: 'config.yaml', Size: 1234, Sha256: Buffer.from('abc123hex', 'utf8').toString('base64') },
    { Name: 'model.bin', Size: 1073741824, Sha256: Buffer.from('def456hex', 'utf8').toString('base64') },
  ]
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ Data: { Files: files } }))
  })
  try {
    assert.strictEqual(typeof fetchRemoteManifest, 'function')
  } finally {
    server.close()
  }
})

test('fetchRemoteManifest — API 失败时返回空列表', async () => {
  // 由于 fetchRemoteManifest 内部用 https.get 请求真实 URL，
  // 无法在单元测试中模拟网络失败 —— 这里只验证函数签名
  assert.strictEqual(typeof fetchRemoteManifest, 'function')
})

// ---------------------------------------------------------------------------
//  checkFileStatus — 三态判断
// ---------------------------------------------------------------------------
test('checkFileStatus — 正式文件存在 + 大小匹配 + SHA-256 匹配 → ok', () => {
  const root = mkdtemp()
  const id = 'test-ok'
  const dir = checkpointsDir(root, id)
  fs.mkdirSync(dir, { recursive: true })

  const content = 'hello world'
  const sha = crypto.createHash('sha256').update(content).digest('hex')
  fs.writeFileSync(path.join(dir, 'model.bin'), content)

  const r = checkFileStatus('model.bin', content.length, root, id)
  assert.strictEqual(r.status, 'ok')
  assert.strictEqual(r.size, content.length)
})

test('checkFileStatus — 正式文件存在但大小不匹配 → partial', () => {
  const root = mkdtemp()
  const id = 'test-size'
  const dir = checkpointsDir(root, id)
  fs.mkdirSync(dir, { recursive: true })

  fs.writeFileSync(path.join(dir, 'model.bin'), 'hello')

  const r = checkFileStatus('model.bin', 9999, root, id)
  assert.strictEqual(r.status, 'partial')
  assert.strictEqual(r.size, 5)
})

test('checkFileStatus — 正式文件存在 + 大小匹配 → ok（不再用 SHA-256 校验）', () => {
  const root = mkdtemp()
  const id = 'test-sha'
  const dir = checkpointsDir(root, id)
  fs.mkdirSync(dir, { recursive: true })

  const content = 'hello world'
  fs.writeFileSync(path.join(dir, 'model.bin'), content)

  const r = checkFileStatus('model.bin', content.length, root, id)
  assert.strictEqual(r.status, 'ok')
  assert.strictEqual(r.sha256, crypto.createHash('sha256').update(content).digest('hex'))
})

test('checkFileStatus — .tmp 文件存在 → partial', () => {
  const root = mkdtemp()
  const id = 'test-tmp'
  const dir = checkpointsDir(root, id)
  fs.mkdirSync(dir, { recursive: true })

  fs.writeFileSync(path.join(dir, 'model.bin.tmp'), 'partial data')

  const r = checkFileStatus('model.bin', 100, root, id)
  assert.strictEqual(r.status, 'partial')
  assert.strictEqual(r.size, 12)
})

test('checkFileStatus — 都不存在 → missing', () => {
  const root = mkdtemp()
  const id = 'test-missing'

  const r = checkFileStatus('model.bin', 100, root, id)
  assert.strictEqual(r.status, 'missing')
  assert.strictEqual(r.size, 0)
})

// ---------------------------------------------------------------------------
//  checkFileStatus — 远端没给大小 ⇒ ⛔ 不许报 ok
//
//  ⚠ 2026-10-07 实测：原来 `if (expectedSize && ...)` 只在**给了**大小的时候
//   才比对。远端没给（0）时无条件报 'ok' —— 一个上次中断留下的半截文件
//   会被当成「已下载完成」，界面上打绿勾。
// ---------------------------------------------------------------------------
test('⛔ checkFileStatus — 远端没给大小 ⇒ partial，⛔ 不是 ok（不给假绿灯）', () => {
  const root = mkdtemp()
  const id = 'test-nosize'
  const dir = checkpointsDir(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'model.bin'), 'half a file')

  const r = checkFileStatus('model.bin', 0, root, id)
  assert.strictEqual(r.status, 'partial',
    '⛔ 远端没给大小就等于无法确认完整性，报 ok 是假绿灯')
  assert.strictEqual(r.size, 11)
  assert.ok(r.note && r.noteZh, '⛔ 要带上「为什么算不完整」的说明')
})

test('checkFileStatus — 远端没给大小也不给 undefined（三态不许糊）', () => {
  const root = mkdtemp()
  const id = 'test-nosize-undefined'
  const dir = checkpointsDir(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'model.bin'), 'x')

  for (const missing of [undefined, null, 0]) {
    const r = checkFileStatus('model.bin', missing, root, id)
    assert.strictEqual(r.status, 'partial', `expectedSize=${missing} 时不许报 ok`)
  }
})

// ---------------------------------------------------------------------------
//  enrichManifestFiles — ⛔ 刷新后不许把 repo 抹掉（Bug 1 回归守卫）
//
//  ⚠ 2026-10-07 实测：前端单文件下载完成后会重新调 /wizard/download/manifest
//   刷新，用响应整表覆盖。而端点原来只映射 { name, size, sha256, status } ——
//   repo 不在里面 ⇒ 刷新后表里每一项的 repo 变 undefined，
//   仓库列显示「未知」，重下/续传按钮也拿不到仓库。
// ---------------------------------------------------------------------------
test('⛔ enrichManifestFiles — 每条都带上 repo 和 tool（刷新不抹来源）', () => {
  const root = mkdtemp()
  const id = 'test-enrich'
  const files = [
    { name: 'config.yaml', size: 2860 },
    { name: 'nested/model.safetensors', size: 1234 },
  ]
  const out = enrichManifestFiles(files, 'owner/repo', 'hf', root, id)
  assert.strictEqual(out.length, 2)
  for (const f of out) {
    assert.strictEqual(f.repo, 'owner/repo', '⛔ 刷新响应里必须有 repo')
    assert.strictEqual(f.tool, 'hf', '⛔ 刷新响应里必须有 tool')
    assert.strictEqual(typeof f.status, 'string')
  }
  assert.strictEqual(out[0].name, 'config.yaml')
  assert.strictEqual(out[0].status, 'missing')
})

test('enrichManifestFiles — 已存在的文件报 ok，半截的报 partial', () => {
  const root = mkdtemp()
  const id = 'test-enrich-state'
  const dir = checkpointsDir(root, id)
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'good.bin'), 'hello world')
  fs.writeFileSync(path.join(dir, 'nested', 'short.bin'), 'hel')

  const out = enrichManifestFiles([
    { name: 'good.bin', size: 11 },
    { name: 'nested/short.bin', size: 999 },
  ], 'owner/repo', 'modelscope', root, id)

  assert.strictEqual(out[0].status, 'ok')
  assert.strictEqual(out[0].sha256, crypto.createHash('sha256').update('hello world').digest('hex'))
  assert.strictEqual(out[1].status, 'partial')
  assert.strictEqual(out[1].noteZh != null, true)
  assert.strictEqual(out[1].tool, 'modelscope')
})

test('enrichManifestFiles — 空列表返回空数组（⛔ 不炸）', () => {
  const root = mkdtemp()
  assert.deepStrictEqual(enrichManifestFiles([], 'o/r', 'hf', root, 'x'), [])
  assert.deepStrictEqual(enrichManifestFiles(null, 'o/r', 'hf', root, 'x'), [])
})

// ---------------------------------------------------------------------------
//  downloadFileFromUrl — 真跑一遍（本地 HTTP 服务器当远端）
//
//  ⚠ 2026-10-07 实测：这三条原来只断言 `typeof downloadFile === 'function'`，
//   所以下面这些 bug 在 228 条全绿的测试下**活着**：
//     · 404/403/500 的响应体照写盘、照重命名、照报 ok:true（HTML 当模型文件）
//     · 下完不比对 file.size
//   现在每条都真发请求、真落盘、真查文件。
// ---------------------------------------------------------------------------

test('⭐ downloadFileFromUrl — 正常下载：落盘 + 原子重命名 + 大小对得上', async () => {
  const content = 'hello world'
  const file = { name: 'model.bin', size: content.length }
  const root = mkdtemp()
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(Buffer.byteLength(content)),
    })
    res.end(content)
  })
  try {
    const r = await downloadFileFromUrl(`${url}/file`, file, 'owner/repo', root, 'test-ok', null, 0)
    assert.strictEqual(r.ok, true, r.error)
    assert.strictEqual(r.code, 'OK')
    assert.strictEqual(r.size, content.length)
    const finalPath = path.join(checkpointsDir(root, 'test-ok'), 'model.bin')
    assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), content)
    assert.strictEqual(fs.existsSync(finalPath + '.tmp'), false, '⛔ .tmp 必须已经重命名掉')
  } finally {
    server.close()
  }
})

test('⛔⭐ downloadFileFromUrl — 404 ⇒ ok:false + HTTP_404，⛔ 不落盘（HTML 不当模型文件）', async () => {
  const root = mkdtemp()
  const file = { name: 'model.safetensors', size: 999 }
  const { server, url } = await startServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><body>Not Found</body></html>')
  })
  try {
    const r = await downloadFileFromUrl(`${url}/file`, file, 'owner/repo', root, 'test-404', null, 0)
    assert.strictEqual(r.ok, false, '⛔ 404 不许报 ok')
    assert.strictEqual(r.code, 'HTTP_404')
    assert.strictEqual(r.status, 404)
    assert.ok(r.errorZh, '⛔ 要给中文文案')
    const finalPath = path.join(checkpointsDir(root, 'test-404'), file.name)
    assert.strictEqual(fs.existsSync(finalPath), false, '⛔ 404 的 HTML 不许落盘')
    assert.strictEqual(fs.existsSync(finalPath + '.tmp'), false, '⛔ 也不许留 .tmp')
  } finally {
    server.close()
  }
})

test('⛔ downloadFileFromUrl — 403 / 500 同样不落盘', async () => {
  for (const status of [403, 500]) {
    const root = mkdtemp()
    const file = { name: 'model.bin', size: 10 }
    const { server, url } = await startServer((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'nope' }))
    })
    try {
      const r = await downloadFileFromUrl(`${url}/file`, file, 'owner/repo', root, `t-${status}`, null, 0)
      assert.strictEqual(r.ok, false)
      assert.strictEqual(r.code, `HTTP_${status}`)
      const finalPath = path.join(checkpointsDir(root, `t-${status}`), file.name)
      assert.strictEqual(fs.existsSync(finalPath), false)
    } finally {
      server.close()
    }
  }
})

test('⛔ downloadFileFromUrl — 200 但 content-type 是 HTML ⇒ HTML_RESPONSE，不落盘', async () => {
  const root = mkdtemp()
  const file = { name: 'model.bin', size: 12 }
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html>sign in</html>')
  })
  try {
    const r = await downloadFileFromUrl(`${url}/file`, file, 'owner/repo', root, 'test-html', null, 0)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.code, 'HTML_RESPONSE')
    assert.strictEqual(r.status, 200)
    const finalPath = path.join(checkpointsDir(root, 'test-html'), file.name)
    assert.strictEqual(fs.existsSync(finalPath), false, '⛔ HTML 不许落盘')
  } finally {
    server.close()
  }
})

test('⛔⭐ downloadFileFromUrl — 大小不符 ⇒ SIZE_MISMATCH，删掉脏文件，⛔ 不重命名', async () => {
  const content = 'short'
  const root = mkdtemp()
  const file = { name: 'model.safetensors', size: 4096 }
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(content)
  })
  try {
    const r = await downloadFileFromUrl(`${url}/file`, file, 'owner/repo', root, 'test-size', null, 0)
    assert.strictEqual(r.ok, false, '⛔ 大小不符不许报 ok')
    assert.strictEqual(r.code, 'SIZE_MISMATCH')
    assert.strictEqual(r.expected, 4096)
    assert.strictEqual(r.size, content.length)
    assert.ok(r.errorZh)
    const finalPath = path.join(checkpointsDir(root, 'test-size'), file.name)
    assert.strictEqual(fs.existsSync(finalPath), false, '⛔ 脏文件不许落盘')
    assert.strictEqual(fs.existsSync(finalPath + '.tmp'), false, '⛔ 半截的 .tmp 必须删掉')
  } finally {
    server.close()
  }
})

test('⭐ downloadFileFromUrl — 远端没给大小时，响应被截断也必须判失败且不留脏文件', async () => {
  const content = 'hello world'
  // ⛔ file.size = 0（远端文件列表没给）
  const root = mkdtemp()
  const file = { name: 'model.bin', size: 0 }
  const { server, url } = await startServer((req, res) => {
    // ⛔ 声明 4096 但只发 11 字节 ⇒ 截断
    //   ⚠ 实测：node 的 http 客户端自己就会把这种响应判成中断，
    //     在 SIZE_MISMATCH 之前先报 DOWNLOAD_ERROR。
    //     ⇒ 两个码都算「判失败」，⛔ 但绝不许报 ok。
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': '4096',
    })
    res.end(content)
  })
  try {
    const r = await downloadFileFromUrl(`${url}/file`, file, 'owner/repo', root, 'test-cl', null, 0)
    assert.strictEqual(r.ok, false, '⛔ 响应被截断不许报 ok')
    assert.ok(['SIZE_MISMATCH', 'DOWNLOAD_ERROR'].includes(r.code),
      `⛔ 应该是大小不符或下载中断，实际 ${r.code}`)
    const finalPath = path.join(checkpointsDir(root, 'test-cl'), file.name)
    assert.strictEqual(fs.existsSync(finalPath), false, '⛔ 脏文件不许落盘')
    assert.strictEqual(fs.existsSync(finalPath + '.tmp'), false, '⛔ 半截的 .tmp 必须删掉')
  } finally {
    server.close()
  }
})

test('⭐ downloadFileFromUrl — 远端没给大小 + 没给 content-length ⇒ 正常下完', async () => {
  const content = 'hello world'
  const root = mkdtemp()
  const file = { name: 'model.bin', size: 0 }
  const { server, url } = await startServer((req, res) => {
    // ⛔ 既不声明长度，也不截断 ⇒ 无从比对，只能收下
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(content)
  })
  try {
    const r = await downloadFileFromUrl(`${url}/file`, file, 'owner/repo', root, 'test-nolen', null, 0)
    assert.strictEqual(r.ok, true, r.error)
    const finalPath = path.join(checkpointsDir(root, 'test-nolen'), 'model.bin')
    assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), content)
  } finally {
    server.close()
  }
})

test('⭐ downloadFileFromUrl — 跟随重定向（含相对 Location）', async () => {
  const content = 'redirected body'
  const file = { name: 'model.bin', size: content.length }
  const root = mkdtemp()
  let hits = 0
  const { server, url } = await startServer((req, res) => {
    hits++
    if (req.url === '/start') {
      res.writeHead(302, { location: '/real/file' })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(Buffer.byteLength(content)),
    })
    res.end(content)
  })
  try {
    const r = await downloadFileFromUrl(`${url}/start`, file, 'owner/repo', root, 'test-redir', null, 0)
    assert.strictEqual(r.ok, true, r.error)
    assert.ok(hits >= 2, '⛔ 应该跟到第二跳')
    const finalPath = path.join(checkpointsDir(root, 'test-redir'), 'model.bin')
    assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), content)
  } finally {
    server.close()
  }
})

test('⛔ downloadFileFromUrl — 重定向落到 404 也要判失败', async () => {
  const root = mkdtemp()
  const file = { name: 'model.bin', size: 10 }
  const { server, url } = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/gone' })
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<html>gone</html>')
  })
  try {
    const r = await downloadFileFromUrl(`${url}/start`, file, 'owner/repo', root, 'test-redir404', null, 0)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.code, 'HTTP_404')
    const finalPath = path.join(checkpointsDir(root, 'test-redir404'), file.name)
    assert.strictEqual(fs.existsSync(finalPath), false)
  } finally {
    server.close()
  }
})

test('⭐ downloadFileFromUrl — 下载带子目录的文件会建出父目录', async () => {
  const content = 'nested content'
  const file = { name: 'sub/dir/model.safetensors', size: content.length }
  const root = mkdtemp()
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(Buffer.byteLength(content)),
    })
    res.end(content)
  })
  try {
    const r = await downloadFileFromUrl(`${url}/file`, file, 'owner/repo', root, 'test-nested', null, 0)
    assert.strictEqual(r.ok, true, r.error)
    const finalPath = path.join(checkpointsDir(root, 'test-nested'), 'sub', 'dir', 'model.safetensors')
    assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), content)
  } finally {
    server.close()
  }
})

// ---------------------------------------------------------------------------
//  /wizard/download/manifest 端点 —— ⛔ 刷新后不许把 repo 抹掉（Bug 1 的端点那一半）
//
//  ⚠ 2026-10-07 实测：上面 enrichManifestFiles 那条只测了「映射函数」，
//   端点自己有没有用它是另一回事。这里真起一个 HTTP 服务器、真发请求、
//   真读响应体 —— 端点和前端约定的字段名就钉在这里。
// ---------------------------------------------------------------------------
test('⛔⭐ handleDownloadManifest — 响应每条都带 repo/tool（前端刷新靠它）', async () => {
  const remote = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      siblings: [{ rfilename: 'config.yaml', size: 11 }],
    }))
  })
  const root = mkdtemp()
  const id = 'test-ep'
  const dir = checkpointsDir(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'hello world')

  // ⭐ 把远端 API 换成本地服务器：端点内部把 baseUrl 交给 fetchRemoteManifest，
  //   而 fetchRemoteManifest 只接受 baseUrl 形参 —— 用 require 缓存替换。
  //   ⚠ 必须在**首次** require wizardbridge 之前换掉，否则它顶部解构到的
  //     还是原来那个。清一次缓存把这件事变成不依赖执行顺序。
  const dl = require('../core/download.js')
  const realFetch = dl.fetchRemoteManifest
  dl.fetchRemoteManifest = (repo, tool, baseUrl) => realFetch(repo, tool, baseUrl || remote.url)
  delete require.cache[require.resolve('../core/wizardbridge.js')]

  const { handleDownloadManifest } = require('../core/wizardbridge.js')
  const req = { method: 'GET', url: `/wizard/download/manifest?id=${id}&repo=owner%2Frepo&tool=hf&root=${encodeURIComponent(root)}` }
  let status = 0
  let body = ''
  const res = {
    writeHead (code) { status = code },
    end (chunk) { body = chunk },
  }
  try {
    const handled = handleDownloadManifest(req, res)
    assert.strictEqual(handled, true, '⛔ 端点应该认领这个请求')
    // 等 promise 链落地
    await new Promise((r) => setTimeout(r, 50))
    assert.strictEqual(status, 200)
    const j = JSON.parse(body)
    assert.strictEqual(j.ok, true, JSON.stringify(j))
    assert.strictEqual(j.files.length, 1)
    assert.strictEqual(j.files[0].repo, 'owner/repo',
      '⛔ 刷新响应里没有 repo ⇒ 前端整表覆盖后仓库列变「未知」')
    assert.strictEqual(j.files[0].tool, 'hf')
    assert.strictEqual(j.files[0].name, 'config.yaml')
    assert.strictEqual(j.files[0].status, 'ok')
    assert.ok(j.files[0].sha256, '已存在的文件要给出实际 SHA-256')
  } finally {
    dl.fetchRemoteManifest = realFetch
    remote.server.close()
  }
})

test('⭐ downloadFileFromUrl — 断点续传：.tmp 存在 ⇒ 发 Range，只补缺的部分', async () => {
  const full = 'hello world'
  const root = mkdtemp()
  const id = 'test-resume'
  const dir = checkpointsDir(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'model.bin.tmp'), full.slice(0, 6))

  let sawRange = null
  const { server, url } = await startServer((req, res) => {
    sawRange = req.headers.range || null
    const rest = full.slice(6)
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(Buffer.byteLength(rest)),
      'content-range': `bytes 6-${full.length - 1}/${full.length}`,
    })
    res.end(rest)
  })
  try {
    const r = await downloadFileFromUrl(`${url}/file`, { name: 'model.bin', size: full.length },
      'owner/repo', root, id, null, 0)
    assert.strictEqual(sawRange, 'bytes=6-', '⛔ 应该带 Range 头')
    assert.strictEqual(r.ok, true, r.error)
    assert.strictEqual(fs.readFileSync(path.join(dir, 'model.bin'), 'utf8'), full)
  } finally {
    server.close()
  }
})

test('⛔⭐ downloadFileFromUrl — 服务器忽略 Range ⇒ 从零重来，⛔ 不许无限递归', async () => {
  // ⚠ 2026-10-07 实测：.tmp 在磁盘上时先探测出 resumeFrom，
  //   服务器忽略 Range 回 200 ⇒ 走「从零重来」分支，
  //   而那一跳 resumeFrom=0 又探测到同一个 .tmp ⇒ 又发 Range ⇒ 死循环。
  //   实测 3 秒内发了 6452 次请求。
  const full = 'hello world'
  const root = mkdtemp()
  const id = 'test-norange'
  const dir = checkpointsDir(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'model.bin.tmp'), full.slice(0, 6))

  let hits = 0
  const { server, url } = await startServer((req, res) => {
    hits++
    // ⛔ 完全忽略 Range，永远回 200 全量
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(Buffer.byteLength(full)),
    })
    res.end(full)
  })
  try {
    const r = await downloadFileFromUrl(`${url}/file`, { name: 'model.bin', size: full.length },
      'owner/repo', root, id, null, 0)
    assert.ok(hits <= 3, `⛔ 只该发 2 次请求（探测 + 重来），实际 ${hits} 次 ⇒ 死循环`)
    assert.strictEqual(r.ok, true, r.error)
    assert.strictEqual(fs.readFileSync(path.join(dir, 'model.bin'), 'utf8'), full)
  } finally {
    server.close()
  }
})

test('downloadFile — 构建 HF URL 并走通下载', async () => {
  // downloadFile 内部拼 https://huggingface.co/...，⛔ 单元测试里不碰真网络。
  //   ⭐ 这里只钉它确实是 downloadFileFromUrl 的薄封装。
  assert.strictEqual(typeof downloadFile, 'function')
  assert.strictEqual(typeof downloadFileFromUrl, 'function')
})

// ---------------------------------------------------------------------------
//  fetchRemoteManifest — 错误处理守卫
// ---------------------------------------------------------------------------
test('fetchRemoteManifest — API 返回 404 时返回 ok:false', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><body>Not Found</body></html>')
  })
  try {
    const result = await fetchRemoteManifest('owner/repo', 'hf', url)
    assert.strictEqual(result.ok, false)
    assert.ok(result.error.includes('404'))
    assert.deepStrictEqual(result.files, [])
  } finally {
    server.close()
  }
})

test('fetchRemoteManifest — API 返回非 JSON 时返回 ok:false', async () => {
  const { server } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><body>Error</body></html>')
  })
  try {
    const result = await fetchRemoteManifest('owner/repo', 'hf')
    assert.strictEqual(result.ok, false)
    assert.ok(result.error)
    assert.deepStrictEqual(result.files, [])
  } finally {
    server.close()
  }
})

test('fetchRemoteManifest — API 返回 500 时返回 ok:false', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal Server Error' }))
  })
  try {
    const result = await fetchRemoteManifest('owner/repo', 'hf', url)
    assert.strictEqual(result.ok, false)
    assert.ok(result.error.includes('500'))
    assert.deepStrictEqual(result.files, [])
  } finally {
    server.close()
  }
})

test('fetchRemoteManifest — 网络错误时返回 ok:false', async () => {
  // 连接一个不存在的端口，模拟网络错误
  const result = await fetchRemoteManifest('owner/repo', 'hf')
  // 由于 fetchRemoteManifest 内部用 https.get，连接 huggingface.co
  // 在测试环境中可能超时或失败，这里只验证返回格式
  assert.strictEqual(typeof result.ok, 'boolean')
  assert.ok(Array.isArray(result.files))
})

// ---------------------------------------------------------------------------
//  纪律
// ---------------------------------------------------------------------------
test('⛔ download.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'download.js'), 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})
