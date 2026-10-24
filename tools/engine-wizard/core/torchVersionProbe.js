'use strict'

// Torch 版本与本机后端的匹配判断。
//
// 问题形状：上游把 torch 钉在某个版本（比如 2.5.1），而那个版本在本机推荐后端
//   上**不可能**用上 ⇒ 装依赖必然失败，报错是 uv 的
//   「No solution found when resolving dependencies」。
//
// 关键：这个判断**不需要联网**。
//   XPU、ROCm 这类加速后端对 torch 版本有明确的下界
//   （XPU 的官方二进制轮子从 2.6.0 起才有），方向是单向的：
//   后端只往更高的版本扩，不回头兼容更老的。
//   所以「这个版本在这个后端上有没有」是确定的事实，查表比大小即可。
//   事实表在 backendTorchSupport.js。
//
// 判据只读两样东西，不猜：
//   ① 上游声明的 torch 版本（requirements / pyproject / lock 里读出来的事实）；
//   ② 该后端与该 Python ABI 的版本下界（表里的事实）。
// 两者不一致 ⇒ 如实报出「上游钉的版本在本机后端上不可用」与「可用的最低版本是什么」，
//   由使用者决定升不升级。平台不替使用者改上游钉的版本。

const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const {
  minTorchFor, cmpVersion, platformFamily, BACKEND_INDEX,
} = require('./backendTorchSupport')

// PyTorch 官方 index 的地址形态：https://download.pytorch.org/whl/<后端>
const INDEX_ROOT = 'https://download.pytorch.org/whl/'

// 只有这些后端有官方 wheel index。没有 index 的后端（ZLUDA / DirectML）
//   不做版本判断：平台上没有可比对的版本清单。
const BACKENDS_WITH_INDEX = BACKEND_INDEX

// Python 主次版本 → wheel 文件名里的 ABI tag
function abiTag (version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)/)
  return m ? `cp${m[1]}${m[2]}` : null
}

/**
 * 读上游声明的 torch 版本。
 *
 * 来源按可靠性排：uv.lock（锁死的那个版本）→ requirements.txt / pyproject.toml
 * 里的 torch==那一行。没有就返回 null：平台不猜版本。
 *
 * @returns {{version:string, source:string}|null}
 */
function readDeclaredTorchVersion (dir) {
  // 来源一：uv.lock。锁文件写的是确切版本，是最准的。
  try {
    const text = fs.readFileSync(path.join(dir, 'uv.lock'), 'utf8')
    const blocks = text.split(/\[\[package\]\]/).slice(1)
    for (const b of blocks) {
      const name = (b.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1]
      if (!name || name.toLowerCase() !== 'torch') continue
      const version = (b.match(/^\s*version\s*=\s*"([^"]+)"/m) || [])[1]
      if (version) {
        return { version: version.replace(/^\s*|\s*$/g, ''), source: 'uv.lock' }
      }
    }
  } catch (e) { /* 没有 lock 就往下看 */ }

  // 来源二：requirements.txt 里的 torch==X / torch==X+后缀。
  try {
    const text = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim()
      const m = line.match(/^torch\s*==\s*([^\s;]+)/i)
      if (m) return { version: m[1], source: 'requirements.txt' }
    }
  } catch (e) { /* 没有 requirements 就往下看 */ }

  // 来源三：pyproject.toml 的 dependencies 里的 torch==X。
  try {
    const text = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8')
    const m = text.match(/["']torch\s*==\s*([^\s"']+)["']/)
    if (m) return { version: m[1], source: 'pyproject.toml' }
  } catch (e) { /* 都没有就是没声明 */ }

  return null
}

/**
 * 从 index 的 HTML 清单里读出「哪些 torch 版本覆盖哪些 ABI tag」。
 *
 * index 页面是普通的 <a href> 清单，每个 wheel 一个链接，文件名形如
 *   torch-2.6.0+xpu-cp311-cp311-win_amd64.whl
 * 只认文件名里的三段：版本号、ABI tag、平台标签。不下载 wheel。
 *
 * @param {string} html index 页面正文
 * @param {string} abi 形如 cp311
 * @param {string} platformTag 形如 win_amd64 / manylinux_2_28_x86_64 / macosx_*
 * @returns {{versions:string[], tags:string[]}} versions 是可用版本（升序），tags 是这批轮子覆盖的 ABI
 */
function parseTorchIndex (html, abi, platformTag) {
  const versions = new Set()
  const tags = new Set()
  if (typeof html !== 'string' || !html) return { versions: [], tags: [] }
  // wheel 文件名：torch-<版本>[+后缀]-<abi>-<abi2>-<平台>.whl
  //   后缀分隔符在 index 页面上有两种写法：链接文本里是字面 `+`，
  //   href 属性里是 URL 编码的 `%2B`。两种都要认，
  //   否则哪天页面只留一种，探测会静默地认为「没有可用版本」。
  const re = /torch-([\d.]+)(?:\+|%2B)([A-Za-z0-9.]+)-(cp\d+)-cp\d+-([A-Za-z0-9_.]+)\.whl/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const [, ver, , tag, plat] = m
    tags.add(tag)
    if (tag === abi && plat === platformTag) versions.add(ver)
  }
  const list = [...versions].sort((a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
    }
    return 0
  })
  return { versions: list, tags: [...tags].sort() }
}

/**
 * 当前平台的 wheel 平台标签。判据是本平台能用的那一种。
 */
function wheelPlatformTag (platform, arch) {
  if (platform === 'win32') return 'win_amd64'
  if (platform === 'linux') {
    // linux 的 wheel 标签带 glibc 版本：取最高那一个（manylinux_2_28 表示 glibc 2.28+）
    return 'manylinux_2_28_x86_64'
  }
  if (platform === 'darwin') return 'macosx_11_0_arm64'
  return null
}

/**
 * 抓一个 index 页面的正文。失败返回 null（调用方按「查不到」处理）。
 */
function fetchIndexHtml (indexUrl, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let req
    try {
      req = https.get(indexUrl, { timeout: timeoutMs || 15000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); finish(null); return }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => { body += d })
        res.on('end', () => finish(body))
      })
    } catch (e) { finish(null); return }
    req.on('timeout', () => { try { req.destroy() } catch (e) { /* 已关 */ }; finish(null) })
    req.on('error', () => finish(null))
  })
}

/**
 * 同步判「上游钉的 torch 版本在本机后端上能不能用」。
 *
 * 判据是**离线查表比大小**（backendTorchSupport.js）：
 *   这个 (官方 index, 平台族, Python ABI) 组合从哪个 torch 版本起才有轮子。
 *   上游声明的版本低于那个下界 ⇒ 一定装不上，且**永远不会**装得上
 *   （后端只往更高的版本扩，不回头兼容更老的）。
 *
 * 所以「这个版本有没有」是确定的事实，不需要联网去查。
 *
 * @param {object} opts
 *   dir 引擎目录（读上游声明）
 *   backend 本机推荐的后端 key（cuda / ipex / rocm / cpu）
 *   pythonVersion 引擎环境用的 Python 版本（形如 '3.11'）
 *   platform 目标平台，默认当前平台
 * @returns {object|null} null 表示「没有需要提示的情况」
 */
function judgeTorchVersion (opts = {}) {
  const backend = opts.backend
  const indexKey = BACKENDS_WITH_INDEX[backend]
  if (!indexKey) return null
  const declared = readDeclaredTorchVersion(opts.dir)
  if (!declared) return null
  const abi = abiTag(opts.pythonVersion)
  if (!abi) return null
  const family = platformFamily(opts.platform || process.platform)
  if (!family) return null

  // 声明带后缀（2.5.1+cu128）时按纯版本号比：后端由使用者选的决定，
  //   不由文件名后缀决定。
  const declaredPlain = declared.version.replace(/\+.*$/, '')

  // ---- 离线判据 ----
  const minVersion = minTorchFor(backend, abi, family)
  if (!minVersion) {
    // 这个后端 + 平台 + ABI 的组合没有官方轮子（表里查不到）。
    //   如实报出来，但不编建议版本。
    return {
      ok: false,
      backend,
      index: `${INDEX_ROOT}${indexKey}/torch/`,
      pythonVersion: opts.pythonVersion,
      abi,
      platformFamily: family,
      declared: declared.version,
      declaredSource: declared.source,
      available: [],
      reason: 'no-wheel-for-this-python',
    }
  }
  if (cmpVersion(declaredPlain, minVersion) >= 0) {
    // 上游钉的版本在这个后端上装得上 ⇒ 不需要提示。
    //   （下界是充分条件：高于下界的版本官方一定发过轮子。）
    return null
  }

  // ---- 低于下界 ⇒ 不兼容，给出建议版本 = 下界 ----
  return {
    ok: false,
    backend,
    index: `${INDEX_ROOT}${indexKey}/torch/`,
    pythonVersion: opts.pythonVersion,
    abi,
    platformFamily: family,
    declared: declared.version,
    declaredSource: declared.source,
    minVersion,
    available: [],
    // 建议版本就是下界本身：那是该组合上第一个有官方轮子的版本。
    suggested: minVersion,
    reason: 'version-not-on-this-backend',
  }
}

/**
 * 判「上游钉的 torch 版本在本机后端上能不能用」，并补充该后端上可用的版本列表。
 *
 * 判断部分在 judgeTorchVersion 里，纯查表、不联网。
 * 这里额外联网只为补充「这个后端上还有哪些版本可用」这份信息，
 *   失败不影响判断（判断已经成立），只是少了一份补充信息。
 *
 * @param {object} opts
 *   dir 引擎目录（读上游声明）
 *   backend 本机推荐的后端 key（cuda / ipex / rocm / cpu）
 *   pythonVersion 引擎环境用的 Python 版本（形如 '3.11'）
 *   platform 目标平台，默认当前平台
 *   arch 目标架构，默认当前架构
 *   timeoutMs 单次抓取超时
 *   offline true ⇒ 完全不联网（只给判断与建议版本）
 * @returns {Promise<object|null>} null 表示「没有需要提示的情况」
 */
async function probeTorchVersion (opts = {}) {
  const result = judgeTorchVersion(opts)
  if (!result || result.ok) return result
  if (opts.offline) return result
  const plat = wheelPlatformTag(opts.platform || process.platform, opts.arch || process.arch)
  if (!plat) return result
  try {
    const html = await fetchIndexHtml(result.index, opts.timeoutMs)
    if (html) {
      const parsed = parseTorchIndex(html, result.abi, plat)
      result.available = parsed.versions
      result.availableTags = parsed.tags
    }
  } catch (e) { /* 抓不到就只留判据 */ }
  return result
}

module.exports = {
  probeTorchVersion,
  judgeTorchVersion,
  readDeclaredTorchVersion,
  parseTorchIndex,
  abiTag,
  wheelPlatformTag,
  cmpVersion,
  BACKENDS_WITH_INDEX,
  INDEX_ROOT,
}
