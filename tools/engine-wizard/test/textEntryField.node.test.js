'use strict'
// 「正文从标准输入读」这一格写回名片的方式（tools/engine-wizard/editor/textEntryField.js）。
//
// 守的是第 4 步必填区「合成文本」那格：有的命令行程序没有 --text 这类开关，
//   正文只从子进程的标准输入进。宿主 lib/engines/host.py 认 call.text_via="stdin"，
//   但它与 call.bind.text 互斥（两个都写每次请求都抛），所以写一边必须摘掉另一边。
//
// 两层判据：
//   1. 形状：开 = 写 text_via 且 bind 里没有 text；关 = 不凭空造 bind.text；
//   2. 不误伤：同一份 bind 里的其它键（输出、参考音频）原样保留。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { esbuild } = require('../../../lib/testDeps.js')

const ROOT = path.join(__dirname, '..', '..', '..')

// 编辑器里的纯函数模块是 ESM：用项目同一个 esbuild 编成 CJS 再取。
function loadEsm (file) {
  const code = esbuild().transformSync(fs.readFileSync(file, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(
    mod.exports, () => { throw new Error(path.basename(file) + ' 不该有依赖') }, mod)
  return mod.exports
}

const { readTextVia, withTextVia, TEXT_VIA_STDIN } = loadEsm(
  path.join(ROOT, 'tools/engine-wizard/editor/textEntryField.js'))

const CLI = () => ({
  kind: 'cli',
  argv: ['{engine_python}', '-m', 'prog'],
  bind: { output_path: '-f' },
})

test('勾上标准输入：写 text_via，且 bind 里不再留 text', () => {
  const call = { ...CLI(), bind: { text: '--text', output_path: '-f' } }
  const out = withTextVia(call, true)
  assert.strictEqual(out.text_via, TEXT_VIA_STDIN)
  assert.strictEqual(out.bind.text, undefined,
    'text_via 与 bind.text 并存，宿主会拒掉每一次请求')
  assert.strictEqual(out.bind.output_path, '-f', '同一份 bind 里的其它键被冲掉了')
})

test('勾上标准输入：bind 里没有 text 时也不凭空造键', () => {
  const out = withTextVia(CLI(), true)
  assert.strictEqual(out.text_via, TEXT_VIA_STDIN)
  assert.deepStrictEqual(Object.keys(out.bind), ['output_path'])
})

test('取消勾选：删掉 text_via，不凭空补一个 bind.text', () => {
  const call = { ...CLI(), text_via: TEXT_VIA_STDIN }
  const out = withTextVia(call, false)
  assert.strictEqual(out.text_via, undefined)
  assert.strictEqual(out.bind.text, undefined)
  assert.strictEqual(readTextVia(out), false)
})

test('原本没有 bind 的名片：勾上后仍不造 bind', () => {
  const out = withTextVia({ kind: 'cli', argv: ['prog'] }, true)
  assert.strictEqual(out.text_via, TEXT_VIA_STDIN)
  assert.strictEqual(out.bind, undefined)
})

test('不改入参', () => {
  const call = { ...CLI(), text_via: TEXT_VIA_STDIN }
  const snapshot = JSON.parse(JSON.stringify(call))
  withTextVia(call, false)
  assert.deepStrictEqual(call, snapshot, '名片是响应式状态，原地改会让界面看不出变化')
})

test('readTextVia 只认 "stdin"', () => {
  assert.strictEqual(readTextVia({ text_via: 'stdin' }), true)
  assert.strictEqual(readTextVia({ text_via: 'file' }), false)
  assert.strictEqual(readTextVia({}), false)
  assert.strictEqual(readTextVia(null), false)
})
