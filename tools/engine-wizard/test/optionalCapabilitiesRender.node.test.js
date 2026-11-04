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

const slotNameInputs = () => [...container.querySelectorAll('input')]
  .filter((el) => el.closest('div[style*="grid-template-columns"]'))
  .filter((el) => el.value === '' || /gpt|sovits/.test(el.value))

const slotBoxes = () => [...container.querySelectorAll('div')]
  .filter((el) => /grid-template-columns/.test(el.getAttribute('style') || ''))

const buttonsOf = (root) => [...root.querySelectorAll('button')].map((b) => b.textContent.trim())

test('⛔ 单权重引擎不声明位：一个框都不画，只留一个「加一位」的入口', async () => {
  await show(cliManifest([]))
  assert.deepStrictEqual(slotBoxes(), [],
    '一位都没声明却画了框：单权重引擎那类会被虚报成「有多权重可换」，而且那个框减不掉')
  assert.ok(!/第2权重位|Weight slot 2/.test(container.textContent),
    '没声明位就不该出现第 2 权重位')
  const add = [...container.querySelectorAll('button')]
    .find((b) => /加一位权重位|Add a weight slot/.test(b.textContent))
  assert.ok(add, '没有入口就再也加不出第一位：要留一个「加一位」按钮')
})

test('点加号多一位、点减号收回；只剩一位时减号变灰；空行不进名片', async () => {
  const holder = { m: cliManifest([]) }
  root.render(React.createElement(OptionalCapabilities, {
    key: 'empty-lines',
    manifest: holder.m,
    onChange: (arg) => { holder.m = typeof arg === 'function' ? arg(holder.m) : arg },
  }))
  await settle()

  const clickByText = async (re, scope) => {
    const btn = [...(scope || container).querySelectorAll('button')]
      .find((b) => re.test(b.textContent.trim()))
    assert.ok(btn, '找不到按钮：' + re)
    btn.click()
    await settle()
  }
  const minusOf = (row) => row.querySelectorAll('button')[1]

  await clickByText(/加一位权重位|Add a weight slot/)
  assert.equal(slotBoxes().length, 1, '点一次只该长一位')
  assert.ok(/第2权重位|Weight slot 2/.test(container.textContent),
    '第一位（本区）的标题是第2权重位：第 1 位在必填区')
  assert.deepStrictEqual(buttonsOf(slotBoxes()[0]), ['+', '−'], '加在上、减在下')
  assert.equal(minusOf(slotBoxes()[0]).disabled, true,
    '只剩这一位时减号要变灰：再减连行都没有了')

  await clickByText(/^\+$/, slotBoxes()[0])
  assert.equal(slotBoxes().length, 2, '加号要能长出新的一位')
  for (const row of slotBoxes()) {
    assert.equal(minusOf(row).disabled, false, '两位以上时每张都能减')
  }

  await clickByText(/^−$/, slotBoxes()[1])
  assert.equal(slotBoxes().length, 1, '减号要能把它收回，误点加号不会越积越多')
  assert.equal(minusOf(slotBoxes()[0]).disabled, true)

  // 一行都没填位名 = 什么都没声明，名片里不该出现 weights。
  assert.equal(holder.m.weights, undefined,
    '位名留空的行等于没声明：它不用手动删，也不该写进名片')
})

test('两位就画两个框，行内四格：位名/显示名/参数名/生效时机', async () => {
  await show(cliManifest([
    { name: 'gpt', label: 'GPT', param: 'gpt_model', applies_at: 'call' },
    { name: 'sovits', label: 'SoVITS', param: 'sovits_model', applies_at: 'call' },
  ]))
  // i18n 桩给的是英文那一份（t(en, zh) 只回 en），所以按英文文案断言。
  assert.ok(/Weight slot 2/.test(container.textContent) && /Weight slot 3/.test(container.textContent),
    '两位要画两个框，标题分别写第 2 / 第 3 权重位（第 1 位在必填区）')
  const rows = slotBoxes()
  assert.equal(rows.length, 2, '一位一个框')
  for (const row of rows) {
    assert.equal(row.querySelectorAll('input').length, 3, '一行三个输入框')
    assert.equal(row.querySelectorAll('select').length, 1, '一行一个生效时机下拉')
  }
  assert.equal(slotNameInputs().length > 0, true)
})

test('零位时区尾两个「添加」并排：加一位权重位 + 添加输出格式', async () => {
  await show(cliManifest([]))
  const all = [...container.querySelectorAll('button')]
  const addWeight = all.find((b) => /加一位权重位|Add a weight slot/.test(b.textContent))
  const addFormat = all.find((b) => /添加输出格式|Add output formats/.test(b.textContent))
  assert.ok(addWeight, '零位时要有起点：没有卡可点，只能靠这个按钮')
  assert.ok(addFormat, '输出格式没声明时要有添加按钮')
  assert.strictEqual(addWeight.parentElement, addFormat.parentElement,
    '两个「添加」并排在同一行：各占一行会把版面割开')
  assert.ok((addWeight.parentElement.getAttribute('style') || '').includes('display: flex'),
    '那一行要横排')
})

test('已有位时区尾不再重复「加一位权重位」：加号在卡里', async () => {
  await show(cliManifest([{ name: 'gpt', label: 'GPT', param: 'gpt_model' }]))
  const all = [...container.querySelectorAll('button')]
  assert.ok(!all.some((b) => /加一位权重位|Add a weight slot/.test(b.textContent)),
    '卡片右侧已有加号，区尾再放一个就是同一个动作两处入口')
  assert.ok(all.some((b) => /添加输出格式|Add output formats/.test(b.textContent)),
    '输出格式还没声明，它自己的添加按钮要留着')
  assert.deepStrictEqual(buttonsOf(slotBoxes()[0]), ['+', '−'], '加在上、减在下')
})

test('输出格式声明过了、权重位也没有：区尾只剩「加一位权重位」', async () => {
  const m = cliManifest([])
  m.call.args = { format: { flag: '--format', style: 'value', role: 'output_format' } }
  await show(m)
  const names = [...container.querySelectorAll('button')].map((b) => b.textContent.trim())
  assert.ok(names.some((x) => /加一位权重位|Add a weight slot/.test(x)))
  assert.ok(!names.some((x) => /添加输出格式|Add output formats/.test(x)),
    '已经声明过就不该再给一个「添加输出格式」')
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
