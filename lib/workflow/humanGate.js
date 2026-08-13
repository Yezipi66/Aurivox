'use strict'

const { HUMAN_GATE_DECISIONS } = require('./nodeRegistry')
const { transitionGate } = require('./runState')

function gateError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function artifactId(ref) {
  if (typeof ref === 'string' && ref) return ref
  if (ref && typeof ref === 'object' && typeof ref.artifact_id === 'string' && ref.artifact_id) return ref.artifact_id
  return null
}

function artifactIds(refs) {
  return (Array.isArray(refs) ? refs : []).map(artifactId).filter(Boolean)
}

function assertNonEmptyString(value, code, message) {
  if (typeof value !== 'string' || !value.trim()) throw gateError(code, message)
}

function assertDecisions(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) throw gateError('GATE_DECISIONS_REQUIRED', 'Human Gate needs at least one decision')
  const seen = new Set()
  for (const decision of decisions) {
    if (!HUMAN_GATE_DECISIONS.includes(decision)) throw gateError('GATE_DECISION_NOT_SUPPORTED', `Unsupported Human Gate decision '${decision}'`)
    if (seen.has(decision)) throw gateError('GATE_DECISION_DUPLICATE', `Duplicate Human Gate decision '${decision}'`)
    seen.add(decision)
  }
}

function createGateInstance({
  gate_id,
  run_id,
  node_id,
  node_attempt = 1,
  review_schema,
  input_artifacts,
  decisions,
  workflow_revision_id = null,
  run_plan_fingerprint = null,
  created_at = new Date().toISOString(),
}) {
  assertNonEmptyString(gate_id, 'GATE_ID_REQUIRED', 'gate_id is required')
  assertNonEmptyString(run_id, 'RUN_ID_REQUIRED', 'run_id is required')
  assertNonEmptyString(node_id, 'NODE_ID_REQUIRED', 'node_id is required')
  assertNonEmptyString(review_schema, 'GATE_SCHEMA_REQUIRED', 'review_schema is required')
  if (!Number.isInteger(node_attempt) || node_attempt < 1) throw gateError('NODE_ATTEMPT_INVALID', 'node_attempt must be a positive integer')
  if (!Array.isArray(input_artifacts) || input_artifacts.length === 0 || input_artifacts.some(ref => !artifactId(ref))) {
    throw gateError('GATE_INPUT_ARTIFACTS_REQUIRED', 'Human Gate needs at least one valid input ArtifactRef')
  }
  assertDecisions(decisions)

  return {
    gate_id,
    run_id,
    node_id,
    node_attempt,
    gate_revision: 1,
    status: 'awaiting_review',
    review_schema,
    workflow_revision_id,
    run_plan_fingerprint,
    input_artifacts: clone(input_artifacts),
    available_decisions: [...decisions],
    created_at,
    resolved_at: null,
    decision: null,
    operator: null,
    comment: null,
    output_artifacts: {},
  }
}

function validateRevisionArtifacts(gate, revised) {
  if (!Array.isArray(revised) || revised.length === 0) throw gateError('REVISION_ARTIFACT_REQUIRED', 'submit_revision requires at least one revised ArtifactRef')
  const parents = new Set(artifactIds(gate.input_artifacts))
  for (const ref of revised) {
    const id = artifactId(ref)
    if (!id || !ref || typeof ref !== 'object') throw gateError('REVISION_ARTIFACT_INVALID', 'Each revised Artifact must be an object with artifact_id and lineage')
    const lineage = ref.lineage
    if (!lineage || typeof lineage !== 'object') throw gateError('REVISION_LINEAGE_REQUIRED', `Revised Artifact '${id}' needs lineage`)
    if (typeof lineage.lineage_id !== 'string' || !lineage.lineage_id) throw gateError('REVISION_LINEAGE_INVALID', `Revised Artifact '${id}' needs lineage.lineage_id`)
    if (!Number.isInteger(lineage.revision) || lineage.revision < 1) throw gateError('REVISION_NUMBER_INVALID', `Revised Artifact '${id}' needs a positive lineage.revision`)
    if (!parents.has(lineage.parent_artifact_id)) throw gateError('REVISION_PARENT_INVALID', `Revised Artifact '${id}' must name one of the Gate input Artifacts as parent`)
  }
}

function resolveGate(gate, {
  expected_gate_revision,
  decision,
  operator = 'local-user',
  comment = null,
  outputs = {},
  timestamp = new Date().toISOString(),
}) {
  if (!gate || typeof gate !== 'object') throw gateError('GATE_INVALID', 'Gate instance must be an object')
  if (gate.status === 'resolved') throw gateError('GATE_ALREADY_RESOLVED', `Gate '${gate.gate_id}' is already resolved`)
  if (gate.status === 'invalidated') throw gateError('GATE_INVALIDATED', `Gate '${gate.gate_id}' is invalidated`)
  if (gate.status === 'superseded') throw gateError('GATE_SUPERSEDED', `Gate '${gate.gate_id}' is superseded`)
  if (gate.status !== 'awaiting_review') throw gateError('GATE_NOT_RESOLVABLE', `Gate '${gate.gate_id}' is not awaiting review`)
  if (!Number.isInteger(expected_gate_revision)) throw gateError('GATE_REVISION_REQUIRED', 'expected_gate_revision is required')
  if (expected_gate_revision !== gate.gate_revision) throw gateError('GATE_REVISION_CONFLICT', `Gate '${gate.gate_id}' revision does not match`, { expected_gate_revision, actual_gate_revision: gate.gate_revision })
  if (!gate.available_decisions.includes(decision)) throw gateError('GATE_DECISION_NOT_ALLOWED', `Decision '${decision}' is not enabled for Gate '${gate.gate_id}'`)
  assertNonEmptyString(operator, 'GATE_OPERATOR_REQUIRED', 'operator is required')

  // Resolve is conceptually two phases. The pure model validates the transition
  // without exposing a half-written state; persistence adapters can record the
  // resolving event inside their own atomic boundary.
  transitionGate(gate.status, 'resolving')

  let outputArtifacts = {}
  if (decision === 'approve') {
    const approved = Array.isArray(outputs.approved) && outputs.approved.length ? outputs.approved : gate.input_artifacts
    outputArtifacts = { approved: clone(approved) }
  } else if (decision === 'submit_revision') {
    validateRevisionArtifacts(gate, outputs.revised)
    outputArtifacts = { revised: clone(outputs.revised) }
  } else if (decision === 'reject') {
    outputArtifacts = { rejected: null }
  } else if (decision === 'cancel') {
    outputArtifacts = {}
  }

  const nextRevision = gate.gate_revision + 1
  const reviewRecord = {
    review_record_id: `review_${gate.gate_id}_${nextRevision}`,
    gate_id: gate.gate_id,
    run_id: gate.run_id,
    node_id: gate.node_id,
    node_attempt: gate.node_attempt,
    decision,
    operator,
    timestamp,
    comment,
    review_schema: gate.review_schema,
    input_artifacts: clone(gate.input_artifacts),
    output_artifacts: clone(outputArtifacts),
    gate_revision: nextRevision,
  }
  const gateOutputs = decision === 'reject' ? { rejected: reviewRecord } : outputArtifacts

  const nextGate = {
    ...clone(gate),
    status: 'resolved',
    gate_revision: nextRevision,
    resolved_at: timestamp,
    decision,
    operator,
    comment,
    output_artifacts: gateOutputs,
  }
  transitionGate('resolving', nextGate.status)

  return {
    gate: nextGate,
    review_record: reviewRecord,
    run_outcome: decision === 'approve' || decision === 'submit_revision' ? 'resuming' : decision === 'reject' ? 'rejected' : 'cancelled',
  }
}

function invalidateGate(gate, { reason = 'run_cancelled', timestamp = new Date().toISOString() } = {}) {
  if (!gate || typeof gate !== 'object') throw gateError('GATE_INVALID', 'Gate instance must be an object')
  if (gate.status === 'resolved') throw gateError('GATE_ALREADY_RESOLVED', `Gate '${gate.gate_id}' is already resolved`)
  if (gate.status === 'invalidated') return clone(gate)
  transitionGate(gate.status, 'invalidated')
  return {
    ...clone(gate),
    status: 'invalidated',
    gate_revision: gate.gate_revision + 1,
    invalidated_at: timestamp,
    invalidation_reason: reason,
  }
}

module.exports = {
  artifactId,
  createGateInstance,
  invalidateGate,
  resolveGate,
  validateRevisionArtifacts,
}
