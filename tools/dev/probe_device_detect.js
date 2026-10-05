#!/usr/bin/env node
'use strict'

// ============================================================================
//  ⭐ 探针：这台机器上的各类计算设备，**从 Node 里能不能检测到**
//
//  为什么要写它（2026-10-05）：
//  「换一个不依赖 venv 的硬件探测」这句话听起来像小事，于是我先假设了
//  「能检测到」。而 `docs/PLATFORM_CAPABILITY_REPORT.md` 已经证明，
//  **「检测到设备」与「知道它能干什么」是两件事** ——
//  同一块 Arc 140T：推理 f16 能跑但无优势、训练 f16 会 NaN、
//  训练 fp32 快 4.6× 但要先编译 821 秒、NPU 干脆没有反向通路。
//
//  ⇒ 所以先量「检测」这一层能不能做到，再谈用它做什么决定。
//  本文件**只做检测**，一律不下结论说「所以该怎么做」。
//
// 用法：node tools/dev/probe_device_detect.js
// ⛔ 纪律：不许出现任何具体引擎名；它探测的是机器，不是引擎。
// ============================================================================

const { execFileSync, spawnSync } = require('node:child_process')
const os = require('node:os')

function section (t) { console.log('\n=== ' + t) }
function tryRun (cmd, args, timeoutMs = 30000) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out: String(out).trim() }
  } catch (e) {
    return { ok: false, err: String((e && (e.stderr || e.message)) || e).trim().split('\n')[0] }
  }
}

// ---------------------------------------------------------------------------
section('① CPU —— Node 内建')
console.log('  model :', os.cpus()[0] && os.cpus()[0].model)
console.log('  cores :', os.cpus().length)
console.log('  ⭐ 关键结论：CPU「有没有」是免费的，')
console.log('    但**它能不能跑 fp16/bf16 的反向**不在这里 —— 那是指令集，见 ②')

// ---------------------------------------------------------------------------
section('② CPU 指令集 —— 那才是「能不能训练」的决定项')
// 报告 §四.4 的判据是 DNNL 报不报
//   "does not support bf16/f16 backward on the platform with avx2_vnni_2"
// ⇒ 也就是说**要问的是「有没有 avx512_bf16 / avx512_fp16」**，不是型号。
const isa = tryRun('powershell', ['-NoProfile', '-Command', `
  $f = Get-ItemProperty -Path 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0' -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Identifier = $f.Identifier
    FeatureSet = $f.FeatureSet
    Description = $f.Description
  } | ConvertTo-Json -Compress
`])
console.log('  WMI/CIM:', isa.ok ? isa.out.slice(0, 200) : ('⛔ ' + isa.err))
console.log('  ⚠️ 上面的 FeatureSet 是**位掩码**，要解成「有哪些指令集」需要另一套映射。')
console.log('    ⛔ 本探针**没有**解它 —— 因为解错了会得到一个假的「支持」。')

// ---------------------------------------------------------------------------
section('③ GPU —— WMI Win32_VideoController')
const gpu = tryRun('powershell', ['-NoProfile', '-Command',
  'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress'], 45000)
if (gpu.ok) {
  let parsed
  try { parsed = JSON.parse(gpu.out) } catch (e) { parsed = gpu.out }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  for (const g of list) {
    console.log(`  · ${g.Name}`)
    console.log(`      AdapterRAM = ${g.AdapterRAM}` +
      (g.AdapterRAM ? ` (${(g.AdapterRAM / 2 ** 30).toFixed(1)} GB)` : ''))
    console.log(`      Driver     = ${g.DriverVersion}`)
  }
  console.log('  ⛔ AdapterRAM 对核显不可信（报告：这台机器实际共享 58.5GB，' +
    '而这里报的是 4GB 上限的产物）⇒ 绝不能拿它当「显存」。')
} else {
  console.log('  ⛔', gpu.err)
}

// ---------------------------------------------------------------------------
section('④ NVIDIA —— nvidia-smi（本机无 N 卡，验的是「找不到时怎么办」）')
const nv = tryRun('nvidia-smi', ['--query-gpu=name,memory.total,driver_version',
  '--format=csv,noheader,nounits'], 20000)
if (nv.ok) {
  console.log('  ✅', nv.out)
} else {
  console.log('  ⛔ nvidia-smi 不可用 ——', nv.err || '（命令不存在）')
  console.log('  ⭐ 这是**正常且必须处理**的分支：无 N 卡的机器上它就是找不到。')
  console.log('    ⛔ 判据必须能区分「没装驱动」与「命令不存在」，否则报错会误导人。')
}

// ---------------------------------------------------------------------------
section('⑤ Intel GPU 的官方工具链在不在（决定 XPU 能否被程序化使用）')
for (const c of [['xpu-smi', null], ['sycl-ls', null]]) {
  const r = tryRun(c[0], ['--version'], 15000)
  console.log(`  ${c[0].padEnd(10)}`, r.ok ? ('✅ ' + r.out.slice(0, 80)) : '⛔ 不在 PATH')
}
console.log('  ⚠️ 而 torch 侧那套（torch.xpu.is_available()）需要 Python + torch ——')
console.log('    ⛔ 那正是 2026-10-05 刚刚从平台 venv 里拆掉的东西。')

// ---------------------------------------------------------------------------
section('⑥ NPU —— ⭐ 完全未验证的一类')
console.log('  报告给的标识：PCI VEN_8086&DEV_7D1D · NPU_PLATFORM=3720 · 驱动 oem10.inf')
const npu = tryRun('powershell', ['-NoProfile', '-Command',
  "Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VEN_8086&DEV_7D1D' } | Select-Object Status,FriendlyName,InstanceId | ConvertTo-Json -Compress"], 60000)
console.log('  PnP 枚举:', npu.ok ? (npu.out || '（无匹配）') : ('⛔ ' + npu.err))
console.log('  ⚠️ 注意「设备在」与「Node 能用它」之间还隔着 OpenVINO Level Zero /')
console.log('    oneDNN 这类原生层 —— ⛔ 本探针**没有**验证 Node 能否调用它们。')

// ---------------------------------------------------------------------------
section('⑦ 汇总：哪些是「检测得到」，哪些是「检测不到」')
console.log(`  ${os.platform()} / Node ${process.version}`)
console.log('  ✅ 无依赖可检测：CPU 型号与核数 · GPU 厂商与名字（名字匹配）')
console.log('  🟡 检测得到但不可信的量：GPU 的 AdapterRAM（核显上是错的）')
console.log('  🟡 条件性：NVIDIA 显存（要 nvidia-smi；无卡时命令不存在）')
console.log('  ⛔ 本探针未验证：CPU 指令集 → fp16/bf16 反向是否可行 · NPU 的程序化访问')
console.log('  ⛔ 本探针刻意不做：任何「所以该选哪个后端」的结论')
