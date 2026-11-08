'use strict'
// 跑上游下载脚本这条口子：能跑、输出透传、跑在引擎目录里，且不许越界。
//   它等于让使用者在本机执行一条脚本，所以三道拒绝（越界路径、非白名单扩展名、文件不存在）
//   必须挡在 spawn 之前；这里用假的 req/res 直接验 handler，不联网、不起服务。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')

const { handleRunScript } = require('../core/wizardbridge.js')

function callRun (body, opts = {}) {
  return new Promise((resolve) => {
    const req = new PassThrough()
    req.method = opts.method || 'POST'
    req.url = opts.url || '/wizard/run-script'
    const chunks = []
    const res = {
      headersSent: false,
      writeHead (code) { this.status = code; this.headersSent = true },
      write (s) { chunks.push(String(s)) },
      end (chunk) { if (chunk) chunks.push(String(chunk)); resolve({ status: this.status, body: chunks.join('') }) },
    }
    const handled = handleRunScript(req, res)
    assert.strictEqual(handled, true, '这个 URL 应该由它接管')
    req.end(JSON.stringify(body))
  })
}

function tmpEngine (files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-run-'))
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text)
  }
  return { root, dir }
}

test('越界路径：不 spawn，直接 400', async () => {
  const r = await callRun({ id: 'demo', file: '../../etc/passwd' })
  assert.strictEqual(r.status, 400)
  assert.match(r.body, /BAD_PATH/)
})

test('id 越界：不 spawn，直接 400', async () => {
  const r = await callRun({ id: '../../outside', file: 'download.js' })
  assert.strictEqual(r.status, 400)
  assert.match(r.body, /BAD_ID/)
})

test('非白名单扩展名：不 spawn，直接 400', async () => {
  const { root } = tmpEngine({ 'notes.txt': 'x' })
  const r = await callRun({ id: 'demo', root, file: 'notes.txt' })
  assert.strictEqual(r.status, 400)
  assert.match(r.body, /BAD_SCRIPT/)
})

test('文件不存在：不 spawn，直接 400', async () => {
  const { root } = tmpEngine({})
  const r = await callRun({ id: 'demo', root, file: 'download.js' })
  assert.strictEqual(r.status, 400)
  assert.match(r.body, /NO_SCRIPT/)
})

// 成功路径用 .js：node 在两个 CI 平台上都有，不依赖 bash 或引擎 venv。
test('跑 .js：输出按行透传，工作目录是引擎目录，退出码如实上报', async () => {
  const { root, dir } = tmpEngine({
    'download_demo.js': 'console.log("cwd=" + process.cwd());\nconsole.log("done");\n',
  })
  const r = await callRun({ id: 'demo', root, file: 'download_demo.js' })
  assert.strictEqual(r.status, 200)
  assert.match(r.body, /event: argv/)
  assert.match(r.body, /"argv":\["node","download_demo\.js"\]/)
  assert.match(r.body, /cwd=/)
  assert.match(r.body, /done/)
  assert.match(r.body, /"ok":true/)
  // cwd 必须是引擎目录。SSE 的 data 是 JSON，反斜杠在原文里被转义过，
  //   要先把事件解析回来再比，否则 Windows 路径永远匹配不上。
  const lines = r.body.split(/\r?\n/)
    .filter((s) => s.startsWith('data: '))
    .map((s) => { try { return JSON.parse(s.slice(6)) } catch (e) { return null } })
    .filter(Boolean)
  const cwdLine = lines.map((e) => e.text || '').find((s) => s.startsWith('cwd=')) || ''
  const norm = (s) => s.replace(/\\/g, '/').toLowerCase()
  assert.strictEqual(norm(cwdLine), norm(`cwd=${dir}`), '脚本要在引擎目录里跑')
  assert.ok(lines.some((e) => e.text === 'done'), '第二行输出也要透传')
})
