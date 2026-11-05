'use strict'
// 参数池收窄：认出推理入口后左栏只列入口文件里的参数。
// 收窄会少列东西，少列错了使用者又看不见，所以判据与退路都要逐条守住：
// 入口文件 → 入口所在目录 → 全量，三级退让，每级的依据要在返回值里说清。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SOURCE = path.join(__dirname, '..', 'editor', 'paramScope.js')

function load () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  assert.ok(esbuild, '拿不到编译依赖')
  const code = esbuild.transformSync(fs.readFileSync(SOURCE, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(
    mod.exports, () => { throw new Error('纯函数模块不该有依赖') }, mod)
  return mod.exports
}

const { scopeParams, normFile } = load()

const p = (name, file) => ({ source: 'cli', name, target: '--' + name, source_file: file })

// 一台引擎的扫描结果：入口文件 3 个，同目录 1 个，别处 4 个（训练、工具脚本）。
const TREES = [
  p('text', 'cli/infer.py'),
  p('output', 'cli/infer.py'),
  p('ref_wav', 'cli/infer.py'),
  p('device', 'cli/util.py'),
  p('lr', 'train/s1_train.py'),
  p('epochs', 'train/s1_train.py'),
  p('batch', 'tools/api_client.py'),
  p('token', 'tools/api_client.py'),
]

test('⛔ 没有入口就不收窄：拿不到依据时给全量，不给空池', () => {
  const r = scopeParams(TREES, '')
  assert.equal(r.basis, 'all')
  assert.equal(r.params.length, TREES.length)
  assert.equal(r.outside, 0)
})

test('入口文件命中：只留入口里的，其余按数量报出去', () => {
  const r = scopeParams(TREES, 'cli/infer.py')
  assert.equal(r.basis, 'entry')
  assert.deepStrictEqual(r.params.map((x) => x.name), ['text', 'output', 'ref_wav'])
  assert.equal(r.outside, 5)
})

test('入口文件里没有参数（薄 __main__ 只做转调）⇒ 退到入口所在目录', () => {
  const r = scopeParams(TREES, 'cli/__main__.py')
  assert.equal(r.basis, 'dir')
  assert.deepStrictEqual(r.params.map((x) => x.name),
    ['text', 'output', 'ref_wav', 'device'])
  assert.equal(r.outside, 4)
})

test('入口所在目录也没有参数 ⇒ 退到全量，不返回空池', () => {
  const r = scopeParams(TREES, 'nonexistent/entry.py')
  assert.equal(r.basis, 'all')
  assert.equal(r.params.length, TREES.length)
  assert.equal(r.outside, 0)
})

test('路径分隔符与大小写不同仍然算同一个文件', () => {
  const mixed = [
    p('text', 'CLI\\Infer.py'),
    p('lr', 'train\\s1_train.py'),
  ]
  const r = scopeParams(mixed, 'cli/infer.py')
  assert.equal(r.basis, 'entry')
  assert.deepStrictEqual(r.params.map((x) => x.name), ['text'])
  assert.equal(r.outside, 1)
})

test('没有 source_file 的参数在收窄后不再出现：无法归属就不能冒充入口内的', () => {
  const list = [p('text', 'cli/infer.py'), { source: 'cli', name: 'loose', target: '--loose' }]
  const r = scopeParams(list, 'cli/infer.py')
  assert.deepStrictEqual(r.params.map((x) => x.name), ['text'])
  assert.equal(r.outside, 1)
})

test('入参不是数组时按空表处理，不抛异常', () => {
  assert.deepStrictEqual(scopeParams(null, 'cli/infer.py').params, [])
  assert.equal(scopeParams(undefined, '').basis, 'all')
})

test('normFile 只做归一，不做绝对化', () => {
  assert.equal(normFile('./CLI/Infer.py'), 'cli/infer.py')
  assert.equal(normFile('cli\\infer.py'), 'cli/infer.py')
  assert.equal(normFile(null), '')
  assert.equal(normFile('D:/x/y.py'), 'd:/x/y.py')
})
