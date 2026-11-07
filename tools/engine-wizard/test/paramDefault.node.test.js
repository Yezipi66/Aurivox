'use strict'
// 参数「建议值」在界面与名片之间的形状换算。
//
// 它决定一件事：成排参数（repeat 大于等于 2）的默认值落盘是数组还是字符串。
// 落成字符串时平台校验会拒（要求长度等于 repeat 的数组），接入者却看不出是这一格的事。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SOURCE = path.join(__dirname, '..', 'editor', 'paramDefault.js')

function load () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  if (!esbuild) throw new Error('拿不到 esbuild')
  const code = esbuild.transformSync(fs.readFileSync(SOURCE, 'utf8'), {
    loader: 'js', format: 'cjs', target: 'node18',
  }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, () => {
    throw new Error('paramDefault 不该有依赖')
  }, mod)
  return mod.exports
}

const { repeatOf, defaultTextOf, defaultFromText, vectorCellText, withVectorCell } = load()

test('守卫：拿到的是活代码里的三个纯函数', () => {
  assert.equal(typeof repeatOf, 'function')
  assert.equal(typeof defaultTextOf, 'function')
  assert.equal(typeof defaultFromText, 'function')
})

test('repeat：未写、写 1、写非法值都算单值', () => {
  assert.equal(repeatOf({}), 1)
  assert.equal(repeatOf({ repeat: 1 }), 1)
  assert.equal(repeatOf({ repeat: 8 }), 8)
  assert.equal(repeatOf({ repeat: '8' }), 8)
  assert.equal(repeatOf({ repeat: 0 }), 1)
  assert.equal(repeatOf({ repeat: 2.5 }), 1)
  assert.equal(repeatOf({ repeat: 'abc' }), 1)
})

test('单值：读写都是标量，类型跟着 type 走', () => {
  assert.equal(defaultTextOf({ suggested_value: 1 }), '1')
  assert.equal(defaultFromText('1', { type: 'number' }), 1)
  assert.equal(defaultFromText('x', { type: 'text' }), 'x')
  assert.equal(defaultFromText('true', { type: 'boolean' }), true)
})

test('成排：落盘是数组，显示是逗号串', () => {
  const entry = { repeat: 8, type: 'number', suggested_value: [0, 0, 0.8, 0, 0, 0, 0, 0] }
  assert.equal(defaultTextOf(entry), '0,0,0.8,0,0,0,0,0')
  assert.deepStrictEqual(defaultFromText('0,0,0.8,0,0,0,0,0', entry), [0, 0, 0.8, 0, 0, 0, 0, 0])
})

test('成排：还没填时显示空串，不拿一个 0 冒充第一维', () => {
  assert.equal(defaultTextOf({ repeat: 8, type: 'number' }), '')
})

test('成排：空的一段写 null，不替人补 0', () => {
  const entry = { repeat: 3, type: 'number' }
  assert.deepStrictEqual(defaultFromText('0.2,,0.4', entry), [0.2, null, 0.4])
})

test('成排：空串整体清空，等于没有建议值', () => {
  assert.strictEqual(defaultFromText('', { repeat: 8, type: 'number' }), undefined)
})

test('成排：数组里有 null 时显示成空的一段，回读仍然对得上', () => {
  const entry = { repeat: 3, type: 'number', suggested_value: [0.2, null, 0.4] }
  assert.equal(defaultTextOf(entry), '0.2,,0.4')
  assert.deepStrictEqual(defaultFromText(defaultTextOf(entry), entry), [0.2, null, 0.4])
})

// 成排参数在界面上是一格一个维度：读一格、写一格，落盘仍是等长数组。
test('多格：一格一个维度，缺的维显示空', () => {
  const entry = { repeat: 3, type: 'number', suggested_value: [0.2, null, 0.4] }
  assert.equal(vectorCellText(entry, 0), '0.2')
  assert.equal(vectorCellText(entry, 1), '')
  assert.equal(vectorCellText(entry, 2), '0.4')
})

test('多格：写一格不动其它维，长度仍是 repeat', () => {
  const entry = { repeat: 3, type: 'number', suggested_value: [0.2, null, 0.4] }
  assert.deepStrictEqual(withVectorCell(entry, 1, '0.9'), [0.2, 0.9, 0.4])
  assert.deepStrictEqual(withVectorCell(entry, 0, ''), [null, null, 0.4], '清空那一维写 null')
})

test('多格：原来没有默认值时写入会补成等长数组', () => {
  const entry = { repeat: 8, type: 'number' }
  const next = withVectorCell(entry, 2, '0.8')
  assert.equal(next.length, 8)
  assert.deepStrictEqual(next.slice(0, 3), [null, null, 0.8])
  assert.deepStrictEqual(next.slice(3), new Array(5).fill(null))
})

// 多维声明不写 repeat：维度数由 dim_labels 的长度定，这里与派生那一步同一条口径。
test('vector 声明的格数取 dim_labels 的长度', () => {
  assert.equal(repeatOf({ type: 'vector', dim_labels: ['a', 'b', 'c'] }), 3)
  assert.equal(repeatOf({ type: 'vector' }), 0, '还没写维度就是零格，由界面提示先加维度')
})

test('vector 的多格读写与 repeat 那条完全一样', () => {
  const entry = { type: 'vector', dim_labels: ['a', 'b', 'c'], suggested_value: [0.2, null, 0.4] }
  assert.equal(vectorCellText(entry, 1), '')
  assert.deepStrictEqual(withVectorCell(entry, 1, '0.9'), [0.2, '0.9', 0.4],
    'vector 每格是 text，写进去的是字符串，平台不替它规定数制')
})

// 从 vector 切到单值类型后，值可能还留着数组。界面不能把它画成一串逗号。
test('标量类型收到数组 ⇒ 当作没填，不显示逗号', () => {
  assert.equal(defaultTextOf({ type: 'text', suggested_value: [null, null, null] }), '')
  assert.equal(defaultTextOf({ type: 'number', suggested_value: [0, 0.2, 0.4] }), '')
})
