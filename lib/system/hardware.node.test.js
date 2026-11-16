#!/usr/bin/env node
'use strict'

// 整机硬件的守卫（lib/system/hardware.js）。要防三件事：
// 1. 它又去借引擎的环境：平台与每台引擎各有一份 torch，问 venv 会得到两种答案。
//    判据：活代码里不许出现 python，只许 node:os 与 lib/system/gpu.js。
// 2. 探测出现第二份：lib/engines/gpus.js 与 /api/health 必须同出一处。
//    判据：engines/gpus.js 的活代码里不许再出现显卡探测命令。
// 3. 「显存」变成一个错数字：非 NVIDIA 一律没有 vram_gb。
// 纪律：不许出现任何具体引擎名。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const FILE = path.join(ROOT, 'lib', 'system', 'hardware.js')
const GPULIST = path.join(ROOT, 'lib', 'engines', 'gpus.js')
const HEALTH = path.join(ROOT, 'lib', 'routes', 'system.js')

function stripComments (src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

test('这条守卫自己找对了文件', () => {
  assert.ok(fs.existsSync(FILE), `找不到 ${FILE}`)
  assert.match(fs.readFileSync(FILE, 'utf8'), /module\.exports/)
})

test('⛔ 整机硬件不许起 Python（活代码里），只许问 node:os 与显卡探测', () => {
  const code = stripComments(fs.readFileSync(FILE, 'utf8'))
  assert.doesNotMatch(code, /python/i,
    '⛔ hardware.js 的活代码里出现了 python。整机硬件必须由平台自己读，'
    + '借引擎的 venv 回答整机问题，同一台机器会得到两份不同的答案。')
  assert.match(code, /node:os/, 'CPU 与内存应当来自 node:os')
  assert.match(code, /require\('\.\/gpu'\)/, '显卡应当来自 lib/system/gpu.js，而不是另写一份')
})

test('⛔ 显卡探测只有一份：gpus.js 不许再起子进程', () => {
  const code = stripComments(fs.readFileSync(GPULIST, 'utf8'))
  for (const cmd of ['nvidia-smi', 'Win32_VideoController', 'system_profiler']) {
    assert.ok(!code.includes(cmd),
      `⛔ lib/engines/gpus.js 里出现了 ${cmd}：那是第二份探测。`
      + '\n  探测在 lib/system/gpu.js，gpus.js 只做字段搬运。')
  }
  assert.match(code, /system\/hardware/, 'gpus.js 应当从 lib/system/hardware.js 取结果')
})

test('⭐ 健康接口带上整机硬件，且探测失败不拖垮健康接口', () => {
  const src = fs.readFileSync(HEALTH, 'utf8')
  assert.match(src, /detectHardware/, '/api/health 不再给出整机硬件')
  assert.match(src, /hardware:\s*\(\(\)\s*=>/, '硬件探测应当被包住：取不到就给 null，不能让 /api/health 失败')
})

test('⭐ 实跑：CPU、内存、显卡一次给全，形状稳定', () => {
  const { detectHardware, clearHardwareCache } = require('./hardware')
  clearHardwareCache()
  const hw = detectHardware()

  assert.ok(hw.cpu && typeof hw.cpu === 'object', '缺 cpu')
  assert.strictEqual(typeof hw.cpu.threads, 'number')
  assert.ok(hw.cpu.threads > 0, `线程数应当为正：${hw.cpu.threads}`)
  assert.ok(hw.cpu.arch, '缺架构')

  assert.ok(hw.memory && hw.memory.total_gb > 0, `内存总量应当为正：${JSON.stringify(hw.memory)}`)
  assert.ok(hw.memory.free_gb >= 0 && hw.memory.free_gb <= hw.memory.total_gb,
    '可用内存不该大于总量')

  assert.ok(Array.isArray(hw.gpus), 'gpus 必须是数组，没有显卡时是空数组')
  assert.ok(typeof hw.probe === 'string' && hw.probe.length > 0,
    '⛔ probe 说不出「凭什么这么判」—— 出错时人要知道它问了哪个接口')
  assert.strictEqual(typeof hw.ready, 'boolean')

  for (const g of hw.gpus) {
    assert.ok(typeof g.vendor === 'string' && g.vendor, '每块卡都要有厂商')
    assert.ok(g.name === null || typeof g.name === 'string')
    if (g.vendor !== 'nvidia') {
      assert.strictEqual(g.vram_gb, null,
        `⛔ 非 NVIDIA（${g.vendor}）却报了 vram_gb=${g.vram_gb} —— 那个数字在这个厂商上不可信`)
    }
    if (g.index !== null) {
      assert.strictEqual(typeof g.index, 'number', 'index 要么是数字，要么是 null')
    }
  }
})

test('⭐ 同一份结果：gpus.js 与 hardware.js 逐字段一致', () => {
  const { detectHardware } = require('./hardware')
  const { detectGpus } = require('../engines/gpus')
  const a = detectHardware().gpus.map((g) => `${g.vendor}|${g.index}|${g.name}`)
  const b = detectGpus().map((g) => `${g.vendor}|${g.index}|${g.name}`)
  assert.deepStrictEqual(b, a, '⛔ 两个入口给出的显卡列表不一致，说明探测又分叉了')
})

test('⛔ 不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice', 'vox' + 'cpm', 'kokoro']
  const code = stripComments(fs.readFileSync(FILE, 'utf8')).toLowerCase()
  for (const bad of FORBIDDEN) {
    assert.ok(!code.includes(bad), `出现了「${bad}」`)
  }
})
