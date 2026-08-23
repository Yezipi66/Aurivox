'use strict'

// ===========================================================================
//  底模能存配方（补一个既有的洞）
// ===========================================================================
//
// 洞是什么：底模（__base__）按设计**不在 voices.json 里** —— 它由 baseVoiceReg
// 在内存里解析出来，好让「没有微调资产也能用底模做零样本推理」成立。
// 而 server.js 的 knownVoice() 当年只写了 `hasOwnProperty(loadVoices(), role)`，
// 于是：
//
//     底模零样本**能推理**，却**存不成配方**（POST /api/recipes 直接 400）。
//     存不成配方 = 出不了 broker = 上不了 flow。
//
// 「底模 + 一段参考音频」正是 IndexTTS2 这类引擎的主力用法，这个洞正好卡在
// 「下游作者接一台新引擎」的主线上。
//
// 这里钉两层：
//   1. 真实的 server.js 源码里，knownVoice 确实放行了底模（沙箱能跑）
//   2. 路由层拿到一个放行底模的 knownVoice 后，确实能把配方存下去

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SERVER = path.join(__dirname, '..', '..', 'server.js')

test('⭐ server.js 的 knownVoice 放行底模（洞已补，且不会被无声改回去）', () => {
  const src = fs.readFileSync(SERVER, 'utf8')
  const m = src.match(/function knownVoice\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(m, '没找到 knownVoice —— 它被改名或删了，这颗钉子要跟着改')
  const bodyCode = m[1].split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.match(
    bodyCode, /isBaseVoice\s*\(\s*role\s*\)/,
    'knownVoice 不再放行底模了 —— 底模又会「能推理但存不成配方」',
  )
})

test('底模放行没有顺手放松「配方必须锚在真实资产上」', () => {
  const src = fs.readFileSync(SERVER, 'utf8')
  const m = src.match(/function knownVoice\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/)
  const bodyCode = m[1]
  // voices.json 那道检查必须还在：放行的只有底模这一个内建音色，
  // 不是把所有 role 都放过去。
  assert.match(bodyCode, /loadVoices\(\)/, 'voices.json 校验被顺手删掉了')
})

// --------------------------------------------------------------------------
//  路由层：底模确实存得进去
// --------------------------------------------------------------------------

const Module = require('node:module')
const routes = []
function fakeRouter () {
  const r = {}
  for (const m of ['get', 'post', 'put', 'delete', 'use', 'all']) {
    r[m] = (p, ...h) => { routes.push({ method: m, path: p, handlers: h }); return r }
  }
  return r
}
const fakeExpress = () => fakeRouter()
fakeExpress.Router = fakeRouter
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'express') return 'express'
  return origResolve.call(this, request, ...rest)
}
require.cache.express = { id: 'express', filename: 'express', loaded: true, exports: fakeExpress }

const os = require('node:os')
const createRecipesRouter = require('./recipes')
const { createRecipeStore } = require('../recipeStore')

function post (body, { baseVoiceKnown }) {
  routes.length = 0
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-baserecipes-'))
  createRecipesRouter({
    recipeStore: createRecipeStore(dir),
    requireApiKey: (req, res, next) => next(),
    // server.js 里 knownVoice 的两种形态：补洞前 / 补洞后
    knownVoice: (role) => (role === '__base__' ? baseVoiceKnown : role === 'alice'),
    classifyRecipeManagedFields: () => ({ ok: true }),
    clientError: (e, f) => String((e && e.message) || f),
    pathResolver: { resolveManagedRef: (v) => ({ ok: true, path: String(v || '') }) },
    fs,
    path,
  })
  const r = routes.find((x) => x.method === 'post' && x.path === '/api/recipes')
  assert.ok(r, '没登记 POST /api/recipes')
  const out = {}
  const res = {
    status: (s) => { out.status = s; return res },
    json: (b) => { out.json = b; return res },
  }
  r.handlers[r.handlers.length - 1]({ body }, res, () => {})
  return out
}

const baseBody = {
  role: '__base__', name: 'zeroshot',
  reference_audio: 'custom/ref.wav', reference_text: '参考文本',
  engine_id: 'indextts2', engine_params: { indextts2: { emo_alpha: 0.8 } },
}

test('⭐ 底模能存配方（201），且 engine_id / engine_params 一路透传到磁盘', () => {
  const out = post(baseBody, { baseVoiceKnown: true })
  assert.equal(out.status, 201, `底模存配方失败：${JSON.stringify(out.json)}`)
  assert.equal(out.json.recipe.engine_id, 'indextts2')
  assert.deepEqual(out.json.recipe.engine_params.indextts2, { emo_alpha: 0.8 })
  assert.equal(out.json.recipe.schema_version, 4)
})

test('洞没补时是什么样（400 unknown voice）—— 这条记录病症本身', () => {
  const out = post(baseBody, { baseVoiceKnown: false })
  assert.equal(out.status, 400)
  assert.match(String(out.json.error), /unknown voice/)
})

test('放行底模没有放行拼错的 role', () => {
  const out = post(Object.assign({}, baseBody, { role: '__bse__' }), { baseVoiceKnown: true })
  assert.equal(out.status, 400, '拼错的 role 被放行了 —— 会产生孤儿配方')
})
