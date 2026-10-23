'use strict'

// 内置节点的注册表：每一类节点一个 define() 调用，handler 是节点的执行体。
// 覆盖输入类（文字 / 参考音频 / 引擎 / 引擎参数 / 数值 / 布尔 / 种子）、处理类（拆句 / 合成 / 拼接）、
// 逻辑类（暂停 / 挑选 / 比较 / 布尔运算 / 条件二选一 / 延时）、循环类与落地类（预览 / 保存 / 保存为音色 / 释放）。
// 质量测量与阈值判定那一族在 qualityNodes.js 里注册，同样走 registry 的 define()。
// 端口类型与类别名决定画布上的接线规则与分组，节点的文案在 docs.js 里。

const fs = require('node:fs')
const path = require('node:path')

const { define, port } = require('./registry')

function nodeError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// 输入类：往流程里放值的节点。

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
    // 文件在运行时检查：路径可能已被移动或锁定，报错要点名是哪个文件、
    // 以及它本该在那里，这样用户才知道是环境变了而不是填错了。
    if (!ctx.fs.existsSync(p)) {
      throw nodeError('FG_REF_AUDIO_NOT_FOUND', `参考音频文件不存在：${p}（运行前该文件仍可访问，请检查是否被移动或重命名）`, { path: p })
    }
    return { outputs: { audio: { kind: 'reference_audio', path: p } } }
  },
})

define({
  type: 'io.engine',
  category: 'load',
  label: '引擎',
  outputs: { engine: port('Engine') },
  // 默认值不写死成某台引擎：lib/ 里不许出现引擎名。
  // null 表示「还没选」，不是「用某台默认引擎」：带着空 engine_id 走到合成会抛
  // FG_ENGINE_ID_MISSING（adapter.js）。默认值留 null 而不在这里就抛，是因为
  // 一个 io.engine 节点未必通向合成（engine.node.test.js 里有一张只拿它喂
  // sys.release 的图）：关卡设在真正要挑引擎的那一层，不设在拿着它的每个人身上。
  // 下拉框里有哪些引擎，开画布时按 engines/ 下装了什么现算（service.js）。
  params: { engine_id: null, voice: null, base_url: null },
  handler: async ({ params }) => ({
    outputs: {
      engine: {
        engine_id: params.engine_id || null,
        // 音色属于「用哪台引擎、怎么配」的一部分，一并带出来，
        // 适配器就不必另外去查。
        voice: params.voice || null,
        base_url: params.base_url || null,
      },
    },
  }),
})

// 合成节点的 engine_params 输入由它提供。引擎专属设置全部走这个端口，
// 合成节点本身不认识任何一台具体引擎。
//
// 这张表是空的：格子按本机 engines/*/manifest.json 的 param_keys 现算
// （service.js 的 describeDefinition），所以加一台引擎只需写一张名片，
// 画布上自动长出对应的格子，lib/ 一个字不改。
//
// 空表是安全的：engine.js 用 Object.assign({}, def.params, node.params) 合并，
// 已存盘的老图把自己的参数原样带着走，不依赖这里列过它。
// 留空的项由 handler 丢掉而不是发成 null：适配器只转发它认识的键，
// 一个没人要的 null 仍然是请求里的噪音。
define({
  type: 'io.engine_params',
  category: 'load',
  label: '引擎参数',
  outputs: { params: port('EngineParams') },
  params: {},
  dynamic_params: 'engine_union',
  handler: async ({ params }) => {
    const out = {}
    for (const [key, value] of Object.entries(params || {})) {
      if (value === null || value === undefined || value === '') continue
      out[key] = value
    }
    return { outputs: { params: out } }
  },
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

// 处理类：把一种值加工成另一种值的节点。

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
      throw nodeError('FG_SYNTHESIZE_UNAVAILABLE', '未连接合成服务，合成节点无法执行')
    }
    // 合成节点不认识是哪台引擎，引擎相关的全部信息都在 engine 与 engine_params 里，
    // 这样换一台引擎不需要改合成节点。
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

// 逻辑类：条件判断、闸门与分支合流。

// pause 是闸门：只决定流程是否继续，不携带数据。答复由谁给（人、定时器、阈值节点）
// 不是引擎关心的事，引擎只知道这个节点在等一个值。
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

// select 是分叉：决定哪些条目继续往下走。它要搬运数据，因此不是 pause 的特例。
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
    // 上游节点已给出要哪几项时，按机器给出的序号选。
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

// switch 让分支汇回主线：按条件在两个值里选一个输出。
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

// 循环类：重复执行一段流程。重复本身由引擎调度（engine.js），这里的 handler 只负责
// 每一轮的值。

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
  // body 口收多条线是常态：一次循环同时收集两样东西（音频片段与它的分数）很常见，
  // 两个累加器都得挂在循环结束上，否则它们落在循环体之外。
  inputs: { body: port('Any', { required: false, multiple: true }) },
  outputs: { done: port('Boolean') },
  params: { loop: null },
  control: 'loop_end',
  handler: async () => ({ outputs: { done: 1 } }),
})

// 累加：循环的价值所在，没有它第十轮会覆盖第九轮，只剩一个结果。
define({
  type: 'flow.append',
  category: 'loop',
  label: '累加',
  inputs: { value: port('Any') },
  outputs: { list: port('Any') },
  control: 'append',
  handler: async () => ({ outputs: {} }),
})

// 落地类：预览、写入磁盘、保存为音色与释放。

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

// 画布与 broker 音色表之间有意义的那一个方向：一次运行产出了值得留下的结果，
// 于是把产生它的设置写回成一条音色。音色从不绑在流程图上，它进来说是预设，
// 出来说是保存下来的结果。
define({
  type: 'out.save_voice',
  category: 'sink',
  label: '保存为音色',
  inputs: { recipe: port('Recipe') },
  outputs: { voice_id: port('Text') },
  params: { voice_id: null, display_name: null, language: 'auto', overwrite: false },
  handler: async ({ inputs, params, ctx, node }) => {
    if (typeof ctx.saveVoice !== 'function') {
      throw nodeError('FG_VOICE_STORE_UNAVAILABLE', '本机未提供音色存储，无法保存为音色')
    }
    const id = String(params.voice_id || '').trim()
    if (!id) throw nodeError('FG_VOICE_NO_ID', '保存为音色节点未填写音色 ID')

    // 配方可能单独来，也可能是一组：上游节点读到的音频输入里是什么就是什么。
    // 只保存第一条是唯一站得住的选择：多条配方就是多个不同的音色。
    const items = Array.isArray(inputs.recipe) ? inputs.recipe : [inputs.recipe]
    const recipe = items[0]
    if (!recipe || typeof recipe !== 'object') {
      throw nodeError('FG_VOICE_NO_RECIPE', '输入的配方为空，无法保存为音色')
    }
    if (items.length > 1) {
      ctx.emit('note', {
        node_id: node.id,
        message: `收到 ${items.length} 条配方，仅使用第 1 条保存为音色 ${id}`,
      })
    }

    const result = await ctx.saveVoice({
      id,
      display_name: params.display_name || id,
      language: params.language || 'auto',
      overwrite: params.overwrite === true,
      reference_audio: recipe.reference_audio || '',
      params: recipe.params || {},
    })
    ctx.emit('voice_saved', { node_id: node.id, voice_id: result.id, voice: result.voice || null })
    return { outputs: { voice_id: result.id } }
  },
})

// 一条支线的显式终点：内存只在这里归还，没有默认的自动释放。
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
