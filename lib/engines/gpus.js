'use strict'
// 显卡探测：列出本机装了哪几块卡，各自归哪个厂商。
//
// 放在 lib/ 而不是向导里，是因为两处都要用：9886 主应用的合成页要出设备下拉，
//   接入向导的第 5 步也要。放在工具侧会让主应用反向依赖 tools/，那是没必要的耦合。
//
// 本文件只回答「机器上有什么」，不判断引擎要哪种写法：
//   引擎认 cuda / cuda:1 还是 0 / 1，由 lib/engines/deviceValue.js 换算。

const os = require('node:os')
const { execFileSync } = require('node:child_process')

function run (cmd, args, timeoutMs) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: timeoutMs || 30000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (e) { return null }
}

/**
 * 依次试几条命令，返回第一条能给出结果的输出。
 * 用途：某些 Windows 环境的 PATH 上没有命令行解释器（精简安装、受限环境常见），
 *   先试裸名，再用标准安装路径。裸名不存在与查询失败都会让 run 返回 null，于是换下一条。
 * runner 可注入（默认 run），仅供测试替身。
 */
function runFirst (cmds, args, timeoutMs, runner) {
  const run_ = runner || run
  for (const c of cmds) {
    const r = run_(c, args, timeoutMs)
    if (r !== null) return r
  }
  return null
}

// 检测结果缓存：枚举显卡要起子进程，几百毫秒到十几秒，缓存 5 分钟。
let _cache = null
let _cacheAt = 0
const CACHE_MS = 5 * 60 * 1000

/**
 * 两张表对同一块显卡的写法常常不同：nvidia-smi 给 "NVIDIA GeForce RTX 4090"，
 *   WMI 可能写成 "NVIDIA GeForce RTX 4090 Laptop GPU"。归一化后比较，
 *   并允许一方是另一方的前缀，否则同一块卡会被列两遍，使用者以为机器上有两块。
 */
function sameGpuName (a, b) {
  const norm = (s) => String(s || '')
    .replace(/\((R|TM|C)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  return x === y || x.startsWith(y) || y.startsWith(x)
}

/**
 * 检测本机 GPU。任何一步失败都不抛，分不清就交给调用方退 CPU。
 * index 是「引擎会认的那个编号」：NVIDIA 取 nvidia-smi -L 里的 GPU 序号，
 *   它等于 CUDA 的编号；其他来源拿不到可靠编号时给 null，调用方按「不指定」处理。
 * @returns {{vendor:string, index:number|null, name:string|null, via:string}[]}
 */
function detectGpus () {
  const now = Date.now()
  if (_cache && now - _cacheAt < CACHE_MS) return _cache
  const out = []
  const plat = process.platform

  // NVIDIA：nvidia-smi 是主信号（驱动自带，最可靠），也是唯一带可靠编号的来源
  const smi = run('nvidia-smi', ['-L'])
  if (smi) {
    for (const line of smi.split('\n')) {
      const m = line.match(/^GPU\s+(\d+)\s*:\s*(.+)$/)
      if (!m) continue
      // 去掉行尾的 (UUID: GPU-xxxx)，那是驱动内部标识，界面上没有意义
      const name = m[2].replace(/\s*\(UUID:[^)]*\)\s*$/i, '').trim()
      if (!name) continue
      out.push({ vendor: 'nvidia', index: Number(m[1]), name, via: 'nvidia-smi -L' })
    }
  }

  if (plat === 'win32') {
    // 同时取 AdapterCompatibility（厂商）：按名字猜厂商会把 "Intel(R) Arc" 这类
    //   判成 unknown，而厂商字段是系统直接给的，不受驱动写法影响。
    const ps = runFirst(
      ['powershell', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
      ['-NoProfile', '-Command',
        'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterCompatibility)" }'])
    if (ps) {
      for (const line of ps.split('\n').map((x) => x.trim()).filter(Boolean)) {
        const bar = line.lastIndexOf('|')
        const raw = (bar >= 0 ? line.slice(0, bar) : line).replace(/\s+/g, ' ').trim()
        const compat = (bar >= 0 ? line.slice(bar + 1) : '').toLowerCase()
        if (!raw) continue
        const name = raw
        const lower = name.toLowerCase()
        let vendor = 'unknown'
        if (compat.includes('nvidia') || lower.includes('nvidia')) vendor = 'nvidia'
        else if (compat.includes('intel') || lower.includes('intel') || lower.includes('arc')) vendor = 'intel'
        else if (compat.includes('amd') || compat.includes('advanced micro devices') ||
          lower.includes('amd') || lower.includes('radeon')) vendor = 'amd'
        // nvidia-smi 已经列过的卡在这里会再出现一次，名字写法未必一致
        //   （"RTX 4090" 与 "RTX 4090 Laptop GPU"），按归一化名字与包含关系去重。
        if (out.some((g) => g.vendor === vendor && sameGpuName(g.name, name))) continue
        // Win32_VideoController 的顺序不代表 CUDA 编号，这一条不参与编号选择
        out.push({ vendor, index: null, name, via: 'Win32_VideoController' })
      }
    }
  } else if (plat === 'darwin') {
    // macOS：Apple Silicon（MPS）
    if (os.cpus()[0] && /arm/i.test(os.cpus()[0].architecture)) {
      out.push({ vendor: 'apple', index: null, name: 'Apple Silicon', via: 'process.arch=arm64' })
    }
  } else {
    // Linux：/sys/class/drm
    try {
      const cards = fs_().readdirSync('/sys/class/drm').filter((x) => /^card\d+$/.test(x))
      for (const c of cards) {
        const p = `/sys/class/drm/${c}/device/vendor`
        if (!fs_().existsSync(p)) continue
        const v = fs_().readFileSync(p, 'utf-8').trim()
        const vendor = v === '0x8086' ? 'intel'
          : v === '0x1002' || v === '0x1022' ? 'amd'
            : v === '0x10de' ? 'nvidia' : 'unknown'
        out.push({ vendor, index: null, name: c, via: '/sys/class/drm vendor id' })
      }
    } catch { /* 没有就分不清，交给调用方退 CPU */ }
  }
  _cache = out; _cacheAt = now
  return out
}

/** 装完驱动或换卡之后调，让下次检测重新跑。 */
function clearGpuCache () { _cache = null; _cacheAt = 0 }

// Linux 分支要 fs，而 detectGpus 是同步的：这里单独 require，免得顶部就依赖 fs
let _fs = null
function fs_ () {
  if (!_fs) _fs = require('node:fs')
  return _fs
}

module.exports = { detectGpus, sameGpuName, clearGpuCache, run, runFirst }
