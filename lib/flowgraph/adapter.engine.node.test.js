'use strict'

// ===========================================================================
//  工作流适配器 · 引擎必须真的跟着请求走（契约 v2 第 1b 步）
// ===========================================================================
// ⭐ 这个文件存在的理由，是一个真实存在过的病：
//    adapter.js 校验完 engine_id 之后**把它丢了** —— 组装 body 时不带它。
//    于是画布上无论选哪台引擎，请求都发到老路径那台（9880）。
//    「工作流做不起来」的病根就是这里。下面第一条测试就是那颗钉子。

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createSynthesizeAdapter } = require('./adapter')

// 记录 generateService 收到的 body，不真的合成。
function spy (result = { ok: true, id: 'G1', audio_url: '/outputs/generate/G1/audio.wav' }) {
  const bodies = []
  const fn = async ({ body }) => { bodies.push(body); return result }
  return { fn, bodies }
}

test('1b: engine 节点选了哪台，body 里就必须带哪台的 engine_id', async () => {
  const { fn, bodies } = spy()
  const synthesize = createSynthesizeAdapter(fn, { defaultVoice: 'v1' })
  await synthesize({ text: '你好', engine: { engine_id: 'indextts2', voice: 'v1' } })
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].engine_id, 'indextts2',
    'engine_id 丢在半路 = 画布上选任何引擎都打到同一台，且不报错')
})

test('1b: engine 节点没写 engine_id ⇒ 落到 legacy_default 那台，不是硬编码的名字', async () => {
  const { fn, bodies } = spy()
  const synthesize = createSynthesizeAdapter(fn, { defaultVoice: 'v1' })
  await synthesize({ text: '你好', engine: { voice: 'v1' } })
  // 具体是哪台由名片上的 legacy_default 决定（今天是 gpt-sovits）。
  // 这里只断言「有值、非空」—— 断言具体名字会让换认领人时无故变红。
  assert.equal(typeof bodies[0].engine_id, 'string')
  assert.ok(bodies[0].engine_id.length > 0)
})

test('1b: 引擎参数同时按引擎分格挂一份，供开跑前点料', async () => {
  const { fn, bodies } = spy()
  const synthesize = createSynthesizeAdapter(fn, { defaultVoice: 'v1' })
  await synthesize({
    text: '你好',
    engine: { engine_id: 'gpt-sovits', voice: 'v1' },
    engine_params: { top_k: 12 },
  })
  const b = bodies[0]
  // 平铺那份照旧（老路径读它），分格那份是新加的，两份同源。
  assert.equal(b.top_k, 12)
  assert.deepEqual(b.engine_params, { 'gpt-sovits': { top_k: 12 } })
})

test('1b: 没装的引擎仍然是 FG_ENGINE_UNSUPPORTED，错误码对外不变', async () => {
  const { fn, bodies } = spy()
  const synthesize = createSynthesizeAdapter(fn, { defaultVoice: 'v1' })
  await assert.rejects(
    () => synthesize({ text: '你好', engine: { engine_id: 'no-such-engine', voice: 'v1' } }),
    (e) => e.code === 'FG_ENGINE_UNSUPPORTED',
  )
  assert.equal(bodies.length, 0, '没装就不该走到合成')
})

test('1b: split/concat 仍然是 false（一个节点一句话，平台不许背着画布再切）', async () => {
  const { fn, bodies } = spy()
  const synthesize = createSynthesizeAdapter(fn, { defaultVoice: 'v1' })
  await synthesize({ text: '你好', engine: { engine_id: 'gpt-sovits', voice: 'v1' } })
  assert.equal(bodies[0].split, false)
  assert.equal(bodies[0].concat, false)
})

// -- 第 2 步：平台自留键 -------------------------------------------------------
// 画布不再给 split/concat/format 格子（service.js 隐了它们），但手改过的图
// 还是能带着它们进来。那时候必须是平台说了算。

test('2: 图里带了 split=true 也不算数 —— 一个节点仍然只出一段', async () => {
  const { fn, bodies } = spy()
  const synthesize = createSynthesizeAdapter(fn, { defaultVoice: 'v1' })
  await synthesize({
    text: '你好',
    engine: { engine_id: 'gpt-sovits', voice: 'v1' },
    engine_params: { split: true, concat: true, format: 'mp3', top_k: 12 },
  })
  const b = bodies[0]
  assert.equal(b.split, false, '让图把 split 改回 true = broker 在背后再切一刀，循环次数不再对得上实际出了几段')
  assert.equal(b.concat, false)
  assert.equal(b.format, 'wav')
  assert.equal(b.top_k, 12, '只拦自留键，不能顺手把别的参数一起丢了')
  assert.deepEqual(b.engine_params, { 'gpt-sovits': { top_k: 12 } },
    '分格那份也不能漏出自留键')
})

test('2: 自留键不算「拼错了」，不能拿 FG_ENGINE_PARAM_UNKNOWN 把老图拦死', async () => {
  const { fn, bodies } = spy()
  const synthesize = createSynthesizeAdapter(fn, { defaultVoice: 'v1' })
  await synthesize({
    text: '你好',
    engine: { engine_id: 'indextts2', voice: 'v1' },
    engine_params: { format: 'wav' },
  })
  assert.equal(bodies.length, 1)
})
