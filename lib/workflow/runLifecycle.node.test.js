'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  appendJournalEvent,
  createGateInstance,
  createJournal,
  invalidateGate,
  replayJournal,
  resolveGate,
  transitionRun,
} = require('./index')

const inputArtifact = {
  artifact_id: 'art_text_v1',
  type: 'TextArtifact',
  fingerprint: 'sha256:text-v1',
}

function gate(decisions = ['approve', 'submit_revision', 'reject', 'cancel']) {
  return createGateInstance({
    gate_id: 'gate_001',
    run_id: 'run_001',
    node_id: 'review_001',
    node_attempt: 1,
    review_schema: 'pronunciation.v1',
    input_artifacts: [inputArtifact],
    decisions,
    created_at: '2026-08-09T00:00:00.000Z',
  })
}

test('Run state machine permits the validated queue/start path and rejects illegal jumps', () => {
  assert.equal(transitionRun('created', 'validated'), 'validated')
  assert.equal(transitionRun('validated', 'queued'), 'queued')
  assert.equal(transitionRun('queued', 'running'), 'running')
  assert.throws(() => transitionRun('running', 'queued'), error => error.code === 'RUN_TRANSITION_INVALID')
})

test('approve resolves a Gate exactly once and exposes explicit approved outputs', () => {
  const current = gate()
  const result = resolveGate(current, {
    expected_gate_revision: 1,
    decision: 'approve',
    operator: 'local-user',
    timestamp: '2026-08-09T00:01:00.000Z',
  })
  assert.equal(result.gate.status, 'resolved')
  assert.equal(result.gate.gate_revision, 2)
  assert.equal(result.run_outcome, 'resuming')
  assert.deepEqual(result.gate.output_artifacts.approved, [inputArtifact])
  assert.equal(result.review_record.decision, 'approve')
  assert.throws(
    () => resolveGate(result.gate, { expected_gate_revision: 2, decision: 'approve' }),
    error => error.code === 'GATE_ALREADY_RESOLVED',
  )
})

test('submit_revision requires a new Artifact with parent lineage', () => {
  const current = gate()
  const revised = {
    artifact_id: 'art_text_v2',
    type: 'TextArtifact',
    fingerprint: 'sha256:text-v2',
    lineage: {
      lineage_id: 'lin_text_001',
      revision: 2,
      parent_artifact_id: 'art_text_v1',
      reason: 'human_revision',
    },
  }
  const result = resolveGate(current, {
    expected_gate_revision: 1,
    decision: 'submit_revision',
    outputs: { revised: [revised] },
  })
  assert.equal(result.run_outcome, 'resuming')
  assert.deepEqual(result.gate.output_artifacts.revised, [revised])

  assert.throws(
    () => resolveGate(gate(), {
      expected_gate_revision: 1,
      decision: 'submit_revision',
      outputs: { revised: [{ artifact_id: 'bad', lineage: { lineage_id: 'lin', revision: 2, parent_artifact_id: 'other' } }] },
    }),
    error => error.code === 'REVISION_PARENT_INVALID',
  )
})

test('reject is a business terminal outcome and cancel is a Run cancellation', () => {
  const rejected = resolveGate(gate(['reject']), { expected_gate_revision: 1, decision: 'reject' })
  assert.equal(rejected.run_outcome, 'rejected')
  assert.equal(rejected.gate.output_artifacts.rejected.review_record_id, rejected.review_record.review_record_id)

  const cancelled = resolveGate(gate(['cancel']), { expected_gate_revision: 1, decision: 'cancel' })
  assert.equal(cancelled.run_outcome, 'cancelled')
  assert.deepEqual(cancelled.gate.output_artifacts, {})
})

test('Gate revision protects against stale or repeated submissions', () => {
  const current = gate()
  assert.throws(
    () => resolveGate(current, { expected_gate_revision: 0, decision: 'approve' }),
    error => error.code === 'GATE_REVISION_CONFLICT',
  )
  const resolved = resolveGate(current, { expected_gate_revision: 1, decision: 'approve' }).gate
  assert.throws(
    () => resolveGate(resolved, { expected_gate_revision: 1, decision: 'approve' }),
    error => error.code === 'GATE_ALREADY_RESOLVED',
  )
})

test('invalidating a waiting Gate makes it non-resolvable', () => {
  const invalidated = invalidateGate(gate(), { reason: 'run_cancelled', timestamp: '2026-08-09T00:02:00.000Z' })
  assert.equal(invalidated.status, 'invalidated')
  assert.equal(invalidated.gate_revision, 2)
  assert.throws(
    () => resolveGate(invalidated, { expected_gate_revision: 2, decision: 'approve' }),
    error => error.code === 'GATE_INVALIDATED',
  )
})

test('Run Journal replays a Human Gate wait and resume without executing nodes', () => {
  const waitingGate = gate()
  let journal = createJournal('run_001', {
    workflow_id: 'tts_demo',
    workflow_revision_id: 'workflow_revision_003',
    workflow_fingerprint: 'sha256:workflow',
    run_plan_fingerprint: 'sha256:plan',
  })
  const add = (event_id, type, payload = {}) => {
    journal = appendJournalEvent(journal, { event_id, type, payload })
  }
  add('evt_1', 'RUN_CREATED', {
    workflow_id: 'tts_demo',
    workflow_revision_id: 'workflow_revision_003',
    workflow_fingerprint: 'sha256:workflow',
    run_plan_fingerprint: 'sha256:plan',
  })
  add('evt_2', 'RUN_VALIDATED')
  add('evt_3', 'RUN_QUEUED')
  add('evt_4', 'RUN_STARTED')
  add('evt_5', 'GATE_CREATED', { gate: waitingGate })

  let projection = replayJournal(journal)
  assert.equal(projection.status, 'awaiting_human_review')
  assert.equal(projection.gates.gate_001.status, 'awaiting_review')

  const resolved = resolveGate(waitingGate, { expected_gate_revision: 1, decision: 'approve' })
  add('evt_6', 'GATE_RESOLVED', { gate: resolved.gate, review_record: resolved.review_record })
  projection = replayJournal(journal)
  assert.equal(projection.status, 'resuming')
  assert.equal(projection.gates.gate_001.status, 'resolved')
  assert.equal(projection.review_records.length, 1)

  add('evt_7', 'RUN_RESUMED')
  projection = replayJournal(journal)
  assert.equal(projection.status, 'running')
  assert.equal(projection.workflow_revision_id, 'workflow_revision_003')
})

test('Journal rejects duplicate event ids and sequence gaps', () => {
  let journal = createJournal('run_002')
  journal = appendJournalEvent(journal, { event_id: 'evt_1', type: 'RUN_CREATED' })
  assert.throws(
    () => appendJournalEvent(journal, { event_id: 'evt_1', type: 'RUN_VALIDATED' }),
    error => error.code === 'JOURNAL_DUPLICATE_EVENT',
  )
  assert.throws(
    () => appendJournalEvent(journal, { event_id: 'evt_2', sequence: 3, type: 'RUN_VALIDATED' }),
    error => error.code === 'JOURNAL_SEQUENCE_CONFLICT',
  )
})
