'use strict'
// 「这一格收的是哪一种数组」的判定。
//
// 判错两种都会出事：把逗号串当普通值 ⇒ 命令行上被拆成 N 个词，上游只吃第一个；
// 把普通值当逗号串 ⇒ 命令行上少给 N-1 个词。两种都不报错。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SOURCE = path.join(__dirname, '..', 'editor', 'paramShape.js')

function load () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  if (!esbuild) throw new Error('拿不到 esbuild')
  const code = esbuild.transformSync(fs.readFileSync(SOURCE, 'utf8'), {
    loader: 'js', format: 'cjs', target: 'node18',
  }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, () => {
    throw new Error('paramShape 不该有依赖')
  }, mod)
  return mod.exports
}

const { vectorShapeFromHelp } = load()

test('守卫：拿到的是活代码里的判定函数', () => {
  assert.equal(typeof vectorShapeFromHelp, 'function')
})

test('上游写明「逗号分隔的 8 维」⇒ 一个词，八格', () => {
  const shape = vectorShapeFromHelp('Comma-separated 8-dimensional emotion vector')
  assert.deepStrictEqual(shape, { style: 'join', join: ',', repeat: 8 })
})

test('IndexTTS2 批量子命令的原话也认：8-dimensional 与 comma-separated 顺序反过来同样命中', () => {
  assert.equal(vectorShapeFromHelp('Default comma-separated 8-dimensional emotion vector').repeat, 8)
})

test('只说逗号分隔、没说几维 ⇒ 一个词，但不推格数', () => {
  const shape = vectorShapeFromHelp('Comma separated list of stop tokens')
  assert.deepStrictEqual(shape, { style: 'join', join: ',', repeat: 0 })
})

test('普通说明不命中：不认识的参数要保持原样', () => {
  assert.strictEqual(vectorShapeFromHelp('Path to the speaker reference audio'), null)
  assert.strictEqual(vectorShapeFromHelp('Speaking rate'), null)
  assert.strictEqual(vectorShapeFromHelp(''), null)
  assert.strictEqual(vectorShapeFromHelp(null), null)
})

test('只写维度不写分隔方式不命中：维数本身不说明是一个词还是 N 个词', () => {
  assert.strictEqual(vectorShapeFromHelp('Embedding of 8-dimensional space'), null)
})

test('中文说明同样认', () => {
  const shape = vectorShapeFromHelp('逗号分隔的 8 维情绪向量')
  assert.deepStrictEqual(shape, { style: 'join', join: ',', repeat: 8 })
})

test('维度离谱时不推格数：格数写了就会被校验当成本钱', () => {
  assert.equal(vectorShapeFromHelp('comma-separated 1-dimensional vector').repeat, 0)
  assert.equal(vectorShapeFromHelp('comma-separated 200-dimensional vector').repeat, 0)
})
