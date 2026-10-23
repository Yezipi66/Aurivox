'use strict'

// 工作流执行器：按 Run Plan 驱动节点，把每一步写进 Run Journal，重启后能接着跑。
// 三条判据：Journal 是唯一权威（真实值不进 Journal，只进进程内的 sidecar）；
// 重新绑定运行输入必须与 Journal 里的快照对账；重试前必须声明副作用。
// 不认识任何具体节点类型：节点行为由 handler 提供，节点定义由 nodeRegistry 提供。

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

// 只有失败那次的副作用被显式交代过，才允许重试。
// 交代的方式有两种：handler 报出 side_effects，或工作流作者在 retry_policy 里声明该节点幂等。
const RETRY_SIDE_EFFECT_DECLARATIONS = new Set(['none', 'idempotent'])

// inputResolver 可以在重启后重新绑定运行输入，但它的返回值不被直接采信：
// 每个重新绑定的值都要与 Run Journal 里已记录的 workflow_input_snapshot 对账
// （docs/FLOW-D10-INPUT-REBIND-CONTRACT.md）。
// 对账 artifact_ref 只能证明引用一致，不能证明字节一致；字节一致靠 artifact 内容不可变这一前提。
//
// 注入了 artifactStore 时，对账通过后还要与 Store 核对 artifact 是否存在、描述符是否一致
// （docs/FLOW-D10B-ARTIFACT-STORE-CONTRACT.md）。Store 是可选的：不注入时只做快照对账，
// 不得因为没有 Store 给单进程运行造出新的失败方式。

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

// Journal 里的记录要够重启后重新绑定输入用，但绝不把任意文本或音频负载写进持久的 Run Journal。
// 像 artifact 的输入只留身份与指纹；基本类型只留摘要与长度。真实值留在进程里，或由 inputResolver 重新解析。
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

// 节点输出写进 Journal 前同样要缩减，但与输入不同：让 artifact 可以被定位的字段原样保留，
// 只把内容缩成摘要。照抄 inputSnapshot() 会把 uri 与 fingerprint_kind 从 HTTP 投影里抹掉，
// 变成一次对外接口形状改动。
//
// 下面是白名单而不是黑名单：将来给 artifact 增加的任何字段，默认都被摘要掉，用户原文不进 Journal。
const OUTPUT_IDENTITY_FIELDS = Object.freeze(['artifact_id', 'type', 'uri', 'fingerprint', 'fingerprint_kind'])

// 一个值可以直接进 Journal 的条件：冻结的白名单已经完整描述了它，即只带身份字段的
// artifact 引用，或者一个基本类型。这样的值没有白名单外的字段要摘要，
// 所以快照就是值本身，不许再套任何包装层。原样保留不增加任何保护成本，还保住一项已验证的能力：
// 通过 inputResolver 重启续跑时，它要把这些输出从 Journal 里读回去。
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

// 端口的键集必须保住。executor.js 里的
// `if (value === undefined) continue` 带着一个正当含义：「这个端口根本没有产出」（可选边）。
// 把输出并成一坨，就只能在「破坏每一条可选边」与「把摘要当真值静默往下传」之间二选一。
// 返回两样东西：给 Journal 用的快照，以及真实值现在只由 sidecar 持有的端口清单。
// 归属按端口逐个记录且写明：下游读到的究竟是值本身还是值的描述，不许它猜。
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

// 把一个重新绑定的值与它记录的快照条目对账。
// 返回不匹配的描述符，值一致时返回 null。
//
// 诊断信息可以带摘要、长度与 artifact 身份，但绝不带原文：inline_digest 存在的意义就是让原始负载
// 不进 Journal，拒绝路径也不该把这层保护撤销掉。
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
      // Object.is 让 NaN 自等，并把 -0 与 0 分开。
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

// 完整对账，键集的两个方向都要查。
// 多出来的键（UNEXPECTED_KEY）也必须失败：多出来的键会进入 _drive()，可能被节点读到，
// 那就是一个 Journal 从未记录过的输入。
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

// 取消是协作式的。Executor 自己观察 abort 信号，不依赖 handler 注意到它。
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
    // 构造时就验 Store 的形状，而不是等到重启恢复时；「按 lineage 隐式取最新版本」
    // 一类的方法在这里就被拒绝，恢复只能绑定原来的版本。
    if (artifactStore !== null) assertReadOnlyArtifactStore(artifactStore)
    this.journalStore = journalStore
    this.handlers = handlers instanceof Map ? handlers : new Map(Object.entries(handlers || {}))
    this.idFactory = idFactory
    this.clock = clock
    this.sleep = sleep
    this.inputResolver = inputResolver
    this.artifactStore = artifactStore
    this.runtimeInputs = new Map()
    // 节点输出的真实值（sidecar）留在这里，永远不进持久的 Journal。
    // 键是 run_id → (node_id, attempt, port)：这样重试不会把上一次尝试的值喂给下游节点，
    // 同一节点的多个端口也不会互相覆盖。
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

  // Journal 是权威。NODE_SUCCEEDED 事件若没有提交，
  // 那次尝试的 sidecar 值就都不许再被取到，否则这一层造出了一个原本不存在的状态。
  _discardOutputValues(runId, keys) {
    const bucket = this.outputValues.get(runId)
    if (!bucket) return
    for (const key of keys) bucket.delete(key)
    if (bucket.size === 0) this.outputValues.delete(runId)
  }

  // 哪一次尝试算数由 Journal 回放投影决定，不看 sidecar 里还剩下什么。
  _readNodeOutput(runId, projection, nodeId, port) {
    const nodeRun = projection.node_runs[nodeId]
    const outputs = nodeRun?.outputs || {}
    if (!(port in outputs) || outputs[port] === undefined) return undefined
    // 门控输出（GATE_RESOLVED）、可以直接进 Journal 的身份引用，以及第二阶段之前写下的 Journal，
    // 它们的值就在 Journal 里，从那里原样读出。
    const custody = Array.isArray(nodeRun.outputs_custody) ? nodeRun.outputs_custody : []
    if (!custody.includes(port)) return outputs[port]
    const attempt = nodeRun.node_attempt
    const key = outputValueKey(nodeId, attempt, port)
    const bucket = this.outputValues.get(runId)
    if (!bucket || !bucket.has(key)) {
      // 失败即关闭，且不可重试。把摘要或快照对象交给 handler 就是一次静默的语义损坏，
      // 而那正是这一层要防的失败形态。
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

  // 运行输入只活在进程里，不许比这次 Run 活得久。
  // 每个出口都走 _settle，所以 Run 结束时会丢掉内存里的负载；
  // awaiting_human_review 是刻意的例外，它保留输入以便续跑。
  async _settle(runId) {
    const projection = await this.journalStore.replay(runId)
    if (TERMINAL_RUN_STATES.has(projection.status)) {
      this.runtimeInputs.delete(runId)
      // 每一种终局都要释放 sidecar，succeeded、failed、rejected、cancelled、stale 一概如此。
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
          // 在 Executor 里再查一次：入口检查与注册监听之间若来了 abort，
          // 就会丢掉这次唤醒，让 Run 白等完整个退避时间。
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

  // 只跑在快照对账通过之后，顺序是刻意的：Run Journal 是本地且只追加的，
  // Store 是外部可变状态。先信更强的那个来源，被污染的 Store 也拦得住。
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
        // 连不上 Store 与 artifact 不存在是两回事。任何抛出都按基础设施故障处理并标为可重试，
        // 把一次临时故障误读成「artifact 已被回收」，就把一次等待变成了一次永久丢失。
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
      // 与快照对账失败一样，这里不写进 Run Journal：发生这件事时，这次 Run 的身份还没重新确立。
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
      // 重新绑定的输入必须与 Run 启动时记录的快照对账，否则 Run 会悄悄用一批从未记录过的输入跑下去。
      // 失败即关闭：不警告后继续，也不部分接受。
      const mismatches = reconcileRuntimeInputs(snapshot, resolved)
      if (mismatches.length > 0) {
        throw executorError('WORKFLOW_INPUT_REBIND_MISMATCH', `Run '${runId}' input rebind does not match recorded snapshot`, {
          run_id: runId,
          mismatches,
        })
      }
      // 确认快照一致之后，才去问外部 Store 那些 artifact 是否还在。
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
          // 先暂存 sidecar、Journal 提交失败再回滚，让「Journal 说成功而真实值已丢」在进程内不可能发生。
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
          // 绝不悄悄重跑一个副作用没交代过的 handler。
          // 没有声明时 Run 失败即关闭。
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
