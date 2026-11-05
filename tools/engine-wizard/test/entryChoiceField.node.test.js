'use strict'
// 「推理入口」那一格的读写：从下拉里选文件，写进名片的必须是模块名或脚本路径，
// 不能把相对文件路径当成 -m 的目标。src 布局还要把工作目录一起定下来。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SOURCE = path.join(__dirname, '..', 'editor', 'entryChoiceField.js')

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

const { readEntry, displayEntry, writeEntry, entryFileOf } = load()

const CANDIDATES = [
  {
    file: 'src/a/b/c/infer_cli.py', module: 'a.b.c.infer_cli', srcRoot: 'src',
    score: 4, flags: 4, groups: [], source: 'file', recommended: true,
  },
  {
    file: 'cli/infer.py', module: 'cli.infer', srcRoot: null,
    score: 2, flags: 2, groups: [], source: 'file', recommended: false,
  },
]

const cliManifest = () => ({
  id: 'demo',
  label: 'Demo',
  call: {
    kind: 'cli',
    argv: ['{engine_python}', '-m', '_MODULE_', '--model_dir', '{checkpoints}'],
    bind: { text: '--text' },
    seed: 'none',
  },
})

test('占位符不算已声明；输入框显示为空', () => {
  const m = cliManifest()
  assert.deepStrictEqual(readEntry(m),
    { target: 'argv', kind: 'module', index: 2, value: '_MODULE_' })
  assert.strictEqual(displayEntry(m, CANDIDATES), '')
})

test('选候选里的文件 ⇒ 写模块名、src 工作目录，权重那一对参数原样保留', () => {
  const m = cliManifest()
  const next = writeEntry(m, 'src/a/b/c/infer_cli.py', CANDIDATES, 'demo')
  assert.deepStrictEqual(next.call.argv,
    ['{engine_python}', '-m', 'a.b.c.infer_cli', '--model_dir', '{checkpoints}'])
  assert.strictEqual(next.call.cwd, 'engines/demo/src')
  assert.strictEqual(displayEntry(next, CANDIDATES), 'src/a/b/c/infer_cli.py',
    '名片里存的是模块名，界面上显示的是使用者选的那个文件')
})

test('选扁平布局的文件 ⇒ 工作目录回到引擎根', () => {
  const m = cliManifest()
  m.call.cwd = 'engines/demo/src'
  const next = writeEntry(m, 'cli/infer.py', CANDIDATES, 'demo')
  assert.deepStrictEqual(next.call.argv.slice(0, 3), ['{engine_python}', '-m', 'cli.infer'])
  assert.strictEqual(next.call.cwd, 'engines/demo')
})

test('手输模块名按原样写，工作目录不替使用者改', () => {
  const m = cliManifest()
  m.call.cwd = 'engines/demo/custom'
  const next = writeEntry(m, 'pkg.custom_cli', CANDIDATES, 'demo')
  assert.deepStrictEqual(next.call.argv.slice(0, 3), ['{engine_python}', '-m', 'pkg.custom_cli'])
  assert.strictEqual(next.call.cwd, 'engines/demo/custom')
})

test('手输 .py 路径写成脚本调用，不留 -m', () => {
  const m = cliManifest()
  const next = writeEntry(m, 'scripts/run_infer.py', CANDIDATES, 'demo')
  assert.deepStrictEqual(next.call.argv,
    ['{engine_python}', 'scripts/run_infer.py', '--model_dir', '{checkpoints}'])
  assert.strictEqual(readEntry(next).kind, 'script')
})

test('脚本形态切回候选模块时，-m 补回来且不留脚本路径', () => {
  const m = cliManifest()
  m.call.argv = ['{engine_python}', 'scripts/run_infer.py', '--model_dir', '{checkpoints}']
  const next = writeEntry(m, 'cli/infer.py', CANDIDATES, 'demo')
  assert.deepStrictEqual(next.call.argv,
    ['{engine_python}', '-m', 'cli.infer', '--model_dir', '{checkpoints}'])
})

test('清空回到占位符，不留空词在命令行上', () => {
  const m = cliManifest()
  const next = writeEntry(m, '   ', CANDIDATES, 'demo')
  assert.deepStrictEqual(next.call.argv.slice(0, 3), ['{engine_python}', '-m', '_MODULE_'])
})

test('Python 类形态写 call.module，不生成 argv', () => {
  const m = { id: 'demo', call: { kind: 'python', module: '' } }
  const next = writeEntry(m, 'pkg.cls', CANDIDATES, 'demo')
  assert.strictEqual(next.call.module, 'pkg.cls')
  assert.strictEqual(next.call.argv, undefined)
})

test('入口文件：候选命中给文件，手输脚本原样给，只有模块名给空', () => {
  const m = cliManifest()
  // 候选里的值（模块名）能反查到文件。
  assert.strictEqual(entryFileOf(
    { call: { kind: 'cli', argv: ['{engine_python}', '-m', 'a.b.c.infer_cli'] } },
    CANDIDATES), 'src/a/b/c/infer_cli.py')
  // 候选里没有的脚本路径原样返回：收窄拿它去比 source_file。
  assert.strictEqual(entryFileOf(
    { call: { kind: 'cli', argv: ['{engine_python}', 'scripts/run.py'] } },
    CANDIDATES), 'scripts/run.py')
  // 只剩模块名、候选里又没有对应文件：给空，由调用方退回全量。
  assert.strictEqual(entryFileOf(
    { call: { kind: 'cli', argv: ['{engine_python}', '-m', 'unknown.pkg'] } },
    CANDIDATES), '')
  // 占位符等于没填。
  assert.strictEqual(entryFileOf(m, CANDIDATES), '')
})
