'use strict'

// 收格子这一步的两个分支：留空（用户明确清空了那一格）与没带这个键（调用方不关心这个参数）
// 走的是两条路。留空才有「沿用上一次」一说，没带这个键照旧由名片 defaults 决定。
// 判据与后果见 issue #26 §14。

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { isBlankValue, resolveIncomingKnobs } = require('./paramTable')

// 一张与任何真引擎都无关的名片：只声明形状，不声明身份。
function profile (paramSchema) {
  return { id: 'engine-x', param_schema: paramSchema, defaults: {} }
}

test('留空 + 上一次填过 ⇒ 接过来的是归一后的那个值，键名与接过来的值都记在 carriedOver 里', () => {
  const p = profile([{ name: 'n', type: 'number' }])
  const out = resolveIncomingKnobs(p, { n: '' }, { n: '2.5' })

  assert.deepEqual(out.values, { n: 2.5 }, '存下来的配方是请求体的形状，接过来要按名片声明的类型再过一遍')
  assert.deepEqual(out.carriedOver, { n: 2.5 })
})

test('⭐ 留空 + 上一次那个值按现在的名片已经收不下 ⇒ 不接，空值原样送出去', () => {
  const p = profile([{ name: 's', type: 'select', choices: [{ value: 'a' }, { value: 'b' }] }])
  const out = resolveIncomingKnobs(p, { s: '' }, { s: 'z' })

  assert.deepEqual(out.values, { s: '' }, '名片换了选项还硬接旧值，等于替用户填一个这台引擎不认的东西')
  assert.deepEqual(out.carriedOver, {})
})

test('留空 + 上一次那一格也是空的 ⇒ 没得接', () => {
  const p = profile([{ name: 'n', type: 'number' }])

  for (const saved of [{ n: '' }, { n: null }, { n: [] }, {}]) {
    const out = resolveIncomingKnobs(p, { n: null }, saved)
    assert.deepEqual(out.values, { n: null })
    assert.deepEqual(out.carriedOver, {}, `上一次那格是 ${JSON.stringify(saved)}，不能报「已沿用」`)
  }
})

test('⭐ 没带这个键 ⇒ values 里不出现它：交给名片 defaults，与留空是两件事', () => {
  const p = profile([{ name: 'n', type: 'number' }])
  const out = resolveIncomingKnobs(p, { other: 1 }, { n: 7 })

  assert.deepEqual(out.values, {})
  assert.deepEqual(out.carriedOver, {})
})

test('savedRecipe 传 null ⇒ 一律不接：查不到上一次就是这个形状', () => {
  const p = profile([{ name: 'n', type: 'number' }])
  const out = resolveIncomingKnobs(p, { n: '' }, null)

  assert.deepEqual(out.values, { n: '' })
  assert.deepEqual(out.carriedOver, {})
})

test('一排格子（repeat 三格）留空 ⇒ 整组接过来；接过来的长度不对就整组不接', () => {
  const p = profile([{ name: 'v', type: 'number', repeat: 3 }])

  const ok = resolveIncomingKnobs(p, { v: [] }, { v: [1, 2, 3] })
  assert.deepEqual(ok.values, { v: [1, 2, 3] })
  assert.deepEqual(ok.carriedOver, { v: [1, 2, 3] })

  const short = resolveIncomingKnobs(p, { v: [] }, { v: [1, 2] })
  assert.deepEqual(short.values, { v: [] }, '少一维发过去，引擎通常照收，然后声音不对而没人知道')
  assert.deepEqual(short.carriedOver, {})
})

test('留空认的三种形状：空串、null、空数组；0 与 false 是填过的值', () => {
  assert.equal(isBlankValue(''), true)
  assert.equal(isBlankValue(null), true)
  assert.equal(isBlankValue([]), true)
  assert.equal(isBlankValue(0), false, '0 是用户填的一个值，不是留空')
  assert.equal(isBlankValue(false), false, 'false 同样是填过的：不发和发 false 在引擎那边是两件事')
})
