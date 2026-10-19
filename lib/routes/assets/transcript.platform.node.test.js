'use strict'

// ===========================================================================
//  transcript 路由：平台行为（读取、编辑、ASR 作业管理）
// ===========================================================================
//
//  这个文件覆盖 lib/routes/assets/transcript.js 的平台行为：
//  · GET /api/assets/:id/transcript 读取转写列表
//  · POST /api/assets/:id/transcript 编辑并保存
//  · POST /api/assets/:id/transcribe 启动 ASR 作业
//  · GET /api/assets/:id/transcribe-status 查询作业状态
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

const register = require('./transcript')

// ---------------------------------------------------------------------------
//  盘上的料
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-transcript-'))
const VOICE_ID = 'voice1'
const voiceDir = path.join(tmp, VOICE_ID)
fs.mkdirSync(path.join(voiceDir, 'asr_opt'), { recursive: true })
fs.writeFileSync(path.join(voiceDir, 'meta.json'), JSON.stringify({ language: 'zh' }))
fs.writeFileSync(path.join(voiceDir, 'asr_opt', 'slicer_opt.list'),
  'audio/slicer_opt/spk1.wav|spk1|zh|你好\naudio/slicer_opt/spk2.wav|spk1|zh|世界\n')
fs.mkdirSync(path.join(voiceDir, 'slicer_opt'), { recursive: true })
fs.writeFileSync(path.join(voiceDir, 'slicer_opt', 'spk1.wav'), Buffer.alloc(64))
fs.writeFileSync(path.join(voiceDir, 'slicer_opt', 'spk2.wav'), Buffer.alloc(64))

const TRANSCRIPT_KINDS = [
  { kind: 'slicer_opt', listName: 'slicer_opt.list', audioSub: 'slicer_opt' },
  { kind: 'raw', listName: 'raw_opt.list', audioSub: 'raw' },
]

function makeCtx (over = {}) {
  const written = { files: {} }
  const ctx = {
    ASSETS_DIR: tmp,
    TRANSCRIPT_KINDS,
    assetScanner: {
      generateSegments: () => {},
      scanVoiceDir: () => ({}),
    },
    clientError: (e, f) => String((e && e.message) || f),
    fs,
    loadTrainingConfig: () => ({}),
    loadVoices: () => ({}),
    path,
    readTranscriptListRows: () => [
      { audio_path: 'audio/slicer_opt/spk1.wav', audio_filename: 'spk1.wav', speaker: 'spk1', lang: 'zh', text: '你好' },
      { audio_path: 'audio/slicer_opt/spk2.wav', audio_filename: 'spk2.wav', speaker: 'spk1', lang: 'zh', text: '世界' },
    ],
    requireApiKey: (req, res, next) => next(),
    runAsr: async () => {},
    safeId: (id) => /^[a-zA-Z0-9_-]+$/.test(id),
    transcribeJobs: new Map(),
    _written: written,
  }
  return { ctx: Object.assign(ctx, over), written }
}

function findHandler (method, pathPattern) {
  routes.length = 0
  const router = fakeRouter()
  const { ctx } = makeCtx()
  register(router, ctx)
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

// ---------------------------------------------------------------------------
//  GET /api/assets/:id/transcript
// ---------------------------------------------------------------------------

test('GET transcript → 404 for unknown voice', async () => {
  const h = findHandler('get', '/transcript')
  await assert.rejects(
    () => call(h, null, { id: 'nonexistent' }),
    (e) => e.status === 404 && /not found/i.test(e.message),
  )
})

test('GET transcript → returns buckets with rows and language from meta', async () => {
  const h = findHandler('get', '/transcript')
  const out = await call(h, null, { id: VOICE_ID })
  assert.ok(out.json)
  assert.equal(out.json.ok, true)
  assert.ok(Array.isArray(out.json.buckets))
  assert.ok(out.json.buckets.length > 0)
  const bucket = out.json.buckets[0]
  assert.equal(bucket.kind, 'slicer_opt')
  assert.ok(Array.isArray(bucket.rows))
  assert.ok(bucket.rows.length > 0)
  assert.equal(out.json.language, 'zh')
})

test('GET transcript → invalid id → 400', async () => {
  const h = findHandler('get', '/transcript')
  await assert.rejects(
    () => call(h, null, { id: 'bad/id' }),
    (e) => e.status === 400 && /Invalid id/.test(e.message),
  )
})

// ---------------------------------------------------------------------------
//  POST /api/assets/:id/transcript
// ---------------------------------------------------------------------------

test('POST transcript → 400 for invalid kind', async () => {
  const h = findHandler('post', '/transcript')
  await assert.rejects(
    () => call(h, { kind: 'bad_kind', rows: [] }, { id: VOICE_ID }),
    (e) => e.status === 400 && /Invalid transcript kind/.test(e.message),
  )
})

test('POST transcript → 400 for non-array rows', async () => {
  const h = findHandler('post', '/transcript')
  await assert.rejects(
    () => call(h, { rows: 'not-an-array' }, { id: VOICE_ID }),
    (e) => e.status === 400 && /rows must be an array/.test(e.message),
  )
})

test('POST transcript → 404 when list file missing', async () => {
  const h = findHandler('post', '/transcript')
  // 创建一个没有 asr_opt/slicer_opt.list 的声音目录
  const emptyVoice = 'emptyvoice'
  fs.mkdirSync(path.join(tmp, emptyVoice), { recursive: true })
  await assert.rejects(
    () => call(h, { rows: [] }, { id: emptyVoice }),
    (e) => e.status === 404 && /No slicer_opt\.list/.test(e.message),
  )
})

test('POST transcript → 200 and merges edited text', async () => {
  const { ctx } = makeCtx()
  routes.length = 0
  const router = fakeRouter()
  register(router, ctx)
  const r = routes.find((x) => x.method === 'post' && String(x.path).includes('/transcript'))
  const handler = r.handlers[r.handlers.length - 1]

  const out = await call(handler, {
    kind: 'slicer_opt',
    rows: [{ audio_filename: 'spk1.wav', text: '编辑后的文本' }],
  }, { id: VOICE_ID })

  assert.equal(out.json.ok, true)
  assert.ok(out.json.changed > 0)
  // 验证列表文件被写入了新内容
  const listContent = fs.readFileSync(path.join(voiceDir, 'asr_opt', 'slicer_opt.list'), 'utf-8')
  assert.match(listContent, /编辑后的文本/)
})

// ---------------------------------------------------------------------------
//  POST /api/assets/:id/transcribe
// ---------------------------------------------------------------------------

test('POST transcribe → 409 when job already running', async () => {
  const { ctx } = makeCtx()
  // 预置一个 running 状态的作业
  ctx.transcribeJobs.set(VOICE_ID, {
    status: 'running', startedAt: Date.now(), finishedAt: null,
    sources: ['raw'], done: [], error: null, logs: [],
    _child: null, _cancelled: false,
  })
  routes.length = 0
  const router = fakeRouter()
  register(router, ctx)
  const r = routes.find((x) => x.method === 'post' && String(x.path).includes('/transcribe'))
  const handler = r.handlers[r.handlers.length - 1]

  await assert.rejects(
    () => call(handler, { source: 'raw' }, { id: VOICE_ID }),
    (e) => e.status === 409 && /already running/.test(e.message),
  )
})

test('POST transcribe → 400 when no audio to transcribe', async () => {
  const h = findHandler('post', '/transcribe')
  // raw 目录不存在 ⇒ 没有可转写的音频
  await assert.rejects(
    () => call(h, { source: 'raw' }, { id: VOICE_ID }),
    (e) => e.status === 400 && /No audio to transcribe/.test(e.message),
  )
})

// ---------------------------------------------------------------------------
//  GET /api/assets/:id/transcribe-status
// ---------------------------------------------------------------------------

test('GET transcribe-status → idle for unknown voice', async () => {
  const h = findHandler('get', '/transcribe-status')
  const out = await call(h, null, { id: 'nonexistent' })
  assert.equal(out.json.ok, true)
  assert.equal(out.json.status, 'idle')
})

test('GET transcribe-status → returns job status', async () => {
  const { ctx } = makeCtx()
  ctx.transcribeJobs.set(VOICE_ID, {
    status: 'running', startedAt: Date.now(), finishedAt: null,
    sources: ['raw'], done: [], error: null, logs: [],
    _child: null, _cancelled: false,
  })
  routes.length = 0
  const router = fakeRouter()
  register(router, ctx)
  const r = routes.find((x) => x.method === 'get' && String(x.path).includes('/transcribe-status'))
  const handler = r.handlers[r.handlers.length - 1]
  const out = await call(handler, null, { id: VOICE_ID })
  assert.equal(out.json.ok, true)
  assert.equal(out.json.status, 'running')
})
