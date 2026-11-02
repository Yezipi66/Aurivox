'use strict'
//  SPEC BRIDGE：把字段元数据送到浏览器


const path = require('node:path')
const { SECTIONS, PARAM_FIELDS, PLATFORM_WORDS } = require('./fieldmeta')

// bind 槽位是平台的固定词表，不许在界面里手抄一份：
// 手抄的那份与平台不同步时，向导会给出平台根本不认的槽位，
// 而平台是在加载名片时才拒（不是填的时候拒）⇒ 使用者填完才发现。
// 这里直接取平台那份。
const { BIND_SLOTS } = require('../../../lib/engines/hostProfile')

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
    // 第 2 步：平台词的中文人话。反射草稿里命中的行显示它，
    //   表外的一个字都不翻译（只给上游原话）。
    platformWords: PLATFORM_WORDS.map((w) => ({
      key: w.key,
      danger: w.danger,
      label: w.label,
      help: w.help,
      warn: w.warn || null,
    })),
    // call.bind 的槽位：平台的固定词表，界面照它给输入框。
    bindSlots: BIND_SLOTS.slice(),
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