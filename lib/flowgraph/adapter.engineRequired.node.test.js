'use strict'

// ===========================================================================
//  flow 画布 · 引擎节点必须选引擎（契约 §12 第 2 步 · 刀 1 第 ③ 条）
// ===========================================================================
// Owner 2026-08-28 拍板：「必须带引擎 id 这个字段，不然 400，因为要走 broker，
// 没有 id 不好管理。」broker 那一半（/v1/audio/speech）已经落地；这里是另一半。
//
// ⭐ 这一刀删掉的东西：`engine.engine_id || legacyDefaultId()`。
//    它不是硬编码（第 1b 步已经把引擎名赶出 lib/ 了），它是**回落**：
//    画布上一张忘了选引擎的图会安安静静地出声，声音来自你没指定过的那台。
//    「跑通了」和「跑对了」在这里长得一模一样 —— 这正是必须用测试而不是
//    用肉眼把它钉死的原因。
//
// ⛔ 关卡为什么设在 adapter 而不是 io.engine 节点的 handler：
//    一个 io.engine 节点未必通向合成。engine.node.test.js 里有一张图只拿它
//    喂 sys.release（释放显存），那张图不合成任何东西，凭什么要求它选引擎。
//    关卡设在真正要挑引擎的那一层，不设在拿着它的每个人身上。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createSynthesizeAdapter } = require('./adapter')

// 记录 generateService 收到的 body，不真的合成。
function spy (result = { ok: true, id: 'G1', audio_url: '/outputs/generate/G1/audio.wav' }) {
  const bodies = []
  const fn = async ({ body }) => { bodies.push(body); return result }
  return { fn, bodies }
}

const mk = (fn) => createSynthesizeAdapter(fn, { defaultVoice: 'v1' })

// ---------------------------------------------------------------------------
//  一、缺 engine_id 的每一种长相，都要抛，且都不许出声
// ---------------------------------------------------------------------------
// 「不许出声」这半句和「要抛」同样重要：一个抛在合成之后的错误，用户已经
// 付出了 GPU 时间、盘上已经多了一个文件。

test('1: engine 里没有 engine_id ⇒ FG_ENGINE_ID_MISSING，且没走到合成', async () => {
  const { fn, bodies } = spy()
  await assert.rejects(
    () => mk(fn)({ text: '你好', engine: { voice: 'v1' } }),
    (e) => e.code === 'FG_ENGINE_ID_MISSING',
  )
  assert.equal(bodies.length, 0, '出了声才报错等于没报错')
})

test('2: engine_id 是 null ⇒ 同样抛（io.engine 节点的默认值就是 null）', async () => {
  const { fn, bodies } = spy()
  await assert.rejects(
    () => mk(fn)({ text: '你好', engine: { engine_id: null, voice: 'v1' } }),
    (e) => e.code === 'FG_ENGINE_ID_MISSING',
  )
  assert.equal(bodies.length, 0)
})

test('3: engine_id 是空字符串 ⇒ 同样抛（前端把下拉框清空最常见的形状）', async () => {
  const { fn, bodies } = spy()
  await assert.rejects(
    () => mk(fn)({ text: '你好', engine: { engine_id: '', voice: 'v1' } }),
    (e) => e.code === 'FG_ENGINE_ID_MISSING',
  )
  assert.equal(bodies.length, 0)
})

test('4: 整个 engine 对象都没有 ⇒ 抛的仍是 FG_ENGINE_ID_MISSING，不是 TypeError', async () => {
  // adapter 里 `request.engine || {}` 那一句负责这条。读不到属性时崩出一个
  // "Cannot read properties of undefined" 对用户毫无用处。
  const { fn, bodies } = spy()
  await assert.rejects(
    () => mk(fn)({ text: '你好' }),
    (e) => e.code === 'FG_ENGINE_ID_MISSING',
  )
  assert.equal(bodies.length, 0)
})

// ---------------------------------------------------------------------------
//  二、报错本身要能把人送到下一步
// ---------------------------------------------------------------------------

test('5: 报错点名 engine_id，并指路 GET /api/engines', async () => {
  const { fn } = spy()
  const err = await mk(fn)({ text: '你好', engine: {} }).catch((e) => e)
  assert.match(err.message, /engine_id/,
    '不说字段名，用户不知道该去填哪一格')
  assert.match(err.message, /\/api\/engines/,
    '第 ① 条刚做出来的那张清单，就是这条报错的下一步；不指路等于让人自己猜')
})

test('6: ⛔ 报错里不许出现任何具体引擎名（契约 §6：lib/ 里不出现引擎名）', async () => {
  const { fn } = spy()
  const err = await mk(fn)({ text: '你好', engine: {} }).catch((e) => e)
  for (const banned of ['gpt-sovits', 'GPT-SoVITS', 'indextts', 'sovits', '9880']) {
    assert.ok(!err.message.toLowerCase().includes(banned.toLowerCase()),
      `报错里写了 ${banned} —— 一句「比如用 gpt-sovits」就把默认值又请回来了，` +
      '只不过这次藏在文案里')
  }
})

// ---------------------------------------------------------------------------
//  三、⭐ 爆炸半径：这一刀**不许**改变的报错
// ---------------------------------------------------------------------------
// 新加一道检查最容易犯的错，是它抢在别的检查前面，把一个本来说得很准的
// 报错换成一个更笼统的。下面四条钉住「谁先谁后」。

test('7: 没装的引擎仍是 FG_ENGINE_UNSUPPORTED —— 新检查没抢它的话', async () => {
  const { fn, bodies } = spy()
  await assert.rejects(
    () => mk(fn)({ text: '你好', engine: { engine_id: 'no-such-engine', voice: 'v1' } }),
    (e) => e.code === 'FG_ENGINE_UNSUPPORTED',
  )
  assert.equal(bodies.length, 0)
})

test('8: 选了引擎但没选音色，仍是 FG_ENGINE_NO_VOICE', async () => {
  const { fn } = spy()
  const synthesize = createSynthesizeAdapter(fn, {}) // ⚠ 不给 defaultVoice
  await assert.rejects(
    () => synthesize({ text: '你好', engine: { engine_id: 'gpt-sovits' } }),
    (e) => e.code === 'FG_ENGINE_NO_VOICE',
  )
})

test('9: 选了引擎但文字是空的，仍是 FG_SYNTHESIZE_EMPTY_TEXT', async () => {
  const { fn } = spy()
  await assert.rejects(
    () => mk(fn)({ text: '   ', engine: { engine_id: 'gpt-sovits', voice: 'v1' } }),
    (e) => e.code === 'FG_SYNTHESIZE_EMPTY_TEXT',
  )
})

test('10: 引擎和音色都没选 ⇒ 先报引擎（一次说一件事，且这件在前）', async () => {
  const { fn } = spy()
  const synthesize = createSynthesizeAdapter(fn, {})
  await assert.rejects(
    () => synthesize({ text: '你好', engine: {} }),
    (e) => e.code === 'FG_ENGINE_ID_MISSING',
  )
  // 为什么是这个顺序而不是反过来：音色是**属于某台引擎**的，
  // 「你没选音色」在还不知道是哪台引擎的时候是句没法执行的建议。
})

// ---------------------------------------------------------------------------
//  四、选了引擎的路照走不误（别把功能一起砍了）
// ---------------------------------------------------------------------------

test('11: 选了引擎 ⇒ 正常合成，body 带着那台的 engine_id', async () => {
  const { fn, bodies } = spy()
  const out = await mk(fn)({ text: '你好', engine: { engine_id: 'indextts2', voice: 'v1' } })
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].engine_id, 'indextts2')
  assert.equal(out.kind, 'audio')
})

test('12: recipe 里仍然记着 engine_id —— 画布上的一段音频要能自述来历', async () => {
  const { fn } = spy()
  const out = await mk(fn)({ text: '你好', engine: { engine_id: 'gpt-sovits', voice: 'v1' } })
  assert.equal(out.recipe.engine_id, 'gpt-sovits')
})

test('13: engine_params 仍按引擎分格挂（synthesisService 那道非空校验靠它）', async () => {
  // ⚠ 这条不只是回归：services/synthesisService.js 里有一条规则是
  //   「凡是带了 engine_id 的调用，必须同时带那台引擎的 engine_params」。
  //   flow 现在**每次**都带 engine_id 了 ⇒ flow 也就每次都要过那道校验。
  const { fn, bodies } = spy()
  await mk(fn)({
    text: '你好',
    engine: { engine_id: 'gpt-sovits', voice: 'v1' },
    engine_params: { top_k: 12 },
  })
  assert.deepEqual(bodies[0].engine_params, { 'gpt-sovits': { top_k: 12 } })
})

// ---------------------------------------------------------------------------
//  五、⭐ 源码级：证明回落是**真的没了**，而不是碰巧没走到
// ---------------------------------------------------------------------------
// 行为测试只能证明「我试过的那几条路上没有回落」。回落是不是真的从代码里
// 消失了，得直接看代码。第 ② 刀就是靠这两条抓住「删了一处、漏了两处」的。

const SRC = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8')
const codeLines = (src) => src.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))   // 去掉注释行

test('14: ⭐ adapter.js 不再 require engines/legacyDefault', async () => {
  const live = codeLines(SRC('adapter.js'))
  const hits = live.filter((l) => /require\(['"]\.\.\/engines\/legacyDefault['"]\)/.test(l))
  assert.equal(hits.length, 0,
    'import 还在 = 回落随时能被一行加回来，而且没人会注意到：\n' + hits.join('\n'))
})

test('15: ⭐ adapter.js 里没有 `engine_id || 某个默认` 形状的回落', async () => {
  const live = codeLines(SRC('adapter.js'))
  const hits = live.filter((l) => /engine_id\s*\|\|/.test(l))
  assert.equal(hits.length, 0,
    '`engine_id ||` 这个形状就是回落本身，右边是什么都一样：\n' + hits.join('\n'))
})

test('16: nodes.js 的默认值仍是 null —— ⛔ 没有为了让测试变绿而写死一台', async () => {
  const live = codeLines(SRC('nodes.js'))
  const decl = live.filter((l) => /params:\s*\{\s*engine_id:/.test(l))
  assert.equal(decl.length, 1, 'io.engine 的 params 声明应当只有一处')
  assert.match(decl[0], /engine_id:\s*null/,
    '默认值一旦变成某台引擎的名字，这一刀就白做了 —— 回落只是从 adapter 挪到了这里')
})

test('17: docs.js 的帮助文案不再说「留空就用默认引擎」', async () => {
  const src = SRC('docs.js')
  assert.ok(!/留空表示用服务器的默认引擎/.test(src),
    '文案还在教用户留空 —— 代码改了、说明书没改，比两边都没改更坑人')
  assert.ok(!/leaving it empty uses the default engine/i.test(src),
    '英文那句同上（改中文忘改英文是这个文件的常见漏法）')
})
