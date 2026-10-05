'use strict'
// ============================================================================
//  hardware —— ⭐ 逻辑照抄 StabilityMatrix 的 hardware-support.md
//
//  ⚠ 这份测试守的是三条纪律（都是 StabilityMatrix 自己的说法，不是我的）：
//    1. 推荐 ≠ 决定（所有选项都要摆出来）
//    2. 检测是 guidance 不是 guarantee（原文原话）
//    3. 分不清就退 CPU
//
//  ⚠ 它必须能在**没有 GPU 的机器**上也跑通（CI 环境就是）——
//    所以推荐逻辑与真机检测是分开的两个函数，可独立测。
// ============================================================================

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const {
  BACKEND_PREFERENCE, recommendBackend, inspectHardware,
  judgeTorchSpec, splitTorchPackages, TORCH_FAMILY, parseUvLock,
} = require('../core/hardware.js')

// ---------------------------------------------------------------------------
// ⭐ 偏好顺序 —— StabilityMatrix 原文那个顺序
// ---------------------------------------------------------------------------
test('⭐ 后端偏好顺序照 StabilityMatrix：CUDA → ZLUDA → IPEX → ROCm → DirectML → CPU', () => {
  assert.deepStrictEqual(BACKEND_PREFERENCE.map((b) => b.key),
    ['cuda', 'zluda', 'ipex', 'rocm', 'directml', 'cpu'])
  // ⭐ CPU 必须垫底 —— 原文：'finally CPU as a last resort'
  assert.strictEqual(BACKEND_PREFERENCE[BACKEND_PREFERENCE.length - 1].key, 'cpu')
})

test('⭐ 每个后端都要说清它面向谁 + 装的是什么', () => {
  for (const b of BACKEND_PREFERENCE) {
    assert.ok(b.for && b.for.length > 4, `${b.key} 缺 for（面向谁）`)
    assert.ok(b.pkg && b.pkg.length > 4, `${b.key} 缺 pkg（装的是什么）`)
    assert.ok(b.label, `${b.key} 缺 label`)
  }
})

// ---------------------------------------------------------------------------
// ⭐ 推荐：按厂商，不是「猜」
// ---------------------------------------------------------------------------
test('NVIDIA ⇒ cuda', () => {
  const r = recommendBackend([{ vendor: 'nvidia', name: 'RTX 4090' }])
  assert.strictEqual(r.recommended, 'cuda')
})

test('⭐ Intel（名字含 Arc）⇒ ipex —— 这台机器就是', () => {
  const r = recommendBackend([{ vendor: 'intel', name: 'Intel(R) Arc(TM) 140T GPU' }])
  assert.strictEqual(r.recommended, 'ipex')
  // ⛔ reason 只说结论；置信度由 confidence 字段承担，⛔ 不塞进 reason。
  assert.strictEqual(r.reason, '推荐使用 XPU')
  assert.strictEqual(r.confidence, 'guidance')
})

test('AMD + Windows ⇒ directml（三条路里最兼容的那条）', () => {
  const r = recommendBackend([{ vendor: 'amd', name: 'Radeon RX 7900' }])
  assert.strictEqual(r.recommended, 'directml')
  assert.strictEqual(r.reason, '推荐使用 DirectML')
})

test('AMD + Linux ⇒ rocm', () => {
  const saved = process.platform
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    const r = recommendBackend([{ vendor: 'amd', name: 'Radeon' }])
    assert.strictEqual(r.recommended, 'rocm')
  } finally {
    Object.defineProperty(process, 'platform', { value: saved, configurable: true })
  }
})

// ---------------------------------------------------------------------------
// ⭐ 纪律 3：分不清就退 CPU（StabilityMatrix + 我们 install_torch.ps:109 同一个选择）
// ---------------------------------------------------------------------------
test('⭐ ⛔ 认不出的厂商 ⇒ cpu，且理由要说清「为什么退」', () => {
  for (const gpus of [[], [{ vendor: 'unknown', name: '??' }],
    [{ vendor: 'qualcomm', name: 'Adreno' }]]) {
    const r = recommendBackend(gpus)
    assert.strictEqual(r.recommended, 'cpu', JSON.stringify(gpus))
    assert.ok(r.reason.length > 6, r.reason)
  }
})

test('⭐ ⛔ 分不清时 confidence 不是 guidance（是明确的回退）', () => {
  // ⭐ 值从 'unknown' 改成 'fallback'：两者都表示「不是探测成功的推荐」，
  //   而 'fallback' 说清了它是**回退**⇒ 界面据此显示警告。
  //   ⛔ 守卫的实质是「不许把回退说成探测成功」，不是钉某个字符串。
  const fallback = recommendBackend([])
  assert.notStrictEqual(fallback.confidence, 'guidance',
    '⛔ 回退不得标成 guidance（那会让界面显示成探测成功的推荐）')
  assert.strictEqual(fallback.recommended, 'cpu')
  // ⭐ 必须带 fellBack 标记：界面据此说明「已回退」而不是「推荐使用 CPU」
  assert.strictEqual(fallback.fellBack, true,
    '⛔ 回退必须带 fellBack=true，否则界面读起来像探测到了 CPU')
  assert.ok(/回退/.test(fallback.reason),
    `⛔ 理由要说清是回退：${fallback.reason}`)

  assert.strictEqual(recommendBackend([{ vendor: 'nvidia' }]).confidence, 'guidance')
})

// ⛔ 独显优先：核显与独显并存时选独显（常识，不是可选项）
test('⭐ ⛔ 核显 + 独显并存 ⇒ 独显优先', () => {
  const both = [
    { vendor: 'intel', name: 'Intel(R) Arc(TM) 140T GPU' },
    { vendor: 'nvidia', name: 'RTX 4090' },
  ]
  assert.strictEqual(recommendBackend(both).recommended, 'cuda',
    '⛔ 独显优先 —— 核显慢一到两个数量级，且它一直在跑桌面合成')
  // ⛔ 顺序不能被探测器返回的顺序影响
  assert.strictEqual(recommendBackend(both.slice().reverse()).recommended, 'cuda',
    '⛔ 推荐不得依赖探测结果的顺序')
  // 只有核显时才用 XPU
  assert.strictEqual(recommendBackend([both[0]]).recommended, 'ipex')
})

// ---------------------------------------------------------------------------
// ⭐ inspectHardware 的形状 —— 「推荐」只是 highlight，选项全在
// ---------------------------------------------------------------------------
test('⭐ ⭐ inspectHardware 必须把**所有**选项都返回（推荐 ≠ 决定）', () => {
  const h = inspectHardware()
  assert.ok(Array.isArray(h.options), '⛔ 没有 options —— 用户就没得选了')
  assert.strictEqual(h.options.length, BACKEND_PREFERENCE.length)
  assert.ok(h.options.some((o) => o.key === h.recommended))
  // ⚠ 纪律 2：必须说清「这只是推荐，你可以改」。
  //   ⛔ 不许断言某几个字（措辞会改），改钉**实质**：
  //   caveat 要点明「未在本机验证」，即推荐 ≠ 保证。
  assert.ok(h.caveat && /未在本机|不是实测|未经/.test(h.caveat), h.caveat)
  // ⛔ 不许用破折号解释腔（Owner 2026-10-05 的口吻要求）
  assert.ok(!/——/.test(h.caveat), `⛔ 界面文案不许用破折号：${h.caveat}`)
})

test('⭐ inspectHardware 不抛异常（CI 上没 GPU 也要能跑）', () => {
  const h = inspectHardware()
  assert.ok(Array.isArray(h.gpus))
  assert.ok(typeof h.recommended === 'string')
})

// ---------------------------------------------------------------------------
// ⭐ judgeTorchSpec —— 绿/黄/白的判据
// ---------------------------------------------------------------------------
test('⭐ 🟢 lock 里的后端 == 本机推荐 ⇒ match', () => {
  assert.strictEqual(judgeTorchSpec('torch==2.14.1+xpu', 'ipex').verdict, 'match')
  assert.strictEqual(judgeTorchSpec('torch==2.2.0+cu121', 'cuda').verdict, 'match')
  assert.strictEqual(judgeTorchSpec('torch==2.5.1+rocm6.2', 'rocm').verdict, 'match')
})

test('⭐ 🟡 lock 里是 CUDA 但本机是 Intel ⇒ mismatch + 说清为什么', () => {
  const j = judgeTorchSpec('torch==2.2.0+cu121', 'ipex')
  assert.strictEqual(j.verdict, 'mismatch')
  assert.strictEqual(j.kind, 'cuda')
  // ⛔ 理由必须同时说「lock 是什么」和「本机是什么」—— 少一样就没法判断
  assert.ok(/CUDA/.test(j.why), j.why)
  assert.ok(/ipex/.test(j.why), j.why)
})

test('⭐ 纯 CPU 版（无后缀）⇒ 到处装得上', () => {
  const j = judgeTorchSpec('torch==2.2.0', 'cuda')
  assert.strictEqual(j.kind, 'cpu')
  assert.strictEqual(j.verdict, 'match', 'CPU 版在任何机器上都能装')
})

test('⭐ ⚪ 不认识的后缀 ⇒ unknown，⛔ 不硬套成某个后端', () => {
  const j = judgeTorchSpec('torch==1.0.0+weird', 'cuda')
  assert.strictEqual(j.verdict, 'unknown')
  assert.strictEqual(j.kind, 'unknown')
  // ⚠ 2026-10-05：措辞改成「请自行确认」了 ⇒ 这条断言改钉**实质**：
  //   ⭐ 必须说清「装之前要用户确认」，⛔ 不许断言某几个字。
  assert.ok(/确认/.test(j.why), j.why)
  assert.ok(!/——/.test(j.why), `⛔ 界面文案不许用破折号解释：${j.why}`)
})

test('⭐ ⚪ 没给本机信息 ⇒ verdict 是 unknown（⛔ 不是 match）', () => {
  const j = judgeTorchSpec('torch==2.2.0+cu121')
  assert.strictEqual(j.verdict, 'unknown')
  assert.ok(/未检测/.test(j.why), j.why)
})

// ---------------------------------------------------------------------------
// ⭐ 拆包：只有 torch 系需要单独处理（Owner 说的）
// ---------------------------------------------------------------------------
test('⭐ torch 系被单独摘出来，其余归普通依赖', () => {
  const { torchish, rest } = splitTorchPackages([
    'torch==2.2.0', 'torchaudio==2.2.0', 'torchvision', 'xformers',
    'onnxruntime-gpu', 'nvidia-cudnn-cu12',
    'transformers>=4.43', 'numpy<2', 'lightning', 'gradio',
  ])
  assert.strictEqual(torchish.length, 6)
  assert.strictEqual(rest.length, 4)
  assert.ok(rest.every((d) => !TORCH_FAMILY.has(
    d.split(/[<>=!~\[]/)[0].trim().toLowerCase())))
})

test('⭐ 判据是包名，⛔ 不看版本、不猜', () => {
  // 各种版本写法都要能认出是 torch 系
  for (const spec of ['torch', 'torch==2.2.0', 'torch>=2.5', 'torch~=2.4', 'TORCH==2.2']) {
    const { torchish } = splitTorchPackages([spec])
    assert.strictEqual(torchish.length, 1, spec)
  }
})

// ---------------------------------------------------------------------------
// 纪律
// ---------------------------------------------------------------------------
test('⛔ hardware.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice', 'vox' + 'cpm']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'hardware.js'), 'utf-8')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

test('⭐ 文件头必须写清「照抄 StabilityMatrix 的哪一段」', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'hardware.js'), 'utf-8')
  const head = src.split('\n').slice(0, 30).join('\n')
  assert.ok(head.includes('StabilityMatrix'), '⛔ 没写来源')
  assert.ok(head.includes('guidance') || head.includes('建议'), '⛔ 没写「推荐不是保证」')
})

// ---------------------------------------------------------------------------
// ⭐⭐ parseUvLock —— 「lock 锁的是什么后端」不能只看 torch 那一行
//
// （已改为中性表述）
//   torch==2.10.0            ← 没有 +cu 后缀
//   nvidia-cudnn-cu12==…     ← 但同一份 lock 锁着 CUDA 全套
//   triton==3.6.0
//   ⇒ 只看 torch 那行会判成「纯 CPU 版，到处装得上」⇒ ⛔ 错。
//   PyPI 上 torch==2.10.0 默认解析出来就是 CUDA 版。
// ---------------------------------------------------------------------------
const REAL_LOCK = `
[[package]]
name = "torch"
version = "2.10.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "torchaudio"
version = "2.10.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "nvidia-cudnn-cu12"
version = "9.10.2.21"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "triton"
version = "3.6.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "transformers"
version = "4.44.0"
source = { registry = "https://pypi.org/simple" }
`

test('⭐⭐ parseUvLock 读出 torch 系，并**剔掉非 torch 系**', () => {
  const rows = parseUvLock(REAL_LOCK)
  const names = rows.map((r) => r.name).sort()
  assert.ok(names.includes('torch') && names.includes('triton'))
  assert.ok(!names.includes('transformers'), 'transformers 不是 torch 系，不该出现在这儿')
})

test('⭐⭐ torch 没后缀但 lock 里有 CUDA 依赖 ⇒ 判 cuda，⛔ 不是 cpu', () => {
  const rows = parseUvLock(REAL_LOCK)
  const torch = rows.find((r) => r.name === 'torch')
  const ctx = { lockedPackages: rows.map((r) => r.name) }

  const onIntel = judgeTorchSpec(torch.spec, 'ipex', ctx)
  assert.strictEqual(onIntel.kind, 'cuda', '⛔ 判成 cpu 就错了')
  assert.strictEqual(onIntel.verdict, 'mismatch', 'Intel 机器上应该是 mismatch')
  // ⛔ why 是界面文案：只说结论「CUDA 版」，⛔ 不讲「因为锁了几个 CUDA 依赖」。
  //   判据由上面两条 kind/verdict 断言守住。
  assert.strictEqual(onIntel.why, 'CUDA 版，需要 NVIDIA 驱动，本机推荐的是 ipex')

  const onNvidia = judgeTorchSpec(torch.spec, 'cuda', ctx)
  assert.strictEqual(onNvidia.verdict, 'match', 'NVIDIA 机器上应该一致')
})

test('⭐ 真的纯 CPU（没有 NVIDIA/XPU 旁证）⇒ 才判 cpu', () => {
  const j = judgeTorchSpec('torch==2.2.0', 'ipex', { lockedPackages: ['torch', 'numpy'] })
  assert.strictEqual(j.kind, 'cpu')
  // ⛔ 同上：结论上界面，⛔ 不把「没有 NVIDIA/XPU 旁证」这个判据讲给用户。
  assert.strictEqual(j.why, 'CPU 版，任何机器均可安装，速度较慢。')
})

test('⭐ lock 里有 Intel XPU 依赖 ⇒ 判 ipex', () => {
  const j = judgeTorchSpec('torch==2.10.0', 'ipex',
    { lockedPackages: ['torch', 'intel-extension-for-pytorch'] })
  assert.strictEqual(j.kind, 'ipex')
})

test('⭐ parseUvLock 对垃圾输入不炸', () => {
  for (const bad of ['', null, undefined, 'no lock here', '[[package]]\nname = "x"']) {
    assert.ok(Array.isArray(parseUvLock(bad)), String(bad))
  }
})
