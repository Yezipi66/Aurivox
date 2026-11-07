'use strict'

// 向导第 3 步的权重落盘路径：唯一的一处答案。
//
// 为什么单独一个文件：落盘路径同时出现在三个地方（下载时写盘（第 3 步）、
// 判断权重在不在（installState）、名片里声明权重在哪（第 4 步 runtime.checkpoints））。
// 三处各写一遍字符串，改一处漏两处就会出现「第 3 步说下好了、第 5 步说目录不存在」。
// 所以路径只在这里算一次，其余各处来问。
//
// 路径是相对项目根的：平台契约要求名片的路径相对项目根（禁绝对路径），
// 名片里填的就是这个相对路径，不用再拼项目根。

const path = require('node:path')

/** 权重目录的相对路径（相对项目根），如 engines/index-tts/checkpoints。 */
function checkpointsRelPath (engineId) {
  const id = String(engineId == null ? '' : engineId).trim()
  if (!id) return null
  // 引擎 id 是目录名，不许带路径分隔符：拼出来的路径必须仍落在 engines/<id>/ 里。
  if (id.includes('/') || id.includes('\\')) return null
  if (id === '.' || id === '..') return null
  return `engines/${id}/checkpoints`
}

/** 权重目录的绝对路径：由传入的项目根与引擎 id 拼出。 */
function checkpointsAbsPath (root, engineId) {
  const rel = checkpointsRelPath(engineId)
  if (!rel) return null
  return path.join(root, rel)
}

/**
 * 权重落点的相对路径：名片写了就以名片为准，没写才用统一落点。
 *
 * 名片是唯一权威。旧名片可能把权重放在 models/tts/<id>，
 * 按统一落点判得到「目录不存在」，而第 5 步按名片判得到「齐了」，
 * 同一个事实两套结论。这里让两处都来问名片。
 *
 * 平台契约要求相对项目根，所以绝对路径与带 .. 的路径一律不认，回退统一落点。
 */
function resolveCheckpointsRel (manifest, engineId) {
  const declared = manifest && manifest.runtime && manifest.runtime.checkpoints
  if (typeof declared === 'string') {
    const rel = declared.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    if (rel && !path.isAbsolute(rel) && !rel.split('/').includes('..')) return rel
  }
  return checkpointsRelPath(engineId)
}

module.exports = { checkpointsRelPath, checkpointsAbsPath, resolveCheckpointsRel }
