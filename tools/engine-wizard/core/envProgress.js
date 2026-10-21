'use strict'
//  ENV：进度持久化模块。
//  职责：断点续传产物检查（stepArtifactExists / sitePackagesNonEmpty）。
//  从 env.js 逐字搬来，不改逻辑。

const fs = require('node:fs')
const path = require('node:path')
const { engineVenvDirAbs, canUseEngineVenv } = require('./envDetect')

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
 */
function stepArtifactExists (step, root, id) {
  const venvDir = engineVenvDirAbs(root, id)
  if (step && step.skipIfExists) {
    return canUseEngineVenv(root, id)
  }
  const argv = (step && step.argv) || []
  const joined = argv.join(' ')
  if (/\b(uv|pip)\b/.test(joined) && /\b(install|sync)\b/.test(joined)) {
    return sitePackagesNonEmpty(venvDir)
  }
  return true
}

module.exports = {
  sitePackagesNonEmpty,
  stepArtifactExists,
}
