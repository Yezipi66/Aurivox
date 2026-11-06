'use strict'
// 多维参数的声明：type "vector"。
//
// 它不是一个新控件形状，是「一项若干同类型的值、每维一个名字」的写法。
// 派生时折成 item × repeat，之后与手写 repeat 的名片走同一条路。
// 这里验的就是这条折算：折错了一处，名片存得下、界面画得出，但值发不到引擎。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildHostProfile } = require('./hostProfile')

const DIMS = ['happy', 'angry', 'sad', 'afraid', 'disgusted', 'melancholic', 'surprised', 'calm']

function manifestWith (parameter, extra = {}) {
  return {
    contract_version: 2,
    id: 'probe',
    label: 'Probe',
    runtime: {
      python: 'engines/probe/.venv',
      entry: '../../lib/engines/host.py',
      args: ['--profile-json', '{profile_json}', '--host', '{host}', '--port', '{port}'],
      cwd: '.',
      checkpoints: 'engines/probe/checkpoints',
    },
    capabilities: { requires_reference_audio: false, streaming: false, output_sample_rate: 22050 },
    call: {
      kind: 'cli',
      argv: ['{engine_python}', '-m', 'probe', '--model-dir', '{checkpoints}'],
      bind: { text: '--text', output_path: '--out' },
      returns: 'file',
      seed: 'none',
      args: {
        text: { flag: '--text', style: 'value' },
        output_path: { flag: '--out', style: 'value' },
        vec: { flag: '--vec', style: 'join', join: ',' },
      },
    },
    weights: [],
    parameters: [parameter],
    ...extra,
  }
}

// 每个用例写一份临时引擎目录：buildHostProfile 是从盘上读名片的。
function profileOf (manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-vec-'))
  const engineDir = path.join(dir, 'probe')
  fs.mkdirSync(engineDir, { recursive: true })
  fs.writeFileSync(path.join(engineDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return () => buildHostProfile('probe', {}, { enginesDir: dir, localRoot: dir })
}

test('vector 声明折成 item × repeat：维度数就是 dim_labels 的长度', () => {
  const p = profileOf(manifestWith({
    name: 'vec', type: 'vector', item: 'number', tier: 'advanced',
    dim_labels: DIMS, suggested_value: [0, 0, 0.8, 0, 0, 0, 0, 0],
  }))()
  const f = p.param_schema.find((x) => x.name === 'vec')
  assert.equal(f.type, 'number', '每一维是数，派生后按数字收值')
  assert.equal(f.repeat, 8, '八维八个格子')
  assert.deepStrictEqual(f.dim_labels.map((d) => d.en), DIMS, '名字原样带下去')
  assert.deepStrictEqual(f.default, [0, 0, 0.8, 0, 0, 0, 0, 0])
})

test('item 没写时每一维按数字：向量最常见的样子是强度', () => {
  const p = profileOf(manifestWith({
    name: 'vec', type: 'vector', dim_labels: ['a', 'b'], suggested_value: [0, 0],
  }))()
  assert.equal(p.param_schema.find((x) => x.name === 'vec').type, 'number')
})

test('item 写别的类型也认：派生后就是那个类型的一排', () => {
  const p = profileOf(manifestWith({
    name: 'vec', type: 'vector', item: 'text', dim_labels: ['a', 'b'],
    suggested_value: ['x', 'y'],
  }))()
  assert.equal(p.param_schema.find((x) => x.name === 'vec').type, 'text')
})

test('vector 没给 dim_labels ⇒ 当场拒：维度数没有第二处可以写', () => {
  const build = profileOf(manifestWith({
    name: 'vec', type: 'vector', item: 'number', suggested_value: [0, 0],
  }))
  assert.throws(build, /dim_labels/)
})

test('vector 只有一维 ⇒ 拒：一维不是多维，用普通类型就够', () => {
  const build = profileOf(manifestWith({
    name: 'vec', type: 'vector', item: 'number', dim_labels: ['only'], suggested_value: [0],
  }))
  assert.throws(build, /dim_labels/)
})

test('vector 同时写 repeat ⇒ 拒：两份事实会漂移', () => {
  const build = profileOf(manifestWith({
    name: 'vec', type: 'vector', item: 'number', repeat: 8,
    dim_labels: DIMS, suggested_value: new Array(8).fill(0),
  }))
  assert.throws(build, /repeat/)
})

test('维度数与默认值长度不一致 ⇒ 拒：少一维发过去，引擎照收，声音不对而没人知道', () => {
  const build = profileOf(manifestWith({
    name: 'vec', type: 'vector', item: 'number', dim_labels: DIMS,
    suggested_value: [0, 0, 0.8],
  }))
  assert.throws(build, /长度/)
})

test('旧格式 params.schema 里写 vector 同样认：两条派生路只有一条换算', () => {
  const m = manifestWith(undefined)
  delete m.parameters
  m.params = { load_time: [], call_time: ['vec'], schema: {
    vec: { type: 'vector', item: 'number', dim_labels: DIMS, default: new Array(8).fill(0) },
  } }
  const p = profileOf(m)()
  const f = p.param_schema.find((x) => x.name === 'vec')
  assert.equal(f.repeat, 8)
  assert.equal(f.type, 'number')
})
