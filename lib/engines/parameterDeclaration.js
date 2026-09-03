'use strict'

const DERIVED_PARAMETERS = Symbol.for('aurivox.derivedParameters')

const UI_KEYS = new Set([
  'label', 'help', 'suggested_value', 'min', 'max', 'step', 'choices',
  'source', 'allow_custom', 'multi', 'repeat', 'dim_labels', 'tier',
  'group', 'order', 'width', 'only_when', 'int',
])

function invalid(message, details = {}) {
  const error = new Error(message)
  error.code = 'ENGINE_MANIFEST_INVALID_VALUE'
  Object.assign(error, details)
  return error
}

function deriveTextBinding(manifest) {
  if (manifest.input === undefined) return manifest
  if (manifest.maps !== undefined) {
    throw invalid(`引擎 ${manifest.id || '?'} 同时写了新版 input 和旧字段 maps。` +
      '核心输入绑定只能声明一次。', { key: 'maps' })
  }
  if (!manifest.input || typeof manifest.input !== 'object' || Array.isArray(manifest.input)) {
    throw invalid(`引擎 ${manifest.id || '?'} 的 input 必须是对象。`, { key: 'input' })
  }
  const extra = Object.keys(manifest.input).filter(k => k !== 'text')
  if (extra.length) {
    throw invalid(`引擎 ${manifest.id || '?'} 的 input 目前只认识特殊字段 text，` +
      `不认识：${extra.join(', ')}`, { key: `input.${extra[0]}` })
  }
  const text = manifest.input.text
  const parameter = typeof text === 'string' ? text : text && text.parameter
  if (typeof parameter !== 'string' || parameter === '') {
    throw invalid(`引擎 ${manifest.id || '?'} 的 input.text 必须声明非空 parameter。`,
      { key: 'input.text.parameter' })
  }
  return { ...manifest, maps: { text: parameter } }
}

function deriveParameterViews(manifest) {
  manifest = deriveTextBinding(manifest)
  if (manifest.parameters === undefined) return manifest
  if (!Array.isArray(manifest.parameters)) {
    throw invalid(`引擎 ${manifest.id || '?'} 的 parameters 必须是数组。`, { key: 'parameters' })
  }
  for (const legacy of ['param_keys', 'payload_keys', 'params', 'defaults', 'defaults_env']) {
    if (manifest[legacy] !== undefined) {
      throw invalid(`引擎 ${manifest.id || '?'} 同时写了新版 parameters 和旧字段 ${legacy}。` +
        '参数只能声明一次，不能保留两份会漂移的事实。', { key: legacy })
    }
  }

  const textParameter = manifest.maps && manifest.maps.text
  const names = new Set()
  const paramKeys = []
  const payloadKeys = []
  const loadTime = []
  const callTime = []
  const schema = {}

  for (let i = 0; i < manifest.parameters.length; i += 1) {
    const item = manifest.parameters[i]
    const at = `parameters[${i}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw invalid(`引擎 ${manifest.id || '?'} 的 ${at} 必须是对象。`, { key: at })
    }
    const name = item.name
    if (typeof name !== 'string' || name === '') {
      throw invalid(`引擎 ${manifest.id || '?'} 的 ${at}.name 必须是非空字符串。`, { key: `${at}.name` })
    }
    if (name === textParameter) {
      throw invalid(`引擎 ${manifest.id || '?'} 的特殊文本参数 ${name} 不应重复出现在 parameters。` +
        '请只在 input.text 中绑定它。', { key: `${at}.name` })
    }
    if (names.has(name)) {
      throw invalid(`引擎 ${manifest.id || '?'} 的 parameters 重复声明了 ${name}。`, { key: `${at}.name` })
    }
    names.add(name)
    const phase = item.phase || 'call'
    if (phase !== 'call' && phase !== 'load') {
      throw invalid(`引擎 ${manifest.id || '?'} 的 ${at}.phase 只能是 call 或 load。`, { key: `${at}.phase` })
    }
    if (!item.type) {
      throw invalid(`引擎 ${manifest.id || '?'} 的 ${at}.type 是必填字段。`, { key: `${at}.type` })
    }

    paramKeys.push(name)
    if (phase === 'call') {
      payloadKeys.push(name)
      callTime.push(name)
    } else {
      loadTime.push(name)
    }

    const view = { type: item.type }
    for (const key of UI_KEYS) {
      if (item[key] !== undefined) view[key === 'suggested_value' ? 'default' : key] = item[key]
    }
    schema[name] = view
  }

  const derived = {
    ...manifest,
    param_keys: paramKeys,
    payload_keys: payloadKeys,
    defaults: {},
    params: { load_time: loadTime, call_time: callTime, schema },
  }
  Object.defineProperty(derived, DERIVED_PARAMETERS, { value: true })
  return derived
}

function hasDerivedParameters(manifest) {
  return Boolean(manifest && manifest[DERIVED_PARAMETERS])
}

module.exports = { deriveParameterViews, hasDerivedParameters }
