'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { FlowgraphService } = require('./service')
const { createSaveVoiceAdapter } = require('./adapter')

// A stand-in for the broker's voice store: the same four functions the voices
// route is handed, so what is exercised here is the real contract.
function fakeVoiceStore(initial = {}) {
  const state = { voices: { ...initial }, locked: 0, backups: 0 }
  return {
    state,
    ctx: {
      loadVoices: () => ({ ...state.voices }),
      saveVoices: voices => { state.voices = { ...voices } },
      withVoicesLock: async fn => { state.locked += 1; await fn() },
      _backupVoicesUnlocked: async () => { state.backups += 1 },
      safeId: id => /^[A-Za-z0-9_-]+$/.test(id),
    },
  }
}

test('a voice saved from the canvas is written like any other voice', async () => {
  const store = fakeVoiceStore()
  const saveVoice = createSaveVoiceAdapter(store.ctx)
  const result = await saveVoice({
    id: 'narrator_v2',
    display_name: '旁白 · 第二版',
    language: 'zh',
    reference_audio: '/refs/narrator.wav',
    params: { gpt_model: '/models/a.ckpt', sovits_model: '/models/a.pth', top_k: 20 },
  })

  assert.equal(result.id, 'narrator_v2')
  const written = store.state.voices.narrator_v2
  assert.equal(written.display_name, '旁白 · 第二版')
  assert.equal(written.gpt_model, '/models/a.ckpt')
  assert.equal(written.reference_audio, '/refs/narrator.wav')
  assert.equal(written.top_k, 20)
  assert.equal(written.temperature, 1.0, '配方没写的项要落在与音色页一致的默认值上')
  assert.equal(written.prompt_lang, 'zh')
  assert.equal(store.state.locked, 1, '写音色必须走锁，否则两处同时写会丢一条')
  assert.equal(store.state.backups, 1, '覆盖 voices.json 前必须先备份')
})

test('saving a voice never replaces an existing one by accident', async () => {
  const store = fakeVoiceStore({ narrator: { display_name: '原有音色' } })
  const saveVoice = createSaveVoiceAdapter(store.ctx)

  await assert.rejects(
    () => saveVoice({ id: 'narrator', params: {} }),
    err => err.code === 'FG_VOICE_EXISTS',
  )
  assert.equal(store.state.voices.narrator.display_name, '原有音色', '被拒绝时原音色必须原封不动')

  await saveVoice({ id: 'narrator', display_name: '新的', overwrite: true, params: {} })
  assert.equal(store.state.voices.narrator.display_name, '新的', '明确要求覆盖时才覆盖')

  await assert.rejects(
    () => saveVoice({ id: '../etc/passwd', params: {} }),
    err => err.code === 'FG_VOICE_BAD_ID',
  )
  assert.equal(createSaveVoiceAdapter({}), null, '宿主没有音色存储时不能假装能保存')
})

function makeService(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsvc-'))
  return new FlowgraphService(Object.assign({ rootDir: root }, extra))
}

const node = (id, type, e = {}) => Object.assign({ id, type, inputs: {}, params: {} }, e)
const graph = (nodes, name = '测试流程') => ({ schema_version: 1, name, nodes, groups: [], blocks: [] })

test('the canvas gets every node, grouped, with ports and default settings', () => {
  const catalogue = makeService().nodeCatalogue()
  assert.ok(catalogue.count >= 30, `节点数量 ${catalogue.count} 太少了，八成有一族没被加载进来`)

  const ids = catalogue.categories.map(c => c.id)
  for (const expected of ['load', 'process', 'logic', 'loop', 'quality', 'sink']) {
    assert.ok(ids.includes(expected), `节点面板缺了「${expected}」这一类`)
  }

  const all = catalogue.categories.flatMap(c => c.nodes)
  const pause = all.find(n => n.type === 'logic.pause')
  assert.equal(pause.suspends, true, '画布得知道 pause 会停下来等人')
  assert.equal(pause.outputs[0].type, 'Boolean')

  // Every node carries the optional enable port, which is what makes "条件为 0
  // 就不往下走" impossible for a node to forget.
  for (const definition of all) {
    assert.ok(definition.inputs.some(p => p.name === 'enable'), `${definition.type} 少了 enable 口`)
  }

  // A freshly dragged node must already be usable, so defaults have to travel.
  const normalise = all.find(n => n.type === 'quality.normalize')
  assert.deepEqual(normalise.params.map(p => p.name).sort(), ['bad', 'good'])
})

test('the quality family really is registered, not just written', () => {
  const types = makeService().nodeCatalogue().categories
    .find(c => c.id === 'quality').nodes.map(n => n.type)
  for (const expected of [
    'quality.measure_basic', 'quality.measure_similarity', 'quality.read_metric',
    'quality.normalize', 'quality.weighted_score', 'quality.standard',
    'quality.threshold', 'quality.filter_list', 'quality.top_k',
    'quality.score_table', 'quality.check_recipe',
  ]) {
    assert.ok(types.includes(expected), `${expected} 没注册进去`)
  }
})

test('a graph survives a save and a reload without changing shape', () => {
  const service = makeService()
  const saved = service.saveGraph(graph([
    node('t', 'io.text', { params: { text: '你好' }, position: { x: 10, y: 20 } }),
    node('p', 'out.preview', { inputs: { value: { node: 't', port: 'text' } } }),
  ]))
  assert.ok(saved.graph_id)

  const back = service.loadGraph(saved.graph_id)
  assert.equal(back.name, '测试流程')
  assert.deepEqual(back.nodes[0].position, { x: 10, y: 20 }, '画布上的位置也得存下来')
  assert.deepEqual(back.nodes[1].inputs.value, { node: 't', port: 'text' })

  assert.equal(service.listGraphs().length, 1)
  assert.equal(service.deleteGraph(saved.graph_id), true)
  assert.equal(service.listGraphs().length, 0)
})

test('checking a graph reports what is wrong before anything runs', () => {
  const service = makeService()
  const good = service.check(graph([node('t', 'io.text', { params: { text: 'x' } })]))
  assert.equal(good.ok, true)

  const bad = service.check(graph([
    node('p', 'out.preview', { inputs: { value: { node: '不存在的节点', port: 'text' } } }),
  ]))
  assert.equal(bad.ok, false)
  assert.ok(bad.problems.length > 0, '接不上就得说出是哪里接不上')
})

test('a run can be started, looked up afterwards, and listed', async () => {
  const service = makeService()
  const report = await service.start(graph([
    node('t', 'io.text', { params: { text: '你好' } }),
    node('p', 'out.preview', { inputs: { value: { node: 't', port: 'text' } } }),
  ]))
  assert.equal(report.status, 'succeeded')
  assert.equal(service.report(report.run_id).run_id, report.run_id)
  const listed = service.listRuns()
  assert.equal(listed[0].graph_name, '测试流程')
})

test('a pause really waits, and the answer sent back over HTTP restarts it', async () => {
  const service = makeService()
  const g = graph([
    node('t', 'io.text', { params: { text: '你好' } }),
    node('gate', 'logic.pause', { params: { prompt: '这条能用吗？' } }),
    node('p', 'out.preview', {
      inputs: { value: { node: 't', port: 'text' }, enable: { node: 'gate', port: 'value' } },
    }),
  ])
  const started = await service.start(g)
  assert.equal(started.status, 'awaiting_input')
  assert.equal(started.pending.node_id, 'gate')
  assert.equal(started.pending.request.kind, 'pause')
  assert.equal(started.pending.request.prompt, '这条能用吗？', '弹窗上要显示图里写的那句话')

  const finished = await service.resume(started.run_id, true)
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.events.find(e => e.type === 'preview').value, '你好')
})

test('cancelling a pause stops that line without killing the run', async () => {
  const service = makeService()
  const started = await service.start(graph([
    node('t', 'io.text', { params: { text: '你好' } }),
    node('gate', 'logic.pause'),
    node('p', 'out.preview', {
      inputs: { value: { node: 't', port: 'text' }, enable: { node: 'gate', port: 'value' } },
    }),
  ]))
  const finished = await service.resume(started.run_id, false)
  assert.equal(finished.status, 'succeeded', '取消是正常终点，不是出错')
  assert.equal(finished.nodes.find(n => n.node_id === 'p').status, 'skipped')
})

test('answering a run that is not waiting is refused instead of silently ignored', async () => {
  const service = makeService()
  const report = await service.start(graph([node('t', 'io.text', { params: { text: 'x' } })]))
  await assert.rejects(() => service.resume(report.run_id, true), err => err.code === 'FG_RUN_NOT_WAITING')
  await assert.rejects(() => service.resume('run_nope', true), err => err.code === 'FG_RUN_UNKNOWN')
})

test('a run that fails stops loudly, keeps its memory, and names the node and round', async () => {
  const service = makeService()
  let thrown = null
  await assert.rejects(() => service.start(graph([
    node('t', 'io.text', { params: { text: '你好' } }),
    node('ref', 'io.reference_audio', { params: { path: '/definitely/not/here.wav' } }),
    node('p', 'out.preview', { inputs: { value: { node: 'ref', port: 'audio' } } }),
  ])), err => { thrown = err; return true })

  assert.equal(thrown.node_id, 'ref')
  assert.match(thrown.message, /第 1 轮/, '报错要说是第几轮')
  assert.match(thrown.message, /运行前该文件仍可访问/, '报错要指向环境被人动过，而不是笼统的失败')
  // The ruling: on failure nothing is released, because that memory is exactly
  // what is needed to work out what happened.
  assert.match(thrown.message, /中间结果未释放/)
  assert.ok(thrown.live_values >= 1, '出错时内存不能释放，现在只剩 ' + thrown.live_values + ' 个值')

  // And a failed run stays visible afterwards rather than vanishing.
  const report = service.report(thrown.run_id)
  assert.equal(report.status, 'failed')
  assert.ok(service.listRuns().some(r => r.run_id === thrown.run_id))
})

test('the run state is written to disk on failure so it survives a restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowstate-'))
  const service = new FlowgraphService({ rootDir: root })
  let thrown = null
  await assert.rejects(() => service.start(graph([
    node('ref', 'io.reference_audio', { params: { path: '/nope.wav' } }),
  ])), err => { thrown = err; return true })
  const written = fs.readdirSync(service.stateDir)
  assert.ok(written.includes(`${thrown.run_id}.json`), '出错要留存工作状态，现在盘上只有 ' + written.join('、'))
})

test('the synthesis node says the service is missing rather than pretending', async () => {
  const service = makeService()
  await assert.rejects(() => service.start(graph([
    node('t', 'io.text', { params: { text: '你好' } }),
    node('e', 'io.engine', { params: { voice: '阿伟' } }),
    node('tts', 'tts.synthesize', {
      inputs: { text: { node: 't', port: 'text' }, engine: { node: 'e', port: 'engine' } },
    }),
  ])), err => err.code === 'FG_SYNTHESIZE_UNAVAILABLE')
})

test('a full threshold graph runs end to end through the service', async () => {
  // Fake synthesis: it writes a real WAV, so the measuring nodes have something
  // genuine to chew on rather than a stub that always agrees with us.
  const wav = (hz, seconds = 1) => {
    const sr = 16000
    const n = Math.round(sr * seconds)
    const b = Buffer.alloc(44 + n * 2)
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8)
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
    b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
    b.write('data', 36); b.writeUInt32LE(n * 2, 40)
    for (let i = 0; i < n; i += 1) {
      const t = i / sr
      const v = (t > 0.05 && t < seconds - 0.05) ? 0.3 * Math.sin(2 * Math.PI * hz * t) : 0
      b.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
    }
    return b
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsynth-'))
  const refPath = path.join(dir, 'ref.wav')
  fs.writeFileSync(refPath, wav(150))

  let round = 0
  const service = makeService({
    synthesize: async request => {
      round += 1
      const p = path.join(dir, `take${round}.wav`)
      fs.writeFileSync(p, wav(round === 1 ? 150 : 400))
      return { kind: 'audio', path: p, recipe: { voice: request.engine.voice, text: request.text, seed: round } }
    },
  })

  const g = graph([
    node('ref', 'io.reference_audio', { params: { path: refPath } }),
    node('txt', 'io.text', { params: { text: '一二三四五' } }),
    node('eng', 'io.engine', { params: { voice: '阿伟' } }),
    node('start', 'flow.loop_start', { params: { times: 2 } }),
    node('tts', 'tts.synthesize', {
      inputs: {
        text: { node: 'txt', port: 'text' },
        engine: { node: 'eng', port: 'engine' },
        reference_audio: { node: 'ref', port: 'audio' },
        seed: { node: 'start', port: 'index' },
      },
    }),
    node('m', 'quality.measure_similarity', {
      inputs: { audio: { node: 'tts', port: 'audio' }, reference: { node: 'ref', port: 'audio' } },
    }),
    node('d', 'quality.read_metric', {
      inputs: { metrics: { node: 'm', port: 'metrics' } }, params: { name: 'mfcc_cosine_distance' },
    }),
    node('s', 'quality.normalize', { inputs: { value: { node: 'd', port: 'value' } }, params: { good: 0, bad: 0.5 } }),
    node('clips', 'flow.append', { inputs: { value: { node: 'tts', port: 'audio' } } }),
    node('scores', 'flow.append', { inputs: { value: { node: 's', port: 'score' } } }),
    node('end', 'flow.loop_end', {
      inputs: { body: [{ node: 'clips', port: 'list' }, { node: 'scores', port: 'list' }] },
      params: { loop: 'start' },
    }),
    node('table', 'quality.score_table', {
      inputs: { metrics: { node: 'scores', port: 'list' }, scores: { node: 'scores', port: 'list' } },
      params: { pass_score: 60 },
    }),
    node('filter', 'quality.filter_list', {
      inputs: { items: { node: 'clips', port: 'list' }, scores: { node: 'scores', port: 'list' } },
      params: { pass_score: 60 },
    }),
    node('pick', 'logic.select', { inputs: { candidates: { node: 'filter', port: 'kept' } } }),
    node('save', 'out.save', {
      inputs: { value: { node: 'pick', port: 'selected' } },
      params: { dir: path.join(dir, 'final'), basename: '成品' },
    }),
    node('bin', 'sys.release', { inputs: { value: { node: 'filter', port: 'dropped' } } }),
  ])

  const started = await service.start(g)
  // Two takes were made, measured and filtered; then it stops for the person.
  assert.equal(started.status, 'awaiting_input')
  assert.equal(started.pending.node_id, 'pick')
  assert.equal(started.pending.request.kind, 'select')
  assert.equal(started.pending.request.count, 1, '两条里只有同源那条过了门槛，人工只需要在 1 条里挑')

  const finished = await service.resume(started.run_id, [0])
  assert.equal(finished.status, 'succeeded')
  const saved = finished.events.find(e => e.type === 'saved')
  assert.equal(saved.files.length, 1)
  assert.ok(fs.existsSync(saved.files[0]), '成品得真的落在盘上')
  assert.ok(finished.events.some(e => e.type === 'released'), '被淘汰的那条接了释放，就该真的被释放')
})
