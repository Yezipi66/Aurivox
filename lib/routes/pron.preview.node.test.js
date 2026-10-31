'use strict'

// POST /api/pron/preview：读音预览必须问当前选中的那台引擎，且只问它声明过的端点。
// 打桩手法同 engines.node.test.js：替换 require 缓存里的 express，不安装依赖；
// profile 与传输层都从 ctx 注入，被测的是真实路由代码。

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

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

const createRouter = require('./pron')

function fakeRes () {
  const res = { statusCode: 200, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  return res
}

const HTTP_PROFILE = (over = {}) => ({
  id: 'demo',
  transport: 'http',
  base_url: 'http://127.0.0.1:9999',
  timeout_ms: 1234,
  pron_preview: { endpoint: '/pron/preview', request: 'json' },
  ...over,
})

async function callPreview (body, ctx) {
  routes.length = 0
  const router = createRouter({
    clientError: (err, fallback) => fallback || 'Internal server error',
    gsvPost: async () => { throw new Error('gsvPost 不该被调用') },
    loadPronLexicon: () => ({}),
    savePronLexicon: () => {},
    loadAdvancedParams: () => ({}),
    saveAdvancedParams: () => ({}),
    requireApiKey: (req, res, next) => next(),
    ...ctx,
  })
  const r = routes.find((x) => x.method === 'post' && x.path === '/api/pron/preview')
  assert.ok(r, '/api/pron/preview 这条路由没被注册')
  const res = fakeRes()
  await r.handlers[r.handlers.length - 1]({ body }, res)
  return res
}

test('⭐ 预览发给名片声明的端点，请求体只有 text 和 lang', async () => {
  const calls = []
  const res = await callPreview(
    { text: '你好', lang: 'zh', engine_id: 'demo' },
    {
      resolveEngineProfile: () => HTTP_PROFILE({ pron_preview: { endpoint: '/custom/pron', request: 'json' } }),
      gsvPost: async (path, payload, opts) => {
        calls.push({ path, payload, opts })
        return {
          statusCode: 200,
          body: Buffer.from(JSON.stringify({
            lang: 'zh', norm_text: 'nǐ hǎo',
            tokens: [{ segLang: 'zh', word: '你', unit: 'syllable', chars: [{ ch: '你', reading: 'nǐ' }] }],
          })),
        }
      },
    })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/custom/pron', '端点必须来自名片，不能写死')
  assert.deepEqual(calls[0].payload, { text: '你好', lang: 'zh' })
  assert.equal(calls[0].opts.baseUrl, 'http://127.0.0.1:9999')
  assert.equal(calls[0].opts.reqTimeout, 1234)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.norm_text, 'nǐ hǎo')
})

test('⭐ 引擎的响应状态原样透出，不被统一改成 200', async () => {
  const res = await callPreview(
    { text: 'abc', engine_id: 'demo' },
    {
      resolveEngineProfile: () => HTTP_PROFILE(),
      gsvPost: async () => ({ statusCode: 422, body: Buffer.from(JSON.stringify({ error: 'bad text' })) }),
    })
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.error, 'bad text')
})

test('stdio 与通用宿主在解析层就被拒（见 profile 的 pron 一节），这里只走 HTTP', async () => {
  // 名片声明 pron 的那台必然是自带服务脚本的引擎：通用宿主只答 /tts。
  const res = await callPreview(
    { text: '你好', lang: 'zh', engine_id: 'demo' },
    {
      resolveEngineProfile: () => HTTP_PROFILE(),
      gsvPost: async (path, payload, opts) => {
        assert.equal(path, '/pron/preview')
        assert.deepEqual(payload, { text: '你好', lang: 'zh' })
        assert.equal(opts.baseUrl, 'http://127.0.0.1:9999')
        return { statusCode: 200, body: Buffer.from(JSON.stringify({ norm_text: 'x', tokens: [] })) }
      },
    })
  assert.equal(res.statusCode, 200)
})

test('⭐⭐ 名片有 languages 表也不换算预览的 lang：那里说的是平台的话', async () => {
  const calls = []
  await callPreview(
    { text: '你好', lang: 'zh', engine_id: 'demo' },
    {
      resolveEngineProfile: () => HTTP_PROFILE({ language_map: { zh: 'all_zh', ja: 'all_ja' } }),
      gsvPost: async (path, payload, opts) => {
        calls.push(payload)
        return { statusCode: 200, body: Buffer.from(JSON.stringify({ norm_text: 'x', tokens: [] })) }
      },
    })
  assert.deepEqual(calls[0], { text: '你好', lang: 'zh' },
    '给预览补上语种换算，GSV 的预览读音就不再等于合成读音')
})

// GSV 的读音预览基线：这里的引擎 id 与端点是测试夹具，用途是钉住一台已装引擎的现状。
test('⭐⭐ GSV 基线：端点、请求体、地址与超时逐项不变', async () => {
  const gsv = require('../engines/profile').resolveEngineProfile('gpt-sovits')
  const calls = []
  const res = await callPreview(
    { text: '你好', lang: 'zh', engine_id: 'gpt-sovits' },
    {
      resolveEngineProfile: () => gsv,
      gsvPost: async (path, payload, opts) => {
        calls.push({ path, payload, opts })
        return {
          statusCode: 200,
          body: Buffer.from(JSON.stringify({
            lang: 'zh', norm_text: '你好',
            tokens: [{ segLang: 'zh', word: '你', unit: 'syllable', chars: [{ ch: '你', reading: 'nǐ' }] }],
          })),
        }
      },
    })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/pron/preview')
  assert.deepEqual(calls[0].payload, { text: '你好', lang: 'zh' })
  assert.equal(calls[0].opts.baseUrl, 'http://127.0.0.1:9880')
  assert.equal(calls[0].opts.reqTimeout, 300000)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.tokens[0].chars[0].reading, 'nǐ')
})

test('⛔ 名片没声明 pron.preview ⇒ 501，并且一次传输都不发', async () => {
  let calls = 0
  const res = await callPreview(
    { text: '你好', engine_id: 'demo' },
    {
      resolveEngineProfile: () => HTTP_PROFILE({ pron_preview: null }),
      gsvPost: async () => { calls += 1; throw new Error('不该被调用') },
    })
  assert.equal(res.statusCode, 501)
  assert.equal(res.body.code, 'PRON_PREVIEW_UNSUPPORTED')
  assert.equal(calls, 0)
})

test('⛔ 缺 engine_id ⇒ 400，不替用户挑一台引擎', async () => {
  const res = await callPreview({ text: '你好' }, {})
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'PRON_ENGINE_ID_MISSING')
})

test('⛔ 不认识的引擎 ⇒ 400，错误里带上引擎 id', async () => {
  const res = await callPreview(
    { text: '你好', engine_id: 'nobody' },
    {
      resolveEngineProfile: () => { throw new Error('manifest not found') },
      gsvPost: async () => { throw new Error('不该被调用') },
    })
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /nobody/)
})

test('空文本 ⇒ 空结果，不打引擎（没东西可预览）', async () => {
  let calls = 0
  const res = await callPreview(
    { text: '', lang: 'ja', engine_id: 'demo' },
    {
      resolveEngineProfile: () => { throw new Error('空文本不该走到解析引擎') },
      gsvPost: async () => { calls += 1; throw new Error('不该被调用') },
    })
  assert.deepEqual(res.body, { lang: 'ja', norm_text: '', tokens: [] })
  assert.equal(calls, 0)
})

test('传输层失败 ⇒ 502，说明引擎可能没起来', async () => {
  const res = await callPreview(
    { text: '你好', engine_id: 'demo' },
    {
      resolveEngineProfile: () => HTTP_PROFILE(),
      gsvPost: async () => { throw new Error('ECONNREFUSED') },
    })
  assert.equal(res.statusCode, 502)
  assert.match(res.body.error, /pron preview failed/)
})
