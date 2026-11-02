'use strict'

//  scan.json 无法读取时，接口的 400 要带上可直接照改的报错原文。
//
//  覆盖两条链路：
//  · POST /api/assets/:id/scan ⇒ 400 + 原样消息 + engine_id + key（不是通用 500）
//  · GET /api/assets/voices-with-models ⇒ 声明无法读取的角色仍然被报出来，带一句 note
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

// 扫盘按引擎收进来的那条 note：真实形状由 scan.node.test.js 钉，这里只造它。
// meta 里这一条的判据是 reason（三种取值之一），没有机器错误码：
// 写坏的那条由路由换成响应里的 code。
function scanNote (engineId, reason, extra) {
  return { engine_id: engineId, reason, text: `引擎 ${engineId} 的 scan.json 读不出扫描约定`, ...extra }
}

const BAD = 'some-engine'
const brokenEntry = scanNote(BAD, 'invalid_scan_file', {
  file: 'engines/some-engine/scan.json',
  key: 'version.from_size[1].below_bytes',
  text: '引擎 some-engine 的 engines/some-engine/scan.json 里 version.from_size[1].below_bytes 必须是正整数（字节）。',
})

// 一份「GSV 的模型扫出来正常、另一个引擎的声明写坏」的 meta：路由照常返回模型，note 只指出出错的那个。
const mixedMeta = {
  id: VOICE_ID,
  display_name: 'Voice One',
  assets: {
    models: { 'some-engine': { weights: [] }, 'good-engine': { weights: [{ name: 'a.bin', path: '/nope' }] } },
    scan_convention_notes: [brokenEntry],
  },
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

test('⭐ scan.json 无法读取 ⇒ 400，消息原样返回，并指明是哪个引擎的哪个键', async () => {
  const h = handlerFor(registerCrud, {
    ...baseCtx,
    assetScanner: {
      scanVoiceDir: () => ({ id: VOICE_ID, assets: { models: {}, scan_convention_notes: [brokenEntry] } }),
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

// 登记在前、400 在后：一个还没登记过的新角色，不能因为另一台引擎的 scan.json 写坏就进不了 voices.json。
// 资产页按目录列角色、生成页按 voices.json 列角色，跳过登记就是「看得见却选不到」，而全量扫描会登记它。
test('⛔ 引擎的 scan.json 写坏时，这次单扫仍然把角色登记进 voices.json', async () => {
  let saved = null
  const h = handlerFor(registerCrud, {
    ...baseCtx,
    loadVoices: () => ({}),
    saveVoices: (v) => { saved = v },
    assetScanner: {
      scanVoiceDir: () => ({ id: VOICE_ID, assets: { models: {}, scan_convention_notes: [brokenEntry] } }),
      generateSegments: () => ({ matched: 0 }),
    },
  }, 'post', '/api/assets/:id/scan')
  const res = fakeRes()
  await h({ params: { id: VOICE_ID }, body: {} }, res)
  assert.equal(res.statusCode, 400, '写坏的声明照样要说得出口')
  assert.ok(saved && saved[VOICE_ID], '400 之前先登记，跳过它这个角色在生成页就选不到')
})

test('⭐ 引擎未安装、未写 scan.json 不是这次扫描的错误 ⇒ 照常 200', async () => {
  const h = handlerFor(registerCrud, {
    ...baseCtx,
    assetScanner: {
      scanVoiceDir: () => ({
        id: VOICE_ID,
        assets: { models: {}, scan_convention_notes: [scanNote('third-party', 'no_scan_file')] },
      }),
      generateSegments: () => ({ matched: 0 }),
    },
  }, 'post', '/api/assets/:id/scan')
  const res = fakeRes()
  await h({ params: { id: VOICE_ID }, body: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
})

test('⭐ 其他扫描错误不变：500 加通用提示，细节只进日志', async () => {
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

test('⭐ 无法读取的声明按引擎返回 note，同一角色的其他候选一个不少', () => {
  const metaVoice = path.join(tmp, 'mixedvoice')
  fs.mkdirSync(metaVoice, { recursive: true })
  fs.writeFileSync(path.join(metaVoice, 'meta.json'), JSON.stringify({
    ...mixedMeta,
    assets: { ...mixedMeta.assets, models: { 'good-engine': { weights: [{ name: 'a.bin', path: '/nope' }] } } },
  }))
  const h = handlerFor(registerModels, {
    ...baseCtx,
    loadVoices: () => ({ mixedvoice: { display_name: 'Mixed' } }),
    assetScanner: { scanVoiceDir: () => { throw new Error('不该现扫') }, generateSegments: () => ({ matched: 0 }) },
  }, 'get', '/api/assets/voices-with-models')
  const res = fakeRes()
  h({ params: {}, body: {}, query: {} }, res)
  const row = res.body.voices.find((v) => v.voiceId === 'mixedvoice')
  assert.ok(row)
  assert.deepEqual(row.engines, ['good-engine'], '一个引擎的声明无法读取，其他引擎的候选照常列出')
  const note = row.model_notes.find((n) => n.engine === BAD)
  assert.ok(note, 'note 要挂在出错的引擎下：界面按引擎筛选，挂错位置就等于没说')
  assert.match(note.text, /scan\.json/)
})

test('⭐ 现扫出来的角色也一样：note 从这份新 meta 里建，不是从抛出的错误里建', () => {
  const liveVoice = path.join(tmp, 'livevoice')
  fs.mkdirSync(liveVoice, { recursive: true })
  const h = handlerFor(registerModels, {
    ...baseCtx,
    loadVoices: () => ({ livevoice: { display_name: 'Live' } }),
    assetScanner: {
      scanVoiceDir: () => ({ id: 'livevoice', assets: mixedMeta.assets }),
      generateSegments: () => ({ matched: 0 }),
    },
  }, 'get', '/api/assets/voices-with-models')
  const res = fakeRes()
  h({ params: {}, body: {}, query: {} }, res)
  const row = res.body.voices.find((v) => v.voiceId === 'livevoice')
  assert.deepEqual(Object.keys(row.models), ['some-engine', 'good-engine'])
  assert.deepEqual(row.model_notes.map(n => [n.engine, n.code]), [[BAD, 'invalid_scan_file']])
})

test('⭐ scan.json 没写、引擎没装这两种缺约定也各生成一条 note', () => {
  const gapVoice = path.join(tmp, 'gapvoice')
  fs.mkdirSync(gapVoice, { recursive: true })
  fs.writeFileSync(path.join(gapVoice, 'meta.json'), JSON.stringify({
    id: 'gapvoice',
    assets: {
      models: { 'no-scan-engine': { weights: [{ name: 'a.bin', path: '/nope' }] } },
      scan_convention_notes: [
        scanNote('no-scan-engine', 'no_scan_file'),
        scanNote('ghost-engine', 'engine_not_installed'),
      ],
    },
  }))
  const h = handlerFor(registerModels, {
    ...baseCtx,
    loadVoices: () => ({ gapvoice: { display_name: 'Gap' } }),
    assetScanner: { scanVoiceDir: () => { throw new Error('不该现扫') }, generateSegments: () => ({ matched: 0 }) },
  }, 'get', '/api/assets/voices-with-models')
  const res = fakeRes()
  h({ params: {}, body: {}, query: {} }, res)
  const row = res.body.voices.find((v) => v.voiceId === 'gapvoice')
  assert.deepEqual(row.model_notes.map(n => [n.engine, n.code]),
    [['no-scan-engine', 'no_scan_file'], ['ghost-engine', 'engine_not_installed']])
  assert.ok(row.model_notes.every(n => n.text), '每条 note 都要带可读说明，界面只取 text')
})

// 候选为空但有话要说，是界面上「什么都没有」最常见的一种：这句 note 是这个角色出现在列表里的唯一理由。
test('⭐ 一个候选都没列出来、只有一句 note 的角色，也还在列表里', () => {
  const gapOnly = path.join(tmp, 'noteonly')
  fs.mkdirSync(gapOnly, { recursive: true })
  fs.writeFileSync(path.join(gapOnly, 'meta.json'), JSON.stringify({
    id: 'noteonly',
    assets: {
      models: { 'no-scan-engine': { weights: [] } },
      scan_convention_notes: [scanNote('no-scan-engine', 'no_scan_file')],
    },
  }))
  const h = handlerFor(registerModels, {
    ...baseCtx,
    loadVoices: () => ({ noteonly: { display_name: 'Note Only' } }),
    assetScanner: { scanVoiceDir: () => { throw new Error('不该现扫') }, generateSegments: () => ({ matched: 0 }) },
  }, 'get', '/api/assets/voices-with-models')
  const res = fakeRes()
  h({ params: {}, body: {}, query: {} }, res)
  const row = res.body.voices.find((v) => v.voiceId === 'noteonly')
  assert.ok(row, '候选为空但有话要说的角色不能被整条滤掉')
  assert.deepEqual(row.engines, [])
  assert.deepEqual(row.model_notes.map(n => [n.engine, n.code]), [['no-scan-engine', 'no_scan_file']])
})

test('⭐ 认不出原因的现扫失败不落进 note，但进日志', () => {
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
      scanVoiceDir: () => { scanned += 1; throw new Error('不该现扫') },
      generateSegments: () => ({ matched: 0 }),
    },
  }, 'get', '/api/assets/voices-with-models')
  const res = fakeRes()
  h({ params: {}, body: {}, query: {} }, res)
  const row = res.body.voices.find((v) => v.voiceId === 'metavoice')
  assert.equal(scanned, 0, '已有 meta 就够用，不该拿一份无法读取的声明去重扫')
  assert.equal(row.model_notes, undefined)
})
