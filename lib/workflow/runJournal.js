'use strict'

const { transitionRun } = require('./runState')

const JOURNAL_SCHEMA = 'aurivox.run_journal'
const JOURNAL_SCHEMA_VERSION = 1

function journalError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function createJournal(run_id, options = {}) {
  if (typeof run_id !== 'string' || !run_id) throw journalError('RUN_ID_REQUIRED', 'run_id is required')
  return {
    schema: JOURNAL_SCHEMA,
    schema_version: JOURNAL_SCHEMA_VERSION,
    run_id,
    workflow_id: options.workflow_id || null,
    workflow_revision_id: options.workflow_revision_id || null,
    workflow_fingerprint: options.workflow_fingerprint || null,
    run_plan_fingerprint: options.run_plan_fingerprint || null,
    events: [],
  }
}

function appendJournalEvent(journal, event) {
  if (!journal || typeof journal !== 'object' || !Array.isArray(journal.events)) throw journalError('JOURNAL_INVALID', 'journal must contain an events array')
  if (!event || typeof event !== 'object') throw journalError('JOURNAL_EVENT_INVALID', 'event must be an object')
  if (typeof event.event_id !== 'string' || !event.event_id) throw journalError('JOURNAL_EVENT_ID_REQUIRED', 'event_id is required')
  if (typeof event.type !== 'string' || !event.type) throw journalError('JOURNAL_EVENT_TYPE_REQUIRED', 'event type is required')
  if (event.run_id !== undefined && event.run_id !== journal.run_id) throw journalError('JOURNAL_RUN_MISMATCH', 'event run_id does not match journal run_id')
  if (journal.events.some(existing => existing.event_id === event.event_id)) throw journalError('JOURNAL_DUPLICATE_EVENT', `event '${event.event_id}' already exists`)
  const expectedSequence = journal.events.length + 1
  const sequence = event.sequence === undefined ? expectedSequence : event.sequence
  if (!Number.isInteger(sequence) || sequence !== expectedSequence) throw journalError('JOURNAL_SEQUENCE_CONFLICT', `expected event sequence ${expectedSequence}`, { expected_sequence: expectedSequence, actual_sequence: sequence })
  const nextEvent = {
    event_id: event.event_id,
    run_id: journal.run_id,
    sequence,
    type: event.type,
    created_at: event.created_at || new Date().toISOString(),
    payload: clone(event.payload || {}),
  }
  return {
    ...journal,
    events: [...journal.events, nextEvent],
  }
}

function ensureRunTransition(projection, next) {
  projection.status = transitionRun(projection.status, next)
}

function applyEvent(projection, event) {
  const payload = event.payload || {}
  switch (event.type) {
    case 'RUN_CREATED':
      if (projection.status !== 'created') throw journalError('JOURNAL_STATE_INVALID', 'RUN_CREATED must be the first run state event')
      if (payload.workflow_id) projection.workflow_id = payload.workflow_id
      if (payload.workflow_revision_id) projection.workflow_revision_id = payload.workflow_revision_id
      if (payload.workflow_fingerprint) projection.workflow_fingerprint = payload.workflow_fingerprint
      if (payload.run_plan_fingerprint) projection.run_plan_fingerprint = payload.run_plan_fingerprint
      break
    case 'RUN_VALIDATED': ensureRunTransition(projection, 'validated'); break
    case 'RUN_QUEUED': ensureRunTransition(projection, 'queued'); break
    case 'RUN_STARTED':
    case 'RUN_RESUMED':
      ensureRunTransition(projection, 'running')
      break
    case 'RUN_RESUMING': ensureRunTransition(projection, 'resuming'); break
    case 'RUN_SUCCEEDED': ensureRunTransition(projection, 'succeeded'); break
    case 'RUN_REJECTED': ensureRunTransition(projection, 'rejected'); break
    case 'RUN_FAILED': ensureRunTransition(projection, 'failed'); break
    case 'RUN_CANCELLED': ensureRunTransition(projection, 'cancelled'); break
    case 'RUN_INTERRUPTED': ensureRunTransition(projection, 'interrupted'); break
    case 'GATE_CREATED': {
      const gate = payload.gate
      if (!gate || typeof gate !== 'object' || !gate.gate_id) throw journalError('JOURNAL_GATE_INVALID', 'GATE_CREATED requires payload.gate')
      ensureRunTransition(projection, 'awaiting_human_review')
      if (projection.gates[gate.gate_id]) throw journalError('JOURNAL_DUPLICATE_GATE', `gate '${gate.gate_id}' already exists`)
      projection.gates[gate.gate_id] = clone(gate)
      break
    }
    case 'GATE_RESOLVED': {
      const gate = payload.gate
      if (!gate || !gate.gate_id || gate.status !== 'resolved') throw journalError('JOURNAL_GATE_INVALID', 'GATE_RESOLVED requires a resolved gate')
      if (!projection.gates[gate.gate_id]) throw journalError('JOURNAL_GATE_NOT_FOUND', `gate '${gate.gate_id}' was not created`)
      const current = projection.gates[gate.gate_id]
      if (current.status !== 'awaiting_review') throw journalError('JOURNAL_GATE_STATE_INVALID', `gate '${gate.gate_id}' is not awaiting review`)
      projection.gates[gate.gate_id] = clone(gate)
      projection.review_records.push(clone(payload.review_record || null))
      if (payload.outputs) projection.outputs.push(...clone(payload.outputs))
      if (gate.decision === 'approve' || gate.decision === 'submit_revision') ensureRunTransition(projection, 'resuming')
      else if (gate.decision === 'reject') ensureRunTransition(projection, 'rejected')
      else if (gate.decision === 'cancel') ensureRunTransition(projection, 'cancelled')
      else throw journalError('JOURNAL_GATE_DECISION_INVALID', `unknown gate decision '${gate.decision}'`)
      break
    }
    case 'GATE_INVALIDATED': {
      const gate = payload.gate
      if (!gate || !gate.gate_id || gate.status !== 'invalidated') throw journalError('JOURNAL_GATE_INVALID', 'GATE_INVALIDATED requires an invalidated gate')
      if (!projection.gates[gate.gate_id]) throw journalError('JOURNAL_GATE_NOT_FOUND', `gate '${gate.gate_id}' was not created`)
      projection.gates[gate.gate_id] = clone(gate)
      break
    }
    case 'NODE_STARTED': {
      const node = payload.node
      if (!node || !node.node_id) throw journalError('JOURNAL_NODE_INVALID', 'NODE_STARTED requires payload.node')
      projection.node_runs[node.node_id] = { ...(projection.node_runs[node.node_id] || {}), ...clone(node), status: 'running' }
      break
    }
    case 'NODE_SUCCEEDED':
    case 'NODE_FAILED':
    case 'NODE_CANCELLED': {
      const node = payload.node
      if (!node || !node.node_id) throw journalError('JOURNAL_NODE_INVALID', `${event.type} requires payload.node`)
      projection.node_runs[node.node_id] = { ...(projection.node_runs[node.node_id] || {}), ...clone(node) }
      break
    }
    case 'ARTIFACT_COMMITTED':
      if (payload.artifacts && Array.isArray(payload.artifacts)) projection.outputs.push(...clone(payload.artifacts))
      break
    default:
      throw journalError('JOURNAL_EVENT_UNKNOWN', `unsupported journal event '${event.type}'`)
  }
}

function replayJournal(journal) {
  if (!journal || journal.schema !== JOURNAL_SCHEMA || journal.schema_version !== JOURNAL_SCHEMA_VERSION || !Array.isArray(journal.events)) {
    throw journalError('JOURNAL_INVALID', 'unsupported or malformed Run Journal')
  }
  const projection = {
    run_id: journal.run_id,
    workflow_id: journal.workflow_id || null,
    workflow_revision_id: journal.workflow_revision_id || null,
    workflow_fingerprint: journal.workflow_fingerprint || null,
    run_plan_fingerprint: journal.run_plan_fingerprint || null,
    status: 'created',
    gates: {},
    node_runs: {},
    review_records: [],
    outputs: [],
    last_sequence: 0,
  }
  for (const event of journal.events) {
    if (event.run_id !== journal.run_id) throw journalError('JOURNAL_RUN_MISMATCH', `event '${event.event_id}' belongs to another run`)
    if (event.sequence !== projection.last_sequence + 1) throw journalError('JOURNAL_SEQUENCE_CONFLICT', `journal sequence gap before event '${event.event_id}'`)
    applyEvent(projection, event)
    projection.last_sequence = event.sequence
  }
  return projection
}

module.exports = {
  JOURNAL_SCHEMA,
  JOURNAL_SCHEMA_VERSION,
  appendJournalEvent,
  createJournal,
  replayJournal,
}
