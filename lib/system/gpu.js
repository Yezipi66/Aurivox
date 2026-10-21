'use strict'

// 算力设备检测：回答「本机有什么显卡」，不回答「它能干什么」。
// 不 spawn Python，也不问任何 venv：平台根 venv 里没有 torch，那个探针只会给出
// 一个假的「无 CUDA」。能力问题归引擎自己的 torch 管。
// 跨平台：形状由平台决定，每个平台各有一套判据，不做通用猜测。
// 显存只有 NVIDIA 才给（nvidia-smi 是权威）；其他厂商的 AdapterRAM 是 32 位
// 字段封顶的产物，不是显存，一律 vram_gb: null 加 shared_memory 标注。
// 纪律：不许出现任何具体引擎名。回答的是机器，不是引擎。

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

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

/** 从设备名字里认厂商：这是名字匹配，不是问驱动。 */
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

/** NVIDIA 是跨平台唯一有权威输出的一类。
 * @returns {{name:string, vramMb:number|null, driver:string|null}|null} */
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
      // 永远不给 vramMb：见文件头「显存」那条
    }))
    .filter((d) => d.vendor !== 'd3d12')   // WARP 是软件光栅，不是硬件
}

function detectLinux () {
  const out = []

  // ① 计算设备节点（真正的算力卡在这里；/sys/class/drm 只给显示设备）
  // kfd 是 ROCm / Level Zero 的统一抽象，AMD 与 Intel 的计算设备都在这儿。
  if (fs.existsSync('/sys/class/kfd/kfd/topology')) {
    let dirs = []
    try { dirs = fs.readdirSync('/sys/class/kfd/kfd/topology') } catch (e) { dirs = [] }
    const nodes = dirs.filter((d) => /^\d+$/.test(d))
    out.push({
      source: '/sys/class/kfd',
      count: nodes.length,
      // 名字要从各自的 device symlink 解析；这里只报数量。
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

  // ② 显示设备（kfd 不可用时的兜底）
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

function detectDarwin () {
  const out = run('system_profiler', ['SPDisplaysDataType'], 45000)
  const list = []
  if (out) {
    for (const m of out.matchAll(/Chipset Model:\s*(.+)/g)) {
      const name = m[1].trim()
      list.push({ name, vendor: vendorFromName(name), source: 'system_profiler' })
    }
  }
  // Apple Silicon 没有独立显卡，但有统一内存的 GPU：只报「有芯片」
  // 会让人以为本机没有 GPU，而它实际有。
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

/**
 * 本机有什么算力设备。
 * @returns {{
 * ready, available, // available 只在 NVIDIA 时为真（前端 badge 依赖这一条）
 * device_name, // NVIDIA 优先；否则第一个非 NVIDIA 设备
 * vram_gb, // 只有 NVIDIA 才给
 * vendor, // 设备厂商；无设备时 null
 * shared_memory, devices, // devices 含多个显卡的情况
 * platform, probe // probe 是用了哪条判据：出问题时人要知道它凭什么这么说
 * }}
 */
function detectGpuNow () {
  const platform = process.platform
  const nv = detectNvidia()          // NVIDIA 判据跨平台通用，先问它
  let devices = []
  let probe = 'none'

  if (platform === 'win32') { devices = detectWindows(); probe = 'Win32_VideoController' }
  else if (platform === 'linux') { devices = detectLinux(); probe = '/sys/class/kfd → /sys/class/drm' }
  else if (platform === 'darwin') { devices = detectDarwin(); probe = 'system_profiler → arch' }

  devices = devices.filter(Boolean)

  if (nv) {
    // NVIDIA 是唯一有权威显存读数的一类：它同时出现在 devices 里，
    // 这样「有哪些设备」的答案也包含它，而不只是「有没有 CUDA」。
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
    // 只在 NVIDIA 时为真：前端 badge / 显存告警 / 「无 CUDA 就别微调」都依赖这一条。
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
/** 缓存 5 分钟：WMI / system_profiler 都要几秒，而 /api/health 会被反复调。 */
function detectGpuCached () {
  const now = Date.now()
  if (_cached && now - _cachedAt < 5 * 60 * 1000) return _cached
  _cached = detectGpuNow()
  _cachedAt = now
  return _cached
}

/** 清缓存（换驱动 / 插拔卡之后用）。 */
function clearGpuCache () { _cached = null; _cachedAt = 0 }

// 兼容旧名：旧的导出名 `startCudaProbe` / `detectCuda` 还在用。
// 这是临时的双名，改调用点是一件独立的小活。
const startCudaProbe = startGpuDetect
const detectCuda = detectGpuCached

// 旧接口的同义壳，现在什么也不做。保留下这个函数名是为了让 server.js 的
// 启动预热调用不必立刻改，而它绝不能被误当成「探测已启动」。
function startGpuDetect () { /* 同步检测，无异步预热可做 */ }

module.exports = {
  detectGpu: detectGpuCached,   // 对外的名字，带 5 分钟缓存
  detectGpuNow,                 // 不带缓存（测试与排障用）
  clearGpuCache,
  startGpuDetect,
  // 旧名，兼容期保留
  startCudaProbe: startGpuDetect,
  detectCuda: detectGpuCached,
}