'use strict'

// ===========================================================================
//  broker 走配方时：引擎跟着配方走，参考音频校验由名片说了算
// ===========================================================================
//
// ⚠ 这个文件解决一个具体的困难：routes/synthesis.js 需要 express，而 CI 沙箱里
//   没有 node_modules —— 整个路由模块在沙箱里根本 require 不进来，于是这条
//   代码路径**一条测试都跑不到**。
//
//   我第一版就栽在「测不到 = 不测」上：1b 那个 requires_engine_params 死代码，
//   正是因为测试塞了假名片绕过真实模块，才一路绿着交付出去的。
//
//   所以这里不绕过被测代码，只**替掉 express 本身**：往 require 缓存里塞一个
//   最小的假 express（只需要 Router().post/get 能登记 handler），然后把
//   **真实的** createRouter 加载进来，拿到**真实的** handler 去调。
//   被测的是 lib/routes/synthesis.js 里一个字没改的原代码。

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

// 只在本进程内、只对 'express' 生效。
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'express') return 'express'
  return origResolve.call(this, request, ...rest)
}
require.cache.express = { id: 'express', filename: 'express', loaded: true, exports: fakeExpress }

const createRouter = require('./synthesis')

// --------------------------------------------------------------------------
//  ctx
// --------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-broker-'))
const realWav = path.join(tmp, 'ref.wav')
fs.writeFileSync(realWav, Buffer.alloc(64))

const profile = (over = {}) => Object.assign({
  id: 'engine-a',
  label: 'Engine A',
  base_url: 'http://127.0.0.1:9880',
  timeout_ms: 120000,
  max_chars: 45,
  requires_reference_audio: true,
  reference_clip_seconds: { min: 3, max: 10 },
  hot_swap_models: true,
  param_keys: [],
}, over)

function makeCtx (over = {}, engineOver = {}) {
  const seen = { cfg: [], engine: [] }
  const ctx = {
    APP_DIR: tmp, ASSETS_DIR: tmp, ASSETS_ROOT: tmp,
    AUDIO_FORMATS: { wav: 'audio/wav' },
    baseVoiceReg: () => null,
    buildTtsPayload: (t, cfg) => ({ ref_audio_path: cfg.reference_audio, prompt_text: cfg.reference_text, text: t }),
    checkFfmpeg: () => true,
    clientError: (e, f) => String((e && e.message) || f),
    computeSegmentBounds: () => [],
    concatWavFiles: async () => Buffer.alloc(64),
    fs,
    genAssetDir: (g) => path.join(tmp, g),
    genBaseName: (p) => String(p || '').split(/[\\/]/).pop(),
    generateOneSegment: async (text, cfg, engine) => { seen.cfg.push(cfg); seen.engine.push(engine); return Buffer.alloc(64) },
    gsvPost: async () => ({ status: 200, body: Buffer.alloc(64) }),
    gsvStream: async () => { throw new Error('not used') },
    isBaseVoice: (v) => v === '__base__',
    loadAdvancedParams: () => ({}),
    loadVoices: () => ({ alice: { language: 'ja' } }),
    newGenId: () => 'GENID',
    normSource: (s) => (s ? String(s) : 'speech'),
    path,
    pathResolver: { resolveManagedRef: (v) => ({ ok: true, path: typeof v === 'string' ? v : (v && v.path ? path.join(tmp, v.path) : '') }) },
    pickBestCkpt: () => ({}),
    recipeStore: { get: () => null, resolveVoice: () => null },
    requireApiKey: (req, res, next) => next(),
    resolveRefPath: (p) => p,
    resolveSeed: () => 123456,
    splitJapaneseText: (t) => [t],
    switchModels: async () => {},
    toPcm16Wav: (b) => b,
    transcodeAudio: async (b) => b,
    wavDurationSec: () => 5,
    withGenerationLock: (fn) => fn(),
    writeGenMeta: () => {},
    // 只认得装了的引擎；其余一律抛 —— 和 profile.js 真实行为一致
    // （⛔ 不静默回落：回落会把「名片写错」表现成「声音不对」）。
    resolveEngineProfile: (id) => {
      const installed = ['engine-a', 'engine-b']
      if (id && !installed.includes(id)) throw new Error(`unknown engine '${id}'`)
      return profile(Object.assign({ id: id || 'engine-a' }, engineOver))
    },
    findLegacyDefaultId: () => 'engine-a',
  }
  return { ctx: Object.assign(ctx, over), seen }
}

function speechHandler (ctx) {
  routes.length = 0
  createRouter(ctx)
  const r = routes.find((x) => x.method === 'post' && String(x.path).includes('/v1/audio/speech'))
  assert.ok(r, '没有登记 /v1/audio/speech —— 假 express 的接法失效了')
  return r.handlers[r.handlers.length - 1]
}

// asyncHandler 把错误交给 next(err)，而它自己的 promise 照样 resolve —— 两边
// 会抢跑。所以这里先把 next 收到的错误存下来，等 handler 整个跑完再抛。
async function call (ctx, body) {
  const h = speechHandler(ctx)
  let nextErr = null
  const out = {}
  const res = {
    set: () => res, setHeader: () => res, status: (s) => { out.status = s; return res },
    json: (b) => { out.json = b; return res },
    send: (b) => { out.body = b; return res },
    end: (b) => { out.body = b; return res },
    write: () => true, on: () => res, headersSent: false,
  }
  const req = { body, headers: {}, on: () => {}, get: () => undefined }
  await Promise.resolve(h(req, res, (err) => { if (err) nextErr = err }))
  // 让 asyncHandler 的 .catch(next) 有机会跑完
  await new Promise((r) => setImmediate(r))
  if (nextErr) throw nextErr
  // asyncHandler 的翻译契约：HttpError -> res.status(s).json({ error })。
  // 它**不走 next()**，所以错误落在响应体里而不是异常里。这里翻回异常，
  // 让每条测试都能直接断言 status / message。
  if (out.status && out.status >= 400) {
    const e = new Error(typeof (out.json && out.json.error) === 'string' ? out.json.error : JSON.stringify(out.json))
    e.status = out.status
    throw e
  }
  return out
}

const recipe = (over = {}) => Object.assign({
  schema_version: 3,
  id: 'alice/calm',
  role: 'alice',
  name: 'calm',
  reference_audio: 'ref.wav',
  reference_text: '参考文本',
  language: 'all_ja',
  params: { speed: 1.2, seed: 42, top_k: 15, text_split_method: 'cut5' },
}, over)

// --------------------------------------------------------------------------
//  参考音频校验：名片说了算，不是写死必填
// --------------------------------------------------------------------------

test('⭐ 名片 requires_reference_audio=false ⇒ 配方没有参考音频也放行', async () => {
  // 这是 Kokoro 那一类（50+ 预设音色包、根本没有参考音频这个概念）能不能
  // 进 broker 的分水岭。写死必填 = 这类引擎的配方永远调不出去。
  const { ctx } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ reference_audio: '', reference_text: '' }) },
  }, { requires_reference_audio: false, reference_clip_seconds: null })
  const out = await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.ok(out, '本该放行却抛了')
})

test('名片 requires_reference_audio=true ⇒ 配方缺参考音频仍然 400（GSV 用户的清晰报错不丢）', async () => {
  const { ctx } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ reference_audio: 'nope.wav' }) },
  }, { requires_reference_audio: true })
  await assert.rejects(
    () => call(ctx, { voice: 'alice/calm', input: '你好' }),
    (e) => e.status === 400 && /reference_audio not found/.test(e.message),
  )
})

test('名片说不要，但配方填了一个指不到文件的路径 ⇒ 照样 400（配方坏了就是坏了）', async () => {
  const { ctx } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ reference_audio: 'nope.wav' }) },
  }, { requires_reference_audio: false, reference_clip_seconds: null })
  await assert.rejects(
    () => call(ctx, { voice: 'alice/calm', input: '你好' }),
    (e) => e.status === 400 && /reference_audio not found/.test(e.message),
  )
})

test('名片 requires_reference_audio=true 但配方没有参考文本 ⇒ 400', async () => {
  const { ctx } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ reference_audio: realWav, reference_text: '' }) },
  }, { requires_reference_audio: true })
  await assert.rejects(
    () => call(ctx, { voice: 'alice/calm', input: '你好' }),
    (e) => e.status === 400 && /no reference_text/.test(e.message),
  )
})

// --------------------------------------------------------------------------
//  引擎跟着配方走
// --------------------------------------------------------------------------

test('配方的 engine_id 指向没装的引擎 ⇒ 400，且明确说是配方的问题', async () => {
  const { ctx } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'not-installed' }) },
  })
  await assert.rejects(
    () => call(ctx, { voice: 'alice/calm', input: '你好' }),
    (e) => e.status === 400 && /engine unavailable/i.test(e.message) && /not-installed/.test(e.message),
  )
})
