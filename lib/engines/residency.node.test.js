'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const {
  DEFAULT_CAP, DEFAULT_IDLE_MS,
  launchSlots, callSlots, isOnDemand, shouldPreload,
  launchKeyOf, planAdmission, planSweep,
} = require('./residency')

// 造一份最小 profile。⛔ 不用真名片：这一层的规则跟具体是哪台引擎无关，
//   拿真名片测会让「换一台引擎这里要不要改」这个问题永远问不出来。
function P(slots, runtime = { preload: true }) {
  return { id: 'x', weight_slots: slots, runtime }
}

// ---------------------------------------------------------------------------
//  哪些位是 launch / call
// ---------------------------------------------------------------------------

test('位分档：applies_at 只有 call 算热切，其余一律算 launch', () => {
  const p = P([
    { name: 'a', applies_at: 'call', param: 'pa' },
    { name: 'b', applies_at: 'launch' },
  ])
  assert.deepEqual(launchSlots(p).map(s => s.name), ['b'])
  assert.deepEqual(callSlots(p).map(s => s.name), ['a'])
})

test('位分档：applies_at 缺失/写歪了都落 launch（后果不对称，宁可多重开一次）', () => {
  const p = P([{ name: 'a' }, { name: 'b', applies_at: 'CALL' }, { name: 'c', applies_at: '' }])
  assert.deepEqual(launchSlots(p).map(s => s.name), ['a', 'b', 'c'])
  assert.equal(callSlots(p).length, 0)
})

test('位分档：一个位都没有 ⇒ 两边都是空，不抛', () => {
  assert.deepEqual(launchSlots(P([])), [])
  assert.deepEqual(callSlots(P(undefined)), [])
  assert.deepEqual(launchSlots(null), [])
})

// ---------------------------------------------------------------------------
//  按需 / 预热
// ---------------------------------------------------------------------------

test('有 launch 位 ⇒ 按需档（起进程就吃内存，放掉真能吐出来）', () => {
  assert.equal(isOnDemand(P([{ name: 'm', applies_at: 'launch' }])), true)
})

test('只有 call 位 ⇒ 不是按需档（进程是个壳，关掉省不下什么）', () => {
  assert.equal(isOnDemand(P([{ name: 'g', applies_at: 'call', param: 'gp' }])), false)
})

test('⚠ 一个位都没声明 ⇒ 不是按需档（平台手上没有证据，选不动它）', () => {
  assert.equal(isOnDemand(P([])), false)
})

test('预热：只有 call 位的开机预热', () => {
  assert.equal(shouldPreload(P([{ name: 'g', applies_at: 'call', param: 'gp' }])), true)
})

test('⭐⭐ 预热：有 launch 位的**不预热**，哪怕名片写着 preload:true', () => {
  // 盘上两张真名片今天都写着 true —— 让 true 一锤定音，这一刀等于白改。
  const p = P([{ name: 'm', applies_at: 'launch' }], { preload: true })
  assert.equal(shouldPreload(p), false)
})

test('预热：名片写 preload:false ⇒ 一律不预热（作者比平台更清楚自己那台）', () => {
  const p = P([{ name: 'g', applies_at: 'call', param: 'gp' }], { preload: false })
  assert.equal(shouldPreload(p), false)
})

test('预热：名片没写 runtime（作者自己起的引擎）⇒ 平台起不了它，不预热', () => {
  assert.equal(shouldPreload(P([{ name: 'g', applies_at: 'call', param: 'gp' }], null)), false)
})

// ---------------------------------------------------------------------------
//  launch 位的选择键
// ---------------------------------------------------------------------------

test('选择键：没有 launch 位 ⇒ 空串（永远不需要重开）', () => {
  assert.equal(launchKeyOf(P([{ name: 'g', applies_at: 'call', param: 'gp' }]), { g: '/x' }), '')
})

test('⭐ 选择键：「有位但没选」和「没有位」必须分得开', () => {
  const withSlot = launchKeyOf(P([{ name: 'm', applies_at: 'launch' }]), {})
  assert.notEqual(withSlot, '', '有位没选 ⇒ 不能等于空串，否则第一次选中时不会重开')
  assert.equal(launchKeyOf(P([]), {}), '')
})

test('选择键：同一组选择必须拼出同一个键（⛔ 不依赖对象键序）', () => {
  const p = P([{ name: 'b', applies_at: 'launch' }, { name: 'a', applies_at: 'launch' }])
  assert.equal(launchKeyOf(p, { a: '1', b: '2' }), launchKeyOf(p, { b: '2', a: '1' }))
})

test('选择键：换一份就换一个键', () => {
  const p = P([{ name: 'm', applies_at: 'launch' }])
  assert.notEqual(launchKeyOf(p, { m: '/one' }), launchKeyOf(p, { m: '/two' }))
})

test('选择键：call 位的选择**不进**键（换它不用重开）', () => {
  const p = P([
    { name: 'm', applies_at: 'launch' },
    { name: 'g', applies_at: 'call', param: 'gp' },
  ])
  assert.equal(launchKeyOf(p, { m: '/one', g: '/aaa' }), launchKeyOf(p, { m: '/one', g: '/bbb' }))
})

// ---------------------------------------------------------------------------
//  入场裁决
// ---------------------------------------------------------------------------

const T0 = 1000000

test('裁决：没起过 ⇒ start', () => {
  const r = planAdmission({ residents: [], id: 'e1', key: 'm=/a', cap: 2, now: T0 })
  assert.equal(r.action, 'start')
  assert.deepEqual(r.evict, [])
})

test('裁决：在跑且装的就是这一份 ⇒ reuse，不重开', () => {
  const r = planAdmission({
    residents: [{ id: 'e1', key: 'm=/a', lastUsedAt: T0, onDemand: true }],
    id: 'e1', key: 'm=/a', cap: 2, now: T0,
  })
  assert.equal(r.action, 'reuse')
  assert.deepEqual(r.evict, [])
})

test('⭐⭐ 裁决：在跑但装的是别的那一份 ⇒ relaunch', () => {
  const r = planAdmission({
    residents: [{ id: 'e1', key: 'm=/a', lastUsedAt: T0, onDemand: true }],
    id: 'e1', key: 'm=/b', cap: 2, now: T0,
  })
  assert.equal(r.action, 'relaunch')
})

test('裁决：relaunch **不**因为上限去关别人（它先关自己再起，名额数不变）', () => {
  const r = planAdmission({
    residents: [
      { id: 'e1', key: 'm=/a', lastUsedAt: T0, onDemand: true },
      { id: 'e2', key: '', lastUsedAt: T0 - 5, onDemand: false },
    ],
    id: 'e1', key: 'm=/b', cap: 2, now: T0,
  })
  assert.equal(r.action, 'relaunch')
  assert.deepEqual(r.evict, [])
})

test('⭐ 裁决：上限满了 ⇒ 关掉最久没用的那一台', () => {
  const r = planAdmission({
    residents: [
      { id: 'old', key: '', lastUsedAt: T0 - 900, onDemand: false },
      { id: 'new', key: '', lastUsedAt: T0 - 10, onDemand: false },
    ],
    id: 'e3', key: '', cap: 2, now: T0,
  })
  assert.equal(r.action, 'start')
  assert.deepEqual(r.evict, ['old'])
})

test('⛔ 裁决：正在忙的那一台**永远不动**，哪怕它最久没用', () => {
  const r = planAdmission({
    residents: [
      { id: 'busy', key: '', lastUsedAt: T0 - 9000, onDemand: true, busy: true },
      { id: 'idle', key: '', lastUsedAt: T0 - 10, onDemand: false },
    ],
    id: 'e3', key: '', cap: 2, now: T0,
  })
  assert.ok(!r.evict.includes('busy'), '正在合成的引擎被关掉 = 用户那一次请求当场失败')
  assert.deepEqual(r.evict, ['idle'])
})

test('⭐ 裁决：上限只有 1 时也能腾出位置', () => {
  const r = planAdmission({
    residents: [{ id: 'a', key: '', lastUsedAt: T0 - 5, onDemand: false }],
    id: 'b', key: '', cap: 1, now: T0,
  })
  assert.deepEqual(r.evict, ['a'])
})

test('⭐⭐ 裁决：空闲超时的按需引擎会被放掉，**跟够不够上限无关**', () => {
  const r = planAdmission({
    residents: [{ id: 'fat', key: 'm=/a', lastUsedAt: T0 - DEFAULT_IDLE_MS, onDemand: true }],
    id: 'other', key: '', cap: 8, now: T0,
  })
  assert.deepEqual(r.evict, ['fat'], '内存该吐就吐，不该等到有人来抢才吐')
})

test('裁决：不是按需档的引擎**不因为空闲**被放掉（关掉省不下什么，重开还白等）', () => {
  const r = planAdmission({
    residents: [{ id: 'shell', key: '', lastUsedAt: T0 - DEFAULT_IDLE_MS * 9, onDemand: false }],
    id: 'other', key: '', cap: 8, now: T0,
  })
  assert.deepEqual(r.evict, [])
})

test('⛔ 裁决：空闲清理绝不碰「自己」（下一步马上要用它）', () => {
  const r = planAdmission({
    residents: [{ id: 'e1', key: 'm=/a', lastUsedAt: T0 - DEFAULT_IDLE_MS * 5, onDemand: true }],
    id: 'e1', key: 'm=/a', cap: 2, now: T0,
  })
  assert.equal(r.action, 'reuse')
  assert.deepEqual(r.evict, [])
})

test('裁决：cap 不给就用默认 2', () => {
  const residents = [
    { id: 'a', key: '', lastUsedAt: T0 - 3, onDemand: false },
    { id: 'b', key: '', lastUsedAt: T0 - 2, onDemand: false },
  ]
  const r = planAdmission({ residents, id: 'c', key: '', now: T0 })
  assert.equal(DEFAULT_CAP, 2)
  assert.equal(r.evict.length, 1)
})

// ---------------------------------------------------------------------------
//  定时清扫
// ---------------------------------------------------------------------------

test('清扫：只放掉按需档、且空闲够久、且不忙的', () => {
  const residents = [
    { id: 'ripe', lastUsedAt: T0 - DEFAULT_IDLE_MS, onDemand: true },
    { id: 'fresh', lastUsedAt: T0 - 5, onDemand: true },
    { id: 'busy', lastUsedAt: T0 - DEFAULT_IDLE_MS * 3, onDemand: true, busy: true },
    { id: 'shell', lastUsedAt: T0 - DEFAULT_IDLE_MS * 3, onDemand: false },
  ]
  assert.deepEqual(planSweep(residents, { now: T0 }), ['ripe'])
})

test('清扫：空列表不抛', () => {
  assert.deepEqual(planSweep(null, { now: T0 }), [])
})

test('清扫：阈值可调', () => {
  const residents = [{ id: 'a', lastUsedAt: T0 - 50, onDemand: true }]
  assert.deepEqual(planSweep(residents, { now: T0, idleMs: 10 }), ['a'])
  assert.deepEqual(planSweep(residents, { now: T0, idleMs: 100 }), [])
})

// ---------------------------------------------------------------------------
//  守卫：这一层不许认识任何一台具体的引擎
// ---------------------------------------------------------------------------

test('⛔ 守卫：residency.js 的代码里不许出现任何引擎 id / 模型位名', () => {
  const src = fs.readFileSync(path.join(__dirname, 'residency.js'), 'utf8')
  // 去掉注释再查 —— 注释里为了讲清楚可以提，代码里不行。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  for (const banned of ['gpt', 'sovits', 'indextts', 'IndexTTS', 'GPT_SOVITS']) {
    assert.ok(!code.includes(banned),
      `residency.js 的代码里出现了 ${banned} —— 装一台谁都没见过的引擎，这个文件必须一个字都不用改`)
  }
})
