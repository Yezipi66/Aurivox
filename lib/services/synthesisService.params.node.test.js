'use strict'

// 第一刀：/api/generate 的 cfg 也按名片拼装。
// 这一份钉的是「非 GSV 引擎的参数真的能到达引擎」，以及三条边界：
//   method 与宿主同口径、平台键不被配方格子反超、GSV 的 payload 与指纹逐字节不变。
//
// 名片解析从 ctx 注入；只有 GSV 基线那一条读真名片（那是它的目的）。

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
  _modelSwitcher: { ensure: async () => ({}) },
  segmentCache: { get: () => null, put: () => false, fingerprint: () => '' },
})

function makeCtx (overrides = {}, engines = { 'engine-x': fakeProfile() }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-params-'))
  const refPath = path.join(root, 'ref.wav')
  fs.writeFileSync(refPath, makeWav(16000 * 5))

  const calls = { root, refPath, cfgs: [], payloads: [], engines: [], switched: 0 }
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
    writeGenMeta: () => {},
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

// 3) 平台键不被配方格子反超

test('⭐ 配方格子里的 seed / speed_factor 不许压过平台语义', async () => {
  const engine = fakeProfile({
    maps: {
      text: 'text', seed: 'seed', speed: 'speed_factor', reference_audio: 'ref_audio_path',
    },
    payload_keys: ['seed', 'speed_factor', 'top_k'],
    param_keys: ['top_k'],
    param_schema: [{ name: 'top_k', type: 'integer' }],
  })
  const { ctx, calls } = makeCtx({}, { 'engine-x': engine })
  const { generateService } = createSynthesisService(ctx)
  await generateService({
    body: body({
      seed: 7,
      speed_factor: 1.1,
      top_k: 5,
      engine_params: { 'engine-x': { seed: 42, speed_factor: 9, top_k: 5 } },
    }),
  })

  const payload = calls.payloads[0]
  assert.equal(payload.seed, 7, 'meta 记 7、引擎收到 42 ⇒ Rerun 复现不了')
  assert.equal(payload.speed_factor, 1.1)
  assert.equal(payload.top_k, 5, '只拦平台占用的键，别的格子参数照旧透传')
})

// 4) GSV 基线：payload 与缓存指纹都不动

test('⭐⭐ GSV 基线：payload 深度相等，segmentCache 指纹不变（第一刀不冷缓存）', async () => {
  const { ctx, calls, root, refPath } = makeCtx({ resolveEngineProfile }, {})
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: { ...fixture.request, ref_audio: refPath } })

  const payload = calls.payloads[0]
  const normalized = JSON.parse(JSON.stringify(payload))
  if (normalized.ref_audio_path === refPath) normalized.ref_audio_path = '<REF>'
  assert.deepStrictEqual(normalized, fixture.payload,
    'GSV 的 payload 变了：默认值或装配顺序被改动')

  const engine = calls.engines[0]
  assert.equal(engine.id, 'gpt-sovits')
  // 指纹里与运行环境有关的两样归一掉：临时参考音频的路径（按内容哈希，本来就无关）
  // 和引擎地址（换成固定值）。其余原料（payload、权重路径）与基线生成时完全相同。
  const fakeFs = {
    statSync: () => ({ size: 123, mtimeMs: 456 }),
    readFileSync: () => Buffer.from('ref-bytes'),
  }
  const cache = createSegmentCache({ dir: path.join(root, 'cache'), fsImpl: fakeFs })
  const fingerprint = cache.fingerprint({
    // maps 必须带上：指纹靠它认出哪个键装的是参考音频（内容哈希，与临时路径无关）。
    profile: { id: engine.id, base_url: '<BASE_URL>', maps: engine.maps },
    payload,
    cfg: calls.cfgs[0],
  })
  assert.equal(fingerprint, fixture.fingerprint,
    '指纹原料变了：第一刀不该让缓存冷启动')
})
