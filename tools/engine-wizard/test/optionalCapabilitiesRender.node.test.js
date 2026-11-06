'use strict'
// 「可选能力」这一段真的能渲染：白屏是最贵的一类坏法，构建通过也抓不住。
//
// 为什么要有这条：`wizardBuild` 只验模块图能不能打包，**认不出未定义的标识符**
//   （`readSlots is not defined` 是运行时才炸的），于是构建绿、页面白。
//   这里用 jsdom + 真 React 渲染一次，把这一整类「引用了没导入的东西」挡在提交之前。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { JSDOM } = require(resolveFromRoot('jsdom'))
// 输入框要走 React 的合成事件：jsdom 里自己派发 input 事件进不了它的队列。
const { Simulate } = require(resolveFromRoot('react-dom/test-utils'))

// 纯函数模块是 ESM：用项目 Vite 依赖的同一个 esbuild 编成 CJS。
function loadEsm (file) {
  const esb = esbuild()
  const code = esb.transformSync(fs.readFileSync(file, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(
    mod.exports, () => { throw new Error(path.basename(file) + ' 不该有依赖') }, mod)
  return mod.exports
}

function loadJsx (file, stubMap) {
  const esb = esbuild()
  const code = esb.transformSync(fs.readFileSync(path.join(EDITOR_DIR, file), 'utf8'), {
    loader: 'jsx', format: 'cjs', target: 'node18',
  }).code
  const mod = { exports: {} }
  const stub = (id) => {
    for (const [k, v] of Object.entries(stubMap)) {
      if (id === k || id.endsWith(k)) return v
    }
    throw new Error(file + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, path.join(EDITOR_DIR, file), EDITOR_DIR)
  return mod.exports
}

const OptionalCapabilities = loadJsx('OptionalCapabilities.jsx', {
  react: React,
  'web/src/lib/i18n': { useT: () => ({ t: (en) => en }) },
  './weightSlots': loadEsm(path.join(EDITOR_DIR, 'weightSlots.js')),
  './seedField': loadEsm(path.join(EDITOR_DIR, 'seedField.js')),
}).default

// 整份文件只起一个页面：React 把事件与根容器绑在 document 上。
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5299/',
  pretendToBeVisual: true,
})
const define = (key, value) => {
  Object.defineProperty(global, key, { value, writable: true, configurable: true })
}
define('window', dom.window)
define('document', dom.window.document)
define('navigator', dom.window.navigator)
define('HTMLElement', dom.window.HTMLElement)
define('Element', dom.window.Element)
define('Node', dom.window.Node)
define('getComputedStyle', dom.window.getComputedStyle)
define('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0))
define('cancelAnimationFrame', (id) => clearTimeout(id))
const container = dom.window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)
const settle = () => new Promise((r) => setTimeout(r, 30))

// python 形态的名片：没有 argv，走 call.module / class / method。
// 全局播种只在这种形态下有意义，所以用它验那一支。
const pyManifest = () => ({
  contract_version: 2,
  id: '',
  label: 'Demo',
  call: { kind: 'python', module: 'demo', class: 'Up', method: 'infer',
    bind: { text: 'text', output_path: 'output_path' }, returns: 'file', seed: 'none' },
  weights: [],
  params: { load_time: [], call_time: [], schema: {} },
})

const cliManifest = (weights) => ({
  contract_version: 2,
  id: '',
  label: 'Demo',
  call: {
    kind: 'cli',
    argv: ['{engine_python}', '-m', 'demo.cli'],
    bind: { text: '--text', output_path: '--out' },
    seed: 'none',
  },
  weights,
  params: { load_time: [], call_time: [], schema: {} },
})

// 每个用例换一个 key 让组件重新挂载：槽位草稿是组件内部状态，
// 不重挂的话上一个用例的草稿会盖住这一份名片。
let mountSeq = 0
async function show (manifest) {
  mountSeq += 1
  root.render(React.createElement(OptionalCapabilities, {
    key: 'm' + mountSeq, manifest, onChange: () => {},
  }))
  await settle()
}

// 权重位的一行：行内是四格加两个按钮，靠内联 grid 排版。
// 权重位的一行：行内四格加两个按钮，靠内联 grid 排版。
//   判据要带上「行里有一个生效时机下拉」：设备/参考文本/seed 那一行也是 grid，
//   只按 grid-template-columns 认，会把那一行数成权重位。
const slotRows = () => [...container.querySelectorAll('div')]
  .filter((el) => /grid-template-columns/.test(el.getAttribute('style') || ''))
  .filter((el) => !!el.querySelector('select'))

// 分段框：输出格式、音频输入、多权重位各一个，标识是 BOX 那份圆角边框。
const boxes = () => [...container.querySelectorAll('div')]
  .filter((el) => /border-radius:\s*6px/.test(el.getAttribute('style') || ''))

const buttonsOf = (root) => [...root.querySelectorAll('button')].map((b) => b.textContent.trim())

const clickIn = async (re, scope) => {
  const btn = [...(scope || container).querySelectorAll('button')]
    .find((b) => re.test(b.textContent.trim()))
  assert.ok(btn, '找不到按钮：' + re)
  btn.click()
  await settle()
}

const mount = async (key, manifest, holder) => {
  root.render(React.createElement(OptionalCapabilities, {
    key,
    manifest,
    onChange: (arg) => { holder.m = typeof arg === 'function' ? arg(holder.m) : arg },
  }))
  await settle()
}

test('单权重引擎也默认摆出第 2 权重位：空行不进名片，减号变灰', async () => {
  const holder = { m: cliManifest([]) }
  await mount('draft-only', holder.m, holder)
  assert.equal(slotRows().length, 1, '默认就摆一位：使用者不必先点一次加号')
  assert.ok(/第2权重位|Weight slot 2/.test(container.textContent),
    '第 1 位在必填区，本区从第 2 位起')
  assert.deepStrictEqual(buttonsOf(slotRows()[0]), ['+', '−'], '加在上、减在下')
  assert.equal(slotRows()[0].querySelectorAll('button')[1].disabled, true,
    '只剩这一位时减号要变灰：再减连行都没有了')
  assert.deepStrictEqual(holder.m.weights || [],
    [], '位名留空的行等于没声明：名片里不该写下这一位')
})

test('点加号长一位、点减号收回；空行始终不进名片', async () => {
  const holder = { m: cliManifest([]) }
  await mount('draft-lines', holder.m, holder)

  await clickIn(/^\+$/, slotRows()[0])
  assert.equal(slotRows().length, 2, '加号要能长出新的一位')
  assert.ok(slotRows().every((row) => row.querySelectorAll('button')[1].disabled === false),
    '两位以上时每一行都能减')

  await clickIn(/^−$/, slotRows()[1])
  assert.equal(slotRows().length, 1, '减号要能把它收回，误点加号不会越积越多')
  assert.equal(holder.m.weights, undefined, '一行都没填位名，名片里不该出现 weights')
})

test('多权重位共用一个框：两位两行，行内四格', async () => {
  await show(cliManifest([
    { name: 'gpt', label: 'GPT', param: 'gpt_model', applies_at: 'call' },
    { name: 'sovits', label: 'SoVITS', param: 'sovits_model', applies_at: 'call' },
  ]))
  // i18n 桩给的是英文那一份（t(en, zh) 只回 en），所以按英文文案断言。
  assert.ok(/Weight slot 2/.test(container.textContent) && /Weight slot 3/.test(container.textContent),
    '两位的标题分别写第 2 / 第 3 权重位（第 1 位在必填区）')
  const rows = slotRows()
  assert.equal(rows.length, 2, '两位两行')
  const weightBox = boxes().find((b) => /Weight slot 2/.test(b.textContent))
  assert.ok(weightBox, '多权重位要有自己的框')
  for (const row of rows) {
    assert.equal(row.querySelectorAll('input').length, 3, '一行三个输入框')
    assert.equal(row.querySelectorAll('select').length, 1, '一行一个生效时机下拉')
    assert.ok(weightBox.contains(row), '两位要收在同一个框里')
  }
})

test('三个框的顺序：输出格式 → 音频输入 → 多权重位，都排在设备那一行之后', async () => {
  await show(cliManifest([]))
  const list = boxes()
  assert.equal(list.length, 3, '三段各占一个框')
  assert.ok(/Output format switch|输出格式开关/.test(list[0].textContent),
    '输出格式紧跟运行设备')
  assert.ok(/Audio input|音频输入/.test(list[1].textContent))
  assert.ok(/Weight slot 2|第2权重位/.test(list[2].textContent), '权重位排在最后')
  assert.ok(/Runtime device|运行设备/.test(list[0].parentElement.textContent),
    '三个框都在运行设备之后')
})

test('没填的框整块弱化：输出格式与音频输入空着带 wz-unset，声明过就摘掉', async () => {
  await show(cliManifest([]))
  let list = boxes()
  assert.ok(/wz-unset/.test(list[0].className), '输出格式开关空着＝不支持输出格式')
  assert.ok(/wz-unset/.test(list[1].className), '音频输入空着＝不接受音频输入')

  const m = cliManifest([])
  m.call.args = {
    format: { flag: '--format', role: 'output_format' },
    audio_ref: { flag: '--emotion-audio', role: 'audio_ref' },
  }
  await show(m)
  list = boxes()
  assert.ok(!/wz-unset/.test(list[0].className), '声明过就不该再弱化')
  assert.ok(!/wz-unset/.test(list[1].className), '声明过就不该再弱化')
})

test('输出格式与权重位都常驻显示，区尾不再有「添加」按钮', async () => {
  await show(cliManifest([]))
  const names = buttonsOf(container)
  assert.ok(!names.some((x) => /添加输出格式|Add output formats/.test(x)),
    '输出格式默认就在，不需要一个添加按钮')
  assert.ok(!names.some((x) => /加一位权重位|Add a weight slot/.test(x)),
    '默认已摆出一位，同一动作不再两处入口')
})

test('空格等于没填：设备与音频的开关名只敲空格，名片里不留键', async () => {
  const holder = { m: cliManifest([]) }
  root.render(React.createElement(OptionalCapabilities, {
    key: 'blank-flag',
    manifest: holder.m,
    onChange: (arg) => { holder.m = typeof arg === 'function' ? arg(holder.m) : arg },
  }))
  await settle()

  const dev = [...container.querySelectorAll('input')]
    .find((i) => i.placeholder === '--device')
  assert.ok(dev, '运行设备那一格要在')
  assert.equal(dev.value, '', '空名片时显示为空：--device 只是提示，不算已声明')
  Simulate.change(dev, { target: { value: '   ' } })
  await settle()
  assert.ok(!holder.m.call.args || !holder.m.call.args.device,
    '只敲空格不算声明运行设备：名片里不该留下这个键')

  const audio = [...container.querySelectorAll('input')]
    .find((i) => i.placeholder === '--emotion-audio')
  assert.ok(audio, '音频输入那一格要在')
  Simulate.change(audio, { target: { value: '  ' } })
  await settle()
  assert.ok(!holder.m.call.args || !holder.m.call.args.audio_ref,
    '只敲空格不算声明音频输入')
})

test('没声明的格弱化显示：空着的设备/参考文本带 wz-unset，声明过就不带', async () => {
  await show(cliManifest([]))
  const cellOf = (placeholder) => [...container.querySelectorAll('div')]
    .find((d) => /(^|\s)field(\s|$)/.test(d.className || '') &&
      d.querySelector(`input[placeholder="${placeholder}"]`))
  const dev = cellOf('--device')
  assert.ok(dev, '找不到运行设备那一格')
  assert.ok(/wz-unset/.test(dev.className), '空着的一格要弱化：这是「还没声明」的样子')
  const ref = [...container.querySelectorAll('div')]
    .find((d) => /wz-unset/.test(d.className || '') && /参考文本|Reference text/.test(d.textContent || ''))
  assert.ok(ref, '参考文本空着时也要弱化')

  const m = cliManifest([])
  m.call.args = { device: { flag: '--device', style: 'value', role: 'device' } }
  await show(m)
  const filled = [...container.querySelectorAll('div')]
    .find((d) => /(^|\s)field(\s|$)/.test(d.className || '') &&
      d.querySelector('input[placeholder="--device"]'))
  assert.ok(filled && !/wz-unset/.test(filled.className),
    '声明过就不该再弱化：灰着表示这一项还不存在')
})

// 可复现性那一格要能改：它写的是 call.seed，宿主只在三种写法里挑一种执行。
// seed 那一格：与运行设备、参考文本同一行，只留一个输入框（填开关名＝引擎自己收）。
// 留空在别的格是「不声明」，在这一格不行：名片缺 call.seed 会被存盘与启动拒掉，
// 所以留空落盘是显式的 "none"。
function seedHarness (initial, sink) {
  function Harness () {
    const [m, setM] = React.useState(initial)
    sink.m = m
    return React.createElement(OptionalCapabilities, { manifest: m, onChange: setM })
  }
  mountSeq += 1
  root.render(React.createElement(Harness, { key: 'seed' + mountSeq }))
}

// seed 那一格：标签文字就是 seed，按标签找，不靠位置猜。
const seedField = () => [...container.querySelectorAll('.field')]
  .find((el) => {
    const label = el.querySelector('.field-label')
    return label && label.textContent.trim() === 'seed'
  })
const seedInput = () => seedField().querySelector('input')
const typeSeed = async (value) => {
  const el = seedInput()
  el.value = value
  Simulate.change(el, { target: el })
  await settle()
}

test('seed 与运行设备、参考文本同一行，排在参考文本之后', async () => {
  const sink = {}
  seedHarness(cliManifest([]), sink)
  await settle()
  const row = seedField().parentElement
  assert.ok(/Runtime device|运行设备/.test(row.textContent), 'seed 与运行设备同一行')
  assert.ok(/Reference text|参考文本/.test(row.textContent), 'seed 与参考文本同一行')
  const labels = [...row.querySelectorAll('.field-label')].map((el) => el.textContent.trim())
  assert.deepStrictEqual(labels, ['Runtime device', 'Reference text', 'seed'],
    '这一行的顺序：设备、参考文本、seed')
  assert.ok(/grid/.test(row.className) || /grid/.test(row.getAttribute('style') || ''))
})

test('填开关名 ⇒ 写 {arg:键} 并补出 call.args；留空 ⇒ 显式 "none" 且那条 args 收走', async () => {
  const sink = {}
  seedHarness(cliManifest([]), sink)
  await settle()
  assert.equal(seedInput().value, '', '没声明时输入框是空的')

  await typeSeed('--seed')
  assert.deepStrictEqual(sink.m.call.seed, { arg: 'seed' },
    'cli 的种子参数名是 call.args 的键，不是开关本身')
  assert.deepStrictEqual(sink.m.call.args.seed, { flag: '--seed', style: 'value' },
    '同时补出 args 形状：宿主要靠它把种子拼成 --seed 42')
  assert.equal(seedInput().value, '--seed', '回显的是开关本身')

  await typeSeed('')
  assert.strictEqual(sink.m.call.seed, 'none',
    '留空要落盘成显式的 none：删掉这一项会让名片缺必填')
  assert.strictEqual(sink.m.call.args && sink.m.call.args.seed, undefined,
    '那条只为种子补出的 args 一起收走')
})

test('名片缺 seed 时自动补「不可复现」；已声明的不被覆盖', async () => {
  const missing = cliManifest([])
  delete missing.call.seed
  const a = {}
  seedHarness(missing, a)
  await settle()
  assert.strictEqual(a.m.call.seed, 'none')

  const declared = cliManifest([])
  declared.call.seed = { arg: 'seed' }
  declared.call.args = { seed: { flag: '--seed', style: 'value' } }
  const b = {}
  seedHarness(declared, b)
  await settle()
  assert.deepStrictEqual(b.m.call.seed, { arg: 'seed' }, '原样保留')
  assert.equal(seedInput().value, '--seed', '回显已有声明')
})

test('python 形态：填参数名只写 call.seed，不建 args 表', async () => {
  const sink = {}
  seedHarness(pyManifest(), sink)
  await settle()
  await typeSeed('seed')
  assert.deepStrictEqual(sink.m.call.seed, { arg: 'seed' })
  assert.strictEqual(sink.m.call.args, undefined, 'python 形态没有命令行，也就没有 args')
})
