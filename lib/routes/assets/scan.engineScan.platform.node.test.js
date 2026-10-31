'use strict'

//  scan.json 写坏了，接口要把人能用得上的那句话说出来。
//
//  覆盖两条链路：
//  · POST /api/assets/:id/scan ⇒ 400 + 原样消息 + engine_id + key（不是通用 500）
//  · GET /api/assets/voices-with-models ⇒ 那条声明坏了的角色仍然被报出来，带一句 note
//
//  打桩手法同 transcript.platform.node.test.js：假 express 只登记 handler，
//  扫盘层从 ctx 注入，被测的是真实路由代码。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const routes = []
function fakeRouter () {
  const r = {}
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'use', 'all']) {
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

const registerCrud = require('./crud')
const registerModels = require('./models')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-scanerr-'))
const VOICE_ID = 'voice1'
const voiceDir = path.join(tmp, VOICE_ID)
fs.mkdirSync(voiceDir, { recursive: true })

function fakeRes () {
  const res = { statusCode: 200, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  res.send = (b) => { res.body = b; return res }
  res.setHeader = () => res
  return res
}

function handlerFor (register, ctx, method, pathPattern) {
  routes.length = 0
  register(fakeRouter(), ctx)
  const r = routes.find((x) => x.method === method && String(x.path).includes(pathPattern))
  assert.ok(r, `没有登记 ${method} ${pathPattern}`)
  return r.handlers[r.handlers.length - 1]
}

function scanErr () {
  const e = new Error('引擎 some-engine 的 engines/some-engine/scan.json 里 version.from_size[1].below_bytes 必须是正整数（字节）。')
  e.code = 'ENGINE_SCAN_INVALID'
  e.engine_id = 'some-engine'
  e.file = 'engines/some-engine/scan.json'
  e.key = 'version.from_size[1].below_bytes'
  return e
}

const baseCtx = {
  ASSETS_DIR: tmp,
  fs,
  path,
  safeId: (id) => /^[a-zA-Z0-9_-]+$/.test(id),
  requireApiKey: (req, res, next) => next(),
  clientError: () => 'Internal server error',
  localError: (err) => String((err && err.message) || err),
  isBaseVoice: () => false,
  baseVoiceMeta: () => ({ id: 'base', display_name: 'base', assets: { models: {} } }),
  loadVoices: () => ({ [VOICE_ID]: { display_name: 'Voice One' } }),
  saveVoices: () => {},
  withVoicesLock: async (fn) => fn(),
  spawn: () => {},
  runFullAssetScan: async () => ({}),
}

//  POST /api/assets/:id/scan

test('⭐ scan.json 坏了 ⇒ 400，消息原样端出来，还点名是哪个引擎的哪个键', async () => {
  const h = handlerFor(registerCrud, {
    ...baseCtx,
    assetScanner: {
      scanVoiceDir: () => { throw scanErr() },
      generateSegments: () => ({ matched: 0 }),
    },
  }, 'post', '/api/assets/:id/scan')
  const res = fakeRes()
  await h({ params: { id: VOICE_ID }, body: {} }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'ENGINE_SCAN_INVALID')
  assert.match(res.body.error, /version\.from_size\[1\]\.below_bytes/, '要能照着改，不能是通用提示')
  assert.equal(res.body.engine_id, 'some-engine')
  assert.equal(res.body.key, 'version.from_size[1].below_bytes')
})

test('⭐ 其它扫描错误照旧：500 加通用提示，细节只进日志', async () => {
  const h = handlerFor(registerCrud, {
    ...baseCtx,
    assetScanner: {
      scanVoiceDir: () => { throw new Error('EACCES: permission denied') },
      generateSegments: () => ({ matched: 0 }),
    },
  }, 'post', '/api/assets/:id/scan')
  const res = fakeRes()
  await h({ params: { id: VOICE_ID }, body: {} }, res)
  assert.equal(res.statusCode, 500)
  assert.equal(res.body.error, 'Internal server error')
  assert.equal(res.body.code, undefined)
})

//  GET /api/assets/voices-with-models

test('⭐ 现扫失败的角色照样被报出来，note 里写着那台引擎的声明坏了', () => {
  const h = handlerFor(registerModels, {
    ...baseCtx,
    assetScanner: {
      scanVoiceDir: () => { throw scanErr() },
      generateSegments: () => ({ matched: 0 }),
    },
  }, 'get', '/api/assets/voices-with-models')
  const res = fakeRes()
  h({ params: {}, body: {}, query: {} }, res)
  const row = res.body.voices.find((v) => v.voiceId === VOICE_ID)
  assert.ok(row, '一份候选都没列出来但有话要说时，这个角色不能被 continue 掉')
  assert.deepEqual(row.engines, [])
  const note = row.model_notes.find((n) => n.code === 'ENGINE_SCAN_INVALID')
  assert.ok(note, 'model_notes 里必须有一条说明为什么这个角色的模型是空的')
  assert.equal(note.engine, 'some-engine', '界面按引擎筛 note，缺 engine 就没人看得见它')
  assert.match(note.text, /scan\.json/)
})

test('⭐ 认不出是哪台引擎的扫描错误不落进 note，但不静默吞掉模型的缺席', () => {
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  try {
    const h = handlerFor(registerModels, {
      ...baseCtx,
      assetScanner: {
        scanVoiceDir: () => { throw new Error('EACCES: permission denied') },
        generateSegments: () => ({ matched: 0 }),
      },
    }, 'get', '/api/assets/voices-with-models')
    const res = fakeRes()
    h({ params: {}, body: {}, query: {} }, res)
    assert.equal(warns.some((w) => w.includes(VOICE_ID) && /permission denied/.test(w)), true,
      '服务端日志里要能看到是哪个角色扫失败了')
    assert.equal(res.body.voices.find((v) => v.voiceId === VOICE_ID), undefined)
  } finally {
    console.warn = origWarn
  }
})

test('meta.json 读得出模型时不现扫，也就不产生任何 note', () => {
  const metaVoice = path.join(tmp, 'metavoice')
  fs.mkdirSync(metaVoice, { recursive: true })
  fs.writeFileSync(path.join(metaVoice, 'meta.json'), JSON.stringify({
    id: 'metavoice',
    assets: { models: { 'some-engine': { weights: [{ name: 'a.bin', path: '/nope' }] } } },
  }))
  let scanned = 0
  const h = handlerFor(registerModels, {
    ...baseCtx,
    loadVoices: () => ({ metavoice: { display_name: 'Meta' } }),
    assetScanner: {
      scanVoiceDir: () => { scanned += 1; throw scanErr() },
      generateSegments: () => ({ matched: 0 }),
    },
  }, 'get', '/api/assets/voices-with-models')
  const res = fakeRes()
  h({ params: {}, body: {}, query: {} }, res)
  const row = res.body.voices.find((v) => v.voiceId === 'metavoice')
  assert.equal(scanned, 0, '已有 meta 就够用了，不该拿一份坏声明去重扫')
  assert.equal(row.model_notes, undefined)
})
