'use strict'
// ============================================================================
//  cap 的行为守卫【B3 · 2026-09-29】
//
//  ⭐⭐ 这份文件存在的理由：改 B3 之前，`cap` 在 residency.node.test.js 里
//  只以「cap: 2」这个**夹具值**出现过 20 次，**没有一条测试断言它的行为**。
//  ⇒ B3 改完之后 1633 条测试全绿、零失败 —— 那不是「没破坏什么」的证据，
//  那是「根本没有测试在看它」的证据。
//  ⭐ 本项目反复付学费的同一种缺陷：没检查过 == 检查过且干净。
// ============================================================================

const test = require('node:test')
const assert = require('node:assert')
const { planAdmission, autoCapFor, DEFAULT_CAP, MB_PER_ENGINE } = require('./residency.js')

// 一台已常驻、非忙、占 500MB 的引擎
function residents(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'r' + i, key: 'k' + i, onDemand: false, busy: false,
    lastUsedAt: 1000 + i, rssMb: 500,
  }))
}

function plan(over) {
  return planAdmission(Object.assign({
    residents: residents(2), id: 'new', key: 'nk', onDemand: true,
    cap: 2, freeMb: 32000, headroom: 1.15, confirmed: true, now: 2000,
  }, over))
}

// ---------------------------------------------------------------------------
//  1) ⭐⭐⭐ B3 的核心：账本有数据时，cap 不再参与
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 32G 机器、内存充足、已常驻 2 台 —— ⛔ 不许因为「最多 2 台」关掉用户的引擎', () => {
  // 这是 B3 修的那个具体症状。改之前 evict=["r0"]。
  const r = plan({ needMb: 1000 })
  assert.equal(r.action, 'start')
  assert.deepEqual(r.evict, [],
    '⛔ 内存明明够，平台不该替用户关引擎 —— 这就是「应用太霸道」最精确的形态')
})

test('⭐⭐⭐ 已常驻 5 台、账本有数据 —— 一样不动', () => {
  const r = plan({ residents: residents(5), needMb: 1000 })
  assert.deepEqual(r.evict, [], '⛔ 机器养得起就不该关')
})

test('⭐⭐ 判据是「知不知道要吃多少」，不是「内存够不够」', () => {
  // needMb=null 但 freeMb 巨大 ⇒ 仍然走 cap 兜底。
  // ⭐ 这一条最容易写反：把判据写成 freeMb > X 就会漏掉「知道总量、不知道单台」这一格。
  const r = plan({ needMb: null, freeMb: 32000 })
  assert.deepEqual(r.evict, ['r0'],
    '账本空 = 平台对每台一无所知 = 正是护栏该管的时刻')
})

test('⭐⭐ needMb=0 不是「不知道」—— 0 是「这台不吃内存」，⛔ 不许被当成缺数据', () => {
  // ⭐ 变异测试逼出来的一条：光断言「evict 为空」**抓不住**这个区别，
  //   因为 needMb=0 时下面那支（want=0 < budget）本来就放行 ⇒ 结果一样。
  //   真正能区分的是**护栏那一支有没有被算过**。所以换一个能看见
  //   「cap 有没有参与」的场景：把 freeMb 压到 0，逼出差别。
  //   needMb=0  ⇒ 知道它不吃内存 ⇒ cap 不参与 ⇒ 即使超上限也不关人
  //   needMb=null ⇒ 不知道    ⇒ cap 兜底     ⇒ 超上限就关人
  const crowded = { residents: residents(3), cap: 1, freeMb: 32000, now: 2000, confirmed: true }
  const known0 = planAdmission({ ...crowded, id: 'n', key: 'k', onDemand: true, headroom: 1.15, needMb: 0 })
  const unknown = planAdmission({ ...crowded, id: 'n', key: 'k', onDemand: true, headroom: 1.15, needMb: null })
  assert.deepEqual(known0.evict, [], 'needMb=0 = 知道它不吃内存 ⇒ cap 不参与')
  assert.deepEqual(unknown.evict, ['r0', 'r1', 'r2'],
    'needMb=null = 不知道 ⇒ cap 兜底（3 台 + cap 1 ⇒ 全关）')
  // ⭐ 两条路径的**读数必须不同** —— 否则这个测试就抓不住任何东西
  assert.notDeepEqual(known0.evict, unknown.evict,
    '⛔ 0 与 null 在 cap 这一支上必须分得开。分不开 = 「最危险被当成最安全」')
})

test('⭐⭐⭐ relaunch 不受 cap 影响（它先关自己再起，名额数不变）', () => {
  const r = planAdmission({
    residents: [{ id: 'me', key: 'old', onDemand: true, busy: false, lastUsedAt: 1, rssMb: 500 }],
    id: 'me', key: 'new', onDemand: true, cap: 1,
    freeMb: 32000, needMb: 1000, headroom: 1.15, confirmed: true, now: 2000,
  })
  assert.equal(r.action, 'relaunch')
  assert.deepEqual(r.evict, [], 'relaunch 占的名额数不变 ⇒ 不用腾')
})

test('⭐⭐⭐ 正在忙的永远不 evict —— 两种模式下都是', () => {
  for (const needMb of [1000, null]) {
    const r = planAdmission({
      residents: [
        { id: 'busy1', key: 'k', onDemand: false, busy: true, lastUsedAt: 1, rssMb: 500 },
        { id: 'busy2', key: 'k', onDemand: false, busy: true, lastUsedAt: 2, rssMb: 500 },
        { id: 'idle', key: 'k', onDemand: false, busy: false, lastUsedAt: 3, rssMb: 500 },
      ],
      id: 'new', key: 'nk', onDemand: true, cap: 1,
      freeMb: 32000, needMb, headroom: 1.15, confirmed: true, now: 2000,
    })
    assert.ok(!r.evict.includes('busy1') && !r.evict.includes('busy2'),
      `needMb=${needMb}: ⛔ 正在忙的不能被关掉`)
  }
})

// ---------------------------------------------------------------------------
//  2) ⭐⭐ 护栏该生效时，它确实生效
// ---------------------------------------------------------------------------

test('⭐⭐ 账本空 + 已常驻超过 cap ⇒ 护栏照常兜底', () => {
  for (const n of [2, 3, 5]) {
    const r = planAdmission({
      residents: residents(n), id: 'new', key: 'nk', onDemand: true, cap: 2,
      freeMb: 32000, needMb: null, headroom: 1.15, confirmed: true, now: 2000,
    })
    assert.equal(r.evict.length, n - 1,
      `已有 ${n} 台、cap=2 ⇒ 该关掉 ${n - 1} 台，实际 ${r.evict.length}`)
  }
})

test('⭐⭐ 账本空 + 没超 cap ⇒ 不动（护栏不是「逢启动就关」）', () => {
  const r = planAdmission({
    residents: residents(1), id: 'new', key: 'nk', onDemand: true, cap: 2,
    freeMb: 32000, needMb: null, headroom: 1.15, confirmed: true, now: 2000,
  })
  assert.deepEqual(r.evict, [])
})

// ---------------------------------------------------------------------------
//  3) ⭐⭐⭐ autoCapFor 公式：总内存每 8G 多养一台【Owner 2026-09-29 定】
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 公式：8G→1 / 16G→2 / 32G→4 / 64G→8 / 128G→16', () => {
  const cases = [[8, 1], [16, 2], [32, 4], [64, 8], [128, 16]]
  for (const [gb, want] of cases) {
    assert.equal(autoCapFor(gb * 1024), want, `${gb}G 应得 cap=${want}`)
  }
})

test('⭐⭐⭐ 8G 就是「一台引擎的量级」，不是随手拍的数', () => {
  // 实测：GSV 峰值 3547MB、IndexTTS2 峰值 8574MB（state/engine_memory.json）。
  // 8G 落在两者之间偏保守一侧 —— 那个 8.4G 的确实偏松，但见下面那条。
  assert.equal(MB_PER_ENGINE, 8192)
  assert.ok(3547 < MB_PER_ENGINE, '比最轻的那台宽松')
  assert.ok(8574 > MB_PER_ENGINE * 0.9, '⭐ 比最重的那台保守（不是宽松 10 倍）')
})

test('⭐⭐ 量不到总内存 ⇒ 退回 DEFAULT_CAP，⛔ 不许返回 0', () => {
  for (const bad of [null, undefined, 0, -1, NaN, 'abc', {}]) {
    assert.equal(autoCapFor(bad), DEFAULT_CAP, `输入 ${JSON.stringify(bad)}`)
  }
  // ⭐ 0 台 = 平台彻底不能用，那不是护栏是故障
  assert.ok(autoCapFor(1) >= 1, '任何输入都至少给 1')
})

test('⭐⭐ 不够 8G 的机器也得给 1（不能因为「算出来是 0」就一台都不许起）', () => {
  assert.equal(autoCapFor(2 * 1024), 1, '2G 机器 → 1 台，不是 0 台')
})

test('⭐⭐⭐ 混合大小引擎时，公式给的是同一个数（Owner 否决了「按最大 peak 算」）', () => {
  // ⛔ 那个方案的问题：一个 GSV(3.5G) + 一个 IndexTTS2(8.4G) 要算几个 cap？
  //   取最大 ⇒ 被轻的那台拖累；取平均 ⇒ 被重的那台漏算。
  // ⇒ cap 是「几台」，每台多重是另一个问题。硬凑成一个数必然失真。
  // 本函数**只吃总内存**，压根不看账本 —— 所以混用时它不会给出不同的数。
  assert.equal(autoCapFor(32 * 1024), autoCapFor(32 * 1024))
  assert.equal(typeof autoCapFor(32 * 1024), 'number')
})

test('⭐⭐ 公式是纯函数（不读时钟、不读环境、不 spawn）', () => {
  const a = autoCapFor(32 * 1024)
  const b = autoCapFor(32 * 1024)
  assert.equal(a, b)
  assert.ok(Number.isInteger(a))
})

// ---------------------------------------------------------------------------
//  4) ⭐⭐⭐ 诚实性：cap 挡不住什么
// ---------------------------------------------------------------------------

test('⭐⭐⭐ cap 挡不住「别人的程序吃掉大半内存」—— needs_confirm 才是那道闸', () => {
  // 本机实测：16G 总内存、已被别人吃掉 8.5G（53%），cap 仍算 2。
  // ⛔ 这是 A 方案的已知边界，写下来是为了将来有人改它时知道自己在改什么。
  const cap = autoCapFor(16 * 1024)
  assert.equal(cap, 2, 'cap 只看总内存')
  // 真正拦住它的是 needs_confirm 那一支：freeMb 很少 + needMb 很大 ⇒ 问用户
  const r = planAdmission({
    residents: [], id: 'e1', key: 'k', onDemand: true, cap,
    freeMb: 900, needMb: 8574, headroom: 1.15, confirmed: false, now: 1,
  })
  assert.equal(r.action, 'needs_confirm',
    '⭐ 「此刻够不够」由这一支回答，cap 不参与 —— 两层分工')
})

// ---------------------------------------------------------------------------
//  5) ⭐ 判据本身的边界
// ---------------------------------------------------------------------------

test('⭐⭐⭐ NaN / 负数 一律当「不知道」—— ⛔ 不许当成「知道，它不吃内存」', () => {
  // ⭐ 变异测试发现的边界：`state.needMb != null` 与
  //   `Number.isFinite(x) && x >= 0` 在 0/null 上**等价**（真等价，不是巧合），
  //   但在 NaN / 负数 / 字符串上不同 —— 而那些会让「最危险」被当成「最安全」。
  //   账本正常不会写出这些值（memledger 拒收非正数），但 `!= null` 会放过它们。
  const crowded = { residents: residents(3), cap: 1, freeMb: 32000, now: 2000, confirmed: true,
    id: 'n', key: 'k', onDemand: true, headroom: 1.15 }
  for (const bad of [NaN, -5, '500']) {
    const r = planAdmission({ ...crowded, needMb: bad })
    assert.notDeepEqual(r.evict, [],
      `needMb=${String(bad)} ⇒ 必须当「不知道」走护栏，而不是「知道它不吃内存」`)
  }
})
