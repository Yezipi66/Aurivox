// B5 占用透明度 —— 前端那两个翻函数的测试。
//
// ⭐ 本项目的纪律：**变异测试才算证明**。所以下面每条都写了
//    「改坏它，看测试会不会红」—— 只测「函数返回了东西」毫无意义。
//    （规则见 real-test-vs-text-guard。）
//
// ⭐⭐ 最重要的一条：`0` 与「没量到过」必须**分得开**。
//    0 的意思是「它不吃内存」，而那是最危险的说法（用户会以为可以多开）。
//    memledger 在没量过时返回 null —— 那个 null 一路传到 UI。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  fmtMemMb,
  occupancyBadge,
  engineUsageBadge,
} from './engines.js'

// ---------------------------------------------------------------------------
//  fmtMemMb
// ---------------------------------------------------------------------------

test('fmtMemMb: 没量到过是 ?，⛔ 绝不是 0', () => {
  assert.equal(fmtMemMb(null), '?')
  assert.equal(fmtMemMb(undefined), '?')
  // ⭐ 变异靶：把 null 也返回 '0 MB' ⇒ 这条必须红
  assert.notEqual(fmtMemMb(null), '0 MB')
})

test('fmtMemMb: 0 和负数也当「不知道」——它们不是「不吃内存」', () => {
  assert.equal(fmtMemMb(0), '?')
  assert.equal(fmtMemMb(-5), '?')
  // ⭐ 变异靶：0 → '0 MB' ⇒ 必须红
  assert.notEqual(fmtMemMb(0), '0 MB')
})

test('fmtMemMb: MB 与 GB 两档', () => {
  assert.equal(fmtMemMb(512), '512 MB')
  assert.equal(fmtMemMb(1024), '1.0 GB')
  assert.equal(fmtMemMb(8192), '8.0 GB')
  // ⭐ 变异靶：把 GB 阈值从 1024 改成 100 ⇒ '512 MB' 会变 '5.1 GB' ⇒ 必须红
  assert.equal(fmtMemMb(512), '512 MB')
})

// ---------------------------------------------------------------------------
//  occupancyBadge —— 机器级
// ---------------------------------------------------------------------------

const OCC = {
  // ⭐⭐ 照**后端 occupancyReport() 的真实产物**写，不是照想象写。
  //   键名是 free_mb / total_mb / resident_peak_mb（snake_case），
  //   数字都在 summary 里 —— 这是 occupancyWiring.node.test.js 用真后端
  //   逼出来的（第一版照想象写，全绿但界面上什么都显示不出来）。
  engines: [
    { id: 'a', label: 'A', running: true, peak_mb: 3000, measured: true, last_attempt_unfinished: false },
    { id: 'b', label: 'B', running: false, peak_mb: null, measured: false, last_attempt_unfinished: false },
  ],
  summary: {
    installed: 2, running: 1, running_count: 1,
    resident_peak_mb: 3000, all_known_peak_mb: 3000, unknown_count: 1,
    free_mb: 2048, total_mb: 8192, used_by_others_mb: 6144, cap: 2, cap_source: null,
  },
  headline: '1 台在跑，历史峰值合计约 2.9 GB。',
}

test('occupancyBadge: 缺 occupancy 段 ⇒ null（⛔ 不是「没占用」）', () => {
  assert.equal(occupancyBadge(null), null)
  assert.equal(occupancyBadge(undefined), null)
  // ⭐ 变异靶：缺数据时返回一个「没占用」的绿标 ⇒ 必须红
  assert.equal(occupancyBadge({}), null)
  assert.equal(occupancyBadge({ engines: [] }), null)  // ⛔ 缺 summary 也是「不知道」
})

test('occupancyBadge: 后端报错 ⇒ 读不到，⛔ 绝不说「没占用」', () => {
  const b = occupancyBadge({ error: 'ledger 打不开' })
  assert.equal(b.tone, 'unknown')
  assert.match(b.label, /读不到/)
  // ⭐ 变异靶：把 error 分支删掉，让它掉到「0 台在跑」⇒ 必须红
  assert.notEqual(b.tone, 'idle')
})

test('occupancyBadge: 跑着几台就说几台', () => {
  const b = occupancyBadge(OCC)
  assert.equal(b.tone, 'ok')
  assert.match(b.label, /1 台在跑/)
})

test('occupancyBadge: 一台没跑 ⇒ idle，且说清「用到才起」', () => {
  const b = occupancyBadge({ ...OCC, summary: { ...OCC.summary, running: 0, resident_peak_mb: 0 } })
  assert.equal(b.tone, 'idle')
  assert.ok(b.detail.some((d) => /用到才起/.test(d)), '要说清是按需起的')
})

test('occupancyBadge: 峰值与系统余量都进 detail', () => {
  const b = occupancyBadge(OCC)
  assert.ok(b.detail.some((d) => d.includes(fmtMemMb(3000))), '历史峰值合计')
  assert.ok(b.detail.some((d) => /系统剩余/.test(d)), '系统剩余')
  // ⭐ 变异靶：删掉峰值那一行 ⇒ 必须红
  assert.equal(b.detail.filter((d) => /GB/.test(d)).length, 2)
})

// ---------------------------------------------------------------------------
//  engineUsageBadge —— 引擎级（三态 + 一次 OOM 警告）
// ---------------------------------------------------------------------------

test('engineUsageBadge: 没量到过 ⇒ unknown，⛔ 绝不是 0/ok', () => {
  const b = engineUsageBadge({ id: 'b', label: 'B' }, OCC)
  assert.equal(b.tone, 'unknown')
  assert.match(b.label, /没量到过/)
  // ⭐ 变异靶：把「没量到」判成 ok（显示 0 MB）⇒ 必须红
  assert.notEqual(b.tone, 'ok')
  assert.ok(!/\b0\s?(MB|GB)/.test(b.label), '⛔ 标签里不许出现 0 MB')
})

test('engineUsageBadge: 在跑 + 有峰值 ⇒ busy + 峰值', () => {
  const b = engineUsageBadge({ id: 'a', label: 'A' }, OCC)
  assert.equal(b.tone, 'busy')
  assert.match(b.label, new RegExp(fmtMemMb(3000).replace('.', '\\.')))
})

test('engineUsageBadge: 在跑但没量到 ⇒ busy，且说清「没量到」', () => {
  const occ = { ...OCC, engines: [{ id: 'c', label: 'C', running: true, peak_mb: null, last_attempt_unfinished: false }] }
  const b = engineUsageBadge({ id: 'c', label: 'C' }, occ)
  assert.equal(b.tone, 'busy')
  assert.match(b.label, /没量到/)
  // ⭐ 变异靶：让它显示成 idle ⇒ 必须红（它在跑）
  assert.notEqual(b.tone, 'idle')
})

test('engineUsageBadge: 没在跑 + 有峰值 ⇒ idle + 「大概会吃到」', () => {
  const occ = { ...OCC, engines: [{ id: 'a', label: 'A', running: false, peak_mb: 3000, last_attempt_unfinished: false }] }
  const b = engineUsageBadge({ id: 'a', label: 'A' }, occ)
  assert.equal(b.tone, 'idle')
  assert.match(b.title, /大概会吃到/)
})

test('engineUsageBadge: ⭐ 上次没起来 ⇒ bad，排在「没量到」前面', () => {
  const occ = { ...OCC, engines: [{ id: 'd', label: 'D', running: false, peak_mb: null, last_attempt_unfinished: true }] }
  const b = engineUsageBadge({ id: 'd', label: 'D' }, occ)
  assert.equal(b.tone, 'bad')
  assert.match(b.label, /上次没起来/)
  // ⭐⭐ 变异靶：把 last_attempt_unfinished 这一支删掉/挪到最后
  //   ⇒ 它会掉进「没量到过」(unknown) ⇒ 必须红。
  //   这是本组测试存在的**主要理由**：attempting 有两种形状
  //   （数组 / 对象），漏认的代价是「OOM 预警永远不出现，而且不报错」。
  assert.notEqual(b.tone, 'unknown')
})

test('engineUsageBadge: attempting 是数组形状时也要认（后端两种都发）', () => {
  // 后端 attempting 可能是 ['d'] 也可能是 {d:{...}}；
  // ⭐ 前端这一层拿到的是已经算好的 last_attempt_unfinished，
  //   但仍要验「这个布尔被真的读了」—— 变异靶：改成 !row.last_attempt_unfinished
  const occ = { ...OCC, engines: [{ id: 'e', label: 'E', running: true, peak_mb: 3000, last_attempt_unfinished: true }] }
  const b = engineUsageBadge({ id: 'e', label: 'E' }, occ)
  assert.equal(b.tone, 'bad')
  // ⭐ 变异靶：把优先级搞反（先判 running/peak）⇒ 必须红
  assert.notEqual(b.tone, 'busy')
})

test('engineUsageBadge: occupancy 里没有这台 ⇒ null（⛔ 不画「0」）', () => {
  assert.equal(engineUsageBadge({ id: 'zzz' }, OCC), null)
  // ⭐ 变异靶：找不到时返回一个「0 MB」的徽章 ⇒ 必须红
  assert.equal(engineUsageBadge({ id: 'zzz' }, OCC), null)
})

test('engineUsageBadge: 没有 occupancy 段 ⇒ null', () => {
  assert.equal(engineUsageBadge({ id: 'a' }, null), null)
  assert.equal(engineUsageBadge(null, OCC), null)
})
