'use strict'

// ===========================================================================
//  recipe v4 读时视图 —— 老配方不改一个字节，读出来就是新形状
// ===========================================================================

const test = require('node:test')
const assert = require('node:assert/strict')

const { toV4, flatParams } = require('./recipeView')

const v3 = () => ({
  schema_version: 3,
  id: 'alice/calm',
  reference_audio: { base: 'asset', path: 'alice/ref.wav' },
  reference_text: '参考文本',
  language: 'all_ja',
  params: {
    speed: 1.2, seed: 42,
    top_k: 15, top_p: 1, temperature: 1, text_split_method: 'cut5',
    batch_size: 4, pron_overrides: { 重: 'zhong4' },
  },
})

// --------------------------------------------------------------------------
//  老配方自动变成「绑在老路径引擎上的闭合调用单元」
// --------------------------------------------------------------------------

test('v3 配方读出来 engine_id = 老路径引擎（不是空、不是猜的）', () => {
  const v = toV4(v3(), 'gpt-sovits')
  assert.equal(v.engine_id, 'gpt-sovits')
  assert.equal(v.schema_version, 3)
})

test('⭐ 视图是纯函数：磁盘上的对象一个字段都没被改过', () => {
  const rec = v3()
  const snapshot = JSON.stringify(rec)
  const v = toV4(rec, 'gpt-sovits')
  // 改视图返回的格子，不能反噬原对象（必须是拷贝，不是引用）
  v.box.top_k = 999
  v.params.speed = 999
  assert.equal(JSON.stringify(rec), snapshot,
    '读时视图污染了原配方 —— 那就等于偷偷迁移了用户数据')
})

test('v3 的私有参数原样落进本引擎格子，一个都不丢', () => {
  const v = toV4(v3(), 'gpt-sovits')
  const box = v.engine_params['gpt-sovits']
  assert.equal(box.top_k, 15)
  assert.equal(box.text_split_method, 'cut5')
  assert.equal(box.batch_size, 4)
  assert.deepEqual(box.pron_overrides, { 重: 'zhong4' })
})

test('通用格子只装 speed / seed —— 平台自己要读的那两个', () => {
  const v = toV4(v3(), 'gpt-sovits')
  assert.deepEqual(Object.keys(v.params).sort(), ['seed', 'speed'])
  assert.equal(v.params.speed, 1.2)
  assert.equal(v.params.seed, 42)
  // ⭐ speed 之所以通用，是因为我查过的 6 台引擎它 6/6 全中；
  //    seed 只有 3/6，留在通用格子是因为**平台自己**要用它做 Rerun 复现。
  assert.equal(v.params.top_k, undefined, 'top_k 是引擎私有的，不该出现在通用格子')
})

test('⭐ 合成平表后，形状与 v3 的 recipe.params 完全一致（老读法一个字不用改）', () => {
  const rec = v3()
  const flat = flatParams(toV4(rec, 'gpt-sovits'))
  for (const [k, val] of Object.entries(rec.params)) {
    assert.deepEqual(flat[k], val, `平表丢了 v3 的 ${k}`)
  }
})

// --------------------------------------------------------------------------
//  v4 配方
// --------------------------------------------------------------------------

test('v4 配方 engine_id 用自己的，不被老路径引擎盖掉', () => {
  const v = toV4({ schema_version: 4, engine_id: 'indextts2', params: {}, engine_params: { indextts2: { emo_alpha: 0.8 } } }, 'gpt-sovits')
  assert.equal(v.engine_id, 'indextts2')
  assert.deepEqual(v.box, { emo_alpha: 0.8 })
})

test('多台引擎的格子互不串味 —— box 只取自己那格', () => {
  const v = toV4({
    schema_version: 4, engine_id: 'engine-b',
    engine_params: { 'engine-a': { x: 1 }, 'engine-b': { y: 2 } },
  }, 'gpt-sovits')
  assert.deepEqual(v.box, { y: 2 })
  assert.equal(v.box.x, undefined)
})

test('v4 显式写的值压过 v3 老值（不被历史回填覆盖）', () => {
  const v = toV4({
    schema_version: 3, engine_id: 'gpt-sovits',
    params: { top_k: 15 },
    engine_params: { 'gpt-sovits': { top_k: 99 } },
  }, 'gpt-sovits')
  assert.equal(v.box.top_k, 99)
})

test('_unassigned 占位格在解析出真实引擎后并回去（存进来到读出去这一段的临时态）', () => {
  const v = toV4({
    schema_version: 4, engine_id: 'indextts2',
    engine_params: { _unassigned: { emo_alpha: 0.8 } },
  }, 'gpt-sovits')
  assert.equal(v.box.emo_alpha, 0.8)
  assert.equal(v.engine_params._unassigned, undefined, '占位格没被清掉，会一直挂在配方上')
})

// --------------------------------------------------------------------------
//  烂输入不能炸
// --------------------------------------------------------------------------

test('空 / null / 缺字段的配方不抛异常', () => {
  for (const bad of [null, undefined, {}, { params: null }, { engine_params: 'nope' }, { engine_params: { a: 5 } }]) {
    const v = toV4(bad, 'gpt-sovits')
    assert.equal(v.engine_id, 'gpt-sovits')
    assert.deepEqual(v.box, {})
  }
})

test('⛔ 视图文件里不许出现任何具体引擎的名字（平台不认识引擎）', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'recipeView.js'), 'utf8')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const name of ['gpt-sovits', 'gpt_sovits', 'indextts2', 'GPT-SoVITS', 'IndexTTS']) {
    assert.equal(code.includes(name), false, `recipeView.js 的代码里写死了引擎名 ${name}`)
  }
})
