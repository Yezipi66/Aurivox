'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  FileRunJournalStore,
  WorkflowExecutor,
  createGateInstance,
  createMemoryArtifactStore,
  createRunPlan,
} = require('./index')

function workflow() {
  return {
    schema: 'aurivox.workflow',
    schema_version: 1,
    id: 'tts_executor_demo',
    name: 'TTS executor demo',
    inputs: {
      text: { type: 'TextArtifact', required: true },
      voice: { type: 'VoiceRef', required: true },
    },
    nodes: [
      { id: 'text', type: 'io.text_input', type_version: 1, params: { workflow_input: 'text' } },
      { id: 'voice', type: 'io.voice_input', type_version: 1, params: { workflow_input: 'voice' } },
      { id: 'route', type: 'text.auto_language', type_version: 1 },
      {
        id: 'review',
        type: 'review.human_gate',
        type_version: 1,
        params: {
          review_schema: 'pronunciation.v1',
          decisions: ['approve', 'submit_revision', 'reject', 'cancel'],
        },
      },
      { id: 'tts', type: 'tts.generate', type_version: 1 },
      { id: 'output', type: 'io.audio_output', type_version: 1 },
    ],
    edges: [
      { id: 'e_text_route', from: { node: 'text', port: 'text' }, to: { node: 'route', port: 'text' } },
      { id: 'e_route_review', from: { node: 'route', port: 'text' }, to: { node: 'review', port: 'review_target' } },
      { id: 'e_route_tts', from: { node: 'route', port: 'text' }, to: { node: 'tts', port: 'text' } },
      { id: 'e_voice_tts', from: { node: 'voice', port: 'voice' }, to: { node: 'tts', port: 'voice' } },
      { id: 'e_review_tts', from: { node: 'review', port: 'approved' }, to: { node: 'tts', port: 'recipe' } },
      { id: 'e_tts_output', from: { node: 'tts', port: 'audio' }, to: { node: 'output', port: 'audio' } },
    ],
  }
}

async function tempStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurivox-flow-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return new FileRunJournalStore(dir)
}

function handlers(calls) {
  return {
    'io.text_input': async ({ workflow_inputs }) => {
      calls.push('text')
      return { outputs: { text: workflow_inputs.text } }
    },
    'io.voice_input': async ({ workflow_inputs }) => {
      calls.push('voice')
      return { outputs: { voice: workflow_inputs.voice } }
    },
    'text.auto_language': async ({ inputs }) => {
      calls.push('route')
      return { outputs: { text: inputs.text, language_assignment: { artifact_id: 'art_lang_1', type: 'LanguageAssignment' } } }
    },
    'review.human_gate': async ({ inputs, run_id, node, node_attempt, plan }) => {
      calls.push('review')
      const gate = createGateInstance({
        gate_id: 'gate_executor_001',
        run_id,
        node_id: node.id,
        node_attempt,
        review_schema: 'pronunciation.v1',
        input_artifacts: inputs.review_target,
        decisions: ['approve', 'submit_revision', 'reject', 'cancel'],
        workflow_revision_id: plan.workflow_revision_id,
        run_plan_fingerprint: plan.run_plan_fingerprint,
        created_at: '2026-08-13T00:00:00.000Z',
      })
      return { status: 'waiting', gate }
    },
    'tts.generate': async ({ inputs }) => {
      calls.push('tts')
      return { outputs: { audio: { artifact_id: 'art_audio_1', type: 'AudioArtifact', text: inputs.text } } }
    },
    'io.audio_output': async ({ inputs }) => {
      calls.push(`output:${inputs.audio?.artifact_id}`)
      return { outputs: {} }
    },
  }
}

test('FileRunJournalStore persists, replays, lists, and removes a journal', async (t) => {
  const store = await tempStore(t)
  const journal = require('./runJournal').createJournal('run_store_1')
  await store.create(journal)
  await store.append('run_store_1', { event_id: 'event_1', type: 'RUN_CREATED' })
  await store.append('run_store_1', { event_id: 'event_2', type: 'RUN_VALIDATED' })
  await fs.appendFile(store.pathFor('run_store_1'), '{"kind":"event","event":', 'utf8')
  const repaired = await store.read('run_store_1')
  assert.equal(repaired.events.length, 2)
  assert.deepEqual(await store.listRunIds(), ['run_store_1'])
  const projection = await store.replay('run_store_1')
  assert.equal(projection.status, 'validated')
  await store.remove('run_store_1')
  assert.deepEqual(await store.listRunIds(), [])
})

test('executor stops at Human Gate and resumes the same Run after approval', async (t) => {
  const store = await tempStore(t)
  const calls = []
  const plan = createRunPlan(workflow())
  const executor = new WorkflowExecutor({ journalStore: store, handlers: handlers(calls), idFactory: () => 'run_executor_1', clock: () => '2026-08-13T00:00:00.000Z' })
  const inputs = {
    text: { artifact_id: 'art_text_1', type: 'TextArtifact', value: '今日' },
    voice: { artifact_id: 'voice_1', type: 'VoiceRef' },
  }

  const waiting = await executor.start(plan, { inputs })
  const storedJournal = await store.read('run_executor_1')
  assert.equal(storedJournal.events[0].payload.workflow_inputs, undefined)
  assert.equal(storedJournal.events[0].payload.workflow_input_snapshot.text.kind, 'artifact_ref')
  assert.equal(storedJournal.events[0].payload.workflow_input_snapshot.text.artifact_id, 'art_text_1')
  assert.equal(waiting.status, 'awaiting_human_review')
  assert.equal(waiting.gates.gate_executor_001.status, 'awaiting_review')
  assert.deepEqual(calls, ['text', 'route', 'review'])
  assert.equal(waiting.node_runs.review.status, 'waiting')
  assert.equal(waiting.node_runs.tts, undefined)

  const done = await executor.resume('run_executor_1', plan, {
    gate_id: 'gate_executor_001',
    expected_gate_revision: 1,
    decision: 'approve',
    operator: 'local-user',
  })
  assert.equal(done.status, 'succeeded')
  assert.equal(done.gates.gate_executor_001.status, 'resolved')
  assert.deepEqual(calls, ['text', 'route', 'review', 'voice', 'tts', 'output:art_audio_1'])
  assert.equal(done.workflow_revision_id, plan.workflow_revision_id)
})

test('executor rejects a resume attempt with a different Run Plan', async (t) => {
  const store = await tempStore(t)
  const calls = []
  const plan = createRunPlan(workflow())
  const executor = new WorkflowExecutor({ journalStore: store, handlers: handlers(calls), idFactory: () => 'run_plan_mismatch' })
  await executor.start(plan, {
    inputs: {
      text: { artifact_id: 'art_text_1', type: 'TextArtifact' },
      voice: { artifact_id: 'voice_1', type: 'VoiceRef' },
    },
  })
  const otherPlan = { ...plan, run_plan_fingerprint: 'sha256:different' }
  await assert.rejects(
    () => executor.resume('run_plan_mismatch', otherPlan, { gate_id: 'gate_executor_001', expected_gate_revision: 1, decision: 'approve' }),
    error => error.code === 'RUN_PLAN_MISMATCH',
  )
})

test('a new executor instance requires an input rebind before approving a Gate', async (t) => {
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const first = new WorkflowExecutor({ journalStore: store, handlers: handlers([]), idFactory: () => 'run_rebind_1' })
  await first.start(plan, {
    inputs: {
      text: { artifact_id: 'art_text_1', type: 'TextArtifact' },
      voice: { artifact_id: 'voice_1', type: 'VoiceRef' },
    },
  })
  const restarted = new WorkflowExecutor({ journalStore: store, handlers: handlers([]) })
  await assert.rejects(
    () => restarted.resume('run_rebind_1', plan, { gate_id: 'gate_executor_001', expected_gate_revision: 1, decision: 'approve' }),
    error => error.code === 'WORKFLOW_INPUT_REBIND_REQUIRED',
  )
})

// FLOW-D10a: an inputResolver closes the restart gap, but it is reconciled
// against the recorded snapshot instead of being trusted on its word.
const REBIND_INPUTS = Object.freeze({
  text: { artifact_id: 'art_text_1', type: 'TextArtifact' },
  voice: { artifact_id: 'voice_1', type: 'VoiceRef' },
})

async function startedRebindRun(t, runId) {
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const first = new WorkflowExecutor({ journalStore: store, handlers: handlers([]), idFactory: () => runId })
  await first.start(plan, { inputs: { ...REBIND_INPUTS } })
  return { store, plan }
}

function approve() {
  return { gate_id: 'gate_executor_001', expected_gate_revision: 1, decision: 'approve' }
}

test('an input rebind that matches the recorded snapshot is accepted', async (t) => {
  const { store, plan } = await startedRebindRun(t, 'run_rebind_ok')
  const calls = []
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers(calls),
    inputResolver: async ({ run_id, snapshot }) => {
      assert.equal(run_id, 'run_rebind_ok')
      // The snapshot never carries raw payloads, only identity/fingerprint.
      assert.equal(snapshot.text.kind, 'artifact_ref')
      assert.equal(snapshot.text.artifact_id, 'art_text_1')
      return { ...REBIND_INPUTS }
    },
  })
  const projection = await restarted.resume('run_rebind_ok', plan, approve())
  assert.equal(projection.status, 'succeeded')
})

test('an input rebind with a different artifact is rejected fail-closed', async (t) => {
  const { store, plan } = await startedRebindRun(t, 'run_rebind_artifact')
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({
      ...REBIND_INPUTS,
      text: { artifact_id: 'art_text_OTHER', type: 'TextArtifact' },
    }),
  })
  await assert.rejects(
    () => restarted.resume('run_rebind_artifact', plan, approve()),
    error => {
      assert.equal(error.code, 'WORKFLOW_INPUT_REBIND_MISMATCH')
      assert.deepEqual(error.mismatches, [{
        key: 'text',
        reason: 'ARTIFACT_ID_MISMATCH',
        expected: 'art_text_1',
        actual: 'art_text_OTHER',
      }])
      return true
    },
  )
})

test('an input rebind with altered inline text is rejected and leaks no plaintext', async (t) => {
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const first = new WorkflowExecutor({ journalStore: store, handlers: handlers([]), idFactory: () => 'run_rebind_text' })
  await first.start(plan, { inputs: { text: 'the original script', voice: REBIND_INPUTS.voice } })

  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ text: 'the tampered script', voice: REBIND_INPUTS.voice }),
  })
  await assert.rejects(
    () => restarted.resume('run_rebind_text', plan, approve()),
    error => {
      assert.equal(error.code, 'WORKFLOW_INPUT_REBIND_MISMATCH')
      assert.equal(error.mismatches.length, 1)
      const [mismatch] = error.mismatches
      assert.equal(mismatch.key, 'text')
      assert.equal(mismatch.reason, 'DIGEST_MISMATCH')
      assert.match(mismatch.expected_digest, /^sha256:/)
      // Diagnostics may carry digests, never the original or tampered text.
      const serialised = JSON.stringify(error.mismatches)
      assert.equal(serialised.includes('original script'), false)
      assert.equal(serialised.includes('tampered script'), false)
      return true
    },
  )
})

test('an input rebind is rejected when keys are missing or unexpected', async (t) => {
  const { store, plan } = await startedRebindRun(t, 'run_rebind_keys')
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ text: REBIND_INPUTS.text, debug_flag: true }),
  })
  await assert.rejects(
    () => restarted.resume('run_rebind_keys', plan, approve()),
    error => {
      assert.equal(error.code, 'WORKFLOW_INPUT_REBIND_MISMATCH')
      const reasons = error.mismatches.map(entry => `${entry.key}:${entry.reason}`).sort()
      assert.deepEqual(reasons, ['debug_flag:UNEXPECTED_KEY', 'voice:MISSING_KEY'])
      return true
    },
  )
})

test('a rejected input rebind does not append to the run journal', async (t) => {
  const { store, plan } = await startedRebindRun(t, 'run_rebind_journal')
  const before = await store.read('run_rebind_journal')
  const beforeStatus = (await store.replay('run_rebind_journal')).status
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ text: REBIND_INPUTS.text, voice: { artifact_id: 'voice_OTHER', type: 'VoiceRef' } }),
  })
  await assert.rejects(
    () => restarted.resume('run_rebind_journal', plan, approve()),
    error => error.code === 'WORKFLOW_INPUT_REBIND_MISMATCH',
  )
  // Rebind runs before the run identity is re-established, so a failed rebind
  // must not pollute the append-only journal.
  const after = await store.read('run_rebind_journal')
  const afterStatus = (await store.replay('run_rebind_journal')).status
  assert.equal(afterStatus, beforeStatus)
  assert.equal(afterStatus, 'awaiting_human_review')
  assert.deepEqual(after.events.map(event => event.type), before.events.map(event => event.type))
  assert.deepEqual(after.events.map(event => event.event_id), before.events.map(event => event.event_id))
})

// FLOW-D10b: the Store answers "does this artifact still exist, and does it
// still look like what the journal recorded?" It runs after D10a, never before.
function storeWith(overrides = {}) {
  const descriptors = {
    art_text_1: { type: 'TextArtifact', fingerprint: null },
    voice_1: { type: 'VoiceRef', fingerprint: null },
    ...overrides,
  }
  // An `undefined` override means "the store no longer holds this". Spreading
  // undefined leaves the key in place, so it has to be deleted explicitly.
  for (const [key, value] of Object.entries(descriptors)) {
    if (value === undefined) delete descriptors[key]
  }
  return createMemoryArtifactStore(descriptors)
}

test('FLOW-D10b: a rebind is accepted when the artifact store confirms every artifact', async (t) => {
  const { store, plan } = await startedRebindRun(t, 'run_store_ok')
  const asked = []
  const artifactStore = {
    async describe(artifactId) {
      asked.push(artifactId)
      return { artifact_id: artifactId, exists: true, type: artifactId === 'voice_1' ? 'VoiceRef' : 'TextArtifact' }
    },
  }
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ ...REBIND_INPUTS }),
    artifactStore,
  })
  const projection = await restarted.resume('run_store_ok', plan, approve())
  assert.equal(projection.status, 'succeeded')
  assert.deepEqual(asked.sort(), ['art_text_1', 'voice_1'])
})

test('FLOW-D10b: with no artifact store injected, behaviour is unchanged from D10a', async (t) => {
  // The store is an optional enhancement. Absent one, this slice must not
  // introduce a new way for a perfectly valid single-process run to fail.
  const { store, plan } = await startedRebindRun(t, 'run_store_absent')
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ ...REBIND_INPUTS }),
  })
  const projection = await restarted.resume('run_store_absent', plan, approve())
  assert.equal(projection.status, 'succeeded')
})

test('FLOW-D10b: an artifact the store no longer has fails closed and is not retryable', async (t) => {
  const { store, plan } = await startedRebindRun(t, 'run_store_gone')
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ ...REBIND_INPUTS }),
    artifactStore: storeWith({ art_text_1: undefined, voice_1: { type: 'VoiceRef' } }),
  })
  await assert.rejects(
    () => restarted.resume('run_store_gone', plan, approve()),
    error => {
      assert.equal(error.code, 'WORKFLOW_INPUT_ARTIFACT_CONFLICT')
      assert.equal(error.retryable, false)
      assert.equal(error.conflicts.length, 1)
      assert.equal(error.conflicts[0].code, 'ARTIFACT_NOT_FOUND')
      assert.equal(error.conflicts[0].artifact_id, 'art_text_1')
      return true
    },
  )
})

test('FLOW-D10b: an unreachable store is retryable and distinct from a missing artifact', async (t) => {
  // Q6. Collapsing these two would let a transient outage be recorded as
  // "the artifact was collected", which is unrecoverable rather than a wait.
  const { store, plan } = await startedRebindRun(t, 'run_store_down')
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ ...REBIND_INPUTS }),
    artifactStore: {
      async describe() { throw new Error('ECONNREFUSED') },
    },
  })
  await assert.rejects(
    () => restarted.resume('run_store_down', plan, approve()),
    error => {
      assert.equal(error.code, 'ARTIFACT_STORE_UNAVAILABLE')
      assert.notEqual(error.code, 'ARTIFACT_NOT_FOUND')
      assert.equal(error.retryable, true)
      return true
    },
  )
})

test('FLOW-D10b: a store fingerprint that disagrees with the journal fails closed', async (t) => {
  const runId = 'run_store_fp'
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const inputs = {
    text: { artifact_id: 'art_text_1', type: 'TextArtifact', fingerprint: 'sha256:aaa' },
    voice: { artifact_id: 'voice_1', type: 'VoiceRef', fingerprint: 'sha256:bbb' },
  }
  const first = new WorkflowExecutor({ journalStore: store, handlers: handlers([]), idFactory: () => runId })
  await first.start(plan, { inputs })

  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ ...inputs }),
    // The resolver agrees with the journal, so D10a passes. The Store is the
    // one reporting that the content behind the id changed.
    artifactStore: storeWith({
      art_text_1: { type: 'TextArtifact', fingerprint: 'sha256:REWRITTEN' },
      voice_1: { type: 'VoiceRef', fingerprint: 'sha256:bbb' },
    }),
  })
  await assert.rejects(
    () => restarted.resume(runId, plan, approve()),
    error => {
      assert.equal(error.code, 'WORKFLOW_INPUT_ARTIFACT_CONFLICT')
      assert.equal(error.conflicts[0].code, 'ARTIFACT_FINGERPRINT_CONFLICT')
      return true
    },
  )
})

test('FLOW-D10b: a store type that disagrees with the journal fails closed', async (t) => {
  const { store, plan } = await startedRebindRun(t, 'run_store_type')
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ ...REBIND_INPUTS }),
    artifactStore: storeWith({ art_text_1: { type: 'AudioArtifact' } }),
  })
  await assert.rejects(
    () => restarted.resume('run_store_type', plan, approve()),
    error => {
      assert.equal(error.conflicts[0].code, 'ARTIFACT_TYPE_CONFLICT')
      assert.equal(error.conflicts[0].expected, 'TextArtifact')
      assert.equal(error.conflicts[0].actual, 'AudioArtifact')
      return true
    },
  )
})

test('FLOW-D10b: a store offering implicit latest-revision lookup is rejected at construction', async (t) => {
  // Q5 is only structurally guaranteed while no such shortcut exists, so the
  // prohibition is enforced in code rather than left in the document.
  const store = await tempStore(t)
  assert.throws(
    () => new WorkflowExecutor({
      journalStore: store,
      handlers: handlers([]),
      artifactStore: {
        async describe() { return null },
        async getLatestByLineage() { return null },
      },
    }),
    error => {
      assert.equal(error.code, 'ARTIFACT_STORE_INVALID')
      assert.equal(error.forbidden_method, 'getLatestByLineage')
      return true
    },
  )
})

test('FLOW-D10b: the store is never asked about inline inputs', async (t) => {
  // Asking about an inline value would report a valid input as ARTIFACT_NOT_FOUND.
  const runId = 'run_store_inline'
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const inputs = { text: 'a raw script', voice: { artifact_id: 'voice_1', type: 'VoiceRef' } }
  const first = new WorkflowExecutor({ journalStore: store, handlers: handlers([]), idFactory: () => runId })
  await first.start(plan, { inputs })

  const asked = []
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ ...inputs }),
    artifactStore: {
      async describe(artifactId) {
        asked.push(artifactId)
        return { artifact_id: artifactId, exists: true, type: 'VoiceRef' }
      },
    },
  })
  const projection = await restarted.resume(runId, plan, approve())

  // The primary claim of this test is unchanged and still asserted: the store is
  // consulted for the artifact input and NOT for the inline string.
  assert.deepEqual(asked, ['voice_1'])

  // FLOW-D27 stage 2 changed this test's TERMINAL expectation, deliberately.
  //
  // Before stage 2 this run reached 'succeeded' on a *fresh* Executor instance,
  // because the first instance had persisted the synth node's content-bearing
  // output verbatim into the Journal and this instance simply read it back.
  // That capability was real (contract R3 §3.2 capability 2) -- R1/R2 wrongly
  // described it as unsupported, and stage 2's implementation is what proved
  // otherwise. Preserving it would require exactly the plaintext persistence
  // D27 exists to remove, so it is given up knowingly, not broken by accident.
  //
  // The loss is strictly co-extensive with the protection: only outputs whose
  // real content left the Journal are affected. Identity-only Artifact outputs
  // are journal-safe (§4.8.1), stay verbatim in the Journal, and REMAIN
  // fresh-instance resumable -- pinned by the other recovery tests in this file.
  //
  // Note what is deliberately NOT done here: the inline string is not swapped
  // for an ArtifactRef to keep a green 'succeeded'. Doing so would make a real
  // capability reduction invisible to the suite.
  assert.equal(projection.status, 'failed')
  assert.equal(projection.error.code, 'NODE_OUTPUT_VALUE_UNAVAILABLE')
  assert.equal(projection.error.retryable, false)
})

test('FLOW-D10b: D10a runs first, so a poisoned store cannot mask a bad resolver', async (t) => {
  // Ordering matters: the journal is local and append-only, the store is
  // externally mutable. A store that happily confirms the wrong artifact must
  // still not get a mismatched rebind through.
  const { store, plan } = await startedRebindRun(t, 'run_store_order')
  const asked = []
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ ...REBIND_INPUTS, text: { artifact_id: 'art_text_EVIL', type: 'TextArtifact' } }),
    artifactStore: {
      async describe(artifactId) {
        asked.push(artifactId)
        return { artifact_id: artifactId, exists: true, type: 'TextArtifact' }
      },
    },
  })
  await assert.rejects(
    () => restarted.resume('run_store_order', plan, approve()),
    error => error.code === 'WORKFLOW_INPUT_REBIND_MISMATCH',
  )
  assert.deepEqual(asked, [], 'the store must not be consulted once D10a has already rejected the rebind')
})

test('FLOW-D10b: a store conflict does not append to the run journal', async (t) => {
  const { store, plan } = await startedRebindRun(t, 'run_store_nojournal')
  const before = await store.read('run_store_nojournal')
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ ...REBIND_INPUTS }),
    artifactStore: storeWith({ voice_1: undefined }),
  })
  await assert.rejects(
    () => restarted.resume('run_store_nojournal', plan, approve()),
    error => error.code === 'WORKFLOW_INPUT_ARTIFACT_CONFLICT',
  )
  const after = await store.read('run_store_nojournal')
  assert.deepEqual(after.events.map(e => e.event_id), before.events.map(e => e.event_id))
  assert.equal((await store.replay('run_store_nojournal')).status, 'awaiting_human_review')
})

test('FLOW-D10b: store conflict diagnostics carry identity only, never content', async (t) => {
  // FLOW-D10 R1 Q3 continues to apply on this path.
  const runId = 'run_store_privacy'
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const secret = 'the confidential script body'
  const inputs = { text: secret, voice: { artifact_id: 'voice_1', type: 'VoiceRef' } }
  const first = new WorkflowExecutor({ journalStore: store, handlers: handlers([]), idFactory: () => runId })
  await first.start(plan, { inputs })

  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ ...inputs }),
    artifactStore: storeWith({ voice_1: undefined }),
  })
  await assert.rejects(
    () => restarted.resume(runId, plan, approve()),
    error => {
      const serialized = JSON.stringify(error.conflicts)
      assert.equal(serialized.includes(secret), false)
      assert.equal(serialized.includes('confidential'), false)
      return error.code === 'WORKFLOW_INPUT_ARTIFACT_CONFLICT'
    },
  )
})

test('FLOW-D10b: a pre-D26 journal entry with a null fingerprint still gets an existence check', async (t) => {
  // Legacy journals recorded fingerprint: null. Skipping the fingerprint
  // comparison for those is necessary backward compatibility; skipping the
  // existence check is not, and would silently reinstate the D26 weakness.
  const { store, plan } = await startedRebindRun(t, 'run_store_legacy')
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers([]),
    inputResolver: async () => ({ ...REBIND_INPUTS }),
    artifactStore: storeWith({ art_text_1: { type: 'TextArtifact', fingerprint: 'sha256:anything' } }),
  })
  // Fingerprint differs but the journal has null -> tolerated.
  const projection = await restarted.resume('run_store_legacy', plan, approve())
  assert.equal(projection.status, 'succeeded')
})

function retryGraph(retryPolicy) {
  return {
    schema: 'aurivox.workflow',
    schema_version: 1,
    id: 'retry_demo',
    name: 'Retry demo',
    inputs: { text: { type: 'TextArtifact', required: true } },
    nodes: [{
      id: 'text',
      type: 'io.text_input',
      type_version: 1,
      retry_policy: retryPolicy,
      params: { workflow_input: 'text' },
    }],
    edges: [],
  }
}

test('executor retries a retryable failure that declares it produced no side effects', async (t) => {
  const store = await tempStore(t)
  const plan = createRunPlan(retryGraph({ max_attempts: 2, backoff_ms: 1 }))
  let calls = 0
  const executor = new WorkflowExecutor({
    journalStore: store,
    sleep: async () => {},
    handlers: {
      'io.text_input': async ({ workflow_inputs }) => {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('temporary'), { code: 'TEMPORARY', retryable: true, side_effects: 'none' })
        return { outputs: { text: workflow_inputs.text } }
      },
    },
    idFactory: () => 'run_retry_1',
  })
  const result = await executor.start(plan, { inputs: { text: { artifact_id: 'text_retry', type: 'TextArtifact' } } })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls, 2)
  assert.equal(result.node_runs.text.node_attempt, 2)
  assert.equal(executor.runtimeInputs.size, 0)
})

test('a node declared idempotent in retry_policy may retry without a handler declaration', async (t) => {
  const store = await tempStore(t)
  const plan = createRunPlan(retryGraph({ max_attempts: 2, backoff_ms: 0, idempotent: true }))
  let calls = 0
  const executor = new WorkflowExecutor({
    journalStore: store,
    sleep: async () => {},
    handlers: {
      'io.text_input': async ({ workflow_inputs }) => {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('temporary'), { code: 'TEMPORARY', retryable: true })
        return { outputs: { text: workflow_inputs.text } }
      },
    },
    idFactory: () => 'run_retry_idempotent',
  })
  const result = await executor.start(plan, { inputs: { text: { artifact_id: 'text_retry', type: 'TextArtifact' } } })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls, 2)
})

test('FLOW-D06: a retryable failure with undeclared side effects fails closed instead of retrying', async (t) => {
  const store = await tempStore(t)
  const plan = createRunPlan(retryGraph({ max_attempts: 3, backoff_ms: 0 }))
  let calls = 0
  const executor = new WorkflowExecutor({
    journalStore: store,
    sleep: async () => {},
    handlers: {
      'io.text_input': async () => {
        calls += 1
        throw Object.assign(new Error('temporary'), { code: 'TEMPORARY', retryable: true })
      },
    },
    idFactory: () => 'run_retry_blocked',
  })
  const result = await executor.start(plan, { inputs: { text: { artifact_id: 'text_retry', type: 'TextArtifact' } } })
  assert.equal(result.status, 'failed')
  assert.equal(calls, 1, 'the handler must not run a second time')
  assert.equal(result.error.code, 'NODE_RETRY_BLOCKED_SIDE_EFFECTS')
  assert.equal(result.error.retryable, false)
  assert.equal(result.error.cause.code, 'TEMPORARY')
  assert.equal(executor.runtimeInputs.size, 0)
})

test('FLOW-D07: cancelling during a failing attempt stops the Run instead of running the next attempt', async (t) => {
  const store = await tempStore(t)
  const plan = createRunPlan(retryGraph({ max_attempts: 3, backoff_ms: 5 }))
  const controller = new AbortController()
  let calls = 0
  const executor = new WorkflowExecutor({
    journalStore: store,
    sleep: () => new Promise(resolve => setTimeout(resolve, 50)),
    handlers: {
      'io.text_input': async () => {
        calls += 1
        // The user cancels while this attempt is in flight; the executor must
        // observe it during the backoff wait rather than starting attempt 2.
        controller.abort(Object.assign(new Error('user cancelled'), { code: 'USER_CANCELLED' }))
        throw Object.assign(new Error('temporary'), { code: 'TEMPORARY', retryable: true, side_effects: 'none' })
      },
    },
    idFactory: () => 'run_cancel_backoff',
  })
  const result = await executor.start(plan, {
    inputs: { text: { artifact_id: 'text_cancel', type: 'TextArtifact' } },
    signal: controller.signal,
  })
  assert.equal(result.status, 'cancelled')
  assert.equal(calls, 1, 'the queued retry attempt must not start')
  assert.equal(result.node_runs.text.status, 'cancelled')
  assert.equal(result.node_runs.text.error.code, 'USER_CANCELLED')
  assert.equal(executor.runtimeInputs.size, 0)
})

test('FLOW-D07: cancelling during the backoff wait interrupts the wait itself', async (t) => {
  const store = await tempStore(t)
  const plan = createRunPlan(retryGraph({ max_attempts: 3, backoff_ms: 5 }))
  const controller = new AbortController()
  let calls = 0
  let sleepInterrupted = false
  const executor = new WorkflowExecutor({
    journalStore: store,
    // A backoff that never settles on its own: only the abort race can end it,
    // so this test hangs if the executor waits on an uninterruptible timer.
    sleep: () => new Promise(resolve => {
      controller.abort(Object.assign(new Error('user cancelled'), { code: 'USER_CANCELLED' }))
      setTimeout(() => { sleepInterrupted = false; resolve() }, 3600000).unref()
    }),
    handlers: {
      'io.text_input': async () => {
        calls += 1
        throw Object.assign(new Error('temporary'), { code: 'TEMPORARY', retryable: true, side_effects: 'none' })
      },
    },
    idFactory: () => 'run_cancel_during_backoff',
  })
  sleepInterrupted = true
  const result = await executor.start(plan, {
    inputs: { text: { artifact_id: 'text_cancel', type: 'TextArtifact' } },
    signal: controller.signal,
  })
  assert.equal(sleepInterrupted, true, 'the backoff must be resolved by the abort, not by its timer')
  assert.equal(result.status, 'cancelled')
  assert.equal(calls, 1, 'the queued retry attempt must not start')
  assert.equal(result.node_runs.text.status, 'cancelled')
  assert.equal(result.node_runs.text.error.code, 'USER_CANCELLED')
  assert.equal(executor.runtimeInputs.size, 0)
})

test('FLOW-D07: an already aborted signal cancels the Run before any node executes', async (t) => {
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const controller = new AbortController()
  controller.abort()
  const calls = []
  const executor = new WorkflowExecutor({ journalStore: store, handlers: handlers(calls), idFactory: () => 'run_cancel_upfront' })
  const result = await executor.start(plan, {
    inputs: { text: { artifact_id: 't', type: 'TextArtifact' }, voice: { artifact_id: 'v', type: 'VoiceRef' } },
    signal: controller.signal,
  })
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(calls, [])
  assert.equal(executor.runtimeInputs.size, 0)
})

test('FLOW-D21: a Run awaiting review keeps its runtime inputs and drops them once terminal', async (t) => {
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const executor = new WorkflowExecutor({ journalStore: store, handlers: handlers([]), idFactory: () => 'run_lifecycle_1' })
  const waiting = await executor.start(plan, {
    inputs: { text: { artifact_id: 't', type: 'TextArtifact' }, voice: { artifact_id: 'v', type: 'VoiceRef' } },
  })
  assert.equal(waiting.status, 'awaiting_human_review')
  assert.equal(executor.runtimeInputs.size, 1, 'inputs must survive until the Gate is resolved')
  const done = await executor.resume('run_lifecycle_1', plan, {
    gate_id: 'gate_executor_001',
    expected_gate_revision: 1,
    decision: 'cancel',
    operator: 'local-user',
  })
  assert.equal(done.status, 'cancelled')
  assert.equal(executor.runtimeInputs.size, 0)
})

test('executor records handler failure as NodeRun and failed Run', async (t) => {
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const executor = new WorkflowExecutor({
    journalStore: store,
    handlers: {
      'io.text_input': async () => { throw Object.assign(new Error('input exploded'), { code: 'TEST_HANDLER_FAILURE' }) },
    },
    idFactory: () => 'run_failure_1',
  })
  const result = await executor.start(plan, { inputs: { text: { artifact_id: 't', type: 'TextArtifact' }, voice: { artifact_id: 'v', type: 'VoiceRef' } } })
  assert.equal(result.status, 'failed')
  assert.equal(result.node_runs.text.error.code, 'TEST_HANDLER_FAILURE')
  assert.equal(result.error.code, 'TEST_HANDLER_FAILURE')
})

// =========================================================================== //
//  FLOW-D27 stage 2 (channel 1) — output-value sidecar
//
//  Contract: docs/FLOW-D27-JOURNAL-PLAINTEXT-CONTRACT.md (R3, frozen).
//  These seven tests are the load-bearing evidence for §4.1 (value
//  preservation), §4.5 (sidecar identity), §4.6 (consistency boundary),
//  §4.3 (lifecycle) and §4.4/§4.7 (fail-closed).
//
//  The one property every single one of them exists to protect: a run that
//  reports 'succeeded' while having synthesised a digest, a placeholder or a
//  redaction marker is NOT a pass. It is silent semantic corruption, and it is
//  strictly worse than a loud failure. 'status === succeeded' is therefore
//  never on its own an acceptance criterion below.
// =========================================================================== //

// Deliberately free of characters JSON.stringify escapes (control chars, quote,
// backslash). An earlier draft of this constant contained \u0000; the Journal
// then held the plaintext while `raw.includes(D27_TEXT)` was false, because the
// on-disk form was escaped. T1 passed against the UNFIXED executor -- a false
// pass of exactly the kind this whole debt has produced twice before. The
// mutation run below is what caught it, not the green tick.
const D27_TEXT = '今日は Thank you — ᚠᚢᚦ 𝄞 tail'

// A capturing variant of handlers(). Same graph, same shapes; it additionally
// records, per node, the exact input object each handler was handed, so a test
// can compare what a downstream node RECEIVED against what the upstream node
// PRODUCED -- rather than inferring correctness from the absence of an
// exception.
function capturingHandlers(seen) {
  const base = handlers([])
  const wrapped = {}
  for (const [type, fn] of Object.entries(base)) {
    wrapped[type] = async (ctx) => {
      seen.push({ type, node_id: ctx.node.id, inputs: ctx.inputs, workflow_inputs: ctx.workflow_inputs })
      return fn(ctx)
    }
  }
  return wrapped
}

function d27Inputs(value = D27_TEXT) {
  return {
    text: { artifact_id: 'art_text_1', type: 'TextArtifact', value },
    voice: { artifact_id: 'voice_1', type: 'VoiceRef' },
  }
}

function nodeSucceededLines(raw) {
  return raw.split(/\r?\n/).filter((line) => line.includes('"NODE_SUCCEEDED"'))
}

// --------------------------------------------------------------------------- //
//  T1 — value preservation across the Human Gate (the load-bearing property)
// --------------------------------------------------------------------------- //

test('FLOW-D27 T1: a post-Gate node receives the pre-Gate output value unchanged', async (t) => {
  // This is the test the FIRST D27 probe could not have written, and the reason
  // that probe produced a false pass: its graph had no consumer of the text
  // output AFTER the Gate, so the resume path that actually needs the real
  // value was never exercised. workflow() does have one -- 'tts' consumes
  // route.text and only runs once the Gate is approved.
  const store = await tempStore(t)
  const seen = []
  const plan = createRunPlan(workflow())
  const executor = new WorkflowExecutor({ journalStore: store, handlers: capturingHandlers(seen), idFactory: () => 'run_d27_t1' })

  const waiting = await executor.start(plan, { inputs: d27Inputs() })
  assert.equal(waiting.status, 'awaiting_human_review')

  const done = await executor.resume('run_d27_t1', plan, approve())
  assert.equal(done.status, 'succeeded')

  // Character-for-character, not "contains", not "is truthy", not "is a string".
  const tts = seen.find((s) => s.node_id === 'tts')
  assert.ok(tts, 'the post-Gate node must actually have run')
  assert.deepStrictEqual(tts.inputs.text, d27Inputs().text)
  assert.strictEqual(tts.inputs.text.value, D27_TEXT)

  // ...and the value it received was never on disk.
  const raw = await fs.readFile(store.pathFor('run_d27_t1'), 'utf8')
  for (const line of nodeSucceededLines(raw)) {
    assert.ok(!line.includes(D27_TEXT), 'no NODE_SUCCEEDED event may carry the plaintext')
  }
  // Note the deliberately narrow scope: only NODE_SUCCEEDED is claimed clean.
  // GATE_CREATED (channel 3) is untouched by stage 2 and remains in stage 3's
  // scope; asserting over the whole file would overstate what was fixed.
})

// --------------------------------------------------------------------------- //
//  T2 — what the Journal keeps: port key set, custody list, no wrapper
// --------------------------------------------------------------------------- //

test('FLOW-D27 T2: the Journal keeps every port key, marks custody, and wraps nothing', async (t) => {
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const executor = new WorkflowExecutor({ journalStore: store, handlers: handlers([]), idFactory: () => 'run_d27_t2' })
  await executor.start(plan, { inputs: d27Inputs() })
  const projection = await executor.resume('run_d27_t2', plan, approve())

  const route = projection.node_runs.route
  // The PORT KEY SET must survive intact. Collapsing outputs into one blob would
  // silently break every optional edge, which §4.4 forbids.
  assert.deepEqual(Object.keys(route.outputs).sort(), ['language_assignment', 'text'])

  // Custody is per-port and explicit: a reader must never have to guess whether
  // what it found is the value or a description of it.
  assert.deepEqual(route.outputs_custody, ['text'])

  // The content-bearing port is reduced to a digest -- and the digest is a
  // DESCRIPTION, so it is allowed to look nothing like the value.
  assert.equal(route.outputs.text.artifact_id, 'art_text_1')
  assert.equal(route.outputs.text.type, 'TextArtifact')
  assert.ok(route.outputs.text.redacted_fields, 'the non-identity fields must be summarised')
  assert.deepEqual(route.outputs.text.redacted_fields.keys, ['value'])
  assert.ok(!JSON.stringify(route.outputs.text).includes(D27_TEXT))

  // The journal-safe port is passed through VERBATIM. Not "equivalent", not
  // "wrapped in {kind:'artifact_ref'}" -- the snapshot IS the value. The first
  // implementation of this slice copied inputSnapshot()'s wrapper here, and
  // that wrapper is precisely what broke §4.1 value preservation. Symmetry with
  // an existing function is a symmetry of DUTY, not of shape.
  assert.deepStrictEqual(
    route.outputs.language_assignment,
    { artifact_id: 'art_lang_1', type: 'LanguageAssignment' },
  )
  assert.ok(!('kind' in route.outputs.language_assignment))
})

// --------------------------------------------------------------------------- //
//  T3 — journal-safe outputs remain resumable on a fresh Executor instance
// --------------------------------------------------------------------------- //

test('FLOW-D27 T3: identity-only outputs still resume on a fresh Executor instance', async (t) => {
  // R3 §3.2 capability 2. This is the positive half of the capability statement
  // whose negative half A2 pins in the D10b inline test above: what stage 2
  // gives up is exactly and only the outputs whose content left the Journal.
  // Nothing wider. If this test ever goes red, the loss stopped being
  // co-extensive with the protection and the trade no longer holds.
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const identityOnly = {
    text: { artifact_id: 'art_text_1', type: 'TextArtifact' },
    voice: { artifact_id: 'voice_1', type: 'VoiceRef' },
  }
  const first = new WorkflowExecutor({ journalStore: store, handlers: handlers([]), idFactory: () => 'run_d27_t3' })
  const waiting = await first.start(plan, { inputs: identityOnly })
  assert.equal(waiting.status, 'awaiting_human_review')
  assert.deepEqual(waiting.node_runs.text.outputs_custody, [], 'an identity-only output is journal-safe')

  const calls = []
  const restarted = new WorkflowExecutor({
    journalStore: store,
    handlers: handlers(calls),
    inputResolver: async () => ({ ...identityOnly }),
  })
  const done = await restarted.resume('run_d27_t3', plan, approve())
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(calls, ['voice', 'tts', 'output:art_audio_1'])
})

// --------------------------------------------------------------------------- //
//  T4 — sidecar identity: run + node + attempt + port
// --------------------------------------------------------------------------- //

test('FLOW-D27 T4: sibling ports are isolated and the sidecar key carries run/node/attempt/port', async (t) => {
  // §4.5. A key of run+node alone would let one port overwrite its sibling and
  // let a D06 retry serve a stale attempt's value downstream -- both of which
  // produce a WRONG artifact rather than an error, which is the failure class
  // this whole slice exists to make impossible.
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const twoPorts = {
    ...handlers([]),
    'text.auto_language': async ({ inputs }) => ({
      outputs: {
        text: inputs.text,
        // A SECOND content-bearing port on the same node, distinguishable from
        // the first. If the sidecar keyed on the node alone, one would win.
        language_assignment: { artifact_id: 'art_lang_1', type: 'LanguageAssignment', value: 'SIBLING-' + D27_TEXT },
      },
    }),
  }
  const executor = new WorkflowExecutor({ journalStore: store, handlers: twoPorts, idFactory: () => 'run_d27_t4' })
  const waiting = await executor.start(plan, { inputs: d27Inputs() })
  assert.equal(waiting.status, 'awaiting_human_review')
  assert.deepEqual(waiting.node_runs.route.outputs_custody.sort(), ['language_assignment', 'text'])

  // White-box on purpose: the key SHAPE is the contract, and a black-box test
  // cannot distinguish "keyed correctly" from "happened not to collide today".
  const bucket = executor.outputValues.get('run_d27_t4')
  assert.ok(bucket, 'the sidecar must hold values while the Gate is open')
  const routeKeys = [...bucket.keys()].filter((k) => k.startsWith('route\u0000'))
  assert.deepEqual(routeKeys.sort(), ['route\u00001\u0000language_assignment', 'route\u00001\u0000text'])
  assert.equal(bucket.get('route\u00001\u0000text').value, D27_TEXT)
  assert.equal(bucket.get('route\u00001\u0000language_assignment').value, 'SIBLING-' + D27_TEXT)
  assert.notEqual(bucket.get('route\u00001\u0000text').value, bucket.get('route\u00001\u0000language_assignment').value)
})

// --------------------------------------------------------------------------- //
//  T5 — fail-closed when a required runtime value is gone
// --------------------------------------------------------------------------- //

test('FLOW-D27 T5: a missing sidecar value fails closed instead of handing over a digest', async (t) => {
  // §4.4/§4.7. The forbidden behaviour is not "crash" -- it is "carry on".
  // Falling back to the Journal snapshot would hand tts.generate an object
  // reading {kind:'inline_digest', digest:'sha256:...'} and cheerfully
  // synthesise it. The run would be green and the audio would be garbage.
  const store = await tempStore(t)
  const seen = []
  const plan = createRunPlan(workflow())
  const executor = new WorkflowExecutor({ journalStore: store, handlers: capturingHandlers(seen), idFactory: () => 'run_d27_t5' })
  await executor.start(plan, { inputs: d27Inputs() })

  // Simulate the only way this can legitimately happen: the process that held
  // the value is gone. Same effect, without a second process.
  executor.outputValues.clear()

  const done = await executor.resume('run_d27_t5', plan, approve())
  assert.equal(done.status, 'failed')
  // The literal code string, not a constant re-imported from the module under
  // test -- a renamed constant must break this, since the name is frozen.
  assert.equal(done.error.code, 'NODE_OUTPUT_VALUE_UNAVAILABLE')
  assert.equal(done.error.retryable, false)
  assert.equal(done.node_runs.tts.error.code, 'NODE_OUTPUT_VALUE_UNAVAILABLE')

  // The actual guarantee: the handler was never reached with substitute data.
  assert.equal(seen.filter((s) => s.node_id === 'tts').length, 0, 'no handler may be invoked with a redacted value')
})

// --------------------------------------------------------------------------- //
//  T6 — consistency boundary with the Journal commit
// --------------------------------------------------------------------------- //

test('FLOW-D27 T6: a failed NODE_SUCCEEDED append leaves no addressable sidecar value', async (t) => {
  // §4.6. The dangerous interleaving is "Journal says succeeded, the real value
  // is gone". The mirror case tested here -- value staged, append lost -- must
  // not leave a value that a later reader could bind to an attempt the Journal
  // never acknowledged.
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  let failNext = false
  const brittle = {
    pathFor: (id) => store.pathFor(id),
    create: (j) => store.create(j),
    read: (id) => store.read(id),
    replay: (id) => store.replay(id),
    listRunIds: () => store.listRunIds(),
    remove: (id) => store.remove(id),
    append: async (id, event) => {
      if (failNext && event.type === 'NODE_SUCCEEDED' && event.event_id.includes('_text_')) {
        throw Object.assign(new Error('disk went away'), { code: 'TEST_APPEND_FAILED' })
      }
      return store.append(id, event)
    },
  }
  failNext = true
  const executor = new WorkflowExecutor({ journalStore: brittle, handlers: handlers([]), idFactory: () => 'run_d27_t6' })
  const result = await executor.start(plan, { inputs: d27Inputs() })

  assert.equal(result.status, 'failed')
  const raw = await fs.readFile(store.pathFor('run_d27_t6'), 'utf8')
  assert.ok(!raw.includes('"NODE_SUCCEEDED"'), 'the node must not be recorded as succeeded')

  // Nothing from the uncommitted attempt may remain addressable.
  const bucket = executor.outputValues.get('run_d27_t6')
  assert.ok(bucket === undefined || !bucket.has('text\u00001\u0000text'), 'the rolled-back value must not survive')
})

// --------------------------------------------------------------------------- //
//  T7 — lifecycle: released on every terminal outcome
// --------------------------------------------------------------------------- //

test('FLOW-D27 T7: the sidecar is released on every terminal outcome, not just success', async (t) => {
  // §4.3. "Retain while awaiting human review" is the only retention rule; a
  // rejected or cancelled run holding user plaintext in memory indefinitely
  // would reintroduce the exposure this slice removes, one level up.
  for (const [decision, expected] of [['approve', 'succeeded'], ['reject', 'rejected'], ['cancel', 'cancelled']]) {
    const store = await tempStore(t)
    const runId = `run_d27_t7_${decision}`
    const plan = createRunPlan(workflow())
    const executor = new WorkflowExecutor({ journalStore: store, handlers: handlers([]), idFactory: () => runId })

    const waiting = await executor.start(plan, { inputs: d27Inputs() })
    assert.equal(waiting.status, 'awaiting_human_review')
    assert.equal(executor.outputValues.size, 1, `${decision}: values must survive until the Gate is resolved`)

    const done = await executor.resume(runId, plan, { ...approve(), decision })
    assert.equal(done.status, expected)
    assert.equal(executor.outputValues.size, 0, `${decision}: the sidecar must be released`)
  }

  // ...and the same on an outright handler failure, which never reaches a Gate.
  const store = await tempStore(t)
  const plan = createRunPlan(workflow())
  const failing = new WorkflowExecutor({
    journalStore: store,
    handlers: {
      ...handlers([]),
      'text.auto_language': async () => { throw Object.assign(new Error('boom'), { code: 'TEST_ROUTE_FAILURE' }) },
    },
    idFactory: () => 'run_d27_t7_failed',
  })
  const failed = await failing.start(plan, { inputs: d27Inputs() })
  assert.equal(failed.status, 'failed')
  assert.equal(failing.outputValues.size, 0, 'a failed Run must release its sidecar too')
})
