'use strict'
// 「合成参数」一条的形状换算：开关、中英文名字、按类型的选项表。
// 这些函数决定主行四列与两张表落到名片里是什么形状。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SOURCE = path.join(__dirname, '..', 'editor', 'paramFields.js')

function load () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  if (!esbuild) throw new Error('拿不到 esbuild')
  const code = esbuild.transformSync(fs.readFileSync(SOURCE, 'utf8'), {
    loader: 'js', format: 'cjs', target: 'node18',
  }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, () => {
    throw new Error('paramFields 不该有依赖')
  }, mod)
  return mod.exports
}

const {
  nameFromFlag, readLabel, withLabel, readChoices, readDims, resizeRows, withCell,
} = load()

test('开关去掉开头横线就是参数名', () => {
  assert.equal(nameFromFlag('--emotion-vector'), 'emotion-vector')
  assert.equal(nameFromFlag('-v'), 'v')
  assert.equal(nameFromFlag('  --speed  '), 'speed')
  assert.equal(nameFromFlag(''), '')
})

test('label 读成中英成对：旧版字符串两边都读到', () => {
  assert.deepStrictEqual(readLabel({ label: { zh: '情绪向量', en: 'Emotion' } }),
    { zh: '情绪向量', en: 'Emotion' })
  assert.deepStrictEqual(readLabel({ label: '旧名字' }), { zh: '旧名字', en: '旧名字' })
  assert.deepStrictEqual(readLabel({}), { zh: '', en: '' })
})

test('改一种语言不抹掉另一种；两边都空就删掉键', () => {
  const entry = { name: 'x', label: { zh: '快乐', en: 'happy' } }
  assert.deepStrictEqual(withLabel(entry, 'en', 'glad').label, { zh: '快乐', en: 'glad' })
  assert.strictEqual(withLabel({ label: { zh: '', en: '' } }, 'zh', '').label, undefined)
})

test('select 选项读成三列：值 / 中文 / 英文', () => {
  const rows = readChoices({ choices: [
    { value: '0', label: { zh: '中性', en: 'neutral' } },
    'auto',
  ] })
  assert.deepStrictEqual(rows, [
    { value: '0', zh: '中性', en: 'neutral' },
    { value: 'auto', zh: '', en: '' },
  ])
})

test('vector 维度读成两列：中文 / 英文', () => {
  assert.deepStrictEqual(readDims({ dim_labels: [{ zh: '快乐', en: 'happy' }, 'sad'] }), [
    { zh: '快乐', en: 'happy' }, { zh: 'sad', en: 'sad' },
  ])
})

test('改行数：补空行、从末尾截，不挪已有值', () => {
  const rows = [{ v: 'a' }, { v: 'b' }, { v: 'c' }]
  assert.deepStrictEqual(resizeRows(rows, 2, () => ({ v: '' })), [{ v: 'a' }, { v: 'b' }])
  assert.deepStrictEqual(resizeRows(rows, 4, () => ({ v: '' })),
    [{ v: 'a' }, { v: 'b' }, { v: 'c' }, { v: '' }])
  assert.deepStrictEqual(resizeRows(rows, 0, () => ({ v: '' })), [])
})

test('改一格只动那一格', () => {
  const rows = [{ zh: '快乐', en: 'happy' }, { zh: '悲伤', en: 'sad' }]
  assert.deepStrictEqual(withCell(rows, 1, 'en', 'sorrow'), [
    { zh: '快乐', en: 'happy' }, { zh: '悲伤', en: 'sorrow' },
  ])
})
