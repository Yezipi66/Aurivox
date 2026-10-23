'use strict'
// 硬件检测：识别本机 GPU，给出 torch 后端建议。
// 偏好顺序照 StabilityMatrix 的原文顺序，推荐只是建议（guidance），不是保证。
// 本文件不识别具体引擎，只按显卡厂商与 uv.lock 里写的后端判断。

const os = require('node:os')
const { execFileSync } = require('node:child_process')

/**
 * 后端的固定偏好顺序，照 StabilityMatrix 的原文顺序。
 * 这是建议排序，不是只支持这几个。
 */
const BACKEND_PREFERENCE = [
  { key: 'cuda',   label: 'CUDA',   for: 'NVIDIA（Windows/Linux）',
    index: 'https://download.pytorch.org/whl/cu121',
    pkg: 'torch (cu121 wheel)' },
  { key: 'zluda',  label: 'ZLUDA',  for: 'AMD (Windows)',
  forZh: 'AMD（Windows）',
    index: null,
    pkg: 'torch (ZLUDA build)' },
  { key: 'ipex',   label: 'IPEX / XPU', for: 'Intel Arc / Core Ultra iGPU',
  forZh: 'Intel Arc / Core Ultra 核显',
    index: 'https://download.pytorch.org/whl/xpu',
    pkg: 'torch (xpu wheel)' },
  { key: 'rocm',   label: 'ROCm',   for: 'AMD (Linux, or a multi-arch card supported on Windows)',
  forZh: 'AMD（Linux，或 Windows 上受支持的多架构卡）',
    index: 'https://download.pytorch.org/whl/rocm6.4',
    pkg: 'torch (rocm wheel)' },
  { key: 'directml', label: 'DirectML', for: 'AMD / Intel (Windows; the most compatible fallback)',
  forZh: 'AMD / Intel（Windows，最兼容的兜底）',
    index: null,
    pkg: 'torch-directml' },
  { key: 'cpu',    label: 'CPU',    for: 'Every platform (last resort)',
  forZh: '所有平台（最后兜底）',
    index: 'https://download.pytorch.org/whl/cpu',
    pkg: 'torch (cpu wheel)' },
]

function run (cmd, args, timeoutMs) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: timeoutMs || 30000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (e) { return null }
}

// 检测结果缓存：WMI 每次都要十几秒，缓存 5 分钟。
let _cache = null
let _cacheAt = 0
const CACHE_MS = 5 * 60 * 1000

/**
 * 检测本机 GPU。任何一步失败都不抛，分不清就交给调用方退 CPU。
 * @returns {{vendor:string, name:string|null, via:string}[]}
 */
function detectGpus () {
  const now = Date.now()
  if (_cache && now - _cacheAt < CACHE_MS) return _cache
  const out = []
  const plat = process.platform

  // NVIDIA：nvidia-smi 是主信号（驱动自带，最可靠）
  const smi = run('nvidia-smi', ['-L'])
  if (smi) {
    const names = smi.split('\n')
      .map((l) => l.replace(/^GPU\s+\d+\s*:\s*/, '').trim())
      .filter(Boolean)
    for (const n of names) out.push({ vendor: 'nvidia', name: n, via: 'nvidia-smi -L' })
  }

  if (plat === 'win32') {
    const ps = run('powershell', [
      '-NoProfile', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
    ])
    if (ps) {
      for (const raw of ps.split('\n').map((x) => x.trim()).filter(Boolean)) {
        const name = raw.replace(/\s+/g, ' ')
        const lower = name.toLowerCase()
        let vendor = 'unknown'
        if (lower.includes('nvidia')) vendor = 'nvidia'
        else if (lower.includes('amd') || lower.includes('radeon')) vendor = 'amd'
        else if (lower.includes('intel') || lower.includes('arc')) vendor = 'intel'
        if (out.some((g) => g.vendor === vendor && g.name === name)) continue
        out.push({ vendor, name, via: 'Win32_VideoController' })
      }
    }
  } else if (plat === 'darwin') {
    // macOS：Apple Silicon（MPS）
    if (os.cpus()[0] && /arm/i.test(os.cpus()[0].architecture)) {
      out.push({ vendor: 'apple', name: 'Apple Silicon', via: 'process.arch=arm64' })
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
        out.push({ vendor, name: c, via: '/sys/class/drm vendor id' })
      }
    } catch { /* 没有就分不清，交给调用方退 CPU */ }
  }
  _cache = out; _cacheAt = now
  return out
}

/** 装完驱动或换卡之后调，让下次检测重新跑。 */
function clearHardwareCache () { _cache = null; _cacheAt = 0 }

// 上面 Linux 分支要 fs，而 detectGpus 是同步的：这里单独 require 免得顶部就依赖 fs
let _fs = null
function fs_ () {
  if (!_fs) _fs = require('node:fs')
  return _fs
}

/**
 * 按 StabilityMatrix 的偏好顺序，为本机选一个推荐后端。
 * @param {{vendor:string}[]} gpus
 * @returns {{recommended:string, reason:string, reasonZh:string, confidence:'guidance'|'fallback'}}
 */
function recommendBackend (gpus) {
  const has = (v) => gpus.some((g) => g.vendor === v)


  if (has('nvidia')) {
    return { recommended: 'cuda', confidence: 'guidance', reason: 'Recommended: CUDA', reasonZh: '推荐使用 CUDA' }
  }
  if (process.platform === 'darwin' && has('apple')) {
    // MPS 是 Apple Silicon 上的选择，不是 CUDA。差别只影响本页推荐。
    return { recommended: 'mps', confidence: 'guidance', reason: 'Recommended: MPS', reasonZh: '推荐使用 MPS' }
  }
  if (has('intel')) {
    return { recommended: 'ipex', confidence: 'guidance', reason: 'Recommended: XPU', reasonZh: '推荐使用 XPU' }
  }
  if (has('amd')) {
    return process.platform === 'win32'
      ? { recommended: 'directml', confidence: 'guidance', reason: 'Recommended: DirectML', reasonZh: '推荐使用 DirectML' }
      : { recommended: 'rocm', confidence: 'guidance', reason: 'Recommended: ROCm', reasonZh: '推荐使用 ROCm' }
  }
  return {
    recommended: 'cpu',
    confidence: 'fallback',
    reason: 'No accelerator detected — falling back to CPU.',
    reasonZh: '未检测到可用的加速器，已回退 CPU',
    fellBack: true,
  }
}

/**
 * 完整入口：检测 + 推荐 + 全部可选项。
 *
 * 返回里一定带 options（所有可选项）：推荐只是 highlight，
 *   用户可以选任何一条，包括「我自己装」。
 */
function inspectHardware () {
  const gpus = detectGpus()
  const rec = recommendBackend(gpus)
  return {
    gpus,
    recommended: rec.recommended,
    reason: rec.reason,
    reasonZh: rec.reasonZh,
    confidence: rec.confidence,
    fellBack: !!rec.fellBack,
    caveat: gpus.length === 0
      ? 'No accelerator detected — falling back to CPU. CPU inference is very slow and fine-tuning is unavailable.'
      : 'Matched by detected GPU model — not verified by actually running on this machine.',
    caveatZh: gpus.length === 0
      ? '未检测到任何加速设备，已回退 CPU。CPU 推理速度很慢，微调不可用。'
      : '按已识别的显卡型号匹配，未在本机运行验证。',
    preferenceOrder: BACKEND_PREFERENCE,
    options: BACKEND_PREFERENCE,
  }
}

/**
 * 判断 uv.lock 里的 torch 属于哪个后端，跟本机检测结果比。
 *
 * 这是标绿与标黄的依据：不是检测到 Intel 就判不行，
 * 而是看 lock 里写的后端与本机能不能用对不对得上。
 *
 * @param {string} spec lock 里那行，比如 'torch==2.2.0+cu121'
 * @returns {{kind:string, verdict:'match'|'mismatch'|'unknown', why:string, whyZh:string}}
 */
function judgeTorchSpec (spec, detected, ctx = {}) {
  const s = String(spec || '')
  const mine = detected || null
  const verdictFor = (kind, desc, descZh) => {
    if (!mine) {
      return { kind, verdict: 'unknown',
        why: `${desc} (this machine was not detected)`, whyZh: `${descZh}（未检测本机）` }
    }
    if (mine === kind) {
      return { kind, verdict: 'match',
        why: `${desc} — matches the recommended backend for this machine`, whyZh: `${descZh}，与本机推荐一致` }
    }
    return { kind, verdict: 'mismatch',
      why: `${desc} — this machine recommends ${mine}`, whyZh: `${descZh}，本机推荐的是 ${mine}` }
  }

  const explicit = s.match(/\+([a-z0-9.]+)/i)
  if (explicit) {
    const tag = explicit[1].toLowerCase()
    if (tag.startsWith('cu')) {
      return verdictFor('cuda', `CUDA build (${tag}), needs NVIDIA drivers`, `CUDA 版（${tag}），需要 NVIDIA 驱动`)
    }
    if (tag.startsWith('rocm')) {
      return verdictFor('rocm', `ROCm build (${tag}), needs AMD drivers`, `ROCm 版（${tag}），需要 AMD 驱动`)
    }
    if (tag.startsWith('xpu') || tag.startsWith('ipex')) {
      return verdictFor('ipex', `Intel XPU build (${tag})`, `Intel XPU 版（${tag}）`)
    }
    return { kind: 'unknown', verdict: 'unknown',
      why: `Suffix +${tag} is not recognized — please check manually.`,
      whyZh: `后缀 +${tag} 无法识别，请自行确认。` }
  }

  if (/torch==[\d.]+$/.test(s.trim())) {
    const locked = ctx.lockedPackages || []
    const cudaDeps = locked.filter((n) => /^nvidia-|^triton$/.test(n))
    if (cudaDeps.length) {
      return verdictFor('cuda', 'CUDA build, needs NVIDIA drivers', 'CUDA 版，需要 NVIDIA 驱动')
    }
    const xpuDeps = locked.filter((n) => /^intel-|^xpu|^ipex/.test(n))
    if (xpuDeps.length) {
      return verdictFor('ipex', 'Intel XPU build', 'Intel XPU 版')
    }
    return { kind: 'cpu', verdict: 'match',
      why: 'CPU build — installable on any machine, but slower.',
      whyZh: 'CPU 版，任何机器均可安装，速度较慢。' }
  }

  return { kind: 'unknown', verdict: 'unknown',
    why: 'Could not determine which backend this package targets — please check manually.',
    whyZh: '无法判断该包适用的后端，请自行确认。' }
}

/**
 * 把 torch 系包从依赖清单里摘出来，其余归普通依赖。
 * 判定用包名，不看版本、不猜。
 * @returns {{torchish:string[], rest:string[]}}
 */
const TORCH_FAMILY = new Set([
  'torch', 'torchvision', 'torchaudio', 'pytorch-triton',
  'onnxruntime', 'onnxruntime-gpu', 'onnxruntime-directml',
  'triton', 'xformers', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12',
])

function splitTorchPackages (deps) {
  const torchish = []
  const rest = []
  for (const d of deps) {
    const name = String(d).split(/[<>=!~\[]/)[0].trim().toLowerCase()
    if (TORCH_FAMILY.has(name)) torchish.push(d)
    else rest.push(d)
  }
  return { torchish, rest }
}


/**
 * 解析 uv.lock 里锁定的 torch 系包。
 *
 * 只做「行 → 值」，不解析整个 lock 语法。
 * @returns {{name:string, version:string, source:string|null, marker:string|null, spec:string}[]}
 * @returns {{name:string, version:string, source:string|null, spec:string}[]}
 */
function parseUvLock (text) {
  if (typeof text !== 'string' || !text.includes('name =')) return []
  const out = []
  // lock 的形状：[[package]]\n name = "x"\n version = "y"\n source = {...}
  const blocks = text.split(/\[\[package\]\]/).slice(1)
  for (const b of blocks) {
    const name = (b.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1]
    if (!name) continue
    if (!TORCH_FAMILY.has(name.toLowerCase())) continue
    const version = (b.match(/^\s*version\s*=\s*"([^"]+)"/m) || [])[1] || null
    const src = (b.match(/source\s*=\s*\{([^}]*)\}/) || [])[1] || null
    let source = null
    if (src) {
      if (/download\.pytorch\.org/.test(src)) {
        const whl = (src.match(/whl\/(\w+)/) || [])[1]
        const cu = (src.match(/\+(?:cu)(\d+)/) || [])[1]
        source = `PyTorch 官方 index（${whl || '?'}${cu ? ' / +cu' + cu : ''}）`
      } else if (/rocm/.test(src)) source = 'AMD ROCm index'
      else if (/registry/.test(src)) source = (src.match(/registry = "([^"]+)"/) || [])[1] || 'PyPI'
      else source = '（其它来源）'
    }
    const marker = (b.match(/marker\s*=\s*"([^"]*)"/) || [])[1] || null
    out.push({ name, version, source, marker, spec: `torch==${version}` })
  }
  return out
}

/**
 * 从 uv.lock 读出 torch 的纯版本号（剥掉 +cu128 / +xpu 这类后缀）。
 *
 * @param {string} text uv.lock 全文
 * @param {string} [platform] process.platform，默认取当前平台
 * @returns {{version:string, plain:string, backend:string|null}|null}
 *   version = lock 里的原样版本（含后缀）· plain = 剥掉后缀
 *   backend = 从后缀/source 推出的后端 key（cuda/ipex/rocm/null）
 */
/**
 * 锁文件里挑 torch 那一行的判据（readTorchPin 与 readTorchFamilyPins 共用）。
 * 优先级：带后缀且 marker 匹配本机 > 带后缀 > 匹配本机 > 第一条
 */
function preferLockRow (cands, plat) {
  const backendOf = (r) => {
    const v = String(r.version)
    if (/\+(?:cu|cuda)\d*/i.test(v) || /download\.pytorch\.org\/whl\/cu/i.test(r.source || '')) return 'cuda'
    if (/\+(?:xpu|ipex)/i.test(v) || /download\.pytorch\.org\/whl\/xpu/i.test(r.source || '')) return 'ipex'
    if (/\+rocm/i.test(v) || /rocm/i.test(r.source || '')) return 'rocm'
    return null
  }
  const isWinLinux = (r) => (r.marker ? /win32|linux/.test(r.marker) : false)
  const isOther = (r) => (r.marker ? /darwin|win32\s*==\s*'false'/.test(r.marker) : false)

  return cands.find((r) => backendOf(r) && isWinLinux(r) && plat !== 'darwin')
    || cands.find((r) => backendOf(r) && isWinLinux(r))
    || cands.find((r) => backendOf(r))
    || cands.find((r) => isWinLinux(r) && plat !== 'darwin')
    || cands.find((r) => isOther(r) && plat === 'darwin')
    || cands[0]
}

function readTorchPin (text, platform) {
  const plat = platform || process.platform
  const rows = parseUvLock(text)
  const cands = rows.filter((r) => r.name.toLowerCase() === 'torch' && r.version)
  if (!cands.length) return null

  const pick = preferLockRow(cands, plat)
  const version = String(pick.version)
  const backendOf = (r) => {
    const v = String(r.version)
    if (/\+(?:cu|cuda)\d*/i.test(v) || /download\.pytorch\.org\/whl\/cu/i.test(r.source || '')) return 'cuda'
    if (/\+(?:xpu|ipex)/i.test(v) || /download\.pytorch\.org\/whl\/xpu/i.test(r.source || '')) return 'ipex'
    if (/\+rocm/i.test(v) || /rocm/i.test(r.source || '')) return 'rocm'
    return null
  }
  return { version, plain: version.replace(/\+.*$/, ''), backend: backendOf(pick) }
}

/**
 * torch 系（不止 torch 一个）的锁定版本。
 * @param {string} text uv.lock 全文
 * @param {string} [platform] process.platform，默认取当前平台
 * @returns {{name:string, plain:string}[]|null} torch 排第一；读不出 torch 给 null
 */
function readTorchFamilyPins (text, platform) {
  const plat = platform || process.platform
  const rows = parseUvLock(text)
  const torchCands = rows.filter((r) => r.name.toLowerCase() === 'torch' && r.version)
  if (!torchCands.length) return null
  const torchRow = preferLockRow(torchCands, plat)
  const plain = String(torchRow.version).replace(/\+.*$/, '')
  const out = [{ name: 'torch', plain }]
  for (const sib of ['torchaudio', 'torchvision']) {
    const cands = rows.filter((r) => r.name.toLowerCase() === sib && r.version
      && String(r.version).replace(/\+.*$/, '') === plain)
    if (!cands.length) continue          // lock 里没有，不装
    out.push({ name: sib, plain: String(preferLockRow(cands, plat).version).replace(/\+.*$/, '') })
  }
  return out
}

module.exports = {
  parseUvLock, readTorchPin, readTorchFamilyPins, clearHardwareCache,
  BACKEND_PREFERENCE, detectGpus, recommendBackend, inspectHardware,
  judgeTorchSpec, splitTorchPackages, TORCH_FAMILY,
}