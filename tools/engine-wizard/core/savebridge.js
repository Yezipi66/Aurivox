'use strict'
// 向导的名片读写接口：列出已装引擎、写入名片、按 id 读回一张名片。
// 三个 handler 都是 Vite 中间件：URL 匹配就接管并返回 true，不匹配返回 false 让下一个 handler 接。
// 落盘与校验由 save.js 负责，本文件只做 HTTP 这一层。

const path = require('node:path')
const { saveManifest, validateId, listInstalled } = require('./save')

function json (res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * GET /wizard/installed：列出已装引擎。URL 与方法都匹配才返回 true。
 */
function handleInstalled (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/installed')) return false
  try {
    // ?all=1 时列出 engines/ 下的全部目录（含还没写名片的），
    // 「新建名片」入口靠它列出第 1 步克隆来、还没写名片的引擎。
    // 不带这个参数时只列有 manifest.json 的那些。
    const all = /[?&]all=1/.test(req.url)
    json(res, 200, { engines: withUsable(listInstalled({ all })) })
  } catch (e) {
    json(res, 500, { error: e.message })
  }
  return true
}

// 「能用」打绿勾的判据：用平台已有的两段，不发明新的。
//   ① 平台认可：有有效 manifest.json（id 与目录名一致），registry 就靠这个认引擎；
//   ② 权重就绪：checkpointStatus(profile).ready === true（纯 fs 检查，不 spawn、不联网）。
//   环境不放进判据：GSV 这类平台底座引擎按名片声明查 .venv 会判 false（它走平台基座），
//   而它实际能用；拿 env 当门会把真实能用的引擎标成不能用。
//   只有「有有效名片」的引擎才 resolveEngineProfile 得出来；名片坏 / 没名片的直接 false。
// deps 仅供测试注入 fake 的平台模块（单测不能依赖真实引擎的权重状态）。
function withUsable (engines, deps = {}) {
  let profileModule = deps.profile || null
  let checkpointsModule = deps.checkpoints || null
  if (!profileModule || !checkpointsModule) {
    try {
      profileModule = require('../../../lib/engines/profile')
      checkpointsModule = require('../../../lib/engines/checkpoints')
    } catch (e) { /* 平台引擎层取不到 ⇒ 全都判不可用，不假装知道 */ }
  }
  return (engines || []).map((e) => {
    let usable = false
    if (profileModule && checkpointsModule && e.manifestPresent && e.idMatchesDir) {
      try {
        const p = profileModule.resolveEngineProfile(e.id)
        usable = checkpointsModule.checkpointStatus(p).ready === true
      } catch (err) { /* 名片坏 / 解析失败 ⇒ 不可用 */ }
    }
    return { ...e, usable }
  })
}

/**
 * POST /wizard/save：写入一张名片。URL 与方法都匹配才返回 true。
 */
function handleSave (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/save')) return false

  let body = ''
  let tooBig = false
  req.on('data', (c) => {
    body += c
    if (body.length > 2 * 1024 * 1024) { tooBig = true; req.destroy() }
  })
  req.on('end', () => {
    if (tooBig) {
      json(res, 413, { ok: false, code: 'TOO_LARGE',
        error: 'manifest exceeds 2MB — that is not a manifest' })
      return
    }
    let payload
    try {
      payload = JSON.parse(body)
    } catch (e) {
      json(res, 400, { ok: false, code: 'BAD_JSON', error: e.message })
      return
    }
    const manifest = payload && payload.manifest
    const opts = {
      overwrite: payload && payload.overwrite === true,
      dryRun: payload && payload.dryRun === true,
      allowCreateDir: !(payload && payload.allowCreateDir === false),
    }
    try {
      const r = saveManifest(manifest, opts)
      json(res, r.ok ? 200 : (r.code === 'EXISTS' ? 409 : 400), r)
    } catch (e) {
      json(res, 500, { ok: false, code: 'SAVE_FAILED', error: e.message })
    }
  })
  return true
}

/**
 * GET /wizard/manifest/<id>：读回一张已装引擎的名片。
 *
 * 原始名片直接读盘，不经过管理层。id 先过 validateId，
 * 再由 readManifestById 保证只读 engines/ 之内。
 *
 * 必须用 req.url 而不是 req.path：Vite 的 connect 给的 req.url 是带查询串的原文，
 * req.path 有时是 undefined（传下去会 500 "path argument must be of type string"）。
 * URL 与方法都匹配才返回 true。
 */
function handleRead (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/manifest/')) return false

  const { readManifestById } = require('./save')

  const raw = req.url.slice('/wizard/manifest/'.length).split('?')[0]
  let id
  try { id = decodeURIComponent(raw) } catch { id = raw }
  const r = readManifestById(id)
  if (!r.ok) { json(res, r.code === 'BAD_ID' ? 400 : 404, r); return true }
  json(res, 200, { ok: true, id, manifest: r.manifest, path: r.path })
  return true
}

module.exports = { handleInstalled, handleSave, handleRead, validateId, path, withUsable }