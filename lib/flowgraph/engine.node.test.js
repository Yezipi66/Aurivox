'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const { FlowEngine, validateGraph, RUN_STATES } = require('./engine')
const { GraphStore, normaliseGraph, emptyGraph } = require('./graphStore')
const { listTypes, getDefinition } = require('./registry')

// ---------------------------------------------------------------------------
//  helpers
// ---------------------------------------------------------------------------

function node(id, type, extra = {}) {
  return Object.assign({ id, type, inputs: {}, params: {} }, extra)
}

function graph(nodes) {
  return { schema_version: 1, name: 'test', nodes, groups: [], blocks: [] }
}

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `flowgraph-${label}-`))
}

function fakeSynthesis() {
  const calls = []
  return {
    calls,
    fn: async request => {
      calls.push(request)
      return { kind: 'audio', text: request.text, bytes: Buffer.from(`audio:${request.text}`), format: 'wav' }
    },
  }
}

function engineWith(options = {}) {
  return new FlowEngine(Object.assign({ synthesize: fakeSynthesis().fn }, options))
}

// ---------------------------------------------------------------------------
//  registry / types
// ---------------------------------------------------------------------------

test('every node type carries an optional enable input', () => {
  const types = listTypes()
  assert.ok(types.length >= 25, `expected the v1 node set, got ${types.length}`)
  for (const type of types) {
    const def = getDefinition(type)
    assert.ok(def.inputs.enable, `${type} is missing the enable port`)
    assert.equal(def.inputs.enable.required, false)
    assert.equal(def.inputs.enable.type, 'Boolean')
  }
})

// ---------------------------------------------------------------------------
//  validation
// ---------------------------------------------------------------------------

test('a graph with mismatched port types is refused before it runs', async () => {
  const g = graph([
    node('text', 'io.text', { params: { text: 'hi' } }),
    node('cat', 'audio.concat', { inputs: { audios: { node: 'text', port: 'text' } } }),
  ])
  const check = validateGraph(g)
  assert.equal(check.ok, false)
  assert.ok(check.problems.some(p => p.code === 'FG_TYPE_MISMATCH'))

  await assert.rejects(() => engineWith().start(g), err => err.code === 'FG_GRAPH_INVALID')
})

test('a missing required input is reported, not discovered halfway through', () => {
  const g = graph([node('cat', 'audio.concat')])
  const check = validateGraph(g)
  assert.equal(check.ok, false)
  assert.ok(check.problems.some(p => p.code === 'FG_INPUT_MISSING'))
})

test('a hand-drawn cycle is refused and points at the loop nodes instead', () => {
  const g = graph([
    node('a', 'logic.not', { inputs: { a: { node: 'b', port: 'value' } } }),
    node('b', 'logic.not', { inputs: { a: { node: 'a', port: 'value' } } }),
  ])
  const check = validateGraph(g)
  assert.ok(check.problems.some(p => p.code === 'FG_CYCLE'))
})

// ---------------------------------------------------------------------------
//  capability 2 — a 0 stops the downstream
// ---------------------------------------------------------------------------

test('enable = 0 skips the node and everything downstream of it', async () => {
  const dir = tmpdir('skip')
  const g = graph([
    node('off', 'io.boolean', { params: { value: false } }),
    node('text', 'io.text', { params: { text: '你好' }, inputs: { enable: { node: 'off', port: 'value' } } }),
    node('save', 'out.save', { inputs: { value: { node: 'text', port: 'text' } }, params: { dir } }),
  ])
  const report = await engineWith().start(g)
  assert.equal(report.status, RUN_STATES.SUCCEEDED)
  const byId = Object.fromEntries(report.nodes.map(n => [n.node_id, n.status]))
  assert.equal(byId.text, 'skipped')
  assert.equal(byId.save, 'skipped')
  assert.equal(fs.readdirSync(dir).length, 0)
})

test('enable = 1 lets the same graph through', async () => {
  const dir = tmpdir('allow')
  const g = graph([
    node('on', 'io.boolean', { params: { value: true } }),
    node('text', 'io.text', { params: { text: '你好' }, inputs: { enable: { node: 'on', port: 'value' } } }),
    node('save', 'out.save', { inputs: { value: { node: 'text', port: 'text' } }, params: { dir, basename: 'x' } }),
  ])
  const report = await engineWith().start(g)
  assert.equal(report.status, RUN_STATES.SUCCEEDED)
  assert.deepEqual(fs.readdirSync(dir), ['x.json'])
})

test('an unconnected branch is simply left alone — it is not an error', async () => {
  const g = graph([
    node('text', 'io.text', { params: { text: 'a' } }),
    node('spare', 'io.text', { params: { text: 'nobody reads me' } }),
    node('view', 'out.preview', { inputs: { value: { node: 'text', port: 'text' } } }),
  ])
  const report = await engineWith().start(g)
  assert.equal(report.status, RUN_STATES.SUCCEEDED)
  // "不接不等于结束，只是没人管，东西还占着内存" — the spare value is still live.
  assert.ok(report.live_values >= 2)
})

// ---------------------------------------------------------------------------
//  capability 3 — small loops, and append not being overwritten
// ---------------------------------------------------------------------------

test('a loop runs once per item and append keeps every pass', async () => {
  const g = graph([
    node('text', 'io.text', { params: { text: '第一句。第二句。第三句。' } }),
    node('split', 'text.split', { inputs: { text: { node: 'text', port: 'text' } } }),
    node('engine', 'io.engine'),
    node('start', 'flow.loop_start', { inputs: { list: { node: 'split', port: 'lines' } } }),
    node('tts', 'tts.synthesize', {
      inputs: { text: { node: 'start', port: 'item' }, engine: { node: 'engine', port: 'engine' } },
    }),
    node('bag', 'flow.append', { inputs: { value: { node: 'tts', port: 'audio' } } }),
    node('end', 'flow.loop_end', { inputs: { body: { node: 'bag', port: 'list' } }, params: { loop: 'start' } }),
    node('view', 'out.preview', { inputs: { value: { node: 'bag', port: 'list' } } }),
  ])
  const synth = fakeSynthesis()
  const engine = new FlowEngine({ synthesize: synth.fn })
  const report = await engine.start(g)

  assert.equal(report.status, RUN_STATES.SUCCEEDED)
  assert.equal(synth.calls.length, 3, '合成应该被叫了三次，一句一次')

  const preview = report.events.find(e => e.type === 'preview')
  assert.equal(preview.value.length, 3, '累加的清单应该有三条，不是最后一条盖掉前两条')
  assert.deepEqual(preview.value.map(a => a.text), ['第一句。', '第二句。', '第三句。'])
})

test('a loop driven by a plain count also works', async () => {
  const g = graph([
    node('n', 'io.number', { params: { value: 7 } }),
    node('start', 'flow.loop_start', { params: { times: 4 } }),
    node('bag', 'flow.append', { inputs: { value: { node: 'start', port: 'index' } } }),
    node('end', 'flow.loop_end', { inputs: { body: { node: 'bag', port: 'list' } }, params: { loop: 'start' } }),
    node('view', 'out.preview', { inputs: { value: { node: 'bag', port: 'list' } } }),
  ])
  const engine = engineWith()
  const report = await engine.start(g)
  const preview = report.events.find(e => e.type === 'preview')
  assert.deepEqual(preview.value, [0, 1, 2, 3])
})

test('reading an accumulated list from inside the same loop is refused with a fix', async () => {
  const g = graph([
    node('start', 'flow.loop_start', { params: { times: 2 } }),
    node('bag', 'flow.append', { inputs: { value: { node: 'start', port: 'index' } } }),
    node('inner', 'out.save', { inputs: { value: { node: 'bag', port: 'list' } }, params: { dir: tmpdir('inner') } }),
    node('end', 'flow.loop_end', { inputs: { body: { node: 'inner', port: 'saved' } }, params: { loop: 'start' } }),
  ])
  await assert.rejects(() => engineWith().start(g), err => err.code === 'FG_APPEND_CONSUMED_INSIDE_LOOP')
})

// ---------------------------------------------------------------------------
//  capability 1 — hanging there waiting for a value
// ---------------------------------------------------------------------------

test('pause stops the run, and continue lets the rest through', async () => {
  const dir = tmpdir('pause-go')
  const g = graph([
    node('text', 'io.text', { params: { text: '要不要继续' } }),
    node('gate', 'logic.pause', { params: { prompt: '听完了吗？' } }),
    node('save', 'out.save', {
      inputs: { value: { node: 'text', port: 'text' }, enable: { node: 'gate', port: 'value' } },
      params: { dir, basename: 'kept' },
    }),
  ])
  const engine = engineWith()
  const first = await engine.start(g)
  assert.equal(first.status, RUN_STATES.AWAITING_INPUT)
  assert.equal(first.pending.node_id, 'gate')
  assert.equal(first.pending.request.prompt, '听完了吗？')
  assert.equal(fs.readdirSync(dir).length, 0, '还没点继续，不该有东西落盘')

  const second = await engine.resume(first.run_id, true)
  assert.equal(second.status, RUN_STATES.SUCCEEDED)
  assert.deepEqual(fs.readdirSync(dir), ['kept.json'])
})

test('pause with cancel stops the downstream — the 0 branch really does nothing', async () => {
  const dir = tmpdir('pause-stop')
  const g = graph([
    node('text', 'io.text', { params: { text: '要不要继续' } }),
    node('gate', 'logic.pause'),
    node('save', 'out.save', {
      inputs: { value: { node: 'text', port: 'text' }, enable: { node: 'gate', port: 'value' } },
      params: { dir },
    }),
  ])
  const engine = engineWith()
  const first = await engine.start(g)
  const second = await engine.resume(first.run_id, false)
  assert.equal(second.status, RUN_STATES.SUCCEEDED)
  assert.equal(Object.fromEntries(second.nodes.map(n => [n.node_id, n.status])).save, 'skipped')
  assert.equal(fs.readdirSync(dir).length, 0)
  // Cancelled, but the text is still sitting in memory: nothing frees itself.
  assert.ok(second.live_values >= 1)
})

test('a run that is not waiting cannot be resumed', async () => {
  const g = graph([node('text', 'io.text', { params: { text: 'a' } })])
  const engine = engineWith()
  const report = await engine.start(g)
  await assert.rejects(() => engine.resume(report.run_id, true), err => err.code === 'FG_RUN_NOT_WAITING')
})

// ---------------------------------------------------------------------------
//  select — the fork, which is a different thing from the gate
// ---------------------------------------------------------------------------

test('select waits for a person and passes on only the chosen items', async () => {
  const g = graph([
    node('start', 'flow.loop_start', { params: { times: 4 } }),
    node('bag', 'flow.append', { inputs: { value: { node: 'start', port: 'index' } } }),
    node('end', 'flow.loop_end', { inputs: { body: { node: 'bag', port: 'list' } }, params: { loop: 'start' } }),
    node('pickER', 'logic.select', { inputs: { candidates: { node: 'bag', port: 'list' } } }),
    node('view', 'out.preview', { inputs: { value: { node: 'pickER', port: 'selected' } } }),
  ])
  const engine = engineWith()
  const first = await engine.start(g)
  assert.equal(first.status, RUN_STATES.AWAITING_INPUT)
  assert.equal(first.pending.request.kind, 'select')
  assert.equal(first.pending.request.count, 4)

  const second = await engine.resume(first.run_id, [0, 2])
  assert.equal(second.status, RUN_STATES.SUCCEEDED)
  assert.deepEqual(second.events.find(e => e.type === 'preview').value, [0, 2])
})

test('select does not stop to ask when a machine already said which ones', async () => {
  const g = graph([
    node('start', 'flow.loop_start', { params: { times: 4 } }),
    node('bag', 'flow.append', { inputs: { value: { node: 'start', port: 'index' } } }),
    node('end', 'flow.loop_end', { inputs: { body: { node: 'bag', port: 'list' } }, params: { loop: 'start' } }),
    node('which', 'io.text', { params: { text: 'unused' } }),
    node('pickER', 'logic.select', {
      inputs: { candidates: { node: 'bag', port: 'list' }, indices: { node: 'picks', port: 'list' } },
    }),
    node('picks', 'flow.append', { inputs: { value: { node: 'start2', port: 'index' } } }),
    node('start2', 'flow.loop_start', { params: { times: 2 } }),
    node('end2', 'flow.loop_end', { inputs: { body: { node: 'picks', port: 'list' } }, params: { loop: 'start2' } }),
    node('view', 'out.preview', { inputs: { value: { node: 'pickER', port: 'selected' } } }),
  ])
  const engine = engineWith()
  const report = await engine.start(g)
  assert.equal(report.status, RUN_STATES.SUCCEEDED, '机器给了序号就不该停下来问人')
  assert.deepEqual(report.events.find(e => e.type === 'preview').value, [0, 1])
})

test('an out-of-range choice fails loudly instead of quietly dropping one', async () => {
  const g = graph([
    node('start', 'flow.loop_start', { params: { times: 2 } }),
    node('bag', 'flow.append', { inputs: { value: { node: 'start', port: 'index' } } }),
    node('end', 'flow.loop_end', { inputs: { body: { node: 'bag', port: 'list' } }, params: { loop: 'start' } }),
    node('pickER', 'logic.select', { inputs: { candidates: { node: 'bag', port: 'list' } } }),
  ])
  const engine = engineWith()
  const first = await engine.start(g)
  await assert.rejects(() => engine.resume(first.run_id, [5]), err => err.code === 'FG_SELECT_INDEX_OUT_OF_RANGE')
})

// ---------------------------------------------------------------------------
//  logic and comparison
// ---------------------------------------------------------------------------

test('compare against a plain number gives the boolean the threshold needs', async () => {
  const g = graph([
    node('score', 'io.number', { params: { value: 85 } }),
    node('gate', 'logic.compare', { inputs: { a: { node: 'score', port: 'value' } }, params: { op: '>=', b: 80 } }),
    node('view', 'out.preview', { inputs: { value: { node: 'gate', port: 'value' } } }),
  ])
  const report = await engineWith().start(g)
  assert.equal(report.events.find(e => e.type === 'preview').value, 1)
})

test('switch brings both branches back onto one line', async () => {
  const g = graph([
    node('flag', 'io.boolean', { params: { value: false } }),
    node('yes', 'io.text', { params: { text: '走了 true' } }),
    node('no', 'io.text', { params: { text: '走了 false' } }),
    node('sw', 'logic.switch', {
      inputs: {
        condition: { node: 'flag', port: 'value' },
        when_true: { node: 'yes', port: 'text' },
        when_false: { node: 'no', port: 'text' },
      },
    }),
    node('view', 'out.preview', { inputs: { value: { node: 'sw', port: 'value' } } }),
  ])
  const report = await engineWith().start(g)
  assert.equal(report.events.find(e => e.type === 'preview').value, '走了 false')
})

test('and / or / not / xor behave', async () => {
  const cases = [
    ['logic.and', 1, 1, 1], ['logic.and', 1, 0, 0],
    ['logic.or', 0, 1, 1], ['logic.or', 0, 0, 0],
    ['logic.xor', 1, 0, 1], ['logic.xnor', 1, 1, 1],
    ['logic.nand', 1, 1, 0], ['logic.nor', 0, 0, 1],
  ]
  for (const [type, a, b, expected] of cases) {
    const g = graph([
      node('a', 'io.boolean', { params: { value: !!a } }),
      node('b', 'io.boolean', { params: { value: !!b } }),
      node('op', type, { inputs: { a: { node: 'a', port: 'value' }, b: { node: 'b', port: 'value' } } }),
      node('view', 'out.preview', { inputs: { value: { node: 'op', port: 'value' } } }),
    ])
    const report = await engineWith().start(g)
    assert.equal(report.events.find(e => e.type === 'preview').value, expected, `${type}(${a},${b})`)
  }
})

// ---------------------------------------------------------------------------
//  capability 4 — lifetime is explicit
// ---------------------------------------------------------------------------

test('a value stays in memory until a release node takes it', async () => {
  const withoutRelease = graph([
    node('text', 'io.text', { params: { text: '占着内存' } }),
    node('view', 'out.preview', { inputs: { value: { node: 'text', port: 'text' } } }),
  ])
  const before = await engineWith().start(withoutRelease)
  assert.equal(before.live_values, 1)

  const withRelease = graph([
    node('text', 'io.text', { params: { text: '占着内存' } }),
    node('view', 'out.preview', { inputs: { value: { node: 'text', port: 'text' } } }),
    node('free', 'sys.release', { inputs: { value: { node: 'text', port: 'text' } } }),
  ])
  const after = await engineWith().start(withRelease)
  assert.equal(after.status, RUN_STATES.SUCCEEDED)
  assert.equal(after.live_values, 0, '释放节点接上之后，内存里应该真的少了东西')
  assert.ok(after.events.some(e => e.type === 'released' && e.freed === 1))
})

test('release can also be asked to drop the video memory', async () => {
  let vramCalls = 0
  const g = graph([
    node('engine', 'io.engine'),
    node('free', 'sys.release', { inputs: { value: { node: 'engine', port: 'engine' } }, params: { release_vram: true } }),
  ])
  const engine = new FlowEngine({ releaseVram: async () => { vramCalls += 1 } })
  await engine.start(g)
  assert.equal(vramCalls, 1)
})

// ---------------------------------------------------------------------------
//  failure policy
// ---------------------------------------------------------------------------

test('a missing file stops the run, names the file, and keeps memory', async () => {
  const stateDir = tmpdir('fail-state')
  const g = graph([
    node('text', 'io.text', { params: { text: '这个还在内存里' } }),
    node('ref', 'io.reference_audio', { params: { path: '/definitely/not/here.wav' } }),
    node('view', 'out.preview', { inputs: { value: { node: 'ref', port: 'audio' } } }),
  ])
  const engine = new FlowEngine({ stateDir })

  await assert.rejects(() => engine.start(g), err => {
    assert.equal(err.code, 'FG_REF_AUDIO_NOT_FOUND')
    assert.match(err.message, /\/definitely\/not\/here\.wav/, '报错要指名道姓说哪个文件')
    assert.equal(err.node_id, 'ref')
    assert.ok(err.live_values >= 1, '出错时绝对不能释放内存')
    return true
  })

  const runs = fs.readdirSync(stateDir)
  assert.equal(runs.length, 1, '出错时应该把工作状态留在盘上')
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, runs[0]), 'utf8'))
  assert.equal(saved.status, 'failed')
  assert.equal(saved.error.node_id, 'ref')
  assert.ok(saved.memory.some(slot => slot.node_id === 'text' && slot.released === false))
})

test('the failure message says which pass of the loop it was', async () => {
  const dir = tmpdir('loop-fail')
  const good = path.join(dir, 'ok.wav')
  fs.writeFileSync(good, 'x')
  let seen = 0
  const guardedFs = Object.create(fs)
  guardedFs.existsSync = p => {
    if (p === good) { seen += 1; return seen < 3 }
    return fs.existsSync(p)
  }
  const g = graph([
    node('start', 'flow.loop_start', { params: { times: 4 } }),
    node('always', 'logic.compare', { inputs: { a: { node: 'start', port: 'index' } }, params: { op: '>=', b: 0 } }),
    node('ref', 'io.reference_audio', { params: { path: good }, inputs: { enable: { node: 'always', port: 'value' } } }),
    node('bag', 'flow.append', { inputs: { value: { node: 'ref', port: 'audio' } } }),
    node('end', 'flow.loop_end', { inputs: { body: { node: 'bag', port: 'list' } }, params: { loop: 'start' } }),
  ])
  const engine = new FlowEngine({ fs: guardedFs })
  await assert.rejects(() => engine.start(g), err => {
    assert.equal(err.iteration, 2)
    assert.match(err.message, /第 3 轮/)
    return true
  })
})

test('asking for synthesis with nothing wired up says so plainly', async () => {
  const g = graph([
    node('text', 'io.text', { params: { text: 'a' } }),
    node('engine', 'io.engine'),
    node('tts', 'tts.synthesize', {
      inputs: { text: { node: 'text', port: 'text' }, engine: { node: 'engine', port: 'engine' } },
    }),
  ])
  const engine = new FlowEngine({})
  await assert.rejects(() => engine.start(g), err => err.code === 'FG_SYNTHESIZE_UNAVAILABLE')
})

// ---------------------------------------------------------------------------
//  graph store
// ---------------------------------------------------------------------------

test('a graph survives a save and a read back unchanged', () => {
  const store = new GraphStore({ dir: tmpdir('store') })
  const g = normaliseGraph(graph([
    node('text', 'io.text', { params: { text: '你好' }, position: { x: 12, y: 34 } }),
    node('view', 'out.preview', { inputs: { value: { node: 'text', port: 'text' } } }),
  ]))
  g.groups = [{ id: 'g1', title: '第一段', node_ids: ['text', 'view'] }]
  const saved = store.save(g)
  const back = store.load(saved.graph_id)

  assert.equal(back.nodes.length, 2)
  assert.deepEqual(back.nodes[0].position, { x: 12, y: 34 })
  assert.deepEqual(back.nodes[1].inputs.value, { node: 'text', port: 'text' })
  assert.equal(back.groups[0].title, '第一段')

  // And it still runs after the round trip.
  return new FlowEngine({}).start(back).then(report => {
    assert.equal(report.status, RUN_STATES.SUCCEEDED)
  })
})

test('a block keeps its inside and its outside ports', () => {
  const store = new GraphStore({ dir: tmpdir('store-block') })
  const g = emptyGraph('带块的图')
  g.nodes = [node('text', 'io.text', { params: { text: 'a' }, block_id: null })]
  g.blocks = [{
    id: 'b1',
    title: '一段常用的处理',
    interface: { inputs: [{ name: 'in', node: 'inner', port: 'text' }], outputs: [{ name: 'out', node: 'inner2', port: 'lines' }] },
    nodes: [
      node('inner', 'io.text', { params: { text: 'x' } }),
      node('inner2', 'text.split', { inputs: { text: { node: 'inner', port: 'text' } } }),
    ],
  }]
  const back = store.load(store.save(g).graph_id)
  assert.equal(back.blocks[0].nodes.length, 2)
  assert.equal(back.blocks[0].interface.inputs[0].name, 'in')
  assert.equal(back.blocks[0].interface.outputs[0].port, 'lines')
})

test('two nodes with the same number are refused on save', () => {
  const store = new GraphStore({ dir: tmpdir('store-dup') })
  assert.throws(() => store.save(graph([node('a', 'io.text'), node('a', 'io.text')])),
    err => err.code === 'FG_STORE_DUPLICATE_ID')
})

test('listing shows what is on the shelf, newest first', () => {
  let t = 0
  const store = new GraphStore({ dir: tmpdir('store-list'), clock: () => `2026-01-0${++t}T00:00:00Z` })
  store.save(Object.assign(emptyGraph('第一张'), { graph_id: 'one', nodes: [node('a', 'io.text')] }))
  store.save(Object.assign(emptyGraph('第二张'), { graph_id: 'two', nodes: [node('a', 'io.text'), node('b', 'io.text')] }))
  const listed = store.list()
  assert.deepEqual(listed.map(g => g.graph_id), ['two', 'one'])
  assert.equal(listed[0].node_count, 2)
})

test('a graph saved by a newer version is refused rather than half-understood', () => {
  const store = new GraphStore({ dir: tmpdir('store-ver') })
  assert.throws(() => store.load.call({
    ...store,
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify({ schema_version: 99, nodes: [] }) },
    _path: () => '/x.json',
  }, 'x'), err => err.code === 'FG_STORE_VERSION_TOO_NEW')
})

// ---------------------------------------------------------------------------
//  the whole thing, end to end
// ---------------------------------------------------------------------------

test('a real-shaped graph: split, loop, synthesise, accumulate, pause, pick, save, release', async () => {
  const outputDir = tmpdir('e2e-out')
  const synth = fakeSynthesis()
  const g = graph([
    node('text', 'io.text', { params: { text: '第一句。第二句。第三句。' } }),
    node('engine', 'io.engine'),
    node('split', 'text.split', { inputs: { text: { node: 'text', port: 'text' } } }),
    node('start', 'flow.loop_start', { inputs: { list: { node: 'split', port: 'lines' } } }),
    node('tts', 'tts.synthesize', {
      inputs: { text: { node: 'start', port: 'item' }, engine: { node: 'engine', port: 'engine' } },
    }),
    node('bag', 'flow.append', { inputs: { value: { node: 'tts', port: 'audio' } } }),
    node('end', 'flow.loop_end', { inputs: { body: { node: 'bag', port: 'list' } }, params: { loop: 'start' } }),
    node('listen', 'out.preview', { inputs: { value: { node: 'bag', port: 'list' } }, params: { label: '三条候选' } }),
    node('pickER', 'logic.select', { inputs: { candidates: { node: 'bag', port: 'list' } } }),
    node('save', 'out.save', { inputs: { value: { node: 'pickER', port: 'selected' } }, params: { basename: 'final' } }),
    node('free', 'sys.release', { inputs: { value: { node: 'bag', port: 'list' } } }),
  ])

  const engine = new FlowEngine({ synthesize: synth.fn, outputDir })
  const waiting = await engine.start(g)
  assert.equal(waiting.status, RUN_STATES.AWAITING_INPUT)
  assert.equal(waiting.pending.request.count, 3)

  const done = await engine.resume(waiting.run_id, [0, 2])
  assert.equal(done.status, RUN_STATES.SUCCEEDED)
  assert.equal(synth.calls.length, 3)
  assert.deepEqual(fs.readdirSync(outputDir).sort(), ['final_001.wav', 'final_002.wav'])
  assert.equal(fs.readFileSync(path.join(outputDir, 'final_001.wav'), 'utf8'), 'audio:第一句。')
  assert.equal(fs.readFileSync(path.join(outputDir, 'final_002.wav'), 'utf8'), 'audio:第三句。')
  assert.ok(done.events.some(e => e.type === 'released'))
})
