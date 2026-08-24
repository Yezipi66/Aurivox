'use strict'

// ===========================================================================
//  /v1/audio/speech 出错时，报错里点的是哪台引擎的名字
// ===========================================================================
//
// 契约 v2 第 3 步（甲）。这条路由是**外部程序**（SillyTavern 这类走 OpenAI
// 兼容接口的）唯一的错误来源：webui 那条路径会把外壳剥掉，这条不会，原样
// 送出去。所以这里写死 "GPT-SoVITS" 的后果最直接 —— 下游作者接了别的引擎，
// 调用方却被指向一台可能根本没启动、甚至没装的引擎。
//
// 接假 express 的手法与 synthesis.enginePayload 那个文件相同（沙箱没有
// node_modules），被测的是真实的路由代码。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const { assembleEnginePayload } = require('../engines/payload')

// ---- 假 express ------------------------------------------------------------
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

const createRouter = require('./synthesis')

// --------------------------------------------------------------------------
//  两台引擎：老路径那台（label 就叫 GPT-SoVITS）和另一台
// --------------------------------------------------------------------------

const GSV = {
  id: 'gpt-sovits',
  label: 'GPT-SoVITS',
  base_url: 'http://127.0.0.1:9880',
  timeout_ms: 120000,
  max_chars: 45,
  requires_reference_audio: true,
  reference_clip_seconds: { min: 3, max: 10 },
  hot_swap_models: true,
  param_keys: [],
  maps: {
    text: 'text', text_lang: 'text_lang',
    reference_audio: 'ref_audio_path', reference_text: 'prompt_text',
    reference_lang: 'prompt_lang',
    speed: 'speed_factor', seed: 'seed', media_type: 'media_type', streaming: 'streaming_mode',
  },
  payload_keys: [],
  defaults: {},
}

const LEAN = {
  id: 'engine-lean',
  label: 'Lean TTS',
  base_url: 'http://127.0.0.1:9881',
  timeout_ms: 90000,
  max_chars: 120,
  requires_reference_audio: true,
  reference_clip_seconds: null,
  hot_swap_models: false,
  param_keys: [],
  maps: { text: 'text', reference_audio: 'ref_audio_path', seed: 'seed', media_type: 'media_type', streaming: 'streaming_mode' },
  payload_keys: [],
  defaults: {},
}

const ENGINES = { 'gpt-sovits': GSV, 'engine-lean': LEAN }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-errname-'))
fs.writeFileSync(path.join(tmp, 'ref.wav'), Buffer.alloc(64))

// 上游给什么由每个用例自己决定。
function makeCtx (over = {}) {
  const ctx = {
    APP_DIR: tmp, ASSETS_DIR: tmp, ASSETS_ROOT: tmp,
    AUDIO_FORMATS: { wav: 'audio/wav' },
    baseVoiceReg: () => null,
    buildTtsPayload: (text, cfg, engine) => assembleEnginePayload({
      profile: engine,
      canonical: { text, reference_audio: cfg.reference_audio, seed: cfg.seed },
      cfg,
      engineParams: cfg.engine_params,
    }),
    checkFfmpeg: () => true,
    clientError: (e, f) => String((e && e.message) || f),
    computeSegmentBounds: () => [],
    concatWavFiles: async () => Buffer.alloc(64),
    fs,
    genAssetDir: (g) => path.join(tmp, g),
    genBaseName: (p) => String(p || '').split(/[\\/]/).pop(),
    generateOneSegment: async () => Buffer.alloc(64),
    gsvPost: async () => ({ statusCode: 200, body: Buffer.alloc(64) }),
    gsvStream: async () => { throw new Error('stream not stubbed in this case') },
    isBaseVoice: (v) => v === '__base__',
    loadAdvancedParams: () => ({}),
    loadVoices: () => ({ alice: { language: 'ja' } }),
    newGenId: () => 'GENID',
    normSource: (s) => (s ? String(s) : 'speech'),
    path,
    pathResolver: { resolveManagedRef: (v) => ({ ok: true, path: path.join(tmp, typeof v === 'string' ? v : (v && v.path) || '') }) },
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
    resolveEngineProfile: (id) => {
      const p = ENGINES[id || 'gpt-sovits']
      if (!p) throw new Error(`unknown engine '${id}'`)
      return p
    },
    findLegacyDefaultId: () => 'gpt-sovits',
  }
  return Object.assign(ctx, over)
}

function speechHandler (ctx) {
  routes.length = 0
  createRouter(ctx)
  const r = routes.find((x) => x.method === 'post' && String(x.path).includes('/v1/audio/speech'))
  assert.ok(r, '没有登记 /v1/audio/speech —— 假 express 的接法失效了')
  return r.handlers[r.handlers.length - 1]
}

// 返回外部调用方最终看到的那句话。
async function errorFrom (ctx, body) {
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
  await new Promise((r) => setImmediate(r))
  if (nextErr) return String(nextErr.message || nextErr)
  if (out.status && out.status >= 400) {
    const e = out.json && out.json.error
    return typeof e === 'string' ? e : JSON.stringify(e)
  }
  assert.fail(`本该报错，却成功了：status=${out.status}`)
}

const recipe = (over = {}) => Object.assign({
  schema_version: 4,
  id: 'alice/calm',
  role: 'alice',
  name: 'calm',
  reference_audio: 'ref.wav',
  reference_text: '参考文本',
  language: 'all_ja',
  engine_id: 'gpt-sovits',
  engine_params: {},
  params: {},
}, over)

const withRecipe = (engineId, over = {}) => makeCtx(Object.assign({
  recipeStore: { get: () => null, resolveVoice: () => recipe({ engine_id: engineId }) },
}, over))

// 上游回一个 4xx。
const failingPost = (status, body) => async () => ({ statusCode: status, body: Buffer.from(body) })
// 上游回 4xx 的流式版本：正文是非流式的 JSON，要被 drain 出来。
const failingStream = (status, body) => async () => ({
  statusCode: status,
  stream: (async function * () { yield Buffer.from(body) })(),
})

// ===========================================================================
//  非流式
// ===========================================================================

test('⭐⭐ 甲: 上游 400 ⇒ 报错点名的是这次真的用的那台引擎', async () => {
  const ctx = withRecipe('engine-lean', {
    gsvPost: failingPost(400, '{"detail":"unknown parameter: emo_alpha"}'),
  })
  const msg = await errorFrom(ctx, { voice: 'alice/calm', input: '你好' })
  assert.match(msg, /Lean TTS \/tts failed \(400\)/,
    '外部调用方会照着这个名字去查引擎 —— 名字错了就等于把人指向另一台机器')
  assert.doesNotMatch(msg, /GPT-SoVITS/, '这次根本没用到 GPT-SoVITS，不该出现它的名字')
  assert.match(msg, /unknown parameter: emo_alpha/, '上游的原话仍然要带上，这是排查的全部信息')
})

test('⭐ 甲: 走老路径引擎时这句话一个字节没变（今天的用户看不到任何变化）', async () => {
  const ctx = withRecipe('gpt-sovits', {
    gsvPost: failingPost(500, '{"detail":"CUDA out of memory"}'),
  })
  const msg = await errorFrom(ctx, { voice: 'alice/calm', input: '你好' })
  assert.equal(msg, 'GPT-SoVITS /tts failed (500): {"detail":"CUDA out of memory"}')
})

test('甲: 上游 200 但音频是空的 ⇒ 同样点名', async () => {
  const ctx = withRecipe('engine-lean', {
    gsvPost: async () => ({ statusCode: 200, body: Buffer.alloc(0) }),
  })
  const msg = await errorFrom(ctx, { voice: 'alice/calm', input: '你好' })
  assert.equal(msg, 'Lean TTS returned empty audio')
})

// ===========================================================================
//  流式（另一支代码，另一句文案 —— 必须单独钉）
// ===========================================================================

test('⭐⭐ 甲: 流式上游 400 ⇒ 报错点名的也是真用的那台', async () => {
  const ctx = withRecipe('engine-lean', {
    gsvStream: failingStream(400, '{"detail":"check_params failed"}'),
  })
  const msg = await errorFrom(ctx, { voice: 'alice/calm', input: '你好', stream: true })
  assert.match(msg, /Lean TTS \/tts streaming failed \(400\)/)
  assert.doesNotMatch(msg, /GPT-SoVITS/)
  assert.match(msg, /check_params failed/)
})

test('甲: 流式走老路径引擎时同样一个字节没变', async () => {
  const ctx = withRecipe('gpt-sovits', {
    gsvStream: failingStream(500, 'boom'),
  })
  const msg = await errorFrom(ctx, { voice: 'alice/calm', input: '你好', stream: true })
  assert.equal(msg, 'GPT-SoVITS /tts streaming failed (500): boom')
})

// ===========================================================================
//  连不上那台引擎（传输层失败）
// ===========================================================================
//
// 上面所有用例的前提都是「引擎回了话，只是回的是错话」。真实世界里最常见的
// 第一个错误恰恰不是这种：引擎压根没启动，连接直接被拒。2026-08-23 实测撞到，
// 服务端日志写着 `connect ECONNREFUSED 127.0.0.1:9880`，调用方收到的却是一句
// 不点名任何东西的通用错误 —— 甲刀的承重 err.upstreamBody 对这种失败无效，
// 因为根本没有 upstream body。
//
// ⭐ 这四条盯的是**接线**，不是 upstreamError.js 里那两个纯函数。纯函数的
//    单测在 lib/engines/transportError.node.test.js；那边全绿也不能证明路由
//    真的调用了它们（突变验证第一轮这里就是 4 个 GREEN）。

const refused = () => {
  const e = new Error('connect ECONNREFUSED 127.0.0.1:9881')
  e.code = 'ECONNREFUSED'
  throw e
}

test('⭐ 引擎没启动时，非流式端点点名的是配方选的那台引擎和它的地址', async () => {
  const ctx = withRecipe('engine-lean', { gsvPost: async () => refused() })
  const msg = await errorFrom(ctx, { voice: 'alice/calm', input: '你好' })
  assert.match(msg, /Lean TTS/, '没点名引擎 —— 调用方不知道该去启动哪个进程')
  assert.match(msg, /http:\/\/127\.0\.0\.1:9881/, '没说地址 —— 少了排查唯一需要的信息')
  assert.match(msg, /ECONNREFUSED/)
  assert.doesNotMatch(msg, /GPT-SoVITS/, '把老路径那台顶包了')
})

test('⭐ 引擎没启动时，流式端点同样点名', async () => {
  const ctx = withRecipe('engine-lean', { gsvStream: async () => refused() })
  const msg = await errorFrom(ctx, { voice: 'alice/calm', input: '你好', stream: true })
  assert.match(msg, /Lean TTS/)
  assert.match(msg, /http:\/\/127\.0\.0\.1:9881/)
  assert.doesNotMatch(msg, /GPT-SoVITS/)
})

test('连不上时给的是 502，不是 500（这是上游的毛病，不是本机崩了）', async () => {
  const ctx = withRecipe('engine-lean', { gsvPost: async () => refused() })
  const h = speechHandler(ctx)
  const out = {}
  const res = {
    set: () => res, setHeader: () => res, status: (s) => { out.status = s; return res },
    json: (b) => { out.json = b; return res }, send: () => res, end: () => res,
    write: () => true, on: () => res, headersSent: false,
  }
  let nextErr = null
  await Promise.resolve(h({ body: { voice: 'alice/calm', input: '你好' }, headers: {}, on: () => {}, get: () => undefined },
    res, (e) => { if (e) nextErr = e }))
  await new Promise((r) => setImmediate(r))
  assert.equal(nextErr ? nextErr.status : out.status, 502)
})

test('引擎回了话的失败不许被当成「连不上」', async () => {
  // 反向钉：isTransportError 一旦放宽到「只要抛错就算连不上」，
  // 上游的真实原话就会被一句 "Cannot reach ..." 顶掉。
  const ctx = withRecipe('engine-lean', { gsvPost: failingPost(400, '{"detail":"check_params failed"}') })
  const msg = await errorFrom(ctx, { voice: 'alice/calm', input: '你好' })
  assert.match(msg, /check_params failed/, '上游原话被吃掉了')
  assert.doesNotMatch(msg, /Cannot reach/)
})

// ===========================================================================
//  反硬编码
// ===========================================================================

test('⭐ 甲: 这条路由的源码里不再有写死的引擎名报错文案', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'synthesis.js'), 'utf8')
  // 只看代码行，注释里提到旧文案是允许的（那是解释历史）。
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  for (const bad of ['GPT-SoVITS /tts failed', 'GPT-SoVITS /tts streaming failed', 'GPT-SoVITS returned empty audio']) {
    assert.ok(!codeLines.some((l) => l.includes(bad)),
      `代码里还留着写死的「${bad}」—— 换台引擎它就在撒谎`)
  }
})
