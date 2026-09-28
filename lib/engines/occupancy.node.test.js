'use strict'
// ============================================================================
//  占用报告的守卫【B5 · Owner 2026-09-29】
//
//  ⭐⭐ 这份文件守的是**诚实性**，不是计算。
//     Owner 纠正过我一次：我说「实时读进程更准」，Owner 指出
//     **峰值就是 OOM 风险本身**，尤其在 Linux 上实时读数反而最危险
//     （OOM killer 正在杀进程时读到的数既不是常态也不是峰值）。
//     memledger.js 早就写着「只涨不落……按上次的记，跑一次短文本就会把
//     上次长文本的教训抹掉 ⇒ 下次长文本 OOM」。
//     ⇒ 下面有一条测试专门钉住「不许退回实时读数」。
// ============================================================================

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { occupancyReport, engineOccupancy, fmtMb, attemptingHas } = require('./occupancy.js')

const P = (id, label) => ({ id, label: label || id })

// ---------------------------------------------------------------------------
//  1) ⭐⭐⭐ 三态：量过 / 没量过 / 谎报「不吃内存」
// ---------------------------------------------------------------------------

test('⭐⭐⭐ peak_mb 是三态，⛔ null（没量过）绝不能变成 0', () => {
  // 0 = 「这台引擎不吃内存」—— 那是**最危险**的说法，会让平台随便起。
  const e = engineOccupancy(P('a'), { needMbOf: () => null })
  assert.equal(e.peak_mb, null, '没量过必须是 null')
  assert.equal(e.measured, false)
})

test('⭐⭐⭐ 账本答不上来（抛异常 / 没注入）时也报 null，⛔ 不许崩、不许编', () => {
  for (const of_ of [
    () => { throw new Error('账本坏了') },
    () => NaN, () => -5, () => 0,
  ]) {
    const e = engineOccupancy(P('a'), { needMbOf: of_ })
    assert.equal(e.peak_mb, null, '答不上来 = 不知道，不是 0')
  }
  const noInject = engineOccupancy(P('a'), {})
  assert.equal(noInject.peak_mb, null, '没注入 needMbOf ⇒ 不知道')
})

test('⭐⭐⭐ measured 与 peak_mb 必须一致 —— ⛔ 0 绝不能标成「量过」', () => {
  // ⭐ 变异测试逼出来的：把 `peak = 0` 那条支路放行之后，
  //   peak_mb 变成 0 **而 measured 仍是 true** —— 于是
  //   「这台引擎不吃内存」被当成实测结论报了出去。
  //   0 是**最危险**的说法（memledger 拒收非正数就是为了这个）。
  for (const bad of [null, NaN, -5, 0, undefined]) {
    const e = engineOccupancy(P('a'), { needMbOf: () => bad })
    assert.equal(e.peak_mb, null, `needMbOf→${String(bad)} 必须是 null`)
    assert.equal(e.measured, false, `needMbOf→${String(bad)} ⛔ 不许标成「量过」`)
  }
  // 反向：量过就必须是真的正数
  const ok = engineOccupancy(P('a'), { needMbOf: () => 1 })
  assert.equal(ok.measured, true)
  assert.equal(ok.peak_mb, 1)
})

test('⭐⭐⭐ 真实峰值如实报出', () => {
  const e = engineOccupancy(P('indextts2'), { needMbOf: () => 8574 })
  assert.equal(e.peak_mb, 8574)
  assert.equal(e.measured, true)
})

// ---------------------------------------------------------------------------
//  2) ⭐⭐⭐ 不许退回「实时读进程」
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 这一层不许有实时读进程的代码路径', () => {
  const src = fs.readFileSync(path.join(__dirname, 'occupancy.js'), 'utf8')
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  // ⛔ sampleTree / processTable 是「读真实进程树」的那一套。
  //   它在 memprobe.js 里是对的（记账要用），但**展示层不许引入** ——
  //   Linux 上 OOM killer 正在杀进程时读到的数是崩溃中的数，不是它的真实高度。
  for (const forbidden of ['sampleTree', 'collectTree', 'processTable']) {
    assert.equal(code.includes(forbidden), false,
      `⛔ occupancy 用了 ${forbidden}（实时读进程）—— Owner 2026-09-29 已纠正：峰值才是 OOM 风险本身`)
  }
})

test('⭐⭐⭐ 字段名必须叫 peak（⛔ 不许叫 current/rss/usage）—— 名字在教育用户', () => {
  const e = engineOccupancy(P('a'), { needMbOf: () => 100 })
  assert.ok('peak_mb' in e, '⛔ 字段名要如实说是峰值')
  assert.equal('current_mb' in e, false)
  assert.equal('rss_mb' in e, false)
})

// ---------------------------------------------------------------------------
//  3) ⭐⭐ summary 的四个数不能互相糊
// ---------------------------------------------------------------------------

test('⭐⭐⭐ resident_peak_mb 只算**在跑的**，不含没在跑但量过的', () => {
  const rep = occupancyReport({
    profiles: [P('a'), P('b'), P('c')],
    status: { a: { running: true }, b: { running: true } },
    needMbOf: (id) => ({ a: 1000, b: 2000, c: 8000 })[id],
  })
  assert.equal(rep.summary.running_count, 2)
  assert.equal(rep.summary.resident_peak_mb, 3000, '只有 a+b')
  assert.equal(rep.summary.all_known_peak_mb, 11000, 'a+b+c 都量过')
})

test('⭐⭐⭐ unknown_count 数的是「没量过」，不是「没在跑」', () => {
  const rep = occupancyReport({
    profiles: [P('a'), P('b')],
    status: { a: { running: true } },
    needMbOf: (id) => (id === 'a' ? 1000 : null),
  })
  assert.equal(rep.summary.unknown_count, 1, 'b 装着但没量过 ⇒ 风险最高的那一格')
})

test('⭐⭐⭐ 没在跑但量过 ⇒ 仍算 all_known，不算 unknown', () => {
  const rep = occupancyReport({
    profiles: [P('a')],
    status: {},                          // 一台都没在跑
    needMbOf: () => 5000,
  })
  assert.equal(rep.summary.unknown_count, 0)
  assert.equal(rep.summary.resident_peak_mb, 0, '没在跑 ⇒ 常驻占用是 0')
  assert.equal(rep.summary.all_known_peak_mb, 5000, '但量过这件事本身是已知的')
})

// ---------------------------------------------------------------------------
//  4) ⭐⭐⭐ headline：把「该不该担心」说清楚
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 一台都没量过时，⛔ 不许报一个让人安心的总数', () => {
  const rep = occupancyReport({
    profiles: [P('a'), P('b')], status: { a: { running: true } },
    needMbOf: () => null,
  })
  assert.match(rep.headline, /从来没量过/,
    '⭐ 「知不知道」比「多不多」更要紧 —— 不知道的那几台才是风险')
  assert.doesNotMatch(rep.headline, /0 MB|峰值合计约 0/,
    '⛔ 不许用「合计 0」把「不知道」说成「不占」')
})

test('⭐⭐⭐ headline 里「没量过」那句不能被悄悄删掉（变异测试逼出来）', () => {
  const rep = occupancyReport({
    profiles: [P('a')], status: { a: { running: true } }, needMbOf: () => null,
  })
  // ⭐ 断言它**具体说了什么**，而不是「大概提到了没量过」——
  //   否则把那句话整句删掉，测试可能换个词就混过去。
  assert.match(rep.headline, /从来没量过占用/,
    '⛔ 这句话是 Owner 那一刀的核心：让人知道哪几台是未知的')
  assert.match(rep.headline, /⚠/, '要有警示标记，不能平淡地混进数字里')
})

test('⭐⭐⭐ 有没量过的 + 有量过的 ⇒ 两边都要说', () => {
  const rep = occupancyReport({
    profiles: [P('known'), P('unknown')], status: { known: { running: true } },
    needMbOf: (id) => (id === 'known' ? 1000 : null),
  })
  assert.match(rep.headline, /1 台在跑/)
  assert.match(rep.headline, /unknown 从来没量过/)
})

test('⭐⭐ 上次没活着回来 ⇒ 必须点出来（这是 OOM 的唯一现场证据）', () => {
  const rep = occupancyReport({
    profiles: [P('a')], status: { a: { running: true } },
    needMbOf: () => null,
    attempting: ['a'],                    // 上次起了没写完
  })
  assert.match(rep.headline, /上次没活着回来/,
    '⭐ memledger.markAttempting 存在的全部理由就是这一刻')
})

test('⭐⭐ 一台都没在跑时要说清楚「用到才起」，不是沉默', () => {
  const rep = occupancyReport({ profiles: [P('a')], status: {}, needMbOf: () => 1000 })
  assert.match(rep.headline, /一台都没在跑|用到才起/)
})

test('⭐⭐ 没装任何引擎 ⇒ 说实话，不报 0 台之外的任何数', () => {
  const rep = occupancyReport({ profiles: [], status: {} })
  assert.match(rep.headline, /还没有装任何引擎/)
  assert.equal(rep.summary.running_count, 0)
})

// ---------------------------------------------------------------------------
//  5) ⭐⭐ 内存读数：cap 用 total，这里两个都要
// ---------------------------------------------------------------------------

test('⭐⭐⭐ free / total / 已被别人吃掉，三个都要', () => {
  const rep = occupancyReport({
    profiles: [P('a')], status: { a: { running: true } }, needMbOf: () => 1000,
    mem: { freeMb: () => 7000, totalMb: () => 16000 },
  })
  assert.equal(rep.summary.free_mb, 7000)
  assert.equal(rep.summary.total_mb, 16000)
  assert.equal(rep.summary.used_by_others_mb, 9000,
    '⭐ 「已被别人吃掉」是 cap 用 total 不用 free 的原因（见 B3）')
})

test('⭐⭐ mem 读不出来 ⇒ 报 null，⛔ 不许编 0（0 = 系统一点内存没被占）', () => {
  const rep = occupancyReport({
    profiles: [P('a')], status: {}, needMbOf: () => 1000,
    mem: { freeMb: () => { throw new Error('读不到') }, totalMb: () => 16000 },
  })
  assert.equal(rep.summary.free_mb, null)
  assert.equal(rep.summary.used_by_others_mb, null, '一个数缺了，相减的结果也不能编')
})

test('⭐⭐ cap 与它的来源一起报出来 —— 用户得知道这是自动算的还是他设的', () => {
  const auto = occupancyReport({ profiles: [], status: {}, cap: 4, capSource: 'auto' })
  const env = occupancyReport({ profiles: [], status: {}, cap: 2, capSource: 'env' })
  assert.equal(auto.summary.cap_source, 'auto')
  assert.equal(env.summary.cap_source, 'env')
  assert.notEqual(auto.summary.cap, env.summary.cap, '⭐ 自动算与显式设的可以不同，要能看出来')
})

// ---------------------------------------------------------------------------
//  6) 纯计算 + 数值格式
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 纯计算：不 spawn、不读时钟、不写盘', () => {
  const src = fs.readFileSync(path.join(__dirname, 'occupancy.js'), 'utf8')
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const forbidden of ['spawn', 'execSync', 'execFile', 'Date.now', 'writeFile', 'fs.']) {
    assert.equal(code.includes(forbidden), false,
      `⛔ occupancy 里出现了 ${forbidden} —— 这一层只做计算，I/O 全在调用方`)
  }
})

test('⭐⭐ 同一份输入必须给出同一份输出（界面上要能比对）', () => {
  const mk = () => occupancyReport({
    profiles: [P('a'), P('b')], status: { a: { running: true } },
    needMbOf: (id) => (id === 'a' ? 1000 : null),
    mem: { freeMb: () => 7000, totalMb: () => 16000 }, cap: 2, capSource: 'auto',
  })
  assert.deepEqual(mk(), mk())
})

test('⭐ 数值格式：GB 只在够大时用，小数字保持 MB（8234 不该写成 8.0 GB）', () => {
  assert.equal(fmtMb(8234), '8.0 GB')
  assert.equal(fmtMb(512), '512 MB')
  assert.equal(fmtMb(0), '0 MB')
  assert.equal(fmtMb(NaN), '?', '⛔ 读不出来要说「?」，不写 0')
})

test('⭐⭐ 报告里不许出现任何一台具体引擎名（换引擎不该改这个文件）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'occupancy.js'), 'utf8')
  const code = src.replace(/\/\/.*$/gm, '').replace(/'(?:indextts2|gpt-sovits)'/g, "''")
  for (const name of ['indextts2', 'gpt-sovits', 'IndexTTS2', 'GPT-SoVITS']) {
    assert.equal(code.includes(name), false, `⛔ 出现了具体引擎名 ${name}`)
  }
})

// ---------------------------------------------------------------------------
//  7) ⭐⭐⭐ attempting 的两种形状【这条是被一个真 bug 逼出来的】
// ---------------------------------------------------------------------------

test('⭐⭐⭐ attempting 传数组或传对象，都必须认出来', () => {
  // ⚠ 真实 bug：supervisor 注入的 attemptingIds() 返回**数组** ['a']，
  //   而 occupancy 原来写的是 opts.attempting[id] ⇒ 数组下标 undefined
  //   ⇒ last_attempt_unfinished 永远 false ⇒ **OOM 预警永远不出现，且不报错**。
  //   20 条测试里只有一条碰了它，且用的是对象形状 ⇒ 逃过了。
  assert.equal(attemptingHas(['a', 'b'], 'a'), true, '数组形状')
  assert.equal(attemptingHas(['a', 'b'], 'c'), false)
  assert.equal(attemptingHas({ a: { startedAt: 1 } }, 'a'), true, '对象形状')
  assert.equal(attemptingHas({ a: {} }, 'b'), false)
  assert.equal(attemptingHas(null, 'a'), false)
  assert.equal(attemptingHas(undefined, 'a'), false)
})

test('⭐⭐⭐ 数组形状下 headline 必须点出「上次没活着回来」（端到端）', () => {
  const rep = occupancyReport({
    profiles: [P('a')], status: { a: { running: true } },
    needMbOf: () => null,
    attempting: ['a'],           // ⭐ 数组 —— 真实注入的形状
  })
  assert.equal(rep.engines[0].last_attempt_unfinished, true)
  assert.match(rep.headline, /上次没活着回来/)
})

test('⭐⭐ 对象形状下同样要点出来（两种都得走通）', () => {
  const rep = occupancyReport({
    profiles: [P('a')], status: { a: { running: true } },
    needMbOf: () => null,
    attempting: { a: { startedAt: 1788509467196 } },
  })
  assert.equal(rep.engines[0].last_attempt_unfinished, true)
  assert.match(rep.headline, /上次没活着回来/)
})

test('⭐⭐ summary 四个基础数：装了/在跑/未知/cap 都要在（缺一个界面就画错）', () => {
  const rep = occupancyReport({
    profiles: [P('a'), P('b'), P('c')],
    status: { a: { running: true } },
    needMbOf: (id) => (id === 'a' ? 1000 : null),
    cap: 4, capSource: 'auto',
  })
  const s = rep.summary
  assert.equal(s.installed, 3, '⛔ 装了 3 台 —— 这个数驱动界面上的台数')
  assert.equal(s.running_count, 1)
  assert.equal(s.unknown_count, 2)
  assert.equal(s.cap, 4)
  assert.equal(s.cap_source, 'auto')
})
