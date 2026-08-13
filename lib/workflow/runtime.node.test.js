'use strict'

// Unit coverage for the FLOW-CORE-004 wiring layer. The live behaviour is
// proven by lib/flow.integration.node.test.js against a real server; this file
// covers the parts that must hold even where a backend runtime is unavailable,
// and pins the decisions that are easy to regress silently.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  FLOW_RUNS_DIRNAME,
  audioOutputHandler,
  buildHandlers,
  createFlowRuntime,
  gateHandler,
  sourceHandler,
} = require('./runtime')
const { statusFor } = require('../routes/flow')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flow-runtime-'))
}

test('the runtime registers exactly the FLOW-CORE-004 slice and nothing more', () => {
  const handlers = buildHandlers({ generateService: async () => ({}), clock: () => 'now' })
  // Registering a node type the slice does not implement would make an
  // unimplemented node look like a working one; the executor's
  // NODE_HANDLER_NOT_FOUND is the correct answer instead.
  assert.deepEqual(Object.keys(handlers).sort(), [
    'io.audio_input',
    'io.audio_output',
    'io.text_input',
    'io.voice_input',
    'review.human_gate',
    'tts.generate',
  ])
})

test('a source node reads the binding named by params.workflow_input', async () => {
  const handler = sourceHandler('text', 'text')
  const result = await handler({
    node: { id: 'n1', params: { workflow_input: 'script' } },
    workflow_inputs: { script: { artifact_id: 'a1', type: 'TextArtifact', value: 'hi' } },
  })
  assert.equal(result.outputs.text.artifact_id, 'a1')
})

test('a source node falls back to the port-default key when no param is given', async () => {
  const handler = sourceHandler('voice', 'voice')
  const result = await handler({
    node: { id: 'n1' },
    workflow_inputs: { voice: { artifact_id: 'v1', type: 'VoiceRef' } },
  })
  assert.equal(result.outputs.voice.artifact_id, 'v1')
})

test('an unbound source node fails closed instead of emitting undefined', async () => {
  const handler = sourceHandler('text', 'text')
  await assert.rejects(
    () => handler({ node: { id: 'n1', params: { workflow_input: 'missing' } }, workflow_inputs: {} }),
    (err) => err.code === 'FLOW_SOURCE_INPUT_MISSING' && err.expected_input === 'missing',
  )
})

test('gate ids are deterministic so a replayed attempt is the same Gate', async () => {
  const handler = gateHandler({ clock: () => '2026-08-13T00:00:00.000Z' })
  const args = {
    inputs: { review_target: [{ artifact_id: 'aud1', type: 'AudioArtifact' }] },
    run_id: 'run_x',
    node: { id: 'review', params: {} },
    node_attempt: 1,
    plan: { workflow_revision_id: 'rev1', run_plan_fingerprint: 'sha256:ff' },
  }
  const a = await handler(args)
  const b = await handler(args)
  assert.equal(a.gate.gate_id, 'run_x__review__1')
  assert.equal(a.gate.gate_id, b.gate.gate_id)
  assert.equal(a.status, 'waiting')
  // The executor rejects any Gate whose identity disagrees with the node it
  // came from (GATE_RESULT_INVALID), so these four fields are load-bearing.
  assert.equal(a.gate.run_id, 'run_x')
  assert.equal(a.gate.node_id, 'review')
  assert.equal(a.gate.node_attempt, 1)
  assert.equal(a.gate.status, 'awaiting_review')
})

test('a different attempt yields a different Gate id', async () => {
  const handler = gateHandler({ clock: () => 'now' })
  const base = {
    inputs: { review_target: [{ artifact_id: 'aud1', type: 'AudioArtifact' }] },
    run_id: 'run_x',
    node: { id: 'review', params: {} },
    plan: {},
  }
  const first = await handler({ ...base, node_attempt: 1 })
  const second = await handler({ ...base, node_attempt: 2 })
  assert.notEqual(first.gate.gate_id, second.gate.gate_id)
})

test('io.audio_output reports the artifact identity but publishes nothing', async () => {
  const result = await audioOutputHandler({
    inputs: { audio: { artifact_id: 'aud1', type: 'AudioArtifact', uri: '/outputs/a.wav', fingerprint_kind: 'descriptor' } },
  })
  assert.deepEqual(result.outputs, {}, 'the terminal node must not invent new artifacts')
  assert.equal(result.metrics.artifact_id, 'aud1')
  assert.equal(result.metrics.uri, '/outputs/a.wav')
})

test('io.audio_output fails closed when nothing reached it', async () => {
  await assert.rejects(
    () => audioOutputHandler({ inputs: {} }),
    (err) => err.code === 'FLOW_OUTPUT_AUDIO_MISSING',
  )
})

test('the runtime refuses to start without a synthesis service or a journal dir', () => {
  assert.throws(() => createFlowRuntime({}, {}), (e) => e.code === 'FLOW_RUNTIME_SERVICE_REQUIRED')
  assert.throws(
    () => createFlowRuntime({}, { generateService: async () => ({}) }),
    (e) => e.code === 'FLOW_RUNTIME_JOURNAL_DIR_REQUIRED',
  )
})

test('the runtime derives its journal directory from ctx.OUTPUT_DIR', () => {
  const dir = tmpDir()
  const runtime = createFlowRuntime({ OUTPUT_DIR: dir }, { generateService: async () => ({}) })
  assert.equal(runtime.journalDir, path.join(dir, FLOW_RUNS_DIRNAME))
})

test('resuming a Run this process never started fails closed, not silently', async () => {
  const runtime = createFlowRuntime({}, { generateService: async () => ({}), journalDir: tmpDir() })
  await assert.rejects(
    () => runtime.resumeGate('run_from_a_previous_process', { gate_id: 'g', decision: 'approve' }),
    (err) => err.code === 'FLOW_RUN_PLAN_UNAVAILABLE' && err.retryable === false,
  )
})

test('kernel error codes map to statuses that mean something to a client', () => {
  assert.equal(statusFor({ code: 'WORKFLOW_INVALID' }), 400)
  assert.equal(statusFor({ code: 'GATE_REVISION_CONFLICT' }), 409)
  assert.equal(statusFor({ code: 'WORKFLOW_INPUT_REBIND_REQUIRED' }), 409)
  assert.equal(statusFor({ code: 'WORKFLOW_INPUT_ARTIFACT_CONFLICT' }), 409)
  // A retryable infrastructure fault must NOT look like a semantic rejection.
  assert.equal(statusFor({ code: 'ARTIFACT_STORE_UNAVAILABLE' }), 503)
  assert.equal(statusFor({ code: 'NODE_HANDLER_NOT_FOUND' }), 501)
  assert.equal(statusFor({ code: 'SOMETHING_UNMAPPED' }), 500)
})
