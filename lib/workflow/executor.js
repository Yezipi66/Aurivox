'use strict'

const crypto = require('crypto')
const { getNodeDefinition } = require('./nodeRegistry')
const { createJournal } = require('./runJournal')
const { createGateInstance, resolveGate } = require('./humanGate')
const {
  ARTIFACT_STORE_ERROR_CODES,
  assertReadOnlyArtifactStore,
  reconcileArtifactDescriptor,
  artifactRefsFromSnapshot,
} = require('./artifactStore')

const TERMINAL_RUN_STATES = new Set(['succeeded', 'rejected', 'failed', 'cancelled', 'stale'])
const COMPLETED_NODE_STATES = new Set(['succeeded', 'skipped'])

// FLOW-D06: a retry is only allowed when the side effects of the failed attempt
// are explicitly accounted for. A handler proves it by reporting side_effects,
// or the workflow author declares the node idempotent in retry_policy.
const RETRY_SIDE_EFFECT_DECLARATIONS = new Set(['none', 'idempotent'])

// FLOW-D10a: an inputResolver may rebind runtime inputs after a restart, but it
// is never trusted blindly. Every rebound value is reconciled against the
// workflow_input_snapshot already recorded in the Run Journal. See
// docs/FLOW-D10-INPUT-REBIND-CONTRACT.md for the frozen contract.
//
// Known limit (contract R1 section 2.6): reconciling an artifact_ref proves the
// reference is identical, not that the bytes are identical. Content-level
// verification depends on the Artifact Store and belongs to FLOW-D10b.
//
// FLOW-D10b: when an artifactStore is injected, rebound artifact_refs are also
// checked for existence and descriptor agreement against the Store. See
// docs/FLOW-D10B-ARTIFACT-STORE-CONTRACT.md (R1).
//
// The store is OPTIONAL. With none injected, behaviour is exactly D10a's: this
// slice adds an enhancement, it must not invent a new way for single-process
// runs to fail.

function executorError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

// Journal records retain enough information to rebind inputs after restart,
// but never copy arbitrary text/audio payloads into the durable Run Journal.
// Artifact-like inputs keep identity/fingerprint; primitives keep a digest and
// size. The live value remains in the process or is resolved by inputResolver.
function inputSnapshot(inputs) {
  const out = {}
  for (const [key, value] of Object.entries(inputs || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && value.artifact_id) {
      out[key] = {
        kind: 'artifact_ref',
        artifact_id: value.artifact_id,
        type: value.type || null,
        fingerprint: value.fingerprint || null,
      }
      continue
    }
    if (typeof value === 'string') {
      out[key] = { kind: 'inline_digest', type: 'string', length: value.length, digest: digest(value) }
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = { kind: 'inline', type: value === null ? 'null' : typeof value, value }
    } else {
      out[key] = { kind: 'opaque_digest', type: Array.isArray(value) ? 'array' : 'object', digest: digest(value) }
    }
  }
  return out
}

// FLOW-D27 stage 2, contract §4.8 (shape B). Node OUTPUTS get the same
// treatment inputs already had, with one deliberate difference: the fields that
// make an artifact *locatable* are preserved verbatim, only content is reduced
// to a digest. Copying inputSnapshot() wholesale would drop uri and
// fingerprint_kind from the HTTP projection -- turning a data-protection change
// into an API shape change.
//
// The allowlist below is the point: any field added to an artifact in future is
// summarised by default. D27's whole premise is that the default must be safe.
const OUTPUT_IDENTITY_FIELDS = Object.freeze(['artifact_id', 'type', 'uri', 'fingerprint', 'fingerprint_kind'])

// A value is journal-safe when the frozen allowlist already describes it
// completely -- an artifact reference carrying nothing but identity, or a
// primitive. Contract §4.8 says such a value has no "其余字段" to summarise, so
// the snapshot IS the value. Keeping it verbatim costs nothing in protection
// and preserves an existing, tested capability: restart resume via an
// inputResolver, which reads these outputs back out of the Journal.
function isJournalSafeOutput(value) {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return true
  if (value && typeof value === 'object' && !Array.isArray(value) && value.artifact_id) {
    return Object.keys(value).every(key => OUTPUT_IDENTITY_FIELDS.includes(key))
  }
  return false
}

function outputSnapshotValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.artifact_id) {
    const out = {}
    for (const field of OUTPUT_IDENTITY_FIELDS) {
      if (value[field] !== undefined) out[field] = value[field]
    }
    if (out.type === undefined) out.type = null
    if (out.fingerprint === undefined) out.fingerprint = null
    const rest = {}
    let hasRest = false
    for (const [k, v] of Object.entries(value)) {
      if (OUTPUT_IDENTITY_FIELDS.includes(k)) continue
      rest[k] = v
      hasRest = true
    }
    if (hasRest) out.redacted_fields = { kind: 'opaque_digest', keys: Object.keys(rest).sort(), digest: digest(rest) }
    return out
  }
  if (typeof value === 'string') return { kind: 'inline_digest', type: 'string', length: value.length, digest: digest(value) }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return { kind: 'inline', type: value === null ? 'null' : typeof value, value }
  }
  return { kind: 'opaque_digest', type: Array.isArray(value) ? 'array' : 'object', digest: digest(value) }
}

// Contract §4.8, second duty: the PORT KEY SET must survive. executor.js's
// `if (value === undefined) continue` carries the legitimate meaning "this port
// produced no output at all" (optional edges). Collapsing outputs into one blob
// would force a choice between breaking every optional edge and the silent
// degradation §4.4 forbids.
// Returns both the journal-facing snapshot and the list of ports whose real
// value is now held ONLY by the sidecar. Custody is per-port and explicit: a
// downstream reader must never have to guess whether what it found in the
// Journal is the value or a description of it.
function outputSnapshot(outputs) {
  const snapshot = {}
  const custody = []
  for (const [port, value] of Object.entries(outputs || {})) {
    if (value === undefined) continue
    if (isJournalSafeOutput(value)) {
      snapshot[port] = clone(value)
      continue
    }
    snapshot[port] = outputSnapshotValue(value)
    custody.push(port)
  }
  return { snapshot, custody }
}

function outputValueKey(nodeId, attempt, port) {
  return `${nodeId}\u0000${attempt}\u0000${port}`
}

// FLOW-D10a: reconcile one rebound value against its recorded snapshot entry.
// Returns a mismatch descriptor, or null when the value matches.
//
// Diagnostics may carry digests, lengths and artifact identity, but never the
// original text: inline_digest exists precisely so raw payloads stay out of the
// journal, and a rejection path must not undo that.
function reconcileSnapshotEntry(key, expected, actual) {
  const mismatch = (reason, extra = {}) => ({ key, reason, ...extra })
  if (!isObject(expected)) return mismatch('SNAPSHOT_ENTRY_INVALID')

  switch (expected.kind) {
    case 'artifact_ref': {
      if (!isObject(actual) || !actual.artifact_id) {
        return mismatch('KIND_MISMATCH', { expected_kind: 'artifact_ref' })
      }
      if (actual.artifact_id !== expected.artifact_id) {
        return mismatch('ARTIFACT_ID_MISMATCH', {
          expected: expected.artifact_id,
          actual: actual.artifact_id,
        })
      }
      if (expected.fingerprint !== null && expected.fingerprint !== undefined
        && (actual.fingerprint || null) !== expected.fingerprint) {
        return mismatch('ARTIFACT_FINGERPRINT_MISMATCH', {
          expected: expected.fingerprint,
          actual: actual.fingerprint || null,
        })
      }
      if (expected.type !== null && expected.type !== undefined
        && (actual.type || null) !== expected.type) {
        return mismatch('ARTIFACT_TYPE_MISMATCH', {
          expected: expected.type,
          actual: actual.type || null,
        })
      }
      return null
    }
    case 'inline_digest': {
      if (typeof actual !== 'string') {
        return mismatch('KIND_MISMATCH', { expected_kind: 'inline_digest' })
      }
      if (actual.length !== expected.length) {
        return mismatch('LENGTH_MISMATCH', {
          expected_length: expected.length,
          actual_length: actual.length,
        })
      }
      const actualDigest = digest(actual)
      if (actualDigest !== expected.digest) {
        return mismatch('DIGEST_MISMATCH', {
          expected_digest: expected.digest,
          actual_digest: actualDigest,
        })
      }
      return null
    }
    case 'inline': {
      const isPrimitive = actual === null || typeof actual === 'number' || typeof actual === 'boolean'
      if (!isPrimitive) return mismatch('KIND_MISMATCH', { expected_kind: 'inline' })
      // Object.is keeps NaN reflexive and separates -0 from 0.
      if (!Object.is(actual, expected.value)) {
        return mismatch('VALUE_MISMATCH', { expected: expected.value, actual })
      }
      return null
    }
    case 'opaque_digest': {
      if (actual === null || typeof actual !== 'object') {
        return mismatch('KIND_MISMATCH', { expected_kind: 'opaque_digest' })
      }
      const actualType = Array.isArray(actual) ? 'array' : 'object'
      if (actualType !== expected.type) {
        return mismatch('KIND_MISMATCH', { expected_kind: expected.type, actual_kind: actualType })
      }
      const actualDigest = digest(actual)
      if (actualDigest !== expected.digest) {
        return mismatch('DIGEST_MISMATCH', {
          expected_digest: expected.digest,
          actual_digest: actualDigest,
        })
      }
      return null
    }
    default:
      return mismatch('SNAPSHOT_ENTRY_INVALID', { expected_kind: expected.kind })
  }
}

// FLOW-D10a: full reconciliation, including both directions of the key set.
// UNEXPECTED_KEY has to fail too: an extra key reaches _drive() and may be read
// by a node, which would be an input the journal never recorded.
function reconcileRuntimeInputs(snapshot, resolved) {
  const mismatches = []
  const expectedKeys = Object.keys(snapshot || {})
  const actualKeys = Object.keys(resolved || {})

  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(resolved || {}, key)) {
      mismatches.push({ key, reason: 'MISSING_KEY' })
      continue
    }
    const mismatch = reconcileSnapshotEntry(key, snapshot[key], resolved[key])
    if (mismatch) mismatches.push(mismatch)
  }

  for (const key of actualKeys) {
    if (!Object.prototype.hasOwnProperty.call(snapshot || {}, key)) {
      mismatches.push({ key, reason: 'UNEXPECTED_KEY' })
    }
  }

  return mismatches
}

function defaultRunId() {
  return `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
}

// FLOW-D07: cancellation is cooperative. The executor observes the abort signal
// itself instead of relying on a handler to notice it.
function isAborted(signal) {
  return Boolean(signal && signal.aborted)
}

function cancellationReason(signal) {
  const reason = signal ? signal.reason : null
  if (reason && typeof reason === 'object' && typeof reason.code === 'string' && reason.code) return reason.code
  if (typeof reason === 'string' && reason) return reason
  return 'RUN_CANCELLED_BY_SIGNAL'
}

function retrySideEffectDeclaration(node, error) {
  if (error && typeof error.side_effects === 'string' && RETRY_SIDE_EFFECT_DECLARATIONS.has(error.side_effects)) {
    return { declared: true, source: 'handler_error.side_effects', value: error.side_effects }
  }
  if (node && node.retry_policy && node.retry_policy.idempotent === true) {
    return { declared: true, source: 'node.retry_policy.idempotent', value: 'idempotent' }
  }
  return { declared: false, source: null, value: null }
}

function assertPlan(plan) {
  if (!isObject(plan) || plan.schema !== 'aurivox.run_plan' || plan.schema_version !== 1) {
    throw executorError('RUN_PLAN_INVALID', 'Executor requires an aurivox.run_plan/v1 object')
  }
  if (typeof plan.workflow_id !== 'string' || typeof plan.workflow_revision_id !== 'string' || typeof plan.run_plan_fingerprint !== 'string') {
    throw executorError('RUN_PLAN_IDENTITY_INVALID', 'Run Plan must contain workflow_id, workflow_revision_id and run_plan_fingerprint')
  }
  if (!Array.isArray(plan.node_order) || !Array.isArray(plan.nodes) || !Array.isArray(plan.edges)) {
    throw executorError('RUN_PLAN_GRAPH_INVALID', 'Run Plan must contain node_order, nodes and edges arrays')
  }
}

function assertStore(store) {
  for (const method of ['create', 'read', 'append', 'replay']) {
    if (!store || typeof store[method] !== 'function') throw executorError('JOURNAL_STORE_INVALID', `journalStore.${method}() is required`)
  }
}

function nodeMap(plan) {
  return new Map(plan.nodes.map(node => [node.id, node]))
}

function incomingEdges(plan, nodeId) {
  return plan.edges.filter(edge => edge && edge.to && edge.to.node === nodeId)
}

function sourceOutputs(projection, nodeId) {
  return projection.node_runs[nodeId]?.outputs || {}
}

function nodeStatus(projection, nodeId) {
  return projection.node_runs[nodeId]?.status || null
}

function nodeReady(plan, projection, node) {
  const incoming = incomingEdges(plan, node.id)
  return incoming.every(edge => COMPLETED_NODE_STATES.has(nodeStatus(projection, edge.from.node)))
}

function blockedNodeDiagnostics(plan, projection) {
  return plan.node_order
    .filter(nodeId => !COMPLETED_NODE_STATES.has(nodeStatus(projection, nodeId)))
    .map(nodeId => ({
      node_id: nodeId,
      status: nodeStatus(projection, nodeId),
      waiting_on: incomingEdges(plan, nodeId).map(edge => ({
        node_id: edge.from.node,
        status: nodeStatus(projection, edge.from.node),
        edge_id: edge.id,
      })),
    }))
}

function collectNodeInputs(plan, projection, node, workflowInputs, readOutput) {
  const definition = getNodeDefinition(node.type, node.type_version || 1)
  if (!definition) throw executorError('UNKNOWN_NODE_TYPE', `No definition for '${node.type}@${node.type_version || 1}'`, { node_id: node.id })
  const inputs = {}
  for (const edge of incomingEdges(plan, node.id)) {
    if (edge.condition !== undefined && edge.condition !== null) throw executorError('EXECUTION_CONDITION_UNSUPPORTED', `Executor skeleton does not evaluate edge condition '${edge.id}'`, { edge_id: edge.id })
    const value = readOutput(edge.from.node, edge.from.port)
    if (value === undefined) continue
    const targetPort = definition.inputs[edge.to.port]
    if (targetPort?.multiple) {
      if (!Array.isArray(inputs[edge.to.port])) inputs[edge.to.port] = []
      if (Array.isArray(value)) inputs[edge.to.port].push(...clone(value))
      else inputs[edge.to.port].push(clone(value))
    } else {
      inputs[edge.to.port] = clone(value)
    }
  }
  for (const [port, binding] of Object.entries(node.bindings || {})) {
    if (!binding || typeof binding.workflow_input !== 'string') continue
    const value = workflowInputs[binding.workflow_input]
    if (value === undefined) throw executorError('WORKFLOW_INPUT_VALUE_MISSING', `Missing runtime value for workflow input '${binding.workflow_input}'`, { node_id: node.id, port })
    inputs[port] = clone(value)
  }
  return inputs
}

function effectiveNodeAttempt(projection, nodeId) {
  const prior = projection.node_runs[nodeId]
  return Number.isInteger(prior?.node_attempt) ? prior.node_attempt + 1 : 1
}

class WorkflowExecutor {
  constructor({ journalStore, handlers = {}, idFactory = defaultRunId, clock = () => new Date().toISOString(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), inputResolver = null, artifactStore = null } = {}) {
    assertStore(journalStore)
    if (inputResolver !== null && typeof inputResolver !== 'function') throw executorError('INPUT_RESOLVER_INVALID', 'inputResolver must be a function when provided')
    // FLOW-D10b: validate the store's shape now, not at restart-recovery time.
    // Recovery is the worst possible moment to discover a malformed store, and
    // the Q5 prohibition is enforced here rather than left to documentation.
    if (artifactStore !== null) assertReadOnlyArtifactStore(artifactStore)
    this.journalStore = journalStore
    this.handlers = handlers instanceof Map ? handlers : new Map(Object.entries(handlers || {}))
    this.idFactory = idFactory
    this.clock = clock
    this.sleep = sleep
    this.inputResolver = inputResolver
    this.artifactStore = artifactStore
    this.runtimeInputs = new Map()
    // FLOW-D27 stage 2 (contract §4.2/§4.3/§4.5). Real node output VALUES live
    // here, never in the durable Journal. Keyed run_id -> (node_id, attempt,
    // port) so a D06 retry cannot serve a stale attempt's value to a downstream
    // node, and so sibling ports cannot overwrite each other.
    this.outputValues = new Map()
  }

  _stageOutputValues(runId, nodeId, attempt, outputs, ports) {
    const keys = []
    if (ports.length === 0) return keys
    if (!this.outputValues.has(runId)) this.outputValues.set(runId, new Map())
    const bucket = this.outputValues.get(runId)
    for (const port of ports) {
      const value = (outputs || {})[port]
      if (value === undefined) continue
      const key = outputValueKey(nodeId, attempt, port)
      bucket.set(key, clone(value))
      keys.push(key)
    }
    return keys
  }

  // Contract §4.6: the Journal is the authority. If the NODE_SUCCEEDED event
  // never commits, no sidecar value for that attempt may remain addressable --
  // otherwise this slice invents a state that did not previously exist.
  _discardOutputValues(runId, keys) {
    const bucket = this.outputValues.get(runId)
    if (!bucket) return
    for (const key of keys) bucket.delete(key)
    if (bucket.size === 0) this.outputValues.delete(runId)
  }

  // Contract §4.5 rule 4: which attempt is authoritative is decided by the
  // replay projection, never by what happens to still be in the sidecar.
  _readNodeOutput(runId, projection, nodeId, port) {
    const nodeRun = projection.node_runs[nodeId]
    const outputs = nodeRun?.outputs || {}
    if (!(port in outputs) || outputs[port] === undefined) return undefined
    // Gate outputs (GATE_RESOLVED), journal-safe identity refs, and journals
    // written before stage 2 keep their values in the Journal itself and are
    // read from there unchanged.
    const custody = Array.isArray(nodeRun.outputs_custody) ? nodeRun.outputs_custody : []
    if (!custody.includes(port)) return outputs[port]
    const attempt = nodeRun.node_attempt
    const key = outputValueKey(nodeId, attempt, port)
    const bucket = this.outputValues.get(runId)
    if (!bucket || !bucket.has(key)) {
      // Contract §4.4/§4.7: fail closed. Handing the handler a digest or the
      // snapshot object would be a silent semantic corruption -- the exact
      // failure mode this slice exists to prevent.
      throw executorError(
        'NODE_OUTPUT_VALUE_UNAVAILABLE',
        `Run '${runId}' has no runtime value for output '${nodeId}.${port}' (attempt ${attempt}); the Journal records the node as complete but the value is not held by this Executor`,
        { run_id: runId, node_id: nodeId, node_attempt: attempt === undefined ? null : attempt, output_port: port, retryable: false },
      )
    }
    return bucket.get(key)
  }

  _outputReader(runId, projection) {
    return (nodeId, port) => this._readNodeOutput(runId, projection, nodeId, port)
  }

  async _append(runId, event) {
    return this.journalStore.append(runId, {
      ...event,
      created_at: event.created_at || this.clock(),
    })
  }

  // FLOW-D21: runtime inputs are process-local and must not outlive the Run.
  // Every executor exit point goes through _settle so a terminal Run drops its
  // in-memory payload; awaiting_human_review deliberately keeps it for resume.
  async _settle(runId) {
    const projection = await this.journalStore.replay(runId)
    if (TERMINAL_RUN_STATES.has(projection.status)) {
      this.runtimeInputs.delete(runId)
      // FLOW-D27 §4.3: every terminal outcome releases the sidecar --
      // succeeded, failed, rejected, cancelled and stale alike.
      this.outputValues.delete(runId)
    }
    return projection
  }

  async _abortableSleep(ms, signal) {
    if (!(ms > 0)) return
    if (isAborted(signal)) return
    if (!signal || typeof signal.addEventListener !== 'function') {
      await this.sleep(ms)
      return
    }
    let onAbort = null
    try {
      await Promise.race([
        this.sleep(ms),
        new Promise(resolve => {
          // Re-check inside the executor: an abort raised between the entry
          // check and this registration would otherwise be a lost wakeup and
          // leave the Run waiting on the full backoff.
          if (signal.aborted) {
            resolve()
            return
          }
          onAbort = () => resolve()
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      if (onAbort && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    }
  }

  async _cancel(runId, signal, node = null, attempt = null) {
    const reason = cancellationReason(signal)
    if (node) {
      await this._append(runId, {
        event_id: `${runId}_${node.id}_cancelled_${attempt}`,
        type: 'NODE_CANCELLED',
        payload: {
          node: {
            node_id: node.id,
            node_attempt: attempt,
            status: 'cancelled',
            error: { code: reason, message: `Node '${node.id}' was cancelled before completing attempt ${attempt}` },
          },
        },
      })
    }
    await this._append(runId, {
      event_id: `${runId}_cancelled`,
      type: 'RUN_CANCELLED',
      payload: { reason, cancelled_node_id: node ? node.id : null },
    })
    return this._settle(runId)
  }

  _handler(type) {
    const handler = this.handlers.get(type)
    if (typeof handler !== 'function') throw executorError('NODE_HANDLER_NOT_FOUND', `No execution handler registered for '${type}'`, { type })
    return handler
  }

  _assertPlanMatches(projection, plan) {
    if (projection.workflow_id !== plan.workflow_id || projection.workflow_revision_id !== plan.workflow_revision_id || projection.run_plan_fingerprint !== plan.run_plan_fingerprint) {
      throw executorError('RUN_PLAN_MISMATCH', 'The supplied Run Plan does not match the Run Journal identity', {
        run_id: projection.run_id,
        journal: {
          workflow_id: projection.workflow_id,
          workflow_revision_id: projection.workflow_revision_id,
          run_plan_fingerprint: projection.run_plan_fingerprint,
        },
        plan: {
          workflow_id: plan.workflow_id,
          workflow_revision_id: plan.workflow_revision_id,
          run_plan_fingerprint: plan.run_plan_fingerprint,
        },
      })
    }
  }

  // FLOW-D10b (contract R1 §3.2 / §8.3). Runs only AFTER the D10a reconciliation
  // has passed, and the order is deliberate: the Run Journal is local and
  // append-only, the Store is externally mutable state. Trusting the stronger
  // source first means a poisoned Store still cannot get past D10a.
  async _verifyArtifactsAgainstStore(runId, snapshot) {
    if (!this.artifactStore) return
    const refs = artifactRefsFromSnapshot(snapshot)
    if (refs.length === 0) return

    const conflicts = []
    for (const ref of refs) {
      let descriptor
      try {
        descriptor = await this.artifactStore.describe(ref.artifact_id, { run_id: runId })
      } catch (err) {
        // Q6: reaching the Store failing is categorically different from the
        // artifact being absent. Any throw is treated as infrastructure trouble
        // and marked retryable — misreading a transient outage as "the artifact
        // was garbage collected" would turn a wait into a permanent loss.
        throw executorError(
          ARTIFACT_STORE_ERROR_CODES.UNAVAILABLE,
          `Run '${runId}' could not reach the artifact store`,
          { run_id: runId, artifact_id: ref.artifact_id, retryable: true, cause: err },
        )
      }
      const conflict = reconcileArtifactDescriptor(ref.key, ref, descriptor)
      if (conflict) conflicts.push(conflict)
    }

    if (conflicts.length > 0) {
      // Like D10a, this is not appended to the Run Journal (FLOW-D10 R1 Q4):
      // it happens before the run's identity is re-established.
      throw executorError(
        'WORKFLOW_INPUT_ARTIFACT_CONFLICT',
        `Run '${runId}' rebound artifacts do not agree with the artifact store`,
        { run_id: runId, retryable: false, conflicts },
      )
    }
  }

  async _resolveRuntimeInputs(runId, plan, projection) {
    if (this.runtimeInputs.has(runId)) return clone(this.runtimeInputs.get(runId))
    if (this.inputResolver) {
      const snapshot = clone(projection.workflow_input_snapshot || {})
      const resolved = await this.inputResolver({
        run_id: runId,
        plan: clone(plan),
        snapshot: clone(snapshot),
      })
      if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) throw executorError('WORKFLOW_INPUT_REBIND_INVALID', 'inputResolver must return an object')
      // FLOW-D10a: a resolver is not trusted on its word. Rebound inputs must
      // reconcile with the snapshot recorded when the run first started, or the
      // run would silently continue on inputs it never claims to have used.
      // Fail-closed: no warn-and-continue, no partial acceptance.
      const mismatches = reconcileRuntimeInputs(snapshot, resolved)
      if (mismatches.length > 0) {
        throw executorError('WORKFLOW_INPUT_REBIND_MISMATCH', `Run '${runId}' input rebind does not match recorded snapshot`, {
          run_id: runId,
          mismatches,
        })
      }
      // FLOW-D10b: only now, with the snapshot agreement established, is it
      // worth asking the external store whether those artifacts still exist.
      await this._verifyArtifactsAgainstStore(runId, snapshot)
      this.runtimeInputs.set(runId, clone(resolved))
      return clone(resolved)
    }
    throw executorError('WORKFLOW_INPUT_REBIND_REQUIRED', `Run '${runId}' needs runtime input rebind after restart`, { run_id: runId, snapshot: clone(projection.workflow_input_snapshot || {}) })
  }

  async start(plan, { run_id = null, inputs = {}, signal = null } = {}) {
    assertPlan(plan)
    const runId = run_id || this.idFactory()
    this.runtimeInputs.set(runId, clone(inputs))
    const journal = createJournal(runId, {
      workflow_id: plan.workflow_id,
      workflow_revision_id: plan.workflow_revision_id,
      workflow_fingerprint: plan.workflow_fingerprint,
      run_plan_fingerprint: plan.run_plan_fingerprint,
    })
    await this.journalStore.create(journal)
    await this._append(runId, {
      event_id: `${runId}_created`,
      type: 'RUN_CREATED',
      payload: {
        workflow_id: plan.workflow_id,
        workflow_revision_id: plan.workflow_revision_id,
        workflow_fingerprint: plan.workflow_fingerprint,
        run_plan_fingerprint: plan.run_plan_fingerprint,
        workflow_input_snapshot: inputSnapshot(inputs),
      },
    })
    await this._append(runId, { event_id: `${runId}_validated`, type: 'RUN_VALIDATED' })
    await this._append(runId, { event_id: `${runId}_queued`, type: 'RUN_QUEUED' })
    await this._append(runId, { event_id: `${runId}_started`, type: 'RUN_STARTED' })
    return this._drive(runId, plan, inputs, signal)
  }

  async resume(runId, plan, { gate_id, expected_gate_revision, decision, operator, comment, outputs = {}, signal = null } = {}) {
    assertPlan(plan)
    const projection = await this.journalStore.replay(runId)
    this._assertPlanMatches(projection, plan)
    if (projection.status !== 'awaiting_human_review') throw executorError('RUN_NOT_AWAITING_REVIEW', `Run '${runId}' is not awaiting human review`, { run_id: runId })
    const gate = projection.gates[gate_id]
    if (!gate) throw executorError('GATE_NOT_FOUND', `Gate '${gate_id}' does not belong to Run '${runId}'`, { run_id: runId, gate_id })
    if (decision === 'approve' || decision === 'submit_revision') await this._resolveRuntimeInputs(runId, plan, projection)
    const resolved = resolveGate(gate, {
      expected_gate_revision,
      decision,
      operator,
      comment,
      outputs,
      timestamp: this.clock(),
    })
    await this._append(runId, {
      event_id: `${gate_id}_resolved_${resolved.gate.gate_revision}`,
      type: 'GATE_RESOLVED',
      payload: {
        gate: resolved.gate,
        review_record: resolved.review_record,
      },
    })
    if (resolved.run_outcome === 'resuming') {
      await this._append(runId, { event_id: `${gate_id}_resumed_${resolved.gate.gate_revision}`, type: 'RUN_RESUMED' })
      return this._drive(runId, plan, undefined, signal)
    }
    return this._settle(runId)
  }

  async _fail(runId, node, attempt, error) {
    const failure = {
      code: error.code || 'NODE_EXECUTION_FAILED',
      message: error.message || String(error),
      ...(Array.isArray(error.blocked_nodes) ? { blocked_nodes: clone(error.blocked_nodes) } : {}),
      ...(error.retryable === false ? { retryable: false } : {}),
      ...(isObject(error.cause) ? { cause: clone(error.cause) } : {}),
    }
    await this._append(runId, {
      event_id: `${runId}_${node.id}_failed_${attempt}`,
      type: 'NODE_FAILED',
      payload: { node: { node_id: node.id, node_attempt: attempt, status: 'failed', error: failure } },
    })
    await this._append(runId, {
      event_id: `${runId}_failed_${attempt}_${node.id}`,
      type: 'RUN_FAILED',
      payload: { error: failure },
    })
    return this._settle(runId)
  }

  async _drive(runId, plan, runtimeInputs, signal) {
    let projection = await this.journalStore.replay(runId)
    this._assertPlanMatches(projection, plan)
    const inputs = runtimeInputs === undefined
      ? await this._resolveRuntimeInputs(runId, plan, projection)
      : clone(runtimeInputs)

    if (TERMINAL_RUN_STATES.has(projection.status)) return this._settle(runId)
    if (projection.status === 'awaiting_human_review') return projection
    if (projection.status === 'resuming') {
      await this._append(runId, { event_id: `${runId}_resumed_${projection.last_sequence}`, type: 'RUN_RESUMED' })
      projection = await this.journalStore.replay(runId)
    }

    const nodes = nodeMap(plan)
    while (true) {
      projection = await this.journalStore.replay(runId)
      if (TERMINAL_RUN_STATES.has(projection.status)) return this._settle(runId)
      if (projection.status === 'awaiting_human_review') return projection
      if (isAborted(signal)) return this._cancel(runId, signal)
      let progressed = false

      for (const nodeId of plan.node_order) {
        const node = nodes.get(nodeId)
        if (!node) throw executorError('RUN_PLAN_NODE_MISSING', `Run Plan node '${nodeId}' is missing`)
        const currentStatus = nodeStatus(projection, node.id)
        if (COMPLETED_NODE_STATES.has(currentStatus)) continue
        if (currentStatus === 'waiting') return projection
        if (!nodeReady(plan, projection, node)) continue

        const attempt = effectiveNodeAttempt(projection, node.id)
        let inputsForNode
        try {
          inputsForNode = collectNodeInputs(plan, projection, node, inputs, this._outputReader(runId, projection))
        } catch (error) {
          if (error && error.code === 'NODE_OUTPUT_VALUE_UNAVAILABLE') return this._fail(runId, node, attempt, error)
          throw error
        }
        if (node.disabled) {
          await this._append(runId, {
            event_id: `${runId}_${node.id}_skipped_${attempt}`,
            type: 'NODE_SKIPPED',
            payload: { node: { node_id: node.id, node_attempt: attempt, status: 'skipped', outputs: {} } },
          })
          progressed = true
          break
        }

        let handler
        try {
          handler = this._handler(node.type)
        } catch (error) {
          return this._fail(runId, node, attempt, error)
        }
        await this._append(runId, {
          event_id: `${runId}_${node.id}_started_${attempt}`,
          type: 'NODE_STARTED',
          payload: { node: { node_id: node.id, node_attempt: attempt, status: 'running', input_snapshot: inputSnapshot(inputsForNode) } },
        })

        try {
          const result = await handler({
            node: clone(node),
            inputs: inputsForNode,
            workflow_inputs: clone(inputs),
            run_id: runId,
            node_attempt: attempt,
            plan: clone(plan),
            projection,
            signal,
          })
          if (!result || typeof result !== 'object') throw executorError('NODE_RESULT_INVALID', `Handler '${node.type}' must return a result object`, { node_id: node.id })
          if (result.status === 'waiting') {
            const gate = result.gate
            if (!gate || gate.gate_id === undefined || gate.node_id !== node.id || gate.run_id !== runId || gate.node_attempt !== attempt || gate.status !== 'awaiting_review') {
              throw executorError('GATE_RESULT_INVALID', `Handler '${node.type}' returned an invalid waiting Gate`, { node_id: node.id })
            }
            await this._append(runId, {
              event_id: `${runId}_${node.id}_gate_${gate.gate_id}`,
              type: 'GATE_CREATED',
              payload: { gate: clone(gate) },
            })
            return this._settle(runId)
          }
          if (result.status !== undefined && result.status !== 'succeeded' && result.status !== 'skipped') throw executorError('NODE_RESULT_STATUS_INVALID', `Handler '${node.type}' returned unsupported status '${result.status}'`, { node_id: node.id })
          // FLOW-D27 §4.6. Order here is an implementation choice the contract
          // deliberately leaves open; staging first and rolling back on a failed
          // append makes interleaving B -- "Journal says succeeded, the real
          // value is gone" -- structurally unreachable in-process.
          const { snapshot, custody } = outputSnapshot(result.outputs || {})
          const staged = this._stageOutputValues(runId, node.id, attempt, result.outputs || {}, custody)
          try {
            await this._append(runId, {
              event_id: `${runId}_${node.id}_succeeded_${attempt}`,
              type: result.status === 'skipped' ? 'NODE_SKIPPED' : 'NODE_SUCCEEDED',
              payload: {
                node: {
                  node_id: node.id,
                  node_attempt: attempt,
                  status: result.status === 'skipped' ? 'skipped' : 'succeeded',
                  input_snapshot: inputSnapshot(inputsForNode),
                  outputs: snapshot,
                  outputs_custody: custody,
                  metrics: clone(result.metrics || {}),
                },
              },
            })
          } catch (appendError) {
            this._discardOutputValues(runId, staged)
            throw appendError
          }
          progressed = true
          break
        } catch (error) {
          if (isAborted(signal)) return this._cancel(runId, signal, node, attempt)
          const retryPolicy = node.retry_policy || { max_attempts: 1, backoff_ms: 0 }
          const maxAttempts = Number.isInteger(retryPolicy.max_attempts) ? retryPolicy.max_attempts : 1
          const retryable = error && error.retryable === true
          const sideEffects = retrySideEffectDeclaration(node, error)
          // FLOW-D06: never silently re-run a handler whose side effects are
          // unaccounted for. Without a declaration the Run fails closed.
          if (retryable && attempt < maxAttempts && !sideEffects.declared) {
            return this._fail(runId, node, attempt, executorError(
              'NODE_RETRY_BLOCKED_SIDE_EFFECTS',
              `Node '${node.id}' reported a retryable failure but did not declare that retrying is side-effect free`,
              {
                node_id: node.id,
                retryable: false,
                cause: { code: error.code || 'NODE_RETRYABLE_FAILURE', message: error.message || String(error) },
              },
            ))
          }
          if (retryable && attempt < maxAttempts) {
            const backoff = Number.isFinite(retryPolicy.backoff_ms) ? retryPolicy.backoff_ms * (2 ** Math.max(0, attempt - 1)) : 0
            await this._append(runId, {
              event_id: `${runId}_${node.id}_retry_${attempt}`,
              type: 'NODE_RETRY_SCHEDULED',
              payload: {
                node: {
                  node_id: node.id,
                  node_attempt: attempt,
                  status: 'retry_waiting',
                  error: { code: error.code || 'NODE_RETRYABLE_FAILURE', message: error.message || String(error) },
                  next_attempt: attempt + 1,
                  backoff_ms: backoff,
                  side_effect_declaration: { source: sideEffects.source, value: sideEffects.value },
                },
              },
            })
            await this._abortableSleep(backoff, signal)
            if (isAborted(signal)) return this._cancel(runId, signal, node, attempt)
            progressed = true
            break
          }
          return this._fail(runId, node, attempt, error)
        }
      }

      if (progressed) continue
      projection = await this.journalStore.replay(runId)
      const allDone = plan.node_order.every(nodeId => COMPLETED_NODE_STATES.has(nodeStatus(projection, nodeId)))
      if (allDone) {
        await this._append(runId, { event_id: `${runId}_succeeded`, type: 'RUN_SUCCEEDED' })
        return this._settle(runId)
      }
      return this._fail(
        runId,
        { id: '__scheduler__', type: 'executor' },
        1,
        executorError('EXECUTION_DEADLOCK', 'No executable node remains and Run is not terminal', {
          blocked_nodes: blockedNodeDiagnostics(plan, projection),
        }),
      )
    }
  }
}

module.exports = {
  COMPLETED_NODE_STATES,
  TERMINAL_RUN_STATES,
  WorkflowExecutor,
}
