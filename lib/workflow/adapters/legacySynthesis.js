'use strict'

// 把 Flow 的类型化输入翻译成 broker 既有的合成请求，并规范化合成结果。
// 不引入 Express，也不复制一份合成逻辑：合成服务由调用方注入。
// 边界：只做翻译与规范化，不下载模型、不做鉴权、不管理引擎进程。

const crypto = require('crypto')

// 入参白名单 = 平台自己的词 + 本机上所有已装引擎认得的词。
//
// 白名单从名片自动长出来：下游作者接入一台新引擎时不必改这个文件，
// 它的参数名自动获得放行。否则他得先找到这个文件、看懂它是白名单，
// 再把自己的参数名一个个抄进来，那正是「要写胶水代码」。
//
// 取并集而不是「当前这台引擎的」：放行的这一刻还不知道图会跑到哪台
//  引擎上，选引擎是别的节点的事。取交集或只取某一台的，会把下游作者的参数
//  静默吃掉：节点上填了、跑起来没有。
// 只装一台引擎时，并集就是那台引擎认得的全部参数名；装了第二台之后，
// 它的私有参数也自动获得放行。
const { acceptedRequestKeys } = require('../../engines/paramTable')

function adapterError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function firstValue(value) {
  if (Array.isArray(value)) return value.length ? firstValue(value[0]) : null
  return value
}

function textValue(value) {
  const item = firstValue(value)
  if (typeof item === 'string' && item) return item
  const obj = asObject(item)
  if (!obj) return null
  for (const key of ['value', 'text', 'content']) if (typeof obj[key] === 'string' && obj[key]) return obj[key]
  const metadata = asObject(obj.metadata)
  if (metadata) for (const key of ['value', 'text', 'content']) if (typeof metadata[key] === 'string' && metadata[key]) return metadata[key]
  return null
}

function voiceValue(value) {
  const item = firstValue(value)
  if (typeof item === 'string' && item) return item
  const obj = asObject(item)
  if (!obj) return null
  for (const key of ['voice_id', 'voice', 'id', 'name']) if (typeof obj[key] === 'string' && obj[key]) return obj[key]
  const metadata = asObject(obj.metadata)
  if (metadata) for (const key of ['voice_id', 'voice', 'id', 'name']) if (typeof metadata[key] === 'string' && metadata[key]) return metadata[key]
  return null
}

function artifactPath(value) {
  const item = firstValue(value)
  if (typeof item === 'string' && item) return item
  const obj = asObject(item)
  if (!obj) return null
  for (const key of ['path', 'uri', 'file', 'ref_audio']) if (typeof obj[key] === 'string' && obj[key]) return obj[key]
  const metadata = asObject(obj.metadata)
  if (metadata) for (const key of ['path', 'uri', 'file', 'ref_audio']) if (typeof metadata[key] === 'string' && metadata[key]) return metadata[key]
  return null
}

function recipeObjects(value) {
  const values = Array.isArray(value) ? value : [value]
  return values.map(item => {
    const obj = asObject(item)
    if (!obj) return null
    return asObject(obj.recipe) || asObject(obj.data) || asObject(obj.metadata) || obj
  }).filter(Boolean)
}

function pickLegacyFields(source) {
  const out = {}
  const obj = asObject(source) || {}
  for (const key of acceptedRequestKeys()) if (obj[key] !== undefined) out[key] = clone(obj[key])
  return out
}

function buildLegacySynthesisRequest({ node = {}, inputs = {}, workflow_inputs = {} } = {}) {
  const text = textValue(inputs.text) || textValue(workflow_inputs.text)
  const voice = voiceValue(inputs.voice) || voiceValue(workflow_inputs.voice)
  if (!text) throw adapterError('LEGACY_TTS_TEXT_REQUIRED', 'Legacy synthesis requires a TextArtifact value')
  if (!voice) throw adapterError('LEGACY_TTS_VOICE_REQUIRED', 'Legacy synthesis requires a VoiceRef')

  const recipe = recipeObjects(inputs.recipe)
    .reduce((merged, item) => ({ ...merged, ...pickLegacyFields(item) }), {})
  const params = pickLegacyFields(node.params)
  const request = {
    ...recipe,
    ...params,
    voice,
    text,
  }

  const refAudio = artifactPath(inputs.reference_audio || inputs.ref_audio)
  if (refAudio && request.ref_audio === undefined) request.ref_audio = refAudio
  const referenceText = textValue(inputs.reference_text)
  if (referenceText && request.reference_text === undefined) request.reference_text = referenceText

  const language = firstValue(inputs.language)
  const languageObj = asObject(language)
  if (languageObj && request.lang_overrides === undefined) {
    const assignments = languageObj.assignments || languageObj.lang_overrides || languageObj.metadata?.assignments
    if (assignments !== undefined) request.lang_overrides = clone(assignments)
  }

  return request
}

function safeArtifactId(prefix, id) {
  const raw = String(id || `${Date.now()}`).replace(/[^a-zA-Z0-9_-]+/g, '_')
  return `${prefix}_${raw}`
}

// 算出产物的指纹。老的合成服务不返回内容摘要，真正的内容哈希在这里做不出来
// （那需要读音频字节，而 audio_url 未必在本机可读）。这里能给出的是描述符指纹：
// 对 broker 报出来的全部产物字段都稳定，且不同产物不会撞在一起。
//
// 这个函数要守住两条：
//  1. 描述符必须包含区分两个产物的每一个字段，尤其是 uri。只哈希
//     {generation_id, files, segments, source} 时，老的合成服务常常一个都不返回，
//     指纹会退化成常数，两份不同的音频共用一个指纹。
//  2. 序列化失败必须报错而不是返回 null。返回 null 会让产物回到「没有强身份」的状态，
//     而下游的比对在指纹为 null 时直接跳过检查，退化就是无声的。
//
// 产物上记 fingerprint_kind: 'descriptor'，下游就不会把它当成内容哈希。
function descriptorFingerprint(kind, descriptor) {
  let serialized
  try {
    serialized = JSON.stringify(descriptor)
  } catch (err) {
    serialized = undefined
  }
  if (typeof serialized !== 'string') {
    throw adapterError(
      'LEGACY_TTS_FINGERPRINT_FAILED',
      'Legacy synthesis artifact descriptor could not be serialized for fingerprinting',
      { artifact_kind: kind },
    )
  }
  return `sha256:${crypto.createHash('sha256').update(serialized).digest('hex')}`
}

// 产物 id 必须是不透明的，且不能把 URL 嵌进去（URL 是位置，不是身份，它可以指向别的字节）。
// 它还必须是确定的：随机 id 会让身份依赖墙上时钟，重试去重与将来的运行缓存键都失效。
// 对描述符做哈希，两个性质一次满足。
function artifactIdFrom(prefix, explicitId, fingerprint) {
  if (explicitId !== undefined && explicitId !== null && String(explicitId) !== '') {
    return safeArtifactId(prefix, explicitId)
  }
  return `${prefix}_${fingerprint.slice('sha256:'.length, 'sha256:'.length + 32)}`
}

function normalizeLegacySynthesisResult(response, request) {
  if (!response || typeof response !== 'object' || response.ok === false) {
    throw adapterError('LEGACY_TTS_OUTPUT_INVALID', 'Legacy synthesis returned no usable result')
  }
  if (typeof response.audio_url !== 'string' || !response.audio_url) {
    throw adapterError('LEGACY_TTS_AUDIO_MISSING', 'Legacy synthesis result has no audio_url', { response: clone(response) })
  }
  const explicitId = response.id

  // 指纹必须在任何 clone() 之前算：clone() 自己基于 JSON，先 clone 会抛出没有错误码的
  // 原生 TypeError，而不是这条路径该抛的适配器错误。
  const inferenceDescriptor = {
    source: 'legacy.synthesis',
    generation_id: explicitId || null,
    response,
    request,
  }
  const inferenceFingerprint = descriptorFingerprint('InferenceResult', inferenceDescriptor)

  const audioDescriptor = {
    source: 'legacy.synthesis',
    uri: response.audio_url,
    generation_id: explicitId || null,
    files: response.files || [],
    segments: response.segments || [],
  }
  const audioFingerprint = descriptorFingerprint('AudioArtifact', audioDescriptor)

  const inference = {
    artifact_id: artifactIdFrom('inference', explicitId, inferenceFingerprint),
    type: 'InferenceResult',
    fingerprint: inferenceFingerprint,
    fingerprint_kind: 'descriptor',
    metadata: {
      source: 'legacy.synthesis',
      response: clone(response),
      request: clone(request),
    },
  }

  const audio = {
    artifact_id: artifactIdFrom('audio', explicitId, audioFingerprint),
    type: 'AudioArtifact',
    uri: response.audio_url,
    fingerprint: audioFingerprint,
    fingerprint_kind: 'descriptor',
    metadata: {
      source: 'legacy.synthesis',
      generation_id: explicitId || null,
      files: clone(response.files || []),
      segments: clone(response.segments || []),
    },
  }
  return { audio, result: inference }
}

function createLegacySynthesisAdapter({ generateService } = {}) {
  if (typeof generateService !== 'function') throw adapterError('LEGACY_TTS_SERVICE_REQUIRED', 'generateService must be injected')
  return async function legacySynthesisHandler(context = {}) {
    const request = buildLegacySynthesisRequest(context)
    let response
    try {
      // 合成服务留在适配器边界之后：它收到的是带 body 的请求对象，不是 Express 的
      // 响应对象；返回的是可 JSON 序列化的服务结果。
      response = await generateService({ body: request, flow: context })
    } catch (error) {
      error.code = error.code || 'LEGACY_TTS_SERVICE_FAILED'
      throw error
    }
    return {
      status: 'succeeded',
      outputs: normalizeLegacySynthesisResult(response, request),
    }
  }
}

module.exports = {
  // 老名字保留为函数，语义从「这张表」变成「现在本机上放行哪些键」。
  // 不导出数组：数组会被调用方存下来，而已装引擎是运行时事实。
  acceptedRequestKeys,
  buildLegacySynthesisRequest,
  createLegacySynthesisAdapter,
  normalizeLegacySynthesisResult,
}
