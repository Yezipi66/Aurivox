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
    // 名片解析的产物一定带 language_map（名片没写表就是空表），手写的假名片也要带齐这一项。
    language_map: {},
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
  return createSynthesisHarness({ prefix: 'aurivox-params-', engines, ctx: overrides })
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

// 1b) 权重位经请求 → cfg → 指纹：非 GSV 的两个位都应让缓存失效
// 带 switch 的 call 位才是这一刀真正修的形状：这张名片没把它的参数列进 payload_keys，
// 选中的路径不随请求体走，所以只看 cfg.gpt_model / cfg.sovits_model 的指纹对它是瞎的。
// 假名片要过得了真解析：checkSlotParams 要求 slot.param 一定在 param_keys 里。

test('⭐⭐ 非 GSV 引擎：call 位与 launch 位切换权重都应改变指纹（真 generateService → 真指纹）', async () => {
  const engines = {
    'engine-x': fakeProfile({
      param_keys: ['x', 'acoustic_weight'],
      weight_slots: [
        {
          name: 'acoustic', param: 'acoustic_weight', applies_at: 'call',
          switch: { endpoint: '/set_acoustic', query: 'weights_path' },
        },
        { name: 'vocoder', applies_at: 'launch' },
      ],
    }),
  }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  const wdir = path.join(calls.root, 'weights')
  fs.mkdirSync(wdir, { recursive: true })
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
  assert.equal(calls.cfgs[0].acoustic_weight, a1, 'call 位未写入 cfg')
  assert.deepEqual(calls.cfgs[0].launch_weights, { vocoder: v1 }, 'launch 位未写入 cfg.launch_weights')
  assert.notEqual(fpAt(1), fpAt(0), 'call 位的权重已切换，但缓存未失效')
  assert.notEqual(fpAt(2), fpAt(1), 'launch 位的权重已切换，但缓存未失效')
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

// 3.5) 格子里的 schema 键按名片声明归一：平铺值缺席或归不成时，发出去的是格子里那份

test('⭐ 只带格子（Flow 的形状）时，schema 键按名片声明的类型归一：发出去的是数字，不是字符串', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ engine_params: { 'engine-x': { x: '7' } } }) })

  assert.equal(calls.payloads[0].x, 7, '名片声明 number ⇒ 引擎该收到 7，收到 "7" 就是两个入口两套规则')
  assert.equal(typeof calls.payloads[0].x, 'number')
})

test('⭐ 平铺值归不成类型、格子带着能归成的值 ⇒ 发出去的是归一后的那一份，不是原字符串', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ x: 'abc', engine_params: { 'engine-x': { x: '12' } } }) })

  assert.equal(calls.payloads[0].x, 12)
  assert.equal(typeof calls.payloads[0].x, 'number')
  assert.notEqual(calls.cfgs[0].x, 'abc', '平铺那个归不成的值不该留在 cfg 里')
})

test('字符串布尔按名片声明归成布尔：格子进来的与平铺进来的同一个口径', async () => {
  const engine = fakeProfile({
    param_keys: ['x', 'flag'],
    payload_keys: ['x', 'flag'],
    param_schema: [{ name: 'x', type: 'number' }, { name: 'flag', type: 'boolean' }],
  })
  const { ctx, calls } = makeCtx({}, { 'engine-x': engine })
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ engine_params: { 'engine-x': { flag: 'false' } } }) })

  assert.equal(calls.payloads[0].flag, false, '"false" 发成字符串会让只吃布尔的引擎当场拒收')
})

test('⭐ 格子里的空值仍原样送出：不补名片 defaults，也不整个丢掉这个键', async () => {
  const engine = fakeProfile({ defaults: { x: 1 } })
  const { ctx, calls } = makeCtx({}, { 'engine-x': engine })
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ engine_params: { 'engine-x': { x: '' } } }) })

  assert.ok('x' in calls.payloads[0], '留空是用户明确清空了这一格，键要发出去，由引擎自己说话')
  assert.equal(calls.payloads[0].x, '')
})

test('名片没声明类型的原生键不动它：归一只按名片走，平台不猜', async () => {
  const engine = fakeProfile({ payload_keys: ['x', 'native'] })
  const { ctx, calls } = makeCtx({}, { 'engine-x': engine })
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ engine_params: { 'engine-x': { native: '12' } } }) })

  assert.equal(calls.payloads[0].native, '12', 'schema 之外的原生键没有类型可据，原样透传')
})

// 3b) 语种换算：请求里的历史写法换成该引擎的写法，其余写法保持不变

test('⭐ 名片没写 languages：历史写法 all_ja / all_ko 换成平台码，其余原样到达引擎', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ split: false, text_lang: 'all_ja', prompt_lang: 'all_ko' }) })
  assert.equal(calls.cfgs[0].text_lang, 'ja', '只支持平台码的引擎收到 all_ja 会当成一个它不支持的写法')
  assert.equal(calls.cfgs[0].prompt_lang, 'ko')

  const b = makeCtx()
  const svc = createSynthesisService(b.ctx)
  await svc.generateService({ body: body({ split: false, text_lang: 'zh' }) })
  assert.equal(b.calls.cfgs[0].text_lang, 'zh', '不是历史写法的值平台不推测，按原值发送')
})

test('⭐ 名片写了 languages：历史写法换算回该引擎自己的写法', async () => {
  const engines = { 'engine-x': fakeProfile({ language_map: { ja: 'yose', ko: 'hangul', zh: 'putonghua' } }) }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ split: false, text_lang: 'all_ja', prompt_lang: 'all_ko' }) })
  assert.equal(calls.cfgs[0].text_lang, 'yose')
  assert.equal(calls.cfgs[0].prompt_lang, 'hangul')

  const gsv = resolveEngineProfile('gpt-sovits')
  // 平台可能送进这两个位置的全部写法：GSV 的名片表要让它们原样返回，逐值不变。
  for (const given of ['all_zh', 'all_yue', 'all_ja', 'all_ko', 'zh', 'yue', 'ja', 'ko', 'en',
    'auto', 'auto_zh_ja', 'auto_zh_ja_yue', 'not_a_lang']) {
    const one = makeCtx({ resolveEngineProfile: () => gsv }, {})
    await createSynthesisService(one.ctx).generateService({
      body: { voice: 'v1', text: '你好', engine_id: 'gpt-sovits', ref_audio: one.refPath, split: false, text_lang: given },
    })
    assert.equal(one.calls.cfgs[0].text_lang, given, `GSV 的 '${given}' 经过名片表要回到同一个值`)
  }
})

test('⭐ 音色登记的语言：历史写法换算成该引擎的写法，裸码按原值发送', async () => {
  const engines = { 'engine-x': fakeProfile({ language_map: { ja: 'yose' } }) }
  const { ctx, calls } = makeCtx(
    { loadVoices: () => ({ v1: { language: 'ja', text_lang: 'all_ja', prompt_lang: 'ja' } }) },
    engines)
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ split: false }) })
  assert.equal(calls.cfgs[0].text_lang, 'yose', '登记值里的 all_ja 若原样发出，只支持平台码的引擎会收到一个它不支持的写法')
  assert.equal(calls.cfgs[0].prompt_lang, 'ja', '不是历史写法的值平台不推测，按原值发送')

  const gsv = resolveEngineProfile('gpt-sovits')
  // GSV 的登记值经过名片表要回到同一个值：这一条守的是零回归。
  for (const reg of ['all_zh', 'all_yue', 'all_ja', 'all_ko', 'zh', 'yue', 'ja', 'ko', 'en',
    'auto', 'auto_zh_ja', 'auto_zh_ja_yue']) {
    const one = makeCtx({
      resolveEngineProfile: () => gsv,
      loadVoices: () => ({ v1: { text_lang: reg, prompt_lang: reg } }),
    }, {})
    await createSynthesisService(one.ctx).generateService({
      body: { voice: 'v1', text: '你好', engine_id: 'gpt-sovits', ref_audio: one.refPath, split: false },
    })
    assert.equal(one.calls.cfgs[0].text_lang, reg, `GSV 登记的 '${reg}' 经过名片表要回到同一个值`)
    assert.equal(one.calls.cfgs[0].prompt_lang, reg)
  }
})

// 4) GSV 基线：payload、指纹原料（除版本号）与 meta 均保持不变

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
  // 基线指纹按版本 2 计算：与生成 fixture 用的是同一版算法，才能证明取材逐字节没有变化。
  // 生产使用的版本号由 segmentCache 的「版本号进指纹」测试覆盖。
  const cache = createSegmentCache({ dir: path.join(root, 'cache'), fsImpl: fakeFs, version: 2 })
  return calls.engines.map((engine, i) => cache.fingerprint({
    // maps 与 weight_slots 必须提供：前者用于识别参考音频，后者逐位取权重。fingerprint 只接受解析后的名片，
    // 缺 weight_slots 时立即抛错。
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
  flatAndGridEmpty: '平铺与格子同为空串：两边都按留空原样送出，一个都不补',
  flatEmptyGridString: '平铺留空、格子带原值：发出去的是平铺那份空值，格子里未被平铺盖到的键按名片声明归一',
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
// 输出根取自 harness 的 ctx.outputRoots（路径权威见 lib/paths.js），这里不另写一份布局。
function seedGeneration (outputRoots, { id = '2026-11-01T000000.000Z', engineId = 'engine-x', source = 'generate', status = 'ok', recipe = {} } = {}) {
  const dir = path.join(outputRoots[source], id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ engine_id: engineId, source, status, recipe }))
  return dir
}

test('⭐ 留空 + 这台引擎有上一次成功调用 ⇒ 接它当时填的值，并把接过来的键名回给界面', async () => {
  const { ctx, calls } = makeCtx()
  seedGeneration(ctx.outputRoots, { recipe: { x: 3 } })
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ x: '' }) })

  // 值走的是同一条拼装路径，所以它和显式填 3 是同一个请求，指纹里也有它：不会有「悄悄换了参数却命中旧缓存」。
  assert.equal(calls.payloads[0].x, 3, '引擎收到的该是上次那个值：既不是空串，也不是名片 defaults')
  assert.deepEqual(res.carried_over, { x: 3 }, '接过来的是哪几格、接成了多少要回给界面提醒；不提醒就是平台静默替用户填了值')
  assert.deepEqual(calls.metas[0].carried_over, { x: 3 }, '这次沿用要在生成记录里查得回来')
})

test('留空 + 上一次那一格也是空的 ⇒ 没得接，不报沿用', async () => {
  const { ctx, calls } = makeCtx()
  seedGeneration(ctx.outputRoots, { recipe: { x: '' } })
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

test('⭐ 上一次是机器入口那一次 ⇒ 不接：客户端填的值不是界面用户的上一次', async () => {
  const { ctx, calls } = makeCtx()
  seedGeneration(ctx.outputRoots, { source: 'broker', recipe: { x: 7 } })
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ x: '' }) })

  assert.equal(calls.payloads[0].x, '', '判据 8：沿用只发生在界面上，机器那一次不参选')
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
