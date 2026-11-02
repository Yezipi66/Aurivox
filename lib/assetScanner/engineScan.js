'use strict'

// 引擎怎么从模型文件名读语种、训练轮数与版本：唯一来源是引擎目录下的 scan.json。
// 本文件不认识任何具体命名；未写 scan.json 的引擎，平台不推断，同时说明它缺在哪一层。

const fs = require('node:fs')
const path = require('node:path')
const { getEngine } = require('../engines/registry')

const SCAN_FILE = 'scan.json'
const TOP_KEYS = Object.freeze(['language_from_name', 'steps_from_name', 'version'])
const VERSION_KEYS = Object.freeze(['slot', 'header_bytes', 'header_map', 'from_name', 'from_size'])
const NAME_RULE_KEYS = Object.freeze(['pattern', 'flags', 'value'])
// 不写 header_bytes 时读几个字节当版本头。2 是这条契约的出厂值，不是某个文件的格式。
const DEFAULT_HEADER_BYTES = 2
const SIZE_RULE_KEYS = Object.freeze(['below_bytes', 'value'])
// scan.json 写坏这一类错误的机器码。抛错、读错误、回给调用方都从这里取：
// 同一个字符串抄在几层里，改一处就会让另一层认不出它。
const SCAN_ERROR_CODE = 'ENGINE_SCAN_INVALID'

function scanError(message, details = {}) {
  const error = new Error(message)
  error.code = SCAN_ERROR_CODE
  Object.assign(error, details)
  return error
}

// 读 scan.json 的每一层都在 `_` 开头的键上放行注释：顶层、version 段、还有一条条规则对象。
// header_map 是例外：那里的键是文件头本身的字节，剥掉 `_` 开头的键就是丢内容。
// 例外写在 parseHeaderMap 的判据里，docs 的「模型文件名的读法：引擎目录下的 scan.json」一节同样写明。
function withoutComments(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith('_')) out[k] = v
  }
  return out
}

// 命名捕获组真的存在才算。查字符串会被转义的括号骗过：`_\\(?<lang>[a-z]{2}\\.bin$`
// 里那个组根本不存在，匹配出来的 m.groups 是 undefined，规则静默失效。
function hasNamedGroup(re, group) {
  let probe
  try {
    probe = new RegExp(`${re.source}|`, re.flags.replace(/[gy]/g, ''))
  } catch (_) {
    return false
  }
  const m = probe.exec('')
  return !!m && !!m.groups && Object.prototype.hasOwnProperty.call(m.groups, group)
}

// 一处正则有两种写法：正则字符串，或 { pattern, flags }。language_from_name 与 steps_from_name
// 的两种都收在这里；version.from_name 只收对象（还多带一个 value），它走 compilePattern，不走这里。
function rulePattern(engineId, file, at, raw) {
  if (typeof raw === 'string') return { pattern: raw, flags: '' }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const decl = withoutComments(raw)
    for (const k of Object.keys(decl)) {
      if (k !== 'pattern' && k !== 'flags') {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 ${at}.${k} 平台不认识；这一层只支持 pattern / flags。`,
          { engine_id: engineId, file, key: `${at}.${k}` })
      }
    }
    const flags = decl.flags === undefined || decl.flags === null ? '' : String(decl.flags)
    return { pattern: decl.pattern, flags }
  }
  throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at} 必须是正则字符串，或 { pattern, flags } 对象。`,
    { engine_id: engineId, file, key: at })
}

function compilePattern(engineId, file, at, pattern, flags) {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at} 必须是非空字符串。`,
      { engine_id: engineId, file, key: at })
  }
  if (/[gy]/.test(flags)) {
    throw scanError(
      `引擎 ${engineId} 的 ${file} 里 ${at} 的 flags 不能带 g 或 y：同一条正则要逐个试文件名，` +
      '带状态的匹配会让结果取决于前面已经试过几个。',
      { engine_id: engineId, file, key: at, value: flags })
  }
  try {
    return new RegExp(pattern, flags)
  } catch (err) {
    throw scanError(
      `引擎 ${engineId} 的 ${file} 里 ${at} 不是合法的正则：${pattern}（${err.message}）`,
      { engine_id: engineId, file, key: at })
  }
}

function parseNamedPatterns(engineId, file, value, key, group) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length === 0) {
    throw scanError(
      `引擎 ${engineId} 的 ${file} 里 ${key} 必须是非空的正则数组；不推断就整段删掉。`,
      { engine_id: engineId, file, key })
  }
  return value.map((raw, i) => {
    const at = `${key}[${i}]`
    const { pattern, flags } = rulePattern(engineId, file, at, raw)
    const re = compilePattern(engineId, file, at, pattern, flags)
    if (!hasNamedGroup(re, group)) {
      // 转义提示只在模式里确实写了这个组时才给出：未写 (?<lang> 的规则也收到这条，
      // 读的人会去查一个不存在的转义。
      const escapeHint = pattern.includes(`(?<${group}>`)
        ? `写了 (?<${group}> 却没认出来，通常是那个括号被转义了。` : ''
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 ${at} 必须带命名捕获组 (?<${group}>...)：` +
        `没有这个组，平台不知道该把匹配到的哪一段当成值。${escapeHint}`,
        { engine_id: engineId, file, key: at })
    }
    return re
  })
}

// 版本头是按字节读的（latin1），所以键只能是 0–255 的字符码：
// 「版本」这类汉字键无法命中，是一条静默失效的规则。
// 这一层的键不剥 `_` 前缀：`_` 是合法的版本头字节，剥掉就把「版本头正好以 `_` 开头」
// 变成另一条静默失效的规则。注释写在上一层的 version._comment 里。
function parseHeaderMap(engineId, file, value, headerBytes) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw scanError(`引擎 ${engineId} 的 ${file} 里 version.header_map 必须是对象。`,
      { engine_id: engineId, file, key: 'version.header_map' })
  }
  const map = {}
  for (const [head, label] of Object.entries(value)) {
    if (head.length !== headerBytes) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 version.header_map 的键 ${JSON.stringify(head)} ` +
        `长度不是 ${headerBytes}：那是 version.header_bytes 说的那几个字节。`,
        { engine_id: engineId, file, key: 'version.header_map', value: head })
    }
    for (let i = 0; i < head.length; i++) {
      if (head.charCodeAt(i) > 255) {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 version.header_map 的键 ${JSON.stringify(head)} ` +
          `第 ${i + 1} 个字符超出了字节范围：版本头按字节读取，` +
          '这类键无法命中，写它等于写一条静默失效的规则。',
          { engine_id: engineId, file, key: 'version.header_map', value: head })
      }
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
    const decl = withoutComments(raw)
    for (const k of Object.keys(decl)) {
      if (!NAME_RULE_KEYS.includes(k)) {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 ${at}.${k} 平台不认识；` +
          `认识的只有 ${NAME_RULE_KEYS.join(' / ')}。`,
          { engine_id: engineId, file, key: `${at}.${k}` })
      }
    }
    const re = compilePattern(engineId, file, `${at}.pattern`, decl.pattern,
      decl.flags === undefined || decl.flags === null ? '' : String(decl.flags))
    if (typeof decl.value !== 'string' || !decl.value.trim()) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at}.value 必须是非空字符串。`,
        { engine_id: engineId, file, key: `${at}.value` })
    }
    return { re, value: decl.value.trim() }
  })
}

function parseSizeRules(engineId, file, value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length === 0) {
    throw scanError(`引擎 ${engineId} 的 ${file} 里 version.from_size 必须是非空数组。`,
      { engine_id: engineId, file, key: 'version.from_size' })
  }
  const rules = value.map((raw, i) => {
    const at = `version.from_size[${i}]`
    const last = i === value.length - 1
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at} 必须是对象。`,
        { engine_id: engineId, file, key: at })
    }
    const decl = withoutComments(raw)
    for (const k of Object.keys(decl)) {
      if (!SIZE_RULE_KEYS.includes(k)) {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 ${at}.${k} 平台不认识；认识的只有 ${SIZE_RULE_KEYS.join(' / ')}。`,
          { engine_id: engineId, file, key: `${at}.${k}` })
      }
    }
    if (typeof decl.value !== 'string' || !decl.value.trim()) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at}.value 必须是非空字符串。`,
        { engine_id: engineId, file, key: `${at}.value` })
    }
    if (last) {
      if (decl.below_bytes !== undefined) {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 ${at} 是最后一项，不许再写 below_bytes：` +
          '最后一项必须覆盖所有尺寸，否则更大的文件无法确定版本。',
          { engine_id: engineId, file, key: `${at}.below_bytes` })
      }
      return { below_bytes: null, value: decl.value.trim() }
    }
    if (!Number.isInteger(decl.below_bytes) || decl.below_bytes <= 0) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 ${at}.below_bytes 必须是正整数（字节）。`,
        { engine_id: engineId, file, key: `${at}.below_bytes`, value: decl.below_bytes })
    }
    return { below_bytes: decl.below_bytes, value: decl.value.trim() }
  })
  // 阈值必须严格递增：[{1000,a},{10,b},{c}] 这种写法里，第二条无法命中，
  // 而名片显示为两条都生效。规则逐条尝试，中间有一条静默失效会让版本判定出错。
  // below_bytes 为 null 的是最后一项（兜底），不参与比较。
  for (let i = 1; i < rules.length; i++) {
    if (rules[i].below_bytes === null) continue
    if (rules[i].below_bytes <= rules[i - 1].below_bytes) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 version.from_size[${i}].below_bytes ` +
        `（${rules[i].below_bytes}）必须比前一项（${rules[i - 1].below_bytes}）大：` +
        '阈值按从小到大依次尝试，不递增的阈值无法命中，是一条静默失效的规则。',
        { engine_id: engineId, file, key: `version.from_size[${i}].below_bytes` })
    }
  }
  return rules
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
  let headerBytes = DEFAULT_HEADER_BYTES
  if (decl.header_bytes !== undefined && decl.header_bytes !== null) {
    if (!Number.isInteger(decl.header_bytes) || decl.header_bytes <= 0 || decl.header_bytes > 64) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 version.header_bytes 必须是 1..64 的整数（读文件前几个字节当版本头）。`,
        { engine_id: engineId, file, key: 'version.header_bytes', value: decl.header_bytes })
    }
    headerBytes = decl.header_bytes
  }
  const header_map = parseHeaderMap(engineId, file, decl.header_map, headerBytes)
  const from_name = parseNameRules(engineId, file, decl.from_name)
  const from_size = parseSizeRules(engineId, file, decl.from_size)
  if (Object.keys(header_map).length === 0 && from_name.length === 0 && from_size.length === 0) {
    throw scanError(
      `引擎 ${engineId} 的 ${file} 里 version 没有写任何判定规则：` +
      '不需要版本标签时，把 version 整段删掉。',
      { engine_id: engineId, file, key: 'version' })
  }
  return { slot, header_bytes: headerBytes, header_map, from_name, from_size }
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
        '（供阅读的注释用 _ 开头。）',
        { engine_id: engineId, file, key: k })
    }
  }
  return {
    language_from_name: parseNamedPatterns(engineId, file, decl.language_from_name, 'language_from_name', 'lang'),
    steps_from_name: parseNamedPatterns(engineId, file, decl.steps_from_name, 'steps_from_name', 'step'),
    version: parseVersion(engineId, file, decl.version),
  }
}

/**
 * 单台引擎的扫描约定，以及「无法读取时缺在哪一层」。
 * conventions 为 null 只有两种原因：该引擎没注册，或注册了但目录下没有 scan.json。
 * 两种情况都由调用方给出说明：贴不上标签时，「没有该约定」与「引擎无法读取」在界面上无法区分。
 * 写了但无法读取（非法 JSON、拼错的键、编译不过的正则）⇒ 抛 ENGINE_SCAN_INVALID，不静默降级。
 * @param {string} engineId 引擎 id = engines/ 下的目录名
 * @returns {{ conventions: object|null, missing: string|null, file: string|null }}
 */
function readScanStatus(engineId) {
  const engine = getEngine(engineId)
  if (!engine) return { conventions: null, missing: 'engine_not_installed', file: null }
  const file = path.join(engine.dir, SCAN_FILE)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { conventions: null, missing: 'no_scan_file', file }
    throw scanError(`引擎 ${engineId} 的 ${file} 无法读取：${err.message}`,
      { engine_id: engineId, file })
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw scanError(`引擎 ${engineId} 的 ${file} 不是合法 JSON：${err.message}`,
      { engine_id: engineId, file })
  }
  return { conventions: parseScanConventions(engineId, file, parsed), missing: null, file }
}

/**
 * 只要约定本身：引擎未安装或未写 scan.json ⇒ null（平台不推断），写了但无法读取 ⇒ 抛。
 * 想知道「缺在哪一层」用 readScanStatus。
 */
function readScanConventions(engineId) {
  return readScanStatus(engineId).conventions
}

function readHead(fp, headerBytes) {
  const fd = fs.openSync(fp, 'r')
  try {
    const buf = Buffer.alloc(headerBytes)
    fs.readSync(fd, buf, 0, headerBytes, 0)
    return buf.toString('latin1')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 按 version 声明判一个权重文件的版本：版本头 → 文件名 → 大小兜底。
 * 无法读取时返回 null：贴不上版本不该让模型从候选里消失（GenerateTab 用它检查底模是否就绪）。
 */
function detectModelVersion(fp, version) {
  try {
    if (Object.keys(version.header_map).length > 0) {
      const head = readHead(fp, version.header_bytes)
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

module.exports = { readScanConventions, readScanStatus, detectModelVersion, SCAN_ERROR_CODE }
