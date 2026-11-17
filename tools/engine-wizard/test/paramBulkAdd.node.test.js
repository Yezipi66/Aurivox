'use strict'
// 第 4 步「把列出的参数一次全部加进来」：与逐个拖入走同一条路，
// 该补的类型、英文名、命令行开关一致，已有的行一条不动。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const { esbuild } = require('../../../lib/testDeps.js')

function load (file, deps) {
  const code = esbuild().transformSync(fs.readFileSync(path.join(EDITOR, file), 'utf8'), {
    loader: 'js', format: 'cjs', target: 'node18',
  }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, (id) => {
    if (deps && deps[id]) return deps[id]
    throw new Error(file + ' 不该求值依赖：' + id)
  }, mod)
  return mod.exports
}

const typeMod = load('paramType.js')
const shapeMod = load('paramShape.js')
const fieldsMod = load('paramFields.js')
const drop = load('paramDrop.js', {
  './paramType.js': typeMod,
  './paramShape.js': shapeMod,
  './paramFields.js': fieldsMod,
})

const { addParamsFromScan } = drop

// 左栏列出的那一组：一个路径、一个数字、一个布尔
const POOL = [
  { source: 'cli', name: 'model-dir', target: '--model-dir', kind: 'str', style: 'value', help: 'path to the model folder' },
  { source: 'cli', name: 'num-step', target: '--num-step', kind: 'int', style: 'value' },
  { source: 'cli', name: 'normalize', target: '--normalize', kind: 'bool', style: 'boolean' },
]

test('一次加入：三条都进来，类型与英文名照单条拖入的规矩填', () => {
  const m = { id: 'x', call: { kind: 'cli', argv: ['{engine_python}', '-m', 'x.cli'], args: {} } }
  const r = addParamsFromScan(m, POOL)
  assert.deepStrictEqual(r.added, ['model-dir', 'num-step', 'normalize'])
  const rows = r.manifest.parameters
  assert.strictEqual(rows.length, 3)
  assert.strictEqual(rows[0].type, 'file', '路径参数应当成为文件控件')
  assert.strictEqual(rows[0].label.en, 'model-dir', '英文名取参数名')
  assert.strictEqual(rows[1].type, 'number')
  assert.strictEqual(rows[2].type, 'boolean')
  // 命令行开关：每条都要落到 call.args，否则宿主启动前会拒收整张名片
  const args = r.manifest.call.args
  assert.strictEqual(args['model-dir'].flag, '--model-dir')
  assert.strictEqual(args['num-step'].flag, '--num-step')
  assert.strictEqual(args.normalize.style, 'boolean', '布尔开关不收值，样式要跟着定')
})

test('一次加入：名片里已有的行原样保留，不重复加也不改类型', () => {
  const m = {
    id: 'x',
    parameters: [{ name: 'model-dir', type: 'select', tier: 'advanced', choices: [{ value: 'a' }] }],
    call: { kind: 'cli', args: { 'model-dir': { flag: '--model-dir', style: 'value' } } },
  }
  const r = addParamsFromScan(m, POOL)
  assert.deepStrictEqual(r.added, ['num-step', 'normalize'])
  const first = r.manifest.parameters[0]
  assert.strictEqual(first.type, 'select', '人挑过的类型不能被这次加入盖掉')
  assert.strictEqual(first.tier, 'advanced')
  assert.strictEqual(r.manifest.parameters.length, 3)
})

test('一次加入：新行排在已有行之后，顺序按左栏列出的次序', () => {
  const m = { id: 'x', parameters: [{ name: 'z-last', type: 'text', tier: 'common' }], call: { kind: 'cli', args: {} } }
  const r = addParamsFromScan(m, POOL)
  assert.deepStrictEqual(r.manifest.parameters.map((p) => p.name),
    ['z-last', 'model-dir', 'num-step', 'normalize'])
})

test('一次加入：空清单不动名片', () => {
  const m = { id: 'x', parameters: [{ name: 'a', type: 'text' }] }
  const r = addParamsFromScan(m, [])
  assert.deepStrictEqual(r.added, [])
  assert.strictEqual(r.manifest, m)
})

test('一次加入：换引擎后的空壳名片没有 call 段，cli 开关名不能丢', () => {
  // 切换引擎后名片只剩 id：没有 call，applyParamDrop 就没处写开关名，
  //   界面上那一列会全是空白的 --argv。
  const shell = { id: 'piper', label: 'piper', contract_version: 2 }
  const r = addParamsFromScan(shell, POOL)
  assert.deepStrictEqual(r.added, ['model-dir', 'num-step', 'normalize'])
  assert.strictEqual(r.manifest.call.kind, 'cli', 'cli 参数要有一个命令行段来接开关名')
  assert.strictEqual(r.manifest.call.args['model-dir'].flag, '--model-dir')
  assert.strictEqual(r.manifest.call.args.normalize.style, 'boolean')
})

test('一次加入：python 形态的参数不凭空立一个 cli 命令行段', () => {
  const shell = { id: 'x' }
  const py = [{ source: 'python', name: 'speed', kind: 'float' }]
  const r = addParamsFromScan(shell, py)
  assert.deepStrictEqual(r.added, ['speed'])
  assert.strictEqual(r.manifest.call, undefined, 'python 形态没有命令行可写')
})

test('一次加入：已经由槽位接管的开关不再做成旋钮', () => {
  // 辅助参考音频走 call.args 的 role，正文 / 参考音频等走 call.bind：
  //   两者各有自己的格子，再做一格就是同一个开关在界面上出现两次。
  const m = {
    id: 'x',
    call: {
      kind: 'cli',
      args: { 'emotion-audio': { flag: '--emotion-audio', style: 'value', role: 'audio_ref' } },
      bind: { text: '--text', output_path: '--output' },
    },
  }
  const pool = [
    { source: 'cli', name: 'emotion-audio', target: '--emotion-audio', kind: 'str', style: 'value' },
    { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value' },
    { source: 'cli', name: 'output', target: '--output', kind: 'str', style: 'value' },
    { source: 'cli', name: 'speed', target: '--speed', kind: 'float', style: 'value' },
  ]
  const r = addParamsFromScan(m, pool)
  assert.deepStrictEqual(r.added, ['speed'], '只该加真正是旋钮的那一个')
  assert.deepStrictEqual(r.manifest.parameters.map((p) => p.name), ['speed'])
  assert.strictEqual(r.manifest.call.args['emotion-audio'].role, 'audio_ref',
    '槽位那条原样保留，不能被改写成参数')
})

test('一次加入：槽位判定认 name 也认开关名', () => {
  const m = {
    id: 'x',
    call: { kind: 'cli', args: { 'ref-audio': { flag: '--voice', role: 'audio_ref' } }, bind: { ref_text: '--emotion-text' } },
  }
  const pool = [
    // 名片里键叫 ref-audio，扫描到的开关是 --voice：按 role 那条的 flag 认
    { source: 'cli', name: 'voice', target: '--voice', kind: 'str', style: 'value' },
    // bind 里只写了开关名，扫描到的参数名是 emotion-text
    { source: 'cli', name: 'emotion-text', target: '--emotion-text', kind: 'str', style: 'value' },
    { source: 'cli', name: 'force', target: '--force', kind: 'bool', style: 'boolean' },
  ]
  const r = addParamsFromScan(m, pool)
  assert.deepStrictEqual(r.added, ['force'])
})
