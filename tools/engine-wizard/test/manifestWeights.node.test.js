'use strict'
// 模型权重这一格守的 bug：名片写了 runtime.checkpoints（权重放哪），
//   却没说引擎从哪个参数读它 ⇒ 进程照起、请求照收，读的是上游自己的默认路径，不报错。
// 判据在平台 hostProfile.js 的 weightsProblem；向导的检查器和界面那一格都跟它走。

const { test } = require('node:test')
const assert = require('node:assert')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')
const { weightsProblem } = require(path.join(ROOT, 'lib', 'engines', 'hostProfile.js'))
const { diagnose } = require(path.join(__dirname, '..', 'core', 'validate.js'))
const FIELD = pathToFileURL(path.join(__dirname, '..', 'editor', 'weightsField.js')).href

const base = () => ({
  id: 'demo', label: 'demo', contract_version: 2,
  runtime: { python: 'engines/demo/.venv', entry: '../../lib/engines/host.py', checkpoints: 'engines/demo/checkpoints' },
  call: { module: 'm', class: 'C', method: 'f', bind: { text: 't', ref_audio: 'r', output_path: 'o' }, seed: 'none' },
})
const errFields = (m) => diagnose(m).filter((d) => d.level === 'error').map((d) => d.field)

test('写了权重目录、没交给引擎 ⇒ 平台判缺，检查器报一条必填错误', () => {
  const m = base()
  assert.equal(weightsProblem(m).field, 'call.init_args')
  assert.deepEqual(errFields(m), ['call.init_args'])
})

test('init_args 里有一项带 {checkpoints} ⇒ 不报', () => {
  const m = base(); m.call.init_args = { model_dir: '{checkpoints}/model.pt' }
  assert.equal(weightsProblem(m), null)
  assert.deepEqual(errFields(m), [])
})

test('call.weights = "self" ⇒ 引擎自己找，不报；写别的值 ⇒ 报值不成立', () => {
  const m = base(); m.call.weights = 'self'
  assert.equal(weightsProblem(m), null)
  m.call.weights = 'yes'
  assert.equal(weightsProblem(m).field, 'call.weights')
})

test('没写 runtime.checkpoints ⇒ 没有可交的权重，不要求', () => {
  const m = base(); delete m.runtime.checkpoints
  assert.equal(weightsProblem(m), null)
})

test('cli 形态看 call.argv', () => {
  const m = base()
  m.call = { kind: 'cli', argv: ['{engine_python}', 'run.py'], bind: { text: '--text', ref_audio: '--ref', output_path: '--out' }, seed: 'none' }
  assert.equal(weightsProblem(m).field, 'call.argv')
  m.call.argv.push('--ckpt', '{checkpoints}')
  assert.equal(weightsProblem(m), null)
})

test('界面那一格：读写 init_args 往返，勾「引擎自己找」去掉原参数', async () => {
  const { readWeights, writeWeights } = await import(FIELD)
  let call = { module: 'm', init_args: { device: 'cpu' } }
  assert.deepEqual(readWeights(call), { self: false, name: '', value: '' })
  call = writeWeights(call, { name: 'backbone' })
  assert.deepEqual(call.init_args, { device: 'cpu', backbone: '{checkpoints}' })
  call = writeWeights(call, { name: 'model_dir', value: '{checkpoints}/a.pt' })
  assert.deepEqual(call.init_args, { device: 'cpu', model_dir: '{checkpoints}/a.pt' })
  assert.deepEqual(readWeights(call), { self: false, name: 'model_dir', value: '{checkpoints}/a.pt' })
  call = writeWeights(call, { self: true })
  assert.equal(call.weights, 'self')
  assert.deepEqual(call.init_args, { device: 'cpu' })
  call = writeWeights(call, { self: false, name: 'ckpt' })
  assert.equal(call.weights, undefined)
  assert.equal(call.init_args.ckpt, '{checkpoints}')
})

test('界面那一格：cli 形态改的是 argv 末尾那一对', async () => {
  const { readWeights, writeWeights } = await import(FIELD)
  let call = { kind: 'cli', argv: ['py', 'run.py'] }
  call = writeWeights(call, { name: '--ckpt' })
  assert.deepEqual(call.argv, ['py', 'run.py', '--ckpt', '{checkpoints}'])
  assert.deepEqual(readWeights(call), { self: false, name: '--ckpt', value: '{checkpoints}' })
  call = writeWeights(call, { name: '--model' })
  assert.deepEqual(call.argv, ['py', 'run.py', '--model', '{checkpoints}'])
  call = writeWeights(call, { name: '' })
  assert.deepEqual(call.argv, ['py', 'run.py'])
})
