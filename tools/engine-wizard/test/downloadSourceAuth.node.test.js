'use strict'
// 第 3 步的下载来源与 HF 授权。
//
// 守四件事：
//   ① 来源一致：同一条命令，显示的命令、列清单用的 tool、下载请求里的 tool 是同一个来源。
//   ② 请求本身缺东西时当场拒绝：repo 为空回 400，来源认不出回 400，不拼一个 HF 地址碰运气。
//   ③ HF 回 401 / 403 时报 GATED，并按「没配令牌 / 令牌被拒 / 未接受许可协议」分开说。
//   ④ 令牌：清单与文件请求都带 Authorization，重定向到别的站点时不带；
//      令牌不出现在任何响应、SSE 事件、日志与本机其它文件里，令牌文件权限 600。
//
// 两个来源的站点根换成本地假服务器（download.js 的 ENDPOINTS），不碰真网络。
// 写根指到临时目录（WIZARD_PROJECT_ROOT），令牌不会落进本仓库。

const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { pathToFileURL } = require('node:url')

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-dl-auth-')))
fs.writeFileSync(path.join(ROOT, 'server.js'), '')
process.env.WIZARD_PROJECT_ROOT = ROOT

const download = require('../core/download')
const wb = require('../core/wizardbridge')
const hfToken = require('../core/hfToken')

const GOOD = 'hf_GoodTokenForTests0123456789'
const NOT_ACCEPTED = 'hf_ValidButLicenseNotAccepted42'
const ID = 'demo-engine'

async function loadEsm (name) {
  return await import(pathToFileURL(path.join(__dirname, '..', 'editor', name)).href)
}

function listen (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

// 假的 HF / 魔搭 / CDN。seen 记下每个请求带的 Authorization，用来判令牌发给了谁。
const seen = { hf: [], ms: [], cdn: [] }
let hf, ms, cdn, bridge
const PAYLOAD = '{"ok":1}'

function fileList (names) {
  return { siblings: names.map((n) => ({ rfilename: n, size: PAYLOAD.length })) }
}

before(async () => {
  cdn = await listen((req, res) => {
    seen.cdn.push({ url: req.url, auth: req.headers.authorization || null })
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(PAYLOAD.length) })
    res.end(PAYLOAD)
  })
  hf = await listen((req, res) => {
    const auth = req.headers.authorization || null
    seen.hf.push({ url: req.url, auth })
    const u = new URL(req.url, 'http://x')
    // 清单：org/private 不带令牌列不出来；其余公开
    if (u.pathname.startsWith('/api/models/')) {
      const repo = u.pathname.slice('/api/models/'.length)
      if (repo === 'org/private' && auth !== `Bearer ${GOOD}`) { res.writeHead(401); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(fileList(['config.json'])))
      return
    }
    // 文件：org/gated 要令牌；有效令牌 302 到 CDN（另一个源）
    const m = u.pathname.match(/^\/(.+?)\/resolve\/([^/]+)\/(.+)$/)
    if (!m) { res.writeHead(404); res.end(); return }
    const [, repo] = m
    if (repo === 'org/gated') {
      if (!auth) { res.writeHead(401); res.end(); return }
      if (auth === `Bearer ${NOT_ACCEPTED}`) { res.writeHead(403); res.end(); return }
      if (auth !== `Bearer ${GOOD}`) { res.writeHead(401); res.end(); return }
      res.writeHead(302, { location: `${cdn.base}/signed/${m[3]}?sig=abc` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(PAYLOAD.length) })
    res.end(PAYLOAD)
  })
  ms = await listen((req, res) => {
    seen.ms.push({ url: req.url, auth: req.headers.authorization || null })
    if (req.url.startsWith('/api/v1/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Data: { Files: [{ Name: 'configuration.json', Type: 'blob', Size: PAYLOAD.length }] } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(PAYLOAD.length) })
    res.end(PAYLOAD)
  })
  download.ENDPOINTS.hf = hf.base
  download.ENDPOINTS.modelscope = ms.base
  const H = [wb.handleHfToken, wb.handleDownloadFile, wb.handleDownloadManifest]
  bridge = await listen((req, res) => {
    for (const h of H) if (h(req, res) === true) return
    res.writeHead(404); res.end()
  })
})

after(() => {
  for (const s of [hf, ms, cdn, bridge]) if (s) s.server.close()
  fs.rmSync(ROOT, { recursive: true, force: true })
})

// 抓日志：console 的四个出口全记下来，测完还原。
function captureConsole () {
  const lines = []
  const orig = {}
  for (const k of ['log', 'info', 'warn', 'error']) {
    orig[k] = console[k]
    console[k] = (...a) => { lines.push(a.map(String).join(' ')) }
  }
  return { lines, restore () { Object.assign(console, orig) } }
}

async function postFile (body) {
  const r = await fetch(`${bridge.base}/wizard/download/file`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await r.text()
  let done = null
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    const ev = JSON.parse(line.slice(6))
    if ('ok' in ev) done = ev
  }
  return { status: r.status, text, done, json: r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null }
}

async function tokenCall (method, body) {
  const r = await fetch(`${bridge.base}/wizard/hf-token`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  return { status: r.status, text, j: JSON.parse(text) }
}

function engineFile (name) {
  return path.join(ROOT, 'engines', ID, 'checkpoints', name)
}

// ---------------------------------------------------------------------------
// ① 来源一致
// ---------------------------------------------------------------------------

test('来源一致：显示的命令、清单的 tool、下载请求的 tool 是同一个来源', async () => {
  const { buildCommand, sourceOf, choiceKey } = await loadEsm('downloadSource.js')
  const { downloadFiles } = await loadEsm('downloadRunner.js')
  const fence = (body) => '```python\n' + body + '\n```\n'
  const md = [
    'hf download org/cli-hf --local-dir=x',
    'modelscope download --model org/cli-ms --local_dir x',
    fence("from modelscope import snapshot_download\nsnapshot_download('org/snap-ms')"),
    fence("from huggingface_hub import snapshot_download\nsnapshot_download('org/snap-hf')"),
    fence("snapshot_download('org/snap-unknown')"),
  ].join('\n')
  const cmds = wb.extractDownloadCommands(md)
  assert.strictEqual(cmds.length, 5)
  const unknown = cmds.find((c) => c.repo === 'org/snap-unknown')
  assert.strictEqual(sourceOf(unknown), 'unknown', '判不出的不许默认成任何一边')
  // 使用者手选之后，三处同样跟着这个选择走
  const choices = { [choiceKey(unknown)]: 'modelscope' }
  const expect = {
    'org/cli-hf': 'hf', 'org/cli-ms': 'modelscope', 'org/snap-ms': 'modelscope',
    'org/snap-hf': 'hf', 'org/snap-unknown': 'modelscope',
  }

  const realFetch = global.fetch
  const bodies = []
  try {
    for (const c of cmds) {
      const source = sourceOf(c, choices)
      assert.strictEqual(source, expect[c.repo], c.repo)
      // 显示的命令
      const { display, source: shown } = buildCommand(c, choices)
      assert.strictEqual(shown, source)
      if (source === 'modelscope') assert.match(display, /modelscope/, display)
      else assert.match(display, /\bhf download\b|huggingface_hub/, display)
      if (c.tool === 'snapshot') {
        assert.doesNotMatch(display, source === 'modelscope' ? /huggingface_hub/ : /from modelscope/, display)
      }
      // 列清单：前端用 sourceOf 的结果当 tool，后端逐行写回同一个 tool
      const r = await realFetch(`${bridge.base}/wizard/download/manifest?id=${ID}&repo=${encodeURIComponent(c.repo)}`
        + `&tool=${source}&root=${encodeURIComponent(ROOT)}`)
      const j = await r.json()
      assert.strictEqual(j.ok, true, JSON.stringify(j))
      for (const f of j.files) assert.strictEqual(f.tool, source, `${c.repo} 清单行的 tool`)
      // 下载：前端把清单行原样交给执行器，请求体里的 tool 与清单一致
      global.fetch = async (url, init) => {
        bodies.push({ repo: c.repo, body: JSON.parse(init.body) })
        return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }
      }
      const rows = j.files.map((f) => ({ ...f, repo: c.repo, tool: source }))
      await downloadFiles({ id: ID, root: ROOT, files: rows, concurrency: 1 })
      global.fetch = realFetch
    }
  } finally {
    global.fetch = realFetch
  }
  assert.strictEqual(bodies.length, 5)
  for (const { repo, body } of bodies) {
    assert.strictEqual(body.repo, repo)
    assert.strictEqual(body.file.tool, expect[repo], `${repo} 下载请求的 tool`)
  }
})

test('来源一致：界面里显示、列清单、回写只走 sourceOf 一处判据', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'editor', 'StepsExtra.jsx'), 'utf8')
  assert.match(src, /import\s*\{[^}]*\bsourceOf\b[^}]*\bbuildCommand\b[^}]*\}\s*from\s*'\.\/downloadSource'/)
  assert.doesNotMatch(src, /const buildCommand\s*=/, '界面里不许再有自己的 buildCommand')
  assert.doesNotMatch(src, /c\.tool === 'modelscope' \? 'modelscope' : 'hf'/, '列清单不许另写一套判据')
  assert.match(src, /const tool = sourceOf\(c, sourceChoices\)/)
  assert.match(src, /\(\{ \.\.\.f, repo: c\.repo, tool \}\)/, '清单逐行回写的是判定后的来源')
  assert.doesNotMatch(src, /tool: f\.tool \|\| 'hf'/, '缺来源的行不许默认成 HF')
})

test('清单端点：来源缺失或认不出 ⇒ 400 UNKNOWN_SOURCE，不默认成 HF', async () => {
  for (const q of ['', '&tool=snapshot', '&tool=unknown']) {
    const r = await fetch(`${bridge.base}/wizard/download/manifest?id=${ID}&repo=org%2Fx${q}`)
    assert.strictEqual(r.status, 400, q)
    const j = await r.json()
    assert.strictEqual(j.code, 'UNKNOWN_SOURCE', q)
  }
})

// ---------------------------------------------------------------------------
// ② 请求本身缺东西
// ---------------------------------------------------------------------------

test('下载端点：repo 为空 ⇒ 400 MISSING_REPO，不开流、不发远端请求', async () => {
  const before = seen.hf.length
  for (const repo of [undefined, '', '   ']) {
    const r = await postFile({ id: ID, root: ROOT, repo, file: { name: 'config.json', size: 8, tool: 'hf' } })
    assert.strictEqual(r.status, 400, `repo=${JSON.stringify(repo)}`)
    assert.strictEqual(r.json.code, 'MISSING_REPO')
  }
  assert.strictEqual(seen.hf.length, before, '不该有任何请求打到远端')
})

test('下载端点：来源认不出 ⇒ 400 UNKNOWN_SOURCE', async () => {
  for (const tool of [undefined, 'snapshot', 'unknown']) {
    const r = await postFile({ id: ID, root: ROOT, repo: 'org/x', file: { name: 'config.json', size: 8, tool } })
    assert.strictEqual(r.status, 400, `tool=${tool}`)
    assert.strictEqual(r.json.code, 'UNKNOWN_SOURCE')
  }
})

test('下载端点：魔搭来源的小文件走魔搭的 resolve 地址并落盘', async () => {
  const r = await postFile({ id: ID, root: ROOT, repo: 'org/ms',
    file: { name: 'configuration.json', size: PAYLOAD.length, tool: 'modelscope' } })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.done.ok, true, JSON.stringify(r.done))
  assert.ok(seen.ms.some((x) => x.url === '/models/org/ms/resolve/master/configuration.json'))
  assert.strictEqual(fs.readFileSync(engineFile('configuration.json'), 'utf8'), PAYLOAD)
})

// ---------------------------------------------------------------------------
// ③ HF 授权错误 ⇒ GATED
// ---------------------------------------------------------------------------

test('HF 回 401、本机没配令牌 ⇒ GATED / NO_TOKEN，带仓库页地址', async () => {
  hfToken.clearToken()
  const r = await postFile({ id: ID, root: ROOT, repo: 'org/gated',
    file: { name: 'meta.yaml', size: PAYLOAD.length, tool: 'hf' } })
  assert.strictEqual(r.done.ok, false)
  assert.strictEqual(r.done.code, 'GATED')
  assert.strictEqual(r.done.status, 401)
  assert.strictEqual(r.done.reason, 'NO_TOKEN')
  assert.strictEqual(r.done.tokenConfigured, false)
  assert.strictEqual(r.done.repoPage, `${hf.base}/org/gated`)
  assert.match(r.done.errorZh, /令牌/)
  assert.ok(!fs.existsSync(engineFile('meta.yaml')), '授权失败不许落盘')
})

test('令牌有效但仍 403 ⇒ GATED / LICENSE_NOT_ACCEPTED：许可协议文案 + 仓库页 + 魔搭提示', async () => {
  const { LICENSE_GATE_NOTE } = require('../core/models')
  assert.strictEqual(hfToken.writeToken(NOT_ACCEPTED).ok, true)
  try {
    const r = await postFile({ id: ID, root: ROOT, repo: 'org/gated',
      file: { name: 'meta.yaml', size: PAYLOAD.length, tool: 'hf' } })
    assert.strictEqual(r.done.code, 'GATED')
    assert.strictEqual(r.done.status, 403)
    assert.strictEqual(r.done.reason, 'LICENSE_NOT_ACCEPTED')
    assert.strictEqual(r.done.tokenConfigured, true)
    assert.ok(r.done.errorZh.includes(LICENSE_GATE_NOTE.zh), '要接上 models.js 的许可门槛文案')
    assert.ok(r.done.errorZh.includes(`${hf.base}/org/gated`), '要给出仓库页地址')
    assert.match(r.done.errorZh, /魔搭/, '要提示可以改用魔搭')
    assert.ok(!r.text.includes(NOT_ACCEPTED), '令牌不许出现在 SSE 里')
  } finally { hfToken.clearToken() }
})

test('配了令牌但 HF 回 401 ⇒ GATED / TOKEN_REJECTED（让使用者更换）', async () => {
  assert.strictEqual(hfToken.writeToken('hf_ExpiredOrRevokedToken').ok, true)
  try {
    const r = await postFile({ id: ID, root: ROOT, repo: 'org/gated',
      file: { name: 'meta.yaml', size: PAYLOAD.length, tool: 'hf' } })
    assert.strictEqual(r.done.code, 'GATED')
    assert.strictEqual(r.done.reason, 'TOKEN_REJECTED')
  } finally { hfToken.clearToken() }
})

test('清单请求 HF 回 401 ⇒ 清单端点同样报 GATED', async () => {
  hfToken.clearToken()
  const r = await fetch(`${bridge.base}/wizard/download/manifest?id=${ID}&repo=org%2Fprivate&tool=hf&root=${encodeURIComponent(ROOT)}`)
  const j = await r.json()
  assert.strictEqual(j.ok, false)
  assert.strictEqual(j.code, 'GATED')
  assert.strictEqual(j.reason, 'NO_TOKEN')
})

// ---------------------------------------------------------------------------
// ④ 令牌
// ---------------------------------------------------------------------------

test('令牌端点：只回「已配置 / 未配置」，令牌本身不出现在响应里', async () => {
  let r = await tokenCall('DELETE')
  assert.deepStrictEqual([r.status, r.j.configured], [200, false])
  r = await tokenCall('GET')
  assert.strictEqual(r.j.configured, false)

  r = await tokenCall('POST', { token: `  ${GOOD}\n` })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.j.configured, true)
  assert.ok(!r.text.includes(GOOD), '保存的响应不许回传令牌')

  r = await tokenCall('GET')
  assert.strictEqual(r.j.configured, true)
  assert.ok(!r.text.includes(GOOD))
  assert.deepStrictEqual(Object.keys(r.j).sort(), ['configured', 'ok'])

  // 坏请求体：新版 Node 的 JSON 报错会带原文，原文里就是令牌，所以报错不许回 err.message
  const bad = await fetch(`${bridge.base}/wizard/hf-token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"token": "${GOOD}"`,
  })
  const badText = await bad.text()
  assert.strictEqual(bad.status, 400)
  assert.ok(!badText.includes(GOOD), badText)

  // 带空白的不像令牌：拒绝，且原因里不带输入
  r = await tokenCall('POST', { token: 'hf_has space' })
  assert.strictEqual(r.status, 400)
  assert.ok(!r.text.includes('has space'))

  r = await tokenCall('DELETE')
  assert.strictEqual(r.j.configured, false)
  assert.strictEqual(hfToken.readToken(), null)
})

test('令牌文件在写根的 state/ 下，权限 600', { skip: process.platform === 'win32' && 'Windows 上 chmod 只控制只读位' }, () => {
  assert.strictEqual(hfToken.writeToken(GOOD).ok, true)
  try {
    const p = hfToken.tokenPath()
    assert.strictEqual(p, path.join(ROOT, 'state', 'hf-token'))
    assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600)
    assert.strictEqual(hfToken.readToken(), GOOD)
  } finally { hfToken.clearToken() }
})

test('令牌带进清单与文件请求；重定向到 CDN 时不带；响应、日志、其它文件里都没有令牌', async () => {
  assert.strictEqual(hfToken.writeToken(GOOD).ok, true)
  const cap = captureConsole()
  const hfBefore = seen.hf.length
  const cdnBefore = seen.cdn.length
  let texts = []
  try {
    const m = await fetch(`${bridge.base}/wizard/download/manifest?id=${ID}&repo=org%2Fprivate&tool=hf&root=${encodeURIComponent(ROOT)}`)
    const mt = await m.text()
    texts.push(mt)
    assert.strictEqual(JSON.parse(mt).ok, true, mt)

    const r = await postFile({ id: ID, root: ROOT, repo: 'org/gated',
      file: { name: 'weights/meta.yaml', size: PAYLOAD.length, tool: 'hf' } })
    texts.push(r.text)
    assert.strictEqual(r.done.ok, true, JSON.stringify(r.done))
    assert.strictEqual(fs.readFileSync(engineFile('weights/meta.yaml'), 'utf8'), PAYLOAD)

    // 魔搭的请求不带 HF 令牌
    const r2 = await postFile({ id: ID, root: ROOT, repo: 'org/ms',
      file: { name: 'configuration.json', size: PAYLOAD.length, tool: 'modelscope' } })
    texts.push(r2.text)
    texts.push((await tokenCall('GET')).text)
  } finally { cap.restore() }

  const hfReqs = seen.hf.slice(hfBefore)
  const manifestReq = hfReqs.find((x) => x.url.startsWith('/api/models/org/private'))
  const fileReq = hfReqs.find((x) => x.url === '/org/gated/resolve/main/weights/meta.yaml')
  assert.strictEqual(manifestReq && manifestReq.auth, `Bearer ${GOOD}`, '清单请求要带令牌')
  assert.strictEqual(fileReq && fileReq.auth, `Bearer ${GOOD}`, '文件请求要带令牌')
  const cdnReqs = seen.cdn.slice(cdnBefore)
  assert.ok(cdnReqs.length >= 1, '应当跟着重定向去了 CDN')
  for (const x of cdnReqs) assert.strictEqual(x.auth, null, '令牌不许跟着重定向发到别的站点')
  for (const x of seen.ms) assert.strictEqual(x.auth, null, 'HF 令牌不许发给魔搭')

  for (const t of texts) assert.ok(!t.includes(GOOD), `响应里出现了令牌：${t.slice(0, 200)}`)
  for (const l of cap.lines) assert.ok(!l.includes(GOOD), `日志里出现了令牌：${l}`)

  // 本机除令牌文件本身之外，任何文件里都不许有令牌（进度记录、下载的文件、名片）
  const leaks = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (full === hfToken.tokenPath()) continue
      if (fs.readFileSync(full, 'utf8').includes(GOOD)) leaks.push(full)
    }
  }
  walk(ROOT)
  hfToken.clearToken()
  assert.deepStrictEqual(leaks, [])
})
