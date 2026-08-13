'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  buildLegacySynthesisRequest,
  createLegacySynthesisAdapter,
  normalizeLegacySynthesisResult,
} = require('./index')

test('legacy synthesis request maps typed Flow inputs through an allowlist', () => {
  const request = buildLegacySynthesisRequest({
    node: {
      params: {
        temperature: 0.8,
        text_lang: 'auto_zh_ja_yue',
        ignored_internal_value: 'must-not-cross-adapter',
      },
    },
    inputs: {
      text: { artifact_id: 'text_1', type: 'TextArtifact', value: '今日' },
      voice: { artifact_id: 'voice_1', type: 'VoiceRef', voice_id: 'voice_demo' },
      recipe: [{
        artifact_id: 'recipe_1',
        type: 'PronunciationRecipe',
        data: {
          ref_audio: 'assets/ref.wav',
          reference_text: '参考文本',
          lang_overrides: { '@0': 'zh' },
          pron_overrides: { zh: { '今日': ['jin1', 'ri4'] } },
          temperature: 0.4,
        },
      }],
      language: { assignments: { '@0': 'zh' } },
    },
  })
  assert.deepEqual(request, {
    voice: 'voice_demo',
    text: '今日',
    ref_audio: 'assets/ref.wav',
    reference_text: '参考文本',
    lang_overrides: { '@0': 'zh' },
    pron_overrides: { zh: { '今日': ['jin1', 'ri4'] } },
    temperature: 0.8,
    text_lang: 'auto_zh_ja_yue',
  })
  assert.equal(request.ignored_internal_value, undefined)
})

test('legacy synthesis result becomes typed AudioArtifact and InferenceResult outputs', () => {
  const result = normalizeLegacySynthesisResult({
    ok: true,
    id: 'gen_001',
    audio_url: '/outputs/generate/gen_001/audio.wav',
    files: [{ role: 'single', url: '/outputs/generate/gen_001/audio.wav' }],
  }, { voice: 'voice_demo', text: '你好' })
  assert.equal(result.audio.type, 'AudioArtifact')
  assert.equal(result.audio.uri, '/outputs/generate/gen_001/audio.wav')
  assert.equal(result.result.type, 'InferenceResult')
  assert.match(result.audio.artifact_id, /^audio_gen_001$/)
  assert.match(result.result.artifact_id, /^inference_gen_001$/)
})

// FLOW-D26 regression suite.
test('FLOW-D26: legacy artifacts always carry a fingerprint labelled as a descriptor', () => {
  const result = normalizeLegacySynthesisResult({
    ok: true,
    audio_url: '/outputs/generate/no_id/audio.wav',
  }, { text: '你好' })
  for (const artifact of [result.audio, result.result]) {
    assert.match(artifact.fingerprint, /^sha256:[0-9a-f]{64}$/)
    // Must not be advertised as a content hash - the adapter never read the bytes.
    assert.equal(artifact.fingerprint_kind, 'descriptor')
  }
})

test('FLOW-D26: different audio yields different fingerprints even with no id/files/segments', () => {
  const a = normalizeLegacySynthesisResult({ ok: true, audio_url: '/outputs/alice.wav' }, { text: '你好' })
  const b = normalizeLegacySynthesisResult({ ok: true, audio_url: '/outputs/bob.wav' }, { text: '再见' })
  // Hashing only the metadata bag collapses to one constant for this shape and
  // makes D10a's fingerprint check vacuous. The uri must be inside the digest.
  assert.notEqual(a.audio.fingerprint, b.audio.fingerprint)
  assert.notEqual(a.audio.artifact_id, b.audio.artifact_id)
  assert.notEqual(a.result.fingerprint, b.result.fingerprint)
})

test('FLOW-D26: artifact identity is deterministic, not wall-clock or random', () => {
  const payload = { ok: true, audio_url: '/outputs/same.wav', files: [{ role: 'single', url: '/outputs/same.wav' }] }
  const first = normalizeLegacySynthesisResult(payload, { text: 'x' })
  const second = normalizeLegacySynthesisResult(payload, { text: 'x' })
  assert.equal(first.audio.artifact_id, second.audio.artifact_id)
  assert.equal(first.audio.fingerprint, second.audio.fingerprint)
  assert.equal(first.result.artifact_id, second.result.artifact_id)
})

test('FLOW-D26: artifact_id stays opaque and never embeds the audio url', () => {
  const result = normalizeLegacySynthesisResult({
    ok: true,
    audio_url: '/outputs/generate/leaky_path/audio.wav',
  }, { text: 'x' })
  for (const id of [result.audio.artifact_id, result.result.artifact_id]) {
    assert.equal(id.includes('outputs'), false)
    assert.equal(id.includes('leaky_path'), false)
    assert.equal(id.includes('wav'), false)
  }
  assert.match(result.audio.artifact_id, /^audio_[0-9a-f]{32}$/)
})

test('FLOW-D26: fingerprint failure fails closed instead of degrading to null', () => {
  // A null fingerprint is silently skipped by the D10a reconciler, so an
  // un-fingerprintable artifact must never be emitted.
  const unserializable = { ok: true, audio_url: '/outputs/x.wav', bad: 1n }
  assert.throws(
    () => normalizeLegacySynthesisResult(unserializable, { text: 'x' }),
    err => {
      assert.notEqual(err.code, undefined)
      return true
    },
  )
})

test('injected legacy service receives a request-like body and returns a handler result', async () => {
  let received = null
  const handler = createLegacySynthesisAdapter({
    generateService: async req => {
      received = req
      return { ok: true, id: 'gen_002', audio_url: '/outputs/generate/gen_002/audio.wav' }
    },
  })
  const result = await handler({
    node: { params: {} },
    inputs: {
      text: { value: '你好' },
      voice: { voice_id: 'voice_demo' },
    },
  })
  assert.equal(received.body.voice, 'voice_demo')
  assert.equal(received.body.text, '你好')
  assert.equal(result.status, 'succeeded')
  assert.equal(result.outputs.audio.uri, '/outputs/generate/gen_002/audio.wav')
})

test('legacy adapter rejects missing typed inputs and malformed service output', async () => {
  const handler = createLegacySynthesisAdapter({ generateService: async () => ({ ok: true }) })
  await assert.rejects(
    () => handler({ inputs: { text: { value: '你好' } } }),
    error => error.code === 'LEGACY_TTS_VOICE_REQUIRED',
  )
  await assert.rejects(
    () => handler({ inputs: { text: { value: '你好' }, voice: { voice_id: 'v' } } }),
    error => error.code === 'LEGACY_TTS_AUDIO_MISSING',
  )
})
