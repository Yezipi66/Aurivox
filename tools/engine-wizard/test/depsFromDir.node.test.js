'use strict'
// /wizard/deps 的「选已有引擎」路径：给 id 且 engines/<id>/ 在，就从本地目录读
// 依赖清单，不再依赖 url 远程探测。
//
// 为什么守这条：逃生口只设 id、不设 repoUrl，第 2 步却键 url。
//   于是选一台已有引擎时 deps 计划算不出来，界面落在「仓库尚未就绪」。
//   改成目录在时从目录读，选已有引擎就能出计划。
//
// 夹具只用抽象 id（fixture-eng），不写具体引擎名；根目录用 WIZARD_PROJECT_ROOT
// 指到临时目录，engineDirForRead 会先在那里找 engines/<id>。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const { handleDeps } = require('../core/wizardbridge.js')

function startServer () {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { handleDeps(req, res) })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function post (port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/wizard/deps', method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let s = ''
      res.on('data', (d) => (s += d))
      res.on('end', () => { try { resolve(JSON.parse(s)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

/** 临时根 + engines/<id>/pyproject.toml（带依赖）。 */
function makeFixtureRoot (id) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-depsdir-'))
  const dir = path.join(root, 'engines', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pyproject.toml'),
    '[project]\nname = "' + id + '"\nversion = "1.0.0"\n'
    + 'dependencies = [\n  "numpy>=1.20",\n  "torch>=2.0",\n]\n')
  return root
}

test('给 id 且目录在 ⇒ 从本地目录读 deps，不依赖 url', async () => {
  const root = makeFixtureRoot('fixture-eng')
  const prev = process.env.WIZARD_PROJECT_ROOT
  process.env.WIZARD_PROJECT_ROOT = root
  const { server, port } = await startServer()
  try {
    const j = await post(port, { id: 'fixture-eng' })
    assert.strictEqual(j.ok, true, JSON.stringify(j))
    assert.strictEqual(j.dep_source, 'pyproject.toml', '应从 pyproject 读出依赖')
    assert.ok(j.deps && j.deps.total >= 1, '应读出依赖：' + JSON.stringify(j))
  } finally {
    server.close()
    if (prev === undefined) delete process.env.WIZARD_PROJECT_ROOT
    else process.env.WIZARD_PROJECT_ROOT = prev
  }
})

test('id 在但目录不在且无 url ⇒ 400（不假装算得出）', async () => {
  const root = makeFixtureRoot('fixture-eng')
  const prev = process.env.WIZARD_PROJECT_ROOT
  process.env.WIZARD_PROJECT_ROOT = root
  const { server, port } = await startServer()
  try {
    const j = await post(port, { id: 'no-such-engine' })
    assert.strictEqual(j.ok, false, JSON.stringify(j))
  } finally {
    server.close()
    if (prev === undefined) delete process.env.WIZARD_PROJECT_ROOT
    else process.env.WIZARD_PROJECT_ROOT = prev
  }
})
