'use strict'

// ============================================================================
//  GPU / 算力设备检测
//
// ============================================================================
//  ⭐⭐ 本文件 2026-10-05 从 cuda.js 改名而来。改名的理由不是好看，是**防误读**：
//  旧文件叫 `cuda.js`，而它真正负责的范围是「这台机器有什么显卡」。
//  而「CUDA」在项目里另有一个含义 —— `server.js` 里那个写死的
//  `device: "cuda"`（请求体里的引擎 device 字段）。
//  两个「CUDA」指的是两件事，文件名只说了其中一件 ⇒ 今天的对话里
//  「CUDA 探测」「默认用 CUDA」「这台机器有没有 CUDA」被混成一团，
//  源头就在这里。
//
// ============================================================================
//  ⭐⭐ 它**不再 spawn Python**（2026-10-05）
//
//  旧实现是「起一个 Python 去 `import torch`，问 `torch.cuda.is_available()`」。
//  现在不做这件事，原因是实测出来的两条硬事实：
//
//  1. ⚠️ **那个解释器已经不可靠**。平台根 venv 在 A19 里被瘦身成 3 个工具链包
//     （C12 不变式 1），里面**没有 torch** ⇒ 旧探针必然答「无 CUDA」。
//     而这台机器确实有 GPU（`docs/PLATFORM_CAPABILITY_REPORT.md` 实测 GPU 比 CPU 快 9×）
//     ⇒ **旧探针在撒谎**，而且撒得毫无声响。
//
//  2. ⚠️ 能力问题**本来就不该由平台层回答**。「这台引擎能不能 fp16 反向」
//     取决于引擎自己的 torch（它在 `engines/<id>/.venv` 里），C12 不变式 2
//     明确要求每台引擎的依赖互相独立。
//     ⇒ **本文件只答「这台机器有什么」，不答「它能干什么」。**
//
// ============================================================================
//  ⭐ 跨平台：形状由平台决定，不由「哪个碰巧能跑」决定
//
//  这条规矩抄自 `lib/engines/platformPaths.js` 的头部注释：
//    「⛔ 不写「三种都试，哪个存在用哪个」—— 那是拿运行时去探测，
//      症状会变成「在 A 机器上碰巧挑中了另一个引擎的解释器」。
//      ⭐ 形状必须由**声明它的那台机器**决定，不由文件系统现状决定。」
//
//  下面每个平台各有一套判据，⛔ 不做跨平台的通用猜测。
//
// ----------------------------------------------------------------------------
//  ⚠️⚠️ 关于「显存」这个数字 —— 它是一个**不可信的量**
//
//  [实测 2026-10-05] Windows 的 `Win32_VideoController.AdapterRAM` 在这台机器上
//  报 **4.0 GB**，而 `PLATFORM_CAPABILITY_REPORT.md` 实测共享内存是 **58.5 GB**
//  ⇒ 那是 32 位字段封顶的产物，**绝不能当显存显示或参与判断**。
//
//  ⇒ 因此本文件的规则：**只有 NVIDIA 才给 `vram_gb`**（`nvidia-smi` 是权威），
//   其他厂商一律 `vram_gb: null` + `shared_memory: true/false` 如实标注。
//   宁可少一个数字，也不要给一个错的数字。
//
// ----------------------------------------------------------------------------
//  ⛔ 纪律：不许出现任何具体引擎名。回答的是机器，不是引擎。
// ============================================================================

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function run (cmd, args, timeoutMs) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs || 20000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return String(out || '').trim()
  } catch (e) {
    return null
  }
}

function firstExisting (paths) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8') } catch (e) { /* 继续下一个 */ }
  }
  return null
}

/** 从设备名字里认厂商 —— ⚠️ 这是**名字匹配**，不是问驱动。
 *  （这条限制是抄 `tools/engine-wizard/core/hardware.js` 的原话：
 *   「Intel 那条更明确：detection is **name-based** and matches GPUs whose
 *    name contains "Arc"」。）
 */
function vendorFromName (name) {
  const n = String(name || '').toLowerCase()
  if (!n) return 'unknown'
  if (n.includes('nvidia')) return 'nvidia'
  if (n.includes('amd') || n.includes('radeon')) return 'amd'
  if (n.includes('intel') || n.includes('arc') || n.includes('iris')
      || n.includes('apple')) return 'intel'
  if (n.includes('microsoft')) return 'd3d12'      // WARP
  return 'unknown'
}

// ---------------------------------------------------------------------------
// NVIDIA —— 跨平台唯一有权威输出的那一类
// ---------------------------------------------------------------------------

/** @returns {{name:string, vramMb:number|null, driver:string|null}|null} */
function detectNvidia () {
  const out = run('nvidia-smi',
    ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'])
  if (out === null) return null
  const line = out.split('\n').map((s) => s.trim()).filter(Boolean)[0]
  if (!line) return null
  const [name, mem, driver] = line.split(',').map((s) => (s || '').trim())
  if (!name) return null
  const vramMb = mem && /^\d+$/.test(mem) ? Number(mem) : null
  return { name, vramMb, driver: driver || null }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function detectWindows () {
  const out = run('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_VideoController | Select-Object Name | ConvertTo-Json -Compress"], 45000)
  if (!out) return []
  let parsed
  try { parsed = JSON.parse(out) } catch (e) { return [] }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list
    .map((g) => g && g.Name)
    .filter(Boolean)
    .map((name) => ({
      name,
      vendor: vendorFromName(name),
      // ⛔ 永远不给 vramMb —— 见文件头「关于显存这个数字」
    }))
    .filter((d) => d.vendor !== 'd3d12')   // WARP 是软件光栅，不是硬件
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

function detectLinux () {
  const out = []

  // ① 计算设备节点（真正的算力卡在这里；/sys/class/drm 只给**显示**设备）
  //    kfd 是 ROCm / Level Zero 的统一抽象：AMD 与 Intel 的计算设备都在这儿。
  if (fs.existsSync('/sys/class/kfd/kfd/topology')) {
    let dirs = []
    try { dirs = fs.readdirSync('/sys/class/kfd/kfd/topology') } catch (e) { dirs = [] }
    const nodes = dirs.filter((d) => /^\d+$/.test(d))
    out.push({
      source: '/sys/class/kfd',
      count: nodes.length,
      // ⚠️ 名字要从各自的 device symlink 解析；这里只报数量，
      //    ⛔ 拿不到就说拿不到（见 detectLinuxNames 补第二轮）。
      names: [],
    })
    for (const d of nodes) {
      const real = (() => {
        try { return fs.realpathSync(`/sys/class/kfd/kfd/topology/${d}/device`) } catch (e) { return '' }
      })()
      const m = /(\d{4}):(\d{4})$/.exec(real)
      if (m) {
        const [_, ven, dev] = m
        const name = `${vendorFromPci(ven)} ${dev}`
        out.push({ name, vendor: vendorFromPci(ven), source: `/sys/class/kfd/${d}` })
      }
    }
  }

  // ② 显示设备（当 kfd 不可用时的兜底）
  if (out.length === 0) {
    let cards = []
    try { cards = fs.readdirSync('/sys/class/drm') } catch (e) { cards = [] }
    for (const c of cards.filter((x) => /^card\d+$/.test(x))) {
      const raw = firstExisting([
        `/sys/class/drm/${c}/device/vendor`,
        `/sys/devices/pci0000:00/${c}/vendor`,
      ])
      if (!raw) continue
      out.push({
        name: `pci ${raw.trim()} (${c})`,
        vendor: vendorFromPci(raw.trim().replace(/^0x/, '')),
        source: `/sys/class/drm/${c}`,
      })
    }
  }
  return out
}

function vendorFromPci (id) {
  const s = String(id || '').toLowerCase().replace(/^0x/, '')
  if (s === '8086') return 'intel'
  if (s === '1002' || s === '1022') return 'amd'
  if (s === '10de') return 'nvidia'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

function detectDarwin () {
  const out = run('system_profiler', ['SPDisplaysDataType'], 45000)
  const list = []
  if (out) {
    for (const m of out.matchAll(/Chipset Model:\s*(.+)/g)) {
      const name = m[1].trim()
      list.push({ name, vendor: vendorFromName(name), source: 'system_profiler' })
    }
  }
  // ⭐ Apple Silicon 没有独立显卡，但**有统一内存的 GPU** ——
  //   只报「有芯片」会让人以为这台机器没有 GPU，而它其实有（报告实测 Vulkan 是最优后端）。
  if (list.length === 0 && os.arch() === 'arm64') {
    const cpu = os.cpus()[0] || {}
    list.push({
      name: `Apple GPU (${String(cpu.model || 'Apple Silicon').trim()})`,
      vendor: 'intel',
      shared_memory: true,
      source: 'arch=arm64',
    })
  }
  return list
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 这台机器有什么算力设备。
 *
 * @returns {{
 *   ready: boolean,
 *   available: boolean,        // ⭐ 只在 NVIDIA 时为真（前端 badge 依赖这一条）
 *   device_name: string|null,  // NVIDIA 优先；否则第一个非 NVIDIA 设备
 *   vram_gb: number|null,      // ⛔ 只有 NVIDIA 才给
 *   vendor: string|null,       // 设备厂商；无设备时 null
 *   shared_memory: boolean|null,
 *   devices: Array<object>,    // 全部设备（含多个显卡的情况）
 *   platform: string,
 *   probe: string              // 用了哪条判据 —— 出问题时人要知道它凭什么这么说
 * }}
 */
function detectGpuNow () {
  const platform = process.platform
  const nv = detectNvidia()          // ⭐ NVIDIA 判据跨平台通用，先问它
  let devices = []
  let probe = 'none'

  if (platform === 'win32') { devices = detectWindows(); probe = 'Win32_VideoController' }
  else if (platform === 'linux') { devices = detectLinux(); probe = '/sys/class/kfd → /sys/class/drm' }
  else if (platform === 'darwin') { devices = detectDarwin(); probe = 'system_profiler → arch' }

  devices = devices.filter(Boolean)

  if (nv) {
    // ⭐ NVIDIA 是唯一有权威显存读数的一类 —— 它同时出现在 devices 里，
    //   这样「有哪些设备」的答案也包含它，而不只是「有没有 CUDA」。
    devices = [{ name: nv.name, vendor: 'nvidia', vram_mb: nv.vramMb, driver: nv.driver, source: 'nvidia-smi' },
      ...devices.filter((d) => d.vendor !== 'nvidia')]
    probe += ' + nvidia-smi'
  }

  if (devices.length === 0) {
    return {
      ready: true, available: false, device_name: null, vram_gb: null,
      vendor: null, shared_memory: null, devices: [], platform, probe,
    }
  }

  const primary = devices.find((d) => d.vendor === 'nvidia') || devices[0]
  const vramMb = primary.vendor === 'nvidia' ? primary.vram_mb : null

  return {
    ready: true,
    // ⭐ 语义未变：**只在 NVIDIA 时为真** ⇒ web/src/App.jsx 与 TrainingTab 的
    //   badge / 显存告警 / 「无 CUDA 就别微调」三处逻辑**一行都不用改**。
    available: primary.vendor === 'nvidia',
    device_name: primary.name,
    vram_gb: vramMb ? Math.round(vramMb / 1024 * 10) / 10 : null,
    vendor: primary.vendor,
    shared_memory: primary.shared_memory === true ? true
      : (primary.vendor !== 'nvidia' ? true : null),
    devices,
    platform,
    probe,
  }
}

let _cached = null
let _cachedAt = 0
/** ⭐ 缓存 5 分钟 —— WMI / system_profiler 都要几秒，而 /api/health 会被反复调。 */
function detectGpuCached () {
  const now = Date.now()
  if (_cached && now - _cachedAt < 5 * 60 * 1000) return _cached
  _cached = detectGpuNow()
  _cachedAt = now
  return _cached
}

/** 清缓存（换驱动 / 插拔卡之后用）。 */
function clearGpuCache () { _cached = null; _cachedAt = 0 }

// ⭐ 兼容旧名 —— 旧的导出名 `startCudaProbe` / `detectCuda` 还在用
//   （server.js:104 与 lib/routes/system.js:129）。⚠️ 这是**临时的双名**，
//   改调用点是一件独立的小活；这里先不制造第二个真相，也**不假装没有旧名**。
const startCudaProbe = startGpuDetect
const detectCuda = detectGpuCached

/**
 * ⚠️ 旧接口的同义壳，**现在什么也不做**。
 *
 * 旧实现在这里 spawn 一个 Python 去 import torch，⛔ 现在刻意不做 ——
 * 理由见文件头。保留下这个函数名是为了让 server.js 的启动预热调用不必立刻改，
 * 而它**绝不能**被误当成「探测已启动」。
 */
function startGpuDetect () { /* 同步检测，无异步预热可做 */ }

module.exports = {
  detectGpu: detectGpuCached,   // ⭐ 对外的名字，带 5 分钟缓存
  detectGpuNow,                 // ⭐ 不带缓存（测试与排障用）
  clearGpuCache,
  startGpuDetect,
  // ⚠️ 旧名，兼容期保留。server.js:104 与 lib/routes/system.js:129 还在用
  startCudaProbe: startGpuDetect,
  detectCuda: detectGpuCached,
}