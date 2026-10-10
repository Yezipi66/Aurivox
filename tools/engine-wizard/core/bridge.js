'use strict'
// ============================================================================
//  VALIDATE BRIDGE —— 把校验层暴露成一个本地 HTTP 接口
//
//  ⭐ 为什么要它
//  校验逻辑在 tools/engine-wizard/core/validate.js（Node, CommonJS），
//  而预览页在浏览器里 —— 浏览器 require 不了它。
//  ⇒ 这一层把「一份名片 JSON」变成「一串诊断」，喂给页面做实时红框。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。它只转发给校验层。
//
//  ⛔ 为什么不是平台的 server.js
//  向导是独立工具，不该往产品里塞代码。
//  平台那条边（/api/engines 等）仍然 proxy 到 9886，两条路各管各的。
// ============================================================================

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

  // ⭐ validate.js 与本文件同在 core/ 目录，用 __dirname 直接定位。
  //   ⛔ 不能指望调用方传 coreDir —— vite 中间件是 h(req, res) 两参调用，
  //   第三个参数从来传不进来（曾因此抛 path.join(undefined,…) 的 500）。
  //   ⇒ 自定位最稳，不依赖任何外部注入。
  const { diagnose, summarize } = require(path.join(__dirname, 'validate.js'))

  let body = ''
  let tooBig = false
  req.on('data', (c) => {
    body += c
    // ⛔ 名片不该有几 MB。上限是为了不让一个手滑粘贴卡死 dev server。
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
      // ⛔ 解析失败**如实说**，不装作校验通过
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
      // ⛔ 校验层自己崩了，如实报，不返回「通过」
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: e.message, stack: (e.stack || '').slice(0, 800) }))
    }
  })
  return true
}

module.exports = { handleValidate }