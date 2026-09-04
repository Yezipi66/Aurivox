'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const {
  DEFAULT_CAP, DEFAULT_HEADROOM, DEFAULT_IDLE_MS,
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

// ---------------------------------------------------------------------------
//  ⭐⭐⭐ 自己正忙的时候，不许把自己重开
// ---------------------------------------------------------------------------
//
// 这一组钉的是一个**今天就能复现**的洞：planAdmission 对**别人**处处守着
// !r.busy，轮到自己那一支（key 不一样 ⇒ relaunch）却一眼都不看 me.busy。
//   ⇒ A 正在合成时，B 用同一台引擎的另一份 launch 模型发起请求
//   ⇒ A 那个进程被当场重开
//   ⇒ **A 拿到半截 WAV 或一句引擎原话报错，而 B 一切正常。**
// 坏的是 A、报错在 A、动手的是 B —— 三样分在三处，这是最难查的那种坏法。

test('⛔⛔⛔ 裁决：自己正忙 + 要的是另一份 launch 模型 ⇒ 当场拒绝，⛔ 不许 relaunch', () => {
  const r = planAdmission({
    residents: [
      { id: 'e1', key: 'model=A', lastUsedAt: T0 - 5, onDemand: true, busy: true },
    ],
    id: 'e1', key: 'model=B', onDemand: true, cap: 2, now: T0,
  })
  assert.equal(r.action, 'busy',
    'relaunch 会把正在跑的那次腰斩 —— 用户拿到的是半截音频，不是一条错误')
  assert.ok(r.reason && r.reason.length > 0, '拒绝必须带一句人话，否则界面上只有一个错误码')
})

test('⛔ 裁决：拒绝那一支**一个人都不许 evict** —— 注定失败的请求不该有副作用', () => {
  const r = planAdmission({
    residents: [
      { id: 'e1', key: 'model=A', lastUsedAt: T0 - 5, onDemand: true, busy: true },
      // 这一台空闲早就超时了，换别的分支会把它放掉。
      { id: 'stale', key: '', lastUsedAt: T0 - DEFAULT_IDLE_MS * 3, onDemand: true },
    ],
    id: 'e1', key: 'model=B', onDemand: true, cap: 2, now: T0,
  })
  assert.equal(r.action, 'busy')
  assert.deepEqual(r.evict, [],
    '这一次不会起任何进程 ⇒ 没有谁需要腾地方；空闲的那几台由 planSweep 那条定时线去放')
})

test('⭐ 边界：自己正忙、但要的**就是同一份**模型 ⇒ 照常 reuse，⛔ 不受这条拒绝影响', () => {
  const r = planAdmission({
    residents: [
      { id: 'e1', key: 'model=A', lastUsedAt: T0 - 5, onDemand: true, busy: true },
    ],
    id: 'e1', key: 'model=A', onDemand: true, cap: 2, now: T0,
  })
  assert.equal(r.action, 'reuse',
    '同一份模型不需要重开进程 ⇒ 忙不忙都不影响，并发合成是引擎自己的事')
})

test('⭐ 边界：自己**没在忙**、要另一份模型 ⇒ 仍然 relaunch（这条行为一个字没变）', () => {
  const r = planAdmission({
    residents: [
      { id: 'e1', key: 'model=A', lastUsedAt: T0 - 5, onDemand: true, busy: false },
    ],
    id: 'e1', key: 'model=B', onDemand: true, cap: 2, now: T0,
  })
  assert.equal(r.action, 'relaunch')
})

test('⭐ 边界：没有 launch 位的引擎（key 恒为空）永远撞不上这条拒绝', () => {
  // 只有 call 位 ⇒ launchKeyOf 返回 ''，两次请求的 key 永远相等 ⇒ 永远 reuse。
  const r = planAdmission({
    residents: [{ id: 'e1', key: '', lastUsedAt: T0 - 5, onDemand: false, busy: true }],
    id: 'e1', key: '', onDemand: false, cap: 2, now: T0,
  })
  assert.equal(r.action, 'reuse',
    '进程是个壳、模型是后来喂进去的 ⇒ 换模型不重开进程 ⇒ 没有腰斩的风险')
})

test('⛔ 边界：**别人**在忙不影响我 —— 拒绝只针对「自己」', () => {
  const r = planAdmission({
    residents: [{ id: 'other', key: 'model=A', lastUsedAt: T0 - 5, onDemand: true, busy: true }],
    id: 'e1', key: 'model=B', onDemand: true, cap: 2, now: T0,
  })
  assert.equal(r.action, 'start', '别人忙不忙跟我起不起没有关系（够不够上限是另一条规则）')
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

// ---------------------------------------------------------------------------
//  内存判据 —— 起之前先看一眼机器还剩多少
//
//  ⭐⭐⭐ 这一整节的形状：不是「精确的内存核算」，是「起之前先看一眼，
//    别把机器撑爆」。允许估错，只要错在保守那边。
//    所以下面每一条断言，都要能指出「它错的时候往哪边错」。
// ---------------------------------------------------------------------------

const T1 = 1000

test("内存够 ⇒ 照起", () => {
  const r = planAdmission({ residents: [], id: "a", key: "", now: T1,
    freeMb: 8000, needMb: 3547 })
  assert.equal(r.action, "start")
})

test("内存风险 ⇒ needs_confirm，⛔ 不剥夺本次尝试的选择", () => {
  const r = planAdmission({ residents: [], id: "a", key: "", now: T1,
    freeMb: 3000, needMb: 3547 })
  assert.equal(r.action, "needs_confirm")
  assert.equal(r.mem.needMb, 3547)
  assert.equal(r.mem.wantMb, Math.ceil(3547 * DEFAULT_HEADROOM))
})

test("⭐ 余量是往上加的 —— 剩 3600 装 3547 也必须先提示风险", () => {
  // 裸看 3600 > 3547 是够的。加上 1.15 的余量就不够了。
  // ⛔ 这一条错的时候往危险那边错：不加余量 ⇒ 断链漏算的那部分没人兜。
  const r = planAdmission({ residents: [], id: "a", key: "", now: T1,
    freeMb: 3600, needMb: 3547 })
  assert.equal(r.action, "needs_confirm")
})

test("⭐⭐⭐ 从来没量过（needMb=null）⇒ needs_confirm，⛔ 不是硬拒绝", () => {
  // 不知道它多大**不等于**它太大。拦下来问，不是拦下来拒。
  const r = planAdmission({ residents: [], id: "a", key: "", now: T1,
    freeMb: 6000, needMb: null })
  assert.equal(r.action, "needs_confirm")
  assert.equal(r.mem.needMb, null)
})

test("⭐⭐⭐ needMb=0 是「不吃内存」，⛔ 不许当成「不知道」", () => {
  // 把 0 和 null 混起来 = 把最危险的情况当成最安全的。
  const r = planAdmission({ residents: [], id: "a", key: "", now: T1,
    freeMb: 100, needMb: 0 })
  assert.equal(r.action, "start")
})

test("用户点过继续 ⇒ 不再拦（confirmed）", () => {
  const r = planAdmission({ residents: [], id: "a", key: "", now: T1,
    freeMb: 6000, needMb: null, confirmed: true })
  assert.equal(r.action, "start")
})

test("⭐ 不给 freeMb ⇒ 完全不做内存判断（老行为一个字不变）", () => {
  // 装上这一刀但还没接线的那段时间里，行为必须跟装之前逐字一样。
  const r = planAdmission({ residents: [], id: "a", key: "", now: T1 })
  assert.equal(r.action, "start")
  assert.equal(r.mem, undefined)
})

test("⭐⭐ relaunch 不做内存判断 —— 先关自己再起，净增为零", () => {
  // 内存 1MB 都不剩，也照样允许换模型重开。
  // ⛔ 这里要是拦了，用户会在一台正常的机器上永远换不了模型。
  const r = planAdmission({
    residents: [{ id: "a", key: "k1", lastUsedAt: T1 }],
    id: "a", key: "k2", now: T1, freeMb: 1, needMb: 8192 })
  assert.equal(r.action, "relaunch")
})

test("reuse 不做内存判断 —— 进程已经在了", () => {
  const r = planAdmission({
    residents: [{ id: "a", key: "k1", lastUsedAt: T1 }],
    id: "a", key: "k1", now: T1, freeMb: 1, needMb: 8192 })
  assert.equal(r.action, "reuse")
})

test("⭐ 要关掉的那几台，它们还回来的内存算进预算", () => {
  // b 过期该放，它现在占着 4000MB。放掉之后就够起 a 了。
  const r = planAdmission({
    residents: [{ id: "b", key: "", lastUsedAt: 0, onDemand: true, rssMb: 4000 }],
    id: "a", key: "", now: T1, idleMs: 10,
    freeMb: 1000, needMb: 3547 })
  assert.equal(r.action, "start")
  assert.deepEqual(r.evict, ["b"])
})

test("⛔ 加回来的是当前用量不是峰值 —— 没给 rssMb 就一分钱不加", () => {
  // 峰值是历史最高，早还给系统了；按峰值加回来是凭空多出一截，方向危险。
  const r = planAdmission({
    residents: [{ id: "b", key: "", lastUsedAt: 0, onDemand: true, peakMb: 9999 }],
    id: "a", key: "", now: T1, idleMs: 10,
    freeMb: 1000, needMb: 3547 })
  assert.equal(r.action, "needs_confirm")
})

test("⭐⭐ 拒绝的时候，⛔ 不为这次请求腾地方（只放该放的）", () => {
  // c 没过期，本来是为了腾 cap 才关的。既然这次注定起不来，就别动 c ——
  // 副作用发生了、请求还是失败了，两头都不落好。
  const r = planAdmission({
    residents: [
      { id: "b", key: "", lastUsedAt: 0, onDemand: true, rssMb: 10 },
      { id: "c", key: "", lastUsedAt: T1, onDemand: false },
      { id: "d", key: "", lastUsedAt: T1, onDemand: false },
    ],
    id: "a", key: "", now: T1, idleMs: 10, cap: 2,
    freeMb: 100, needMb: 3547 })
  assert.equal(r.action, "needs_confirm")
  assert.deepEqual(r.evict, ["b"], "只放过期的那台，⛔ 不许顺手关掉 c")
})

test("needs_confirm 的时候同样不为它腾地方", () => {
  const r = planAdmission({
    residents: [{ id: "c", key: "", lastUsedAt: T1, onDemand: false },
                { id: "d", key: "", lastUsedAt: T1, onDemand: false }],
    id: "a", key: "", now: T1, cap: 2,
    freeMb: 6000, needMb: null })
  assert.equal(r.action, "needs_confirm")
  assert.deepEqual(r.evict, [])
})

test("⭐ busy 比内存先判 —— 正在合成的那次不许被内存问题腰斩", () => {
  const r = planAdmission({
    residents: [{ id: "a", key: "k1", busy: true, lastUsedAt: T1 }],
    id: "a", key: "k2", now: T1, freeMb: 1, needMb: 8192 })
  assert.equal(r.action, "busy")
})

test("DEFAULT_HEADROOM 只往上加，不小于 1", () => {
  assert.ok(DEFAULT_HEADROOM >= 1)
})

test("⛔ headroom 传个小于 1 的数进来 ⇒ 忽略它，用默认值", () => {
  // 允许调用方把余量调没了，等于允许它把安全阀拧掉。
  const r = planAdmission({ residents: [], id: "a", key: "", now: T1,
    freeMb: 3600, needMb: 3547, headroom: 0.5 })
  assert.equal(r.action, "needs_confirm")
})
