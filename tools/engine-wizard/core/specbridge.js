'use strict'
// ============================================================================
//  SPEC BRIDGE —— 把字段元数据送到浏览器
//
//  ⭐ 为什么表单是「按规格自动长出来的」而不是手写一遍
//  46 个键，手写表单 = 第二份清单，必然漂移（平台那条 C11 守卫的同一件事）。
//  fieldmeta.js 已经是唯一权威 ⇒ 表单**照它长**，不重述。
//
//  ⛔ 不许出现任何具体引擎名。
// ============================================================================

const path = require('node:path')
const { SECTIONS, PARAM_FIELDS } = require('./fieldmeta')

/**
 * 表单要的全部信息，压成一个 JSON。
 * - sections：顶层段的分组、说明、危险等级
 * - paramFields：parameters[] 每一条有哪些格
 * ⚠ 只送**渲染需要的**，不把整个 fieldmeta 倒出去。
 */
function buildSpec () {
  return {
    sections: SECTIONS.map((s) => ({
      key: s.key,
      group: s.group,
      danger: s.danger,
      howto: s.howto,
      warn: s.warn || null,
      structure: s.structure || null,
    })),
    paramFields: PARAM_FIELDS.map((f) => ({
      key: f.key,
      required: f.required === true,
      danger: f.danger,
      howto: f.howto,
      warn: f.warn || null,
      default: f.default === undefined ? null : f.default,
    })),
  }
}

/**
 * Vite 中间件：GET /wizard/spec → 字段规格
 * （与 bridge.js 的 /wizard/validate 同源，分开是因为一个 GET 一个 POST）
 */
function handleSpec (req, res, coreDir) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/spec')) return false
  try {
    const out = buildSpec()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: e.message }))
  }
  return true
}

module.exports = { buildSpec, handleSpec }