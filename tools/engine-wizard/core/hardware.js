'use strict'
// ============================================================================
//  HARDWARE —— 检测本机 GPU，给出 torch 后端建议
//
//  ⭐ 逻辑照抄 StabilityMatrix（开源，Apache-2.0）的 docs/advanced/hardware-support.md，
//     它的原文：
//       「The general order of preference is CUDA for NVIDIA, then ZLUDA (Windows AMD),
//         then IPEX (Intel), then native ROCm (Linux AMD, or supported Windows AMD),
//         then DirectML (Windows AMD), and finally CPU as a last resort.
//         If a package does not support your detected GPU, the recommended default
//         falls back to CPU.」
//
//  ⛔⛔ 三条纪律（照 StabilityMatrix 自己的说法，不是我的发明）：
//
//   1. ⛔ **推荐，不是决定**。所有选项都摆出来让用户选，
//     包括「照 uv.lock 装」「我自己装 torch」。
//
//  2. ⛔ **检测是尽力而为，不是保证**。原文：
//     「treat any GPU model boundaries as **guidance rather than a hard guarantee**;
//       some GPUs work with manual configuration even when a badge is not shown」
//     ⚠ Intel 那条更明确：「detection is **name-based** and matches GPUs whose
//       name contains "Arc"」—— 就是字符串匹配，不是真的问驱动。
//
//  3. ⛔ **分不清就退 CPU**（原文的 fallback，也是我们项目
//     install_torch.ps:109 自己的做法：「If we cannot tell, we assume CPU
//     (the safe, universally-importable choice) and say so」）。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

const os = require('node:os')
const { execFileSync } = require('node:child_process')

/**
 * ⭐ 后端的固定偏好顺序 —— StabilityMatrix 的原文顺序。
 * ⚠ 这是**建议排序**，不是「只支持这几个」。
 */
const BACKEND_PREFERENCE = [
  { key: 'cuda',   label: 'CUDA',   for: 'NVIDIA（Windows/Linux）',
    index: 'https://download.pytorch.org/whl/cu121',
    pkg: 'torch (cu121 wheel)' },
  { key: 'zluda',  label: 'ZLUDA',  for: 'AMD（Windows）',
    index: null,
    pkg: 'torch (ZLUDA build)' },
  { key: 'ipex',   label: 'IPEX / XPU', for: 'Intel Arc / Core Ultra 核显',
    index: 'https://download.pytorch.org/whl/xpu',
    pkg: 'torch (xpu wheel)' },
  { key: 'rocm',   label: 'ROCm',   for: 'AMD（Linux，或 Windows 上受支持的多架构卡）',
    index: 'https://download.pytorch.org/whl/rocm6.4',
    pkg: 'torch (rocm wheel)' },
  { key: 'directml', label: 'DirectML', for: 'AMD / Intel（Windows，最兼容的兜底）',
    index: null,
    pkg: 'torch-directml' },
  { key: 'cpu',    label: 'CPU',    for: '所有平台（最后兜底）',
    index: 'https://download.pytorch.org/whl/cpu',
    pkg: 'torch (cpu wheel)' },
]

function run (cmd, args, timeoutMs) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      // ⚠⚠ 8秒不够 —— 2026-10-04 实测：WMI 查显卡在服务进程里跑要十几秒，
      //   超时后 run() 返回 null ⇒ GPU 列表空 ⇒ 推荐退 CPU（错的）。
      //   powershell 启动本身就 2-4 秒，WMI 再几秒。
      timeout: timeoutMs || 30000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (e) { return null }
}

// ⭐ 检测结果缓存 —— ⛔ WMI 每次都要十几秒，
//   而 /wizard/deps 是「看一眼」的端点，不能每次都付这个代价。
//   ⚠ 缓存 5 分钟：刚装完驱动就检测的话，5 分钟内看不到变化。
let _cache = null
let _cacheAt = 0
const CACHE_MS = 5 * 60 * 1000

/**
 * ⭐ 检测本机 GPU。**尽力而为**，任何一步失败都不抛 —— 分不清就交给调用方退 CPU。
 * @returns {{vendor:string, name:string|null, detail:string|null}[]}
 */
function detectGpus () {
  const now = Date.now()
  if (_cache && now - _cacheAt < CACHE_MS) return _cache
  const out = []
  const plat = process.platform

  // ---- NVIDIA：nvidia-smi 是主信号（驱动自带，最可靠）----
  const smi = run('nvidia-smi', ['-L'])
  if (smi) {
    const names = smi.split('\n')
      .map((l) => l.replace(/^GPU\s+\d+\s*:\s*/, '').trim())
      .filter(Boolean)
    for (const n of names) out.push({ vendor: 'nvidia', name: n, via: 'nvidia-smi -L' })
  }

  // ---- 其它厂商：读显卡名（名字匹配，⚠ 就是 StabilityMatrix 说的那种）----
  if (plat === 'win32') {
    // ⛔ WMI 查询走 powershell（不依赖第三方包）
    const ps = run('powershell', [
      '-NoProfile', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
    ])
    if (ps) {
      for (const raw of ps.split('\n').map((x) => x.trim()).filter(Boolean)) {
        const name = raw.replace(/\s+/g, ' ')
        const lower = name.toLowerCase()
        let vendor = 'unknown'
        // ⚠ 名字匹配 —— 照 StabilityMatrix：「detection is name-based」
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
    } catch { /* 没有就分不清 ⇒ 交给调用方退 CPU */ }
  }
  _cache = out; _cacheAt = now
  return out
}

/** ⛔ 清缓存（装完驱动/换了卡之后用） */
function clearHardwareCache () { _cache = null; _cacheAt = 0 }

// ⛔ 上面 Linux 分支要 fs，而 detectGpus 是同步的 —— 这里单独 require 免得顶部就依赖 fs
let _fs = null
function fs_ () {
  if (!_fs) _fs = require('node:fs')
  return _fs
}

/**
 * ⭐ 按 StabilityMatrix 的偏好顺序，为本机选一个**推荐后端**。
 * @param {{vendor:string}[]} gpus
 * @returns {{recommended:string, reason:string, confidence:'guidance'|'unknown'}}
 */
function recommendBackend (gpus) {
  const has = (v) => gpus.some((g) => g.vendor === v)

  // ⛔ reason 只陈述结论，⛔ 不给理由。理由是维护者的信息（依据哪套偏好
  //   顺序、为什么这个平台选它），而界面上它渲染成一行提示（StepDeps.jsx）
  //   ⇒ 放进去只会让人读第二遍已经写在标题里的结论。
  //   判据：reason 里出现 StabilityMatrix /「按型号判断」/「有三条路」
  //   这类实现依据 ⇒ 那句话该待在代码注释里。
  //
  // ⛔ 推荐不是保证：本机实际可用性由 lock 后端与检测结果的比对给出
  //   （judgeTorchSpec），界面分开显示，⛔ 不混进 reason。

  if (has('nvidia')) {
    return { recommended: 'cuda', confidence: 'guidance', reason: '推荐使用 CUDA' }
  }
  if (process.platform === 'darwin' && has('apple')) {
    // MPS 是 Apple Silicon 上的选择，⛔ 不是 CUDA。差别只影响本页推荐。
    return { recommended: 'mps', confidence: 'guidance', reason: '推荐使用 MPS' }
  }
  if (has('intel')) {
    // ⚠ 探测是**按型号名**判的（型号含 Arc 才算 Arc）。那是置信度问题，
    //   由 confidence 字段承担，⛔ 不写进 reason。
    return { recommended: 'ipex', confidence: 'guidance', reason: '推荐使用 XPU' }
  }
  if (has('amd')) {
    // Windows 上有三条路（ROCm / ZLUDA / DirectML），取最兼容的兜底；
    // 完整排序见 BACKEND_PREFERENCE。
    return process.platform === 'win32'
      ? { recommended: 'directml', confidence: 'guidance', reason: '推荐使用 DirectML' }
      : { recommended: 'rocm', confidence: 'guidance', reason: '推荐使用 ROCm' }
  }
  // 分不清 ⇒ CPU 版。CPU 是「哪里都装得上」的选择，代价是速度。
  return { recommended: 'cpu', confidence: 'unknown', reason: '推荐使用 CPU' }
}

/**
 * ⭐ 完整入口：检测 + 推荐 + 全部可选项。
 *
 * ⚠ 返回里**一定**带 `options`（所有可选项）——
 *   推荐只是 highlight，用户可以选任何一条，包括「我自己装」。
 */
function inspectHardware () {
  const gpus = detectGpus()
  const rec = recommendBackend(gpus)
  return {
    gpus,
    recommended: rec.recommended,
    reason: rec.reason,
    // ⚠ 永远说清楚：这是建议不是保证
    confidence: rec.confidence,
    caveat: '按已识别的显卡型号匹配，未在本机运行验证。',
    preferenceOrder: BACKEND_PREFERENCE,
    options: BACKEND_PREFERENCE,
  }
}

/**
 * ⭐ ⭐ 关键：判断 **uv.lock 里的 torch 属于哪个后端**，跟检测结果比。
 *
 * ⚠ 这才是「标绿 / 标黄」的依据 —— ⛔ 不是「检测到 Intel 就说不行」，
 *   而是「lock 里写的那个后端，跟本机能不能用对得上」。
 *
 * @param {string} spec lock 里那行，比如 'torch==2.2.0+cu121'
 * @returns {{kind:string, verdict:'match'|'mismatch'|'unknown', why:string}}
 */
function judgeTorchSpec (spec, detected, ctx = {}) {
  const s = String(spec || '')
  // ⭐ 第二个参数 = inspectHardware().recommended。
  //    ⚠ 没有它就只能说「这是 CUDA 版」，⛔ 说不准「跟你这台机器对不对得上」——
  //    而那正是 Owner 要的「标绿 / 标黄」。
  const mine = detected || null

  // why = 「这是什么」+「和本机是否一致」两句，都是结论。
  // ⛔ 不追加「装之前请确认」：状态徽标（✓ / ! / ?）已经说明该怎么做了，
  //   再加一句叮嘱只是把同一个意思说两遍。
  const verdictFor = (kind, desc) => {
    if (!mine) return { kind, verdict: 'unknown', why: `${desc}（未检测本机）` }
    if (mine === kind) {
      return { kind, verdict: 'match', why: `${desc}，与本机推荐一致` }
    }
    return { kind, verdict: 'mismatch', why: `${desc}，本机推荐的是 ${mine}` }
  }

  // ---- 后缀自报（+cu121 / +rocm6.4 / +xpu…）----
  const explicit = s.match(/\+([a-z0-9.]+)/i)
  if (explicit) {
    const tag = explicit[1].toLowerCase()
    if (tag.startsWith('cu')) {
      return verdictFor('cuda', `CUDA 版（${tag}），需要 NVIDIA 驱动`)
    }
    if (tag.startsWith('rocm')) {
      return verdictFor('rocm', `ROCm 版（${tag}），需要 AMD 驱动`)
    }
    if (tag.startsWith('xpu') || tag.startsWith('ipex')) {
      return verdictFor('ipex', `Intel XPU 版（${tag}）`)
    }
    // ⛔ 不认识的后缀 ⇒ 如实说「不认识」，⛔ 不硬套
    return { kind: 'unknown', verdict: 'unknown',
      why: `后缀 +${tag} 无法识别，请自行确认。` }
  }

  // ---- 没有后缀 ⇒ ⚠⚠ **不能**直接当成CPU 版（2026-10-04 实测踩到）
  //   真实案例（某上游的 uv.lock，1.1MB）：
  //     torch==2.10.0         ← torch 本身没有 +cu 后缀
  //     nvidia-cudnn-cu12      ← 但同一份 lock 里锁着 CUDA 全套
  //     nvidia-cublas-cu12
  //     triton==3.6.0
  //   PyPI 上 `torch==2.10.0` 默认解析出来的是 **CUDA 版**，
  //   而那几个 NVIDIA 包就是它拖进来的依赖。
  //   ⇒ ⛔ 判据不能只看 torch 那一行有没有后缀，要看整份 lock 的旁证。
  if (/torch==[\d.]+$/.test(s.trim())) {
    const locked = ctx.lockedPackages || []
    const cudaDeps = locked.filter((n) => /^nvidia-|^triton$/.test(n))
    if (cudaDeps.length) {
      return verdictFor('cuda', 'CUDA 版，需要 NVIDIA 驱动')
    }
    const xpuDeps = locked.filter((n) => /^intel-|^xpu|^ipex/.test(n))
    if (xpuDeps.length) {
      return verdictFor('ipex', 'Intel XPU 版')
    }
    return { kind: 'cpu', verdict: 'match',
      why: 'CPU 版，任何机器均可安装，速度较慢。' }
  }

  // ⛔ 分不出来就说分不出来
  return { kind: 'unknown', verdict: 'unknown',
    why: '无法判断该包适用的后端，请自行确认。' }
}

/**
 * ⭐ 把 torch 系包从依赖清单里**摘出来**，其余归「普通依赖」。
 *
 * ⭐ 照 Owner 说的：只有 torch 及其依赖需要单独处理，其它直接同步就行。
 * ⛔ 判定用**包名**，⛔ 不看版本、不猜。
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
 * ⭐⭐ 解析 uv.lock 里**锁定**的 torch 系包。
 *
 * ⚠ 为什么非读 lock 不可（2026-10-04 实测踩到）：
 *   pyproject.toml 写的是 `torch>=2.5.0` —— **没有后缀、分不出后端**；
 *   真正锁死 wheel 的是 uv.lock 的 `version = "2.10.0"` + source。
 *   ⚠ 而且**锁的未必是 CUDA 版**：实测那份 lock 里 torch 是
 *     `2.10.0` + `registry = "https://pypi.org/simple"` = 通用/CPU 版，
 *     ⛔ 不是 `+cu121`。⇒ 「lock 是 CUDA 版」这个假设本身就不能信。
 *
 * ⛔⛔ 只做「行 → 值」，⛔ 不解析整个 lock 语法。
 * @param {string} text uv.lock 原文
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
    // ⭐ spec = lock 里那一条（带后缀的话就在 version 里）
    // ⭐ marker 一起带出：同一个包在 lock 里可能按平台分成多条
    //   （实测某台的 torch 同时有 PyPI 与 whl/cu128 两条），
    //   ⛔ 只取第一条会拿到不适用于本机的那条。
    const marker = (b.match(/marker\s*=\s*"([^"]*)"/) || [])[1] || null
    out.push({ name, version, source, marker, spec: `torch==${version}` })
  }
  return out
}

/**
 * 从 uv.lock 读出 torch 的**纯版本号**（剥掉 +cu128 / +xpu 这类后缀）。
 *
 * ⭐ 为什么需要它：lock 里写的是 `2.8.0+cu128`，而同一版本号在
 *   xpu / cpu / rocm 线上各有自己的 wheel（实测 torch-2.8.0+xpu-cp311-win_amd64
 *   与 torch-2.8.0+cu128-cp311-win_amd64 同时存在）。
 *   ⇒ lock 锁的是**版本号**，⛔ 不是后端。想换后端不必放弃锁文件。
 *
 * ⚠️⚠️ 同一个 torch 在 lock 里**可能有多条记录**，按 marker 分流。实测某台
 *   已装引擎的 uv.lock：
 *     version = "2.8.0"        source = PyPI        marker = 非 win32/linux
 *     version = "2.8.0+cu128"  source = whl/cu128   marker = win32 或 linux
 *   ⇒ ⛔ 取第一条会漏掉真正适用于本机的那条（它没有后缀 ⇒ 判成 cpu/null）。
 *   ✅ 规则：**带后缀的优先**；都带后缀时取与当前平台匹配的那条。
 *
 * @param {string} text uv.lock 全文
 * @param {string} [platform] process.platform，默认取当前平台
 * @returns {{version:string, plain:string, backend:string|null}|null}
 *   version = lock 里的原样版本（含后缀）· plain = 剥掉后缀
 *   backend = 从后缀/source 推出的后端 key（cuda/ipex/rocm/null）
 */
function readTorchPin (text, platform) {
  const plat = platform || process.platform
  const rows = parseUvLock(text)
  const cands = rows.filter((r) => r.name.toLowerCase() === 'torch' && r.version)
  if (!cands.length) return null

  const backendOf = (r) => {
    const v = String(r.version)
    if (/\+(?:cu|cuda)\d*/i.test(v) || /download\.pytorch\.org\/whl\/cu/i.test(r.source || '')) return 'cuda'
    if (/\+(?:xpu|ipex)/i.test(v) || /download\.pytorch\.org\/whl\/xpu/i.test(r.source || '')) return 'ipex'
    if (/\+rocm/i.test(v) || /rocm/i.test(r.source || '')) return 'rocm'
    return null
  }
  const isWinLinux = (r) => r.marker ? /win32|linux/.test(r.marker) : false
  const isOther = (r) => r.marker ? /darwin|win32\s*==\s*'false'/.test(r.marker) : false

  // 优先级：带后缀且 marker 匹配本机 > 带后缀 > 匹配本机 > 第一条
  let pick = cands.find((r) => backendOf(r) && isWinLinux(r) && plat !== 'darwin')
    || cands.find((r) => backendOf(r) && isWinLinux(r))
    || cands.find((r) => backendOf(r))
    || cands.find((r) => isWinLinux(r) && plat !== 'darwin')
    || cands.find((r) => isOther(r) && plat === 'darwin')
    || cands[0]

  const version = String(pick.version)
  return { version, plain: version.replace(/\+.*$/, ''), backend: backendOf(pick) }
}

module.exports = {
  parseUvLock, readTorchPin, clearHardwareCache,
  BACKEND_PREFERENCE, detectGpus, recommendBackend, inspectHardware,
  judgeTorchSpec, splitTorchPackages, TORCH_FAMILY,
}