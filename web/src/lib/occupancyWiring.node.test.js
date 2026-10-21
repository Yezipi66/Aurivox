// 占用徽章的接线完整性：证明后端真产出的东西能喂进前端真显示的徽章。
// 输入用后端真实的 occupancyReport() 产物，不用手写的 occ 对象：手写输入的字段名对不上时，
// 测试照样全绿，却什么都没验。这里任何一边改字段名，这组测试立刻红。
// 这一组是接线测试不是单元测试：跑的是两个真函数，只跳过 React 渲染。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { occupancyReport, engineOccupancy } from '../../../lib/engines/occupancy.js'
import { occupancyBadge, engineUsageBadge, fmtMemMb } from './engines.js'

/** 照 occupancyReport() 真正读的样子造：它读 status[id].running。输入形状必须从读它的那一端确认。 */
function makeStatus (runningIds) {
  const out = {}
  for (const id of runningIds) out[id] = { running: true, busy: false }
  return out
}

test('接线：后端真实产物 → 机器级徽章（⛔ 手写对象不算）', () => {
  const occ = occupancyReport({
    profiles: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    status: makeStatus(['a']),
    // occupancyReport 读的是 needMbOf 这个闭包，不是 ledger.needMb：给错的话 peak 恒为 null。
    needMbOf: (id) => (id === 'a' ? 3000 : null),
    attempting: {},
    mem: { freeMb: 2048, totalMb: 8192 },
    cap: 2,
  })
  // 先钉住后端契约本身：前端就是靠这几个字段活的。
  assert.ok(Array.isArray(occ.engines), 'occupancy.engines 必须是数组')
  assert.equal(occ.engines.length, 2)
  assert.equal(occ.summary.running, 1)
  assert.equal(occ.summary.resident_peak_mb, 3000)

  const b = occupancyBadge(occ)
  assert.ok(b, '真实产物必须能翻成徽章')
  assert.equal(b.tone, 'ok')
  assert.match(b.label, /1 台运行中/)
  // 峰值要真的进去（数值来自后端，不是测试自己编的）。
  assert.ok(b.detail.some((d) => d.includes(fmtMemMb(3000))), '历史峰值合计')
})

test('接线：从来没量到过的那台 ⇒ unknown，⛔ 前端不许显示 0', () => {
  const occ = occupancyReport({
    profiles: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    status: makeStatus([]),
    needMbOf: () => null,                    // 两台都没量过
    attempting: {},
    mem: { freeMb: 2048, totalMb: 8192 },
    cap: 2,
  })
  const b = engineUsageBadge({ id: 'a', label: 'A' }, occ)
  assert.equal(b.tone, 'unknown')
  // 核心断言：真实后端给出 null 时，前端不许把它变成「0 MB」或绿标。
  // 0 的意思是「它不吃内存」，那是最危险的说法（用户会以为能多开）。
  assert.ok(!/\b0\s?(MB|GB)/.test(b.label), `⛔ 标签里出现了 0：${b.label}`)
  assert.match(b.label, /未测量/)
})

test('接线：attempting 是数组形状时，OOM 警告能到 UI（后端两种都发）', () => {
  // memledger 的 attempting 有两种形状：['b']（id 数组）与 {b:{...}}（账本原样）。
  // 按下标取数组会取到 undefined ⇒ 永远是 false ⇒ OOM 预警永远不出现，而且不报任何错。
  const occ = occupancyReport({
    profiles: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    status: makeStatus([]),
    needMbOf: () => null,
    attempting: ['b'],                       // 数组形状
    mem: { freeMb: 512, totalMb: 8192 },
    cap: 2,
  })
  const b = engineUsageBadge({ id: 'b', label: 'B' }, occ)
  assert.equal(b.tone, 'bad', '⛔ 数组形状的 attempting 必须被认出来')
  assert.match(b.label, /上次启动失败/)
  // 变异靶：把 attemptingHas 的数组分支删掉 ⇒ 这条必须红。
})

test('接线：attempting 是对象形状时同样要认', () => {
  const occ = occupancyReport({
    profiles: [{ id: 'b', label: 'B' }],
    status: makeStatus([]),
    needMbOf: () => null,
    attempting: { b: { at: 123 } },          // 对象形状
    mem: { freeMb: 512, totalMb: 8192 },
    cap: 2,
  })
  const b = engineUsageBadge({ id: 'b', label: 'B' }, occ)
  assert.equal(b.tone, 'bad')
})

test('接线：后端报 error 时前端说「读不到」，⛔ 绝不说「没占用」', () => {
  // routes/engines.js 在 occupancy 抛错时给的是 { error: <消息> }，没有 engines 数组。
  // 前端必须据此说「读不到」。
  const b = occupancyBadge({ error: '账本打不开' })
  assert.equal(b.tone, 'unknown')
  assert.match(b.label, /无法读取/)
  // 变异靶：把 !Array.isArray(occ.engines) 那道闸删掉 ⇒ 它会掉到「0 台在跑」的绿标 ⇒ 必须红。
  assert.notEqual(b.tone, 'idle')
})

test('接线：occupancy 那一段整个缺失 ⇒ 不画（⛔ 不画「没占用」）', () => {
  // 老 broker 或请求失败 ⇒ r.occupancy 是 undefined。App.jsx 传下来的是 null。
  assert.equal(occupancyBadge(null), null)
  assert.equal(occupancyBadge(undefined), null)
  // 变异靶：让它返回一个 idle 徽章 ⇒ 必须红。
})

test('接线：engineOccupancy 单台那一份也能直接喂前端', () => {
  const row = engineOccupancy(
    { id: 'a', label: 'A' },
    { resident: true, needMbOf: () => 1500, attempting: {} })
  assert.equal(row.running, true)
  assert.equal(row.peak_mb, 1500)
  assert.equal(row.measured, true)
  assert.equal(row.last_attempt_unfinished, false)

  const b = engineUsageBadge({ id: 'a', label: 'A' }, { engines: [row] })
  assert.equal(b.tone, 'busy')
  assert.ok(b.label.includes(fmtMemMb(1500)))
})
