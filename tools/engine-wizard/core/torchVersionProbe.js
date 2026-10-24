'use strict'

// Torch 版本与本机后端的匹配探测。
//
// 问题形状：上游把 torch 钉在某个版本（比如 2.5.1），而那个版本在本机推荐后端
//   的官方 index 上没有匹配本机 Python ABI 的轮子 ⇒ 装依赖必然失败，
//   报错是 uv 的「No solution found when resolving dependencies」。
//   典型场景：XPU 与 ROCm 的轮子起步比 CPU/CUDA 晚，torch 2.5.1 在 xpu 上不存在。
//
// 判据只读两样东西，不猜：
//   ① 上游声明的 torch 版本（requirements / pyproject / lock 里读出来的事实）；
//   ② 本机推荐后端的官方 index 上有哪些版本、覆盖哪些 Python ABI。
// 两者不一致 ⇒ 如实报出「上游钉的版本在本机后端上不可用」与「可用的最低版本是什么」，
//   由使用者决定升不升级。平台不替使用者改上游钉的版本。

const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')

// PyTorch 官方 index 的地址形态：https://download.pytorch.org/whl/<后端>
const INDEX_ROOT = 'https://download.pytorch.org/whl/'

// 只有这些后端有官方 wheel index。没有 index 的后端（ZLUDA / DirectML）
//   不做版本探测：平台上没有可比对的版本清单。
const BACKENDS_WITH_INDEX = {
  cuda: 'cu121',
  ipex: 'xpu',
  rocm: 'rocm6.4',
  cpu: 'cpu',
}

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
 * 探测「上游钉的 torch 版本在本机后端上能不能用」。
 *
 * @param {object} opts
 *   dir 引擎目录（读上游声明）
 *   backend 本机推荐的后端 key（cuda / ipex / rocm / cpu）
 *   pythonVersion 引擎环境用的 Python 版本（形如 '3.11'）
 *   platform 目标平台，默认当前平台
 *   arch 目标架构，默认当前架构
 *   timeoutMs 单次抓取超时
 * @returns {Promise<object|null>} null 表示查不出来（没有声明 / 没 index / 抓不到）
 */
async function probeTorchVersion (opts = {}) {
  const backend = opts.backend
  const indexKey = BACKENDS_WITH_INDEX[backend]
  if (!indexKey) return null
  const declared = readDeclaredTorchVersion(opts.dir)
  if (!declared) return null
  const abi = abiTag(opts.pythonVersion)
  if (!abi) return null
  const plat = wheelPlatformTag(opts.platform || process.platform, opts.arch || process.arch)
  if (!plat) return null

  const url = `${INDEX_ROOT}${indexKey}/torch/`
  const html = await fetchIndexHtml(url, opts.timeoutMs)
  if (!html) return null
  const parsed = parseTorchIndex(html, abi, plat)
  if (!parsed.versions.length) {
    // 索引抓到了，但没有匹配这个 ABI 与平台的轮子。
    //   这个结论本身就是「上游钉的版本装不上」：整个 index 在这个 Python 上
    //   一个轮子都没有，上游声明的版本必然不在其中。
    //   要给建议就得从「这个 index 上有哪些版本」里挑一个能配这个 ABI 的，
    //   而那要求换 ABI 或换 Python 版本，不是换 torch 版本能解决的。
    //   所以这里不给 suggested，只如实报出「一个轮子都没有」。
    return {
      ok: false,
      backend,
      index: url,
      pythonVersion: opts.pythonVersion,
      abi,
      platformTag: plat,
      declared: declared.version,
      declaredSource: declared.source,
      available: [],
      availableTags: parsed.tags,
      reason: 'no-wheel-for-this-python',
    }
  }

  // 上游钉的版本是不是在可用列表里？
  //   声明带后缀（2.5.1+cu128）时按纯版本号比：后端由 index 决定，不由文件名后缀决定。
  const declaredPlain = declared.version.replace(/\+.*$/, '')
  const usable = parsed.versions.includes(declaredPlain)
  const result = {
    ok: usable,
    backend,
    index: url,
    pythonVersion: opts.pythonVersion,
    abi,
    platformTag: plat,
    declared: declared.version,
    declaredSource: declared.source,
    available: parsed.versions,
    availableTags: parsed.tags,
  }
  if (!usable) {
    // 建议版本 = 可用列表里第一个不低于上游钉的版本。
    //   没有更高的就取最高的那个（上游钉的比所有可用版本都新）。
    const higher = parsed.versions.filter((v) => cmpVersion(v, declaredPlain) >= 0)
    result.suggested = higher.length ? higher[0] : parsed.versions[parsed.versions.length - 1]
    result.reason = 'version-not-on-this-backend'
  }
  return result
}

function cmpVersion (a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

module.exports = {
  probeTorchVersion,
  readDeclaredTorchVersion,
  parseTorchIndex,
  abiTag,
  wheelPlatformTag,
  cmpVersion,
  BACKENDS_WITH_INDEX,
  INDEX_ROOT,
}
