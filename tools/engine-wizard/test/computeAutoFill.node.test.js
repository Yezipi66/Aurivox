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
    ref_text: null,
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
    ref_text: null,
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
  assert.deepStrictEqual(r.matched, { text: null, ref_audio: null, ref_text: null, output_path: null })
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

// 参考文本：可选槽位，扫描尽量认，认不出就空着。
test('参考文本：候选名认得出就填进 bind.ref_text，cli 写开关、python 写参数名', () => {
  const cases = [
    ['prompt_text', '--prompt_text', 'cli'],
    ['ref_text', '--ref_text', 'cli'],
    ['prompt-text', '--prompt-text', 'cli'],
    ['reference_text', 'reference_text', 'python'],
    ['ref-text', '--ref-text', 'cli'],
  ]
  for (const [name, target, source] of cases) {
    const r = computeAutoFill([
      { source, name: 'text', target: source === 'cli' ? '--text' : 'text', kind: 'str', help: null, required: true, group: 'infer', is_tool: false },
      { source, name, target, kind: 'str', help: null, required: false, group: 'infer', is_tool: false },
    ], {})
    assert.equal(r.matched.ref_text, target, `${name} 没被认成参考文本`)
    assert.equal(r.call.bind.ref_text, target)
    assert.notEqual(r.matched.text, target, `${name} 被认成了合成文本`)
  }
})

test('参考文本：认不出不瞎猜，bind 里也不出现 ref_text', () => {
  const r = computeAutoFill(cliParams, { kind: 'cli' })
  assert.equal(r.matched.ref_text, null)
  assert.ok(!('ref_text' in r.call.bind))
})

test('参考文本：名片里已经绑了的不被扫描覆盖', () => {
  const r = computeAutoFill([
    { source: 'cli', name: 'prompt_text', target: '--prompt_text', kind: 'str', help: null, required: false, group: 'infer', is_tool: false },
  ], { kind: 'cli', bind: { ref_text: '--transcript' } })
  assert.equal(r.call.bind.ref_text, '--transcript')
})

// ---- bind 槽位候选 ----
// 反射器为了让「同一概念不声明两次」，按 BIND_SLOTS 把 text / output_path 这些名字
// 从 parameters[] 里剔掉；而认槽位靠的就是名字，剔了等于把要找的名字先删了，
// output_path 于是永远填不出来（表现为「名片里那一格始终空着，且不报错」）。
// 候选由第三个参数单独递进来：只用于认槽位，不进 parameters[]。

test('bind 候选：output_path 从候选里认出来并写进 call.bind', () => {
  const r = computeAutoFill([
    { source: 'python', name: 'spk_audio_prompt', target: 'spk_audio_prompt', kind: 'str', help: null, required: true, group: 'infer', is_tool: false },
  ], { kind: 'python' }, [
    { name: 'output_path', target: 'output_path', phase: 'call', bind_slot: 'output_path' },
  ])
  assert.equal(r.matched.output_path, 'output_path')
  assert.equal(r.call.bind.output_path, 'output_path')
})

test('bind 候选：引擎那边叫 output_dir 也算输出槽位', () => {
  const r = computeAutoFill([
    { source: 'python', name: 'spk_audio_prompt', target: 'spk_audio_prompt', kind: 'str', help: null, required: true, group: 'infer', is_tool: false },
  ], { kind: 'python' }, [
    { name: 'output_dir', target: 'output_dir', phase: 'call', bind_slot: 'output_path' },
  ])
  assert.equal(r.call.bind.output_path, 'output_dir')
})

// 回归守卫：不给候选时必须和加这个功能之前一模一样，认不出就是认不出，不瞎猜。
test('bind 候选：不给候选时行为不变，output_path 仍认不出', () => {
  const r = computeAutoFill([
    { source: 'python', name: 'spk_audio_prompt', target: 'spk_audio_prompt', kind: 'str', help: null, required: true, group: 'infer', is_tool: false },
  ], { kind: 'python' })
  assert.equal(r.matched.output_path, null)
  assert.ok(!('output_path' in r.call.bind))
})

test('bind 候选：params 里已有的同名参数优先，不被候选覆盖', () => {
  const r = computeAutoFill([
    { source: 'python', name: 'output_path', target: 'real_one', kind: 'str', help: null, required: false, group: 'infer', is_tool: false },
  ], { kind: 'python' }, [
    { name: 'output_path', target: 'from_candidate', phase: 'call', bind_slot: 'output_path' },
  ])
  assert.equal(r.call.bind.output_path, 'real_one')
})

// 候选只用于认槽位：它混进参数清单就等于「同一概念声明两次」。
test('bind 候选：只用于认槽位，不进参数清单', () => {
  const params = [
    { source: 'python', name: 'spk_audio_prompt', target: 'spk_audio_prompt', kind: 'str', help: null, required: true, group: 'infer', is_tool: false },
  ]
  const before = computeAutoFill([...params], { kind: 'python' })
  const after = computeAutoFill([...params], { kind: 'python' }, [
    { name: 'output_path', target: 'output_path', phase: 'call', bind_slot: 'output_path' },
  ])
  assert.deepEqual(after.argList, before.argList)
})

// 运行设备：名片要有一个承接「跑哪块卡」的位置，平台才能出设备下拉。
test('运行设备的参数自动打上标记，按 torch 写法', () => {
  const params = [...cliParams, {
    source: 'cli', name: 'device', target: '--device', kind: 'str',
    style: 'value', help: null, required: false, group: 'infer', is_tool: true,
  }]
  const r = computeAutoFill(params, { kind: 'cli' })
  assert.deepEqual(r.call.args.device, {
    flag: '--device', style: 'value', role: 'device', device_format: 'torch',
  })
  // 名字要带回给调用方写进 params.call_time：不写进去，请求里带了也会被静默丢弃
  assert.deepEqual(r.callTime, ['device'])
})

test('设备参数是整数类型时按编号写法标记', () => {
  const params = [...cliParams, {
    source: 'cli', name: 'device', target: '--device', kind: 'number',
    style: 'value', help: null, required: false, group: 'infer', is_tool: true,
  }]
  const r = computeAutoFill(params, { kind: 'cli' })
  assert.equal(r.call.args.device.device_format, 'index',
    '整数类型的 device 是 CUDA 编号，不是 torch 设备字符串')
})

test('名字不像设备的参数不打标记，平台不猜', () => {
  const params = [...cliParams, {
    source: 'cli', name: 'accelerator', target: '--accelerator', kind: 'str',
    style: 'value', help: null, required: false, group: 'infer', is_tool: true,
  }]
  const r = computeAutoFill(params, { kind: 'cli' })
  assert.equal(r.call.args.accelerator.role, undefined)
  assert.deepEqual(r.callTime, [])
})

test('带横线的开关也认得出槽位：归一化只用于匹配，落盘保留上游写法', () => {
  const params = [
    { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value', required: true, group: 'infer', source_file: 'cli.py' },
    { source: 'cli', name: 'output-dir', target: '--output-dir', kind: 'str', style: 'value', required: false, group: 'infer', source_file: 'cli.py' },
  ]
  const r = computeAutoFill(params, { kind: 'cli' })
  assert.equal(r.call.bind.output_path, '--output-dir', '带横线的落点开关此前绑不上')
})

test('输出形态按落点开关名推：以 _dir 结尾的判成目录', () => {
  const params = [
    { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value', required: true, group: 'infer', source_file: 'cli.py' },
    { source: 'cli', name: 'save-dir', target: '--save-dir', kind: 'str', style: 'value', required: false, group: 'infer', source_file: 'cli.py' },
  ]
  const r = computeAutoFill(params, { kind: 'cli' })
  assert.equal(r.call.returns, 'dir', '名字以 _dir 结尾时引擎收的是目录，文件名它自己起')
})

test('收文件名的引擎不写 returns，缺省就是 file', () => {
  const r = computeAutoFill(cliParams, { kind: 'cli' })
  assert.equal(r.call.returns, undefined)
})

test('已经写过 returns 的不覆盖：那是使用者的决定', () => {
  const params = [
    { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value', required: true, group: 'infer', source_file: 'cli.py' },
    { source: 'cli', name: 'save-dir', target: '--save-dir', kind: 'str', style: 'value', required: false, group: 'infer', source_file: 'cli.py' },
  ]
  const r = computeAutoFill(params, { kind: 'cli', returns: 'file' })
  assert.equal(r.call.returns, 'file')
})

// 入口嗅探结果（entry）要真正用上：模块名与子命令写进 argv，而不是认出来就完。
test('占位符换成嗅探到的模块名，子命令补在模块后面', () => {
  const r = computeAutoFill(
    cliParams,
    { kind: 'cli', argv: ['{engine_python}', '-m', '__MODULE__', 'infer'] },
    [],
    { file: 'pkg/cli.py', module: 'pkg.cli', subcommand: 'infer', score: 4 },
  )
  assert.deepEqual(r.call.argv, ['{engine_python}', '-m', 'pkg.cli', 'infer'])
})

test('骨架里已有子命令时不重复插一个', () => {
  const r = computeAutoFill(
    cliParams,
    { kind: 'cli', argv: ['{engine_python}', '-m', '_MODULE_', 'synth'] },
    [],
    { file: 'pkg/cli.py', module: 'pkg.cli', subcommand: 'infer', score: 4 },
  )
  assert.deepEqual(r.call.argv, ['{engine_python}', '-m', 'pkg.cli', 'synth'])
})

test('argv 已写着具体模块名时不改写：那是使用者的决定', () => {
  const r = computeAutoFill(
    cliParams,
    { kind: 'cli', argv: ['{engine_python}', '-m', 'my_own.entry'] },
    [],
    { file: 'pkg/cli.py', module: 'pkg.cli', subcommand: 'infer', score: 4 },
  )
  assert.deepEqual(r.call.argv, ['{engine_python}', '-m', 'my_own.entry'])
})

test('模块名能落定时工作目录指到引擎目录上', () => {
  const r = computeAutoFill(
    cliParams,
    { kind: 'cli', argv: ['{engine_python}', '-m', '_MODULE_'] },
    [],
    { file: 'pkg/cli.py', module: 'pkg.cli', score: 4 },
    'demo-engine',
  )
  assert.equal(r.call.cwd, 'engines/demo-engine')
})

test('src 布局：工作目录落到引擎目录下的 src，模块名不带 src. 前缀', () => {
  const r = computeAutoFill(
    cliParams,
    { kind: 'cli', argv: ['{engine_python}', '-m', '_MODULE_'] },
    [],
    { file: 'src/pkg/cli.py', module: 'pkg.cli', srcRoot: 'src', score: 4 },
    'demo-engine',
  )
  assert.equal(r.call.cwd, 'engines/demo-engine/src',
    'cwd 停在引擎根时 -m pkg.cli 找不到包，起来就是 ModuleNotFoundError')
  assert.deepEqual(r.call.argv, ['{engine_python}', '-m', 'pkg.cli'])
})

test('认出入口后，args 只从入口那个文件收，别的脚本的开关不进来', () => {
  const params = [
    { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value', required: true, group: '(root)', source_file: 'cli/inference.py' },
    { source: 'cli', name: 'device', target: '--device', kind: 'str', style: 'value', required: false, group: '(root)', source_file: 'cli/inference.py' },
    // 同仓库的量化脚本也有参数：收进来就是别人的旋钮
    { source: 'cli', name: 'tp_size', target: '--tp_size', kind: 'number', style: 'value', required: false, group: '(root)', source_file: 'quantize.py' },
  ]
  const r = computeAutoFill(
    params,
    { kind: 'cli', argv: ['{engine_python}', '-m', '_MODULE_'] },
    [],
    { file: 'cli/inference.py', module: 'cli.inference', score: 4 },
  )
  assert.equal(r.call.args.text.flag, '--text')
  assert.equal(r.call.args.device.role, 'device')
  assert.equal(r.call.args.tp_size, undefined, '其他脚本的开关不该进 args')
})

test('扫不出入口时不设限：args 保持原有行为', () => {
  const params = [
    { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value', required: true, group: '(root)', source_file: 'cli/inference.py' },
    { source: 'cli', name: 'tp_size', target: '--tp_size', kind: 'number', style: 'value', required: false, group: '(root)', source_file: 'quantize.py' },
  ]
  const r = computeAutoFill(params, { kind: 'cli' })
  assert.ok(r.call.args.tp_size, '没有入口线索时不过滤，维持旧行为')
})

test('音频类输入按嗅探建议打 role，名字进 call_time 白名单', () => {
  const params = [
    { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value', required: true, group: 'synth', source_file: 'cli.py' },
    { source: 'cli', name: 'emotion-audio', target: '--emotion-audio', kind: 'str', style: 'value', required: false, group: 'synth', source_file: 'cli.py' },
  ]
  const r = computeAutoFill(params, { kind: 'cli' }, [], null, null, {
    audio_params: ['emotion_audio'], weight_slots: [], output_formats: [],
  })
  assert.strictEqual(r.call.args['emotion-audio'].role, 'audio_ref')
  assert.deepStrictEqual(r.callTime, ['emotion-audio'], '音频参数也要进白名单，否则请求带了会被静默丢')
})

test('没嗅探到就不打 role：平台不替人猜', () => {
  const params = [
    { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value', required: true, group: 'synth', source_file: 'cli.py' },
    { source: 'cli', name: 'emotion_audio', target: '--emotion_audio', kind: 'str', style: 'value', required: false, group: 'synth', source_file: 'cli.py' },
  ]
  const r = computeAutoFill(params, { kind: 'cli' })
  assert.strictEqual(r.call.args.emotion_audio.role, undefined)
})

test('格式开关按嗅探建议打 role，名字进 call_time 白名单', () => {
  const params = [
    { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value', required: true, group: 'synth', source_file: 'cli.py' },
    { source: 'cli', name: 'output-format', target: '--output-format', kind: 'str', style: 'value', required: false, group: 'synth', source_file: 'cli.py', choices: ['wav', 'mp3'] },
  ]
  const r = computeAutoFill(params, { kind: 'cli' }, [], null, null, {
    audio_params: [], weight_slots: [], output_formats: ['wav', 'mp3'], format_arg: 'output_format',
  })
  assert.strictEqual(r.call.args['output-format'].role, 'output_format')
  assert.ok(r.callTime.includes('output-format'), '格式参数也要进白名单，host 才收得到')
})

test('顶层声明建议回传，由调用方按已有声明决定是否落盘', () => {
  const r = computeAutoFill(cliParams, { kind: 'cli' }, [], null, null, {
    audio_params: [],
    weight_slots: [{ name: 'gpt', param: 'gpt_model', applies_at: 'call' }],
    output_formats: ['wav', 'mp3'],
  })
  assert.deepStrictEqual(r.manifestPatch.weights[0].name, 'gpt')
  assert.deepStrictEqual(r.manifestPatch.output_formats, ['wav', 'mp3'])
})

// 权重落点：扫描认出的模型目录开关要自动接上 {checkpoints}。
// 少了这一对，名片校验只报「模型权重」缺失，而开关本身已经在 args 里。

const entryForWeights = {
  file: 'demo/infer_cli.py', module: 'demo.infer_cli', srcRoot: null,
  subcommand: null, score: 4, source: 'entry-points',
}

const withModel = [
  { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value', required: true, group: 'infer', source_file: 'demo/infer_cli.py' },
  { source: 'cli', name: 'model_dir', target: '--model_dir', kind: 'str', style: 'value', required: false, group: 'infer', source_file: 'demo/infer_cli.py' },
]

test('扫描认出模型目录开关 ⇒ 自动接上权重落点，名片不再缺「模型权重」', () => {
  const r = computeAutoFill(withModel, { kind: 'cli' }, [], entryForWeights, 'demo')
  assert.deepStrictEqual(r.call.argv.slice(-2), ['--model_dir', '{checkpoints}'])
  assert.ok(r.notes.some((n) => /权重落点/.test(n.zh)), '自动接线要在说明里留痕，便于核对')
  assert.strictEqual(r.call.args.model_dir.flag, '--model_dir', '开关本身仍留在 args 里')
})

test('名片里已写着权重落点 ⇒ 不再追加，使用者的写法优先', () => {
  const cur = { kind: 'cli', argv: ['{engine_python}', '-m', '_MODULE_', '--ckpt', '{checkpoints}'] }
  const r = computeAutoFill(withModel, cur, [], entryForWeights, 'demo')
  assert.deepStrictEqual(r.call.argv.slice(-2), ['--ckpt', '{checkpoints}'])
  assert.strictEqual(r.call.argv.length, 5, '不该出现第二对权重参数')
})

test('引擎自行定位权重 ⇒ 不补落点', () => {
  const r = computeAutoFill(withModel, { kind: 'cli', weights: 'self' }, [], entryForWeights, 'demo')
  assert.ok(!r.call.argv.some((w) => String(w).includes('{checkpoints}')))
})

test('没有入口线索且命中不止一个模型开关 ⇒ 不替使用者挑', () => {
  const params = [
    ...withModel,
    { source: 'cli', name: 'ckpt_dir', target: '--ckpt-dir', kind: 'str', style: 'value', group: 'infer', source_file: 'other.py' },
  ]
  const r = computeAutoFill(params, { kind: 'cli' }, [], null, 'demo')
  assert.ok(!r.call.argv.some((w) => String(w).includes('{checkpoints}')),
    '多个候选且没有入口证据时，接错目录会让引擎加载错权重')
})

test('没有入口线索但只命中一个模型开关 ⇒ 仍然自动接上', () => {
  const r = computeAutoFill(withModel, { kind: 'cli' }, [], null, 'demo')
  assert.deepStrictEqual(r.call.argv.slice(-2), ['--model_dir', '{checkpoints}'])
})

test('python 形态不往 argv 里写权重落点', () => {
  const r = computeAutoFill(pythonParams, { kind: 'python' }, [], null, 'demo')
  assert.strictEqual(r.call.argv, undefined)
})

// 自动填值分两档：规范同名、证据落在入口文件、且没有竞争候选才算确定，其余一律推测。
// 界面只按这两档给徽标着色，判据留在这里。

const entryFile = 'src/demo/__main__.py'
const cliInEntry = (name, target, file = entryFile) => ({
  source: 'cli', name, target, kind: 'str', style: 'value', group: 'infer', source_file: file,
})
const declaredEntry = {
  file: entryFile, module: 'demo.__main__', srcRoot: 'src', subcommand: null,
  score: 4, source: 'entry-points', confidence: 'high', ambiguous: false,
}
const exactSlots = [
  cliInEntry('text', '--text'),
  cliInEntry('ref_audio', '--ref_audio'),
  cliInEntry('prompt_text', '--prompt_text'),
  cliInEntry('output_path', '--output_path'),
]

test('规范同名且证据落在入口文件 ⇒ 四个槽位与入口都标成确定', () => {
  const r = computeAutoFill(exactSlots, { kind: 'cli' }, [], declaredEntry, 'demo')
  for (const key of ['text', 'ref_audio', 'ref_text', 'output_path']) {
    assert.ok(r.matched[key], key + ' 应当认得出')
    assert.strictEqual(r.confidence.bind[key].level, 'certain', key)
  }
  assert.strictEqual(r.confidence.entry.level, 'certain')
})

test('置信度与匹配结果一一对应，不凭空多出一格', () => {
  const r = computeAutoFill(exactSlots, { kind: 'cli' }, [], declaredEntry, 'demo')
  assert.deepStrictEqual(Object.keys(r.confidence.bind).sort(), Object.keys(r.matched).sort())
  for (const key of Object.keys(r.matched)) {
    assert.strictEqual(!!r.confidence.bind[key], !!r.matched[key])
  }
})

test('按相近名匹配 ⇒ 标成推测，依据点名相近参数与更贴切的落点开关', () => {
  const params = [
    cliInEntry('speaker', '--speaker'),
    cliInEntry('output_dir', '--output-dir'),
    cliInEntry('output_file', '--output-file'),
    cliInEntry('input_file', '--input-file'),
  ]
  const entry = { ...declaredEntry, confidence: 'medium' }
  const r = computeAutoFill(params, { kind: 'cli' }, [], entry, 'demo')
  assert.strictEqual(r.matched.text, null, '没有文本开关时不该硬填一格')
  assert.strictEqual(r.confidence.bind.text, null)
  assert.strictEqual(r.matched.ref_audio, '--speaker')
  assert.strictEqual(r.confidence.bind.ref_audio.level, 'guess')
  assert.match(r.confidence.bind.ref_audio.reason.zh, /speaker/)
  assert.strictEqual(r.matched.output_path, '--output-dir')
  assert.strictEqual(r.confidence.bind.output_path.level, 'guess')
  assert.match(r.confidence.bind.output_path.reason.zh, /--output-file/)
  assert.strictEqual(r.call.returns, 'dir')
  assert.strictEqual(r.confidence.returns.level, 'guess')
  assert.strictEqual(r.confidence.returns.value, 'dir')
  assert.strictEqual(r.confidence.entry.level, 'guess')
})

test('另有更贴切的规范名也在扫描结果里 ⇒ 即使同名也降为推测', () => {
  const params = [...exactSlots, cliInEntry('output_file', '--output-file')]
  const r = computeAutoFill(params, { kind: 'cli' }, [], declaredEntry, 'demo')
  assert.strictEqual(r.confidence.bind.output_path.level, 'guess')
  assert.match(r.confidence.bind.output_path.reason.zh, /--output-file/)
})

test('同名开关不在入口文件里 ⇒ 标成推测并写出所在文件', () => {
  const params = exactSlots.map((p) => p.name === 'text'
    ? { ...p, source_file: 'tools/other_cli.py' } : p)
  const r = computeAutoFill(params, { kind: 'cli' }, [], declaredEntry, 'demo')
  assert.strictEqual(r.confidence.bind.text.level, 'guess')
  assert.match(r.confidence.bind.text.reason.zh, /tools\/other_cli\.py/)
})

test('输出形态由名片自己声明 ⇒ 不产生推断记录', () => {
  const params = [cliInEntry('output_dir', '--output-dir')]
  const r = computeAutoFill(params, { kind: 'cli', returns: 'file' }, [], declaredEntry, 'demo')
  assert.strictEqual(r.confidence.returns, null)
  assert.strictEqual(r.call.returns, 'file')
})

test('权重落点按名字排序接上 ⇒ 标成推测，并记下接的是哪个开关', () => {
  const r = computeAutoFill(withModel, { kind: 'cli' }, [], entryForWeights, 'demo')
  assert.strictEqual(r.confidence.weights.level, 'guess')
  assert.strictEqual(r.confidence.weights.flag, '--model_dir')
})

// 可复现性：契约要求每张名片显式写出三态之一，缺了宿主拒绝启动。
// 自动填只做两件事：扫到名字就是 seed 的开关就按「引擎自己收」写，否则写「不可复现」。
const withSeedFlag = [...cliParams,
  { source: 'cli', name: 'seed', target: '--seed', kind: 'number', style: 'value', help: null, required: false, group: 'infer', is_tool: false }]

test('可复现性：扫到同名 seed 开关 ⇒ 按「引擎自己收」写，并补出 call.args 那一条', () => {
  const r = computeAutoFill(withSeedFlag, { kind: 'cli' }, [], null, 'demo')
  assert.deepStrictEqual(r.call.seed, { arg: 'seed' },
    'cli 的种子参数名是 call.args 的键，不是开关本身')
  assert.deepStrictEqual(r.call.args.seed, { flag: '--seed', style: 'value' },
    '只写 call.seed 不补 args 形状，宿主编命令行时会报「没有说明该变成哪个开关」')
})

test('可复现性：扫不到种子开关 ⇒ 写「不可复现」，不留空', () => {
  const r = computeAutoFill(cliParams, { kind: 'cli' }, [], null, 'demo')
  assert.strictEqual(r.call.seed, 'none',
    '缺了这一项保存与启动都会被拒；「不可复现」是唯一不需要额外信息的答案')
})

test('可复现性：名片已经写过 seed ⇒ 不覆盖', () => {
  const r = computeAutoFill(withSeedFlag, { kind: 'cli', seed: { mode: 'global', rngs: ['torch'] } }, [], null, 'demo')
  assert.deepStrictEqual(r.call.seed, { mode: 'global', rngs: ['torch'] })
})

// 嗅探这条路上，seed 与其它参数同一套：扫到同名开关就是证据。
//   名片里原本写着 "none" 的允许升级，但要把这次改动说出来，不能悄悄改。
test('可复现性：名片写着 none、扫到 seed 开关 ⇒ 升级为「引擎自己收」并提示', () => {
  const r = computeAutoFill(withSeedFlag, { kind: 'cli', seed: 'none' }, [], null, 'demo')
  assert.deepStrictEqual(r.call.seed, { arg: 'seed' })
  assert.ok(r.notes.some((n) => /「不可复现」/.test(n.zh)), '升级要说出来，别让人以为一直就是这样')
})

test('可复现性：入口文件里有同名 seed ⇒ 优先取入口里的那一个', () => {
  const entry = { file: 'cli/infer.py' }
  const params = [
    { source: 'cli', name: 'seed', target: '--seed', kind: 'number', style: 'value', source_file: 'train/s1_train.py' },
    { source: 'cli', name: 'seed', target: '--seed', kind: 'number', style: 'value', source_file: 'cli/infer.py' },
  ]
  const r = computeAutoFill(params, { kind: 'cli' }, [], entry, 'demo')
  assert.deepStrictEqual(r.call.seed, { arg: 'seed' })
  assert.deepStrictEqual(r.call.args.seed, { flag: '--seed', style: 'value' })
})

test('可复现性：已经写成 {arg} 的不被扫描改写', () => {
  const cur = { kind: 'cli', seed: { arg: 'random_seed' },
    args: { random_seed: { flag: '--random-seed', style: 'value' } } }
  const r = computeAutoFill(withSeedFlag, cur, [], null, 'demo')
  assert.deepStrictEqual(r.call.seed, { arg: 'random_seed' }, '已声明的参数名不被扫描改写')
  assert.deepStrictEqual(r.call.args.random_seed,
    { flag: '--random-seed', style: 'value' }, '原来那条 args 形状也在')
})

// 模型权重那两格：参数名来自扫描（入口文件内、按名字排序），
//   值来自「上游怎么说 + 盘上有几个权重文件」。只有两边都指向文件才写具体文件名。
const W_ENTRY = { file: 'cli/infer.py' }
const wParam = (name, help) => ({
  source: 'cli', name, target: '--' + name.replace(/_/g, '-'), kind: 'str',
  style: 'value', help: help || null, source_file: 'cli/infer.py',
})

test('模型权重：开关名带 dir ⇒ 值给下载目录', () => {
  const r = computeAutoFill([wParam('model_dir', 'Path to the model folder')],
    { kind: 'cli' }, [], W_ENTRY, 'demo', null, ['a.onnx', 'b.onnx'])
  assert.ok(r.call.argv.includes('{checkpoints}'))
  assert.ok(!r.call.argv.some((w) => String(w).startsWith('{checkpoints}/')))
})

test('模型权重：开关名与说明都指向文件，且盘上恰好一个权重文件 ⇒ 写文件名', () => {
  const r = computeAutoFill([wParam('model_file', 'Path to the .onnx model file')],
    { kind: 'cli' }, [], W_ENTRY, 'demo', null, ['voices/model.onnx', 'README.md'])
  assert.ok(r.call.argv.includes('{checkpoints}/model.onnx'),
    '盘上唯一那个权重文件才写进去')
  assert.ok(r.notes.some((n) => /盘上唯一/.test(n.zh)))
})

test('模型权重：只是名字像目录、盘上只有一个文件，也不改成文件名', () => {
  const r = computeAutoFill([wParam('model', 'Model directory')],
    { kind: 'cli' }, [], W_ENTRY, 'demo', null, ['model.onnx'])
  assert.ok(r.call.argv.includes('{checkpoints}'), '证据不足时按目录写')
})

test('模型权重：说明指向文件但盘上两个权重 ⇒ 先接目录并说明要手写文件名', () => {
  const r = computeAutoFill([wParam('model_file', 'Path to the model file')],
    { kind: 'cli' }, [], W_ENTRY, 'demo', null, ['a.onnx', 'b.onnx'])
  assert.ok(r.call.argv.includes('{checkpoints}'))
  assert.ok(r.notes.some((n) => /手写 \{checkpoints\}\/文件名/.test(n.zh)))
})
