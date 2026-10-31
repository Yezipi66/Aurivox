'use strict'

// 引擎的资产侧约定：唯一来源是引擎目录下的 scan.json。
// 它回答两件事：怎么从模型文件名读语种/轮数/版本，以及底模目录里哪些文件算候选、各属于哪个权重位。
// 本文件不认识任何具体命名；没写 scan.json 的引擎，平台不推断，也把它缺在哪一层说出来。

const fs = require('node:fs')
const path = require('node:path')
const { getEngine } = require('../engines/registry')

const SCAN_FILE = 'scan.json'
const TOP_KEYS = Object.freeze(['language_from_name', 'steps_from_name', 'version', 'base_models'])
const VERSION_KEYS = Object.freeze(['slot', 'header_bytes', 'header_map', 'from_name', 'from_size'])
const NAME_RULE_KEYS = Object.freeze(['pattern', 'flags', 'value'])
const SIZE_RULE_KEYS = Object.freeze(['below_bytes', 'value'])
const BASE_MODEL_KEYS = Object.freeze(['slot', 'name', 'candidates', 'version', 'steps', 'default'])
// 不写 header_bytes 时读几个字节当版本头。2 是这条契约的出厂值，不是某个文件的格式。
const DEFAULT_HEADER_BYTES = 2

// missing 那两个 token 说给人听的那半句话：只点名缺在哪一层，
// 前半句（谁的什么读不出来）由各自的用户界面写。
const MISSING_SCAN_REASON = {
  engine_not_installed: '平台没有这台引擎（engines/ 下没有它的目录）',
  no_scan_file: '这台引擎的目录下没有 scan.json',
}

function scanError(message, details = {}) {
  const error = new Error(message)
  error.code = 'ENGINE_SCAN_INVALID'
  Object.assign(error, details)
  return error
}

// 注释键的规矩在各层都一样：`_` 开头的键是写给人看的，不是内容。
// 只在顶层认、到数组元素里就报「不认识的键」，同一条提示会指两个方向。
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

// 一条规则 Either 是正则字符串，要么是 { pattern, flags }：version.from_name 也是这两种，
// 两类规则写法不同，后来的人只会当成两套契约。
function rulePattern(engineId, file, at, raw) {
  if (typeof raw === 'string') return { pattern: raw, flags: '' }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const decl = withoutComments(raw)
    for (const k of Object.keys(decl)) {
      if (k !== 'pattern' && k !== 'flags') {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 ${at}.${k} 平台不认识；这一层只认 pattern / flags。`,
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
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 ${at} 必须带命名捕获组 (?<${group}>...)：` +
        `没有这个组，平台不知道该把匹配到的哪一段当成值。写了 (?<${group}> 却没认出来，` +
        '通常是那个括号被转义了。',
        { engine_id: engineId, file, key: at })
    }
    return re
  })
}

// 版本头是按字节读的（latin1），所以键只能是 0–255 的字符码：
// 写「版本」这种汉字的键永远匹配不上，那是条静默的死规则。
function parseHeaderMap(engineId, file, value, headerBytes) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw scanError(`引擎 ${engineId} 的 ${file} 里 version.header_map 必须是对象。`,
      { engine_id: engineId, file, key: 'version.header_map' })
  }
  const map = {}
  for (const [head, label] of Object.entries(withoutComments(value))) {
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
          `第 ${i + 1} 个字符超出了字节范围：版本头是按字节读的，` +
          '这样的键永远匹配不上，写它等于写一条静默失效的规则。',
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
          '最后一项要兜住所有尺寸，否则更大的文件会读不出版本。',
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
  // 阈值必须严格递增：[{1000,a},{10,b},{c}] 这种写法里，第二条永远轮不到，
  // 而名片看上去两条都生效。逐个试的规则一旦有一条是死的，排查的人只会去怪文件。
  // below_bytes 为 null 的是兜底那一项，不参与比较。
  for (let i = 1; i < rules.length; i++) {
    if (rules[i].below_bytes === null) continue
    if (rules[i].below_bytes <= rules[i - 1].below_bytes) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 version.from_size[${i}].below_bytes ` +
        `（${rules[i].below_bytes}）必须比前一项（${rules[i - 1].below_bytes}）大：` +
        '阈值是从小到大逐个试的，不递增的那一条永远轮不到，是条静默失效的规则。',
        { engine_id: engineId, file, key: `version.from_size[${i}].below_bytes` })
    }
  }
  return rules
}

// 候选路径只能是底模目录下的相对路径：绝对路径会绕过 checkpoints_env 指的目录。
function isRelativeCandidate(value) {
  return typeof value === 'string' && value.trim() !== ''
    && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.split(/[\\/]/).includes('..')
}

function parseBaseModels(engineId, file, value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length === 0) {
    throw scanError(`引擎 ${engineId} 的 ${file} 里 base_models 必须是非空数组：不声明就整段删掉。`,
      { engine_id: engineId, file, key: 'base_models' })
  }
  const entries = value.map((raw, i) => {
    const at = `base_models[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at} 必须是对象。`,
        { engine_id: engineId, file, key: at })
    }
    const decl = withoutComments(raw)
    for (const k of Object.keys(decl)) {
      if (!BASE_MODEL_KEYS.includes(k)) {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 ${at}.${k} 平台不认识；` +
          `认识的只有 ${BASE_MODEL_KEYS.join(' / ')}。`,
          { engine_id: engineId, file, key: `${at}.${k}` })
      }
    }
    for (const k of ['slot', 'name']) {
      if (typeof decl[k] !== 'string' || !decl[k].trim()) {
        throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at}.${k} 必须是非空字符串。`,
          { engine_id: engineId, file, key: `${at}.${k}`, value: decl[k] })
      }
    }
    if (!Array.isArray(decl.candidates) || decl.candidates.length === 0) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at}.candidates 必须是非空数组。`,
        { engine_id: engineId, file, key: `${at}.candidates` })
    }
    for (const c of decl.candidates) {
      if (!isRelativeCandidate(c)) {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 ${at}.candidates 只能写底模目录下的相对路径：${JSON.stringify(c)}`,
          { engine_id: engineId, file, key: `${at}.candidates`, value: c })
      }
    }
    if (decl.version !== undefined && (typeof decl.version !== 'string' || !decl.version.trim())) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at}.version 必须是非空字符串。`,
        { engine_id: engineId, file, key: `${at}.version`, value: decl.version })
    }
    if (decl.steps !== undefined && decl.steps !== null
      && !(Number.isInteger(decl.steps) && decl.steps >= 0)) {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at}.steps 必须是非负整数或 null。`,
        { engine_id: engineId, file, key: `${at}.steps`, value: decl.steps })
    }
    if (decl.default !== undefined && typeof decl.default !== 'boolean') {
      throw scanError(`引擎 ${engineId} 的 ${file} 里 ${at}.default 必须是布尔值。`,
        { engine_id: engineId, file, key: `${at}.default`, value: decl.default })
    }
    const entry = {
      slot: decl.slot.trim(),
      name: decl.name.trim(),
      candidates: decl.candidates.map((c) => c.trim()),
    }
    if (decl.version !== undefined) entry.version = decl.version.trim()
    if (decl.steps !== undefined) entry.steps = decl.steps
    if (decl.default !== undefined) entry.default = decl.default
    return entry
  })
  // 同一个位上两个 default（或两个同名条目）不是「多看一行」的问题：
  // 前端用 find(x => x.default) 挑默认项，挑到哪个取决于声明顺序，用户以为选的是别的。
  const seenNames = new Map()
  const seenDefault = new Set()
  for (const entry of entries) {
    const at = `${entry.slot}/${entry.name}`
    if (seenNames.has(at)) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 base_models 有两条都往 ${at} 写：` +
        '下拉里会出现两个同名条目，用户分不出选哪个。',
        { engine_id: engineId, file, key: 'base_models', value: at })
    }
    seenNames.set(at, true)
    if (entry.default === true) {
      if (seenDefault.has(entry.slot)) {
        throw scanError(
          `引擎 ${engineId} 的 ${file} 里 ${entry.slot} 这个位有两条 default: true：` +
          '默认项只能有一个，多个的话界面只会静默取排在前面那条。',
          { engine_id: engineId, file, key: 'base_models', value: entry.slot })
      }
      seenDefault.add(entry.slot)
    }
  }
  return entries
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
      `引擎 ${engineId} 的 ${file} 里 version 一条判定规则都没写：` +
      '不贴版本就把 version 整段删掉。',
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
        '（要写给人看的注释，用 _ 开头。）',
        { engine_id: engineId, file, key: k })
    }
  }
  return {
    language_from_name: parseNamedPatterns(engineId, file, decl.language_from_name, 'language_from_name', 'lang'),
    steps_from_name: parseNamedPatterns(engineId, file, decl.steps_from_name, 'steps_from_name', 'step'),
    version: parseVersion(engineId, file, decl.version),
    base_models: parseBaseModels(engineId, file, decl.base_models),
  }
}

/**
 * 一台引擎的扫描约定，以及「读不出来时缺在哪一层」。
 * conventions 为 null 只有两种原因：这台引擎没注册，或注册了但目录下没有 scan.json。
 * 两种都让调用方说出来：标签贴不上时，「没有这个约定」和「引擎坏了」在界面上长一样。
 * 写了但读不动（坏 JSON、拼错的键、编译不过的正则）⇒ 抛 ENGINE_SCAN_INVALID，不静默降级。
 * @param {string} engineId 引擎 id = engines/ 下的目录名
 * @returns {{ conventions: object|null, missing: string|null, file: string|null }}
 */function readScanStatus(engineId) {
  const engine = getEngine(engineId)
  if (!engine) return { conventions: null, missing: 'engine_not_installed', file: null }
  const file = path.join(engine.dir, SCAN_FILE)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { conventions: null, missing: 'no_scan_file', file }
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
  return { conventions: parseScanConventions(engineId, file, parsed), missing: null, file }
}

/**
 * 只要约定本身：引擎没装或没写 scan.json ⇒ null（平台不推断），写了但读不动 ⇒ 抛。
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
 * 读不出来返回 null：贴不上版本不该让模型从候选里消失（GenerateTab 用它查底模齐不齐）。
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

module.exports = { MISSING_SCAN_REASON, scanError, readScanConventions, readScanStatus, detectModelVersion }
