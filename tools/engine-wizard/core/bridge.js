'use strict'
//  VALIDATE BRIDGE：把校验层暴露成一个本地 HTTP 接口

const http = require('node:http')
const path = require('node:path')

/**
 * 处理一次校验请求。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>}  true = 这次请求已被处理
 */
function handleValidate (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/validate')) return false

  // validate.js 与本文件同在 core/ 目录，用 __dirname 直接定位。
  const { diagnose, summarize } = require(path.join(__dirname, 'validate.js'))

  let body = ''
  let tooBig = false
  req.on('data', (c) => {
    body += c
    // 名片不该有几 MB。上限是为了不让一个手滑粘贴卡死 dev server。
    if (body.length > 4 * 1024 * 1024) { tooBig = true; req.destroy() }
  })
  req.on('end', () => {
    if (tooBig) {
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Manifest too large (>4MB) — this does not look like a manifest' }))
      return
    }
    let manifest
    try {
      manifest = JSON.parse(body)
    } catch (e) {

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        parse_error: e.message,
        diagnostics: [],
        summary: { ok: false, errors: 1, warns: 0, infos: 0,
          headline: 'JSON 解析失败' },
      }))
      return
    }
    try {
      const diagnostics = diagnose(manifest)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ diagnostics, summary: summarize(diagnostics) }))
    } catch (e) {
      // 校验层自己崩了，如实报，不返回「通过」
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: e.message, stack: (e.stack || '').slice(0, 800) }))
    }
  })
  return true
}

module.exports = { handleValidate }