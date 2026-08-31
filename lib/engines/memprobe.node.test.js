'use strict'

const test = require('node:test')
const assert = require('node:assert')

const {
  HEADROOM, MAX_TREE, processTable, collectTree, sampleTree,
  peakIsFree, freeMb, withHeadroom,
} = require('./memprobe')

// 造一张假进程表。⛔ 不用真机的表：真机的表每次都不一样，测不出确定的东西。
function R(pid, ppid, rssMb, peakMb) {
  return { pid, ppid, name: 'p' + pid,
    rss: rssMb * 1024 * 1024,
    peak: peakMb == null ? null : peakMb * 1024 * 1024 }
}

// ---------------------------------------------------------------------------
//  建树
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 内存全在子进程里 —— 只看根进程会漏掉 99%', () => {
  // 真机 2026-08-31 实测的形状：壳 4.6MB，真身 3547MB。
  const rows = [R(19320, 16944, 5, 5), R(10260, 19320, 468, 3547)]
  const s = sampleTree(19320, { rows, platform: 'linux' })
  assert.equal(s.count, 2)
  assert.equal(s.peakMb, 3552, '必须是整棵树的和，⛔ 不是根进程那 5MB')
})

test('四层链也收得全', () => {
  const rows = [R(1, 0, 1, 1), R(2, 1, 1, 1), R(3, 2, 1, 1), R(4, 3, 100, 200)]
  assert.equal(collectTree(rows, 1).length, 4)
})

test('⛔ 只收子孙，不收兄弟', () => {
  const rows = [R(1, 0, 1, 1), R(2, 1, 10, 10), R(99, 0, 9999, 9999)]
  const s = sampleTree(1, { rows, platform: 'linux' })
  assert.equal(s.count, 2)
})

test('⚠ 父子关系成环也不会死循环', () => {
  // 进程表是边读边变的，理论上能读出自相矛盾的父子关系。
  const rows = [R(1, 2, 1, 1), R(2, 1, 1, 1)]
  const t = collectTree(rows, 1)
  assert.ok(t.length <= 2)
})

test('⚠ 认错爹收进半台机器时，有个上限拦着', () => {
  const rows = [R(1, 0, 1, 1)]
  for (let i = 2; i < MAX_TREE + 200; i++) rows.push(R(i, 1, 1, 1))
  assert.ok(collectTree(rows, 1).length <= MAX_TREE)
})

// ---------------------------------------------------------------------------
//  「量不到」和「量到 0」必须分得开
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 进程已经没了 ⇒ ok:false，⛔ 绝不返回 0', () => {
  // 记 0 等于告诉账本「这台引擎不吃内存」—— 那是最危险的一条记录。
  const s = sampleTree(12345, { rows: [R(1, 0, 1, 1)], platform: 'linux' })
  assert.equal(s.ok, false)
  assert.equal(s.peakMb, null)
})

test('拿不到进程表 ⇒ ok:false，⛔ 不抛', () => {
  const s = sampleTree(1, { rows: [], platform: 'linux' })
  assert.equal(s.ok, false)
})

test('没给根 PID ⇒ ok:false', () => {
  assert.equal(sampleTree(null, { rows: [R(1, 0, 1, 1)] }).ok, false)
  assert.equal(sampleTree(-1, { rows: [R(1, 0, 1, 1)] }).ok, false)
})

// ---------------------------------------------------------------------------
//  峰值：两家有，一家没有
// ---------------------------------------------------------------------------

test('⭐ Windows / Linux 的峰值是操作系统免费记的', () => {
  assert.equal(peakIsFree('win32'), true)
  assert.equal(peakIsFree('linux'), true)
})

test('⛔ macOS 没有峰值 —— 调用方靠这个决定要不要开采样', () => {
  assert.equal(peakIsFree('darwin'), false)
})

test('⭐ 峰值缺失时退回当前用量，⛔ 不返回 0', () => {
  // macOS 上 peak 恒为 null。这时 peakMb 至少得是当前用量 ——
  // 返回 0 会让账本记下「不吃内存」。
  const rows = [R(1, 0, 500, null)]
  const s = sampleTree(1, { rows, platform: 'darwin' })
  assert.equal(s.peakMb, 500)
})

test('⭐ 峰值永远 >= 当前用量', () => {
  // 这条就是判 Windows 单位的那把尺子：当字节算会算出比当前值还小的数。
  const rows = [R(1, 0, 500, 100)]
  const s = sampleTree(1, { rows, platform: 'linux' })
  assert.ok(s.peakMb >= s.rssMb)
})

// ---------------------------------------------------------------------------
//  余量 / 单位
// ---------------------------------------------------------------------------

test('⛔ 单位一律 MB —— 换算只向上取整，不许抹掉零头', () => {
  // 用 GB 存会把 1.5G 舍成 1 或 2，一个变量差一倍，抹掉的精度找不回来。
  const rows = [R(1, 0, 0, 0)]
  rows[0].rss = 1.5 * 1024 * 1024 * 1024
  rows[0].peak = 1.5 * 1024 * 1024 * 1024
  const s = sampleTree(1, { rows, platform: 'linux' })
  assert.equal(s.peakMb, 1536)
})

test('余量只往上加', () => {
  assert.ok(withHeadroom(1000) > 1000)
  assert.equal(withHeadroom(1000, 1.15), 1150)
})

test('⛔ 余量传个小于 1 的数进来 ⇒ 用默认值，不许把安全阀拧掉', () => {
  assert.equal(withHeadroom(1000, 0.5), Math.ceil(1000 * HEADROOM))
})

// ---------------------------------------------------------------------------
//  真机（这台沙箱）
// ---------------------------------------------------------------------------

test('在这台机器上真的量得到自己', () => {
  const s = sampleTree(process.pid)
  assert.equal(s.ok, true)
  assert.ok(s.rssMb > 0)
})

test('freeMb 是个正数', () => {
  assert.ok(freeMb() > 0)
})

test('processTable 在这台机器上拿得到东西', () => {
  assert.ok(processTable().length > 0)
})

// ---------------------------------------------------------------------------
//  守卫
// ---------------------------------------------------------------------------

test('⛔ 守卫：memprobe.js 不许认识任何一台具体的引擎', () => {
  // 这一层量的是**进程**不是引擎。它一旦认识某台引擎，
  // 「兼容任意 TTS」在内存这一项上就破了。
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, 'memprobe.js'), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  for (const banned of ['gpt', 'sovits', 'indextts', 'IndexTTS', 'infer_server']) {
    assert.ok(!code.includes(banned),
      `memprobe.js 的代码里出现了 ${banned}`)
  }
})
