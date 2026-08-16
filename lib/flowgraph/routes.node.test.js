'use strict'

// The canvas talks to the server over these paths, so they are worth testing
// even though `express` itself is not installed in every environment. A tiny
// stand-in router is injected before the route module is loaded: it records the
// paths that get registered and lets each handler be called directly, which is
// exactly the part that is ours to get right.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

function fakeExpress() {
  const routes = []
  const router = {}
  for (const method of ['get', 'post', 'delete', 'put']) {
    router[method] = (routePath, handler) => { routes.push({ method, path: routePath, handler }) }
  }
  router.__routes = routes
  return { Router: () => router }
}

// Load the route module with `express` stubbed out, without touching the real
// resolution for anything else.
function loadRouteModule() {
  const original = Module.prototype.require
  Module.prototype.require = function patched(request) {
    if (request === 'express') return fakeExpress()
    return original.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve('../routes/flowgraph')]
    return require('../routes/flowgraph')
  } finally {
    Module.prototype.require = original
  }
}

const { FlowgraphService } = require('./service')

function callable(router) {
  const map = new Map(router.__routes.map(r => [`${r.method.toUpperCase()} ${r.path}`, r.handler]))
  return async (key, req = {}) => {
    const handler = map.get(key)
    if (!handler) throw new Error(`没有登记这条路径：${key}（有的是 ${[...map.keys()].join('、')}）`)
    let sent = null
    const res = {
      headersSent: false,
      status(code) { this._status = code; return this },
      set() { return this },
      json(body) { sent = { status: this._status || 200, body }; this.headersSent = true; return this },
      send(body) { sent = { status: this._status || 200, body }; this.headersSent = true; return this },
    }
    await new Promise(resolve => { handler(Object.assign({ params: {}, body: {} }, req), res, resolve); setTimeout(resolve, 50) })
    return sent
  }
}

function setup(extra = {}) {
  const createRouter = loadRouteModule()
  const service = new FlowgraphService(Object.assign({
    rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'flowroute-')),
  }, extra))
  const router = createRouter({ flowgraphService: service })
  return { call: callable(router), service, router, createRouter }
}

const node = (id, type, e = {}) => Object.assign({ id, type, inputs: {}, params: {} }, e)
const graph = nodes => ({ schema_version: 1, name: '路由测试', nodes, groups: [], blocks: [] })

test('every path the canvas needs is actually registered', () => {
  const { router } = setup()
  const registered = router.__routes.map(r => `${r.method.toUpperCase()} ${r.path}`)
  for (const expected of [
    'GET /api/flowgraph/nodes',
    'GET /api/flowgraph/status',
    'GET /api/flowgraph/graphs',
    'GET /api/flowgraph/graphs/:id',
    'POST /api/flowgraph/graphs',
    'DELETE /api/flowgraph/graphs/:id',
    'POST /api/flowgraph/check',
    'GET /api/flowgraph/runs',
    'POST /api/flowgraph/runs',
    'GET /api/flowgraph/runs/:id',
    'POST /api/flowgraph/runs/:id/resume',
  ]) {
    assert.ok(registered.includes(expected), `少了 ${expected}`)
  }
})

test('with the canvas switched off every path says so plainly, not 500', async () => {
  const createRouter = loadRouteModule()
  const router = createRouter({})
  const call = callable(router)
  const reply = await call('GET /api/flowgraph/nodes')
  assert.equal(reply.status, 503)
  assert.equal(reply.body.error.code, 'FG_DISABLED')
  assert.match(reply.body.error.message, /FLOWGRAPH_ENABLED/)
})

test('the status path admits when it cannot actually make a sound', async () => {
  const quiet = await setup().call('GET /api/flowgraph/status')
  assert.equal(quiet.body.can_synthesize, false, '没接合成就该直说，不能让人查半天')

  const wired = await setup({ synthesize: async () => ({ kind: 'audio', path: '/x.wav' }) })
    .call('GET /api/flowgraph/status')
  assert.equal(wired.body.can_synthesize, true)
  assert.ok(wired.body.node_count >= 30)
})

test('saving then loading a graph round-trips over HTTP', async () => {
  const { call } = setup()
  const saved = await call('POST /api/flowgraph/graphs', {
    body: { graph: graph([node('t', 'io.text', { params: { text: '你好' } })]) },
  })
  assert.equal(saved.status, 200)
  const id = saved.body.graph.graph_id

  const listed = await call('GET /api/flowgraph/graphs')
  assert.equal(listed.body.graphs.length, 1)

  const loaded = await call('GET /api/flowgraph/graphs/:id', { params: { id } })
  assert.equal(loaded.body.graph.nodes[0].params.text, '你好')

  const gone = await call('DELETE /api/flowgraph/graphs/:id', { params: { id } })
  assert.equal(gone.body.deleted, true)
})

test('asking for a graph that is not there is a 404 with the number in it', async () => {
  const reply = await setup().call('GET /api/flowgraph/graphs/:id', { params: { id: 'graph_nope' } })
  assert.equal(reply.status, 404)
  assert.equal(reply.body.error.code, 'FG_STORE_NOT_FOUND')
  assert.match(reply.body.error.message, /graph_nope/)
})

test('checking a graph answers 200 with the problem list, not an error status', async () => {
  const reply = await setup().call('POST /api/flowgraph/check', {
    body: { graph: graph([node('p', 'out.preview', { inputs: { value: { node: '没这个', port: 'text' } } })]) },
  })
  // Checking SUCCEEDED — it successfully found that the graph is broken.
  assert.equal(reply.status, 200)
  assert.equal(reply.body.ok, false)
  assert.ok(reply.body.problems.length >= 1)
})

test('a run started, paused, and answered, all over HTTP', async () => {
  const { call } = setup()
  const started = await call('POST /api/flowgraph/runs', {
    body: {
      graph: graph([
        node('t', 'io.text', { params: { text: '你好' } }),
        node('gate', 'logic.pause', { params: { prompt: '继续吗？' } }),
        node('p', 'out.preview', {
          inputs: { value: { node: 't', port: 'text' }, enable: { node: 'gate', port: 'value' } },
        }),
      ]),
    },
  })
  assert.equal(started.status, 200)
  assert.equal(started.body.status, 'awaiting_input')
  const runId = started.body.run_id

  const listed = await call('GET /api/flowgraph/runs')
  assert.equal(listed.body.runs[0].waiting_for, 'gate')

  const answered = await call('POST /api/flowgraph/runs/:id/resume', {
    params: { id: runId }, body: { value: true },
  })
  assert.equal(answered.body.status, 'succeeded')

  const looked = await call('GET /api/flowgraph/runs/:id', { params: { id: runId } })
  assert.equal(looked.body.status, 'succeeded')
})

test('starting with no graph at all is refused with a sentence, not a crash', async () => {
  const reply = await setup().call('POST /api/flowgraph/runs', { body: {} })
  assert.equal(reply.status, 400)
  assert.equal(reply.body.error.code, 'FG_NO_GRAPH')
})

test('answering with nothing is refused rather than treated as "cancel"', async () => {
  const reply = await setup().call('POST /api/flowgraph/runs/:id/resume', {
    params: { id: 'run_x' }, body: {},
  })
  assert.equal(reply.status, 400)
  assert.equal(reply.body.error.code, 'FG_NO_VALUE')
})

test('a broken graph comes back as 400 with the node names, not a bare 500', async () => {
  const reply = await setup().call('POST /api/flowgraph/runs', {
    body: { graph: graph([node('bag', 'flow.append', { inputs: { value: { node: 'bag', port: 'list' } } })]) },
  })
  assert.equal(reply.status, 400)
  assert.ok(reply.body.error.code.startsWith('FG_'))
  assert.ok(reply.body.error.message.length > 0)
})

test('a file that moved under a running graph is the user environment, so 422', async () => {
  const reply = await setup().call('POST /api/flowgraph/runs', {
    body: { graph: graph([node('ref', 'io.reference_audio', { params: { path: '/gone/away.wav' } })]) },
  })
  assert.equal(reply.status, 422, '文件被挪走是环境问题，不该报成服务器故障')
  assert.match(reply.body.error.message, /运行前该文件仍可访问/)
  assert.equal(reply.body.error.node_id, 'ref')
})

test('the status mapping itself is deliberate, not "everything is 500"', () => {
  const { statusFor } = loadRouteModule()
  assert.equal(statusFor({ code: 'FG_GRAPH_INVALID' }), 400)
  assert.equal(statusFor({ code: 'FG_STORE_NOT_FOUND' }), 404)
  assert.equal(statusFor({ code: 'FG_RUN_NOT_WAITING' }), 409)
  assert.equal(statusFor({ code: 'FG_MEASURE_FILE_MISSING' }), 422)
  assert.equal(statusFor({ code: 'FG_SOMETHING_FILE_MISSING' }), 422, '同一族的新错误码要自动落到 422')
  assert.equal(statusFor({ code: 'FG_SYNTHESIZE_UNAVAILABLE' }), 503)
  assert.equal(statusFor(new Error('boom')), 500)
})
