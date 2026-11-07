'use strict'
// vector 是第六种独立控件：一个大框里按维度分格，不是 number × repeat 的别名。
//
// 派生时 type 必须原样留下，前端才有依据画自己的大框；维度名字要带中英文，
// 因为每个小框的标题按界面语言显示。值按 text 数组收，长度与维度数对齐。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildHostProfile } = require('./hostProfile')
const { coerceIncoming } = require('./paramTable')

const DIMS = [
  { zh: '快乐', en: 'happy' }, { zh: '愤怒', en: 'angry' },
  { zh: '悲伤', en: 'sad' }, { zh: '恐惧', en: 'afraid' },
]

function manifestWith (parameter) {
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
  }
}

// 每个用例写一份临时引擎目录：buildHostProfile 从盘上读名片。
function profileOf (manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-vec-'))
  const engineDir = path.join(dir, 'probe')
  fs.mkdirSync(engineDir, { recursive: true })
  fs.writeFileSync(path.join(engineDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return () => buildHostProfile('probe', {}, { enginesDir: dir, localRoot: dir })
}

const VECTOR = () => ({
  name: 'vec', type: 'vector', tier: 'advanced',
  label: { zh: '情绪向量', en: 'Emotion vector' },
  dim_labels: DIMS,
  suggested_value: ['0', '0', '0.8', '0'],
})

test('vector 派生后仍是 vector：前端据此画大框，不折算成别的控件', () => {
  const p = profileOf(manifestWith(VECTOR()))()
  const f = p.param_schema.find((x) => x.name === 'vec')
  assert.equal(f.type, 'vector')
  assert.equal(f.repeat, 4, '维度数只由 dim_labels 的长度定')
  assert.deepStrictEqual(f.dim_labels, DIMS, '中英文名字原样带下去')
  assert.deepStrictEqual(f.default, ['0', '0', '0.8', '0'])
  assert.deepStrictEqual(f.label, { zh: '情绪向量', en: 'Emotion vector' })
})

test('vector 没给 dim_labels ⇒ 当场拒：维度数没有第二处可以写', () => {
  const bad = VECTOR()
  delete bad.dim_labels
  assert.throws(profileOf(manifestWith(bad)), /dim_labels/)
})

test('vector 只有一维 ⇒ 拒：一维不是多维，用普通类型就够', () => {
  const bad = VECTOR()
  bad.dim_labels = [{ zh: '唯一', en: 'only' }]
  bad.suggested_value = ['0']
  assert.throws(profileOf(manifestWith(bad)), /dim_labels/)
})

test('vector 同时写 repeat ⇒ 拒：两份事实会漂移', () => {
  const bad = VECTOR()
  bad.repeat = 4
  assert.throws(profileOf(manifestWith(bad)), /repeat/)
})

test('维度数与默认值长度不一致 ⇒ 拒：少一维发过去，声音不对而没人知道', () => {
  const bad = VECTOR()
  bad.suggested_value = ['0', '0']
  assert.throws(profileOf(manifestWith(bad)), /长度/)
})

test('旧格式 params.schema 里写 vector 同样认', () => {
  const m = manifestWith(undefined)
  delete m.parameters
  m.params = { load_time: [], call_time: ['vec'], schema: {
    vec: { type: 'vector', dim_labels: DIMS, default: ['0', '0', '0', '0'] },
  } }
  const f = profileOf(m)().param_schema.find((x) => x.name === 'vec')
  assert.equal(f.type, 'vector')
  assert.equal(f.repeat, 4)
})

test('收取侧：按维度收成 text 数组，长度不符整条不要', () => {
  const f = { name: 'vec', type: 'vector', dim_labels: DIMS }
  assert.deepStrictEqual(coerceIncoming(f, ['0.8', '0', '0', '0']), ['0.8', '0', '0', '0'])
  assert.equal(coerceIncoming(f, ['0.8', '0']), undefined)
  assert.equal(coerceIncoming(f, '0.8,0,0,0'), undefined)
})
