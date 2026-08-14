'use strict'

// ---------------------------------------------------------------------------
//  Flow graph engine — backend v1
// ---------------------------------------------------------------------------
// Four capabilities, and nothing else new:
//
//   1. A node can hang there waiting for a value from outside (pause, select).
//   2. An edge whose condition is 0 does not run its downstream.
//   3. Small loops: a stretch of graph repeats, one list item per pass.
//   4. Lifetime is explicit: nothing is freed on its own. A value lives until a
//      `sys.release` node consumes it. "不接不等于结束，只是没人管，东西还占着内存."
//
// What is deliberately absent, compared with lib/workflow/: there is no ledger,
// no review record, no approve/reject/revise vocabulary and no notion of a
// "person". A pause is a boolean source. Who supplies the boolean is not the
// engine's business.
//
// Failure policy (user ruling, 2026-08-14): stop at once, never release memory,
// keep the working state, throw loudly. Errors here are assumed to be the run
// environment changing underfoot (a file moved, a lock taken), so the message
// must name the file and the pass number, not say "the loop failed".

const nodeFs = require('node:fs')
const nodePath = require('node:path')

require('./nodes')
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

// ---------------------------------------------------------------------------
//  Graph shape helpers
// ---------------------------------------------------------------------------

function normaliseIncoming(node) {
  // node.inputs: { portName: {node, port} | [{node, port}] }
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

// ---------------------------------------------------------------------------
//  Validation — refuse a graph that cannot run, before anything runs
// ---------------------------------------------------------------------------

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
        problems.push({ code: 'FG_UNKNOWN_INPUT_PORT', node_id: node.id, message: `节点 ${node.id} 没有叫 '${link.port}' 的入口` })
        continue
      }
      const fromDef = getDefinition(index.nodes.get(link.from).type)
      const sourcePort = fromDef && fromDef.outputs[link.fromPort]
      if (!sourcePort) {
        problems.push({ code: 'FG_UNKNOWN_OUTPUT_PORT', node_id: link.from, message: `节点 ${link.from} 没有叫 '${link.fromPort}' 的出口` })
        continue
      }
      if (!accepts(targetPort.type, sourcePort.type)) {
        problems.push({
          code: 'FG_TYPE_MISMATCH',
          node_id: node.id,
          message: `接不上：${link.from}.${link.fromPort} 是 ${sourcePort.type}，${node.id}.${link.port} 要的是 ${targetPort.type}`,
        })
      }
    }
    for (const [portName, portDef] of Object.entries(def.inputs)) {
      if (!portDef.required) continue
      const supplied = links.some(l => l.port === portName)
      const fromParam = node.params && node.params[portName] !== undefined && node.params[portName] !== null
      if (!supplied && !fromParam) {
        problems.push({ code: 'FG_INPUT_MISSING', node_id: node.id, message: `节点 ${node.id} 的入口 '${portName}' 没接东西` })
      }
    }
    if (def.control === 'loop_end') {
      const loopId = node.params && node.params.loop
      if (!loopId || !index.nodes.has(loopId)) {
        problems.push({ code: 'FG_LOOP_END_UNPAIRED', node_id: node.id, message: `循环结束节点 ${node.id} 没有指明它配的是哪个循环开始` })
      }
    }
  }

  // A cycle that is not a declared loop is a mistake, not a feature. The
  // loop pairing is carried in params, not as an edge, so a real loop does not
  // show up here — anything that does is somebody wiring a box back to itself.
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

// ---------------------------------------------------------------------------
//  Memory — nothing is freed unless a release node says so
// ---------------------------------------------------------------------------

class FlowMemory {
  constructor() {
    this.slots = new Map() // key -> {node_id, port, iteration, value, released}
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

// ---------------------------------------------------------------------------
//  Engine
// ---------------------------------------------------------------------------

class FlowEngine {
  constructor(options = {}) {
    this.fs = options.fs || nodeFs
    this.outputDir = options.outputDir || null
    this.stateDir = options.stateDir || null
    this.synthesize = options.synthesize || null
    this.concatAudio = options.concatAudio || null
    this.releaseVram = options.releaseVram || null
    this.sleep = options.sleep || (ms => new Promise(r => setTimeout(r, ms)))
    this.clock = options.clock || (() => new Date().toISOString())
    this.idFactory = options.idFactory || (() => `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    this.runs = new Map()
  }

  // -- public -------------------------------------------------------------

  async start(graph, { run_id = null, params = {} } = {}) {
    const check = validateGraph(graph)
    if (!check.ok) {
      throw engineError('FG_GRAPH_INVALID', `这张图有 ${check.problems.length} 处接不上，没开跑`, { problems: check.problems })
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
      throw engineError('FG_RUN_NOT_WAITING', `这次运行现在不是在等你，它是 ${run.status}`, { run_id: runId, status: run.status })
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

  // -- loops ---------------------------------------------------------------

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
    // An append belongs to the innermost loop whose body contains it.
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
    // The accumulated list only exists after the loop is over, so anything that
    // reads it must sit outside the loop. Catching this here gives a sentence
    // the user can act on, instead of a run that quietly stops making progress.
    for (const [appendId, ownerStart] of run.appendOwner.entries()) {
      const owner = run.loops.get(ownerStart)
      for (const edge of run.index.outgoing.get(appendId) || []) {
        if (owner.body.has(edge.to)) {
          throw engineError('FG_APPEND_CONSUMED_INSIDE_LOOP',
            `累加节点 ${appendId} 的结果被循环里面的 ${edge.to} 接走了。累加的清单要等整个循环跑完才有，请把 ${edge.to} 挪到循环结束的后面`,
            { node_id: appendId, consumer: edge.to })
        }
      }
    }
  }

  // -- scheduling ----------------------------------------------------------

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
    // A required input coming from a skipped node means this node cannot run
    // either. That is capability 2: the 0 branch does not execute downstream.
    // `enable` counts as required for this purpose even though it is optional:
    // if the thing that was supposed to decide never ran, nobody decided.
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
      return this._fail(run, null, engineError('FG_DEADLOCK', '没有节点还能往下跑，但图还没跑完', {
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

    // Capability 2, the near side: an explicit 0 on `enable` means this node
    // does not run at all.
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
      // Capability 1: hang here until somebody sends a value in. Nothing is
      // freed while waiting — the whole point of waiting is that the work is
      // still there when the answer arrives.
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
    // NOT done: the list only exists once the loop is over. Downstream nodes
    // must wait, otherwise the tenth pass overwrites the ninth and only one
    // result survives — the exact failure `append` exists to prevent.
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

  // -- context handed to handlers -----------------------------------------

  _ctx(run) {
    return {
      fs: this.fs,
      outputDir: this.outputDir,
      synthesize: this.synthesize,
      concatAudio: this.concatAudio,
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

  // -- failure -------------------------------------------------------------

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
    // Ruling: on failure, keep the working state and DO NOT release memory.
    // What is in memory at this moment is exactly what rebuilding the scene
    // needs, so freeing it here would destroy the evidence.
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
    return `${pass}${where}出错，已停下：${e.message}（内存没有释放，${run.memory.liveCount()} 个值还留着，方便你查）`
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
      // Persisting the state is a courtesy; failing to persist must not mask
      // the original error the user needs to see.
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
