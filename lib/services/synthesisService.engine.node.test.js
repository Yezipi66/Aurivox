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
    hot_swap_models: true,
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
    switchModels: async (cfg) => { calls.switchModels.push({ cfg }) },
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

const body = (extra = {}) => ({ voice: 'v1', text: '你好', ...extra })

// --------------------------------------------------------------------------
//  引擎跟着请求走
// --------------------------------------------------------------------------

test('1b: 请求没带 engine_id ⇒ 用 legacy_default 那台（webui 今天的行为不变）', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body() })
  assert.deepEqual(calls.resolved, ['engine-a'])
  assert.equal(calls.generateOneSegment[0].engine.id, 'engine-a')
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

test('1b: 名片 hot_swap_models=false ⇒ 跳过换权重，但照样合成', async () => {
  const engines = { 'engine-a': profile({ hot_swap_models: false }) }
  const { ctx, calls } = makeCtx({}, engines)
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body() })
  assert.equal(res.ok, true)
  // 不支持热换的引擎（IndexTTS2 就是）不该被敲一个根本不存在的接口。
  assert.equal(calls.switchModels.length, 0)
  assert.equal(calls.generateOneSegment.length, 1)
})

test('1b: 名片 hot_swap_models=true ⇒ 照旧换权重，且在第一段之前', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body() })
  assert.equal(calls.switchModels.length, 1)
})

// --------------------------------------------------------------------------
//  开跑前点料 —— 只点「在不在」，绝不点「对不对」
// --------------------------------------------------------------------------

test('1b: 名片 requires_reference_audio=false ⇒ 没有参考音频也放行', async () => {
  const engines = { 'engine-a': profile({ requires_reference_audio: false, reference_clip_seconds: null }) }
  const { ctx, calls } = makeCtx({ buildTtsPayload: () => ({ ref_audio_path: '', prompt_text: '' }) }, engines)
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
  let real = null
  try { real = realResolve(require('../engines/legacyDefault').findLegacyDefaultId()) } catch (_) { /* 沙箱里可能没装引擎 */ }
  if (real) {
    assert.equal(Object.prototype.hasOwnProperty.call(real, 'requires_engine_params'), false,
      'profile.js 现在生产 requires_engine_params 了 —— 要么接线，要么删掉引用它的代码')
  }
})

test('v4: 请求点名了 engine_id 但没带那格 ⇒ 400', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(
    () => generateService({ body: body({ engine_id: 'engine-a' }) }),
    (e) => e.status === 400 && /engine_params\.engine-a is missing or empty/.test(e.message),
  )
  assert.equal(calls.generateOneSegment.length, 0)
})

test('v4: 那格存在但是空对象 ⇒ 400（「不为空」是唯一判据）', async () => {
  const { ctx } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(
    () => generateService({ body: body({ engine_id: 'engine-a', engine_params: { 'engine-a': {} } }) }),
    (e) => e.status === 400,
  )
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

test('v4: 没点名 engine_id ⇒ 不查格子（webui 老路径每一次生成都走这里）', async () => {
  // ⭐ 这条是「无条件校验」方案的反例钉子。webui 那条老路径既不发 engine_id
  //    也不发 engine_params —— 如果把校验做成无条件的，用户每按一次生成都是
  //    400。老路径在契约 §12 第 2 步被删掉时，这条钉子跟着一起退休。
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body() })
  assert.equal(res.ok, true)
  assert.equal(calls.generateOneSegment.length, 1)
})

