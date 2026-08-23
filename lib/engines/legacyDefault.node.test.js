'use strict'

// ---------------------------------------------------------------------------
//  lib/engines/legacyDefault.js —— 「没人说连哪台的时候连哪台」
// ---------------------------------------------------------------------------
// 这里最要紧的一条是「两张名片都认领 ⇒ 报错」。静默取第一个的代价是：
// 有一天有人给第二个引擎也加了这一行，然后合成悄悄换了一台引擎，音色变了，
// 而所有测试都是绿的。

const test = require('node:test')
const assert = require('node:assert')

const { findLegacyDefaultId } = require('./legacyDefault')

const engine = (id, legacy) => (legacy === undefined ? { id } : { id, legacy_default: legacy })

test('恰好一张名片认领 ⇒ 就是它', () => {
  assert.equal(findLegacyDefaultId([engine('alpha'), engine('beta', true)]), 'beta')
})

test('没有人认领 ⇒ 报错，并列出装了哪些引擎', () => {
  assert.throws(() => findLegacyDefaultId([engine('alpha'), engine('beta')]), (e) => {
    assert.equal(e.code, 'ENGINE_LEGACY_DEFAULT_MISSING')
    assert.match(e.message, /alpha/)
    assert.match(e.message, /beta/)
    return true
  })
})

test('一台引擎都没装时，报错也要说人话', () => {
  assert.throws(() => findLegacyDefaultId([]),
    (e) => e.code === 'ENGINE_LEGACY_DEFAULT_MISSING' && /一台都没有/.test(e.message))
})

test('⭐ 两张名片都认领 ⇒ 必须报错，不许按字母序静默挑一个', () => {
  assert.throws(() => findLegacyDefaultId([engine('alpha', true), engine('beta', true)]), (e) => {
    assert.equal(e.code, 'ENGINE_LEGACY_DEFAULT_AMBIGUOUS')
    assert.deepStrictEqual(e.claimed, ['alpha', 'beta'])
    return true
  })
})

test('legacy_default 写成字符串 "true" 不算认领（JSON 里最常见的手滑）', () => {
  assert.throws(() => findLegacyDefaultId([engine('alpha', 'true')]),
    (e) => e.code === 'ENGINE_LEGACY_DEFAULT_MISSING')
})

test('legacy_default:false 与「没写」等价', () => {
  assert.throws(() => findLegacyDefaultId([engine('alpha', false)]),
    (e) => e.code === 'ENGINE_LEGACY_DEFAULT_MISSING')
})
