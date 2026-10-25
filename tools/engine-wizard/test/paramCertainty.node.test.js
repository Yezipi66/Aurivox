'use strict'
// 左栏类型上色的判据：类型是上游写明的（绿），还是我们猜的（灰）。
//   只认上游自己写下的东西：argparse 的 action= / type= / choices=，python 的注解与 Literal。
//   默认值、参数名推出来的类型一律算猜。
const { test } = require('node:test')
const assert = require('node:assert')
const { fromCli, fromPython } = require('../core/paramDigest')

const cli = (extra) => fromCli({ name: 'x', flag: '--x', style: 'value', ...extra })

test('cli：store_true / BooleanOptionalAction 是确定的 boolean', () => {
  assert.deepStrictEqual([cli({ style: 'boolean' }).kind, cli({ style: 'boolean' }).kind_certain], ['boolean', true])
  assert.strictEqual(cli({ style: 'boolean_optional' }).kind_certain, true)
})

test('cli：写了 type=int / float 是确定的 number', () => {
  assert.deepStrictEqual([cli({ type: 'int' }).kind, cli({ type: 'int' }).kind_certain], ['number', true])
  assert.strictEqual(cli({ type: 'float' }).kind_certain, true)
})

test('cli：没写 type=、默认值是数字 ⇒ 猜成 number，标不确定', () => {
  const p = cli({ default: 1.0 })
  assert.deepStrictEqual([p.kind, p.kind_certain], ['number', false])
})

test('cli：什么都没写 ⇒ str，不确定', () => {
  const p = cli({})
  assert.deepStrictEqual([p.kind, p.kind_certain], ['str', false])
})

test('python：有注解或 Literal 选项是确定的；只有默认值推的不确定', () => {
  assert.strictEqual(fromPython({ name: 'a', kind: { kind: 'text', confidence: 'medium' }, annotation: { raw: 'str' } }).kind_certain, true)
  assert.strictEqual(fromPython({ name: 'a', kind: { kind: 'text', confidence: 'medium' }, upstream_choices: ['x'] }).kind_certain, true)
  assert.strictEqual(fromPython({ name: 'a', kind: { kind: 'boolean', confidence: 'strong' } }).kind_certain, true)
  assert.strictEqual(fromPython({ name: 'a', kind: { kind: 'number', confidence: 'medium' } }).kind_certain, false)
  assert.strictEqual(fromPython({ name: 'a', type: 'number' }).kind_certain, false)
})
