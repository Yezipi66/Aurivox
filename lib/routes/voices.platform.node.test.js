'use strict'

//  voices 路由：平台行为（CRUD、参考音频上传、validate）
//
//  这个文件覆盖 lib/routes/voices.js 的平台行为：
//  · GET /api/voices 列表
//  · POST /api/voices 创建
//  · PUT /api/voices/:id 更新
//  · DELETE /api/voices/:id 删除
//  · GET /api/voices/:id/validate 模型位检查
//
//  不依赖真实 engines/ 目录，全部用 fixture/mock 构造输入。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

// ---- 假 express：只做 handler 登记 ----------------------------------------
const routes = []
function fakeRouter () {
  const r = {}
  for (const m of ['get', 'post', 'put', 'delete', 'use', 'all']) {
    r[m] = (p, ...handlers) => { routes.push({ method: m, path: p, handlers }); return r }
  }
  return r
}
const fakeExpress = () => fakeRouter()
fakeExpress.Router = fakeRouter
fakeExpress.json = () => (req, res, next) => next()
fakeExpress.static = () => (req, res, next) => next()

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'express') return 'express'
  return origResolve.call(this, request, ...rest)
}
require.cache.express = { id: 'express', filename: 'express', loaded: true, exports: fakeExpress }

//  盘上的料
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-voices-'))
// 让 lib/paths 的 dataOrRoot('VOICES_JSON', 'voices.json') 指向临时文件。
// dataOrRoot 在模块加载时执行，所以设完环境变量必须清 require 缓存再重新加载。
const VOICES_DIR = path.join(tmp, 'voices')
fs.mkdirSync(VOICES_DIR, { recursive: true })
const VOICES_JSON = path.join(VOICES_DIR, 'voices.json')

const createRouter = require('./voices')

// 初始 voices.json
fs.writeFileSync(VOICES_JSON, JSON.stringify({
  voice1: { display_name: 'Voice 1', language: 'zh' },
}))

function makeCtx (over = {}) {
  const ctx = {
    ASSETS_DIR: tmp,
    BASE_VOICE_DISPLAY: 'Base',
    BASE_VOICE_ID: '__base__',
    VOICES_DIR,
    _backupVoicesUnlocked: async () => {},
    baseCheckpoints: () => ({ gpt: ['base.ckpt'], sovits: ['base.pth'] }),
    clientError: (e, f) => String((e && e.message) || f),
    fs,
    isBaseVoice: (v) => v === '__base__',
    loadVoices: () => JSON.parse(fs.readFileSync(VOICES_JSON, 'utf-8')),
    path,
    pickBestCkpt: (list) => list && list.length ? { path: list[0] } : null,
    requireApiKey: (req, res, next) => next(),
    resolveRefPath: (p) => p,
    safeId: (id) => /^[a-zA-Z0-9_-]+$/.test(id),
    saveVoices: (data) => fs.writeFileSync(VOICES_JSON, JSON.stringify(data)),
    upload: {
      single: () => (req, res, next) => { req.file = { filename: 'test.wav' }; next() },
      array: () => (req, res, next) => { req.files = [{ filename: 'test.wav' }]; next() },
    },
    withVoicesLock: (fn) => fn(),
  }
  return Object.assign(ctx, over)
}

function findHandler (method, pathPattern) {
  routes.length = 0
  const ctx = makeCtx()
  createRouter(ctx)
  const r = routes.find((x) => x.method === method && String(x.path).includes(pathPattern))
  assert.ok(r, `没有登记 ${method} ${pathPattern}`)
  return r.handlers[r.handlers.length - 1]
}

async function call (handler, body, params = {}, query = {}) {
  let nextErr = null
  const out = {}
  const res = {
    set: () => res, setHeader: () => res, status: (s) => { out.status = s; return res },
    json: (b) => { out.json = b; return res },
    send: (b) => { out.body = b; return res },
    end: (b) => { out.body = b; return res },
    write: () => true, on: () => res, headersSent: false,
    writeHead: () => res, destroy: () => {},
  }
  const req = { body, params, query, headers: {}, on: () => {}, get: () => undefined }
  await Promise.resolve(handler(req, res, (err) => { if (err) nextErr = err }))
  await new Promise((r) => setImmediate(r))
  if (nextErr) throw nextErr
  if (out.status && out.status >= 400) {
    const e = new Error(typeof (out.json && out.json.error) === 'string' ? out.json.error : JSON.stringify(out.json))
    e.status = out.status
    e.body = out.json || {}
    if (out.json && out.json.code) e.code = out.json.code
    throw e
  }
  return out
}

//  GET /api/voices

test('GET /api/voices → returns voice list with builtin Base', async () => {
  const h = findHandler('get', '/api/voices')
  const out = await call(h)
  assert.ok(out.json)
  assert.ok(Array.isArray(out.json.voices))
  // Base voice 在第一位
  assert.equal(out.json.voices[0].id, '__base__')
  assert.equal(out.json.voices[0].builtin, true)
  // 盘上的 voice1 也在列表中
  const ids = out.json.voices.map((v) => v.id)
  assert.ok(ids.includes('voice1'))
})

//  POST /api/voices

test('POST /api/voices → 400 for missing id', async () => {
  const h = findHandler('post', '/api/voices')
  await assert.rejects(
    () => call(h, {}),
    (e) => e.status === 400 && /Missing 'id'/.test(e.message),
  )
})

test('POST /api/voices → 400 for invalid id', async () => {
  const h = findHandler('post', '/api/voices')
  await assert.rejects(
    () => call(h, { id: 'bad/id' }),
    (e) => e.status === 400 && /Invalid id/.test(e.message),
  )
})

test('POST /api/voices → 409 when voice already exists', async () => {
  const h = findHandler('post', '/api/voices')
  await assert.rejects(
    () => call(h, { id: 'voice1' }),
    (e) => e.status === 409 && /already exists/.test(e.message),
  )
})

test('POST /api/voices → 200 and creates voice', async () => {
  const h = findHandler('post', '/api/voices')
  const out = await call(h, { id: 'newvoice', display_name: 'New Voice', language: 'ja' })
  assert.equal(out.json.ok, true)
  assert.equal(out.json.id, 'newvoice')
  assert.ok(out.json.voice)
  assert.equal(out.json.voice.display_name, 'New Voice')
})

//  PUT /api/voices/:id

test('PUT /api/voices/:id → 404 for unknown voice', async () => {
  const h = findHandler('put', '/api/voices/')
  await assert.rejects(
    () => call(h, {}, { id: 'nonexistent' }),
    (e) => e.status === 404 && /not found/i.test(e.message),
  )
})

test('PUT /api/voices/:id → 400 for invalid id', async () => {
  const h = findHandler('put', '/api/voices/')
  await assert.rejects(
    () => call(h, {}, { id: 'bad/id' }),
    (e) => e.status === 400 && /Invalid id/.test(e.message),
  )
})

test('PUT /api/voices/:id → 200 and updates display_name', async () => {
  const h = findHandler('put', '/api/voices/')
  const out = await call(h, { display_name: 'Updated Name' }, { id: 'voice1' })
  assert.equal(out.json.ok, true)
  assert.equal(out.json.voice.display_name, 'Updated Name')
})

//  DELETE /api/voices/:id

test('DELETE /api/voices/:id → 404 for unknown voice', async () => {
  const h = findHandler('delete', '/api/voices/')
  await assert.rejects(
    () => call(h, null, { id: 'nonexistent' }),
    (e) => e.status === 404 && /not found/i.test(e.message),
  )
})

test('DELETE /api/voices/:id → 200 and removes voice', async () => {
  const h = findHandler('delete', '/api/voices/')
  const out = await call(h, null, { id: 'voice1' })
  assert.equal(out.json.ok, true)
  assert.equal(out.json.id, 'voice1')
  // 验证盘上确实删了
  const voices = JSON.parse(fs.readFileSync(VOICES_JSON, 'utf-8'))
  assert.ok(!voices.voice1)
})

//  GET /api/voices/:id/validate

test('GET validate → 404 for unknown voice', async () => {
  const h = findHandler('get', '/validate')
  await assert.rejects(
    () => call(h, null, { id: 'nonexistent' }),
    (e) => e.status === 404 && /not found/i.test(e.message),
  )
})

test('GET validate → returns slots for builtin Base voice', async () => {
  const h = findHandler('get', '/validate')
  const out = await call(h, null, { id: '__base__' })
  assert.equal(out.json.ok, true)
  assert.equal(out.json.voice, '__base__')
  assert.ok(out.json.checks)
  assert.ok(Array.isArray(out.json.checks.slots))
  // Base voice 的 slots 来自 baseCheckpoints，不是空
  assert.ok(out.json.checks.slots.length > 0)
  assert.equal(out.json.checks.reference_audio_exists, false)
})

test('GET validate → 404 for id with slash (no safeId guard on this route)', async () => {
  // validate 路由不检查 safeId，含 / 的 id 只是找不到而已
  const h = findHandler('get', '/validate')
  await assert.rejects(
    () => call(h, null, { id: 'bad/id' }),
    (e) => e.status === 404 && /not found/i.test(e.message),
  )
})
