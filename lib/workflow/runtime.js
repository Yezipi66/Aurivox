'use strict'

// ===========================================================================
//  FLOW-CORE-004: live wiring (Executor <-> real synthesis service)
// ===========================================================================
// Everything under lib/workflow/ was, until this file existed, unreachable from
// a running process: nothing in server.js or lib/routes/ required it. 182 tests
// proved the kernel behaves correctly WHEN CALLED, not that anything called it.
//
// This module is the missing wire. It is deliberately the ONLY place that knows
// both sides, so the boundary stays inspectable:
//
//   - it owns no synthesis logic (that stays in lib/services/synthesisService.js)
//   - it owns no scheduling logic (that stays in executor.js)
//   - it registers one handler per node type and nothing else
//
// SCOPE (FLOW-CORE-004 slice): the narrowest graph that exercises a real
// engine call end to end —
//
//     io.text_input + io.voice_input -> tts.generate -> review.human_gate
//                                                    -> io.audio_output
//
// Node types outside that path are intentionally NOT registered. Asking the
// executor to run them raises NODE_HANDLER_NOT_FOUND, which is the correct
// fail-closed answer: an unimplemented node must not look like a working one.
//
// KNOWN LIMIT — cross-process resume. Run Plans and workflow inputs are held in
// memory here. After a restart the Journal survives but the plan does not, so a
// resume raises WORKFLOW_INPUT_REBIND_REQUIRED (FLOW-D05) unless an
// inputResolver is injected. That is the contracted behaviour, not a bug; the
// automatic path needs the Artifact Store write side, which FLOW-D10b
// explicitly does not implement (see matrix §4.2).

const path = require('path')

const { createRunPlan } = require('./validator')
const { createGateInstance } = require('./humanGate')
const { FileRunJournalStore } = require('./fileJournalStore')
const { WorkflowExecutor } = require('./executor')
const { createLegacySynthesisAdapter } = require('./adapters/legacySynthesis')

const FLOW_RUNS_DIRNAME = '_flow_runs'

function runtimeError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// A source node's job is to hand the bound workflow input straight through. The
// executor already resolved bindings into `workflow_inputs`; re-deriving them
// here would create a second, divergent binding path.
// The binding key comes from the node's `params.workflow_input`, which is the
// name the validator checks against the workflow's `inputs` declaration. An
// earlier draft of this file invented `params.input_key`; the first real
// end-to-end run rejected it, which is precisely the class of drift that
// mock-handler tests cannot catch.
function sourceHandler(portName, inputKey) {
  return async ({ workflow_inputs = {}, node = {} }) => {
    const key = (node.params && node.params.workflow_input) || inputKey
    const value = workflow_inputs[key]
    if (value === undefined) {
      throw runtimeError('FLOW_SOURCE_INPUT_MISSING', `Source node '${node.id}' has no workflow input bound to '${key}'`, {
        node_id: node.id,
        expected_input: key,
      })
    }
    return { outputs: { [portName]: value } }
  }
}

// Gate ids must be deterministic: the executor writes GATE_CREATED into an
// append-only Journal keyed by event_id, so a random id would make a replayed
// or retried attempt look like a different Gate.
function gateHandler({ clock }) {
  return async ({ inputs = {}, run_id, node = {}, node_attempt, plan = {} }) => {
    const params = node.params || {}
    const gate = createGateInstance({
      gate_id: `${run_id}__${node.id}__${node_attempt}`,
      run_id,
      node_id: node.id,
      node_attempt,
      review_schema: params.review_schema || 'audio.review.v1',
      input_artifacts: inputs.review_target,
      decisions: params.decisions || ['approve', 'submit_revision', 'reject', 'cancel'],
      workflow_revision_id: plan.workflow_revision_id,
      run_plan_fingerprint: plan.run_plan_fingerprint,
      created_at: clock(),
    })
    return { status: 'waiting', gate }
  }
}

// The terminal node records where the audio ended up. It deliberately does not
// copy, move or register the file anywhere: publishing artifacts is Artifact
// Store work (unimplemented, matrix §4.2), and faking it here would make the
// Store look less necessary than it is.
async function audioOutputHandler({ inputs = {} }) {
  const audio = Array.isArray(inputs.audio) ? inputs.audio[0] : inputs.audio
  if (!audio || typeof audio !== 'object') {
    throw runtimeError('FLOW_OUTPUT_AUDIO_MISSING', 'io.audio_output received no AudioArtifact')
  }
  return {
    outputs: {},
    metrics: {
      artifact_id: audio.artifact_id,
      uri: audio.uri || null,
      fingerprint_kind: audio.fingerprint_kind || null,
    },
  }
}

function buildHandlers({ generateService, clock }) {
  return {
    'io.text_input': sourceHandler('text', 'text'),
    'io.voice_input': sourceHandler('voice', 'voice'),
    'io.audio_input': sourceHandler('audio', 'audio'),
    'tts.generate': createLegacySynthesisAdapter({ generateService }),
    'review.human_gate': gateHandler({ clock }),
    'io.audio_output': audioOutputHandler,
  }
}

// ---------------------------------------------------------------------------
//  Runtime
// ---------------------------------------------------------------------------

class FlowRuntime {
  constructor({ executor, journalStore, journalDir }) {
    this.executor = executor
    this.journalStore = journalStore
    this.journalDir = journalDir
    // run_id -> { plan, workflow, created_at }. Memory only; see KNOWN LIMIT.
    this._plans = new Map()
  }

  planFor(runId) {
    const entry = this._plans.get(runId)
    if (!entry) {
      throw runtimeError('FLOW_RUN_PLAN_UNAVAILABLE', `No in-memory Run Plan for '${runId}'. The process was restarted; resume requires an inputResolver (FLOW-D05/D10a).`, {
        run_id: runId,
        retryable: false,
      })
    }
    return entry
  }

  async startRun({ workflow, inputs = {}, run_id = null, signal = null }) {
    const plan = createRunPlan(workflow)
    const projection = await this.executor.start(plan, { run_id, inputs, signal })
    this._plans.set(projection.run_id, { plan, workflow, created_at: new Date().toISOString() })
    return projection
  }

  async resumeGate(runId, { gate_id, expected_gate_revision, decision, operator, comment, outputs = {}, signal = null }) {
    const { plan } = this.planFor(runId)
    return this.executor.resume(runId, plan, {
      gate_id, expected_gate_revision, decision, operator, comment, outputs, signal,
    })
  }

  async getRun(runId) {
    return this.journalStore.replay(runId)
  }

  async listRuns() {
    return this.journalStore.listRunIds()
  }

  knownRunIds() {
    return [...this._plans.keys()]
  }
}

function createFlowRuntime(ctx = {}, options = {}) {
  const {
    generateService,
    journalDir,
    clock = () => new Date().toISOString(),
    inputResolver = null,
    artifactStore = null,
  } = options

  if (typeof generateService !== 'function') {
    throw runtimeError('FLOW_RUNTIME_SERVICE_REQUIRED', 'createFlowRuntime requires a generateService function')
  }

  const dir = journalDir
    || (ctx.OUTPUT_DIR ? path.join(ctx.OUTPUT_DIR, FLOW_RUNS_DIRNAME) : null)
  if (!dir) {
    throw runtimeError('FLOW_RUNTIME_JOURNAL_DIR_REQUIRED', 'createFlowRuntime requires journalDir or ctx.OUTPUT_DIR')
  }

  const journalStore = new FileRunJournalStore(dir)
  const executor = new WorkflowExecutor({
    journalStore,
    handlers: buildHandlers({ generateService, clock }),
    clock,
    inputResolver,
    artifactStore,
  })

  return new FlowRuntime({ executor, journalStore, journalDir: dir })
}

module.exports = {
  FLOW_RUNS_DIRNAME,
  FlowRuntime,
  audioOutputHandler,
  buildHandlers,
  createFlowRuntime,
  gateHandler,
  sourceHandler,
}
