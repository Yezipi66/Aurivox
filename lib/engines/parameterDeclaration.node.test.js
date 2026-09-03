'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { deriveParameterViews } = require('./parameterDeclaration')
const { parseParamSchema } = require('./profile')

test('一份 parameters 同时派生 UI、调用白名单和生命周期集合', () => {
  const m = deriveParameterViews({ id: 'demo', parameters: [
    { name: 'temperature', type: 'number', phase: 'call', suggested_value: 0.7,
      tier: 'advanced', label: { zh: '温度', en: 'Temperature' } },
    { name: 'use_fp16', type: 'boolean', phase: 'load', suggested_value: true },
  ] })
  assert.deepEqual(m.param_keys, ['temperature', 'use_fp16'])
  assert.deepEqual(m.payload_keys, ['temperature'])
  assert.deepEqual(m.params.call_time, ['temperature'])
  assert.deepEqual(m.params.load_time, ['use_fp16'])
  assert.deepEqual(m.defaults, {})
  assert.equal(m.params.schema.temperature.default, 0.7)
  assert.equal(m.params.schema.temperature.tier, 'advanced')
  assert.deepEqual(m.params.schema.temperature.label, { zh: '温度', en: 'Temperature' })
})

test('suggested_value 只派生 UI 初值，绝不派生平台 defaults', () => {
  const m = deriveParameterViews({ id: 'demo', parameters: [
    { name: 'verbose', type: 'boolean', suggested_value: false },
    { name: 'seed', type: 'number', suggested_value: 0 },
  ] })
  assert.deepEqual(m.defaults, {})
  assert.deepEqual(m.params.schema.verbose.default, false)
  assert.deepEqual(m.params.schema.seed.default, 0)
})

test('新版 parameters 与旧重复字段不能并存', () => {
  for (const legacy of ['param_keys', 'payload_keys', 'params', 'defaults', 'defaults_env']) {
    assert.throws(() => deriveParameterViews({ id: 'demo', parameters: [], [legacy]: {} }),
      err => err.code === 'ENGINE_MANIFEST_INVALID_VALUE' && err.message.includes(legacy))
  }
})

test('重复参数名、空名字和未知 phase 都明确拒绝', () => {
  assert.throws(() => deriveParameterViews({ id: 'x', parameters: [
    { name: 'a', type: 'text' }, { name: 'a', type: 'number' },
  ] }), /重复声明/)
  assert.throws(() => deriveParameterViews({ id: 'x', parameters: [{ name: '', type: 'text' }] }), /非空字符串/)
  assert.throws(() => deriveParameterViews({ id: 'x', parameters: [{ name: 'a', type: 'text', phase: 'sometimes' }] }), /call 或 load/)
})

test('没有 parameters 的旧名片原样返回，真实引擎迁移前行为不变', () => {
  const old = { id: 'legacy', param_keys: ['x'], params: { call_time: ['x'] } }
  assert.strictEqual(deriveParameterViews(old), old)
})

test('suggested_value 可省略，平台不编造初值', () => {
  const m = deriveParameterViews({ id: 'demo', parameters: [
    { name: 'temperature', type: 'number' },
  ] })
  assert.equal(Object.hasOwn(m.params.schema.temperature, 'default'), false)
})

test('text 是特殊核心输入，只映射机器名，不进入普通参数', () => {
  const m = deriveParameterViews({ id: 'demo', input: { text: { parameter: 'tts_text' } }, parameters: [
    { name: 'temperature', type: 'number' },
  ] })
  assert.deepEqual(m.maps, { text: 'tts_text' })
  assert.deepEqual(m.param_keys, ['temperature'])
  assert.throws(() => deriveParameterViews({ id: 'demo', input: { text: 'tts_text' }, parameters: [
    { name: 'tts_text', type: 'text' },
  ] }), /不应重复出现在 parameters/)
})

test('新版 input 与旧 maps 不能并存', () => {
  assert.throws(() => deriveParameterViews({ id: 'demo', input: { text: 'tts_text' }, maps: { text: 'text' } }),
    err => err.code === 'ENGINE_MANIFEST_INVALID_VALUE' && err.message.includes('maps'))
})


test('新版无 suggested_value 的参数可通过现有 profile 解析器', () => {
  const m = deriveParameterViews({ id: 'demo', parameters: [
    { name: 'temperature', type: 'number' },
  ] })
  const schema = parseParamSchema(m, m.defaults)
  assert.equal(schema.length, 1)
  assert.equal(schema[0].name, 'temperature')
  assert.equal(schema[0].type, 'number')
  assert.equal(Object.hasOwn(schema[0], 'default'), false)
})
