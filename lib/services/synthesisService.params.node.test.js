'use strict'

// /api/generate 的 cfg 按名片拼装：名片声明的参数要到达引擎，method 与宿主同口径，
// 平台占用的键不被配方格子覆盖。
// GSV 基线用真名片与真指纹：parity 逐段比对 payload、指纹与 meta，
// exceptions 记录的是这一层有意改变的行为。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const createSynthesisService = require('./synthesisService')
const { createSegmentCache } = require('../cache/segmentCache')
const { resolveEngineProfile } = require('../engines/profile')
const { makeWav, createSynthesisHarness } = require('../testSynthesis')
const fixture = require('./__fixtures__/gsv-baseline.json')

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

// 默认点名一张与 GSV 无关的假引擎；用例要换名片或换成真 resolveEngineProfile 时走 ctx。
function makeCtx (overrides = {}, engines = { 'engine-x': fakeProfile() }) {
  return createSynthesisHarness({ prefix: 'aurivox-params-', withRef: true, engines, ctx: overrides })
}

const body = (extra = {}) => ({ voice: 'v1', text: '你好', engine_id: 'engine-x', ...extra })

// 1) 非 GSV 参数到达引擎

test('⭐ 假引擎的平铺参数与分格参数都写入 cfg，并拼进 payload', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ x: 5, engine_params: { 'engine-x': { x: 5 } } }) })

  assert.equal(calls.cfgs.length, 1)
  assert.equal(calls.cfgs[0].x, 5, '请求里的 x 必须写入 cfg：否则界面调整了参数而引擎未收到')
  assert.deepEqual(calls.cfgs[0].engine_params, { x: 5 })
  assert.equal(calls.payloads[0].x, 5)
})

test('⭐ 只带分格参数（Flow 的形状）同样能到达引擎', async () => {
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

test('method: 单方法引擎（methods=null）由服务层原样透传，交给宿主判断', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ method: 'vc' }) })

  assert.equal(calls.cfgs.length, 1, '平台不能替宿主把请求拦下')
  assert.equal(calls.cfgs[0].method, 'vc', '平台不拦：这个值能不能认，由宿主按自己的入口形状判断')
  assert.equal(calls.payloads[0].method, 'vc')
})

// 3) 平台键不被配方格子覆盖（真 GSV 名片）

test('⭐ 配方格子中的 seed / speed_factor 不得覆盖平台语义，其余格子键照常透传', async () => {
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
  assert.equal(payload.seed, 7, 'meta 记录 7 而引擎收到 42 时，Rerun 无法复现')
  assert.equal(payload.speed_factor, 1.1)
  assert.equal(payload.super_sampling, true, '非平台占用的格子键必须到达引擎')
  assert.deepStrictEqual(calls.metas[0].recipe.engine_params, grid, 'meta 记录的是调用方给出的原始分格')
})

// pron_overrides / lang_overrides 既是平台按段重映射的键，也是 GSV 的 payload_keys：
// 它们进不了格子白名单靠的是 PLATFORM_REQUEST_KEYS 这一笔扣除，不是 maps。
// 少扣这一笔，格子里的同名值会盖掉平台重映射后的值，而 meta 记的仍是平台那一份。
test('⭐ 平台词同时出现在平铺值与配方格子里：发出去的是平台重映射后的那一份', async () => {
  const { ctx, calls, refPath } = makeCtx({ resolveEngineProfile }, {})
  const { generateService } = createSynthesisService(ctx)
  await generateService({
    body: {
      voice: 'v1',
      text: '你好',
      engine_id: 'gpt-sovits',
      ref_audio: refPath,
      pron_overrides: { '你': ['ni3'] },
      lang_overrides: { '你': 'zh' },
      engine_params: {
        'gpt-sovits': { pron_overrides: { '你': ['ni2'] }, lang_overrides: { '你': 'ja' }, super_sampling: true },
      },
    },
  })

  const payload = calls.payloads[0]
  assert.deepStrictEqual(payload.pron_overrides, { '你': ['ni3'] }, '格子里的同名值不得盖掉平台按段重映射的读音覆盖')
  assert.deepStrictEqual(payload.lang_overrides, { '你': 'zh' })
  assert.equal(payload.super_sampling, true, '同一格子里非平台占用的键照常透传')
})

// 4) GSV 基线：payload、指纹、meta 都不动

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
  const cache = createSegmentCache({ dir: path.join(root, 'cache'), fsImpl: fakeFs })
  return calls.engines.map((engine, i) => cache.fingerprint({
    // maps 必须带上：指纹靠它认出哪个键装的是参考音频（内容哈希，与临时路径无关）。
    profile: { id: engine.id, base_url: '<BASE_URL>', maps: engine.maps },
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
  test(`⭐⭐ GSV 基线（${name}）：payload、指纹与 meta 与基线一致`, async () => {
    const actual = await replay(expected.request)

    assert.equal(actual.payloads.length, expected.payloads.length, '段数变了')
    actual.payloads.forEach((payload, i) => {
      assert.deepStrictEqual(payload, expected.payloads[i], `第 ${i} 段的 payload 变了`)
    })
    assert.deepStrictEqual(actual.fingerprints, expected.fingerprints, '缓存指纹变了：已合成的音频会重新生成')
    assert.deepStrictEqual(actual.metas, expected.meta, 'meta 变了')
  })
}

// 每条都是这一层有意改变的行为，基线 fixture 记录的是改变后的值。
// 组名必须有说明：漏一条，测试标题就变成「undefined」，读的人不知道这条为什么是例外。
const EXCEPTIONS = {
  gridOnly: '配方格子中的参数到达引擎',
  flow: '同上；Flow 格子里的权重路径与参考文本不进请求体',
  emptySpeed: '留空不补名片 defaults：没有可沿用的上一次时，那个空值原样送出去，由引擎自己说话',
  nullTopK: '同上：null 也原样送出去',
  splitBucketString: '字符串布尔按名片声明的类型归一',
  emptyNull: '空串与 null 一律原样送出去，一个都不补',
  method: '单方法引擎透传 method，由宿主判断',
  emptySplit: '升级前空串回落成名片的切分法，现在原样送出去',
}

for (const [name, expected] of Object.entries(fixture.exceptions)) {
  if (!EXCEPTIONS[name]) throw new Error(`例外组 ${name} 没有说明：在 EXCEPTIONS 里写清它凭什么例外`)
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

// 每个例外组在 fixture 里同时存着 base（改变前）与 changed（变了哪几个面）。
// 下面只核对 fixture 自身：changed 必须等于 base 与当前值之间的实际差异，不得多写或少写。
for (const [name, expected] of Object.entries(fixture.exceptions)) {
  test(`例外 ${name}：base 与 changed 记录的差异一致`, () => {
    const faces = []
    if (JSON.stringify(expected.base.payloads) !== JSON.stringify(expected.payloads)) faces.push('payload')
    if (JSON.stringify(expected.base.fingerprints) !== JSON.stringify(expected.fingerprints)) faces.push('指纹')
    if (JSON.stringify(expected.base.meta) !== JSON.stringify(expected.meta)) faces.push('meta')
    assert.deepStrictEqual(expected.changed, faces)
    assert.ok(faces.length > 0, `${name} 列成了例外，却与 base 逐字相同`)
  })
}

// 5) 参数留空：接这台引擎上一次成功调用填的值，接不到就什么都不补（issue #26 §14）

// 在临时输出根里落一次生成记录：查「上一次成功」读的就是这些 meta.json。
function seedGeneration (root, { id = '2026-11-01T000000.000Z', engineId = 'engine-x', status = 'ok', recipe = {} } = {}) {
  const dir = path.join(root, 'outputs/generate', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ engine_id: engineId, status, recipe }))
  return dir
}

test('⭐ 留空 + 这台引擎有上一次成功调用 ⇒ 接它当时填的值，并把接过来的键名回给界面', async () => {
  const { ctx, calls, root } = makeCtx()
  seedGeneration(root, { recipe: { x: 3 } })
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ x: '' }) })

  // 值走的是同一条拼装路径，所以它和显式填 3 是同一个请求，指纹里也有它：不会有「悄悄换了参数却命中旧缓存」。
  assert.equal(calls.payloads[0].x, 3, '引擎收到的该是上次那个值：既不是空串，也不是名片 defaults')
  assert.deepEqual(res.carried_over, { x: 3 }, '接过来的是哪几格、接成了多少要回给界面提醒；不提醒就是平台静默替用户填了值')
  assert.deepEqual(calls.metas[0].carried_over, { x: 3 }, '这次沿用要在生成记录里查得回来')
})

test('留空 + 上一次那一格也是空的 ⇒ 没得接，不报沿用', async () => {
  const { ctx, calls, root } = makeCtx()
  seedGeneration(root, { recipe: { x: '' } })
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ x: '' }) })

  assert.equal(calls.payloads[0].x, '')
  assert.equal(res.carried_over, undefined, '什么都没接过来，就不能告诉用户「已沿用上次的参数」')
})

test('⭐ 留空 + 没有上一次 ⇒ 什么都不补：空值原样送出去，由引擎自己说话', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ x: null }) })

  assert.equal(calls.payloads[0].x, null, '不填名片 defaults、不猜值：用户给的就是送出去的那个')
  assert.equal(res.carried_over, undefined)
})

test('⭐ 没带这个键 ⇒ 照旧由名片 defaults 决定，并且不去翻上一次的记录', async () => {
  let reads = 0
  const { ctx, calls } = makeCtx({ readLastSuccessRecipe: () => { reads++; return null } })
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body() })

  assert.equal(reads, 0, '这次没人留空 ⇒ 不该为查上一次产生任何读盘')
  assert.equal(calls.cfgs[0].x, undefined, '没带这个键 = 调用方不关心这个参数，与留空是两件事')
})
