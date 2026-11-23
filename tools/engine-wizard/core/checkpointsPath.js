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
const { fromV011 } = require('../../../lib/engines/contract')

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
  // v0.1.1 磁盘是三节；投影成扁平视图再取 checkpoints（幂等，扁平输入原样返回）。
  const flat = fromV011(manifest)
  const declared = flat && flat.runtime && flat.runtime.checkpoints
  if (typeof declared === 'string') {
    const rel = declared.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    if (rel && !path.isAbsolute(rel) && !rel.split('/').includes('..')) return rel
  }
  return checkpointsRelPath(engineId)
}

const fs = require('node:fs')

/** 归一成平台分隔符的引擎内相对路径；非法（空/绝对/含 . 或 ..）返回 null。 */
function safeEngineRel (value) {
  const s = String(value == null ? '' : value).trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!s || path.isAbsolute(s)) return null
  const parts = s.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  return parts.join('/')
}

/**
 * 第 3 步的存放位置快照：engines/<id>/wizard.json 的 downloadDir。
 * 两种记法，读取时统一还原成「引擎内相对」：
 *   手动改（界面）→ 记全局（项目根相对 engines/<id>/checkpoints）
 *   自动（下载开始/结束写盘）→ 记相对（checkpoints）
 * 坏文件 / 非法值一律视为未设置（返回 null），不抛错。
 */
function readDownloadSnapshot (root, engineId) {
  if (!checkpointsRelPath(engineId)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'engines', engineId, 'wizard.json'), 'utf8'))
    const prefix = `engines/${engineId}/`
    const v = raw && raw.downloadDir
    const rel = typeof v === 'string' && v.startsWith(prefix) ? v.slice(prefix.length) : v
    return safeEngineRel(rel)
  } catch {
    return null
  }
}

/** 把项目根相对的名片路径转成引擎内相对；不在 engines/<id>/ 下就原样返回。 */
function toEngineRel (value, engineId) {
  const s = String(value == null ? '' : value).trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const prefix = `engines/${engineId}/`
  return s.startsWith(prefix) ? s.slice(prefix.length) : s
}

/**
 * 权重目录（**项目根相对**，与名片同语义）。一条链，唯一答案：
 *   名片 registration.runtime.checkpoints（第 4 步声明，最权威）
 *   → 第 3 步快照 wizard.json.downloadDir（引擎内相对，拼回 engines/<id>/）
 *   → 默认 engines/<id>/checkpoints
 * 顺序无关：先 4 后 3、下载中切换、跳过第 3 步都收敛到同一个值。
 * 路径一律不接受绝对路径与 ..：名片是外部输入，不能指到项目外。
 */
function weightsDirFor (root, engineId, manifest) {
  const flat = fromV011(manifest)
  const declared = flat && flat.runtime && flat.runtime.checkpoints
  if (typeof declared === 'string') {
    const rel = declared.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    if (rel && !path.isAbsolute(rel) && !rel.split('/').includes('..')) return rel
  }
  const snap = readDownloadSnapshot(root, engineId)
  if (snap) return `engines/${engineId}/${snap}`
  return `engines/${engineId}/checkpoints`
}

module.exports = { checkpointsRelPath, checkpointsAbsPath, resolveCheckpointsRel, weightsDirFor, readDownloadSnapshot, safeEngineRel, toEngineRel }
