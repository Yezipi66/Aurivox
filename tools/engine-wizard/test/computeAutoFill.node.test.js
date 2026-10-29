'use strict'
// computeAutoFill 的行为测试：覆盖槽位匹配、kind 判定与 args 写法三件事。
// computeAutoFill 不抛异常，填错的名片要等平台保存时才被拒，所以只能靠测试守住。
// 被测代码是 tools/engine-wizard/editor/scanAutofill.js 里的那份实现，
// 用项目 Vite 依赖的同一个 esbuild 编译成 CJS 后取其导出，不在此处重抄。
// 它是纯函数文件，不 import react 与任何组件。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const SOURCE = path.join(EDITOR_DIR, 'scanAutofill.js')

/**
 * 加载 scanAutofill.js 里的 computeAutoFill。
 * @returns {Function|null} 拿不到编译依赖时返回 null，由守卫用例报错，不静默跳过。
 */
function loadComputeAutoFill () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  if (!esbuild) {
    // 拿不到编译依赖就返回 null，由下面的守卫用例报错，不静默跳过。
    return null
  }
  const src = fs.readFileSync(SOURCE, 'utf8')
  const code = esbuild.transformSync(src, {
    loader: 'js',
    format: 'cjs',
    target: 'node18',
  }).code
  const mod = { exports: {} }
  const stub = (id) => {
    throw new Error('computeAutoFill 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  run(mod.exports, stub, mod, SOURCE, EDITOR_DIR)
  return mod.exports.computeAutoFill
}

const computeAutoFill = loadComputeAutoFill()

// 夹具：/wizard/discover 的返回，形状取自 paramDigest 的统一层。
//   cli 路    name 是命令行开关去掉横线的部分，target 是开关本身，
//             style 是名片 args 段认的写法词，kind 是界面显示的类型名。
//   python 路 name 与 target 同名，都是上游方法的参数名。
const cliParams = [
  { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value', help: null, required: true, group: 'infer', is_tool: false },
  { source: 'cli', name: 'voice', target: '--voice', kind: 'str', style: 'value', help: null, required: false, group: 'infer', is_tool: false },
  { source: 'cli', name: 'output', target: '--output', kind: 'str', style: 'value', help: null, required: true, group: 'infer', is_tool: false },
]

const pythonParams = [
  { source: 'python', name: 'tts_text', target: 'tts_text', kind: 'str', help: null, required: true, group: 'call', is_tool: false },
  { source: 'python', name: 'ref_audio', target: 'ref_audio', kind: 'str', help: null, required: true, group: 'call', is_tool: false },
  { source: 'python', name: 'save_path', target: 'save_path', kind: 'str', help: null, required: true, group: 'call', is_tool: false },
]

const mixedParams = [...cliParams, ...pythonParams]

test('守卫：这份测试真的拿到了活代码里的那个纯函数', () => {
  assert.equal(typeof computeAutoFill, 'function',
    '没拿到 computeAutoFill。缺 esbuild 依赖时这一条会红，'
    + '那是环境问题，不要连同下面那些一起跳过。')
})

// 槽位匹配：候选名对的是 name，写进 bind 的必须是 target。
test('cli 参数：按 dest 名认槽位，认出来的是命令行开关', () => {
  const r = computeAutoFill(cliParams, { kind: 'cli' })
  assert.deepStrictEqual(r.matched, {
    text: '--text',
    ref_audio: '--voice',
    output_path: '--output',
  }, '槽位没认出：候选名不带横线，填进 bind 的必须是带横线的开关')
  assert.deepStrictEqual(r.call.bind, {
    text: '--text',
    ref_audio: '--voice',
    output_path: '--output',
  })
})

test('python 参数：按参数名认槽位，填进 bind 的就是那个参数名', () => {
  const r = computeAutoFill(pythonParams, { kind: 'python', module: 'm', class: 'C' })
  assert.deepStrictEqual(r.matched, {
    text: 'tts_text',
    ref_audio: 'ref_audio',
    output_path: 'save_path',
  })
  assert.deepStrictEqual(r.call.bind, {
    text: 'tts_text',
    ref_audio: 'ref_audio',
    output_path: 'save_path',
  })
})

test('两条路混在一张表里：两个来源各自的候选名都要认得出', () => {
  const r = computeAutoFill(mixedParams, { kind: 'cli' })
  // --text 与 --voice 先被认走；save_path 这种 python 参数名也要认得出
  assert.equal(r.matched.text, '--text')
  assert.equal(r.matched.ref_audio, '--voice')
  assert.equal(r.matched.output_path, '--output')
  // python 侧的候选名同样要能认：换一个只有 python 路才有的名字
  const onlyPy = computeAutoFill(
    pythonParams.concat([{ source: 'cli', name: 'unrelated', target: '--unrelated', kind: 'boolean', help: null, required: false, group: 'infer', is_tool: false }]),
    { kind: 'cli' })
  assert.equal(onlyPy.matched.output_path, 'save_path',
    'python 路参数名的候选没被认出来')
})

// call.kind：来源混在一起时保持名片原来的 kind。
test('python 名片 + 混有 cli 参数：kind 保持 python 不被改写', () => {
  const r = computeAutoFill(mixedParams, { kind: 'python', module: 'm', class: 'C' })
  assert.equal(r.call.kind, 'python',
    '探测是同时扫两条路并合并成一张表的，有 cli 参数不等于这台引擎是 cli 形态。'
    + 'kind 被改写成 cli 之后，python 的参数名会被平台的槽位规则拒掉。')
})

test('纯 cli 参数：kind 才置成 cli', () => {
  const r = computeAutoFill(cliParams, { kind: 'python', module: 'm', class: 'C' })
  assert.equal(r.call.kind, 'cli')
})

test('纯 python 参数：kind 置成 python', () => {
  const r = computeAutoFill(pythonParams, {})
  assert.equal(r.call.kind, 'python')
})

test('两种来源都在时，如实报出需要人工确认', () => {
  const r = computeAutoFill(mixedParams, { kind: 'python' })
  const notes = r.notes || []
  assert.ok(notes.length > 0,
    '两种来源混在一张表里，平台替名片做决定，就要把这件事报给用户而不是默默填')
  // 每条都要带两种语言：这几句会显示在界面上，纯函数手上没有翻译表
  for (const n of notes) {
    assert.ok(n.en && n.zh, '说明没带齐两种语言，组件没法按当前语言取')
  }
  assert.match(notes.map((n) => n.zh).join('\n'), /kind|来源|确认/,
    '这条说明要让用户知道是来源混在一起了')
})

test('只有一种来源时不报这条说明', () => {
  assert.deepStrictEqual(computeAutoFill(cliParams, { kind: 'cli' }).notes, [])
  assert.deepStrictEqual(computeAutoFill(pythonParams, { kind: 'python' }).notes, [])
})

test('同名参数在两种来源里指向不同值时，如实报出来而不是挑一个', () => {
  const r = computeAutoFill(
    [cliParams[0],
      { source: 'python', name: 'text', target: 'text', kind: 'str', help: null, required: true, group: 'call', is_tool: false }],
    { kind: 'python' })
  assert.equal(r.matched.text, '--text', '按先出现的那个填')
  assert.match(r.notes.map((n) => n.zh).join('\n'), /同名/,
    '同一个名字在两种来源里指向不同的值，这件事要报给用户')
})

// args 段：python 名片不该长出 args。
test('纯 python 参数：不写 args 段', () => {
  const r = computeAutoFill(pythonParams, { kind: 'python', module: 'm', class: 'C' })
  assert.equal(r.call.args, undefined,
    'kind="python" 下 args 不是认得的键，写进去名片存不下来')
})

test('python 名片 + 混有 cli 参数：args 里只准有 cli 来源的参数', () => {
  const r = computeAutoFill(mixedParams, { kind: 'python', module: 'm', class: 'C' })
  const keys = Object.keys(r.call.args || {})
  assert.deepStrictEqual(keys.filter((k) => !cliParams.some((p) => p.name === k)), [],
    'python 来源的参数名被写进了 call.args')
})

test('cli 名片 + 混有 python 参数：args 里仍只准有 cli 来源的参数', () => {
  // 这条是按 source 分流的判据：名片是 cli 形态（于是 args 段会走），
  // 这一组参数里却混着 python 参数。少了 source 判断，python 的参数名会带着
  // flag 键进 args 段，而那是一条上游不认识的命令行开关。
  const r = computeAutoFill(mixedParams, { kind: 'cli' })
  assert.deepStrictEqual(Object.keys(r.call.args || {}).sort(),
    ['output', 'text', 'voice'],
    'python 来源的参数名被写进了 cli 名片的 args 段')
  for (const [name, entry] of Object.entries(r.call.args || {})) {
    assert.ok(String(entry.flag).startsWith('-'),
      `call.args.${name}.flag 是 "${entry.flag}"，不是命令行开关`)
  }
})

test('纯 cli 参数：args 里是 dest 名到开关的映射，且 style 是宿主认得的词', () => {
  const r = computeAutoFill(cliParams, { kind: 'cli' })
  assert.deepStrictEqual(r.call.args, {
    text: { flag: '--text', style: 'value' },
    voice: { flag: '--voice', style: 'value' },
    output: { flag: '--output', style: 'value' },
  }, 'args 段写的是名片形状，style 必须是宿主认得的那几个词之一')
})

test('args 里的 style 必须是宿主认得的词（统一层的类型名不是 style）', () => {
  // 统一层把类型归成 str / boolean / array，宿主的 args 段认的是
  // value / boolean / repeat，两张表不是一个。
  const { ARG_STYLES } = require(path.join(__dirname, '..', '..', '..', 'lib', 'engines', 'hostProfile'))
  const r = computeAutoFill(cliParams, { kind: 'cli' })
  for (const [name, entry] of Object.entries(r.call.args || {})) {
    assert.ok(ARG_STYLES.includes(entry.style),
      `call.args.${name}.style 写的是 "${entry.style}"`
      + `，宿主只认：${ARG_STYLES.join(' / ')}`)
  }
})

// 用户手填的值不被扫描结果覆盖。
test('用户已手填的 bind 不被扫描结果覆盖', () => {
  const r = computeAutoFill(cliParams, {
    kind: 'cli',
    bind: { text: '--tts-text' },
  })
  assert.equal(r.call.bind.text, '--tts-text',
    '手填的值被扫描猜的盖掉了')
  // 另外两个槽位空着，仍然要填
  assert.equal(r.call.bind.ref_audio, '--voice')
  assert.equal(r.call.bind.output_path, '--output')
})

test('用户已手填的 args 不被扫描结果覆盖', () => {
  const r = computeAutoFill(cliParams, {
    kind: 'cli',
    args: { text: { flag: '--tts-text', style: 'value' } },
  })
  assert.equal(r.call.args.text.flag, '--tts-text')
  assert.equal(r.call.args.voice.flag, '--voice')
})

// 没有参数就没有建议。
test('参数为空/null/空数组：返回 null', () => {
  assert.equal(computeAutoFill([], { kind: 'cli' }), null)
  assert.equal(computeAutoFill(null, { kind: 'cli' }), null)
  assert.equal(computeAutoFill(undefined, { kind: 'cli' }), null)
})

test('认不出槽位时 matched 是空值，不许瞎猜一个', () => {
  const r = computeAutoFill(
    [{ source: 'cli', name: 'speed', target: '--speed', kind: 'number', help: null, required: false, group: 'infer', is_tool: false }],
    { kind: 'cli' })
  assert.deepStrictEqual(r.matched, { text: null, ref_audio: null, output_path: null })
})

test('不改传进来的名片：入参不被就地改写', () => {
  const card = { kind: 'python', module: 'm', class: 'C', bind: {} }
  const snapshot = JSON.stringify(card)
  computeAutoFill(mixedParams, card)
  assert.equal(JSON.stringify(card), snapshot, 'computeAutoFill 就地改了入参')
})
test('prompt_text 是参考文本，不许被认成合成文本', () => {
  const r = computeAutoFill([
    { source: 'cli', name: 'prompt_text', target: '--prompt-text', kind: 'str', style: 'value', help: null, required: false, group: 'infer', is_tool: false },
    { source: 'cli', name: 'output', target: '--output', kind: 'str', style: 'value', help: null, required: true, group: 'infer', is_tool: false },
  ], { kind: 'cli' })
  assert.equal(r.matched.text, null)
  assert.equal(r.call.bind.text, undefined)
})
