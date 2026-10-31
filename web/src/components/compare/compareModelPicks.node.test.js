// 对比页模型轴的纯函数测试：逐位候选、默认选择、请求体权重字段、旧行模型按位置迁移、参考位。
// 夹具用编出来的位名与参数名，不写任何真实引擎 id 或位名。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  slotItemText, slotHeaderText, voiceEntry, slotOptions, ownerOfModel, modelItem,
  defaultPicksOf, candidatePathsBySlot, referenceSlotOf, referenceVoiceOf,
  compareWeightBody, normalizeRowModel,
} from './compareModelPicks.pure.js'
import { migrateRowModelShape } from '../../lib/compareRowMigrate.js'

const slot = (name, extra = {}) => ({ name, label: name.toUpperCase(), ...extra })
const item = (path, extra = {}) => ({ path, name: path.split('/').pop(), ...extra })

const ENGINE_ID = 'fake-engine'
const TWO_SLOT = [
  slot('alpha', { param: 'alpha_model', applies_at: 'call' }),
  slot('beta', { param: 'beta_model', applies_at: 'call' }),
]
const FAKE_THREE = [
  slot('alpha', { param: 'alpha_model', applies_at: 'call' }),
  slot('frozen', { applies_at: 'launch' }),
  slot('beta', { param: 'beta_model', applies_at: 'call' }),
]
// 位名与旧界面的两个字段名完全不同的两位引擎：旧行数据靠位置对它迁移。
const ALT_TWO = [
  slot('encoder', { param: 'encoder_weight', applies_at: 'call' }),
  slot('decoder', { param: 'decoder_weight', applies_at: 'call' }),
]

// meta.assets.models = { <引擎id>: { <位名>: [候选项] } }
const meta = (bySlot) => ({ display_name: '小美', language: 'ja', assets: { models: { [ENGINE_ID]: bySlot } } })
const many = (prefix, n) => Array.from({ length: n }, (_, i) => item(`/m/${prefix}${i + 1}`))
const withDefaultAt = (list, index) => list.map((it, i) => (i === index ? { ...it, default: true } : it))

//  候选：每个角色每个位一份清单，不做组合展开

test('⭐⭐ 候选按位各自成清单：5 × 6 时每一个 alpha 都在候选里', () => {
  const entry = voiceEntry(TWO_SLOT, ENGINE_ID, meta({
    alpha: many('a', 5),
    beta: many('b', 6),
  }), 'A')
  assert.deepEqual(entry.itemsBySlot.alpha.map(i => i.path),
    ['/m/a1', '/m/a2', '/m/a3', '/m/a4', '/m/a5'])
  assert.equal(entry.itemsBySlot.beta.length, 6)
  assert.equal(slotOptions([entry], 'alpha', 'A').length, 5)
  assert.equal(slotOptions([entry], 'beta', 'A').length, 6)
  assert.equal(entry.voiceName, '小美')
  assert.equal(entry.language, 'ja')
})

test('候选清单与角色一一对应：不做笛卡尔积，位数增多也不膨胀', () => {
  const entry = voiceEntry(FAKE_THREE, ENGINE_ID, meta({
    alpha: many('a', 4), frozen: many('f', 4), beta: many('b', 4),
  }), 'A')
  assert.equal(Object.keys(entry.itemsBySlot).length, 3)
  assert.equal(candidatePathsBySlot([entry]).alpha.size, 4)
  assert.deepEqual(Object.keys(candidatePathsBySlot([entry])).sort(), ['alpha', 'beta', 'frozen'])
})

test('任一位没有候选时这个角色不成立（缺一个位的行必然缺权重）', () => {
  assert.equal(voiceEntry(TWO_SLOT, ENGINE_ID, meta({ alpha: many('a', 2), beta: [] }), 'A'), null)
  assert.equal(voiceEntry(TWO_SLOT, ENGINE_ID, meta({ alpha: many('a', 2) }), 'A'), null)
  assert.equal(voiceEntry([], ENGINE_ID, meta({ alpha: many('a', 2) }), 'A'), null)
})

test('default 标记：所有位都带 default 候选才算这个角色有推荐默认组合', () => {
  const both = voiceEntry(TWO_SLOT, ENGINE_ID, meta({
    alpha: withDefaultAt(many('a', 3), 0), beta: withDefaultAt(many('b', 2), 1),
  }), 'A')
  assert.equal(both.default, true)
  const onlyOne = voiceEntry(TWO_SLOT, ENGINE_ID, meta({
    alpha: withDefaultAt(many('a', 3), 0), beta: many('b', 2),
  }), 'A')
  assert.equal(onlyOne.default, false)
})

//  默认选择：保持「各位都 default 否则各位第一项」的旧语义

test('⭐⭐ 每个位都有 default ⇒ 取各位的 default', () => {
  const entry = voiceEntry(TWO_SLOT, ENGINE_ID, meta({
    alpha: withDefaultAt(many('a', 3), 2), beta: withDefaultAt(many('b', 2), 1),
  }), 'A')
  assert.deepEqual(defaultPicksOf(TWO_SLOT, entry), { alpha: '/m/a3', beta: '/m/b2' })
})

test('⭐ 只有一个位带 default 时不取它：退回各位第一项（旧界面取第一组）', () => {
  const entry = voiceEntry(TWO_SLOT, ENGINE_ID, meta({
    alpha: withDefaultAt(many('a', 3), 2), beta: many('b', 2),
  }), 'A')
  assert.deepEqual(defaultPicksOf(TWO_SLOT, entry), { alpha: '/m/a1', beta: '/m/b1' })
})

test('默认选择与角色查询：找不到角色或位时返回空，不返回 undefined', () => {
  const entry = voiceEntry(TWO_SLOT, ENGINE_ID, meta({ alpha: many('a', 2), beta: many('b', 2) }), 'A')
  const models = [entry]
  assert.deepEqual(defaultPicksOf(TWO_SLOT, undefined), {})
  assert.deepEqual(slotOptions(models, 'alpha', ''), [])
  assert.deepEqual(slotOptions(models, 'nope', 'A'), [])
  assert.deepEqual(slotOptions(null, 'alpha', 'A'), [])
  assert.equal(ownerOfModel(models, 'alpha', '/m/a2'), 'A')
  assert.equal(ownerOfModel(models, 'alpha', '/m/gone'), '')
  assert.equal(ownerOfModel(models, 'alpha', ''), '')
  assert.equal(modelItem(models, 'A', 'alpha', '/m/a2').path, '/m/a2')
  assert.equal(modelItem(models, 'A', 'alpha', '/m/gone'), null)
})

//  请求体：位名与参数名全部来自名片

test('⭐⭐ 非两槽位引擎的请求体：alpha_model/beta_model 加 launch_weights，没有另两台引擎的字段', () => {
  const engine = { id: ENGINE_ID, weight_slots: FAKE_THREE }
  const body = compareWeightBody(engine, {
    voiceId: 'A', picks: { alpha: '/m/a.bin', frozen: '/m/frozen', beta: '/m/b.bin' }, owners: {},
  })
  assert.deepEqual(body, {
    alpha_model: '/m/a.bin', beta_model: '/m/b.bin', launch_weights: { frozen: '/m/frozen' },
  })
  for (const absent of ['gpt_model', 'sovits_model']) assert.ok(!(absent in body), `${absent} 不该出现在请求体里`)
})

test('两槽位都选中的请求体与逐键写死的旧写法相同', () => {
  const engine = { id: ENGINE_ID, weight_slots: TWO_SLOT }
  const body = compareWeightBody(engine, { voiceId: 'A', picks: { alpha: '/m/a.ckpt', beta: '/m/b.pth' }, owners: {} })
  assert.deepEqual(body, { alpha_model: '/m/a.ckpt', beta_model: '/m/b.pth' })
  assert.ok(!('launch_weights' in body), '两位都是 call 时不该出现 launch_weights')
  assert.deepEqual(compareWeightBody(engine, null), {})
})

test('⭐⭐ 所选路径不在候选清单里时不发：下拉展示不出它的选择不该悄悄跑进引擎', () => {
  const engine = { id: ENGINE_ID, weight_slots: TWO_SLOT }
  const known = { alpha: new Set(['/m/a.ckpt']), beta: new Set(['/m/b.pth']) }
  const body = compareWeightBody(engine, { voiceId: 'A', picks: { alpha: '/m/deleted.ckpt', beta: '/m/b.pth' }, owners: {} }, known)
  assert.deepEqual(body, { beta_model: '/m/b.pth' })
})

test('某一位一个候选都没有时不拦它的选择（无从判断，照旧发出去）', () => {
  const engine = { id: ENGINE_ID, weight_slots: TWO_SLOT }
  const body = compareWeightBody(engine,
    { voiceId: 'A', picks: { alpha: '/m/a.ckpt' }, owners: {} },
    { alpha: new Set(), beta: new Set(['/m/b.pth']) })
  assert.deepEqual(body, { alpha_model: '/m/a.ckpt' })
})

//  旧行模型：按位置迁移，不按旧位名

test('⭐ 旧形状的两个字段按位置交给当前名片的位（位名不叫旧名字的引擎也不丢选择）', () => {
  const legacy = { voiceId: 'A', gptCheckpoint: '/m/a.ckpt', sovitsModel: '/m/b.pth', gptVoiceId: 'B', mix: true }
  assert.deepEqual(migrateRowModelShape(legacy, ALT_TWO), {
    picks: { encoder: '/m/a.ckpt', decoder: '/m/b.pth' },
    owners: { encoder: 'B' },
  })
  assert.deepEqual(normalizeRowModel(legacy, ALT_TWO), {
    voiceId: 'A',
    picks: { encoder: '/m/a.ckpt', decoder: '/m/b.pth' },
    owners: { encoder: 'B' },
    mix: true,
  })
  // 迁到位上的选择真的会跟着请求体出去：位名对不上时旧行会安静地一个权重都不发。
  assert.deepEqual(compareWeightBody({ id: ENGINE_ID, weight_slots: ALT_TWO }, legacy),
    { encoder_weight: '/m/a.ckpt', decoder_weight: '/m/b.pth' })
})

test('旧形状落在 GSV 的两个位名上时逐键不变', () => {
  const gsvSlots = [
    slot('gpt', { label: 'GPT', param: 'gpt_model', applies_at: 'call' }),
    slot('sovits', { label: 'SoVITS', param: 'sovits_model', applies_at: 'call' }),
  ]
  const legacy = { voiceId: 'A', gptCheckpoint: '/m/a.ckpt', sovitsModel: '/m/b.pth', sovitsVoiceId: 'B' }
  assert.deepEqual(normalizeRowModel(legacy, gsvSlots), {
    voiceId: 'A', picks: { gpt: '/m/a.ckpt', sovits: '/m/b.pth' }, owners: { sovits: 'B' }, mix: false,
  })
})

test('新形状原样收：空值丢掉，重复归一结果不变', () => {
  const rm = { voiceId: 'A', picks: { alpha: '/m/a.bin', beta: '' }, owners: { beta: 'B' }, mix: true }
  const normalized = normalizeRowModel(rm, TWO_SLOT)
  assert.deepEqual(normalized, { voiceId: 'A', picks: { alpha: '/m/a.bin' }, owners: { beta: 'B' }, mix: true })
  assert.deepEqual(normalizeRowModel(normalized, TWO_SLOT), normalized)
  assert.deepEqual(normalizeRowModel(null, TWO_SLOT), { voiceId: '', picks: {}, owners: {}, mix: false })
  assert.deepEqual(normalizeRowModel({ picks: { alpha: '/m/a.bin' } }, []), {
    voiceId: '', picks: { alpha: '/m/a.bin' }, owners: {}, mix: false,
  })
})

//  参考位

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

//  文字

test('候选项文字保留版本与步数，名称缺失时退回路径', () => {
  assert.equal(slotItemText({ name: 'w', version: 'v2', steps: 8 }), 'w [v2] (8)')
  assert.equal(slotItemText({ path: '/m/only-path' }), '/m/only-path')
  assert.equal(slotItemText(null), '')
})

test('混搭表头每段只标一样：有版本标版本，没有版本标步数', () => {
  assert.equal(slotHeaderText({ name: 'w', version: 'v2', steps: 8 }), 'w [v2]')
  assert.equal(slotHeaderText({ name: 'w', steps: 8 }), 'w (8)')
  assert.equal(slotHeaderText({ name: 'w' }), 'w')
  assert.equal(slotHeaderText(null), '')
})
