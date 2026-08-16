import test from 'node:test'
import assert from 'node:assert/strict'

import {
  emptyGraph, addNode, moveNode, setParam, removeNode, connect, disconnect,
  edgesOf, missingInputs, typesFit, wouldCycle, makeNodeId, findDefinition,
  pickText, clampZoom, zoomAround, isTypingTarget, describeValue,
  voicePreset, applyPreset,
  ZOOM_MIN, ZOOM_MAX,
} from './graphModel.js'

// A stand-in for what /api/flowgraph/nodes returns, kept small on purpose so a
// failure points at the wiring rules rather than at the fixture.
const catalogue = {
  categories: [
    {
      id: 'load',
      nodes: [
        {
          type: 'io.text',
          label: '文字',
          inputs: [{ name: 'enable', type: 'Boolean', required: false, multiple: false }],
          outputs: [{ name: 'text', type: 'Text' }],
          params: [{ name: 'text', default: '' }],
        },
        {
          type: 'io.number',
          label: '数字',
          inputs: [{ name: 'enable', type: 'Boolean', required: false, multiple: false }],
          outputs: [{ name: 'value', type: 'Number' }],
          params: [{ name: 'value', default: 0 }],
        },
      ],
    },
    {
      id: 'process',
      nodes: [
        {
          type: 'tts.synthesize',
          label: '合成',
          inputs: [
            { name: 'text', type: 'Text', required: true, multiple: false },
            { name: 'engine', type: 'Engine', required: true, multiple: false },
            { name: 'seed', type: 'Number', required: false, multiple: false },
            { name: 'enable', type: 'Boolean', required: false, multiple: false },
          ],
          outputs: [{ name: 'audio', type: 'Audio' }],
          params: [{ name: 'format', default: 'wav' }],
        },
      ],
    },
    {
      id: 'loop',
      nodes: [
        {
          type: 'flow.loop_end',
          label: '循环结束',
          inputs: [
            { name: 'body', type: 'Any', required: false, multiple: true },
            { name: 'enable', type: 'Boolean', required: false, multiple: false },
          ],
          outputs: [{ name: 'done', type: 'Boolean' }],
          params: [{ name: 'loop', default: null }],
        },
      ],
    },
    {
      id: 'sink',
      nodes: [
        {
          type: 'out.preview',
          label: '试听 / 查看',
          inputs: [
            { name: 'value', type: 'Any', required: true, multiple: false },
            { name: 'enable', type: 'Boolean', required: false, multiple: false },
          ],
          outputs: [],
          params: [{ name: 'label', default: '' }],
        },
      ],
    },
  ],
}

const def = type => findDefinition(catalogue, type)

test('a dropped node arrives with its settings already filled in', () => {
  const graph = addNode(emptyGraph(), def('io.text'), { x: 40, y: 80 })
  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.nodes[0].id, 'text', '节点编号要是人看得懂的，报错时才有意义')
  assert.equal(graph.nodes[0].params.text, '', '刚拖出来就该能直接用，不用先去填一遍默认值')
  assert.deepEqual(graph.nodes[0].position, { x: 40, y: 80 })
})

test('two of the same node get told apart instead of clashing', () => {
  let graph = addNode(emptyGraph(), def('io.text'))
  graph = addNode(graph, def('io.text'))
  graph = addNode(graph, def('io.text'))
  assert.deepEqual(graph.nodes.map(n => n.id), ['text', 'text2', 'text3'])
  assert.equal(makeNodeId(graph, 'io.text'), 'text4')
})

test('a wire between matching ports goes in', () => {
  let graph = addNode(addNode(emptyGraph(), def('io.text')), def('out.preview'))
  const result = connect(graph, catalogue, { node: 'text', port: 'text' }, { node: 'preview', port: 'value' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.graph.nodes[1].inputs.value, { node: 'text', port: 'text' })
  assert.equal(edgesOf(result.graph).length, 1)
})

test('a wire between the wrong kinds is refused with both kinds named', () => {
  let graph = addNode(addNode(emptyGraph(), def('io.number')), def('tts.synthesize'))
  const result = connect(graph, catalogue, { node: 'number', port: 'value' }, { node: 'synthesize', port: 'text' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /Number/)
  assert.match(result.reason, /Text/)
})

test('the few sensible conversions are allowed, and nothing else', () => {
  assert.equal(typesFit('Number', 'Score'), true)
  assert.equal(typesFit('Score', 'Number'), true)
  assert.equal(typesFit('Boolean', 'Number'), true)
  assert.equal(typesFit('Audio', 'ReferenceAudio'), true)
  assert.equal(typesFit('Any', 'Audio'), true, '万能口谁都能接')
  assert.equal(typesFit('Audio', 'Any'), true)
  assert.equal(typesFit('Text', 'Audio'), false)
  assert.equal(typesFit('Audio', 'Engine'), false)
})

test('a wire that would make a ring is refused, and it says to use the loop nodes', () => {
  let graph = addNode(addNode(emptyGraph(), def('io.text')), def('out.preview'))
  graph = connect(graph, catalogue, { node: 'text', port: 'text' }, { node: 'preview', port: 'value' }).graph
  assert.equal(wouldCycle(graph, 'preview', 'text'), true)

  // A ring that is type-correct at every step, so only the ring check can stop
  // it: text feeds the loop end, and the loop end's "done" is a Boolean that
  // would fit straight back into text's enable.
  let ring = addNode(addNode(emptyGraph(), def('io.text')), def('flow.loop_end'))
  ring = connect(ring, catalogue, { node: 'text', port: 'text' }, { node: 'loop_end', port: 'body' }).graph
  const back = connect(ring, catalogue, { node: 'loop_end', port: 'done' }, { node: 'text', port: 'enable' })
  assert.equal(back.ok, false)
  assert.match(back.reason, /循环开始/, '不让接圈的时候要告诉人正确的做法是什么')
})

test('a port that takes several wires keeps them all; a single one gets replaced', () => {
  let graph = addNode(addNode(addNode(emptyGraph(), def('io.text')), def('io.number')), def('flow.loop_end'))
  graph = connect(graph, catalogue, { node: 'text', port: 'text' }, { node: 'loop_end', port: 'body' }).graph
  graph = connect(graph, catalogue, { node: 'number', port: 'value' }, { node: 'loop_end', port: 'body' }).graph
  assert.equal(graph.nodes[2].inputs.body.length, 2, '一个循环里同时攒音频和攒分数是常态，不是特例')

  let single = addNode(addNode(addNode(emptyGraph(), def('io.text')), def('io.text')), def('out.preview'))
  single = connect(single, catalogue, { node: 'text', port: 'text' }, { node: 'preview', port: 'value' }).graph
  single = connect(single, catalogue, { node: 'text2', port: 'text' }, { node: 'preview', port: 'value' }).graph
  assert.deepEqual(single.nodes[2].inputs.value, { node: 'text2', port: 'text' }, '往占着的口上拖，意思显然是换一条')
})

test('the same wire twice is refused rather than quietly doubled', () => {
  let graph = addNode(addNode(emptyGraph(), def('io.text')), def('flow.loop_end'))
  graph = connect(graph, catalogue, { node: 'text', port: 'text' }, { node: 'loop_end', port: 'body' }).graph
  const again = connect(graph, catalogue, { node: 'text', port: 'text' }, { node: 'loop_end', port: 'body' })
  assert.equal(again.ok, false)
})

test('pulling one wire off a shared port leaves the others alone', () => {
  let graph = addNode(addNode(addNode(emptyGraph(), def('io.text')), def('io.number')), def('flow.loop_end'))
  graph = connect(graph, catalogue, { node: 'text', port: 'text' }, { node: 'loop_end', port: 'body' }).graph
  graph = connect(graph, catalogue, { node: 'number', port: 'value' }, { node: 'loop_end', port: 'body' }).graph
  const after = disconnect(graph, { node: 'loop_end', port: 'body' }, { node: 'text', port: 'text' })
  assert.deepEqual(after.nodes[2].inputs.body, [{ node: 'number', port: 'value' }])
})

test('deleting a node takes its wires with it, so the graph still runs', () => {
  let graph = addNode(addNode(emptyGraph(), def('io.text')), def('out.preview'))
  graph = connect(graph, catalogue, { node: 'text', port: 'text' }, { node: 'preview', port: 'value' }).graph
  const after = removeNode(graph, 'text')
  assert.equal(after.nodes.length, 1)
  assert.equal(edgesOf(after).length, 0, '留着指向已删节点的线，图会存得下来却跑不起来')
})

test('the canvas can say what is still unwired before you press go', () => {
  let graph = addNode(emptyGraph(), def('tts.synthesize'))
  const before = missingInputs(graph, catalogue)
  assert.deepEqual(before.map(m => m.port).sort(), ['engine', 'text'])
  assert.match(before[0].message, /未连接/)

  graph = addNode(graph, def('io.text'))
  graph = connect(graph, catalogue, { node: 'text', port: 'text' }, { node: 'synthesize', port: 'text' }).graph
  assert.deepEqual(missingInputs(graph, catalogue).map(m => m.port), ['engine'])
})

test('optional inputs, including enable, are never nagged about', () => {
  const graph = addNode(emptyGraph(), def('io.text'))
  assert.deepEqual(missingInputs(graph, catalogue), [], 'enable 是可选的，不该被当成漏接')
})

test('a node this server does not know is called out by name', () => {
  const graph = { ...emptyGraph(), nodes: [{ id: 'x', type: 'made.up', inputs: {}, params: {} }] }
  const problems = missingInputs(graph, catalogue)
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /made\.up/)
})

test('moving a node and typing in a setting change nothing else', () => {
  let graph = addNode(addNode(emptyGraph(), def('io.text')), def('io.number'))
  graph = connect(graph, catalogue, { node: 'text', port: 'text' }, { node: 'number', port: 'enable' }).ok
    ? graph
    : graph
  const moved = moveNode(graph, 'text', { x: 300.4, y: 120.6 })
  assert.deepEqual(moved.nodes[0].position, { x: 300, y: 121 })
  assert.deepEqual(moved.nodes[1], graph.nodes[1])

  const typed = setParam(moved, 'text', 'text', '你好')
  assert.equal(typed.nodes[0].params.text, '你好')
  assert.deepEqual(typed.nodes[0].position, { x: 300, y: 121 }, '改设置不该把节点弹回原位')
})

// ---------------------------------------------------------------------------
//  Language, zoom and the delete key
// ---------------------------------------------------------------------------

test('labels come out in the chosen language, and a missing one never blanks the screen', () => {
  const label = { en: 'Seed', zh: '随机种子' }
  assert.equal(pickText(label, 'en'), 'Seed')
  assert.equal(pickText(label, 'zh'), '随机种子')
  assert.equal(pickText({ en: 'Seed' }, 'zh'), 'Seed', '缺中文时退回英文，而不是显示空白')
  assert.equal(pickText({ zh: '随机种子' }, 'en'), '随机种子')
  assert.equal(pickText('plain string', 'zh'), 'plain string', '老服务器只给一个字符串也要能用')
  assert.equal(pickText(null, 'zh', 'seed'), 'seed')
})

test('a refused wire explains itself in both languages', () => {
  const graph = addNode(addNode(emptyGraph(), def('io.number')), def('tts.synthesize'))
  const result = connect(graph, catalogue, { node: 'number', port: 'value' }, { node: 'synthesize', port: 'text' })
  assert.equal(result.ok, false)
  assert.match(result.reason_i18n.zh, /类型不匹配/)
  assert.match(result.reason_i18n.en, /Type mismatch/)
  assert.match(result.reason_i18n.en, /Number/)
})

test('what is still unwired is reported in both languages too', () => {
  const graph = addNode(emptyGraph(), def('tts.synthesize'))
  const problems = missingInputs(graph, catalogue)
  assert.ok(problems.length > 0)
  for (const problem of problems) {
    assert.ok(problem.message_i18n.zh && problem.message_i18n.en, '两种语言都要有，否则英文界面里会冒出中文')
  }
})

test('the wheel zooms towards the pointer, not towards the middle of nowhere', () => {
  // Cursor 100px into the box, canvas not scrolled: the graph point under the
  // cursor is at 100. After zooming in it sits at 100 * 1.25 = 125, so the box
  // has to scroll by 25 to keep it under the cursor.
  const zoomedIn = zoomAround({ zoom: 1, factor: 1.25, pointer: { x: 100, y: 100 }, scroll: { left: 0, top: 0 } })
  assert.equal(zoomedIn.zoom, 1.25)
  assert.equal(zoomedIn.left, 25)
  assert.equal(zoomedIn.top, 25)

  // Zooming back out by the same factor returns to exactly where it started.
  const back = zoomAround({
    zoom: zoomedIn.zoom, factor: 1 / 1.25,
    pointer: { x: 100, y: 100 }, scroll: { left: zoomedIn.left, top: zoomedIn.top },
  })
  assert.equal(back.zoom, 1)
  assert.equal(back.left, 0)
  assert.equal(back.top, 0)

  // Never asks for a negative scroll position: the box would silently clamp it
  // and the zoom and the scroll would then disagree about where things are.
  const atEdge = zoomAround({ zoom: 1, factor: 0.5, pointer: { x: 10, y: 10 }, scroll: { left: 0, top: 0 } })
  assert.ok(atEdge.left >= 0 && atEdge.top >= 0)
})

test('zoom stays inside sane limits however hard the wheel is spun', () => {
  assert.equal(clampZoom(99), ZOOM_MAX)
  assert.equal(clampZoom(0.001), ZOOM_MIN)
  assert.equal(clampZoom(Number.NaN), 1, '算出 NaN 时画布必须还能用')
  let zoom = 1
  for (let i = 0; i < 50; i += 1) {
    zoom = zoomAround({ zoom, factor: 1.1, pointer: { x: 0, y: 0 }, scroll: { left: 0, top: 0 } }).zoom
  }
  assert.equal(zoom, ZOOM_MAX)
})

test('Delete deletes a node, except while typing into a setting', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true)
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true)
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false)
  assert.equal(isTypingTarget(null), false)
})

// ---------------------------------------------------------------------------
//  Voice as a preset
// ---------------------------------------------------------------------------
// The ruling these tests hold to: a voice belongs to the broker. Picking one
// here copies its numbers in once and then lets go. Nothing stays bound, and
// nothing is written back.

test('a voice preset carries only the fields the engine understands', () => {
  const preset = voicePreset({
    id: 'narrator',
    display_name: '旁白',          // broker bookkeeping, must not travel
    language: 'zh',                // ditto
    gpt_model: '/models/a.ckpt',
    sovits_model: '/models/a.pth',
    sample_steps: 32,
    if_sr: false,
    speed_factor: 1.1,
    aux_ref_audio_paths: ['/a.wav', '/b.wav'],
    batch_size: null,              // unset in the record, so not a value to copy
    fragment_interval: '',
  })
  assert.deepEqual(preset, {
    gpt_model: '/models/a.ckpt',
    sovits_model: '/models/a.pth',
    sample_steps: 32,
    if_sr: false,
    speed_factor: 1.1,
    aux_ref_audio_paths: '/a.wav,/b.wav',
  })
  assert.equal('display_name' in preset, false, '音色的展示信息不属于引擎参数')
  assert.equal('batch_size' in preset, false, '音色没记的项不能当成 null 覆盖节点的值')
  assert.deepEqual(voicePreset(null), {}, '读不到音色时要给出空预设，而不是抛错')
})

test('an imported preset becomes the node\'s own editable values', () => {
  const target = {
    id: 'engine_params',
    type: 'io.engine_params',
    params: { gpt_model: null, sample_steps: null, speed_factor: 1 },
  }
  const graph = { name: 'g', nodes: [target] }
  const result = applyPreset(graph, 'engine_params', {
    gpt_model: '/models/a.ckpt',
    sample_steps: 32,
    top_k: 15,          // not declared by this node
  })
  assert.deepEqual(result.applied.sort(), ['gpt_model', 'sample_steps'])
  assert.deepEqual(result.skipped, ['top_k'], '节点没有的设置要说出来，不能悄悄丢掉')
  assert.equal(result.graph.nodes[0].params.gpt_model, '/models/a.ckpt')
  assert.equal(result.graph.nodes[0].params.speed_factor, 1, '预设没提到的项要原样保留')
  assert.equal(graph.nodes[0].params.gpt_model, null, '导入不能就地改写原图')

  // And after importing, the value is an ordinary one: editing it works exactly
  // as if it had been typed, and there is nothing left pointing at the voice.
  const edited = setParam(result.graph, 'engine_params', 'sample_steps', 8)
  assert.equal(edited.nodes[0].params.sample_steps, 8)
  assert.equal(JSON.stringify(edited).includes('voice'), false, '导入后图里不该残留与音色的绑定')
})

test('a setting shows its current value on the node itself', () => {
  assert.equal(describeValue(-1, 'zh'), '-1')
  assert.equal(describeValue('', 'zh'), '未设置')
  assert.equal(describeValue('', 'en'), '(empty)')
  assert.equal(describeValue(null, 'en'), '(empty)')
  assert.equal(describeValue(true, 'zh'), '启用')
  assert.equal(describeValue(false, 'en'), 'off')
  assert.equal(describeValue([2, 1, 1], 'en'), '[2, 1, 1]')
  assert.equal(describeValue('x'.repeat(40), 'en').length, 23, '长文本要截断，否则一个节点能撑满整块画布')
})
