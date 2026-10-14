'use strict'

const path = require('node:path')
const { saveManifest, validateId, listInstalled } = require('./save')

function json (res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** GET /wizard/installed */
function handleInstalled (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/installed')) return false
  try {
    // ?all=1：列出 engines/ 下**所有**文件夹（含还没名片的），
    //   「新建名片」入口靠它列出第 1 步克隆来、还没写名片的引擎。
    //   默认仍只列有 manifest 的（不改老行为）。
    const all = /[?&]all=1/.test(req.url)
    json(res, 200, { engines: listInstalled({ all }) })
  } catch (e) {
    json(res, 500, { error: e.message })
  }
  return true
}

/** POST /wizard/save */
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
 * GET /wizard/manifest/<id>：读一张**已装**引擎的名片
 *
 * 平台无按 id 取原始 manifest 的端点（见 lib/routes/engines.js），故此处直接读盘。
 * 安全：只读 engines/ 之内，且 id 必须先过 validateId（拦掉 ../escape 这类）。
 *
 * 必须用 req.url，不是 req.path：Vite 的 connect 给的 req.url 是带查询串的原文，
 *   req.path 有时是 undefined（传下去会 500 "path argument must be of type string"）。
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

module.exports = { handleInstalled, handleSave, handleRead, validateId, path }