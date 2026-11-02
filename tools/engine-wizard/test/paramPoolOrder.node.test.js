'use strict'
// 参数池渲染顺序的守卫：必填置顶、其余原序、入参不被改。
//   required 的来源见 core/paramDigest.js，只有上游写了 required=True
//   才置顶，默认值与平台推断一律不算（与 paramDigest 的搬运口径一致）。

const { test } = require('node:test')
const assert = require('node:assert')
const { orderForPool } = require('../editor/paramPoolOrder')

const mk = (name, extra) => ({ name, target: `--${name}`, ...extra })

test('必填置顶，非必填保持扫描原序', () => {
  const list = [
    mk('opt-1', {}),
    mk('must', { required: true }),
    mk('opt-2', {}),
    mk('also-must', { required: true }),
  ]
  assert.deepStrictEqual(
    orderForPool(list).map((p) => p.name),
    ['must', 'also-must', 'opt-1', 'opt-2'])
})

test('必填之间与可选之间都保持原序（稳定）', () => {
  const list = [
    mk('b1', { required: true }),
    mk('o1', {}),
    mk('b2', { required: true }),
    mk('o2', {}),
    mk('b3', { required: true }),
  ]
  assert.deepStrictEqual(
    orderForPool(list).map((p) => p.name),
    ['b1', 'b2', 'b3', 'o1', 'o2'])
})

test('清一色时就是原序：全必填 / 全可选都不该乱动', () => {
  const allReq = [mk('a', { required: true }), mk('b', { required: true })]
  assert.deepStrictEqual(orderForPool(allReq).map((p) => p.name), ['a', 'b'])
  const allOpt = [mk('a'), mk('b')]
  assert.deepStrictEqual(orderForPool(allOpt).map((p) => p.name), ['a', 'b'])
})

test('只有 required === true 才置顶 —— 与 paramDigest 的搬运口径一致', () => {
  const list = [
    mk('str', { required: 'true' }),
    mk('num', { required: 1 }),
    mk('obj', { required: {} }),
    mk('real', { required: true }),
  ]
  assert.deepStrictEqual(
    orderForPool(list).map((p) => p.name),
    ['real', 'str', 'num', 'obj'])
})

test('返回新数组，入参不改（React list 上直接排会出幽灵更新）', () => {
  const list = [mk('o', {}), mk('m', { required: true })]
  const before = list.map((p) => p.name)
  const out = orderForPool(list)
  assert.notStrictEqual(out, list, '返回了同一个数组引用')
  assert.deepStrictEqual(list.map((p) => p.name), before, '入参被改了')
})

test('空数组 / 非数组 / 奇形怪状的条目都不炸', () => {
  assert.deepStrictEqual(orderForPool([]), [])
  assert.deepStrictEqual(orderForPool(null), [])
  assert.deepStrictEqual(orderForPool('nope'), [])
  assert.deepStrictEqual(orderForPool([null, 42, undefined]),
    [null, 42, undefined])
})
