'use strict'

//  /v1/audio/speech：请求发给哪台引擎、请求体里能有哪些键
//
// 契约 v2 第 1c 步。这条路由过去有两处硬伤，两处都不会报错，只会"声音不对"
// 或者"上游 400 但看不出为什么"：
//
//  ① 请求体拼完之后，这里还会直接写引擎的键名再补几刀
//  （sample_steps / if_sr / speed_factor / media_type / streaming_mode）。
//  对一台不认识这些键的引擎，通用宿主（lib/engines/host.py 的 validate_request）会返回 400，
//  宽松的会静默忽略 ： 后者更糟。
//
//  ② 更要命的：调 gsvPost / gsvStream 时根本没带地址。配方明明写了
//  engine_id、上面也解析出了引擎档案，请求却照样打到老路径引擎那台上。
//  也就是说 v4「配方是闭合的调用目标」在这条路由上是断的。
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

//  两台引擎：一台像 GPT-SoVITS（键多、地址 9880），一台像 IndexTTS2（键少、地址 9881）

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
  // 名片解析的产物一定带 language_map（名片没写表就是空表），手写的假名片也要带齐这一项。
  language_map: {},
  maps: {
    text: 'text', text_lang: 'text_lang',
    reference_audio: 'ref_audio_path', reference_text: 'prompt_text',
    reference_lang: 'prompt_lang',
    speed: 'speed_factor', seed: 'seed', media_type: 'media_type', streaming: 'streaming_mode',
  },
  payload_keys: ['top_k', 'sample_steps', 'if_sr', 'overlap_length', 'min_chunk_length'],
  defaults: {},
  // 名片声明的可调旋钮。平台按这一份把 cfg 里的值补进请求体
  // ： 不是按 payload_keys 遍历：那里面还有 aux_ref_audio_paths 这种平台
  // 已经解析成绝对路径的结构化字段，照抄一遍会把它打回项目相对路径
  // （server.js 那条注释警告的正是这个）。schema 里只会有标量旋钮。
  param_schema: [
    { name: 'top_k', type: 'integer', tier: 'common' },
    { name: 'sample_steps', type: 'integer', tier: 'advanced' },
    { name: 'if_sr', type: 'boolean', tier: 'advanced' },
    { name: 'overlap_length', type: 'integer', tier: 'advanced' },
    { name: 'min_chunk_length', type: 'integer', tier: 'advanced' },
  ],
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
  language_map: {},
  // 这台引擎只有四个概念 ： 没有语言、没有参考文本、没有语速、不支持流式。
  maps: { text: 'text', reference_audio: 'ref_audio_path', seed: 'seed', media_type: 'media_type' },
  payload_keys: ['emo_alpha'],
  defaults: {},
  param_schema: [{ name: 'emo_alpha', type: 'number', tier: 'common' }],
}

// 语种写法交回名片的两台：engine-typed 有名片表（写法与平台码不同），
// engine-untyped 有 text_lang 这个位置却没写表，它只支持平台码。
const LANG_MAP = {
  zh: 'zh_x', yue: 'yue_x', ja: 'ja_x', en: 'en_x', ko: 'ko_x',
  auto: 'auto_x', auto_zh_ja: 'multi_x', auto_zh_ja_yue: 'multi_x',
}
const TYPED = { ...RICH, id: 'engine-typed', base_url: 'http://127.0.0.1:9883', language_map: LANG_MAP }
const UNTYPED = { ...RICH, id: 'engine-untyped', base_url: 'http://127.0.0.1:9884' }
// 真实 GPT-SoVITS 名片：零回归按它当前表里的写法比对，不复制一份表。
const GSV_LANG = require('../engines/profile').resolveEngineProfile('gpt-sovits').language_map
const GSV = {
  ...RICH, id: 'engine-gsv', base_url: 'http://127.0.0.1:9885', language_map: GSV_LANG,
  // GSV 的名片把 auto_base_lang 列进 payload_keys，夹具跟着它：基底语言要能在发出去的请求体里看到。
  payload_keys: [...RICH.payload_keys, 'auto_base_lang'],
}

const ENGINES = {
  'engine-rich': RICH, 'engine-lean': LEAN,
  'engine-typed': TYPED, 'engine-untyped': UNTYPED, 'engine-gsv': GSV,
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-enginepayload-'))
fs.writeFileSync(path.join(tmp, 'ref.wav'), Buffer.alloc(64))

function makeCtx (over = {}) {
  const seen = { post: [], stream: [] }
  const ctx = {
    APP_DIR: tmp, ASSETS_DIR: tmp, ASSETS_ROOT: tmp,
    AUDIO_FORMATS: { wav: 'audio/wav' },
    baseVoiceReg: () => null,
    //  用真实的组装器，不是 stub ： 这个文件测的就是请求体的形状，
    //  stub 掉它等于什么都没测。
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

//  配方选了哪台引擎，请求就打到哪台 ： 这一条过去是断的

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

//  请求体里只出现这台引擎认识的键

test('⭐⭐ 键少的那台引擎：请求体里一个它不认识的键都没有', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: {
      resolveVoice: () => recipe({
        engine_id: 'engine-lean',
        engine_params: { 'engine-lean': { emo_alpha: 0.8 } },
      }),
    },
    // 高级参数页里存着一堆 GPT-SoVITS 的参数 ： 它们过去会照单全收地拼进去。
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
  // 结果发现两台测试引擎的名片里都有 media_type，于是"写死键名"和
  // "问名片要"produce 出一样的东西 ： 测试当时测了个寂寞。
  //
  // 真实世界里这台引擎是存在的：只吐一种格式、没有 media_type 这个参数的
  // TTS 服务很常见（IndexTTS2 的名片 output_formats 就只写了 wav）。给它塞一个 media_type
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

//  语种：/v1/audio/speech 的 language 用平台语种码，写法由名片换算

test('⭐⭐ 请求里的历史写法 all_ja 换成该引擎的写法（以名片为准）', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-typed', language: '' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好', language: 'all_ja' })
  assert.equal(seen.post[0].payload.text_lang, 'ja_x')
})

test('⭐⭐ 只支持平台码的引擎收到的是 ja，不是 all_ja', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-untyped', language: '' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好', language: 'all_ja' })
  assert.equal(seen.post[0].payload.text_lang, 'ja',
    '没有 languages 表的引擎收到 all_ja 就等于一次必然失败的调用')
})

test('/v1/audio/speech 的 language 大小写与首尾空白都归一', async () => {
  for (const [given, expected] of [['JA', 'ja_x'], [' all_zh ', 'zh_x'], ['ja', 'ja_x']]) {
    const { ctx, seen } = makeCtx({
      recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-typed', language: '' }) },
    })
    await call(ctx, { voice: 'alice/calm', input: '你好', language: given })
    assert.equal(seen.post[0].payload.text_lang, expected, `language=${given}`)
  }
})

test('⭐ 音色登记的裸码按原值发送，登记值里的历史写法也换算成该引擎的写法', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-typed', language: '' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.equal(seen.post[0].payload.text_lang, 'ja', 'assets 里的裸码 ja 是引擎的写法，不是平台码')
  assert.equal(seen.post[0].payload.prompt_lang, 'ja')

  // 登记值也可能是历史写法（PATCH /api/voices 接受任意值）：它同样要过这道换算。
  for (const [engine, expected] of [['engine-typed', 'ja_x'], ['engine-untyped', 'ja']]) {
    const one = makeCtx({
      loadVoices: () => ({ alice: { language: 'all_ja' } }),
      recipeStore: { resolveVoice: () => recipe({ engine_id: engine, language: '' }) },
    })
    await call(one.ctx, { voice: 'alice/calm', input: '你好' })
    assert.equal(one.seen.post[0].payload.text_lang, expected, `${engine} 收到登记值里的 all_ja，即它不支持的写法`)
    assert.equal(one.seen.post[0].payload.prompt_lang, expected)
  }
})

test('⭐ 裸音色名那条路径也走同一道换算：登记值里的历史写法同样换算', async () => {
  // /v1/audio/speech 读登记值有两条路径：配方路径，以及「裸音色名 + 请求给 engine_id」。
  // 这条走后者：换算发生在两条路径汇合之后，登记值里的历史写法在这里同样要换成引擎的写法。
  const dir = path.join(tmp, 'bob')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'segments.json'), JSON.stringify({
    segments: [{ matched: true, audio: path.join(tmp, 'ref.wav'), text: 'こんにちは' }],
  }))

  for (const [engine, expected] of [['engine-typed', 'ja_x'], ['engine-untyped', 'ja']]) {
    const one = makeCtx({ loadVoices: () => ({ bob: { language: 'all_ja' } }) })
    await call(one.ctx, { voice: 'bob', engine_id: engine, input: '你好' })
    assert.equal(one.seen.post[0].payload.text_lang, expected,
      `${engine} 从裸音色名这条路径收到登记值里的 all_ja，即它不支持的写法`)
    assert.equal(one.seen.post[0].payload.prompt_lang, expected)
  }

  const gsv = makeCtx({ loadVoices: () => ({ bob: { language: 'all_ja' } }) })
  await call(gsv.ctx, { voice: 'bob', engine_id: 'engine-gsv', input: '你好' })
  assert.equal(gsv.seen.post[0].payload.text_lang, 'all_ja', 'GSV 的登记值逐值原样到达')
  assert.equal(gsv.seen.post[0].payload.prompt_lang, 'all_ja')
})

test('⭐ 存量配方里的历史写法按该引擎的写法发送（有表的引擎收到它自己的写法）', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-typed' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.equal(seen.post[0].payload.text_lang, 'ja_x',
    "配方存的是 'all_ja'：先归一为平台码 ja，再换算成该引擎的写法")
})

test('⭐⭐ 存量配方里的历史写法在只支持平台码的引擎上换成平台码', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-untyped' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.equal(seen.post[0].payload.text_lang, 'ja',
    '配方里存的是引擎取值 all_ja：不归一就按原值发给一台不认识它的引擎')
})

test('两种多语写法在名片里映射为同一个引擎写法', async () => {
  for (const given of ['auto_zh_ja', 'auto_zh_ja_yue']) {
    const { ctx, seen } = makeCtx({
      recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-typed', language: '' }) },
    })
    await call(ctx, { voice: 'alice/calm', input: '你好', language: given })
    assert.equal(seen.post[0].payload.text_lang, 'multi_x', `language=${given}`)
  }
})

test('⭐ 没写表的引擎收到 auto_zh_ja：这两个写法平台不代为合并', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-untyped', language: '' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好', language: 'auto_zh_ja' })
  assert.equal(seen.post[0].payload.text_lang, 'auto_zh_ja',
    '这两个写法都在平台词表上，是否合并由名片决定，平台不代为合并')
})

test('词表外的语种仍退回平台的 auto，再按名片换算', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-typed', language: '' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好', language: 'fr' })
  assert.equal(seen.post[0].payload.text_lang, 'auto_x', '退回平台码 auto 之后照样按名片换算')
})

// 多语模式的基底语言：这条回落是 GSV 的旋钮（它名片的 payload_keys 里有 auto_base_lang），
// 所以走 engine-gsv，也让发出去的键真带上下面的断言。
test('⭐⭐ 配方语言是多语模式、又没写 auto_base_lang：基底语言回落用资产登记的语言', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-gsv', language: 'auto_zh_ja' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.equal(seen.post[0].payload.text_lang, 'auto_zh_ja')
  assert.equal(seen.post[0].payload.auto_base_lang, 'ja',
    '夹具里 alice 登记的语言是 ja：回落不读它，多语请求的基底语言就等于被写死成 zh')
})

test('⭐⭐ 资产登记的语言是 auto：基底语言退回 zh，因为 auto 不是合法的基础语言', async () => {
  const { ctx, seen } = makeCtx({
    loadVoices: () => ({ alice: { language: 'auto' } }),
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-gsv', language: 'auto_zh_ja_yue' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.equal(seen.post[0].payload.auto_base_lang, 'zh')
})

test('⭐⭐ 资产登记的语言是历史写法 all_ja：基底语言归一成 ja，不退回中文', async () => {
  const { ctx, seen } = makeCtx({
    loadVoices: () => ({ alice: { language: 'all_ja' } }),
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-gsv', language: 'auto_zh_ja_yue' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.equal(seen.post[0].payload.auto_base_lang, 'ja',
    '登记值不归一就判具体语种：all_ja 判不中，一门日语资产被当成中文的基底语言')
})

test('⭐⭐ 配方钉的是多语写法：请求发到引擎并回音频，平台不在这里当场拦下', async () => {
  // 这一条钉的是 owner 答复第 6 条留在本刀的例外：改动前这条路上多语请求没有基底语言，
  // 平台自己报错；现在它带着解析出来的基底语言发到引擎。
  const { ctx, seen } = makeCtx({
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-gsv', language: 'auto_zh_ja_yue' }) },
  })
  const out = await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.equal(seen.post.length, 1, '请求发到引擎，不是平台拦下')
  assert.equal(seen.post[0].payload.auto_base_lang, 'ja', '发出去的一定向着基底语言')
  assert.ok(out.body && out.body.length > 0, '回的是音频')
})

test('⭐⭐ 名片把多语写法换算成这台引擎自己的说法：基底语言的判据仍认得出多语请求', async () => {
  // 名片表把 auto_zh_ja 换成 multi_x 之后，按发出去的那个值判「是不是多语」就永远判不中，
  // 这条回落对这台引擎消失。判据取换算前的语种，两边才都对得上。
  const MULTI = { ...TYPED, id: 'engine-multi', payload_keys: [...TYPED.payload_keys, 'auto_base_lang'] }
  const { ctx, seen } = makeCtx({
    resolveEngineProfile: () => MULTI,
    recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-multi', language: '' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好', language: 'auto_zh_ja' })
  assert.equal(seen.post[0].payload.text_lang, 'multi_x', '发出去的是该名片表里的写法')
  assert.equal(seen.post[0].payload.auto_base_lang, 'ja', '多语请求照样拿到基底语言')
})

// GSV 的零回归：/v1/audio/speech 这条路上发给它的两个语种位置，逐值对着固定的基线表比。
//
// BASE_ALIAS 是固定的基线表：GSV 的这两个位置必须始终等于它，改了它这段比较就不再是回归保护。

const BASE_ALIAS = {
  zh: 'all_zh', all_zh: 'all_zh',
  yue: 'all_yue', all_yue: 'all_yue',
  ja: 'all_ja', all_ja: 'all_ja',
  en: 'en',
  ko: 'all_ko', all_ko: 'all_ko',
  auto: 'auto',
  auto_zh_ja: 'auto_zh_ja_yue', auto_zh_ja_yue: 'auto_zh_ja_yue',
}

test('⭐⭐ 请求指定的语种发给 GSV：与别名表的输出逐值相同', async () => {
  for (const [lang, expected] of Object.entries(BASE_ALIAS)) {
    const { ctx, seen } = makeCtx({
      recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-gsv', language: '' }) },
    })
    await call(ctx, { voice: 'alice/calm', input: '你好', language: lang })
    assert.equal(seen.post[0].payload.text_lang, expected, `language=${lang}`)
  }
})

test('⭐⭐ 配方记录的语言发给 GSV：原样到达，逐值不变', async () => {
  for (const stored of ['all_zh', 'all_yue', 'all_ja', 'all_ko', 'zh', 'ja', 'en', 'auto', 'auto_zh_ja', 'not_a_lang']) {
    const { ctx, seen } = makeCtx({
      recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-gsv', language: stored }) },
    })
    await call(ctx, { voice: 'alice/calm', input: '你好' })
    assert.equal(seen.post[0].payload.text_lang, stored, `recipe.language=${stored}`)
  }
})

test('⭐⭐ 音色登记的语言发给 GSV：逐值原样到达', async () => {
  for (const reg of ['all_zh', 'all_yue', 'all_ja', 'all_ko', 'zh', 'ja', 'en', 'auto',
    'auto_zh_ja', 'auto_zh_ja_yue', 'not_a_lang']) {
    const { ctx, seen } = makeCtx({
      loadVoices: () => ({ alice: { language: reg } }),
      recipeStore: { resolveVoice: () => recipe({ engine_id: 'engine-gsv', language: '' }) },
    })
    await call(ctx, { voice: 'alice/calm', input: '你好' })
    assert.equal(seen.post[0].payload.text_lang, reg, `voiceReg.language=${reg}`)
    assert.equal(seen.post[0].payload.prompt_lang, reg, `voiceReg.language=${reg}`)
  }
})
