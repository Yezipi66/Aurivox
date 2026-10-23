'use strict'

// 流程图引擎：校验一张图，按节点顺序执行，并把每个值管到被释放为止。
// 四项能力：节点可以挂起等外部给值；条件为 0 的边不执行下游；小循环按列表逐项重复；
// 值的生命周期显式，谁也不释放就一直占着内存，直到 sys.release 节点消费它。
// 与 lib/workflow/ 的差别：这里没有账本、没有评审记录、没有审批词汇，也没有「人」的概念。
// 暂停只是一个布尔来源，谁提供那个布尔值不由引擎决定。
// 失败策略：立即停止，不释放内存，保留工作状态并抛出带位置的错误。
// 这里的错误按「运行环境在脚下变了」（文件被移动、锁被拿走）来报，所以消息要点名文件与轮次。

const nodeFs = require('node:fs')
const nodePath = require('node:path')

require('./nodes')
require('./qualityNodes')
const { getDefinition } = require('./registry')
const { accepts } = require('./types')

const RUN_STATES = Object.freeze({
  RUNNING: 'running',
  AWAITING_INPUT: 'awaiting_input',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
})

class FlowRunError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'FlowRunError'
    Object.assign(this, details)
  }
}

function engineError(code, message, details = {}) {
  return new FlowRunError(message, Object.assign({ code }, details))
}

// 图结构辅助函数

function normaliseIncoming(node) {
  // node.inputs 的形状：{ 端口名: {node, port} | [{node, port}] }
  const out = []
  for (const [portName, ref] of Object.entries(node.inputs || {})) {
    const refs = Array.isArray(ref) ? ref : [ref]
    for (const one of refs) {
      if (!one || typeof one.node !== 'string') continue
      out.push({ port: portName, from: one.node, fromPort: one.port })
    }
  }
  return out
}

function buildIndex(graph) {
  const nodes = new Map()
  for (const node of graph.nodes || []) {
    if (nodes.has(node.id)) throw engineError('FG_DUPLICATE_NODE_ID', `图里有两个节点用了同一个编号 '${node.id}'`)
    nodes.set(node.id, node)
  }
  const incoming = new Map()
  const outgoing = new Map()
  for (const node of nodes.values()) {
    const links = normaliseIncoming(node)
    incoming.set(node.id, links)
    for (const link of links) {
      if (!nodes.has(link.from)) {
        throw engineError('FG_EDGE_DANGLING', `节点 '${node.id}' 接到了一个不存在的节点 '${link.from}'`, { node_id: node.id, missing: link.from })
      }
      if (!outgoing.has(link.from)) outgoing.set(link.from, [])
      outgoing.get(link.from).push({ to: node.id, toPort: link.port, fromPort: link.fromPort })
    }
  }
  return { nodes, incoming, outgoing }
}

function descendants(index, startId) {
  const seen = new Set()
  const stack = [startId]
  while (stack.length) {
    const id = stack.pop()
    for (const edge of index.outgoing.get(id) || []) {
      if (seen.has(edge.to)) continue
      seen.add(edge.to)
      stack.push(edge.to)
    }
  }
  return seen
}

function ancestors(index, endId) {
  const seen = new Set()
  const stack = [endId]
  while (stack.length) {
    const id = stack.pop()
    for (const link of index.incoming.get(id) || []) {
      if (seen.has(link.from)) continue
      seen.add(link.from)
      stack.push(link.from)
    }
  }
  return seen
}

// 校验：图一旦跑不起来就在开始前拒绝，不先执行一部分再报错

function validateGraph(graph) {
  const problems = []
  const index = buildIndex(graph)

  for (const node of index.nodes.values()) {
    const def = getDefinition(node.type)
    if (!def) {
      problems.push({ code: 'FG_UNKNOWN_NODE_TYPE', node_id: node.id, message: `不认识这种节点：${node.type}` })
      continue
    }
    const links = index.incoming.get(node.id) || []
    for (const link of links) {
      const targetPort = def.inputs[link.port]
      if (!targetPort) {
        problems.push({ code: 'FG_UNKNOWN_INPUT_PORT', node_id: node.id, message: `节点 ${node.id} 不存在名为 '${link.port}' 的输入端口` })
        continue
      }
      const fromDef = getDefinition(index.nodes.get(link.from).type)
      const sourcePort = fromDef && fromDef.outputs[link.fromPort]
      if (!sourcePort) {
        problems.push({ code: 'FG_UNKNOWN_OUTPUT_PORT', node_id: link.from, message: `节点 ${link.from} 不存在名为 '${link.fromPort}' 的输出端口` })
        continue
      }
      if (!accepts(targetPort.type, sourcePort.type)) {
        problems.push({
          code: 'FG_TYPE_MISMATCH',
          node_id: node.id,
          message: `类型不匹配：${link.from}.${link.fromPort} 输出 ${sourcePort.type}，而 ${node.id}.${link.port} 需要 ${targetPort.type}`,
        })
      }
    }
    for (const [portName, portDef] of Object.entries(def.inputs)) {
      if (!portDef.required) continue
      const supplied = links.some(l => l.port === portName)
      const fromParam = node.params && node.params[portName] !== undefined && node.params[portName] !== null
      if (!supplied && !fromParam) {
        problems.push({ code: 'FG_INPUT_MISSING', node_id: node.id, message: `节点 ${node.id} 的输入端口 '${portName}' 未连接` })
      }
    }
    if (def.control === 'loop_end') {
      const loopId = node.params && node.params.loop
      if (!loopId || !index.nodes.has(loopId)) {
        problems.push({ code: 'FG_LOOP_END_UNPAIRED', node_id: node.id, message: `循环结束节点 ${node.id} 没有指明它配的是哪个循环开始` })
      }
    }
  }

  // 不是声明过的循环就出现了环，这是接线错误而不是功能。循环的配对记在 params 里，
  // 不是一条边，所以真正的循环不会在这里出现；出现的就是有人把节点接回了自己。
  const colour = new Map()
  const visit = id => {
    colour.set(id, 'grey')
    for (const edge of index.outgoing.get(id) || []) {
      const c = colour.get(edge.to)
      if (c === 'grey') {
        problems.push({ code: 'FG_CYCLE', node_id: id, message: `图里有环：${id} → ${edge.to}。想重复跑请用循环开始/循环结束` })
        continue
      }
      if (!c) visit(edge.to)
    }
    colour.set(id, 'black')
  }
  for (const id of index.nodes.keys()) if (!colour.get(id)) visit(id)

  return { ok: problems.length === 0, problems, index }
}

// 内存：没有释放节点点名，就什么都不释放

class FlowMemory {
  constructor() {
    this.slots = new Map() // 键是 nodeId:port#iteration，值含 {node_id, port, iteration, value, released}
  }

  key(nodeId, port, iteration) {
    return `${nodeId}:${port}#${iteration}`
  }

  put(nodeId, port, iteration, value) {
    this.slots.set(this.key(nodeId, port, iteration), {
      node_id: nodeId, port, iteration, value, released: false,
    })
  }

  get(nodeId, port, iteration) {
    const slot = this.slots.get(this.key(nodeId, port, iteration))
    if (!slot) return undefined
    if (slot.released) {
      throw engineError('FG_VALUE_RELEASED', `${nodeId}.${port} 已经被「释放」节点放掉了，后面又有人要用它`, { node_id: nodeId, port })
    }
    return slot.value
  }

  releaseFrom(nodeIds) {
    let freed = 0
    for (const slot of this.slots.values()) {
      if (slot.released) continue
      if (!nodeIds.has(slot.node_id)) continue
      slot.value = null
      slot.released = true
      freed += 1
    }
    return freed
  }

  liveCount() {
    let n = 0
    for (const slot of this.slots.values()) if (!slot.released) n += 1
    return n
  }

  snapshot() {
    return [...this.slots.values()].map(s => ({
      node_id: s.node_id, port: s.port, iteration: s.iteration, released: s.released,
    }))
  }
}

// 引擎

class FlowEngine {
  constructor(options = {}) {
    this.fs = options.fs || nodeFs
    this.outputDir = options.outputDir || null
    this.stateDir = options.stateDir || null
    this.synthesize = options.synthesize || null
    this.concatAudio = options.concatAudio || null
    this.saveVoice = options.saveVoice || null
    this.releaseVram = options.releaseVram || null
    this.sleep = options.sleep || (ms => new Promise(r => setTimeout(r, ms)))
    this.clock = options.clock || (() => new Date().toISOString())
    this.idFactory = options.idFactory || (() => `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    this.runs = new Map()
  }

  async start(graph, { run_id = null, params = {} } = {}) {
    const check = validateGraph(graph)
    if (!check.ok) {
      throw engineError('FG_GRAPH_INVALID', `校验未通过，共 ${check.problems.length} 处问题，未开始运行`, { problems: check.problems })
    }
    const runId = run_id || this.idFactory()
    const run = {
      run_id: runId,
      graph,
      index: check.index,
      params,
      status: RUN_STATES.RUNNING,
      started_at: this.clock(),
      nodes: new Map(),
      memory: new FlowMemory(),
      loops: new Map(),
      appendOwner: new Map(),
      pending: null,
      answers: new Map(),
      error: null,
      events: [],
    }
    for (const id of check.index.nodes.keys()) {
      run.nodes.set(id, { status: 'pending', outputs: {}, iteration: 0, runs: 0 })
    }
    this._planLoops(run)
    this.runs.set(runId, run)
    return this._drive(run)
  }

  async resume(runId, value) {
    const run = this.runs.get(runId)
    if (!run) throw engineError('FG_RUN_UNKNOWN', `没有编号为 ${runId} 的运行`, { run_id: runId })
    if (run.status !== RUN_STATES.AWAITING_INPUT || !run.pending) {
      throw engineError('FG_RUN_NOT_WAITING', `该运行当前不等待输入，状态为 ${run.status}`, { run_id: runId, status: run.status })
    }
    const { node_id, iteration } = run.pending
    run.answers.set(`${node_id}#${iteration}`, value)
    run.nodes.get(node_id).status = 'pending'
    run.pending = null
    run.status = RUN_STATES.RUNNING
    return this._drive(run)
  }

  get(runId) {
    return this.runs.get(runId) || null
  }

  report(runId) {
    const run = this.runs.get(runId)
    if (!run) return null
    return {
      run_id: run.run_id,
      status: run.status,
      pending: run.pending,
      error: run.error,
      live_values: run.memory.liveCount(),
      nodes: [...run.nodes.entries()].map(([id, s]) => ({ node_id: id, status: s.status, runs: s.runs })),
      events: run.events,
    }
  }

  _planLoops(run) {
    for (const node of run.index.nodes.values()) {
      const def = getDefinition(node.type)
      if (!def || def.control !== 'loop_end') continue
      const startId = node.params.loop
      const body = new Set(
        [...descendants(run.index, startId)].filter(id => ancestors(run.index, node.id).has(id) || id === node.id),
      )
      body.delete(node.id)
      run.loops.set(startId, {
        start_id: startId,
        end_id: node.id,
        body,
        index: 0,
        items: null,
        buckets: new Map(),
      })
    }
    // 累加节点归属于包含它的最内层循环。
    for (const node of run.index.nodes.values()) {
      const def = getDefinition(node.type)
      if (!def || def.control !== 'append') continue
      let owner = null
      for (const loop of run.loops.values()) {
        if (!loop.body.has(node.id)) continue
        if (!owner || loop.body.size < owner.body.size) owner = loop
      }
      if (!owner) {
        throw engineError('FG_APPEND_OUTSIDE_LOOP', `累加节点 ${node.id} 不在任何循环里面，那它没有东西可累加`, { node_id: node.id })
      }
      run.appendOwner.set(node.id, owner.start_id)
      owner.buckets.set(node.id, [])
    }
    // 累加出来的清单在整个循环结束后才存在，所以读它的节点必须放在循环外面。
    // 在这里拦住，调用方拿到的是一句能照着改的话，而不是一次悄悄不再推进的运行。
    for (const [appendId, ownerStart] of run.appendOwner.entries()) {
      const owner = run.loops.get(ownerStart)
      for (const edge of run.index.outgoing.get(appendId) || []) {
        if (owner.body.has(edge.to)) {
          throw engineError('FG_APPEND_CONSUMED_INSIDE_LOOP',
            `累加节点 ${appendId} 的结果被循环里面的 ${edge.to} 消耗了。累加的清单要等整个循环执行完才有，请把 ${edge.to} 挪到循环结束的后面`,
            { node_id: appendId, consumer: edge.to })
        }
      }
    }
  }

  _readInput(run, link, nodeId) {
    const upstream = run.nodes.get(link.from)
    return run.memory.get(link.from, link.fromPort, upstream.iteration)
  }

  _readiness(run, nodeId) {
    const state = run.nodes.get(nodeId)
    if (state.status !== 'pending') return 'not_pending'
    const links = run.index.incoming.get(nodeId) || []
    const def = getDefinition(run.index.nodes.get(nodeId).type)

    if (def.control === 'loop_end') {
      const loop = run.loops.get(run.index.nodes.get(nodeId).params.loop)
      for (const id of loop.body) {
        const s = run.nodes.get(id).status
        if (s !== 'done' && s !== 'skipped' && s !== 'accumulating') return 'waiting'
      }
      return 'ready'
    }

    let anySkipped = false
    for (const link of links) {
      const upstream = run.nodes.get(link.from)
      if (upstream.status === 'skipped') { anySkipped = true; continue }
      if (upstream.status !== 'done') return 'waiting'
    }
    // 必填输入来自被跳过的节点时，这个节点同样不能执行。这就是「条件为 0 的那条边，
    // 下游不执行」。enable 虽然是可选端口，这里仍按必填处理：本该决定的那个节点没跑，
    // 就等于没有人决定过。
    if (anySkipped) {
      for (const link of links) {
        const upstream = run.nodes.get(link.from)
        if (upstream.status !== 'skipped') continue
        const portDef = def.inputs[link.port]
        if (link.port === 'enable' || (portDef && portDef.required)) return 'skip'
      }
    }
    return 'ready'
  }

  async _drive(run) {
    while (true) {
      if (run.status !== RUN_STATES.RUNNING) return this.report(run.run_id)

      let progressed = false
      for (const nodeId of run.index.nodes.keys()) {
        const readiness = this._readiness(run, nodeId)
        if (readiness === 'not_pending' || readiness === 'waiting') continue
        if (readiness === 'skip') {
          run.nodes.get(nodeId).status = 'skipped'
          run.events.push({ at: this.clock(), type: 'node_skipped', node_id: nodeId, reason: '上游那条路是 0' })
          progressed = true
          continue
        }
        const outcome = await this._runNode(run, nodeId)
        if (outcome === 'suspended') return this.report(run.run_id)
        progressed = true
        break
      }

      if (progressed) continue

      const unfinished = [...run.nodes.entries()].filter(([, s]) => s.status !== 'done' && s.status !== 'skipped')
      if (!unfinished.length) {
        run.status = RUN_STATES.SUCCEEDED
        run.finished_at = this.clock()
        run.events.push({ at: run.finished_at, type: 'run_succeeded', live_values: run.memory.liveCount() })
        return this.report(run.run_id)
      }
      return this._fail(run, null, engineError('FG_DEADLOCK', '没有节点还能继续执行，但图尚未完成', {
        stuck: unfinished.map(([id, s]) => ({ node_id: id, status: s.status })),
      }))
    }
  }

  async _runNode(run, nodeId) {
    const node = run.index.nodes.get(nodeId)
    const def = getDefinition(node.type)
    const state = run.nodes.get(nodeId)
    const links = run.index.incoming.get(nodeId) || []
    const params = Object.assign({}, def.params, node.params || {})

    let inputs
    try {
      inputs = this._collectInputs(run, node, def, links)
    } catch (error) {
      return this._fail(run, nodeId, error)
    }

    // enable 上明确给了 0，这个节点整条都不执行。
    if (inputs.enable !== undefined && !inputs.enable) {
      state.status = 'skipped'
      run.events.push({ at: this.clock(), type: 'node_skipped', node_id: nodeId, reason: 'enable 是 0' })
      return 'skipped'
    }

    if (def.control === 'loop_start') return this._runLoopStart(run, node, def, inputs, params)
    if (def.control === 'loop_end') return this._runLoopEnd(run, node)
    if (def.control === 'append') return this._runAppend(run, node, inputs)

    const iteration = this._iterationFor(run, nodeId)
    const answerKey = `${nodeId}#${iteration}`
    const resumed = run.answers.has(answerKey) ? run.answers.get(answerKey) : undefined

    let result
    try {
      result = await def.handler({
        node,
        params,
        inputs,
        incoming: links,
        resumed,
        iteration,
        loop: this._loopValueFor(run, nodeId),
        ctx: this._ctx(run),
        run_id: run.run_id,
      })
    } catch (error) {
      return this._fail(run, nodeId, error, iteration)
    }

    if (result && result.suspend) {
      // 挂起等外部给值。等待期间不释放任何值：等待的前提就是答案到达时那份工作还在。
      state.status = 'suspended'
      run.status = RUN_STATES.AWAITING_INPUT
      run.pending = { node_id: nodeId, iteration, request: result.suspend }
      run.events.push({ at: this.clock(), type: 'awaiting_input', node_id: nodeId, kind: result.suspend.kind })
      this._persist(run)
      return 'suspended'
    }

    state.iteration = iteration
    state.runs += 1
    state.outputs = {}
    for (const [portName, value] of Object.entries((result && result.outputs) || {})) {
      run.memory.put(nodeId, portName, iteration, value)
      state.outputs[portName] = true
    }
    state.status = 'done'
    run.events.push({ at: this.clock(), type: 'node_done', node_id: nodeId, iteration })
    return 'done'
  }

  _collectInputs(run, node, def, links) {
    const inputs = {}
    for (const link of links) {
      const portDef = def.inputs[link.port]
      const value = this._readInput(run, link, node.id)
      if (portDef && portDef.multiple) {
        if (!Array.isArray(inputs[link.port])) inputs[link.port] = []
        inputs[link.port].push(value)
      } else {
        inputs[link.port] = value
      }
    }
    return inputs
  }

  _iterationFor(run, nodeId) {
    for (const loop of run.loops.values()) {
      if (loop.body.has(nodeId)) return loop.index
    }
    return 0
  }

  _loopValueFor(run, nodeId) {
    const loop = run.loops.get(nodeId)
    if (!loop) return null
    const items = loop.items || []
    return { item: items[loop.index], index: loop.index, total: items.length }
  }

  async _runLoopStart(run, node, def, inputs, params) {
    const loop = run.loops.get(node.id)
    if (!loop) return this._fail(run, node.id, engineError('FG_LOOP_START_UNPAIRED', `循环开始 ${node.id} 没有配对的循环结束`))
    if (loop.items === null) {
      if (Array.isArray(inputs.list)) loop.items = inputs.list.slice()
      else if (Number.isInteger(params.times) && params.times > 0) loop.items = Array.from({ length: params.times }, (_, i) => i)
      else return this._fail(run, node.id, engineError('FG_LOOP_NO_ITEMS', `循环开始 ${node.id} 既没接列表，也没填次数`))
      run.events.push({ at: this.clock(), type: 'loop_started', node_id: node.id, total: loop.items.length })
    }
    const state = run.nodes.get(node.id)
    const result = await def.handler({ loop: this._loopValueFor(run, node.id), params, inputs, ctx: this._ctx(run), node })
    state.iteration = loop.index
    state.runs += 1
    state.outputs = {}
    for (const [portName, value] of Object.entries(result.outputs || {})) {
      run.memory.put(node.id, portName, loop.index, value)
      state.outputs[portName] = true
    }
    state.status = 'done'
    return 'done'
  }

  async _runAppend(run, node, inputs) {
    const ownerId = run.appendOwner.get(node.id)
    const loop = run.loops.get(ownerId)
    loop.buckets.get(node.id).push(inputs.value)
    const state = run.nodes.get(node.id)
    state.runs += 1
    // 这里不能置为 done：清单在整个循环结束后才存在。下游节点必须等待，
    // 否则第十轮会覆盖第九轮，只剩一个结果，那正是 append 节点要防的失败。
    state.status = 'accumulating'
    run.events.push({ at: this.clock(), type: 'appended', node_id: node.id, size: loop.buckets.get(node.id).length })
    return 'done'
  }

  async _runLoopEnd(run, node) {
    const loop = run.loops.get(node.params.loop)
    const more = loop.index + 1 < (loop.items || []).length
    if (more) {
      loop.index += 1
      for (const id of loop.body) {
        const s = run.nodes.get(id)
        s.status = 'pending'
        s.outputs = {}
      }
      run.nodes.get(loop.start_id).status = 'pending'
      run.events.push({ at: this.clock(), type: 'loop_next', node_id: loop.start_id, index: loop.index })
      return 'done'
    }
    for (const [appendId, bucket] of loop.buckets.entries()) {
      run.memory.put(appendId, 'list', 0, bucket.slice())
      const s = run.nodes.get(appendId)
      s.status = 'done'
      s.iteration = 0
      s.outputs = { list: true }
    }
    const state = run.nodes.get(node.id)
    run.memory.put(node.id, 'done', 0, 1)
    state.status = 'done'
    state.iteration = 0
    state.outputs = { done: true }
    state.runs += 1
    run.events.push({ at: this.clock(), type: 'loop_finished', node_id: loop.start_id, total: loop.items.length })
    return 'done'
  }

  // 交给节点处理器的上下文

  _ctx(run) {
    return {
      fs: this.fs,
      outputDir: this.outputDir,
      synthesize: this.synthesize,
      concatAudio: this.concatAudio,
      // 把音色写回 broker 的音色列表。画布单独运行时它不存在，
      // 节点会说明这一点，而不是以奇怪的方式失败。
      saveVoice: this.saveVoice,
      releaseVram: this.releaseVram,
      sleep: this.sleep,
      emit: (type, payload) => run.events.push(Object.assign({ at: this.clock(), type }, payload)),
      releaseUpstream: (nodeId, links) => {
        const producers = new Set((links || []).map(l => l.from))
        const freed = run.memory.releaseFrom(producers)
        return freed
      },
    }
  }

  _fail(run, nodeId, error, iteration = null) {
    run.status = RUN_STATES.FAILED
    run.error = {
      node_id: nodeId,
      iteration,
      code: error.code || 'FG_NODE_FAILED',
      message: error.message,
      details: error.problems || error.stuck || null,
      at: this.clock(),
    }
    // 失败时的约定：保留工作状态，不释放内存。此刻内存里的内容正是重建现场所需的，
    // 在这里释放就等于毁掉证据。
    run.events.push({ at: run.error.at, type: 'run_failed', node_id: nodeId, code: run.error.code, live_values: run.memory.liveCount() })
    this._persist(run)
    const wrapped = engineError(run.error.code, this._failureSentence(run), {
      run_id: run.run_id,
      node_id: nodeId,
      iteration,
      live_values: run.memory.liveCount(),
      cause: error,
    })
    throw wrapped
  }

  _failureSentence(run) {
    const e = run.error
    const where = e.node_id ? `节点 ${e.node_id}` : '调度'
    const pass = e.iteration !== null && e.iteration !== undefined ? `第 ${e.iteration + 1} 轮` : ''
    return `${pass}${where}执行失败，运行已终止：${e.message}（中间结果未释放，仍保留 ${run.memory.liveCount()} 个值，可用于排查）`
  }

  _persist(run) {
    if (!this.stateDir) return null
    try {
      this.fs.mkdirSync(this.stateDir, { recursive: true })
      const file = nodePath.join(this.stateDir, `${run.run_id}.json`)
      this.fs.writeFileSync(file, JSON.stringify({
        run_id: run.run_id,
        status: run.status,
        pending: run.pending,
        error: run.error,
        saved_at: this.clock(),
        nodes: [...run.nodes.entries()].map(([id, s]) => ({ node_id: id, status: s.status, iteration: s.iteration, runs: s.runs })),
        memory: run.memory.snapshot(),
        events: run.events,
      }, null, 2))
      return file
    } catch {
      // 持久化状态是一份副本：写不进去不能盖掉用户要看的那个原始错误。
      return null
    }
  }
}

module.exports = {
  FlowEngine,
  FlowMemory,
  FlowRunError,
  RUN_STATES,
  validateGraph,
  buildIndex,
}
