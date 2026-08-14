'use strict'

// ---------------------------------------------------------------------------
//  Built-in nodes — backend v1
// ---------------------------------------------------------------------------
// This is the "一小把能真跑的节点" agreed for the first backend slice:
// 文字 / 参考音 / 引擎 / 合成 / pause / 比较 / select / 累加 / 保存 / 释放,
// plus the logic and loop nodes those need to be useful.
//
// Deliberately NOT here yet: the measurement family and the threshold family.
// They are next, and they plug in through this same `define()` call — which is
// the point of doing the backend first.

const fs = require('node:fs')
const path = require('node:path')

const { define, port } = require('./registry')

function nodeError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// ---------------------------------------------------------------------------
//  载入类 — sources
// ---------------------------------------------------------------------------

define({
  type: 'io.text',
  category: 'load',
  label: '文字',
  outputs: { text: port('Text') },
  params: { text: '' },
  handler: async ({ params }) => {
    if (typeof params.text !== 'string') {
      throw nodeError('FG_TEXT_PARAM_MISSING', '文字节点没有填内容')
    }
    return { outputs: { text: params.text } }
  },
})

define({
  type: 'io.reference_audio',
  category: 'load',
  label: '参考音频',
  outputs: { audio: port('ReferenceAudio') },
  params: { path: '' },
  handler: async ({ params, ctx }) => {
    const p = params.path
    if (!p) throw nodeError('FG_REF_AUDIO_PATH_MISSING', '参考音频节点没有选文件')
    // The file is checked at run time on purpose: the user's own ruling is that
    // failures here are almost always "运行环境被人改了" (file moved, locked).
    // Saying which file, and that it was expected to be there, is the whole
    // point of the message.
    if (!ctx.fs.existsSync(p)) {
      throw nodeError('FG_REF_AUDIO_NOT_FOUND', `参考音频找不到了：${p}（跑之前它还在，检查是不是被移动或改名了）`, { path: p })
    }
    return { outputs: { audio: { kind: 'reference_audio', path: p } } }
  },
})

define({
  type: 'io.engine',
  category: 'load',
  label: '引擎',
  outputs: { engine: port('Engine') },
  params: { engine_id: 'gpt-sovits', base_url: null },
  handler: async ({ params }) => ({
    outputs: {
      engine: {
        engine_id: params.engine_id || 'gpt-sovits',
        base_url: params.base_url || null,
      },
    },
  }),
})

define({
  type: 'io.number',
  category: 'load',
  label: '数字',
  outputs: { value: port('Number') },
  params: { value: 0 },
  handler: async ({ params }) => ({ outputs: { value: Number(params.value) } }),
})

define({
  type: 'io.boolean',
  category: 'load',
  label: '开关',
  outputs: { value: port('Boolean') },
  params: { value: true },
  handler: async ({ params }) => ({ outputs: { value: params.value ? 1 : 0 } }),
})

define({
  type: 'io.seed',
  category: 'load',
  label: '种子',
  outputs: { seed: port('Number') },
  params: { seed: -1 },
  handler: async ({ params }) => ({ outputs: { seed: Number(params.seed) } }),
})

// ---------------------------------------------------------------------------
//  处理类 — work
// ---------------------------------------------------------------------------

define({
  type: 'text.split',
  category: 'process',
  label: '拆句',
  inputs: { text: port('Text') },
  outputs: { lines: port('TextList') },
  params: { max_chars: 60 },
  handler: async ({ inputs, params }) => {
    const max = Number(params.max_chars) > 0 ? Number(params.max_chars) : 60
    const pieces = String(inputs.text)
      .split(/(?<=[。．.!?！？\n])/)
      .map(s => s.trim())
      .filter(Boolean)
    const lines = []
    for (const piece of pieces) {
      if (piece.length <= max) { lines.push(piece); continue }
      for (let i = 0; i < piece.length; i += max) lines.push(piece.slice(i, i + max))
    }
    return { outputs: { lines: lines.length ? lines : [String(inputs.text)] } }
  },
})

define({
  type: 'tts.synthesize',
  category: 'process',
  label: '合成',
  inputs: {
    text: port('Text'),
    engine: port('Engine'),
    reference_audio: port('ReferenceAudio', { required: false }),
    seed: port('Number', { required: false }),
    engine_params: port('EngineParams', { required: false }),
  },
  outputs: { audio: port('Audio') },
  params: { format: 'wav' },
  handler: async ({ inputs, params, ctx }) => {
    if (typeof ctx.synthesize !== 'function') {
      throw nodeError('FG_SYNTHESIZE_UNAVAILABLE', '没有接上合成服务，合成节点跑不了')
    }
    // The synthesis node knows nothing about which engine this is. Everything
    // engine-specific travels inside `engine` and `engine_params`, which is what
    // makes "GPT-SoVITS 是起点而不是终点" mechanically true rather than a slogan.
    const audio = await ctx.synthesize({
      text: inputs.text,
      engine: inputs.engine,
      reference_audio: inputs.reference_audio || null,
      seed: inputs.seed === undefined ? null : inputs.seed,
      engine_params: inputs.engine_params || {},
      format: params.format || 'wav',
    })
    if (!audio || typeof audio !== 'object') {
      throw nodeError('FG_SYNTHESIZE_BAD_RESULT', '合成服务没有返回音频')
    }
    return { outputs: { audio } }
  },
})

define({
  type: 'audio.concat',
  category: 'process',
  label: '拼接',
  inputs: { audios: port('AudioList') },
  outputs: { audio: port('Audio') },
  params: { silence_ms: 0 },
  handler: async ({ inputs, params, ctx }) => {
    if (typeof ctx.concatAudio !== 'function') {
      throw nodeError('FG_CONCAT_UNAVAILABLE', '没有接上拼接服务')
    }
    const audio = await ctx.concatAudio(inputs.audios, { silence_ms: Number(params.silence_ms) || 0 })
    return { outputs: { audio } }
  },
})

// ---------------------------------------------------------------------------
//  逻辑类 — logic
// ---------------------------------------------------------------------------

// pause is a GATE: it decides whether the pipeline keeps going. It carries no
// data. Whoever supplies the answer (a person, a timer, a threshold) is not the
// engine's business — the engine only knows the node is waiting for a value.
define({
  type: 'logic.pause',
  category: 'logic',
  label: 'pause',
  outputs: { value: port('Boolean') },
  params: { prompt: '继续吗？' },
  suspends: true,
  handler: async ({ params, resumed }) => {
    if (resumed === undefined) {
      return { suspend: { kind: 'pause', prompt: params.prompt || '继续吗？', expects: 'boolean' } }
    }
    return { outputs: { value: resumed ? 1 : 0 } }
  },
})

// select is a FORK: it decides which items travel on. It moves data, which is
// exactly why it is not a special case of pause.
define({
  type: 'logic.select',
  category: 'logic',
  label: 'select',
  inputs: {
    candidates: port('Any'),
    indices: port('IndexList', { required: false }),
  },
  outputs: { selected: port('Any') },
  params: { prompt: '挑出要继续往下走的' },
  suspends: true,
  handler: async ({ inputs, params, resumed }) => {
    const list = Array.isArray(inputs.candidates) ? inputs.candidates : [inputs.candidates]
    // Machine-driven selection: an upstream node already said which ones.
    if (Array.isArray(inputs.indices)) {
      return { outputs: { selected: pick(list, inputs.indices) } }
    }
    if (resumed === undefined) {
      return {
        suspend: {
          kind: 'select',
          prompt: params.prompt,
          expects: 'index_list',
          count: list.length,
          candidates: list,
        },
      }
    }
    if (!Array.isArray(resumed)) {
      throw nodeError('FG_SELECT_BAD_ANSWER', 'select 收到的不是一组序号')
    }
    return { outputs: { selected: pick(list, resumed) } }
  },
})

function pick(list, indices) {
  return indices.map(i => {
    const index = Number(i)
    if (!Number.isInteger(index) || index < 0 || index >= list.length) {
      throw nodeError('FG_SELECT_INDEX_OUT_OF_RANGE', `select 收到越界序号 ${i}（一共 ${list.length} 个）`, { index: i, count: list.length })
    }
    return list[index]
  })
}

const COMPARATORS = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
}

define({
  type: 'logic.compare',
  category: 'logic',
  label: '比较',
  inputs: { a: port('Number'), b: port('Number', { required: false }) },
  outputs: { value: port('Boolean') },
  params: { op: '>', b: null },
  handler: async ({ inputs, params }) => {
    const fn = COMPARATORS[params.op]
    if (!fn) throw nodeError('FG_COMPARE_BAD_OP', `比较节点不认识 '${params.op}' 这个比法`, { op: params.op })
    const right = inputs.b === undefined ? Number(params.b) : Number(inputs.b)
    return { outputs: { value: fn(Number(inputs.a), right) ? 1 : 0 } }
  },
})

function boolNode(type, label, fn, arity) {
  const inputs = { a: port('Boolean') }
  if (arity === 2) inputs.b = port('Boolean')
  define({
    type,
    category: 'logic',
    label,
    inputs,
    outputs: { value: port('Boolean') },
    handler: async ({ inputs: got }) => ({
      outputs: { value: fn(got.a ? 1 : 0, got.b ? 1 : 0) ? 1 : 0 },
    }),
  })
}

boolNode('logic.and', '与', (a, b) => a && b, 2)
boolNode('logic.or', '或', (a, b) => a || b, 2)
boolNode('logic.not', '非', a => !a, 1)
boolNode('logic.xor', '异或', (a, b) => (a ? 1 : 0) !== (b ? 1 : 0), 2)
boolNode('logic.xnor', '同或', (a, b) => (a ? 1 : 0) === (b ? 1 : 0), 2)
boolNode('logic.nand', '与非', (a, b) => !(a && b), 2)
boolNode('logic.nor', '或非', (a, b) => !(a || b), 2)

// switch is how a branch comes back to the main line — the "不要写长分支，
// 工作流类似流水线，一般要合并到一起" rule made mechanical.
define({
  type: 'logic.switch',
  category: 'logic',
  label: 'switch',
  inputs: {
    condition: port('Boolean'),
    when_true: port('Any', { required: false }),
    when_false: port('Any', { required: false }),
  },
  outputs: { value: port('Any') },
  handler: async ({ inputs }) => ({
    outputs: { value: inputs.condition ? inputs.when_true : inputs.when_false },
  }),
})

define({
  type: 'logic.sleep',
  category: 'logic',
  label: 'sleep',
  inputs: { trigger: port('Any', { required: false }) },
  outputs: { done: port('Boolean') },
  params: { ms: 0 },
  handler: async ({ params, ctx }) => {
    const ms = Number(params.ms) || 0
    if (ms > 0) await ctx.sleep(ms)
    return { outputs: { done: 1 } }
  },
})

// ---------------------------------------------------------------------------
//  循环 — loop
// ---------------------------------------------------------------------------
// Handled structurally by the engine (see engine.js). The handlers here only
// shape the per-iteration values; the repetition itself is scheduling work.

define({
  type: 'flow.loop_start',
  category: 'loop',
  label: '循环开始',
  inputs: { list: port('Any', { required: false }) },
  outputs: { item: port('Any'), index: port('Number') },
  params: { times: null },
  control: 'loop_start',
  handler: async ({ loop }) => ({
    outputs: { item: loop.item, index: loop.index },
  }),
})

define({
  type: 'flow.loop_end',
  category: 'loop',
  label: '循环结束',
  inputs: { body: port('Any', { required: false }) },
  outputs: { done: port('Boolean') },
  params: { loop: null },
  control: 'loop_end',
  handler: async () => ({ outputs: { done: 1 } }),
})

// append is the reason a loop is worth anything: without it the tenth pass
// overwrites the ninth and only one result survives.
define({
  type: 'flow.append',
  category: 'loop',
  label: '累加',
  inputs: { value: port('Any') },
  outputs: { list: port('Any') },
  control: 'append',
  handler: async () => ({ outputs: {} }),
})

// ---------------------------------------------------------------------------
//  展示 / 落地类 — sinks
// ---------------------------------------------------------------------------

define({
  type: 'out.preview',
  category: 'sink',
  label: '试听 / 查看',
  inputs: { value: port('Any') },
  outputs: {},
  params: { label: '' },
  handler: async ({ inputs, params, ctx, node }) => {
    ctx.emit('preview', { node_id: node.id, label: params.label || '', value: inputs.value })
    return { outputs: {} }
  },
})

define({
  type: 'out.save',
  category: 'sink',
  label: '保存',
  inputs: { value: port('Any') },
  outputs: { saved: port('Any') },
  params: { dir: null, basename: 'flow' },
  handler: async ({ inputs, params, ctx, node }) => {
    const dir = params.dir || ctx.outputDir
    if (!dir) throw nodeError('FG_SAVE_NO_DIR', '保存节点不知道要存到哪个文件夹')
    ctx.fs.mkdirSync(dir, { recursive: true })
    const items = Array.isArray(inputs.value) ? inputs.value : [inputs.value]
    const saved = []
    items.forEach((item, i) => {
      const suffix = items.length > 1 ? `_${String(i + 1).padStart(3, '0')}` : ''
      const base = `${params.basename || 'flow'}${suffix}`
      if (item && item.bytes) {
        const target = path.join(dir, `${base}.${item.format || 'wav'}`)
        ctx.fs.writeFileSync(target, Buffer.from(item.bytes))
        saved.push(target)
      } else if (item && item.path && ctx.fs.existsSync(item.path)) {
        const target = path.join(dir, `${base}${path.extname(item.path)}`)
        ctx.fs.copyFileSync(item.path, target)
        saved.push(target)
      } else {
        const target = path.join(dir, `${base}.json`)
        ctx.fs.writeFileSync(target, JSON.stringify(item, null, 2))
        saved.push(target)
      }
    })
    ctx.emit('saved', { node_id: node.id, files: saved })
    return { outputs: { saved } }
  },
})

// The explicit end of a line. "不接默认还是存内存的" — so a branch that is
// genuinely finished says so here, and only here does memory go back.
define({
  type: 'sys.release',
  category: 'sink',
  label: '释放（内存 / 显存）',
  inputs: { value: port('Any', { multiple: true }) },
  outputs: {},
  params: { release_vram: false },
  handler: async ({ ctx, node, params, incoming }) => {
    const freed = ctx.releaseUpstream(node.id, incoming)
    if (params.release_vram && typeof ctx.releaseVram === 'function') await ctx.releaseVram()
    ctx.emit('released', { node_id: node.id, freed })
    return { outputs: {} }
  },
})

module.exports = { fsDefault: fs }
