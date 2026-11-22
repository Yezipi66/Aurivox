const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')

// 下载完成的判定分三层，这一组守卫按层盯住：
//   协议层：续传起点是否与请求一致（看 Content-Range，不看状态码）
//   传输层：报文是否收全、字节数是否等于应到
//   内容层：远端给了 SHA-256 时以哈希为准
// 判据的选择在下载前就由清单决定，收尾时不再改判。

const ROOT = path.resolve(__dirname, '..', '..', '..')
const D = require(path.join(ROOT, 'tools', 'engine-wizard', 'core', 'download.js'))

function shaOf (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function tmpRoot (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aurivox-verify-${tag}-`))
}

function listen (handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

function putTmp (root, id, name, bytes) {
  const finalPath = D.destPath(root, id, '', name)
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  fs.writeFileSync(finalPath + '.tmp', bytes)
  return finalPath
}

// ---- 协议层：续传起点 ----

test('206 却从字节 0 发全量 ⇒ 拒绝拼接，删掉临时文件', async () => {
  const root = tmpRoot('start')
  const payload = crypto.randomBytes(8192)
  const finalPath = putTmp(root, 'demo', 'big.bin', payload.subarray(0, 4096))
  const { server, base } = await listen((req, res) => {
    // 收到 Range 却回 206 并从 0 开始发送：把全量追加到残留文件之后会得到
    //   一份尺寸更大、内容错位的文件。
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length),
      'content-range': `bytes 0-${payload.length - 1}/${payload.length}`,
    })
    res.end(payload)
  })
  try {
    const r = await D.downloadFileFromUrl(`${base}/big.bin`,
      { name: 'big.bin', size: payload.length }, 'org/repo', root, 'demo', null, null)
    assert.strictEqual(r.ok, false, JSON.stringify(r))
    assert.strictEqual(r.code, 'RANGE_START_MISMATCH')
    assert.strictEqual(r.failed_at, 'range')
    assert.strictEqual(r.expected, 4096)
    assert.strictEqual(r.actual, 0)
    assert.strictEqual(fs.existsSync(finalPath), false, '不许落下拼接后的文件')
    assert.strictEqual(fs.existsSync(finalPath + '.tmp'), false, '临时文件要删掉')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('200 但带正确的 Content-Range ⇒ 认作合法续传（魔搭的响应形态）', async () => {
  const root = tmpRoot('ms')
  const payload = crypto.randomBytes(8192)
  const finalPath = putTmp(root, 'demo', 'big.bin', payload.subarray(0, 4096))
  const { server, base } = await listen((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || '')
    const start = m ? Number(m[1]) : 0
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length - start),
      'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
    })
    res.end(payload.subarray(start))
  })
  try {
    const r = await D.downloadFileFromUrl(`${base}/big.bin`,
      { name: 'big.bin', size: payload.length }, 'org/repo', root, 'demo', null, null)
    assert.strictEqual(r.ok, true, JSON.stringify(r))
    assert.deepStrictEqual(fs.readFileSync(finalPath), payload)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('续传请求被回 200 且没有 Content-Range ⇒ 首次从零重下', async () => {
  const root = tmpRoot('ignore')
  const payload = crypto.randomBytes(4096)
  const finalPath = putTmp(root, 'demo', 'big.bin', Buffer.alloc(1024))
  let ranged = 0
  const { server, base } = await listen((req, res) => {
    if (req.headers.range) ranged++
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length),
    })
    res.end(payload)
  })
  try {
    const r = await D.downloadFileFromUrl(`${base}/big.bin`,
      { name: 'big.bin', size: payload.length }, 'org/repo', root, 'demo', null, null)
    assert.strictEqual(r.ok, true, JSON.stringify(r))
    assert.ok(ranged >= 1, '第一次应当尝试续传')
    assert.deepStrictEqual(fs.readFileSync(finalPath), payload, '从零重下后内容必须与远端一致')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---- 内容层 ----

test('远端给了 sha256 且相符 ⇒ 成功，标明按哈希核对', async () => {
  const root = tmpRoot('hash-ok')
  const payload = Buffer.from('weights-and-config')
  const { server, base } = await listen((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length),
    })
    res.end(payload)
  })
  try {
    const r = await D.downloadFileFromUrl(`${base}/m.bin`,
      { name: 'm.bin', size: payload.length, sha256: shaOf(payload) },
      'org/repo', root, 'demo', null, null)
    assert.strictEqual(r.ok, true, JSON.stringify(r))
    assert.strictEqual(r.criterion, 'hash')
    assert.strictEqual(r.shaVerified, true)
    assert.strictEqual(r.state, 'done')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('大小对但 sha256 不符 ⇒ 报内容不符，不落正式文件', async () => {
  const root = tmpRoot('hash-bad')
  const payload = Buffer.from('actually-not-the-file')
  const { server, base } = await listen((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length),
    })
    res.end(payload)
  })
  try {
    const r = await D.downloadFileFromUrl(`${base}/m.bin`,
      { name: 'm.bin', size: payload.length, sha256: shaOf(Buffer.from('expected')) },
      'org/repo', root, 'demo', null, null)
    assert.strictEqual(r.ok, false, JSON.stringify(r))
    assert.strictEqual(r.code, 'CONTENT_MISMATCH')
    assert.strictEqual(r.failed_at, 'hash')
    assert.ok(r.expectedSha && r.sha256 && r.expectedSha !== r.sha256)
    assert.match(r.errorZh, /SHA-256/)
    const finalPath = D.destPath(root, 'demo', '', 'm.bin')
    assert.strictEqual(fs.existsSync(finalPath), false)
    assert.strictEqual(fs.existsSync(finalPath + '.tmp'), false)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('sha256 相符但清单尺寸写错 ⇒ 仍然成功，只附一条提示（不误杀正确文件）', async () => {
  const root = tmpRoot('hash-size-drift')
  const payload = Buffer.from('the-real-bytes')
  const { server, base } = await listen((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length),
    })
    res.end(payload)
  })
  try {
    const r = await D.downloadFileFromUrl(`${base}/m.bin`,
      { name: 'm.bin', size: payload.length + 999, sha256: shaOf(payload) },
      'org/repo', root, 'demo', null, null)
    assert.strictEqual(r.ok, true, JSON.stringify(r))
    assert.ok(r.noteZh && r.noteZh.includes('以哈希为准'), r.noteZh)
    const finalPath = D.destPath(root, 'demo', '', 'm.bin')
    assert.deepStrictEqual(fs.readFileSync(finalPath), payload)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---- 传输层 ----

test('既无大小也无 sha：报文完整收下 ⇒ 成功但标未校验', async () => {
  const root = tmpRoot('unverified')
  const payload = Buffer.from('no-metadata-at-all')
  const { server, base } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(payload)
  })
  try {
    const r = await D.downloadFileFromUrl(`${base}/m.bin`,
      { name: 'm.bin', size: 0 }, 'org/repo', root, 'demo', null, null)
    assert.strictEqual(r.ok, true, JSON.stringify(r))
    assert.strictEqual(r.code, 'OK_UNVERIFIED')
    assert.strictEqual(r.criterion, 'none')
    assert.strictEqual(r.state, 'unverified')
    assert.strictEqual(r.shaVerified, false)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('报文没有收全 ⇒ 判失败，不留正式文件（不进入内容核对）', async () => {
  const root = tmpRoot('incomplete')
  const payload = crypto.randomBytes(64 * 1024)
  const { server, base } = await listen((req, res) => {
    // 不声明长度（分块传输），发一半后断开：报文不完整。
    //   客户端会先尝试续传，而这个服务端不认字节范围，于是停在协议层。
    //   两种码都表示「传输层出了问题」，共同的判据是不许报成功、不许落正式文件。
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.write(payload.subarray(0, 8192))
    setTimeout(() => { try { res.socket.destroy() } catch (e) { /* 已关闭 */ } }, 20)
  })
  try {
    const r = await D.downloadFileFromUrl(`${base}/m.bin`,
      { name: 'm.bin', size: payload.length, sha256: shaOf(payload) },
      'org/repo', root, 'demo', null, null)
    assert.strictEqual(r.ok, false, JSON.stringify(r))
    assert.ok(['INCOMPLETE_TRANSFER', 'RANGE_NOT_HONOURED', 'DOWNLOAD_ERROR', 'REQUEST_ERROR'].includes(r.code),
      `应当是传输层失败，实际 ${r.code}`)
    assert.strictEqual(r.shaVerified, undefined, '传输层失败时不做内容核对')
    const finalPath = D.destPath(root, 'demo', '', 'm.bin')
    assert.strictEqual(fs.existsSync(finalPath), false)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkFileStatus 带出这条清单用的判据', async () => {
  const root = tmpRoot('criterion')
  const content = Buffer.from('weights')
  const dir = path.join(root, 'engines', 'demo', 'checkpoints')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'm.bin'), content)

  const byHash = await D.checkFileStatus('m.bin', content.length, root, 'demo', shaOf(content))
  assert.strictEqual(byHash.criterion, 'hash')

  const bySize = await D.checkFileStatus('m.bin', content.length, root, 'demo', null)
  assert.strictEqual(bySize.criterion, 'size')

  const none = await D.checkFileStatus('m.bin', 0, root, 'demo', null)
  assert.strictEqual(none.criterion, 'none')
  fs.rmSync(root, { recursive: true, force: true })
})

// ---- 清单：HF 的 LFS 哈希要真的读出来 ----

test('HF 清单解析出 lfs.sha256，供下载与事后核对使用', async () => {
  const payload = '{"siblings":[{"rfilename":"LLM/model.safetensors","size":123,' +
    '"lfs":{"sha256":"abc123","size":123}},{"rfilename":"config.yaml","size":9}]}'
  const { server, base } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(payload)
  })
  try {
    const r = await D.fetchRemoteManifest('org/repo', 'hf', base)
    assert.strictEqual(r.ok, true, JSON.stringify(r))
    const weight = r.files.find((f) => f.name === 'LLM/model.safetensors')
    const config = r.files.find((f) => f.name === 'config.yaml')
    assert.strictEqual(weight.sha256, 'abc123', 'LFS 文件的 lfs.sha256 就是内容哈希')
    assert.strictEqual(config.sha256, null, '非 LFS 文件没有内容哈希，不能拿 blobId 冒充')
  } finally {
    server.close()
  }
})

test('续传响应只给了本段范围、总量未知 ⇒ 不声称完整（标未校验）', async () => {
  const root = tmpRoot('star-total')
  const payload = Buffer.from('0123456789abcdef')
  const finalPath = putTmp(root, 'demo', 'm.bin', payload.subarray(0, 8))
  const { server, base } = await listen((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || '')
    const start = m ? Number(m[1]) : 0
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length - start),
      // 服务端只声明本段范围，不给出文件总量
      'content-range': `bytes ${start}-${payload.length - 1}/*`,
    })
    res.end(payload.subarray(start))
  })
  try {
    const r = await D.downloadFileFromUrl(`${base}/m.bin`,
      { name: 'm.bin', size: 0 }, 'org/repo', root, 'demo', null, null)
    assert.strictEqual(r.ok, true, JSON.stringify(r))
    assert.strictEqual(r.state, 'unverified', '总量未知时不得声称已核对完整')
    assert.strictEqual(r.code, 'OK_UNVERIFIED')
    assert.deepStrictEqual(fs.readFileSync(finalPath), payload)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('清单行把远端哈希与本地哈希分开，下载时用远端那一份做期望值', async () => {
  const root = tmpRoot('remote-sha')
  const localContent = Buffer.from('what-is-on-disk')
  const remoteSha = shaOf(Buffer.from('what-the-remote-has'))
  const dir = path.join(root, 'engines', 'demo', 'checkpoints')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'm.bin'), localContent)

  const out = await D.enrichManifestFiles(
    [{ name: 'm.bin', size: localContent.length, sha256: remoteSha }], 'org/repo', 'hf', root, 'demo')
  assert.strictEqual(out[0].remote_sha256, remoteSha, '远端哈希要单独留一份')
  assert.strictEqual(out[0].sha256, shaOf(localContent), 'sha256 是盘上实际算出的值')
  assert.strictEqual(out[0].status, 'partial', '本地哈希与远端不符时这条应当报残缺')
  fs.rmSync(root, { recursive: true, force: true })
})

test('魔搭清单取 Path 而不是 Name：子目录里的文件不会拼出 404 的地址', async () => {
  const payload = '{"Data":{"Files":[' +
    '{"Type":"blob","Name":"config.json","Path":"CosyVoice-BlankEN/config.json","Size":659,"Sha256":"aa11"},' +
    '{"Type":"tree","Name":"sub","Path":"sub","Size":0},' +
    '{"Type":"blob","Name":".gitattributes","Path":".gitattributes","Size":12,"Sha256":"bb22"}]}}'
  const { server, base } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(payload)
  })
  try {
    const r = await D.fetchRemoteManifest('org/repo', 'modelscope', base)
    assert.strictEqual(r.ok, true, JSON.stringify(r))
    assert.deepStrictEqual(r.files.map((f) => f.name),
      ['CosyVoice-BlankEN/config.json', '.gitattributes'], '目录项要滤掉，路径要保留')
    const url = D.fileUrl({ ...r.files[0], tool: 'modelscope' }, 'org/repo', 'master',
      'CosyVoice-BlankEN/config.json')
    assert.ok(url.endsWith('/CosyVoice-BlankEN/config.json'), url)
  } finally {
    server.close()
  }
})
