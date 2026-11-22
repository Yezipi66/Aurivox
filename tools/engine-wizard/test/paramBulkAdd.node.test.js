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

const { addParamsFromScan, syncParamsFromScan } = drop

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

test('一次加入：只进了 call.args 当命令行映射的开关仍可做成旋钮', () => {
  // 扫描会把入口文件的开关全写进 call.args（flag + style），那只是命令行映射，
  //   不代表已经有格子。拿「args 里有没有」当判据会把所有可调参数一起排除掉。
  const m = {
    id: 'x',
    call: { kind: 'cli', args: { speed: { flag: '--speed', style: 'value' } }, bind: { text: '--text' } },
  }
  const pool = [{ source: 'cli', name: 'speed', target: '--speed', kind: 'float', style: 'value' }]
  const r = addParamsFromScan(m, pool)
  assert.deepStrictEqual(r.added, ['speed'])
  assert.strictEqual(r.manifest.parameters[0].name, 'speed')
})

// 扫描写回的整表同步：python 形态重扫后，上一轮 cli 扫出来的行不能留在表里。
test('整表同步：清掉人没碰过、本次没扫到的旧形态行', () => {
  const old = (name) => ({
    name, tier: 'common', type: 'file',
    label: { en: name, zh: '' },
    help: { zh: 'upstream words', en: 'upstream words' },
  })
  const m = {
    id: 'x',
    call: { kind: 'python' },
    parameters: [old('dst_model'), old('src_path'), old('val_best')],
  }
  // python 方法签名：只有 speed 落进来，其余是上次 cli 扫描的残留
  const pool = [
    { source: 'python', name: 'speed', kind: 'number', phase: 'call' },
    { source: 'python', name: 'stream', kind: 'boolean', phase: 'call' },
  ]
  const r = syncParamsFromScan(m, pool)
  assert.deepStrictEqual(r.removed.sort(), ['dst_model', 'src_path', 'val_best'])
  assert.deepStrictEqual(r.added.sort(), ['speed', 'stream'])
  assert.deepStrictEqual(
    r.manifest.parameters.map((p) => p.name).sort(), ['speed', 'stream'])
})

test('整表同步：人填过中文名或改过说明的行不动', () => {
  const hand = { name: 'kept', tier: 'common', type: 'text',
    label: { en: 'kept', zh: '人填的中文名' }, help: { zh: '人写的说明', en: 'own words' } }
  const stale = { name: 'gone', tier: 'common', type: 'text',
    label: { en: 'gone', zh: '' }, help: { zh: '', en: '' } }
  const m = { id: 'x', call: { kind: 'python' }, parameters: [hand, stale] }
  const r = syncParamsFromScan(m, [{ source: 'python', name: 'speed', kind: 'number' }])
  assert.deepStrictEqual(r.removed, ['gone'])
  assert.strictEqual(r.manifest.parameters[0].zh, undefined)
  assert.ok(r.manifest.parameters.some((p) => p.name === 'kept' && p.label.zh === '人填的中文名'))
})

// 形态标记：这一行从哪个入口形态扫出来的，写回时按它清场，不靠猜。
test('扫描行写入形态标记；python-static 归一成 python', () => {
  const cliRow = drop.applyScanShape({}, { source: 'cli', name: 'speed', kind: 'float' })
  const pyRow = drop.applyScanShape({}, { source: 'python', name: 'speed', kind: 'float' })
  const staticRow = drop.applyScanShape({}, { source: 'python-static', name: 'speed', kind: 'float' })
  assert.strictEqual(cliRow.scan_kind, 'cli')
  assert.strictEqual(pyRow.scan_kind, 'python')
  assert.strictEqual(staticRow.scan_kind, 'python', '静态反射与 import 反射是同一形态，不能分成两种')
})

test('带 cli 标记的异形态行删掉；manual 行不动', () => {
  const cli = { name: 'dst_model', scan_kind: 'cli', tier: 'common', type: 'file',
    label: { en: 'dst_model', zh: '' }, help: { zh: '', en: '' } }
  const hand = { name: 'my_own', scan_kind: 'manual', tier: 'common', type: 'number',
    label: { en: 'my_own', zh: '我加的' }, help: { zh: '自己的说明', en: 'own words' } }
  const m = { id: 'x', call: { kind: 'python' }, parameters: [cli, hand] }
  const r = syncParamsFromScan(m, [{ source: 'python', name: 'speed', kind: 'number' }])
  assert.deepStrictEqual(r.removed, ['dst_model'])
  const kept = r.manifest.parameters.find((p) => p.name === 'my_own')
  assert.ok(kept, 'manual 行不删')
  assert.strictEqual(kept.label.zh, '我加的', 'manual 行的字段一个不动')
})

test('本次扫到的无标记存量行顺手补形态，名片扫一次就升级', () => {
  const legacy = { name: 'speed', tier: 'common', type: 'number',
    label: { en: 'speed', zh: '' }, help: { zh: '', en: '' } }
  const m = { id: 'x', call: { kind: 'python' }, parameters: [legacy] }
  const r = syncParamsFromScan(m, [{ source: 'python', name: 'speed', kind: 'number' }])
  assert.strictEqual(r.manifest.parameters[0].scan_kind, 'python')
  assert.deepStrictEqual(r.removed, [])
})

test('manual 行不被扫描补全改写来源', () => {
  const row = { name: 'speed', scan_kind: 'manual', type: 'text',
    label: { en: 'speed', zh: '我自己定的' } }
  const out = drop.applyScanShape(row, { source: 'python', name: 'speed', kind: 'number' })
  assert.strictEqual(out.scan_kind, 'manual')
  assert.strictEqual(out.label.zh, '我自己定的')
})

test('无标记存量行：人改过的补 manual，人没碰过且本次没扫到的删', () => {
  const hand = { name: 'tuned', tier: 'common', type: 'number',
    label: { en: 'tuned', zh: '我调过' }, help: { zh: '', en: '' } }
  const stale = { name: 'old_flag', tier: 'common', type: 'file',
    label: { en: 'old_flag', zh: '' }, help: { zh: '', en: '' } }
  const m = { id: 'x', call: { kind: 'python' }, parameters: [hand, stale] }
  const r = syncParamsFromScan(m, [{ source: 'python', name: 'speed', kind: 'number' }])
  assert.deepStrictEqual(r.removed, ['old_flag'])
  const tuned = r.manifest.parameters.find((p) => p.name === 'tuned')
  assert.strictEqual(tuned.scan_kind, 'manual', '人改过的归 manual，不再被下次重扫删掉')
})

test('归属判据：python 的 bind 参数按 name 认，不在合成表里再做一行', () => {
  const m = { id: 'x', call: {
    kind: 'python',
    bind: { text: 'tts_text', ref_audio: 'prompt_wav', ref_text: 'prompt_text' },
  } }
  for (const name of ['tts_text', 'prompt_wav', 'prompt_text']) {
    assert.strictEqual(drop.isParamTaken(m, { source: 'python', name, kind: 'text' }), true,
      name + ' 已在必填区有格子，不能再进合成表')
  }
  assert.strictEqual(drop.isParamTaken(m, { source: 'python', name: 'speed', kind: 'number' }), false,
    'speed 没进任何格子，该留在合成表')
})

test('归属判据：cli 的 bind 仍按开关名认，不受 python 分支影响', () => {
  const m = { id: 'x', call: { kind: 'cli', bind: { text: '--prompt_text' } } }
  assert.strictEqual(drop.isParamTaken(m,
    { source: 'cli', name: 'prompt_text', target: '--prompt_text', kind: 'str' }), true)
})

test('扫描写回：bind 接管的 python 参数不重复进表', () => {
  const m = { id: 'x', call: {
    kind: 'python',
    bind: { text: 'tts_text', ref_audio: 'prompt_wav', ref_text: 'prompt_text' },
  } }
  const pool = [
    { source: 'python', name: 'tts_text', kind: 'text' },
    { source: 'python', name: 'prompt_text', kind: 'text' },
    { source: 'python', name: 'prompt_wav', kind: 'file' },
    { source: 'python', name: 'speed', kind: 'number' },
  ]
  const r = addParamsFromScan(m, pool)
  assert.deepStrictEqual(r.added, ['speed'], '只有没被 bind 接管的 speed 进表')
})

test('整表同步：bind 接管的行从合成表清掉，manual 的同名行留住', () => {
  const bound = { name: 'tts_text', scan_kind: 'python', tier: 'common', type: 'text',
    label: { en: 'tts_text', zh: '' }, help: { zh: '', en: '' } }
  const hand = { name: 'prompt_text', scan_kind: 'manual', tier: 'common', type: 'text',
    label: { en: 'prompt_text', zh: '我改过' }, help: { zh: '我自己写的', en: 'mine' } }
  const m = { id: 'x', call: {
    kind: 'python',
    bind: { text: 'tts_text', ref_text: 'prompt_text' },
  }, parameters: [bound, hand] }
  const r = syncParamsFromScan(m, [
    { source: 'python', name: 'tts_text', kind: 'text' },
    { source: 'python', name: 'prompt_text', kind: 'text' },
    { source: 'python', name: 'speed', kind: 'number' },
  ])
  assert.ok(r.removed.includes('tts_text'), 'bind 接管的自动清掉')
  assert.ok(!r.removed.includes('prompt_text'), 'manual 优先，bind 也不动它')
  assert.ok(r.manifest.parameters.some((p) => p.name === 'prompt_text'))
  assert.deepStrictEqual(r.added, ['speed'])
})
