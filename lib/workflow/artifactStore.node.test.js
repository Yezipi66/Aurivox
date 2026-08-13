'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  ARTIFACT_STORE_ERROR_CODES,
  FORBIDDEN_STORE_METHODS,
  assertReadOnlyArtifactStore,
  reconcileArtifactDescriptor,
  artifactRefsFromSnapshot,
  createMemoryArtifactStore,
} = require('./index')

const EXPECTED = Object.freeze({
  artifact_id: 'art_1',
  type: 'TextArtifact',
  fingerprint: 'sha256:abc',
})

test('assertReadOnlyArtifactStore requires describe()', () => {
  assert.throws(() => assertReadOnlyArtifactStore({}), e => e.code === 'ARTIFACT_STORE_INVALID')
  assert.throws(() => assertReadOnlyArtifactStore(null), e => e.code === 'ARTIFACT_STORE_INVALID')
  assert.doesNotThrow(() => assertReadOnlyArtifactStore({ describe: async () => null }))
})

test('assertReadOnlyArtifactStore rejects every implicit latest-revision shortcut', () => {
  // FLOW-D10 R1 Q5 holds only while no such method exists, so each name in the
  // list is checked rather than trusting the documentation.
  for (const forbidden of FORBIDDEN_STORE_METHODS) {
    assert.throws(
      () => assertReadOnlyArtifactStore({ describe: async () => null, [forbidden]: async () => null }),
      error => {
        assert.equal(error.code, 'ARTIFACT_STORE_INVALID')
        assert.equal(error.forbidden_method, forbidden)
        return true
      },
      `expected '${forbidden}' to be rejected`,
    )
  }
})

test('reconcileArtifactDescriptor accepts a descriptor that agrees', () => {
  assert.equal(reconcileArtifactDescriptor('text', EXPECTED, {
    artifact_id: 'art_1', exists: true, type: 'TextArtifact', fingerprint: 'sha256:abc',
  }), null)
})

test('reconcileArtifactDescriptor treats null, absent and exists:false alike', () => {
  for (const descriptor of [null, undefined, { artifact_id: 'art_1', exists: false }]) {
    const conflict = reconcileArtifactDescriptor('text', EXPECTED, descriptor)
    assert.equal(conflict.code, ARTIFACT_STORE_ERROR_CODES.NOT_FOUND)
    assert.equal(conflict.key, 'text')
    assert.equal(conflict.artifact_id, 'art_1')
  }
})

test('reconcileArtifactDescriptor rejects a descriptor answering about another id', () => {
  // A store that silently resolves to a different artifact is exactly the Q5
  // failure mode, so it must not be accepted just because the shape is valid.
  const conflict = reconcileArtifactDescriptor('text', EXPECTED, {
    artifact_id: 'art_2', exists: true, type: 'TextArtifact', fingerprint: 'sha256:abc',
  })
  assert.equal(conflict.code, ARTIFACT_STORE_ERROR_CODES.NOT_FOUND)
  assert.equal(conflict.reason, 'DESCRIPTOR_ID_MISMATCH')
})

test('reconcileArtifactDescriptor flags type and fingerprint conflicts separately', () => {
  const typeConflict = reconcileArtifactDescriptor('text', EXPECTED, {
    artifact_id: 'art_1', exists: true, type: 'AudioArtifact', fingerprint: 'sha256:abc',
  })
  assert.equal(typeConflict.code, ARTIFACT_STORE_ERROR_CODES.TYPE_CONFLICT)

  const fpConflict = reconcileArtifactDescriptor('text', EXPECTED, {
    artifact_id: 'art_1', exists: true, type: 'TextArtifact', fingerprint: 'sha256:zzz',
  })
  assert.equal(fpConflict.code, ARTIFACT_STORE_ERROR_CODES.FINGERPRINT_CONFLICT)
})

test('reconcileArtifactDescriptor skips fingerprint comparison for pre-D26 null entries', () => {
  const legacy = { artifact_id: 'art_1', type: 'TextArtifact', fingerprint: null }
  assert.equal(reconcileArtifactDescriptor('text', legacy, {
    artifact_id: 'art_1', exists: true, type: 'TextArtifact', fingerprint: 'sha256:whatever',
  }), null)
  // ...but existence is still enforced for those same entries.
  assert.equal(reconcileArtifactDescriptor('text', legacy, null).code, ARTIFACT_STORE_ERROR_CODES.NOT_FOUND)
})

test('artifactRefsFromSnapshot selects only artifact_ref entries', () => {
  const refs = artifactRefsFromSnapshot({
    a: { kind: 'artifact_ref', artifact_id: 'art_1', type: 'TextArtifact', fingerprint: 'sha256:abc' },
    b: { kind: 'inline_digest', type: 'string', length: 3, digest: 'sha256:d' },
    c: { kind: 'inline', type: 'number', value: 1 },
    d: { kind: 'opaque_digest', type: 'object', digest: 'sha256:e' },
    e: { kind: 'artifact_ref' },
  })
  assert.deepEqual(refs, [{ key: 'a', artifact_id: 'art_1', type: 'TextArtifact', fingerprint: 'sha256:abc' }])
})

test('the memory store is read-only and refuses to serve content', async () => {
  const store = createMemoryArtifactStore({ art_1: { type: 'TextArtifact' } })
  assert.doesNotThrow(() => assertReadOnlyArtifactStore(store))
  assert.equal((await store.describe('art_1')).exists, true)
  assert.equal(await store.describe('missing'), null)
  // Content verification is L2 and explicitly outside this slice.
  await assert.rejects(() => store.openContent('art_1'), e => e.code === 'ARTIFACT_CONTENT_UNSUPPORTED')
})

test('describe() returns a copy so callers cannot mutate store state', async () => {
  const store = createMemoryArtifactStore({ art_1: { type: 'TextArtifact' } })
  const first = await store.describe('art_1')
  first.type = 'AudioArtifact'
  assert.equal((await store.describe('art_1')).type, 'TextArtifact')
})
