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
    json(res, 200, { engines: listInstalled({ all }) })
  } catch (e) {
    json(res, 500, { error: e.message })
  }
  return true
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
 * 平台没有按 id 取原始名片的端点（lib/routes/engines.js 只提供列表与启停），
 * 所以这里直接读盘。id 先过 validateId，再由 readManifestById 保证只读 engines/ 之内。
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

module.exports = { handleInstalled, handleSave, handleRead, validateId, path }