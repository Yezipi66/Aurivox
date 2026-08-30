// 模型下拉候选的守卫测试。
//
// 最要紧的三条（其余都是边界）：
//   1. 二维筛选：别的角色的模型**不出现**在下拉里；
//   2. 一个模型位的引擎，就长一个下拉 —— 不是两个里空一个；
//   3. 这个文件里不许出现任何引擎 id / 模型位名字。
//
// ⚠ 这些是 ESM，`node --test` 直接跑得动（import 带 .js 后缀，见 engines.js 顶部注释）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  slotsOf, assetIdFromModelPath, ownerOfPath, candidatesForSlot,
  flattenGroups, itemLabel, reconcileSelection, modelNotesFor,
  enginesInMeta, modelsFromMeta, countModelsInMeta, modelCountsByEngine,
  weightsToSend, weightsFromParams, anySlotSwitchable, slotsNeedingRelaunch,
  launchWeightsToSend,
  voicesForEngine, describeGeneration,
} from './modelPickers.pure.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// --- 夹具：两台形状完全不同的引擎，名字都是编出来的 ----------------------
// ⛔ 故意不用真机上那两台的 id：测试里写死真实 id，等于把"平台认识这台引擎"
//    这件事偷偷带进守卫。
const TWO_SLOT = { id: 'enj-two', weight_slots: [{ name: 'alpha', label: 'Alpha' }, { name: 'beta', label: 'Beta' }] }
const ONE_SLOT = { id: 'enj-one', weight_slots: [{ name: 'solo', label: 'Solo' }] }

const ASSETS = [
  { voiceId: '__base__', displayName: 'Base', builtin: true,
    models: {
      'enj-two': { alpha: [{ name: 'base-a', path: '/w/enj-two/alpha/base-a' }], beta: [{ name: 'base-b', path: '/w/enj-two/beta/base-b' }] },
      'enj-one': { solo: [{ name: 'base-solo', path: '/w/enj-one', is_dir: true }] },
    } },
  { voiceId: 'Alice', displayName: 'Alice',
    models: {
      'enj-two': { alpha: [{ name: 'alice-a.ckpt', path: 'assets/Alice/models/enj-two/alpha/alice-a.ckpt', steps: 8 }], beta: [] },
      'enj-one': { solo: [{ name: 'alice-solo', path: 'assets/Alice/models/enj-one/solo/alice-solo', is_dir: true }] },
    } },
  { voiceId: 'Bob', displayName: 'Bob',
    models: { 'enj-two': { alpha: [{ name: 'bob-a.ckpt', path: 'assets/Bob/models/enj-two/alpha/bob-a.ckpt' }] } } },
]

test('名片声明几个位，就是几个位', () => {
  assert.deepEqual(slotsOf(TWO_SLOT).map(s => s.name), ['alpha', 'beta'])
  assert.deepEqual(slotsOf(ONE_SLOT).map(s => s.name), ['solo'])
})

test('⛔ 名片没写 weights ⇒ 空数组，不许兜底成两个', () => {
  assert.deepEqual(slotsOf({ id: 'x' }), [])
  assert.deepEqual(slotsOf(null), [])
  assert.deepEqual(slotsOf({ id: 'x', weight_slots: 'nonsense' }), [])
})

test('位名缺失的条目被丢掉，label 缺省退回位名', () => {
  const s = slotsOf({ weight_slots: [{ name: 'k' }, { label: '没名字' }, null] })
  assert.deepEqual(s, [{ name: 'k', label: 'k', param: null, applies_at: 'launch' }])
})

// ⚠⚠ 回归守卫：slotsOf 曾经把 param 丢掉，于是 weightsToSend 对**每一台**引擎
//    都返回空 —— 下拉能点、请求体里一个键都没有，不报错只是换了没用。
//    单元测试当时全绿，因为别处都是直接手写带 param 的位喂进去的。
test('⭐⭐ slotsOf 必须把 param 原样带过来（丢了 = 选了不发）', () => {
  const slots = slotsOf({ weight_slots: [
    { name: 'a', label: 'A', param: 'a_model', applies_at: 'call' },
    { name: 'b', label: 'B' },
  ] })
  assert.deepEqual(slots, [
    { name: 'a', label: 'A', param: 'a_model', applies_at: 'call' },
    { name: 'b', label: 'B', param: null, applies_at: 'launch' },
  ])
  assert.deepEqual(weightsToSend(slots, { a: '/p/a', b: '/p/b' }), { a_model: '/p/a' })
  assert.equal(anySlotSwitchable(slots), true)
})

// ⭐⭐ 换一份要不要重开引擎，是**每个位各自的事** —— 一台引擎完全可以一个位
//    一次调用就能换、另一个位是开进程时吃进去的。原来那个引擎级的布尔位
//    在这种引擎上没有正确答案，这两条就是它退休的判据。
test('哪些位换了要重开引擎：按位算，不按引擎算', () => {
  const mixed = slotsOf({ weight_slots: [
    { name: 'a', param: 'a_model', applies_at: 'call' },
    { name: 'b', applies_at: 'launch' },
  ] })
  assert.deepEqual(slotsNeedingRelaunch(mixed), ['b'])
  assert.equal(anySlotSwitchable(mixed), true)
})

test('接口没吐 applies_at ⇒ 兜底 launch（⛔ 不兜底成"能热换"）', () => {
  const s = slotsOf({ weight_slots: [{ name: 'a' }, { name: 'b', applies_at: '瞎写的' }] })
  assert.deepEqual(s.map(x => x.applies_at), ['launch', 'launch'])
  assert.deepEqual(slotsNeedingRelaunch(s), ['a', 'b'])
})

test('⭐ 一条规则：候选只来自当前选中的这个角色', () => {
  const g = candidatesForSlot(ASSETS, 'enj-two', 'alpha', 'Alice')
  assert.deepEqual(g.map(x => x.voiceId), ['Alice'])
  assert.ok(!g.some(x => x.voiceId === 'Bob'), 'Bob 的权重不该出现在 Alice 的下拉里')
})

// ⭐⭐ 2026-08-31 Owner：「为什么 voice 下面还是会有出现底模？都有 base model
//    这种虚拟资产了」。原来这里钉的是「底模在每一个角色下面都出现」——
//    那是底模还没有自己条目时的权宜。它现在是一个正经的虚拟角色，
//    再在别人下面出现一次就是同一份权重的第二个入口，而且那个入口会让
//    历史记录说「用的是 Alice」。
test('⛔ 底模不出现在别的角色下面；选中它自己时照常出现且在最前', () => {
  for (const who of ['Alice', 'Bob']) {
    const g = candidatesForSlot(ASSETS, 'enj-two', 'alpha', who)
    assert.ok(!g.some(x => x.builtin), `${who} 的下拉里不该有底模`)
  }
  const b = candidatesForSlot(ASSETS, 'enj-two', 'alpha', '__base__')
  assert.equal(b[0].builtin, true)
  assert.equal(b[0].voiceId, '__base__')
})

test('⭐ 一个模型位的引擎，就长一个下拉', () => {
  const slots = slotsOf(ONE_SLOT)
  assert.equal(slots.length, 1)
  const g = candidatesForSlot(ASSETS, 'enj-one', 'solo', 'Alice')
  const flat = flattenGroups(g)
  assert.equal(flat.length, 1)                      // 只有 Alice 自己微调的
  assert.ok(!flat.some(i => i.name === 'base-solo'), '底模不在角色的下拉里')
  // ⭐ 整个目录就是一份候选 —— 平台不筛后缀，目录也能当模型。
  const base = flattenGroups(candidatesForSlot(ASSETS, 'enj-one', 'solo', '__base__'))
  assert.equal(base.find(i => i.name === 'base-solo').is_dir, true)
})

test('空的位不出现（目录建了但里面没东西 ≠ 有模型）', () => {
  const g = candidatesForSlot(ASSETS, 'enj-two', 'beta', 'Alice')
  assert.deepEqual(g, [])   // Alice 的 beta 是空数组，底模也不再来补位
})

test('这台引擎在这个角色下一个模型都没有 ⇒ 空（⛔ 不拿底模顶上）', () => {
  assert.deepEqual(candidatesForSlot(ASSETS, 'enj-one', 'solo', 'Bob'), [])
  assert.deepEqual(candidatesForSlot(ASSETS, 'enj-nope', 'solo', '__base__'), [])
  assert.deepEqual(candidatesForSlot(ASSETS, 'enj-two', '不存在的位', 'Alice'), [])
  assert.deepEqual(candidatesForSlot(null, 'enj-two', 'alpha', 'Alice'), [])
  assert.deepEqual(candidatesForSlot(ASSETS, '', 'alpha', 'Alice'), [])
})

test('从路径倒推角色：三层结构认，素材路径不认，底模不认', () => {
  assert.equal(assetIdFromModelPath('D:/p/assets/Alice/models/enj-two/alpha/x.ckpt'), 'Alice')
  assert.equal(assetIdFromModelPath('assets/Alice/models/enj-two/alpha/x.ckpt'), 'Alice')
  // 反斜杠（Windows）同样认
  assert.equal(assetIdFromModelPath('D:\\p\\assets\\Alice\\models\\enj-one\\solo\\d\\w.pth'), 'Alice')
  // ⛔ 素材不分引擎，也不在 models/ 下 —— 不能被认成模型
  assert.equal(assetIdFromModelPath('assets/Alice/raw/a.wav'), '')
  assert.equal(assetIdFromModelPath('assets/Alice/models/enj-two/alpha'), '')  // 少一层，位下面没东西
  // 底模不在 assets/ 下
  assert.equal(assetIdFromModelPath('/w/enj-one/x'), '')
  assert.equal(assetIdFromModelPath(null), '')
})

test('⭐ 属于谁，看它在不在清单里，不看路径长什么样', () => {
  const b = candidatesForSlot(ASSETS, 'enj-one', 'solo', '__base__')
  // 底模路径没有任何"我是底模"的特征，照样认得出来
  assert.deepEqual(ownerOfPath(b, '/w/enj-one'), { voiceId: '__base__', displayName: 'Base', builtin: true })
  const g = candidatesForSlot(ASSETS, 'enj-one', 'solo', 'Alice')
  assert.equal(ownerOfPath(g, 'assets/Alice/models/enj-one/solo/alice-solo').voiceId, 'Alice')
  assert.equal(ownerOfPath(g, '/不在清单里/的/路径'), null)
  assert.equal(ownerOfPath(g, ''), null)
})

test('标签：有 steps / version 才贴，没有就只有名字', () => {
  assert.equal(itemLabel({ name: 'a.ckpt' }), 'a.ckpt')
  assert.equal(itemLabel({ name: 'a.ckpt', steps: 8 }), 'a.ckpt (step 8)')
  assert.equal(itemLabel({ name: 'b.pth', version: 'v2Pro' }), 'b.pth (v2Pro)')
  assert.equal(itemLabel({ name: 'b.pth', steps: 0, version: 'v2' }), 'b.pth (step 0 · v2)')
  assert.equal(itemLabel(null), '')
})

// --- 「这一份装不起来」要写在下拉那一行上 --------------------------------
// ⭐ 后端按名片的 required 核对过，三态：true / false / null。
//   ⛔ null 是"说不出来"（单文件的候选、名片没写 required），不许画成有问题。
test('标签：候选不完整就在那一行上说，⛔ "说不出来"不许说成有问题', () => {
  assert.equal(itemLabel({ name: 'm', complete: false, missing: ['a', 'b'] }), 'm (⚠ 缺 2 项)')
  assert.equal(itemLabel({ name: 'm', complete: false }), 'm (⚠ 不完整)')
  assert.equal(itemLabel({ name: 'm', complete: true }), 'm')
  assert.equal(itemLabel({ name: 'm', complete: null }), 'm')
  assert.equal(itemLabel({ name: 'm' }), 'm')
  // 跟既有的两段并存，不互相顶掉
  assert.equal(itemLabel({ name: 'm', steps: 8, complete: false, missing: ['a'] }),
    'm (step 8 · ⚠ 缺 1 项)')
})

// --- 空下拉必须解释自己为什么空 ------------------------------------------
test('后端的诊断按 引擎 × 角色 取出来，⛔ 前端不拼话', () => {
  const assets = [
    { voiceId: 'base', builtin: true, models: {}, model_notes: [{ engine: 'e1', code: 'x', text: '不该被拿到' }] },
    { voiceId: 'Alice', models: {}, model_notes: [
      { engine: 'e1', code: 'whole_dir_as_candidate', text: '第一句' },
      { engine: 'e2', code: 'loose_files', text: '别台引擎的' },
      { engine: 'e1', code: 'loose_files' },              // 没有 text ⇒ 没话可说，剔掉
    ] },
    { voiceId: 'Bob', models: {} },
  ]
  assert.deepEqual(modelNotesFor(assets, 'e1', 'Alice').map(n => n.text), ['第一句'])
  assert.deepEqual(modelNotesFor(assets, 'e2', 'Alice').map(n => n.text), ['别台引擎的'])
  // 一条都没有 / 角色不在清单里 / 参数缺 ⇒ 空数组，⛔ 不是 undefined
  assert.deepEqual(modelNotesFor(assets, 'e1', 'Bob'), [])
  assert.deepEqual(modelNotesFor(assets, 'e1', 'Nobody'), [])
  assert.deepEqual(modelNotesFor(assets, '', 'Alice'), [])
  assert.deepEqual(modelNotesFor(null, 'e1', 'Alice'), [])
  // ⛔ 底模那一条不是谁的资产，它的话不许被当成当前角色的
  assert.deepEqual(modelNotesFor(assets, 'e1', 'base'), [])
})

test('还有效的旧选择要留住（异步刷新不许把用户刚挑的弹回第一条）', () => {
  const slots = slotsOf(TWO_SLOT)
  const groups = { alpha: candidatesForSlot(ASSETS, 'enj-two', 'alpha', 'Alice'), beta: candidatesForSlot(ASSETS, 'enj-two', 'beta', 'Alice') }
  const keep = reconcileSelection(slots, groups, { alpha: 'assets/Alice/models/enj-two/alpha/alice-a.ckpt' })
  assert.equal(keep.alpha, 'assets/Alice/models/enj-two/alpha/alice-a.ckpt')
})

test('⛔ 失效的旧选择必须换掉（换引擎后不许把别人的权重发出去）', () => {
  const slots = slotsOf(ONE_SLOT)
  const groups = { solo: candidatesForSlot(ASSETS, 'enj-one', 'solo', 'Alice') }
  const out = reconcileSelection(slots, groups, { solo: 'assets/Alice/models/enj-two/alpha/alice-a.ckpt' })
  assert.notEqual(out.solo, 'assets/Alice/models/enj-two/alpha/alice-a.ckpt')
  // 退回这个角色自己的第一条 —— ⛔ 不再退回底模（底模已经不在别人的下拉里）
  assert.equal(out.solo, 'assets/Alice/models/enj-one/solo/alice-solo')
})

test('候选是空的时候选择就是空字符串，不是 undefined', () => {
  const out = reconcileSelection(slotsOf(ONE_SLOT), { solo: [] }, null)
  assert.equal(out.solo, '')
})

test('default 标记优先于第一条', () => {
  const groups = { solo: [{ voiceId: 'A', displayName: 'A', items: [{ name: 'x', path: 'p1' }, { name: 'y', path: 'p2', default: true }] }] }
  assert.equal(reconcileSelection(slotsOf(ONE_SLOT), groups, null).solo, 'p2')
})

// --- 选中的模型怎么发出去 ------------------------------------------------
const SEND_SLOTS = [
  { name: 'alpha', label: 'A', param: 'alpha_model' },
  { name: 'beta', label: 'B', param: 'beta_model' },
  { name: 'frozen', label: 'F', param: null },   // 这台引擎换不了的位
]

test('⭐ 用哪个参数名发，是名片说的（平台不认识任何一个具体键名）', () => {
  assert.deepEqual(
    weightsToSend(SEND_SLOTS, { alpha: '/p/a', beta: '/p/b', frozen: '/p/f' }),
    { alpha_model: '/p/a', beta_model: '/p/b' })
})

test('⛔⛔ 名片没写 param 的位一个字节都不发（发一个引擎不读的键＝撒谎）', () => {
  const body = weightsToSend(SEND_SLOTS, { frozen: '/p/f' })
  assert.deepEqual(body, {})
  assert.ok(!('frozen' in body) && !('frozen_model' in body))
})

test('没选的位不发（空字符串是"还没选"，不是"选了空"）', () => {
  assert.deepEqual(weightsToSend(SEND_SLOTS, { alpha: '', beta: '/p/b' }), { beta_model: '/p/b' })
  assert.deepEqual(weightsToSend(SEND_SLOTS, null), {})
  assert.deepEqual(weightsToSend(null, { alpha: '/p/a' }), {})
})

test('Rerun：从请求体把各个位的选择读回来', () => {
  assert.deepEqual(
    weightsFromParams(SEND_SLOTS, { alpha_model: '/p/a', frozen_model: '/p/f', 别的键: 1 }),
    { alpha: '/p/a' })
  // 明确写了 null 的键 ⇒ 读成空字符串（"这次没带权重"），⛔ 不是丢掉不管
  assert.deepEqual(weightsFromParams(SEND_SLOTS, { beta_model: null }), { beta: '' })
})

test('一个位都没有 ⇒ 界面要说明"这台引擎不用选模型"', () => {
  assert.equal(anySlotSwitchable(SEND_SLOTS), true)
  assert.equal(anySlotSwitchable([]), false)
  assert.equal(anySlotSwitchable(null), false)
})

test('⭐⭐ 开进程那一步吃进去的位，现在**也算能换**（平台会带着新的重开一次）', () => {
  // ⚠ 这条以前是反过来断言的（没有参数名 ⇒ 换不了）。那时候确实换不了：
  //   平台换模型只有"对活着的进程发一个换权重请求"这一条路。
  //   现在平台会把它关掉、带着选中的那一份重开，所以那句话不再成立。
  assert.equal(anySlotSwitchable([{ name: 'frozen', param: null, applies_at: 'launch' }]), true)
})

// --- 开进程那一步吃进去的那些位，选择怎么送出去 ---------------------------
const MIXED_SLOTS = [
  { name: 'alpha', label: 'A', param: 'alpha_model', applies_at: 'call' },
  { name: 'frozen', label: 'F', param: null, applies_at: 'launch' },
]

test('⭐⭐⭐ 没有参数名的位，选择走平台级的那一份（⛔ 不进引擎请求体）', () => {
  const sel = { alpha: '/p/a', frozen: '/p/f' }
  // 进请求体的那份：只有引擎认识的参数名
  assert.deepEqual(weightsToSend(MIXED_SLOTS, sel), { alpha_model: '/p/a' })
  // 给平台的那份：键是**位名**，因为收件人是平台不是引擎
  assert.deepEqual(launchWeightsToSend(MIXED_SLOTS, sel), { frozen: '/p/f' })
})

test('⛔ 两份必须把位分完，不重不漏（同一个选择不许说两遍）', () => {
  const sel = { alpha: '/p/a', frozen: '/p/f' }
  const a = Object.keys(weightsToSend(MIXED_SLOTS, sel))
  const b = Object.keys(launchWeightsToSend(MIXED_SLOTS, sel))
  assert.equal(a.length + b.length, 2)
  assert.deepEqual(b, ['frozen'])
})

test('没选的位不发（空字符串是"还没选"，不是"选了空"）', () => {
  assert.deepEqual(launchWeightsToSend(MIXED_SLOTS, { frozen: '' }), {})
  assert.deepEqual(launchWeightsToSend(MIXED_SLOTS, null), {})
  assert.deepEqual(launchWeightsToSend(null, { frozen: '/x' }), {})
})

test('⭐⭐ Rerun：开进程那一步吃进去的那份也要读得回来', () => {
  // ⛔ 只读参数名那一份的话，Rerun 会**悄悄换回底模**：
  //   参数一字不差、声音不是那个人，而且不报错。
  assert.deepEqual(
    weightsFromParams(MIXED_SLOTS, { alpha_model: '/p/a', launch_weights: { frozen: '/p/f' } }),
    { alpha: '/p/a', frozen: '/p/f' })
  // 一份都没存过的老记录 ⇒ 读回来就是没有，不抛
  assert.deepEqual(weightsFromParams(MIXED_SLOTS, { alpha_model: '/p/a' }), { alpha: '/p/a' })
})

// --- 直接读 meta.json -----------------------------------------------------
const META = { assets: { models: {
  'enj-two': { alpha: [{ name: 'a' }, { name: 'b' }], beta: [{ name: 'c' }] },
  'enj-one': { solo: [] },                       // 目录在、里面空 ⇒ 不算这台引擎有模型
} } }

test('meta：按引擎汇总，空的引擎不出现', () => {
  assert.deepEqual(enginesInMeta(META), ['enj-two'])
  assert.deepEqual(modelCountsByEngine(META), [{ engineId: 'enj-two', count: 3 }])
  assert.equal(countModelsInMeta(META), 3)
})

test('meta：取某位的清单，取不到就是空数组（⛔ 不是 undefined）', () => {
  assert.equal(modelsFromMeta(META, 'enj-two', 'alpha').length, 2)
  assert.deepEqual(modelsFromMeta(META, 'enj-two', '不存在'), [])
  assert.deepEqual(modelsFromMeta(META, '没这台', 'alpha'), [])
  assert.deepEqual(modelsFromMeta(null, 'enj-two', 'alpha'), [])
})

test('⛔ 老的 checkpoints 键一个字都不读（读到了说明还在吃老形状）', () => {
  const legacy = { assets: { checkpoints: { gpt: [{ name: 'x' }], sovits: [{ name: 'y' }] } } }
  assert.deepEqual(enginesInMeta(legacy), [])
  assert.equal(countModelsInMeta(legacy), 0)
  assert.deepEqual(modelCountsByEngine(legacy), [])
})

// --- 音色下拉：底模 ∪「每个位都有自己模型」的角色 ------------------------

const VOICES = [
  { id: 'base', display_name: 'Base model', builtin: true },
  { id: 'alice', display_name: 'Alice' },
  { id: 'bob', display_name: 'Bob' },
  { id: 'carol', display_name: 'Carol' },
]

// alice：两个位都有；bob：只有一个位；carol：这台引擎下什么都没有。
const ASSETS_2SLOT = [
  { voiceId: '__base__', displayName: 'Base', builtin: true, models: { e1: { a: [{ path: 'p' }], b: [{ path: 'q' }] } } },
  { voiceId: 'alice', displayName: 'Alice', models: { e1: { a: [{ path: '1' }], b: [{ path: '2' }] } } },
  { voiceId: 'bob', displayName: 'Bob', models: { e1: { a: [{ path: '3' }] } } },
  { voiceId: 'carol', displayName: 'Carol', models: { e2: { a: [{ path: '4' }] } } },
]
const SLOTS2 = [{ name: 'a' }, { name: 'b' }]

test('底模永远在，且只留每个位都有自己模型的角色', () => {
  const got = voicesForEngine(VOICES, ASSETS_2SLOT, 'e1', SLOTS2)
  assert.deepEqual(got.map(v => v.id), ['base', 'alice'])
})

test('⛔ 只有一半模型的角色不列（半个模型是特殊需求，不在这里照顾）', () => {
  const got = voicesForEngine(VOICES, ASSETS_2SLOT, 'e1', SLOTS2)
  assert.ok(!got.some(v => v.id === 'bob'))
})

test('别的引擎下有模型不算数', () => {
  const got = voicesForEngine(VOICES, ASSETS_2SLOT, 'e1', SLOTS2)
  assert.ok(!got.some(v => v.id === 'carol'))
  assert.deepEqual(voicesForEngine(VOICES, ASSETS_2SLOT, 'e2', [{ name: 'a' }]).map(v => v.id),
    ['base', 'carol'])
})

test('一个位的引擎：谁在这个位上有模型谁就在', () => {
  const got = voicesForEngine(VOICES, ASSETS_2SLOT, 'e1', [{ name: 'a' }])
  assert.deepEqual(got.map(v => v.id), ['base', 'alice', 'bob'])
})

test('这台引擎下谁都没有模型 ⇒ 只剩底模那一条（不是空下拉）', () => {
  const got = voicesForEngine(VOICES, ASSETS_2SLOT, 'e9', [{ name: 'a' }])
  assert.deepEqual(got.map(v => v.id), ['base'])
})

test('⚠ 名片一个模型位都没写 ⇒ 不筛，全列', () => {
  assert.deepEqual(voicesForEngine(VOICES, ASSETS_2SLOT, 'e1', []).map(v => v.id),
    ['base', 'alice', 'bob', 'carol'])
})

test('还不知道是哪台引擎 ⇒ 不筛（⛔ 别在加载中途把人清空）', () => {
  assert.equal(voicesForEngine(VOICES, ASSETS_2SLOT, null, SLOTS2).length, 4)
})

test('空位/空表都不炸', () => {
  assert.deepEqual(voicesForEngine(null, null, 'e1', SLOTS2), [])
  assert.deepEqual(voicesForEngine(VOICES, null, 'e1', SLOTS2).map(v => v.id), ['base'])
  assert.deepEqual(voicesForEngine(VOICES, [{ voiceId: 'alice', models: { e1: { a: [], b: [{ path: '2' }] } } }], 'e1', SLOTS2).map(v => v.id), ['base'])
})

test('顺序照抄音色清单，不重排', () => {
  const got = voicesForEngine(VOICES, ASSETS_2SLOT, 'e1', [{ name: 'a' }])
  assert.deepEqual(got.map(v => v.id), ['base', 'alice', 'bob'])
})

// --- 历史记录那一行怎么写 -----------------------------------------------
//
// 病历：Owner 2026-08-31 00:42 在真机上看到一条 IndexTTS2 的记录印着
//     Base model · Auto · GPT - / SoVITS - · ref 交谈2_2.wav · seed 3788417817
// 那台引擎既没有 GPT 位也没有 SoVITS 位。原因是 GenerateTab.jsx 里写死的模板
//     `GPT ${item.gpt} / SoVITS ${item.sovits}`
// —— 位名写死、位数写死成 2。

test('一个位的引擎写一格，⛔ 不是两格空一格', () => {
  assert.equal(
    describeGeneration({ engine_label: 'Enj One', weights: [{ name: 'solo', label: 'Solo', value: 'checkpoints' }] }),
    'Enj One · Solo checkpoints')
})

test('三个位的引擎写三格 —— 位数不是常数 2', () => {
  assert.equal(
    describeGeneration({ engine_label: 'Enj Three', weights: [
      { name: 'a', label: 'A', value: 'x.ckpt' },
      { name: 'b', label: 'B', value: 'y.pth' },
      { name: 'c', label: 'C', value: 'z' }] }),
    'Enj Three · A x.ckpt / B y.pth / C z')
})

test('⛔ 没选的位写横杠，位不许从行里消失（消失 = 用户以为没这个位）', () => {
  assert.equal(
    describeGeneration({ engine_label: 'Enj Two', weights: [
      { name: 'alpha', label: 'Alpha', value: '' },
      { name: 'beta', label: 'Beta', value: 'b.pth' }] }),
    'Enj Two · Alpha - / Beta b.pth')
})

test('一个位都没有的引擎：只写引擎名，⛔ 不留一个空的分隔符', () => {
  assert.equal(describeGeneration({ engine_label: 'Enj Zero', weights: [] }), 'Enj Zero')
})

test('没有 label 就退到引擎 id；位没有 label 就退到位名', () => {
  assert.equal(
    describeGeneration({ engine_id: 'enj-one', weights: [{ name: 'solo', value: 'v' }] }),
    'enj-one · solo v')
})

test('⚠ 老条目（这一版之前的 meta.json）没有 weights ⇒ 整段不写，⛔ 不去猜位名', () => {
  assert.equal(describeGeneration({ voice: 'v1' }), '')
  assert.equal(describeGeneration({}), '')
  assert.equal(describeGeneration(null), '')
  // 老条目里可能还留着上一版写下的那两个键 —— 也不许用。
  assert.equal(describeGeneration({ gpt: 'a.ckpt', sovits: 'b.pth' }), '')
})

test('坏形状不许把整张历史列表带崩', () => {
  assert.equal(describeGeneration({ engine_label: 'E', weights: 'nope' }), 'E')
  assert.equal(describeGeneration({ engine_label: 'E', weights: [null, {}, { name: 'ok', label: 'OK' }] }), 'E · OK -')
})

// --- 守卫：不许认识任何具体引擎 -----------------------------------------
test('⛔ 这个文件里不许出现任何真实引擎 id 或模型位名字', () => {
  const src = readFileSync(path.join(HERE, 'modelPickers.pure.js'), 'utf8')
  // 只看代码，注释里点名是允许的（注释就是用来讲来龙去脉的）。
  const code = src
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  for (const banned of ['gpt', 'sovits', 'indextts', 'gpt-sovits']) {
    assert.ok(!code.toLowerCase().includes(banned),
      `代码里出现了 "${banned}" —— 平台不许认识任何一台具体引擎`)
  }
})
