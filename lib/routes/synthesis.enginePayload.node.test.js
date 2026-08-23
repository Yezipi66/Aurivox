'use strict'

// ===========================================================================
//  /v1/audio/speech：请求发给哪台引擎、请求体里能有哪些键
// ===========================================================================
//
// 契约 v2 第 1c 步。这条路由过去有两处硬伤，两处都不会报错，只会"声音不对"
// 或者"上游 400 但看不出为什么"：
//
//   ① 请求体拼完之后，这里还会**直接写引擎的键名**再补几刀
//      （sample_steps / if_sr / speed_factor / media_type / streaming_mode）。
//      对一台不认识这些键的引擎，IndexTTS2 那种严格的 shim 会当场 400，
//      宽松的会静默忽略 —— 后者更糟。
//
//   ② ⛔ 更要命的：调 gsvPost / gsvStream 时**根本没带地址**。配方明明写了
//      engine_id、上面也解析出了引擎档案，请求却照样打到老路径引擎那台上。
//      也就是说 v4「配方是闭合的调用目标」在这条路由上是断的。
//
// 这个文件把两件事都钉住。接假 express 的手法与 synthesis.recipeEngine
// 那个文件相同（沙箱没有 node_modules），被测的是真实的路由代码。

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
//  两台引擎：一台像 GPT-SoVITS（键多、地址 9880），一台像 IndexTTS2（键少、地址 9881）
// --------------------------------------------------------------------------

const RICH = {
  id: 'engine-rich',
  label: 'Rich',
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
  payload_keys: ['top_k', 'sample_steps', 'if_sr', 'overlap_length', 'min_chunk_length'],
  defaults: {},
}

const LEAN = {
  id: 'engine-lean',
  label: 'Lean',
  base_url: 'http://127.0.0.1:9881',
  timeout_ms: 90000,
  max_chars: 120,
  requires_reference_audio: true,
  reference_clip_seconds: null,
  hot_swap_models: false,
  param_keys: [],
  // 这台引擎只有四个概念 —— 没有语言、没有参考文本、没有语速、不支持流式。
  maps: { text: 'text', reference_audio: 'ref_audio_path', seed: 'seed', media_type: 'media_type' },
  payload_keys: ['emo_alpha'],
  defaults: {},
}

const ENGINES = { 'engine-rich': RICH, 'engine-lean': LEAN }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-enginepayload-'))
fs.writeFileSync(path.join(tmp, 'ref.wav'), Buffer.alloc(64))

function makeCtx (over = {}) {
  const seen = { post: [], stream: [] }
  const ctx = {
    APP_DIR: tmp, ASSETS_DIR: tmp, ASSETS_ROOT: tmp,
    AUDIO_FORMATS: { wav: 'audio/wav' },
    baseVoiceReg: () => null,
    // ⭐ 用**真实的**组装器，不是 stub —— 这个文件测的就是请求体的形状，
    //    stub 掉它等于什么都没测。
    buildTtsPayload: (text, cfg, engine) => assembleEnginePayload({
      profile: engine,
      canonical: {
        text,
        text_lang: cfg.text_lang || cfg.language || 'ja',
        reference_audio: cfg.reference_audio,
        reference_text: cfg.reference_text,
        reference_lang: cfg.prompt_lang || cfg.language || 'ja',
        speed: cfg.speed_factor, seed: cfg.seed, media_type: cfg.media_type,
      },
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
    gsvPost: async (p, payload, opts) => { seen.post.push({ path: p, payload, opts }); return { statusCode: 200, body: Buffer.alloc(64) } },
    gsvStream: async (p, payload, timeout, opts) => { seen.stream.push({ path: p, payload, timeout, opts }); throw new Error('stream not exercised here') },
    isBaseVoice: (v) => v === '__base__',
    loadAdvancedParams: () => ({}),
    loadVoices: () => ({ alice: { language: 'ja' } }),
    newGenId: () => 'GENID',
    normSource: (s) => (s ? String(s) : 'speech'),
    path,
    pathResolver: { resolveManagedRef: (v) => ({ ok: true, path: typeof v === 'string' ? path.join(tmp, v) : path.join(tmp, (v && v.path) || '') }) },
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
      const p = ENGINES[id || 'engine-rich']
      if (!p) throw new Error(`unknown engine '${id}'`)
      return p
    },
    findLegacyDefaultId: () => 'engine-rich',
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
  await new Promise((r) => setImmediate(r))
  if (nextErr) throw nextErr
  if (out.status && out.status >= 400) {
    const e = new Error(typeof (out.json && out.json.error) === 'string' ? out.json.error : JSON.stringify(out.json))
    e.status = out.status
    throw e
  }
  return out
}

const recipe = (over = {}) => Object.assign({
  schema_version: 4,
  id: 'alice/calm',
  role: 'alice',
  name: 'calm',
  reference_audio: 'ref.wav',
  reference_text: '参考文本',
  language: 'all_ja',
  engine_id: 'engine-rich',
  engine_params: { 'engine-rich': { top_k: 20 } },
  params: { speed: 1.2, seed: 42 },
}, over)

// ===========================================================================
//  ⛔ 配方选了哪台引擎，请求就打到哪台 —— 这一条过去是断的
// ===========================================================================

test('⭐⭐ 配方指向另一台引擎 ⇒ 请求发到那台的地址（过去无论如何都发给老路径引擎）', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: {
      resolveVoice: () => recipe({
        engine_id: 'engine-lean',
        engine_params: { 'engine-lean': { emo_alpha: 0.8 } },
      }),
    },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.equal(seen.post.length, 1)
  assert.equal(seen.post[0].opts.baseUrl, 'http://127.0.0.1:9881',
    '配方写了 engine-lean，请求却没打到它的地址上 —— ' +
    '配方作为「闭合的调用目标」在运输层断了')
  assert.equal(seen.post[0].opts.reqTimeout, 90000, '超时也该来自那台引擎的名片')
})

test('配方走老路径引擎时，地址仍然是老路径引擎的（行为不变）', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { resolveVoice: () => recipe() },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.equal(seen.post[0].opts.baseUrl, 'http://127.0.0.1:9880')
  assert.equal(seen.post[0].opts.reqTimeout, 120000)
})

test('中断信号照旧传给运输层（加地址没有把它挤掉）', async () => {
  const { ctx, seen } = makeCtx({ recipeStore: { resolveVoice: () => recipe() } })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.ok('signal' in seen.post[0].opts, 'opts 里少了 signal —— 客户端断开就停不下来了')
})

// ===========================================================================
//  请求体里只出现这台引擎认识的键
// ===========================================================================

test('⭐⭐ 键少的那台引擎：请求体里一个它不认识的键都没有', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: {
      resolveVoice: () => recipe({
        engine_id: 'engine-lean',
        engine_params: { 'engine-lean': { emo_alpha: 0.8 } },
      }),
    },
    // 高级参数页里存着一堆 GPT-SoVITS 的参数 —— 它们过去会照单全收地拼进去。
    loadAdvancedParams: () => ({ top_k: 15, sample_steps: 32, if_sr: true }),
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  const payload = seen.post[0].payload
  for (const k of ['text_lang', 'prompt_text', 'prompt_lang', 'speed_factor',
    'top_k', 'sample_steps', 'if_sr', 'streaming_mode', 'overlap_length', 'min_chunk_length']) {
    assert.ok(!(k in payload),
      `${k} 漏进了 engine-lean 的请求体。它的名片里没有这个概念，` +
      '严格的引擎会当场 400，宽松的会静默忽略 —— 两种都不是我们要的')
  }
  assert.equal(payload.text, '你好')
  assert.equal(payload.emo_alpha, 0.8, '配方里这台引擎的那一格必须原样送到')
})

test('键多的那台引擎：该有的键一个不少（门控没有把 GPT-SoVITS 的功能砍掉）', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { resolveVoice: () => recipe() },
    loadAdvancedParams: () => ({ sample_steps: 32, if_sr: true }),
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  const payload = seen.post[0].payload
  assert.equal(payload.sample_steps, 32)
  assert.equal(payload.if_sr, true)
  assert.equal(payload.media_type, 'wav', '非流式这条路径固定收 WAV，转码在 broker 这边做')
  assert.ok('speed_factor' in payload)
  assert.equal(payload.top_k, 20, '配方里这台引擎那一格的值要盖过默认')
})

test('⭐ 连"容器格式"这种看起来人人都有的概念，名片没写也不发', async () => {
  // 这一条是突变验证逼出来的：我原本以为「非流式固定收 WAV」这行改不坏，
  // 结果发现两台测试引擎的名片里**都**有 media_type，于是"写死键名"和
  // "问名片要"produce 出一样的东西 —— 测试当时测了个寂寞。
  //
  // 真实世界里这台引擎是存在的：只吐一种格式、没有 media_type 这个参数的
  // TTS 服务很常见（IndexTTS2 的 shim 就只认 wav）。给它塞一个 media_type
  // 就是一次必然失败的调用。
  const NO_MEDIA = { ...LEAN, id: 'engine-nomedia', base_url: 'http://127.0.0.1:9882',
    maps: { text: 'text', reference_audio: 'ref_audio_path', seed: 'seed' } }
  const { ctx, seen } = makeCtx({
    recipeStore: {
      resolveVoice: () => recipe({ engine_id: 'engine-nomedia', engine_params: { 'engine-nomedia': { emo_alpha: 0.5 } } }),
    },
    resolveEngineProfile: (id) => {
      const p = { ...ENGINES, 'engine-nomedia': NO_MEDIA }[id || 'engine-rich']
      if (!p) throw new Error(`unknown engine '${id}'`)
      return p
    },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  const payload = seen.post[0].payload
  assert.ok(!('media_type' in payload),
    '名片里没有 media_type 这个概念，却还是被塞了进去 —— ' +
    '"人人都有的键"这种直觉正是割线长回去的方式')
  assert.deepEqual(Object.keys(payload).sort(), ['emo_alpha', 'ref_audio_path', 'seed', 'text'])
})

test('engine_params 只取自己那一格 —— 别的引擎的格子不许串过来', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: {
      resolveVoice: () => recipe({
        engine_id: 'engine-lean',
        engine_params: {
          'engine-lean': { emo_alpha: 0.8 },
          'engine-rich': { top_k: 99, text_split_method: 'cut5' },
        },
      }),
    },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  const payload = seen.post[0].payload
  assert.equal(payload.emo_alpha, 0.8)
  assert.ok(!('top_k' in payload), '换引擎时上一台的参数要留在配方里，但不许发出去')
  assert.ok(!('text_split_method' in payload))
})
