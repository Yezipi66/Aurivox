'use strict'

// FLOW-CORE-003: translate typed Flow inputs to the existing broker synthesis
// service without importing Express or duplicating synthesis.js. The adapter is
// intentionally dependency-injected: the current generateService is still
// private to its route factory, so wiring it into the live server is a separate
// integration step.

const crypto = require('crypto')

const LEGACY_REQUEST_KEYS = Object.freeze([
  'format', 'split', 'max_chars', 'concat', 'silence_ms',
  'ref_audio', 'reference_text', 'aux_ref_audio_paths',
  'temperature', 'top_k', 'top_p', 'repetition_penalty',
  'text_split_method', 'speed_factor', 'seed',
  'gpt_model', 'sovits_model', 'text_lang', 'prompt_lang',
  'batch_size', 'batch_threshold', 'split_bucket', 'fragment_interval',
  'parallel_infer', 'sample_steps', 'if_sr', 'super_sampling',
  'media_type', 'streaming_mode', 'overlap_length', 'min_chunk_length',
  'pron_overrides', 'auto_base_lang', 'lang_overrides', 'engine_batch',
  'recipe_id', 'source', 'voice_label',
  // 引擎契约 v2：工作流节点也要能说「去哪台引擎、带哪包参数」。
  // 不加这两个键，flow 里接的新引擎会在这道白名单上被**静默吃掉** ——
  // 节点上填了、跑起来没有，和 recipeStore 当年吃未知参数键是同一个病。
  // engine_params 是嵌套对象，clone() 走 JSON 深拷贝，整包原样过。
  'engine_id', 'engine_params',
])

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
  for (const key of LEGACY_REQUEST_KEYS) if (obj[key] !== undefined) out[key] = clone(obj[key])
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

// FLOW-D26. The legacy broker returns no content digest, so the adapter cannot
// produce a true content hash here (it would have to read the audio bytes, and
// `audio_url` may not even be locally readable). What it CAN do is produce a
// *descriptor* fingerprint that is stable and collision-free with respect to
// everything the broker told us about the artifact.
//
// Two rules this function exists to enforce, both of which were violated by the
// weaker "hash whatever metadata happens to be around" approach:
//
//   1. The descriptor MUST include every field that distinguishes one artifact
//      from another - crucially `uri`. Hashing only {generation_id, files,
//      segments, source} collapses to a CONSTANT for the very common legacy
//      case where the broker returns none of them, so two different audio
//      files would share one fingerprint.
//   2. Serialization failure MUST fail closed. Returning null on error puts the
//      artifact back into the exact weak-identity state D26 exists to remove,
//      and D10a *skips* the fingerprint check when it is null - so the
//      degradation would be silent.
//
// `fingerprint_kind: 'descriptor'` is recorded so no downstream layer mistakes
// this for a content hash. Real content hashing is FLOW-D10b / Artifact Store
// territory and is deliberately NOT faked here.
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

// The artifact id must be opaque and must not embed the URL (a URL is a
// location, not an identity, and it can be rebound to different bytes). It must
// also be deterministic: a random id makes identity depend on wall-clock time,
// which breaks idempotent-retry de-duplication and any future run cache key.
// Hashing the descriptor gives us both properties at once.
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

  // Fingerprints are computed BEFORE any clone(): clone() is itself
  // JSON-based, so doing it first would surface an uncoded native TypeError
  // instead of the fail-closed adapter error this path is supposed to raise.
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
      // The current synthesis service is deliberately kept behind an adapter
      // boundary. It receives a request-like object with body, not an Express
      // response, and returns its JSON-serialisable service result.
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
  LEGACY_REQUEST_KEYS,
  buildLegacySynthesisRequest,
  createLegacySynthesisAdapter,
  normalizeLegacySynthesisResult,
}
