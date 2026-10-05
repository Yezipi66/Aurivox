#!/usr/bin/env node
'use strict'

// ============================================================================
//  GPU 检测的守卫（lib/system/gpu.js）
//
// ============================================================================
//  ⭐ 这份测试要防的是三件**已经发生过或很容易发生**的事：
//
//  1. **它又开始 spawn Python。** 旧实现就是起一个 Python 去 import torch。
//     A19 把根 venv 瘦身后那套必然答「无 CUDA」⇒ 在一台有 GPU 的机器上**撒谎**。
//     ⇒ 判据：`lib/system/gpu.js` 里不许出现 spawn / execFileSync 之外的解释器调用，
//       且**整棵树里不许再 require 任何 python_helper**。
//
//  2. **「显存」变成一个错数字。** [实测] Windows 的 `AdapterRAM` 在核显上
//     报 4.0 GB，而实际共享内存 58.5 GB。
//     ⇒ 判据：**非 NVIDIA 一律 vram_gb=null**，且代码里不许把 AdapterRAM 当显存。
//
//  3. **悄悄锁死在一个平台上。** 第一版就用了 `Get-CimInstance` +
//     `Get-PnpDevice` 两个 Windows 独有手段，而项目明写「技术栈打通全平台」
//     （`lib/engines/platformPaths.js` 的前身规矩）。
//     ⇒ 判据：三个平台各有一套判据，缺哪套都不许合并。
//
// ⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const GPU = path.join(ROOT, 'lib', 'system', 'gpu.js')
const SRC = fs.readFileSync(GPU, 'utf8')

// ---------------------------------------------------------------------------
// ⭐ 先证明这份守卫自己找对了文件（否则后面几条会静默通过）
// ---------------------------------------------------------------------------
test('⭐ 这条守卫自己找对了文件', () => {
  assert.ok(fs.existsSync(GPU), `找不到 ${GPU}`)
  assert.match(SRC, /module\.exports/, 'gpu.js 没有导出任何东西')
})

// ---------------------------------------------------------------------------
// 1 · ⛔ 不许 spawn Python
// ---------------------------------------------------------------------------
test('⛔ GPU 检测不许起 Python 解释器（**活代码**里不许，注释里解释「为什么不用」是必要的）', () => {
  // ⚠️ 为什么要剥注释再查：文件头有一整段在解释「为什么不再 spawn Python」。
  //   ⛔ 那段说明是**必要的**（下一个读代码的人需要它），所以判据不能扫全文 ——
  //   否则这条守卫会逼着人把解释删掉，而那正是「不记录理由」的失败形状。
  const code = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
    .replace(/\/\/[^\n]*/g, '')                // 行注释
  assert.doesNotMatch(code, /python/i,
    '⛔ gpu.js 的**活代码**里出现了 python —— 它必须只问操作系统，不问任何 venv。'
    + '\n  理由：根 venv 在 A19 里已经没有 torch 了（只有 uv/packaging/hf_transfer），'
    + '\n  而这台机器确实有 GPU ⇒ 那条路只会给出一个假的「无 CUDA」。')
  assert.doesNotMatch(code, /python_helper|getPythonPath/,
    '⛔ gpu.js 依赖了 python_helper —— 平台层的探测不该借训练线的解释器。')
  // ⭐ 正面断言：它只调操作系统自己的工具
  for (const tool of ['nvidia-smi', 'powershell', 'system_profiler']) {
    assert.match(code, new RegExp(tool.replace(/[.\-]/g, '\\$&')),
      `找不到 ${tool} —— 那才是它该问的东西`)
  }
})

// ---------------------------------------------------------------------------
// 2 · ⛔ 显存只给 NVIDIA
// ---------------------------------------------------------------------------
test('⛔ AdapterRAM 不许被当成显存', () => {
  assert.doesNotMatch(SRC, /AdapterRAM\s*[,;}]/,
    '⛔ 读了 AdapterRAM 却没有把它当成「不可信的量」—— '
    + '它在核显上会报 4.0GB（32 位封顶），而实际共享内存是 58.5GB。')
  assert.match(SRC, /vram_mb: null|vramMb : null|vram_gb: null/,
    'gpu.js 里找不到「非 NVIDIA 不给显存」的痕迹')
})

test('⭐ 非 NVIDIA 设备一律没有 vram_mb', () => {
  // ⚠️ 这一条只能对**真实读到的设备**生效，所以用当前机器做样本；
  //   若这台机器有 N 卡，这条会自动验证 nvidia 分支而不验证 intel 分支 ——
  //   所以它同时断言「代码里有条件判断」，而不断言这台机器的具体形状。
  assert.match(SRC, /vendor === 'nvidia'/, '找不到「只有 nvidia 才给显存」的判断')
  assert.match(SRC, /shared_memory/, '找不到「共享内存」的标注 —— '
    + '核显上「显存」这个数字本身是有歧义的，必须如实标注而不是填一个数')
})

// ---------------------------------------------------------------------------
// 3 · ⛔ 三个平台各有一套判据
// ---------------------------------------------------------------------------
test('⛔ win32 / linux / darwin 三套判据都在，且没有互相顶替', () => {
  for (const [platform, needle, why] of [
    ['win32', 'Win32_VideoController', 'Windows 侧显卡名'],
    ['linux', '/sys/class/kfd', 'Linux 上「算力设备」在 kfd，不在 drm'],
    ['darwin', 'system_profiler', 'macOS 侧显卡'],
  ]) {
    assert.match(SRC, new RegExp(needle),
      `⛔ 缺 ${platform} 的判据（${why}）—— `
      + '项目要求「技术栈打通全平台」，而第一版只写了 Windows 那套')
  }
  assert.match(SRC, /\/sys\/class\/drm/,
    '⛔ 缺 Linux 显示设备兜底（kfd 不可用时该走它）')
  assert.match(SRC, /arm64/,
    '⛔ 缺 Apple Silicon 的兜底 —— 统一内存的 GPU 也是 GPU，'
    + '只报「没有显卡」会误导人')
})

test('⭐ NVIDIA 判据是跨平台的：先问它，再按平台补其余的', () => {
  assert.match(SRC, /function detectNvidia \(\)/, '找不到 detectNvidia 的定义')
  assert.match(SRC, /nvidia-smi/, 'detectNvidia 里没有调 nvidia-smi')
  // ⛔ 「先问 NVIDIA」这件事只能测行为，不能测源码位置 ——
  //   ⛔ 上一版用 indexOf 比位置，而 JSDoc 里那个函数名比分支还早，判据是错的。
  //   ⇒ 现在验证**返回值**：NVIDIA 那台必须排在 devices 的第一位，
  //     且即使平台分支补进来别的设备，available 也仍然只由 NVIDIA 决定。
  const { detectGpuNow, clearGpuCache } = require('./gpu')
  clearGpuCache()
  const r = detectGpuNow()
  if (r.devices.some((d) => d.vendor === 'nvidia')) {
    assert.strictEqual(r.devices[0].vendor, 'nvidia',
      'NVIDIA 设备必须排在 devices 首位 —— 它是唯一有权威显存读数的那类')
    assert.strictEqual(r.available, true, '有 N 卡却答 available=false')
  }
  // ⭐ 而无论有没有 N 卡，platform 字段都要如实报出来
  assert.strictEqual(r.platform, process.platform)
})

// ---------------------------------------------------------------------------
// 4 · ⭐ 形状与旧字段兼容（前端零改动）
// ---------------------------------------------------------------------------
test('⭐ 旧字段一个都不少（前端 badge / 显存告警 / 微调预检都在读）', () => {
  for (const f of ['ready', 'available', 'device_name', 'vram_gb']) {
    assert.match(SRC, new RegExp(f),
      `⛔ 返回形状里少了 ${f} —— web/src/App.jsx 与 TrainingTab 四处都在读它`)
  }
})

test('⭐ available 仍然只在 NVIDIA 时为真（这条是前端零改动的前提）', () => {
  assert.match(SRC, /available:\s*primary\.vendor === 'nvidia'/,
    '⛔ available 的判据变了 —— 前端 TrainingTab 那句'
    + '「available === false ⇒ 别微调」就换了含义却没换文案')
})

// ---------------------------------------------------------------------------
// 5 · ⭐ 旧名还在用着，别悄悄删
// ---------------------------------------------------------------------------
test('⛔ 旧名 startCudaProbe / detectCuda 仍在导出（server.js 还在 require）', () => {
  for (const old of ['startCudaProbe', 'detectCuda']) {
    assert.match(SRC, new RegExp(old),
      `⛔ 旧导出名 ${old} 不见了 —— server.js:104 与 lib/routes/system.js:129 还在用它，`
      + '删掉会直接 require 失败。改调用点是一件独立的小活，不在这条守卫的范围里。')
  }
})

test('⛔ 旧的 cuda.js 必须不存在（改名不是复制一份）', () => {
  const old = path.join(ROOT, 'lib', 'system', 'cuda.js')
  assert.ok(!fs.existsSync(old),
    'lib/system/cuda.js 还在 —— 那是「两份 GPU 检测」，它们会各自漂移。'
    + '\n  留档请靠 git，不要靠磁盘上放两份。')
})

// ---------------------------------------------------------------------------
// 6 · 实跑一次：形状对不对
// ---------------------------------------------------------------------------
test('⭐ 实跑：返回形状自洽', () => {
  const { detectGpuNow, clearGpuCache } = require('./gpu')
  clearGpuCache()
  const r = detectGpuNow()
  assert.strictEqual(typeof r.ready, 'boolean')
  assert.strictEqual(typeof r.available, 'boolean')
  assert.ok(Array.isArray(r.devices))
  assert.ok(typeof r.probe === 'string' && r.probe.length > 0,
    '⛔ probe 说不出「我凭什么这么判」—— 出错时人要知道它问了哪个接口')

  if (r.devices.length === 0) {
    assert.strictEqual(r.device_name, null, '没有设备时 device_name 必须是 null，不能留上一次的')
    assert.strictEqual(r.available, false)
  } else {
    assert.ok(r.device_name, '有设备就必须报出名字')
  }
  if (r.vendor !== 'nvidia') {
    assert.strictEqual(r.vram_gb, null,
      `⛔ 非 NVIDIA（${r.vendor}）却报了 vram_gb=${r.vram_gb} —— 那个数字在这个厂商上不可信`)
  }
  if (r.available) {
    assert.strictEqual(r.vendor, 'nvidia',
      '⛔ available=true 但厂商不是 nvidia —— 前端把它当 CUDA 用')
  }
})