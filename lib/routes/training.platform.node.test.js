'use strict'

//  training 路由：平台行为（start/status/cancel/tasks）
//
//  这个文件覆盖 lib/routes/training.js 的平台行为：
//  · POST /api/train/start 创建训练任务
//  · GET /api/train/status/:id 查询任务状态
//  · POST /api/train/cancel/:id 取消任务
//  · GET /api/train/tasks 列出所有任务
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

const createRouter = require('./training')

//  ctx
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-training-'))
const ASSETS_DIR = tmp
const INPUT_DIR = path.join(tmp, 'input')
fs.mkdirSync(INPUT_DIR, { recursive: true })

function makeCtx (over = {}) {
  const pipelineMock = {
    createPipeline: (opts) => ({
      id: 'task-1',
      start: async () => {},
    }),
    getStatusById: (id) => (id === 'task-1'
      ? { id: 'task-1', status: 'running', voiceId: 'voice1' }
      : null),
    getTask: (id) => (id === 'task-1'
      ? {
          id: 'task-1',
          cancel: () => {},
          getReviewList: () => [],
          getDenoisePreview: () => ({}),
          resolveReviewAudioPath: () => null,
          saveReviewList: () => ({}),
          resume: () => true,
        }
      : null),
    getLogsById: (id) => (id === 'task-1' ? ['log1', 'log2'] : null),
    getAllTasks: () => [{ id: 'task-1', status: 'running' }],
    STAGING_ROOT: path.join(tmp, 'staging'),
  }

  const ctx = {
    ALLOWED_LANGUAGES: new Set(['zh', 'ja', 'en']),
    ASSETS_DIR,
    TRAIN_DATA_ROOT: '',
    assetId: {
      allocateVoiceId: (name) => 'newid',
      reserve: () => {},
      release: () => {},
    },
    checkBaseModelsForVersion: () => ({ blocking: null }),
    clientError: (e, f) => String((e && e.message) || f),
    collectTakenVoiceIds: () => [],
    fs,
    loadVoices: () => ({}),
    path,
    requireApiKey: (req, res, next) => next(),
    safeId: (id) => /^[a-zA-Z0-9_-]+$/.test(id),
    sanitizeCustomParams: (p) => p || {},
    trainingPipeline: pipelineMock,
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

async function call (handler, body, params = {}) {
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
  const req = { body, params, headers: {}, on: () => {}, get: () => undefined }
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

//  POST /api/train/start

test('POST train/start → 400 for missing displayName', async () => {
  const h = findHandler('post', '/train/start')
  await assert.rejects(
    () => call(h, {}),
    (e) => e.status === 400 && /Missing 'displayName'/.test(e.message),
  )
})

test('POST train/start → 400 for missing language', async () => {
  const h = findHandler('post', '/train/start')
  await assert.rejects(
    () => call(h, { displayName: 'Test Voice' }),
    (e) => e.status === 400 && /Missing 'language'/.test(e.message),
  )
})

test('POST train/start → 400 for invalid language', async () => {
  const h = findHandler('post', '/train/start')
  await assert.rejects(
    () => call(h, { displayName: 'Test Voice', language: 'ko', inputDir: INPUT_DIR }),
    (e) => e.status === 400 && /Invalid language/.test(e.message),
  )
})

test('POST train/start → 400 for missing inputDir', async () => {
  const h = findHandler('post', '/train/start')
  await assert.rejects(
    () => call(h, { displayName: 'Test Voice', language: 'zh' }),
    (e) => e.status === 400 && /Missing 'inputDir'/.test(e.message),
  )
})

test('POST train/start → 400 for nonexistent inputDir', async () => {
  const h = findHandler('post', '/train/start')
  await assert.rejects(
    () => call(h, { displayName: 'Test Voice', language: 'zh', inputDir: path.join(tmp, 'nonexistent') }),
    (e) => e.status === 400 && /does not exist/.test(e.message),
  )
})

test('POST train/start → 200 and creates pipeline', async () => {
  const { ctx } = { ctx: makeCtx() }
  routes.length = 0
  createRouter(ctx)
  const r = routes.find((x) => x.method === 'post' && String(x.path).includes('/train/start'))
  const handler = r.handlers[r.handlers.length - 1]

  const out = await call(handler, {
    displayName: 'Test Voice',
    language: 'zh',
    inputDir: INPUT_DIR,
  })
  assert.equal(out.json.ok, true)
  assert.ok(out.json.taskId)
  assert.ok(out.json.voiceId)
})

//  GET /api/train/status/:id

test('GET train/status/:id → 404 for unknown task', async () => {
  const h = findHandler('get', '/train/status')
  await assert.rejects(
    () => call(h, null, { id: 'nonexistent' }),
    (e) => e.status === 404 && /Task not found/.test(e.message),
  )
})

test('GET train/status/:id → 200 for existing task', async () => {
  const h = findHandler('get', '/train/status')
  const out = await call(h, null, { id: 'task-1' })
  assert.equal(out.json.id, 'task-1')
  assert.equal(out.json.status, 'running')
})

//  POST /api/train/cancel/:id

test('POST train/cancel/:id → 404 for unknown task', async () => {
  const h = findHandler('post', '/train/cancel')
  await assert.rejects(
    () => call(h, null, { id: 'nonexistent' }),
    (e) => e.status === 404 && /Task not found/.test(e.message),
  )
})

test('POST train/cancel/:id → 200 for existing task', async () => {
  const h = findHandler('post', '/train/cancel')
  const out = await call(h, null, { id: 'task-1' })
  assert.equal(out.json.ok, true)
})

//  GET /api/train/tasks

test('GET train/tasks → returns task list', async () => {
  const h = findHandler('get', '/train/tasks')
  const out = await call(h)
  assert.ok(out.json.tasks)
  assert.ok(Array.isArray(out.json.tasks))
  assert.ok(out.json.tasks.length > 0)
})

//  GET /api/train/logs/:id

test('GET train/logs/:id → 404 for unknown task', async () => {
  const h = findHandler('get', '/train/logs')
  await assert.rejects(
    () => call(h, null, { id: 'nonexistent' }),
    (e) => e.status === 404 && /Task not found/.test(e.message),
  )
})

test('GET train/logs/:id → 200 for existing task', async () => {
  const h = findHandler('get', '/train/logs')
  const out = await call(h, null, { id: 'task-1' })
  assert.ok(Array.isArray(out.json.logs))
  assert.ok(out.json.logs.length > 0)
})
