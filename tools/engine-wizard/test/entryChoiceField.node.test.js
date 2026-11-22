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

const { readEntry, displayEntry, writeEntry, entryFileOf, readSubcommand, writeSubcommand,
  writePythonEntry, withCallKind, callKindOf } = load()

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

// ---- 子命令：写进命令行的那一个词 ----

test('子命令读得出来，占位符与开关不算', () => {
  assert.strictEqual(readSubcommand(
    { call: { kind: 'cli', argv: ['{engine_python}', '-m', 'pkg.cli', 'synth', '--text', 'x'] } }), 'synth')
  assert.strictEqual(readSubcommand(
    { call: { kind: 'cli', argv: ['{engine_python}', '-m', 'pkg.cli', '--text', 'x'] } }), '')
  assert.strictEqual(readSubcommand(
    { call: { kind: 'cli', argv: ['{engine_python}', '-m', '{_MODULE_}'] } }), '')
  assert.strictEqual(readSubcommand(
    { call: { kind: 'cli', argv: ['{engine_python}', 'scripts/run.py', 'infer'] } }), 'infer')
})

test('子命令能插入、替换、去掉，且不动原对象', () => {
  const base = { call: { kind: 'cli', argv: ['{engine_python}', '-m', 'pkg.cli', '--text', 'x'] } }
  const added = writeSubcommand(base, 'synth')
  assert.deepStrictEqual(added.call.argv, ['{engine_python}', '-m', 'pkg.cli', 'synth', '--text', 'x'])
  assert.deepStrictEqual(base.call.argv, ['{engine_python}', '-m', 'pkg.cli', '--text', 'x'],
    '原名片不该被改')

  const replaced = writeSubcommand(added, 'batch')
  assert.deepStrictEqual(replaced.call.argv, ['{engine_python}', '-m', 'pkg.cli', 'batch', '--text', 'x'])

  const removed = writeSubcommand(replaced, '')
  assert.deepStrictEqual(removed.call.argv, ['{engine_python}', '-m', 'pkg.cli', '--text', 'x'])
})

test('还没有模块名时不硬塞子命令', () => {
  const m = { call: { kind: 'cli', argv: ['{engine_python}'] } }
  const out = writeSubcommand(m, 'synth')
  assert.deepStrictEqual(out.call.argv, ['{engine_python}'])
})

test('选 python 入口时模块、类、方法一起写，命令行那几段摘掉', () => {
  const m = { id: 'demo', call: { kind: 'cli', argv: ['{engine_python}', '-m', 'pkg.cli'], args: { text: { flag: '--text' } } } }
  const out = writePythonEntry(m, {
    module: 'pkg.tts', className: 'TTS', method: 'synthesize', srcRoot: null,
  }, 'demo')
  assert.strictEqual(out.call.kind, 'python')
  assert.strictEqual(out.call.module, 'pkg.tts')
  assert.strictEqual(out.call.class, 'TTS')
  assert.strictEqual(out.call.method, 'synthesize')
  assert.strictEqual(out.call.argv, undefined, 'argv 在 python 形态下不合法')
  assert.strictEqual(out.call.args, undefined, 'args 在 python 形态下不合法')
  assert.strictEqual(out.call.cwd, 'engines/demo')
  assert.deepStrictEqual(m.call.argv, ['{engine_python}', '-m', 'pkg.cli'], '原名片不该被改')
})

test('换入口时，旧的子命令不属于新入口就去掉', () => {
  const C = [{ file: 'cli/other.py', module: 'cli.other', groups: ['infer', 'batch'], srcRoot: null }]
  const m = { id: 'demo', call: { kind: 'cli', argv: ['{engine_python}', '-m', 'cli.main', 'synth', '--text', 'x'] } }
  const out = writeEntry(m, 'cli/other.py', C, 'demo')
  assert.deepStrictEqual(out.call.argv, ['{engine_python}', '-m', 'cli.other', '--text', 'x'],
    'synth 不属于新入口，留着就是一条非法参数')

  const K = [{ file: 'cli/keep.py', module: 'cli.keep', groups: ['synth', 'infer'], srcRoot: null }]
  const kept = writeEntry(m, 'cli/keep.py', K, 'demo')
  assert.deepStrictEqual(kept.call.argv, ['{engine_python}', '-m', 'cli.keep', 'synth', '--text', 'x'],
    '新入口也有这个子命令时保留')
})

// ---- 调用形态：cli / python ----

test('形态按名片判：写了 kind 认它，没写按有没有 argv 判', () => {
  assert.strictEqual(callKindOf({ call: { kind: 'python' } }), 'python')
  assert.strictEqual(callKindOf({ call: { kind: 'cli' } }), 'cli')
  assert.strictEqual(callKindOf({ call: { argv: ['{engine_python}', 'x.py'] } }), 'cli')
  assert.strictEqual(callKindOf({ call: {} }), 'python')
  assert.strictEqual(callKindOf({}), 'python')
})

test('切到 python：命令行那几段摘掉，绑定名改成方法参数名', () => {
  const before = {
    parameters: [{ name: 'train_data', type: 'text' }],
    call: {
      kind: 'cli',
      argv: ['{engine_python}', '-m', 'pkg.cli'],
      args: { voice: { flag: '--voice' } },
      text_via: 'stdin',
      bind: { text: '--tts-text', ref_audio: '--prompt_wav' },
    },
  }
  const after = withCallKind(before, 'python')
  assert.strictEqual(after.call.kind, 'python')
  assert.strictEqual(after.call.argv, undefined,
    'cli 的执行命令必须摘掉，否则界面按 argv 判形态，切了还在显示命令行词序')
  assert.strictEqual(after.call.text_via, undefined, 'stdin 是 cli 专有的文本入口')
  assert.strictEqual(after.call.args, undefined,
    'call.args 是命令行形态的形状声明：留在 python 名片里保存会被拒')
  assert.strictEqual(after.parameters, undefined,
    '命令行扫出来的合成参数行要一起清掉：名字对不上方法参数，还会长得像可调旋钮')
  assert.deepStrictEqual(after.call.bind, { text: 'tts_text', ref_audio: 'prompt_wav' },
    '绑定名按 python 参数名改写：去掉前缀，原有的下划线保留')
  assert.strictEqual(before.call.kind, 'cli', '原对象被动了')
})

test('切到 cli：构造参数摘掉，绑定名改成命令行开关，argv 给一个起点', () => {
  const before = {
    call: {
      kind: 'python',
      module: 'pkg.api',
      class: 'Model',
      method: 'infer',
      init_args: { model_dir: '{checkpoints}' },
      bind: { text: 'tts_text', ref_audio: 'prompt_wav' },
    },
  }
  const after = withCallKind(before, 'cli')
  assert.strictEqual(after.call.kind, 'cli')
  assert.strictEqual(after.call.module, undefined)
  assert.strictEqual(after.call.class, undefined)
  assert.strictEqual(after.call.method, undefined)
  assert.strictEqual(after.call.init_args, undefined, '构造参数属于 python 形态')
  assert.deepStrictEqual(after.call.argv, ['{engine_python}'], '没有 argv 时给一个能继续填的起点')
  assert.deepStrictEqual(after.call.bind, { text: '--tts-text', ref_audio: '--prompt-wav' })
})

test('切到 cli 时逐块生成不成立：返回方式落回文件', () => {
  const after = withCallKind({ call: { kind: 'python', returns: 'generator' } }, 'cli')
  assert.strictEqual(after.call.returns, 'file',
    '命令行进程结束后只剩文件或字节流，generator 会让宿主走进一个 cli 不存在的分支')
})

test('已经是开关或参数名的绑定不会再被改一遍', () => {
  const py = withCallKind({ call: { kind: 'cli', bind: { text: '--tts_text' } } }, 'python')
  assert.strictEqual(py.call.bind.text, 'tts_text')
  const cli = withCallKind({ call: { kind: 'python', bind: { text: 'tts_text' } } }, 'cli')
  assert.strictEqual(cli.call.bind.text, '--tts-text')
})
