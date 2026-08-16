'use strict'

// ---------------------------------------------------------------------------
//  HTTP surface for the node canvas
// ---------------------------------------------------------------------------
// A translator and nothing more: HTTP in, service call, HTTP out. No scheduling,
// no synthesis, no quality logic lives here.
//
// Mounted only when the canvas is switched on, and additive throughout: every
// path is under /api/flowgraph/*, so the generate page keeps behaving exactly as
// it did before this file existed.

const express = require('express')
const { HttpError, asyncHandler } = require('../http/http')

// Which failures are the user's to fix (4xx) and which are ours (5xx). Being
// explicit beats "everything is a 500", because a 500 tells the canvas nothing
// it can show a person.
const STATUS_BY_CODE = Object.freeze({
  FG_GRAPH_INVALID: 400,
  FG_STORE_BAD_GRAPH: 400,
  FG_STORE_BAD_NODE: 400,
  FG_STORE_NODE_NO_ID: 400,
  FG_STORE_NODE_NO_TYPE: 400,
  FG_STORE_DUPLICATE_ID: 400,
  FG_STORE_BAD_ID: 400,
  FG_STORE_VERSION_TOO_NEW: 400,
  FG_APPEND_OUTSIDE_LOOP: 400,
  FG_APPEND_CONSUMED_INSIDE_LOOP: 400,
  FG_ENGINE_PARAM_UNKNOWN: 400,
  FG_ENGINE_UNSUPPORTED: 400,
  FG_ENGINE_NO_VOICE: 400,
  FG_WEIGHTED_LENGTH_MISMATCH: 400,
  FG_FILTER_LENGTH_MISMATCH: 400,
  FG_TOPK_LENGTH_MISMATCH: 400,
  FG_NORMALIZE_SAME_ENDS: 400,
  FG_METRIC_UNKNOWN: 400,
  FG_RECIPE_MISSING: 400,
  FG_STORE_NOT_FOUND: 404,
  FG_RUN_UNKNOWN: 404,
  FG_RUN_NOT_WAITING: 409,
  FG_REF_AUDIO_NOT_FOUND: 422,
  FG_MEASURE_FILE_MISSING: 422,
  FG_SYNTHESIZE_FILE_MISSING: 422,
  FG_CONCAT_FILE_MISSING: 422,
  FG_SYNTHESIZE_UNAVAILABLE: 503,
  FG_CONCAT_UNAVAILABLE: 503,
})

function statusFor(error) {
  if (!error || !error.code) return 500
  if (STATUS_BY_CODE[error.code]) return STATUS_BY_CODE[error.code]
  // A run that stopped because a file moved under it is the user's environment,
  // not a server fault — that whole family is 422 by default.
  if (/_FILE_MISSING$|_NOT_FOUND$/.test(error.code)) return 422
  return 500
}

// The engine's error objects carry the detail that makes a message actionable
// (which node, which round, which file). Passing it through is the entire point
// of the "第 3 轮读不到那个文件" style of message.
function bodyFor(error) {
  const out = {
    code: error && error.code ? error.code : 'FG_INTERNAL',
    message: (error && error.message) || String(error),
  }
  for (const key of ['node_id', 'path', 'problems', 'unknown', 'name', 'graph_id', 'run_id', 'consumer', 'status', 'index']) {
    if (error && error[key] !== undefined) out[key] = error[key]
  }
  return out
}

function rethrow(error) {
  throw new HttpError(statusFor(error), bodyFor(error))
}

const guard = fn => async (...args) => {
  try {
    return await fn(...args)
  } catch (error) {
    if (error instanceof HttpError) throw error
    return rethrow(error)
  }
}

module.exports = function createRouter(ctx) {
  const router = express.Router()
  const service = () => {
    if (!ctx.flowgraphService) {
      throw new HttpError(503, {
        code: 'FG_DISABLED',
        message: '这台服务器上没有开画布（设 FLOWGRAPH_ENABLED=1 再启动）',
      })
    }
    return ctx.flowgraphService
  }

  // -- what can be dragged onto the canvas -----------------------------------

  router.get('/api/flowgraph/nodes', asyncHandler(guard(async () => service().nodeCatalogue())))

  router.get('/api/flowgraph/status', asyncHandler(guard(async () => {
    const s = service()
    return {
      ok: true,
      node_count: s.nodeCatalogue().count,
      // Whether the canvas can actually make a sound, rather than only pretend
      // to — worth its own field so nobody debugs a silent graph for an hour.
      can_synthesize: typeof s.engine.synthesize === 'function',
      can_concat: typeof s.engine.concatAudio === 'function',
      output_dir: s.outputDir,
    }
  })))

  // -- the graph library ------------------------------------------------------

  router.get('/api/flowgraph/graphs', asyncHandler(guard(async () => ({ graphs: service().listGraphs() }))))

  router.get('/api/flowgraph/graphs/:id', asyncHandler(guard(async req => ({ graph: service().loadGraph(req.params.id) }))))

  router.post('/api/flowgraph/graphs', asyncHandler(guard(async req => {
    const graph = req.body && req.body.graph ? req.body.graph : req.body
    return { graph: service().saveGraph(graph) }
  })))

  router.delete('/api/flowgraph/graphs/:id', asyncHandler(guard(async req => ({
    deleted: service().deleteGraph(req.params.id),
  }))))

  // Check without running. The canvas calls this while you wire, so "这张图接不
  // 上" shows up before you press go, not three minutes into a batch.
  router.post('/api/flowgraph/check', asyncHandler(guard(async req => {
    const graph = req.body && req.body.graph ? req.body.graph : req.body
    return service().check(graph)
  })))

  // -- running ----------------------------------------------------------------

  router.get('/api/flowgraph/runs', asyncHandler(guard(async () => ({ runs: service().listRuns() }))))

  router.post('/api/flowgraph/runs', asyncHandler(guard(async req => {
    const body = req.body || {}
    const target = body.graph_id ? String(body.graph_id) : body.graph
    if (!target) {
      throw new HttpError(400, { code: 'FG_NO_GRAPH', message: '开跑要有一张图：给编号或者把图整个送过来' })
    }
    return service().start(target, { params: body.params || {} })
  })))

  router.get('/api/flowgraph/runs/:id', asyncHandler(guard(async req => service().report(req.params.id))))

  // Sending the answer back to a waiting node — a person clicking 继续 on a
  // pause, or picking clips on a select.
  router.post('/api/flowgraph/runs/:id/resume', asyncHandler(guard(async req => {
    const body = req.body || {}
    if (!('value' in body)) {
      throw new HttpError(400, { code: 'FG_NO_VALUE', message: '要送回去的答案是空的（继续/取消，或者选中的编号）' })
    }
    return service().resume(req.params.id, body.value)
  })))

  return router
}

module.exports.statusFor = statusFor
module.exports.bodyFor = bodyFor
