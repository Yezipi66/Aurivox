'use strict'

// FLOW-D10b — read-only Artifact Store retrieval, per the R1 contract in
// docs/FLOW-D10B-ARTIFACT-STORE-CONTRACT.md §3.
//
// Scope is deliberately one slice: existence + descriptor reconciliation during
// input rebind. Writing, GC, retention enforcement, lineage revision allocation
// and cache keys are explicitly NOT here (contract §5) — an unimplemented part
// cannot be retroactively defined by an implementation detail.
//
// The honest bound on what this buys us (contract §4): comparing against the
// fingerprint the Store reports is level L1, and **L1 does not remove trust, it
// moves trust from the resolver to the Store**. A Store that allows in-place
// overwrite without updating the fingerprint fools L1 exactly as well as it
// fools L0. Byte-level certainty is L2 (re-hash the content), which is not
// affordable for ModelCheckpoint-sized artifacts and is not implemented here.

const ARTIFACT_STORE_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'ARTIFACT_NOT_FOUND',
  TYPE_CONFLICT: 'ARTIFACT_TYPE_CONFLICT',
  FINGERPRINT_CONFLICT: 'ARTIFACT_FINGERPRINT_CONFLICT',
  UNAVAILABLE: 'ARTIFACT_STORE_UNAVAILABLE',
})

// Contract §3 Q5: the Store must not offer any way to implicitly resolve "the
// latest" artifact of a lineage. FLOW-D10 R1 Q5 decided that recovery rebinds
// the ORIGINAL revision; that guarantee is structural (an artifact_id already
// names an immutable version) and survives only as long as no such shortcut
// exists. A prohibition that lives only in markdown is not a prohibition, so it
// is enforced at construction time.
const FORBIDDEN_STORE_METHODS = Object.freeze([
  'getLatestByLineage',
  'getLatest',
  'resolveLatest',
  'latestRevision',
  'findLatest',
])

function storeError(code, message, details = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, details)
  return err
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Validates the shape of an injected store. Runs once, at executor construction,
// so a malformed store fails immediately instead of at restart-recovery time —
// which is the one moment the operator least wants a surprise.
function assertReadOnlyArtifactStore(store) {
  if (!isObject(store) && typeof store !== 'function') {
    throw storeError('ARTIFACT_STORE_INVALID', 'artifactStore must be an object')
  }
  if (typeof store.describe !== 'function') {
    throw storeError('ARTIFACT_STORE_INVALID', 'artifactStore must implement describe(artifact_id)')
  }
  for (const forbidden of FORBIDDEN_STORE_METHODS) {
    if (typeof store[forbidden] === 'function') {
      throw storeError(
        'ARTIFACT_STORE_INVALID',
        `artifactStore must not expose '${forbidden}': implicit latest-revision lookup breaks FLOW-D10 R1 Q5`,
        { forbidden_method: forbidden },
      )
    }
  }
  return store
}

// Compares one Store descriptor against the snapshot entry recorded in the Run
// Journal. Pure: no IO, no throwing. Returns a conflict descriptor or null.
//
// Diagnostics carry artifact_id / type / fingerprint only. All three are opaque
// identifiers, never content — FLOW-D10 R1 Q3 applies here unchanged.
function reconcileArtifactDescriptor(key, expected, descriptor) {
  const conflict = (code, extra = {}) => ({ key, code, artifact_id: expected.artifact_id, ...extra })

  if (descriptor === null || descriptor === undefined) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.NOT_FOUND)
  }
  if (!isObject(descriptor)) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.NOT_FOUND, { reason: 'DESCRIPTOR_INVALID' })
  }
  // `exists: false` is a first-class answer, distinct from a null return: a
  // Store may know of an id whose content has been collected.
  if (descriptor.exists === false) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.NOT_FOUND)
  }
  // A descriptor answering about a different id means the Store resolved the
  // lookup to something else — exactly what Q5 forbids.
  if (descriptor.artifact_id !== undefined && descriptor.artifact_id !== expected.artifact_id) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.NOT_FOUND, {
      reason: 'DESCRIPTOR_ID_MISMATCH',
      store_artifact_id: descriptor.artifact_id,
    })
  }
  if (expected.type !== null && expected.type !== undefined
    && descriptor.type !== null && descriptor.type !== undefined
    && descriptor.type !== expected.type) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.TYPE_CONFLICT, {
      expected: expected.type,
      actual: descriptor.type,
    })
  }
  // Contract §8.2 rule 4: a null fingerprint in the snapshot is a pre-FLOW-D26
  // journal entry. Skipping the fingerprint comparison for those is required
  // backward compatibility; skipping the existence check would not be, and is
  // not done — the checks above already ran.
  if (expected.fingerprint !== null && expected.fingerprint !== undefined
    && descriptor.fingerprint !== null && descriptor.fingerprint !== undefined
    && descriptor.fingerprint !== expected.fingerprint) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.FINGERPRINT_CONFLICT, {
      expected: expected.fingerprint,
      actual: descriptor.fingerprint,
    })
  }
  return null
}

// Collects the artifact_ref entries a snapshot refers to.
//
// Contract §8.2 rule 3: only artifact_ref entries are Store business. Asking the
// Store about an inline value would report a perfectly valid inline input as
// ARTIFACT_NOT_FOUND.
function artifactRefsFromSnapshot(snapshot) {
  const refs = []
  for (const [key, entry] of Object.entries(snapshot || {})) {
    if (!isObject(entry) || entry.kind !== 'artifact_ref') continue
    if (!entry.artifact_id) continue
    refs.push({ key, artifact_id: entry.artifact_id, type: entry.type ?? null, fingerprint: entry.fingerprint ?? null })
  }
  return refs
}

// Reference in-memory store. Test/local single-process only: it holds no
// durability, no cross-process visibility (FLOW-D23 stands) and is not the
// production Artifact Store, which remains unimplemented by design.
//
// `ctx` is accepted and ignored — contract Q3: the slot exists so the signature
// need not change when a user model appears, but no permission semantics are
// defined now, because any defined now would be wrong later.
function createMemoryArtifactStore(descriptors = {}) {
  const entries = new Map()
  for (const [artifactId, descriptor] of Object.entries(descriptors)) {
    entries.set(artifactId, { artifact_id: artifactId, exists: true, ...descriptor })
  }
  return {
    async describe(artifactId, _ctx = null) {
      if (!entries.has(artifactId)) return null
      return { ...entries.get(artifactId) }
    },
    async openContent(artifactId, _ctx = null) {
      throw storeError(
        'ARTIFACT_CONTENT_UNSUPPORTED',
        'memory artifact store does not serve content; content verification is L2 and out of the D10b slice',
        { artifact_id: artifactId },
      )
    },
  }
}

module.exports = {
  ARTIFACT_STORE_ERROR_CODES,
  FORBIDDEN_STORE_METHODS,
  assertReadOnlyArtifactStore,
  reconcileArtifactDescriptor,
  artifactRefsFromSnapshot,
  createMemoryArtifactStore,
}
