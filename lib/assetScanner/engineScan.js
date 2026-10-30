'use strict'

// 引擎怎么从模型文件名读语种、训练轮数与版本：唯一来源是引擎目录下的 scan.json。
// 本文件不认识任何具体命名；没写 scan.json 的引擎，平台不推断。

const fs = require('node:fs')
const path = require('node:path')
const { getEngine } = require('../engines/registry')

const SCAN_FILE = 'scan.json'
const TOP_KEYS = Object.freeze(['language_from_name', 'steps_from_name', 'version'])
const VERSION_KEYS = Object.freeze(['slot', 'header_map', 'from_name', 'from_size'])
const NAME_RULE_KEYS = Object.freeze(['pattern', 'flags', 'value'])
// process_ckpt 的版本头就是文件前两个字节。
const PT_HEADER_BYTES = 2

function scanError(message, details = {}) {
  const error = new Error(message)
  error.code = 'ENGINE_SCAN_INVALID'
  Object.assign(error, details)
  return error
}

function withoutComments(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith('_')) out[k] = v
  }
  return out
}

function namedPatterns(engineId, file, value, key, group) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length === 0) {
    throw scanError(
      `引擎 ${engineId} 的 ${file} 里 ${key} 必须是非空的正则数组；不推断就整段删掉。`,
      { engine_id: engineId, file, key })
  }
  return value.map((source, i) => {
    const at = `${key}[${i}]`
    if (typeof source !== 'string' || !source.trim()) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at} 必须是非空字符串。`,
        { engine_id: engineId, file, key: at })
    }
    let re
    try {
      re = new RegExp(source)
    } catch (err) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 ${at} 不是合法的正则：${source}（${err.message}）`,
        { engine_id: engineId, file, key: at })
    }
    if (!re.source.includes(`(?<${group}>`)) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 ${at} 必须带命名捕获组 (?<${group}>...)：` +
        '没有组名，平台不知道该把匹配到的哪一段当成值。',
        { engine_id: engineId, file, key: at })
    }
    return re
  })
}

function parseHeaderMap(engineId, file, value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw scanError(`引擎 ${engineId} 的 ${file} 里 version.header_map 必须是对象。`,
      { engine_id: engineId, file, key: 'version.header_map' })
  }
  const map = {}
  for (const [head, label] of Object.entries(value)) {
    if (head.length !== PT_HEADER_BYTES) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 version.header_map 的键 ${JSON.stringify(head)} ` +
        `必须是文件前 ${PT_HEADER_BYTES} 个字节，写成两个字符。`,
        { engine_id: engineId, file, key: 'version.header_map', value: head })
    }
    if (typeof label !== 'string' || !label.trim()) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 version.header_map.${JSON.stringify(head)} 必须是非空字符串。`,
        { engine_id: engineId, file, key: `version.header_map.${head}`, value: label })
    }
    map[head] = label.trim()
  }
  return map
}

function parseNameRules(engineId, file, value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length === 0) {
    throw scanError(`引擎 ${engineId} 的 ${file} 里 version.from_name 必须是非空数组。`,
      { engine_id: engineId, file, key: 'version.from_name' })
  }
  return value.map((raw, i) => {
    const at = `version.from_name[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at} 必须是对象。`,
        { engine_id: engineId, file, key: at })
    }
    for (const k of Object.keys(raw)) {
      if (!NAME_RULE_KEYS.includes(k)) {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 ${at}.${k} 平台不认识；` +
          `认识的只有 ${NAME_RULE_KEYS.join(' / ')}。`,
          { engine_id: engineId, file, key: `${at}.${k}` })
      }
    }
    if (typeof raw.pattern !== 'string' || !raw.pattern.trim()) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at}.pattern 必须是非空正则。`,
        { engine_id: engineId, file, key: `${at}.pattern` })
    }
    const flags = raw.flags === undefined || raw.flags === null ? '' : String(raw.flags)
    if (/[gy]/.test(flags)) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 ${at}.flags 不能带 g 或 y：同一个正则要拿来逐个试文件名，` +
        '带状态的匹配会让结果取决于试过几个文件。',
        { engine_id: engineId, file, key: `${at}.flags`, value: flags })
    }
    let re
    try {
      re = new RegExp(raw.pattern, flags)
    } catch (err) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 ${at} 不是合法的正则：${raw.pattern}（${err.message}）`,
        { engine_id: engineId, file, key: at })
    }
    if (typeof raw.value !== 'string' || !raw.value.trim()) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at}.value 必须是非空字符串。`,
        { engine_id: engineId, file, key: `${at}.value` })
    }
    return { re, value: raw.value.trim() }
  })
}

function parseSizeRules(engineId, file, value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length === 0) {
    throw scanError(`引擎 ${engineId} 的 ${file} 里 version.from_size 必须是非空数组。`,
      { engine_id: engineId, file, key: 'version.from_size' })
  }
  return value.map((raw, i) => {
    const at = `version.from_size[${i}]`
    const last = i === value.length - 1
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at} 必须是对象。`,
        { engine_id: engineId, file, key: at })
    }
    for (const k of Object.keys(raw)) {
      if (k !== 'below_bytes' && k !== 'value') {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 ${at}.${k} 平台不认识；认识的只有 below_bytes / value。`,
          { engine_id: engineId, file, key: `${at}.${k}` })
      }
    }
    if (typeof raw.value !== 'string' || !raw.value.trim()) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at}.value 必须是非空字符串。`,
        { engine_id: engineId, file, key: `${at}.value` })
    }
    if (last) {
      if (raw.below_bytes !== undefined) {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 ${at} 是最后一项，不许再写 below_bytes：` +
          '最后一项要兜住所有尺寸，否则更大的文件会读不出版本。',
          { engine_id: engineId, file, key: `${at}.below_bytes` })
      }
      return { below_bytes: null, value: raw.value.trim() }
    }
    if (!Number.isInteger(raw.below_bytes) || raw.below_bytes <= 0) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 ${at}.below_bytes 必须是正整数（字节）。`,
        { engine_id: engineId, file, key: `${at}.below_bytes`, value: raw.below_bytes })
    }
    return { below_bytes: raw.below_bytes, value: raw.value.trim() }
  })
}

function parseVersion(engineId, file, value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw scanError(`引擎 ${engineId} 的 ${file} 里 version 必须是对象。`,
      { engine_id: engineId, file, key: 'version' })
  }
  const decl = withoutComments(value)
  for (const k of Object.keys(decl)) {
    if (!VERSION_KEYS.includes(k)) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 version.${k} 平台不认识；` +
        `认识的只有 ${VERSION_KEYS.join(' / ')}。`,
        { engine_id: engineId, file, key: `version.${k}` })
    }
  }
  const slot = typeof decl.slot === 'string' ? decl.slot.trim() : ''
  if (!slot || /[\\/]/.test(slot) || slot === '.' || slot === '..') {
    throw scanError(
      `引擎 ${engineId} 的 ${file} 里 version.slot 必须是权重位目录名（不含路径分隔符）。`,
      { engine_id: engineId, file, key: 'version.slot', value: decl.slot })
  }
  const header_map = parseHeaderMap(engineId, file, decl.header_map)
  const from_name = parseNameRules(engineId, file, decl.from_name)
  const from_size = parseSizeRules(engineId, file, decl.from_size)
  if (Object.keys(header_map).length === 0 && from_name.length === 0 && from_size.length === 0) {
    throw scanError(
      `引擎 ${engineId} 的 ${file} 里 version 一条判定规则都没写：` +
      '不贴版本就把 version 整段删掉。',
      { engine_id: engineId, file, key: 'version' })
  }
  return { slot, header_map, from_name, from_size }
}

function parseScanConventions(engineId, file, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw scanError(`引擎 ${engineId} 的 ${file} 必须是一个 JSON 对象。`,
      { engine_id: engineId, file })
  }
  const decl = withoutComments(raw)
  for (const k of Object.keys(decl)) {
    if (!TOP_KEYS.includes(k)) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 顶层有一个平台不认识的键：${k}；` +
        `认识的只有 ${TOP_KEYS.join(' / ')}。` +
        '（要写给人看的注释，用 _ 开头。）',
        { engine_id: engineId, file, key: k })
    }
  }
  return {
    engine_id: engineId,
    file: file.replace(/\\/g, '/'),
    language_from_name: namedPatterns(engineId, file, decl.language_from_name, 'language_from_name', 'lang'),
    steps_from_name: namedPatterns(engineId, file, decl.steps_from_name, 'steps_from_name', 'step'),
    version: parseVersion(engineId, file, decl.version),
  }
}

/**
 * 读一台引擎的扫描约定。引擎没装或没写 scan.json ⇒ null（平台不推断）；写了但读不动 ⇒ 抛。
 * @param {string} engineId 引擎 id = engines/ 下的目录名
 */
function readScanConventions(engineId) {
  const engine = getEngine(engineId)
  if (!engine) return null
  const file = path.join(engine.dir, SCAN_FILE)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw scanError(`引擎 ${engineId} 的 ${file} 读不出来：${err.message}`,
      { engine_id: engineId, file })
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw scanError(`引擎 ${engineId} 的 ${file} 不是合法 JSON：${err.message}`,
      { engine_id: engineId, file })
  }
  return parseScanConventions(engineId, file, parsed)
}

function readHead(fp) {
  const fd = fs.openSync(fp, 'r')
  try {
    const buf = Buffer.alloc(PT_HEADER_BYTES)
    fs.readSync(fd, buf, 0, PT_HEADER_BYTES, 0)
    return buf.toString('latin1')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 按 version 声明判一个权重文件的版本：版本头 → 文件名 → 大小兜底。
 * 读不出来返回 null：版本只是给人看的标签，贴不上不该让模型从候选里消失。
 */
function detectModelVersion(fp, version) {
  try {
    if (Object.keys(version.header_map).length > 0) {
      const head = readHead(fp)
      if (Object.prototype.hasOwnProperty.call(version.header_map, head)) {
        return version.header_map[head]
      }
    }
    const base = path.basename(fp)
    for (const rule of version.from_name) {
      if (rule.re.test(base)) return rule.value
    }
    if (version.from_size.length > 0) {
      const size = fs.statSync(fp).size
      for (const rule of version.from_size) {
        if (rule.below_bytes === null || size < rule.below_bytes) return rule.value
      }
    }
    return null
  } catch (_) {
    return null
  }
}

module.exports = { readScanConventions, detectModelVersion }
