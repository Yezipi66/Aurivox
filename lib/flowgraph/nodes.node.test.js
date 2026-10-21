'use strict'

//  flowgraph/nodes.js — 节点注册与 handler 行为
// 测节点类型注册完整性 + 纯 handler 逻辑（不依赖 engines/ 目录）。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

require('./nodes') // 注册所有节点
const { listTypes, getDefinition, reset } = require('./registry')

//  registry 完整性

test('所有节点类型均已注册', () => {
  const types = listTypes()
  const expected = [
    'io.text', 'io.reference_audio', 'io.engine', 'io.engine_params',
    'io.number', 'io.boolean', 'io.seed',
    'text.split', 'tts.synthesize', 'audio.concat',
    'logic.pause', 'logic.select', 'logic.compare',
    'logic.and', 'logic.or', 'logic.not', 'logic.xor', 'logic.xnor', 'logic.nand', 'logic.nor',
    'logic.switch', 'logic.sleep',
    'flow.loop_start', 'flow.loop_end', 'flow.append',
    'out.preview', 'out.save', 'out.save_voice', 'sys.release',
  ]
  for (const t of expected) {
    assert.ok(types.includes(t), `节点类型 ${t} 未注册`)
  }
})

test('每个节点都有 enable 输入端口', () => {
  const types = listTypes()
  for (const type of types) {
    const def = getDefinition(type)
    assert.ok(def.inputs.enable, `${type} 缺少 enable 端口`)
    assert.equal(def.inputs.enable.required, false)
    assert.equal(def.inputs.enable.type, 'Boolean')
  }
})

test('每个节点都有 handler 函数', () => {
  const types = listTypes()
  for (const type of types) {
    const def = getDefinition(type)
    assert.equal(typeof def.handler, 'function', `${type} 的 handler 不是函数`)
  }
})

//  io.text — 文字节点

test('io.text: 正常文本通过', async () => {
  const def = getDefinition('io.text')
  const { outputs } = await def.handler({ params: { text: '你好世界' } })
  assert.equal(outputs.text, '你好世界')
})

test('io.text: 非字符串参数抛错', async () => {
  const def = getDefinition('io.text')
  await assert.rejects(
    def.handler({ params: { text: 123 } }),
    /文字节点没有填内容/
  )
})

//  io.reference_audio — 参考音频节点

test('io.reference_audio: 文件存在时返回音频对象', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-'))
  const fp = path.join(tmp, 'ref.wav')
  fs.writeFileSync(fp, Buffer.alloc(44))
  const def = getDefinition('io.reference_audio')
  const { outputs } = await def.handler({ params: { path: fp }, ctx: { fs } })
  assert.equal(outputs.audio.kind, 'reference_audio')
  assert.equal(outputs.audio.path, fp)
  fs.unlinkSync(fp)
  fs.rmdirSync(tmp)
})

test('io.reference_audio: 文件不存在抛错', async () => {
  const def = getDefinition('io.reference_audio')
  await assert.rejects(
    def.handler({ params: { path: '/nonexistent/file.wav' }, ctx: { fs } }),
    /参考音频文件不存在/
  )
})

test('io.reference_audio: 空路径抛错', async () => {
  const def = getDefinition('io.reference_audio')
  await assert.rejects(
    def.handler({ params: { path: '' }, ctx: { fs } }),
    /参考音频节点没有选文件/
  )
})

//  io.engine — 引擎节点

test('io.engine: 返回引擎对象', async () => {
  const def = getDefinition('io.engine')
  const { outputs } = await def.handler({ params: { engine_id: 'myengine', voice: 'narrator', base_url: 'http://localhost' } })
  assert.equal(outputs.engine.engine_id, 'myengine')
  assert.equal(outputs.engine.voice, 'narrator')
  assert.equal(outputs.engine.base_url, 'http://localhost')
})

test('io.engine: 空参数返回 null 字段', async () => {
  const def = getDefinition('io.engine')
  const { outputs } = await def.handler({ params: {} })
  assert.equal(outputs.engine.engine_id, null)
  assert.equal(outputs.engine.voice, null)
  assert.equal(outputs.engine.base_url, null)
})

//  io.engine_params — 引擎参数节点

test('io.engine_params: 空值被丢弃', async () => {
  const def = getDefinition('io.engine_params')
  const { outputs } = await def.handler({
    params: { speed: 1.5, seed: -1, empty: '', null_val: null, undef: undefined },
  })
  assert.deepEqual(outputs.params, { speed: 1.5, seed: -1 })
})

test('io.engine_params: 全空时返回空对象', async () => {
  const def = getDefinition('io.engine_params')
  const { outputs } = await def.handler({ params: { a: '', b: null } })
  assert.deepEqual(outputs.params, {})
})

//  io.number / io.boolean / io.seed

test('io.number: 转换为数字', async () => {
  const def = getDefinition('io.number')
  const { outputs } = await def.handler({ params: { value: '3.14' } })
  assert.equal(outputs.value, 3.14)
})

test('io.boolean: true → 1, false → 0', async () => {
  const def = getDefinition('io.boolean')
  const r1 = await def.handler({ params: { value: true } })
  const r2 = await def.handler({ params: { value: false } })
  assert.equal(r1.outputs.value, 1)
  assert.equal(r2.outputs.value, 0)
})

test('io.seed: 转换为数字', async () => {
  const def = getDefinition('io.seed')
  const { outputs } = await def.handler({ params: { seed: '42' } })
  assert.equal(outputs.seed, 42)
})

//  text.split — 拆句节点

test('text.split: 按标点拆分', async () => {
  const def = getDefinition('text.split')
  const { outputs } = await def.handler({
    inputs: { text: '你好。世界！再见？' },
    params: { max_chars: 60 },
  })
  assert.deepEqual(outputs.lines, ['你好。', '世界！', '再见？'])
})

test('text.split: 长句按 max_chars 切分', async () => {
  const def = getDefinition('text.split')
  const { outputs } = await def.handler({
    inputs: { text: 'abcdefghijklmnop' },
    params: { max_chars: 5 },
  })
  assert.deepEqual(outputs.lines, ['abcde', 'fghij', 'klmno', 'p'])
})

test('text.split: 空文本返回单元素数组', async () => {
  const def = getDefinition('text.split')
  const { outputs } = await def.handler({
    inputs: { text: '' },
    params: { max_chars: 60 },
  })
  assert.deepEqual(outputs.lines, [''])
})

//  logic.compare — 比较节点

test('logic.compare: 支持所有比较运算符', async () => {
  const def = getDefinition('logic.compare')
  const cases = [
    { op: '>', a: 5, b: 3, expected: 1 },
    { op: '>=', a: 5, b: 5, expected: 1 },
    { op: '<', a: 3, b: 5, expected: 1 },
    { op: '<=', a: 5, b: 5, expected: 1 },
    { op: '==', a: 5, b: 5, expected: 1 },
    { op: '!=', a: 5, b: 3, expected: 1 },
  ]
  for (const c of cases) {
    const { outputs } = await def.handler({ inputs: { a: c.a, b: c.b }, params: { op: c.op } })
    assert.equal(outputs.value, c.expected, `op=${c.op} a=${c.a} b=${c.b}`)
  }
})

test('logic.compare: 非法运算符抛错', async () => {
  const def = getDefinition('logic.compare')
  await assert.rejects(
    def.handler({ inputs: { a: 1, b: 2 }, params: { op: 'invalid' } }),
    /比较节点不认识/
  )
})

test('logic.compare: 无 inputs.b 时使用 params.b', async () => {
  const def = getDefinition('logic.compare')
  const { outputs } = await def.handler({ inputs: { a: 5 }, params: { op: '>', b: 3 } })
  assert.equal(outputs.value, 1)
})

//  boolNode — 逻辑门

test('logic.and: 与门', async () => {
  const def = getDefinition('logic.and')
  const r1 = await def.handler({ inputs: { a: 1, b: 1 } })
  const r2 = await def.handler({ inputs: { a: 1, b: 0 } })
  const r3 = await def.handler({ inputs: { a: 0, b: 0 } })
  assert.equal(r1.outputs.value, 1)
  assert.equal(r2.outputs.value, 0)
  assert.equal(r3.outputs.value, 0)
})

test('logic.or: 或门', async () => {
  const def = getDefinition('logic.or')
  const r1 = await def.handler({ inputs: { a: 0, b: 1 } })
  const r2 = await def.handler({ inputs: { a: 0, b: 0 } })
  assert.equal(r1.outputs.value, 1)
  assert.equal(r2.outputs.value, 0)
})

test('logic.not: 非门', async () => {
  const def = getDefinition('logic.not')
  const r1 = await def.handler({ inputs: { a: 1 } })
  const r2 = await def.handler({ inputs: { a: 0 } })
  assert.equal(r1.outputs.value, 0)
  assert.equal(r2.outputs.value, 1)
})

test('logic.xor: 异或门', async () => {
  const def = getDefinition('logic.xor')
  const r1 = await def.handler({ inputs: { a: 1, b: 0 } })
  const r2 = await def.handler({ inputs: { a: 1, b: 1 } })
  assert.equal(r1.outputs.value, 1)
  assert.equal(r2.outputs.value, 0)
})

test('logic.nand: 与非门', async () => {
  const def = getDefinition('logic.nand')
  const r1 = await def.handler({ inputs: { a: 1, b: 1 } })
  const r2 = await def.handler({ inputs: { a: 0, b: 0 } })
  assert.equal(r1.outputs.value, 0)
  assert.equal(r2.outputs.value, 1)
})

test('logic.nor: 或非门', async () => {
  const def = getDefinition('logic.nor')
  const r1 = await def.handler({ inputs: { a: 0, b: 0 } })
  const r2 = await def.handler({ inputs: { a: 1, b: 0 } })
  assert.equal(r1.outputs.value, 1)
  assert.equal(r2.outputs.value, 0)
})

//  logic.switch — 分支合并

test('logic.switch: 条件为真时返回 when_true', async () => {
  const def = getDefinition('logic.switch')
  const { outputs } = await def.handler({ inputs: { condition: 1, when_true: 'A', when_false: 'B' } })
  assert.equal(outputs.value, 'A')
})

test('logic.switch: 条件为假时返回 when_false', async () => {
  const def = getDefinition('logic.switch')
  const { outputs } = await def.handler({ inputs: { condition: 0, when_true: 'A', when_false: 'B' } })
  assert.equal(outputs.value, 'B')
})

//  logic.pause — 暂停门

test('logic.pause: 首次调用返回 suspend', async () => {
  const def = getDefinition('logic.pause')
  const result = await def.handler({ params: { prompt: '继续吗？' }, resumed: undefined })
  assert.equal(result.suspend.kind, 'pause')
  assert.equal(result.suspend.prompt, '继续吗？')
})

test('logic.pause: resumed=true 时返回 1', async () => {
  const def = getDefinition('logic.pause')
  const { outputs } = await def.handler({ params: {}, resumed: true })
  assert.equal(outputs.value, 1)
})

test('logic.pause: resumed=false 时返回 0', async () => {
  const def = getDefinition('logic.pause')
  const { outputs } = await def.handler({ params: {}, resumed: false })
  assert.equal(outputs.value, 0)
})

//  logic.select — 选择门

test('logic.select: 按 indices 选择', async () => {
  const def = getDefinition('logic.select')
  const { outputs } = await def.handler({
    inputs: { candidates: ['a', 'b', 'c'], indices: [0, 2] },
    params: {},
  })
  assert.deepEqual(outputs.selected, ['a', 'c'])
})

test('logic.select: 无线索时返回 suspend', async () => {
  const def = getDefinition('logic.select')
  const result = await def.handler({
    inputs: { candidates: ['a', 'b'] },
    params: { prompt: '挑一个' },
    resumed: undefined,
  })
  assert.equal(result.suspend.kind, 'select')
})

test('logic.select: 越界序号抛错', async () => {
  const def = getDefinition('logic.select')
  await assert.rejects(
    def.handler({ inputs: { candidates: ['a', 'b'], indices: [5] }, params: {} }),
    /select 收到越界序号/
  )
})

test('logic.select: 非法 resumed 抛错', async () => {
  const def = getDefinition('logic.select')
  await assert.rejects(
    def.handler({ inputs: { candidates: ['a'] }, params: {}, resumed: 'not-array' }),
    /select 收到的不是一组序号/
  )
})

//  logic.sleep — 休眠

test('logic.sleep: 返回 done=1', async () => {
  const def = getDefinition('logic.sleep')
  const { outputs } = await def.handler({ params: { ms: 0 }, ctx: { sleep: async () => {} } })
  assert.equal(outputs.done, 1)
})

//  flow.loop_start / flow.loop_end / flow.append

test('flow.loop_start: 返回 loop item 和 index', async () => {
  const def = getDefinition('flow.loop_start')
  const { outputs } = await def.handler({ loop: { item: 'x', index: 3 } })
  assert.equal(outputs.item, 'x')
  assert.equal(outputs.index, 3)
})

test('flow.loop_end: 返回 done=1', async () => {
  const def = getDefinition('flow.loop_end')
  const { outputs } = await def.handler({})
  assert.equal(outputs.done, 1)
})

test('flow.append: 返回空对象', async () => {
  const def = getDefinition('flow.append')
  const { outputs } = await def.handler({})
  assert.deepEqual(outputs, {})
})

//  out.preview — 试听/查看

test('out.preview: 发出 preview 事件', async () => {
  const events = []
  const def = getDefinition('out.preview')
  const { outputs } = await def.handler({
    inputs: { value: 'test data' },
    params: { label: '预览' },
    ctx: { emit: (name, payload) => events.push({ name, payload }) },
    node: { id: 'node1' },
  })
  assert.deepEqual(outputs, {})
  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'preview')
  assert.equal(events[0].payload.node_id, 'node1')
  assert.equal(events[0].payload.value, 'test data')
})

//  out.save — 保存

test('out.save: 保存 bytes 到文件', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'save-'))
  const events = []
  const def = getDefinition('out.save')
  const { outputs } = await def.handler({
    inputs: { value: { bytes: Buffer.from('audio data'), format: 'wav' } },
    params: { dir: tmp, basename: 'test' },
    ctx: { fs, emit: (name, payload) => events.push({ name, payload }) },
    node: { id: 'node1' },
  })
  assert.equal(outputs.saved.length, 1)
  assert.ok(outputs.saved[0].endsWith('.wav'))
  assert.ok(fs.existsSync(outputs.saved[0]))
  fs.unlinkSync(outputs.saved[0])
  fs.rmdirSync(tmp)
})

test('out.save: 无 dir 抛错', async () => {
  const def = getDefinition('out.save')
  await assert.rejects(
    def.handler({ inputs: { value: {} }, params: { dir: null }, ctx: { fs } }),
    /保存节点不知道要存到哪个文件夹/
  )
})

//  sys.release — 释放

test('sys.release: 调用 releaseUpstream 并发出事件', async () => {
  const events = []
  const freed = []
  const def = getDefinition('sys.release')
  const { outputs } = await def.handler({
    inputs: {},
    params: { release_vram: false },
    ctx: {
      releaseUpstream: (nodeId) => { freed.push(nodeId); return 2 },
      emit: (name, payload) => events.push({ name, payload }),
    },
    node: { id: 'node1' },
  })
  assert.deepEqual(outputs, {})
  assert.deepEqual(freed, ['node1'])
  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'released')
})

//  tts.synthesize — 合成节点

test('tts.synthesize: 无 ctx.synthesize 抛错', async () => {
  const def = getDefinition('tts.synthesize')
  await assert.rejects(
    def.handler({ inputs: { text: 'hello' }, params: {}, ctx: {} }),
    /未连接合成服务/
  )
})

test('tts.synthesize: 正常调用返回音频', async () => {
  const def = getDefinition('tts.synthesize')
  const fakeAudio = { bytes: Buffer.from('audio'), format: 'wav' }
  const { outputs } = await def.handler({
    inputs: { text: 'hello' },
    params: { format: 'wav' },
    ctx: { synthesize: async () => fakeAudio },
  })
  assert.deepEqual(outputs.audio, fakeAudio)
})

//  audio.concat — 拼接节点

test('audio.concat: 无 ctx.concatAudio 抛错', async () => {
  const def = getDefinition('audio.concat')
  await assert.rejects(
    def.handler({ inputs: { audios: [] }, params: {}, ctx: {} }),
    /没有接上拼接服务/
  )
})
