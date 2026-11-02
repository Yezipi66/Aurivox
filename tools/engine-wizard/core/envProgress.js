'use strict'
//  ENV：进度持久化模块。
//  职责：断点续传产物检查（stepArtifactExists / sitePackagesNonEmpty）。

const fs = require('node:fs')
const path = require('node:path')
const { engineVenvDirAbs, canUseEngineVenv } = require('./envDetect')

/**
 * 引擎 venv 的 site-packages 目录。
 * @returns {string|null} 目录路径；找不着 ⇒ null
 */
function sitePackagesDir (venvDir) {
  const candidates = []
  if (process.platform === 'win32') {
    candidates.push(path.join(venvDir, 'Lib', 'site-packages'))
  } else {
    const libDir = path.join(venvDir, 'lib')
    let entries = []
    try { entries = fs.readdirSync(libDir, { withFileTypes: true }) } catch (e) { return null }
    for (const e of entries) {
      if (e.isDirectory() && /^python3\./.test(e.name)) {
        candidates.push(path.join(libDir, e.name, 'site-packages'))
      }
    }
  }
  for (const sp of candidates) {
    try {
      fs.readdirSync(sp)
      return sp
    } catch (e) { /* 下一个 */ }
  }
  return null
}

/**
 * 引擎 venv 里某个包当前装的是哪个版本。
 *
 * 读法：site-packages 下 `<包名>-<版本>[+后缀].dist-info` 的目录名。
 * 不 spawn python 去问，那要起进程，慢且可能失败。
 * dist-info 目录名带后缀（`torch-2.6.0+xpu`），后缀是后端标记，
 *   要与命令里那个 index 对得上才算装的是这一版。
 *
 * @param {string} venvDir 引擎 venv 目录
 * @param {string} pkgName 包名（torch 这种）
 * @returns {string|null} 版本串（含 +后缀）；没装 ⇒ null
 */
function installedPackageVersion (venvDir, pkgName) {
  const sp = sitePackagesDir(venvDir)
  if (!sp) return null
  let entries = []
  try { entries = fs.readdirSync(sp) } catch (e) { return null }
  const prefix = pkgName.toLowerCase() + '-'
  for (const it of entries) {
    if (!it.toLowerCase().startsWith(prefix)) continue
    if (!it.toLowerCase().endsWith('.dist-info')) continue
    return it.slice(prefix.length, -'.dist-info'.length)
  }
  return null
}

/**
 * 一条安装命令里声明了哪些包的哪个版本。
 *
 * 只认形如 `<包名>==<版本>` 的实参（uv pip install 的写法）。
 * `-r requirements.txt` 那种清单形式解析不出逐个版本 ⇒ 返回空数组，
 *   调用方据此知道「这步没法按版本核对」。
 *
 * @param {string[]} argv 命令参数
 * @returns {{name:string, version:string}[]} 声明的包与版本
 */
function parseDeclaredSpecs (argv) {
  const out = []
  for (const a of argv || []) {
    const m = String(a).match(/^([A-Za-z0-9_.-]+)==([^\s]+)$/)
    if (m) out.push({ name: m[1], version: m[2] })
  }
  return out
}

/**
 * 一条安装命令用的是哪个官方 index。
 * @param {string[]} argv 命令参数
 * @returns {string|null} index 目录名（xpu / cu121 / cpu 那种）；没有 ⇒ null
 */
function parseIndexName (argv) {
  for (let i = 0; i < (argv || []).length; i++) {
    const a = String(argv[i])
    if (a === '--index-url' || a === '-i') {
      const v = String(argv[i + 1] || '')
      const m = v.match(/\/whl\/([^/]+)\/?$/)
      return m ? m[1] : null
    }
    if (a.startsWith('--index-url=')) {
      const m = a.match(/\/whl\/([^/]+)\/?$/)
      return m ? m[1] : null
    }
  }
  return null
}

/**
 * 已装版本与命令要装的版本是否一致。
 *
 * 后缀必须一起比：`torch==2.6.0` 从 xpu index 装出来是 `2.6.0+xpu`，
 *   从 cpu index 装出来是 `2.6.0+cpu` ⇒ 版本号相同但后端不同，
 *   那是另一个产物（XPU 机器上装了 CPU 版 ⇒ 用不上加速）。
 *   命令没带 index 时不比对后缀（装什么后端由 pip 当时选的源决定）。
 *
 * @param {string} installed 已装版本串（可能带 +后缀）
 * @param {string} wanted 命令声明的版本串
 * @param {string|null} indexName 命令里的官方 index 目录名
 * @returns {boolean} 一致 ⇒ true
 */
function versionMatches (installed, wanted, indexName) {
  if (!installed || !wanted) return false
  const base = (s) => String(s).split('+')[0]
  if (base(installed) !== base(wanted)) return false
  if (!indexName) return true
  // index 目录名（xpu / cu121 / cpu）⇒ 期望的后缀标记。
  const expectSuffix = indexName === 'cu121' ? 'cu121' : indexName
  const gotSuffix = String(installed).includes('+')
    ? String(installed).split('+')[1].toLowerCase()
    : ''
  // 有些 index 的后缀比目录名更细（cu121 的轮子后缀是 cu121，cu128 是 cu128）。
  //   目录名与后缀不完全一致时，只在「后缀确实带这个标记」时才算匹配。
  return gotSuffix.includes(expectSuffix.toLowerCase())
}

/**
 * 装包那步的产物：目标 site-packages 非空。
 */
function sitePackagesNonEmpty (venvDir) {
  const candidates = []
  if (process.platform === 'win32') {
    candidates.push(path.join(venvDir, 'Lib', 'site-packages'))
  } else {
    const libDir = path.join(venvDir, 'lib')
    let entries = []
    try { entries = fs.readdirSync(libDir, { withFileTypes: true }) } catch (e) { return false }
    for (const e of entries) {
      if (e.isDirectory() && /^python3\./.test(e.name)) {
        candidates.push(path.join(libDir, e.name, 'site-packages'))
      }
    }
  }
  for (const sp of candidates) {
    try {
      const items = fs.readdirSync(sp)
      if (items.length > 0) return true
    } catch (e) { /* 下一个 */ }
  }
  return false
}

/**
 * 某一步的产物是否还在。
 *
 * 三层判据（缺一层就会静默跳过）：
 *   ① 建环境步：引擎 venv 的 python 能 spawn（`canUseEngineVenv`）。
 *   ② 装包步：目标 site-packages 非空。
 *   ③ 版本核对：这步命令里声明了 `<包>==<版本>` 时，
 *      引擎 venv 里那个包当前装的就是那一版（后端后缀也要对）。
 *      这一层不能省：产物在、但已经不是命令要装的那一版时
 *      （例如手工把 torch 降回上游钉的版本），命令文本一字未变 ⇒
 *      只看命令文本会判「已完成」而跳过 ⇒ 装出来的环境是错的，
 *      而界面报「完成」。
 */
function stepArtifactExists (step, root, id) {
  const venvDir = engineVenvDirAbs(root, id)
  if (step && step.skipIfExists) {
    return canUseEngineVenv(root, id)
  }
  const argv = (step && step.argv) || []
  const joined = argv.join(' ')
  if (!/\b(uv|pip)\b/.test(joined) || !/\b(install|sync)\b/.test(joined)) {
    return true
  }
  if (!sitePackagesNonEmpty(venvDir)) return false

  // 版本核对：命令里声明了逐个版本时，逐个对。
  const specs = parseDeclaredSpecs(argv)
  if (!specs.length) return true
  const indexName = parseIndexName(argv)
  for (const spec of specs) {
    const installed = installedPackageVersion(venvDir, spec.name)
    if (!versionMatches(installed, spec.version, indexName)) return false
  }
  return true
}

module.exports = {
  sitePackagesNonEmpty,
  sitePackagesDir,
  installedPackageVersion,
  parseDeclaredSpecs,
  parseIndexName,
  versionMatches,
  stepArtifactExists,
}
