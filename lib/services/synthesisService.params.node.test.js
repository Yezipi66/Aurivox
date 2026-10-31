'use strict'

// /api/generate 的 cfg 按名片拼装：名片声明的参数要到达引擎，method 与宿主同口径，
// 平台占用的键不被配方格子反超。
// GSV 基线用真名片与真指纹：parity 逐段比对 payload、指纹与 meta，
// exceptions 钉的是本 PR 有意改变的行为。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const createSynthesisService = require('./synthesisService')
const { createSynthesisModule } = require('../server/synthesis')
const { applyEngineKnobs } = require('../engines/paramTable')
const { createSegmentCache } = require('../cache/segmentCache')
const { resolveEngineProfile } = require('../engines/profile')
const { toPcm16Wav, computeSegmentBounds, wavDurationSec } = require('../audio/wav')
const fixture = require('./__fixtures__/gsv-baseline.json')

function makeWav (nSamples = 16000, sampleRate = 16000) {
  const data = Buffer.alloc(nSamples * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

// 一台参数名与 GSV 完全无关的引擎。
function fakeProfile (over = {}) {
  return {
    id: 'engine-x',
    label: 'Engine X',
    dir: '/nowhere/engine-x',
    base_url: 'http://127.0.0.1:3333',
    base_url_source: 'manifest',
    timeout_ms: 1000,
    max_chars: 45,
    hard_max_chars: 90,
    requires_reference_audio: false,
    reference_clip_seconds: null,
    weight_slots: [],
    output_sample_rate: 16000,
    supports_finetune: false,
    streaming: false,
    param_keys: ['x'],
    payload_keys: ['x'],
    maps: { text: 'text' },
    param_schema: [{ name: 'x', type: 'number' }],
    defaults: {},
    methods: null,
    default_method: null,
    ...over,
  }
}

// 真实 buildTtsPayload 的替身：不用网络，只记录 cfg / payload。
const synthModule = createSynthesisModule({
  _weightSwitch: { ensure: async () => ({}) },
  segmentCache: { get: () => null, put: () => false, fingerprint: () => '' },
})

function makeCtx (overrides = {}, engines = { 'engine-x': fakeProfile() }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-params-'))
  const refPath = path.join(root, 'ref.wav')
  fs.writeFileSync(refPath, makeWav(16000 * 5))

  const calls = { root, refPath, cfgs: [], payloads: [], engines: [], metas: [], switched: 0 }
  const ctx = {
    fs,
    path,
    resolveEngineProfile: (id) => {
      if (!engines[id]) { const e = new Error(`ENGINE_NOT_FOUND: ${id}`); throw e }
      return engines[id]
    },
    switchModels: async () => { calls.switched++ },
    generateOneSegment: async (text, cfg, engine) => {
      const payload = synthModule.buildTtsPayload(text, cfg, engine)
      applyEngineKnobs(payload, engine, cfg)
      calls.cfgs.push(cfg)
      calls.payloads.push(payload)
      calls.engines.push(engine)
      return makeWav(1600)
    },
    toPcm16Wav,
    computeSegmentBounds,
    wavDurationSec,
    concatWavFiles: (files, out) => { fs.writeFileSync(out, makeWav(3200)); return { method: 'stub' } },
    splitJapaneseText: (text, opts) => {
      const out = []
      for (let i = 0; i < text.length; i += opts.softLimit) out.push(text.slice(i, i + opts.softLimit))
      return out
    },
    loadVoices: () => ({ v1: { language: 'zh' } }),
    isBaseVoice: () => false,
    baseVoiceReg: () => null,
    resolveReference: synthModule.resolveReference,
    buildTtsPayload: synthModule.buildTtsPayload,
    newGenId: () => 'GENID',
    normSource: (s) => (s ? String(s) : 'generate'),
    genAssetDir: (genId) => path.join(root, genId),
    genBaseName: (p) => (p && typeof p === 'string' ? p.replace(/\\/g, '/').split('/').pop() : ''),
    writeGenMeta: (id, meta) => { calls.metas.push(meta) },
    resolveSeed: synthModule.resolveSeed,
    clientError: (err, fallback) => String((err && err.message) || fallback),
    withGenerationLock: (fn) => fn(),
    ...overrides,
  }
  return { ctx, calls, root, refPath }
}

const body = (extra = {}) => ({ voice: 'v1', text: '你好', engine_id: 'engine-x', ...extra })

// 1) 非 GSV 参数到达引擎

test('⭐ 假引擎的平铺参数与分格参数都进 cfg，并拼进 payload', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ x: 5, engine_params: { 'engine-x': { x: 5 } } }) })

  assert.equal(calls.cfgs.length, 1)
  assert.equal(calls.cfgs[0].x, 5, '请求里的 x 必须进 cfg：否则界面调了、引擎没收到')
  assert.deepEqual(calls.cfgs[0].engine_params, { x: 5 })
  assert.equal(calls.payloads[0].x, 5)
})

test('⭐ 只带分格参数（Flow 的形状）也能到达引擎', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ engine_params: { 'engine-x': { x: 7 } } }) })

  assert.deepEqual(calls.cfgs[0].engine_params, { x: 7 })
  assert.equal(calls.payloads[0].x, 7)
})

// 1b) 权重位经请求 → cfg → 指纹：非 GSV 的两个位都要能让缓存失效

test('⭐⭐ 非 GSV 引擎：call 位与 launch 位换权重都让指纹变（真 generateService → 真指纹）', async () => {
  const engines = {
    'engine-x': fakeProfile({
      weight_slots: [
        { name: 'acoustic', param: 'acoustic_weight', applies_at: 'call' },
        { name: 'vocoder', applies_at: 'launch' },
      ],
    }),
  }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-params-w-'))
  const weight = (name) => {
    const p = path.join(wdir, name)
    fs.writeFileSync(p, Buffer.from(name))
    return p
  }
  const a1 = weight('a1.pt'); const a2 = weight('a2.pt')
  const v1 = weight('v1.pt'); const v2 = weight('v2.pt')
  const cache = createSegmentCache({ dir: path.join(calls.root, 'cache') })
  const fpAt = (i) => cache.fingerprint({
    profile: engines['engine-x'], payload: calls.payloads[i], cfg: calls.cfgs[i],
  })
  const send = (acoustic, vocoder) => generateService({
    body: body({ seed: 42, acoustic_weight: acoustic, launch_weights: { vocoder } }),
  })

  await send(a1, v1)
  await send(a2, v1)
  await send(a2, v2)
  assert.equal(calls.cfgs[0].acoustic_weight, a1, 'call 位没进 cfg')
  assert.deepEqual(calls.cfgs[0].launch_weights, { vocoder: v1 }, 'launch 位没进 cfg.launch_weights')
  assert.notEqual(fpAt(1), fpAt(0), 'call 位换了权重，缓存没有失效')
  assert.notEqual(fpAt(2), fpAt(1), 'launch 位换了权重，缓存没有失效')
})

// 2) method：与宿主同口径

test('method: 多方法引擎收到表内值 ⇒ cfg 与 payload 都带着它', async () => {
  const engine = fakeProfile({ methods: ['zero_shot', 'vc'], default_method: 'zero_shot' })
  const { ctx, calls } = makeCtx({}, { 'engine-x': engine })
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ method: 'vc' }) })

  assert.equal(calls.cfgs[0].method, 'vc')
  assert.equal(calls.payloads[0].method, 'vc')
})

test('method: 多方法引擎收到表外值 ⇒ 400，一次推理都不发生', async () => {
  const engine = fakeProfile({ methods: ['zero_shot', 'vc'], default_method: 'zero_shot' })
  const { ctx, calls } = makeCtx({}, { 'engine-x': engine })
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(
    () => generateService({ body: body({ method: 'nope' }) }),
    (e) => e.status === 400 && /zero_shot/.test(e.message) && /vc/.test(e.message),
  )
  assert.equal(calls.cfgs.length, 0)
})

test('method: 单方法引擎（methods=null）服务层不抢答，交给宿主判断', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ method: 'vc' }) })

  assert.equal(calls.cfgs.length, 1, '平台不能替宿主把请求拦下来')
  assert.equal(calls.cfgs[0].method, 'vc', '原样透传，值与 call.method 不同时由宿主 400')
  assert.equal(calls.payloads[0].method, 'vc')
})

// 3) 平台键不被配方格子反超（真 GSV 名片）

test('⭐ 配方格子里的 seed / speed_factor 不许压过平台语义，其余格子键照旧透传', async () => {
  const { ctx, calls, refPath } = makeCtx({ resolveEngineProfile }, {})
  const { generateService } = createSynthesisService(ctx)
  const grid = { 'gpt-sovits': { seed: 42, speed_factor: 9, super_sampling: true } }
  await generateService({
    body: {
      voice: 'v1',
      text: '你好',
      engine_id: 'gpt-sovits',
      ref_audio: refPath,
      seed: 7,
      speed_factor: 1.1,
      engine_params: grid,
    },
  })

  const payload = calls.payloads[0]
  assert.equal(payload.seed, 7, 'meta 记 7、引擎收到 42 ⇒ Rerun 复现不了')
  assert.equal(payload.speed_factor, 1.1)
  assert.equal(payload.super_sampling, true, '非平台占用的格子键必须到达引擎')
  assert.deepStrictEqual(calls.metas[0].recipe.engine_params, grid, 'meta 记的是调用方给的原始分格')
})

// 3b) 语种的双读：请求里的旧写法换成这台引擎的原话，别的写法一律不动

test('⭐ 名片没写 languages：旧写法 all_ja / all_ko 换成平台码，其余原样到达引擎', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ split: false, text_lang: 'all_ja', prompt_lang: 'all_ko' }) })
  assert.equal(calls.cfgs[0].text_lang, 'ja', '只认平台码的引擎不该再收到 all_ja')
  assert.equal(calls.cfgs[0].prompt_lang, 'ko')

  const b = makeCtx()
  const svc = createSynthesisService(b.ctx)
  await svc.generateService({ body: body({ split: false, text_lang: 'zh' }) })
  assert.equal(b.calls.cfgs[0].text_lang, 'zh', '不是旧写法的值平台不猜，原样发')
})

test('⭐ 名片写了 languages：旧写法换算回这台引擎自己的写法', async () => {
  const engines = { 'engine-x': fakeProfile({ language_map: { ja: 'yose', ko: 'hangul', zh: 'putonghua' } }) }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ split: false, text_lang: 'all_ja', prompt_lang: 'all_ko' }) })
  assert.equal(calls.cfgs[0].text_lang, 'yose')
  assert.equal(calls.cfgs[0].prompt_lang, 'hangul')

  const gsv = resolveEngineProfile('gpt-sovits')
  // 平台可能送进这两个位置的全部写法：GSV 的名片表要让它们原样回来，一条都不许漂。
  for (const given of ['all_zh', 'all_yue', 'all_ja', 'all_ko', 'zh', 'yue', 'ja', 'ko', 'en',
    'auto', 'auto_zh_ja', 'auto_zh_ja_yue', 'not_a_lang']) {
    const one = makeCtx({ resolveEngineProfile: () => gsv }, {})
    await createSynthesisService(one.ctx).generateService({
      body: { voice: 'v1', text: '你好', engine_id: 'gpt-sovits', ref_audio: one.refPath, split: false, text_lang: given },
    })
    assert.equal(one.calls.cfgs[0].text_lang, given, `GSV 的 '${given}' 绕一圈名片表要回到同一个值`)
  }
})

test('⭐ 音色登记的语言原样发出：那张表是按这台引擎写进去的', async () => {
  const engines = { 'engine-x': fakeProfile({ language_map: { ja: 'yose' } }) }
  const { ctx, calls } = makeCtx(
    { loadVoices: () => ({ v1: { language: 'ja', text_lang: 'all_ja', prompt_lang: 'ja' } }) },
    engines)
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ split: false }) })
  assert.equal(calls.cfgs[0].text_lang, 'all_ja', '登记值不经换算')
  assert.equal(calls.cfgs[0].prompt_lang, 'ja', '登记值不经换算')
})

// 4) GSV 基线：payload、指纹原料（除版本号）与 meta 都不动

// 与捕获脚本同一套归一：临时参考音频的路径、引擎地址换成固定值，
// 参考音频按内容哈希进指纹，与路径无关。
function normalize (value, refPath) {
  return JSON.parse(JSON.stringify(value, (k, v) => (typeof v === 'string' ? v.split(refPath).join('<REF>') : v)))
}

function fingerprintsOf (calls, root) {
  const fakeFs = {
    statSync: () => ({ size: 123, mtimeMs: 456 }),
    readFileSync: () => Buffer.from('ref-bytes'),
  }
  // 基线指纹按版本 2 计算：与生成 fixture 的算法同代，才能证明取材逐字节没有漂移。
  // 生产用的版本号由 segmentCache 自己的「版本号进指纹」测试守着。
  const cache = createSegmentCache({ dir: path.join(root, 'cache'), fsImpl: fakeFs, version: 2 })
  return calls.engines.map((engine, i) => cache.fingerprint({
    // maps 与 weight_slots 必须带上：前者认参考音频，后者逐位取权重（指纹缺了任何一边都会命中旧音频）。
    profile: { id: engine.id, base_url: '<BASE_URL>', maps: engine.maps, weight_slots: engine.weight_slots },
    payload: calls.payloads[i],
    cfg: calls.cfgs[i],
  }))
}

async function replay (request) {
  const { ctx, calls, root, refPath } = makeCtx({ resolveEngineProfile }, {})
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: { ...request, ref_audio: refPath } })
  return {
    payloads: calls.payloads.map((payload) => normalize(payload, refPath)),
    fingerprints: fingerprintsOf(calls, root),
    metas: normalize(calls.metas, refPath).map((meta) => { delete meta.createdAt; return meta }),
  }
}

for (const [name, expected] of Object.entries(fixture.parity)) {
  test(`⭐⭐ GSV 基线（${name}）：payload、指纹原料与 meta 与基线一致`, async () => {
    const actual = await replay(expected.request)

    assert.equal(actual.payloads.length, expected.payloads.length, '段数变了')
    actual.payloads.forEach((payload, i) => {
      assert.deepStrictEqual(payload, expected.payloads[i], `第 ${i} 段的 payload 变了`)
    })
    assert.deepStrictEqual(actual.fingerprints, expected.fingerprints, '缓存指纹变了：已合成的音频会重新生成')
    assert.deepStrictEqual(actual.metas, expected.meta, 'meta 变了')
  })
}

// 每条都是本 PR 有意改变的行为，基线 fixture 钉的是改后的值。
const EXCEPTIONS = {
  gridOnly: '配方格子里的参数现在到达引擎（#26 意见 1）',
  flow: '同上；Flow 格子里的权重路径与参考文本不进请求体',
  emptySpeed: '空串按「没填」处理，交给名片 defaults，与 /v1/audio/speech 同口径',
  nullTopK: 'null 同上',
  splitBucketString: '字符串布尔按名片声明的类型归一',
  emptyNull: '空串与 null 一律交给名片 defaults',
  method: '单方法引擎透传 method，由宿主判断',
}

for (const [name, expected] of Object.entries(fixture.exceptions)) {
  test(`GSV 行为例外（${name}）：${EXCEPTIONS[name]}`, async () => {
    const actual = await replay(expected.request)

    assert.equal(actual.payloads.length, expected.payloads.length, '段数变了')
    actual.payloads.forEach((payload, i) => {
      assert.deepStrictEqual(payload, expected.payloads[i], `第 ${i} 段的 payload 变了`)
    })
    assert.deepStrictEqual(actual.fingerprints, expected.fingerprints, '缓存指纹变了')
    assert.deepStrictEqual(actual.metas, expected.meta, 'meta 变了')
  })
}
