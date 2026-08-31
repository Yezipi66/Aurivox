'use strict'

// ===========================================================================
//  引擎跟着请求走 + 开跑前点料（契约 v2 第 1b 步）
// ===========================================================================
// 第 0 步的钉子钉的是「今天的表现」，这个文件钉的是「1b 新加的表现」。
// 两者分文件：钉子响了说明我改坏了老行为，这里响了说明新功能没做对。
//
// ⚠ 名片解析从 ctx 注入（ctx.resolveEngineProfile / ctx.findLegacyDefaultId），
//   所以这里不读真的 engines/ 目录 —— 真名片体检在 realManifests 那份里。
//   规则测试与现状测试分家，业务调 max_chars 时这里不会无故变红。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const createSynthesisService = require('./synthesisService')
const { toPcm16Wav, computeSegmentBounds, wavDurationSec } = require('../audio/wav')

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

// 一张形状完整的名片（值是这个文件自己造的，不是真名片）。
function profile (over = {}) {
  return {
    id: 'engine-a',
    label: 'Engine A',
    dir: '/nowhere/engine-a',
    base_url: 'http://127.0.0.1:1111',
    base_url_source: 'manifest',
    timeout_ms: 111000,
    max_chars: 45,
    hard_max_chars: 90,
    requires_reference_audio: true,
    reference_clip_seconds: { min: 3, max: 10 },
    // ⭐⭐ 这里以前写的是引擎级的 hot_swap_models: true。
    //   换模型的送法现在写在**模型位**上：一台引擎完全可以两种位都有，
    //   一个引擎级的是非题答不了那种引擎。
    //   默认给一个「进程活着时一次调用就能换」的位 —— 等价于原来那个 true。
    weight_slots: [{ name: 'm', label: 'M', param: 'm_model', applies_at: 'call' }],
    output_sample_rate: 32000,
    supports_finetune: true,
    streaming: true,
    param_keys: [],
    ...over,
  }
}

function makeCtx (overrides = {}, engines = { 'engine-a': profile() }, legacyId = 'engine-a') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-1b-'))
  const refPath = path.join(root, 'ref.wav')
  fs.writeFileSync(refPath, makeWav(16000 * 5))   // 5 秒，落在 3–10 内

  const calls = { root, refPath, switchModels: [], generateOneSegment: [], meta: [], resolved: [] }

  const ctx = {
    fs,
    path,
    resolveEngineProfile: (id) => {
      calls.resolved.push(id)
      if (!engines[id]) { const e = new Error(`ENGINE_NOT_FOUND: ${id}`); throw e }
      return engines[id]
    },
    findLegacyDefaultId: () => legacyId,
    // ⚠ 第二个参数是「换给哪一台」。夹具必须收下它 —— 只收 cfg 的夹具会让
    //   「接线时忘了传引擎」在测试里长得和传了一模一样（实测漏过一次：
    //   1334 条全绿，前端一按生成就 500）。
    switchModels: async (cfg, engine) => { calls.switchModels.push({ cfg, engine }) },
    generateOneSegment: async (text, cfg, engine) => {
      calls.generateOneSegment.push({ text, cfg, engine })
      return makeWav(1600)
    },
    toPcm16Wav,
    computeSegmentBounds,
    wavDurationSec,
    // ⚠ 真实现是把结果**写到 out 路径**，不是 return —— 服务随后会 stat 它。
    // ⚠ 真实现把结果**写到 out 路径**（服务随后 stat 它），并返回 { method }。
    concatWavFiles: (files, out) => { fs.writeFileSync(out, makeWav(3200)); return { method: 'stub' } },
    splitJapaneseText: (text, opts) => {
      const { softLimit } = opts
      const out = []
      for (let i = 0; i < text.length; i += softLimit) out.push(text.slice(i, i + softLimit))
      calls.lastSoftLimit = softLimit
      calls.lastHardLimit = opts.hardLimit
      return out
    },
    loadVoices: () => ({ v1: { language: 'zh' } }),
    isBaseVoice: () => false,
    baseVoiceReg: () => null,
    resolveReference: () => ({ reference_audio: refPath, reference_text: '参考文本' }),
    buildTtsPayload: () => ({ ref_audio_path: refPath, prompt_text: '参考文本' }),
    newGenId: () => 'GENID',
    normSource: (s) => (s ? String(s) : 'generate'),
    genAssetDir: (genId) => path.join(root, genId),
    genBaseName: (p) => (p && typeof p === 'string' ? p.replace(/\\/g, '/').split('/').pop() : ''),
    writeGenMeta: (genId, meta) => { calls.meta.push({ genId, meta }) },
    resolveSeed: () => 123456,
    clientError: (err, fallback) => String((err && err.message) || fallback),
    withGenerationLock: (fn) => fn(),
    ...overrides,
  }
  return { ctx, calls }
}

// ⭐ 刀 2 之后每一次合成都必须点名引擎。这些用例大多不关心「哪一台」，
//   所以默认点名夹具里的那一台；关心的用例自己传 engine_id 覆盖。
const body = (extra = {}) => ({ voice: 'v1', text: '你好', engine_id: 'engine-a', ...extra })

// --------------------------------------------------------------------------
//  引擎跟着请求走
// --------------------------------------------------------------------------

test('⭐⭐⭐ 刀 2: 请求没带 engine_id ⇒ 400，⛔ 不再去 legacy_default 那台认领', async () => {
  // 这条过去断言的是反面：「没带 engine_id ⇒ 用 legacy_default 那台」。
  // 那正是 `tts failed` 的病根 —— web 前端从来不发 engine_id，于是界面上
  // 选哪台都没用，请求永远打到认领人身上。现在前端点名了，认领人拿掉。
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(
    () => generateService({ body: { voice: 'v1', text: '你好' } }),
    (e) => e.status === 400 && /engine_id/.test(e.message))
  assert.deepEqual(calls.resolved, [], '不该去解析任何引擎档案')
  assert.equal(calls.generateOneSegment.length, 0, '⛔ 一次推理都不该发生')
})

test('1b: 请求带了 engine_id ⇒ 用那一台，且档案原样传到 generateOneSegment', async () => {
  const engines = { 'engine-a': profile(), 'engine-b': profile({ id: 'engine-b', base_url: 'http://127.0.0.1:2222', timeout_ms: 222000 }) }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  // v4：明确点名了引擎，就必须同时带上那台引擎的参数格子。
  await generateService({ body: body({ engine_id: 'engine-b', engine_params: { 'engine-b': { x: 1 } } }) })
  assert.deepEqual(calls.resolved, ['engine-b'])
  const passed = calls.generateOneSegment[0].engine
  // ⭐ 这条就是「画布上选了引擎，请求真的打到那台」的证据：
  //    地址和超时必须来自被选中的名片，不是老路径那台。
  assert.equal(passed.base_url, 'http://127.0.0.1:2222')
  assert.equal(passed.timeout_ms, 222000)
})

test('1b: engine_id 指向没装的引擎 ⇒ 400，且一次引擎都没调用（不静默回落）', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(
    () => generateService({ body: body({ engine_id: 'not-installed' }) }),
    (e) => e.status === 400 && /Engine unavailable/.test(e.message) && /not-installed/.test(e.message),
  )
  assert.equal(calls.generateOneSegment.length, 0)
  assert.equal(calls.switchModels.length, 0)
})

test('1b: 分段的每一段都带着同一台引擎，不会中途换台', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ text: 'x'.repeat(100), max_chars: 10 }) })
  assert.ok(calls.generateOneSegment.length > 1)
  const ids = new Set(calls.generateOneSegment.map((c) => c.engine.id))
  assert.deepEqual([...ids], ['engine-a'])
})

// --------------------------------------------------------------------------
//  名片说了算：分段长度 / 换权重
// --------------------------------------------------------------------------

test('1b: 没传 max_chars ⇒ 用名片的 max_chars（⚠ 不是 splitJapaneseText 的 30）', async () => {
  const engines = { 'engine-a': profile({ max_chars: 45 }) }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ text: 'x'.repeat(200) }) })
  assert.equal(calls.lastSoftLimit, 45)
  assert.equal(calls.lastHardLimit, 90, 'hardLimit 恒为 softLimit 的两倍，与搬家前一致')
})

test('1b: 请求里的 max_chars 仍然压过名片（老行为不变）', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ text: 'x'.repeat(200), max_chars: 12 }) })
  assert.equal(calls.lastSoftLimit, 12)
})

test('1b: 一个「一次调用就能换」的位都没有 ⇒ 跳过换权重，但照样合成', async () => {
  // 只有「开进程那一步吃进去」的位（IndexTTS2 就是这样）。
  const engines = { 'engine-a': profile({
    weight_slots: [{ name: 'model', label: 'M', param: null, applies_at: 'launch' }],
  }) }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body() })
  assert.equal(res.ok, true)
  // ⛔ 不该去敲一个这台引擎根本没有的接口 —— 敲了会报错，
  //   而那个错长得像「合成失败」。
  assert.equal(calls.switchModels.length, 0)
  assert.equal(calls.generateOneSegment.length, 1)
})

test('1b: 一个位都没有（模型是写死的）⇒ 也跳过', async () => {
  const engines = { 'engine-a': profile({ weight_slots: [] }) }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  assert.equal((await generateService({ body: body() })).ok, true)
  assert.equal(calls.switchModels.length, 0)
})

test('1b: 有「一次调用就能换」的位 ⇒ 照旧换权重，且在第一段之前', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body() })
  assert.equal(calls.switchModels.length, 1)
})

test('⭐⭐⭐ 换权重必须点名「换给哪一台」——地址跟着这次的名片走', async () => {
  // 这条钉的是 2026-08-31 那个 500：换权重这一句只传了 cfg，没传引擎，
  // 于是 GSV 客户端拿不到 base_url，当场抛 ENGINE_BASE_URL_MISSING，
  // 前端只看得到 "Internal server error"，一声不出。
  // ⚠ 它当时躲过了 1334 条测试，因为没有一条看过这一句的第二个参数。
  const engines = {
    'engine-a': profile(),
    'engine-b': profile({ id: 'engine-b', base_url: 'http://127.0.0.1:2222', timeout_ms: 222000 }),
  }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ engine_id: 'engine-b', engine_params: { 'engine-b': { x: 1 } } }) })
  assert.equal(calls.switchModels.length, 1)
  const engine = calls.switchModels[0].engine
  assert.ok(engine, '⛔ 第二个参数不能是 undefined —— 那正是 500 的原样')
  // ⭐ 换权重和推理必须打到同一台，⛔ 不许一个带地址一个不带。
  assert.equal(engine.base_url, 'http://127.0.0.1:2222')
  assert.equal(engine.timeout_ms, 222000)
  assert.equal(engine.id, calls.generateOneSegment[0].engine.id)
})

test('⭐⭐⭐ 1b: 有「开进程那一步吃进去」的位 ⇒ 先让看管人带着它把引擎备好', async () => {
  // ⛔ 这条钉的就是这一刀要修的那个 bug：以前这一整类位被跳过，
  //   表现是下拉能选、后端连"你选过"都看不见、声音没变、而且不报错。
  const engines = { 'engine-a': profile({
    weight_slots: [{ name: 'model', label: 'M', param: null, applies_at: 'launch' }],
  }) }
  const seen = []
  const busy = []
  const sup = {
    ensure: async (p, sel) => { seen.push({ id: p.id, sel }); return { action: 'start' } },
    markBusy: (id, b) => busy.push([id, b]),
  }
  const { ctx, calls } = makeCtx({ engineSupervisor: sup }, engines)
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ launch_weights: { model: '/p/picked' } }) })

  assert.equal(seen.length, 1, '看管人没被叫到 ⇒ 选中的模型一步都走不到引擎')
  assert.equal(seen[0].id, 'engine-a')
  assert.deepEqual(seen[0].sel, { model: '/p/picked' },
    '选择没传给看管人 ⇒ 引擎会带着底模重开，声音还是不对，而且不报错')
  assert.equal(calls.generateOneSegment.length, 1)

  // ⭐⭐ 合成期间必须标「正在忙」，而且**收尾必须清掉**。
  //   不标 ⇒ 定时清扫会把一台算得慢的引擎当成空闲放掉，合成当场失败。
  //   不清 ⇒ 这台引擎从此永不释放，"用完就放"整个白做。
  assert.deepEqual(busy, [['engine-a', true], ['engine-a', false]])
})

test('⛔ 1b: 合成失败也要把「正在忙」清掉（否则这台引擎再也放不掉）', async () => {
  const engines = { 'engine-a': profile({
    weight_slots: [{ name: 'model', label: 'M', param: null, applies_at: 'launch' }],
  }) }
  const busy = []
  const sup = {
    ensure: async () => ({ action: 'reuse' }),
    markBusy: (id, b) => busy.push([id, b]),
  }
  const { ctx } = makeCtx({
    engineSupervisor: sup,
    generateOneSegment: async () => { throw new Error('引擎炸了') },
  }, engines)
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(() => generateService({ body: body() }))
  assert.deepEqual(busy, [['engine-a', true], ['engine-a', false]])
})

test('1b: 没有「开进程那一步吃进去」的位 ⇒ 不去惊动看管人', async () => {
  const seen = []
  const sup = { ensure: async () => { seen.push(1); return { action: 'reuse' } }, markBusy: () => {} }
  const { ctx } = makeCtx({ engineSupervisor: sup })   // 默认夹具只有 call 位
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body() })
  assert.equal(seen.length, 0)
})

test('1b: 没装看管人 ⇒ 照常合成，⛔ 不把接线缺失表现成「合成失败」', async () => {
  const engines = { 'engine-a': profile({
    weight_slots: [{ name: 'model', label: 'M', param: null, applies_at: 'launch' }],
  }) }
  const { ctx, calls } = makeCtx({}, engines)   // ctx 里没有 engineSupervisor
  const { generateService } = createSynthesisService(ctx)
  assert.equal((await generateService({ body: body() })).ok, true)
  assert.equal(calls.generateOneSegment.length, 1)
})

// --------------------------------------------------------------------------
//  开跑前点料 —— 只点「在不在」，绝不点「对不对」
// --------------------------------------------------------------------------

test('1b: 名片 requires_reference_audio=false ⇒ 没有参考音频也放行', async () => {
  const engines = { 'engine-a': profile({ requires_reference_audio: false, reference_clip_seconds: null }) }
  const { ctx, calls } = makeCtx({ resolveReference: () => ({ reference_audio: '', reference_text: '' }) }, engines)
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body() })
  assert.equal(res.ok, true)
  assert.equal(calls.generateOneSegment.length, 1)
})

test('1b: 时长窗口来自名片，不是写死的 3–10', async () => {
  // 5 秒的参考音频，对 6–20 秒窗口的引擎来说太短。
  const engines = { 'engine-a': profile({ reference_clip_seconds: { min: 6, max: 20 } }) }
  const { ctx } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(
    () => generateService({ body: body() }),
    (e) => e.status === 400 && /requires a 6–20s reference clip/.test(e.message),
  )
})

test('1b: 名片 reference_clip_seconds=null ⇒ 不检查时长（任何长度放行）', async () => {
  const engines = { 'engine-a': profile({ reference_clip_seconds: null }) }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body() })
  assert.equal(calls.generateOneSegment.length, 1)
})

// --------------------------------------------------------------------------
//  硬校验之二：参数格子非空
// --------------------------------------------------------------------------
//
// ⛔⭐ 这一组测试是重写过的。原来的五条断言的是名片键 `requires_engine_params`，
//    而 profile.js **从来没有生产过这个键** —— 真机上恒为 undefined，整条检查
//    一次都没跑过。测试之所以全绿，是因为它们把 `profile({requires_engine_params:
//    true})` 这个**假名片对象**直接塞进 ctx，绕过了 profile.js。假名片让测试和
//    突变验证同时失明。
//
//    所以下面每一条都补了一个前置断言：**真实 profile.js 造出来的名片里，
//    根本没有这个键**。这样同一个错误再犯一次，会当场响。
//
// 新规则不依赖任何名片声明：请求点名了 engine_id ⇒ 那台的格子必须非空。

const { resolveEngineProfile: realResolve } = require('../engines/profile')

test('⚠ 防复发：真实名片里没有 requires_engine_params 这个键（幻影键守卫）', () => {
  // 这条钉子的作用是：如果将来又有人想靠「名片里先声明、以后再接线」来做
  // 校验，他会先在这里撞一下墙 —— 要么真的把键接进 profile.js 的输出，
  // 要么就别在别处 if 它。
  // ⭐⭐⭐ 刀 A1（2026-08-31）：这里过去是
  //     realResolve(require('../engines/legacyDefault').findLegacyDefaultId())
  //   整句包在 try 里 ⇒ 模块删掉之后它**不会红，只会静静地变成 null**，
  //   然后下面的 if 一辈子不进去 —— 这条守卫会活着但什么都不守。
  //   ⭐ 这就是「半份守卫比没有守卫更坏」：它还在测试清单里占着一行绿。
  //   ⇒ 改成扫**盘上每一台**引擎，顺带把覆盖面从 1 台扩到 N 台。
  const { listEngines } = require('../engines/registry')
  const list = listEngines()
  assert.ok(list.length > 0, '这条守卫需要盘上至少装着一台引擎才有意义')
  let checked = 0
  for (const m of list) {
    let real = null
    try { real = realResolve(m.id) } catch (_) { continue }   // 名片本身坏了，归别的测试管
    checked++
    assert.equal(Object.prototype.hasOwnProperty.call(real, 'requires_engine_params'), false,
      `profile.js 现在给 ${m.id} 生产 requires_engine_params 了 —— 要么接线，要么删掉引用它的代码`)
  }
  assert.ok(checked > 0, '一台名片都解析不出来 —— 这条守卫又变成空转了')
})

test('⭐⭐ 刀 2: 点名了引擎、一格参数都没带 ⇒ 放行（「没有参数」是一台合法的引擎）', async () => {
  // 这两条过去断言的是反面：「点名了就必须带非空的那一格」。那条规则里藏着
  // 一句只对某几台引擎为真的话 ——「一台引擎一定有参数可调」。名片
  // params.schema 为空的引擎会被它打成 400，而它什么也没做错。
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ engine_id: 'engine-a' }) })
  assert.equal(res.ok, true)
  assert.equal(calls.generateOneSegment.length, 1)
})

test('⭐⭐ 刀 2: 那格存在但是空对象 ⇒ 也放行（空格子 = 没有参数，不是错误）', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ engine_id: 'engine-a', engine_params: { 'engine-a': {} } }) })
  assert.equal(res.ok, true)
  assert.equal(calls.generateOneSegment.length, 1)
})

test('v4: 那格非空就放行 —— ⛔ 里面的键名和值一个都不检查', async () => {
  const engines = { 'engine-a': profile({ param_keys: ['known_key'] }) }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  // 故意塞一个名片里根本没有的键、一个明显离谱的值。平台照样放行：
  // 参数对不对是引擎自己的事，平台判不了，硬判只会得到一个恒常误报、
  // 然后被所有人忽略的检查。
  const res = await generateService({ body: body({ engine_id: 'engine-a', engine_params: { 'engine-a': { 完全没听说过的键: -999 } } }) })
  assert.equal(res.ok, true)
  assert.equal(calls.generateOneSegment.length, 1)
})

test('v4: 别的引擎那格填了，自己这格空着 ⇒ 仍然 400（不串格）', async () => {
  const { ctx } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(
    () => generateService({ body: body({ engine_id: 'engine-a', engine_params: { 'engine-b': { x: 1 } } }) }),
    (e) => e.status === 400,
  )
})

test('⭐⭐⭐ 刀 2: 带的是别台引擎的参数格子 ⇒ 400，且报错要点名那袋参数是谁的', async () => {
  // 这是「格子非空」那条规则真正想守住的东西，而且守得更准：
  // 界面按 A 画格子、请求点名 B —— 这正是错配。⛔ 一次推理都不许发生。
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(
    () => generateService({ body: body({ engine_id: 'engine-a', engine_params: { 'engine-b': { x: 1 } } }) }),
    (e) => e.status === 400 && /engine-a/.test(e.message) && /engine-b/.test(e.message))
  assert.equal(calls.generateOneSegment.length, 0)
})

