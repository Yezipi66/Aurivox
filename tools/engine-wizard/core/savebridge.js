'use strict'
// ============================================================================
//  SAVE BRIDGE —— 把「填好了，存到盘上」这件事接起来
//
//  ⭐ 两件事：
//   GET  /wizard/installed  → 已装了哪些（覆盖前先看一眼）
//   POST /wizard/save        → 存盘
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

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
    json(res, 200, { engines: listInstalled() })
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
 * GET /wizard/manifest/<id> —— 读一张**已装**引擎的名片
 *
 * ⭐ 为什么平台自己没有这个端点
 *   查过了：lib/routes/engines.js 只提供列表（GET /api/engines），
 *   ⛔ 没有「按 id 取原始 manifest.json」的接口。
 *   而向导是独立工具，不往产品里塞代码 ⇒ 这里自己读盘。
 *
 * ⛔ 安全：⛔ 只读 engines/ 之内，且 id 必须先过 validateId
 *   （拦掉 ../escape 这类）—— 读盘也一样要防路径穿越。
 *
 * ⛔⛔ 必须用 req.url，不是 req.path。
 *    Vite 的 connect 给的 req.url 是带查询串的原文；req.path 有时是 undefined
 *    （实测 2026-10-03：500 "path argument must be of type string"）。
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