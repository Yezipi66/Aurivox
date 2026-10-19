'use strict'

// ===========================================================================
//  refine 路由：平台行为（精调派生、类型验证、checkpoint 解析）
// ===========================================================================
//
//  这个文件覆盖 lib/routes/assets/refine.js 的平台行为：
//  · POST /api/assets/:id/refine 精调派生
//  · refinement_type 解析
//  · 父角色 checkpoint 查找与 warm-start 选择
//  · use_own_data 与 input_dir 校验
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

const register = require('./refine')

// ---------------------------------------------------------------------------
//  盘上的料
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-refine-'))
const PARENT_ID = 'parent1'
const parentDir = path.join(tmp, PARENT_ID)

// 创建父角色目录结构
fs.mkdirSync(path.join(parentDir, 'models', 'gpt-sovits', 'gpt'), { recursive: true })
fs.mkdirSync(path.join(parentDir, 'models', 'gpt-sovits', 'sovits'), { recursive: true })
fs.mkdirSync(path.join(parentDir, 'slicer_opt'), { recursive: true })
fs.mkdirSync(path.join(parentDir, 'asr_opt'), { recursive: true })

// 父角色 meta.json
fs.writeFileSync(path.join(parentDir, 'meta.json'), JSON.stringify({
  display_name: 'Parent Voice',
  language: 'zh',
  base_version: 'v2',
}))

// checkpoints
fs.writeFileSync(path.join(parentDir, 'models', 'gpt-sovits', 'gpt', 'parent1-e8.ckpt'), Buffer.alloc(64))
fs.writeFileSync(path.join(parentDir, 'models', 'gpt-sovits', 'sovits', 'parent1_v2_e8_s96.pth'), Buffer.alloc(64))

// segments.json
fs.writeFileSync(path.join(parentDir, 'segments.json'), JSON.stringify({
  segments: [{ matched: true, audio: 'spk1.wav', text: '你好', lang: 'zh' }],
}))

// ASR .list
fs.writeFileSync(path.join(parentDir, 'asr_opt', 'slicer_opt.list'),
  'audio/slicer_opt/spk1.wav|spk1|zh|你好\n')

// TRAIN_DATA_ROOT
const TRAIN_DATA_ROOT = path.join(tmp, 'train_data')
fs.mkdirSync(TRAIN_DATA_ROOT, { recursive: true })

function makeCtx (over = {}) {
  const created = { pipelines: [], released: [] }
  const ctx = {
    ASSETS_DIR: tmp,
    TRAIN_DATA_ROOT: '',
    assetId: {
      allocateVoiceId: (name) => 'child1',
      reserve: () => {},
      release: (id) => { created.released.push(id) },
    },
    assetScanner: {
      buildSegmentsFor: () => ({ ok: true, matched: 1 }),
      generateSegments: () => {},
      scanVoiceDir: () => ({}),
    },
    clientError: (e, f) => String((e && e.message) || f),
    collectTakenVoiceIds: () => [],
    crypto: require('node:crypto'),
    fs,
    loadVoices: () => ({}),
    normalizeVersion: (v) => v || 'v2',
    path,
    pickLatestByEpoch: (files, re) => {
      let best = null, bestE = -1
      for (const f of files) {
        const m = f.match(re)
        if (!m) continue
        const e = parseInt(m[1], 10)
        if (e > bestE) { bestE = e; best = f }
      }
      return best ? { file: best, epoch: bestE } : null
    },
    requireApiKey: (req, res, next) => next(),
    safeId: (id) => /^[a-zA-Z0-9_-]+$/.test(id),
    sanitizeCustomParams: (p) => p || {},
    trainingPipeline: {
      createPipeline: (opts) => {
        created.pipelines.push(opts)
        return { id: 'task-child-1', start: async () => {} }
      },
    },
    versionFromName: (name) => {
      const m = name.match(/_v(\d+)(Pro|Plus)?/)
      if (!m) return null
      let v = 'v' + m[1]
      if (m[2]) v += m[2]
      return v
    },
    withVoicesLock: (fn) => fn(),
  }
  return { ctx: Object.assign(ctx, over), created }
}

function findHandler () {
  routes.length = 0
  const router = fakeRouter()
  const { ctx } = makeCtx()
  register(router, ctx)
  const r = routes.find((x) => x.method === 'post' && String(x.path).includes('/refine'))
  assert.ok(r, '没有登记 POST /refine')
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

// ---------------------------------------------------------------------------
//  参数校验
// ---------------------------------------------------------------------------

test('POST refine → 400 for invalid id', async () => {
  const h = findHandler()
  await assert.rejects(
    () => call(h, {}, { id: 'bad/id' }),
    (e) => e.status === 400 && /Invalid id/.test(e.message),
  )
})

test('POST refine → 404 for unknown parent', async () => {
  const h = findHandler()
  await assert.rejects(
    () => call(h, {}, { id: 'nonexistent' }),
    (e) => e.status === 404 && /not found/i.test(e.message),
  )
})

test('POST refine → 400 for invalid refinement_type', async () => {
  const h = findHandler()
  await assert.rejects(
    () => call(h, { refinement_type: 'xyz' }, { id: PARENT_ID }),
    (e) => e.status === 400 && /at least one model/.test(e.message),
  )
})

test('POST refine → 400 for use_own_data without input_dir', async () => {
  const h = findHandler()
  await assert.rejects(
    () => call(h, { use_own_data: true }, { id: PARENT_ID }),
    (e) => e.status === 400 && /input_dir is required/.test(e.message),
  )
})

test('POST refine → 400 for nonexistent input_dir in own-data mode', async () => {
  const h = findHandler()
  await assert.rejects(
    () => call(h, { use_own_data: true, input_dir: path.join(tmp, 'nonexistent') }, { id: PARENT_ID }),
    (e) => e.status === 400 && /does not exist/.test(e.message),
  )
})

// ---------------------------------------------------------------------------
//  checkpoint 解析
// ---------------------------------------------------------------------------

test('POST refine → 400 when parent has no checkpoints', async () => {
  const { ctx } = makeCtx()
  // 创建没有 checkpoints 的父角色
  const noCkptParent = 'noparent'
  fs.mkdirSync(path.join(tmp, noCkptParent), { recursive: true })
  fs.writeFileSync(path.join(tmp, noCkptParent, 'meta.json'), JSON.stringify({ display_name: 'No CKPT' }))

  routes.length = 0
  const router = fakeRouter()
  register(router, ctx)
  const r = routes.find((x) => x.method === 'post' && String(x.path).includes('/refine'))
  const handler = r.handlers[r.handlers.length - 1]

  await assert.rejects(
    () => call(handler, {}, { id: noCkptParent }),
    (e) => e.status === 400 && /no published S1\/S2 checkpoints/.test(e.message),
  )
})

test('POST refine → 400 for explicit nonexistent base_s1_file', async () => {
  const h = findHandler()
  await assert.rejects(
    () => call(h, { base_s1_file: 'nonexistent.ckpt' }, { id: PARENT_ID }),
    (e) => e.status === 400 && /S1 checkpoint not found/.test(e.message),
  )
})

// ---------------------------------------------------------------------------
//  正常流程
// ---------------------------------------------------------------------------

test('POST refine → 200 and creates pipeline with correct lineage', async () => {
  const { ctx, created } = makeCtx()
  routes.length = 0
  const router = fakeRouter()
  register(router, ctx)
  const r = routes.find((x) => x.method === 'post' && String(x.path).includes('/refine'))
  const handler = r.handlers[r.handlers.length - 1]

  const out = await call(handler, {
    refinement_type: 's2',
    params: { training: { gpt_epochs: 5, sovits_epochs: 10, learning_rate: 0.001 } },
  }, { id: PARENT_ID })

  assert.equal(out.json.ok, true)
  assert.equal(out.json.refinementType, 's2')
  assert.equal(out.json.parentVoiceId, PARENT_ID)
  assert.ok(out.json.voiceId)
  assert.ok(out.json.taskId)

  // 验证 pipeline 被创建
  assert.equal(created.pipelines.length, 1)
  const pipeline = created.pipelines[0]
  assert.ok(pipeline.voiceId)
  assert.ok(pipeline.refinement)
  assert.equal(pipeline.refinement.parent_voice_id, PARENT_ID)
})

test('POST refine → 200 with both s1+s2', async () => {
  const h = findHandler()
  const out = await call(h, { refinement_type: 'both' }, { id: PARENT_ID })
  assert.equal(out.json.ok, true)
  assert.equal(out.json.refinementType, 's1+s2')
  assert.ok(out.json.additionalS1Epochs > 0)
  assert.ok(out.json.additionalS2Epochs > 0)
})

test('POST refine → 200 with use_own_data and valid input_dir', async () => {
  const ownInputDir = path.join(TRAIN_DATA_ROOT, 'own_input')
  fs.mkdirSync(ownInputDir, { recursive: true })

  const h = findHandler()
  const out = await call(h, {
    use_own_data: true,
    input_dir: ownInputDir,
    language: 'ja',
  }, { id: PARENT_ID })
  assert.equal(out.json.ok, true)
  assert.equal(out.json.dataMode, 'own')
})
