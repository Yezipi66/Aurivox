'use strict'

// 把内核接到真实的合成服务上。这是唯一同时知道两边的
// 地方，边界因此可检查：它不拥有合成逻辑（在 lib/services/synthesisService.js），
// 不拥有调度逻辑（在 executor.js），只按节点类型注册 handler。
//
// 覆盖范围只有一条最窄的、真正打通引擎调用的路径：
// io.text_input + io.voice_input → tts.generate → review.human_gate → io.audio_output
// 路径之外的节点类型不注册：执行器遇到它们抛 NODE_HANDLER_NOT_FOUND，
// 这是正确的 fail-closed 答案，未实现的节点不能看起来像能用的节点。
//
// 已知限制：跨进程恢复。Run Plan 与工作流输入只存在内存里，进程重启后 Journal
// 还在、计划没了，因此恢复会抛 WORKFLOW_INPUT_REBIND_REQUIRED，
// 除非注入了 inputResolver。这是约定好的行为而不是缺陷：自动恢复需要
// Artifact Store 的写入侧，而那一部分按设计未实现。

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

// 来源节点只负责把绑定了的工作流输入原样传出去。执行器已经把绑定解析进
// workflow_inputs 了，在这里重新推导会多出一条会分叉的绑定路径。
// 绑定的键名取自节点的 params.workflow_input，也就是校验器拿去和工作流 inputs
// 声明对照的那个名字。
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

// Gate 的 id 必须可复算：执行器把 GATE_CREATED 写进按 event_id 索引的追加式
// Journal，随机的 id 会让重放或重试看起来像是另一个 Gate。
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

// 终端节点只记录音频落到了哪里，故意不复制、不移动、不登记：发布产物是
// Artifact Store 的活（按设计未实现），在这里假做会让 Store 显得没那么必要。
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

// 运行时的运行记录与计划。

class FlowRuntime {
  constructor({ executor, journalStore, journalDir }) {
    this.executor = executor
    this.journalStore = journalStore
    this.journalDir = journalDir
    // run_id -> { plan, workflow, created_at }。只在内存里，见文件头的已知限制。
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
