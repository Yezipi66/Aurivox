'use strict'

// ===========================================================================
//  recipeStore v4 —— engine_id / engine_params，以及堵住「静默吃键」
// ===========================================================================
//
// ⚠ recipeStore.js 在这一刀之前**一个测试都没有**，而它是配方唯一的写入口。
//   下面这组先把 v4 的新行为钉住，同时补上 v3 时代就该有的那条：
//   保存成功了、值却没了，是最恶劣的失败形式。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createRecipeStore } = require('./recipeStore')

function store () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-recipes-'))
  return createRecipeStore(dir)
}

const base = (extra = {}) => Object.assign({
  role: 'alice', name: 'calm',
  reference_audio: 'assets/alice/ref.wav',
  reference_text: '参考文本',
}, extra)

// --------------------------------------------------------------------------
//  新存的配方是 v4
// --------------------------------------------------------------------------

test('v4: 新配方 schema_version = 4', () => {
  const r = store().create(base())
  assert.equal(r.ok, true, r.error)
  assert.equal(r.recipe.schema_version, 4)
})

test('v4: engine_id 存得进、读得出', () => {
  const r = store().create(base({ engine_id: 'indextts2' }))
  assert.equal(r.ok, true, r.error)
  assert.equal(r.recipe.engine_id, 'indextts2')
})

test('v4: 不填 engine_id ⇒ 空字符串（含义是「老路径引擎」，由调用层解析）', () => {
  const r = store().create(base())
  assert.equal(r.recipe.engine_id, '')
})

test('v4: engine_id 形状不合法 ⇒ 报错，不静默吞', () => {
  for (const bad of ['has space', 'a/b', '../x', 'x;y']) {
    const r = store().create(base({ engine_id: bad }))
    assert.equal(r.ok, false, `engine_id "${bad}" 被放行了`)
  }
  assert.equal(store().create(base({ engine_id: 123 })).ok, false)
})

// --------------------------------------------------------------------------
//  engine_params：原样存、原样取
// --------------------------------------------------------------------------

test('⭐ v4: engine_params 原样存原样取 —— 键名、值、嵌套一个都不改', () => {
  const box = {
    emo_alpha: 0.8,
    完全没听说过的键: -999,
    nested: { a: [1, 2, { b: null }] },
    'weird.key-name': 'ok',
    zero: 0, empty: '', no: false,
  }
  const r = store().create(base({ engine_id: 'indextts2', engine_params: { indextts2: box } }))
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.recipe.engine_params.indextts2, box)
})

test('v4: engine_params 形状错（值不是对象）⇒ 报错', () => {
  // 形状是唯一校验的东西：形状错了，调用层就取不到 engine_params[engine_id]，
  // 那才是真的会静默失败。⛔ 键名和值一概不看。
  for (const bad of [{ e: 5 }, { e: 'x' }, { e: [1] }, { e: null }]) {
    assert.equal(store().create(base({ engine_params: bad })).ok, false)
  }
})

test('v4: 多台引擎的格子并存，互不影响', () => {
  const r = store().create(base({
    engine_id: 'engine-b',
    engine_params: { 'engine-a': { x: 1 }, 'engine-b': { y: 2 } },
  }))
  assert.deepEqual(r.recipe.engine_params, { 'engine-a': { x: 1 }, 'engine-b': { y: 2 } })
})

// --------------------------------------------------------------------------
//  ⭐⭐ 静默吃键：v3 最恶劣的失败形式
// --------------------------------------------------------------------------

test('⭐⭐ v4: params 里的未知键不再消失 —— 落进本引擎格子', () => {
  // v3 的行为：params 是写死的 16 键白名单，表外的键**直接丢掉还照返 200**。
  // 用户看到「保存成功」，值却没了。下游作者接一台新引擎时，他的每一个
  // 自定义参数都会这样蒸发 —— 这正是「无法提供工作流插件」的一个具体成因。
  const r = store().create(base({
    engine_id: 'indextts2',
    params: { speed: 1.1, emo_alpha: 0.8, 某个新引擎的参数: 'keep-me' },
  }))
  assert.equal(r.ok, true, r.error)
  assert.equal(r.recipe.engine_params.indextts2.emo_alpha, 0.8, 'emo_alpha 被静默吃掉了')
  assert.equal(r.recipe.engine_params.indextts2['某个新引擎的参数'], 'keep-me')
  // 通用键仍然留在 params 里，前端一个字都不用改
  assert.equal(r.recipe.params.speed, 1.1)
})

test('v4: 引擎未知时未知键收进 _unassigned 占位格，仍然不丢', () => {
  const r = store().create(base({ params: { 未知键: 7 } }))
  assert.equal(r.recipe.engine_params._unassigned['未知键'], 7)
})

test('v4: v3 那 16 个已知键仍然留在 params 里（前端零改动，不制造回归）', () => {
  const r = store().create(base({
    params: { top_k: 15, text_split_method: 'cut5', speed: 1.0, seed: -1 },
  }))
  assert.equal(r.recipe.params.top_k, 15)
  assert.equal(r.recipe.params.text_split_method, 'cut5')
})

// --------------------------------------------------------------------------
//  更新既有配方
// --------------------------------------------------------------------------

test('v4: 更新别的字段时，engine_params 不被清空', () => {
  const s = store()
  s.create(base({ engine_id: 'e1', engine_params: { e1: { x: 1 } } }))
  const r = s.create(base({ engine_id: 'e1', reference_text: '换了文本' }), { force: true })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.recipe.engine_params.e1, { x: 1 }, '更新无关字段把参数格子清空了')
})

test('v4: 显式传 engine_params ⇒ 整包替换（是替换不是合并，语义要明确）', () => {
  const s = store()
  s.create(base({ engine_id: 'e1', engine_params: { e1: { x: 1, y: 2 } } }))
  const r = s.create(base({ engine_id: 'e1', engine_params: { e1: { x: 9 } } }), { force: true })
  assert.deepEqual(r.recipe.engine_params.e1, { x: 9 })
})

test('⛔ recipeStore.js 的代码里不许出现任何具体引擎的名字（纯存储层）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'recipeStore.js'), 'utf8')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const name of ['gpt-sovits', 'gpt_sovits', 'indextts2', 'IndexTTS']) {
    assert.equal(code.includes(name), false, `recipeStore.js 的代码里写死了引擎名 ${name}`)
  }
})
