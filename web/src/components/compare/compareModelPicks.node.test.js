// 对比页模型轴的纯函数测试：组合上限、请求体权重字段、旧本地存储的迁移、参考位。
// 夹具用编出来的位名与参数名，不写任何真实引擎 id 或位名。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MODEL_COMBO_LIMIT, modelCombos, slotItemText, referenceSlotOf, referenceVoiceOf,
  weightRequestFields, normalizeRowModel,
} from './compareModelPicks.pure.js'

const slot = (name, extra = {}) => ({ name, label: name.toUpperCase(), ...extra })
const item = (path, extra = {}) => ({ path, name: path.split('/').pop(), ...extra })

const TWO_SLOT = [
  slot('alpha', { param: 'alpha_model', applies_at: 'call' }),
  slot('beta', { param: 'beta_model', applies_at: 'call' }),
]
const FAKE_THREE = [
  slot('alpha', { param: 'alpha_model', applies_at: 'call' }),
  slot('frozen', { applies_at: 'launch' }),
  slot('beta', { param: 'beta_model', applies_at: 'call' }),
]

test('两槽位按笛卡尔积，组合数与旧下拉相同', () => {
  const lists = {
    alpha: [item('/m/a1'), item('/m/a2'), item('/m/a3')],
    beta: [item('/m/b1'), item('/m/b2')],
  }
  const { combos, total, dropped } = modelCombos(TWO_SLOT, lists)
  assert.equal(total, 6)
  assert.equal(combos.length, 6)
  assert.equal(dropped, 0)
  assert.deepEqual(combos[0].picks, { alpha: '/m/a1', beta: '/m/b1' })
  assert.deepEqual(combos[5].picks, { alpha: '/m/a3', beta: '/m/b2' })
  assert.equal(combos[0].items.alpha.name, 'a1')
})

test('三个槽位也按笛卡尔积，每组三个位都有选择', () => {
  const lists = {
    alpha: [item('/m/a1'), item('/m/a2')],
    frozen: [item('/m/f1'), item('/m/f2')],
    beta: [item('/m/b1'), item('/m/b2')],
  }
  const { combos, total } = modelCombos(FAKE_THREE, lists)
  assert.equal(total, 8)
  assert.equal(combos.length, 8)
  for (const c of combos) {
    assert.deepEqual(Object.keys(c.picks).sort(), ['alpha', 'beta', 'frozen'])
  }
})

test('超过上限时截断，并报出被丢弃的数量', () => {
  const four = (prefix) => Array.from({ length: 4 }, (_, i) => item(`/m/${prefix}${i}`))
  const lists = { alpha: four('a'), frozen: four('f'), beta: four('b') }
  const { combos, total, dropped } = modelCombos(FAKE_THREE, lists)
  assert.equal(total, 64)
  assert.equal(combos.length, MODEL_COMBO_LIMIT)
  assert.equal(dropped, 64 - MODEL_COMBO_LIMIT)
})

test('任一位没有候选时一个组合都不造，也不报出丢弃数', () => {
  const { combos, total, dropped } = modelCombos(TWO_SLOT, { alpha: [item('/m/a1')], beta: [] })
  assert.deepEqual(combos, [])
  assert.equal(total, 0)
  assert.equal(dropped, 0)
  assert.deepEqual(modelCombos([], {}), { combos: [], total: 0, dropped: 0 })
})

test('两槽位的权重字段与旧请求体逐键相同', () => {
  const fields = weightRequestFields(TWO_SLOT, { alpha: '/m/a.ckpt', beta: '/m/b.pth' })
  assert.deepEqual(fields.params, { alpha_model: '/m/a.ckpt', beta_model: '/m/b.pth' })
  assert.deepEqual(fields.launch_weights, {})
  const legacy = { voice: 'A', alpha_model: '/m/a.ckpt', beta_model: '/m/b.pth' }
  assert.deepEqual({ voice: 'A', ...fields.params }, legacy)
})

test('非两槽位的引擎：call 位按参数名平铺，launch 位交给平台', () => {
  const fields = weightRequestFields(FAKE_THREE, {
    alpha: '/m/a.bin', frozen: '/m/frozen-dir', beta: '/m/b.bin',
  })
  assert.deepEqual(fields.params, { alpha_model: '/m/a.bin', beta_model: '/m/b.bin' })
  assert.deepEqual(fields.launch_weights, { frozen: '/m/frozen-dir' })
  assert.deepEqual(weightRequestFields(FAKE_THREE, {}), { params: {}, launch_weights: {} })
})

test('旧 rowModels 形状迁移到 picks 与 owners，重复归一结果不变', () => {
  const old = {
    voiceId: 'A',
    gptCheckpoint: '/m/a.ckpt',
    sovitsModel: '/m/b.pth',
    gptVoiceId: 'B',
    sovitsVoiceId: '',
    mix: true,
  }
  const migrated = normalizeRowModel(old)
  assert.deepEqual(migrated, {
    voiceId: 'A',
    picks: { gpt: '/m/a.ckpt', sovits: '/m/b.pth' },
    owners: { gpt: 'B' },
    mix: true,
  })
  assert.deepEqual(normalizeRowModel(migrated), migrated)
  assert.deepEqual(normalizeRowModel(null), { voiceId: '', picks: {}, owners: {}, mix: false })
})

test('参考位是第一个带 param 的位；没有这样的位时为空', () => {
  assert.equal(referenceSlotOf(TWO_SLOT), 'alpha')
  const launchFirst = [slot('frozen', { applies_at: 'launch' }), slot('beta', { param: 'beta_model' })]
  assert.equal(referenceSlotOf(launchFirst), 'beta')
  assert.equal(referenceSlotOf([]), '')
})

test('参考侧角色优先取该位的跨角色归属，否则用主角色或回退值', () => {
  assert.equal(referenceVoiceOf({ voiceId: 'A', owners: {} }, TWO_SLOT, 'fallback'), 'A')
  assert.equal(referenceVoiceOf({ voiceId: 'A', owners: { alpha: 'B' } }, TWO_SLOT, 'fallback'), 'B')
  assert.equal(referenceVoiceOf(null, TWO_SLOT, 'fallback'), 'fallback')
})

test('候选项文字保留版本与步数，名称缺失时退回路径', () => {
  assert.equal(slotItemText({ name: 'w', version: 'v2', steps: 8 }), 'w [v2] (8)')
  assert.equal(slotItemText({ path: '/m/only-path' }), '/m/only-path')
  assert.equal(slotItemText(null), '')
})
