'use strict'
// 第 4 步「命令行词序」这一块：位置参数只能在这里加，加了要真的进 argv。
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')
const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { JSDOM } = require(resolveFromRoot('jsdom'))
const { Simulate } = require(resolveFromRoot('react-dom/test-utils'))

function loadJsx (file, stubs) {
  const code = esbuild().transformSync(fs.readFileSync(path.join(EDITOR_DIR, file), 'utf8'),
    { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  const stub = (id) => {
    for (const [k, v] of Object.entries(stubs)) if (id === k || id.endsWith(k)) return v
    // 下拉换成了页面内的组件，这里只要能选值就够，交互细节由真组件那条测试守。
    if (id.endsWith('components/common/Select')) return require('./_selectStub.js')
    throw new Error(file + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, path.join(EDITOR_DIR, file), EDITOR_DIR)
  return mod.exports
}

// 位置参数那张表与名字归一化在 scanAutofill 里，加载真的那一份：
//   换成替身等于测了一张假的映射表。
const scanAutofill = loadJsx('scanAutofill.js', { './paramShape.js': loadJsx('paramShape.js', {}) })

const ArgvWords = loadJsx('ArgvWords.jsx', {
  react: React,
  'web/src/lib/i18n': { useT: () => ({ t: (en, zh) => zh || en }) },
  './scanAutofill': scanAutofill,
}).default

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5399/', pretendToBeVisual: true,
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
const settle = () => new Promise((r) => setTimeout(r, 40))

function card (argv, bind) {
  return { id: 'demo', call: { kind: 'cli', argv, bind: bind || {} } }
}

let seq = 0
// 受控组件：onChange 写回 holder 之后要重新渲染，否则点第二下时界面上还是旧词表。
function render (manifest, holder, key) {
  root.render(React.createElement(ArgvWords, {
    key,
    manifest,
    // undefined 表示「还没扫过」：那一格给不出结论，组件按摊开处理。
    positionals: holder.pos,
    onChange: (arg) => {
      holder.m = typeof arg === 'function' ? arg(holder.m) : arg
      render(holder.m, holder, key)
    },
  }))
}
async function show (manifest, holder, positionals) {
  holder.pos = positionals === undefined ? null : positionals
  seq += 1
  render(manifest, holder, 'aw' + seq)
  await settle()
}

const buttons = () => [...container.querySelectorAll('button')]
const buttonWith = (needle) => buttons().find((b) => b.textContent.trim() === needle)
const slotButton = (label) => buttons().find((b) => b.textContent.includes('+ ' + label))

test('词表按 argv 顺序渲染，第一个词不能删也不能再前移', async () => {
  const holder = { m: card(['{engine_python}', '-m', 'demo.cli']) }
  await show(holder.m, holder)
  assert.ok(container.textContent.includes('{engine_python}'))
  assert.ok(container.textContent.includes('demo.cli'))
  const first = container.querySelectorAll('.badge')[0]
  const btns = [...first.querySelectorAll('button')]
  assert.equal(btns[0].disabled, true, '第一个词不能再前移')
  assert.equal(btns[2].disabled, true, '第一个词不能删')
})

test('点「+ 文本」把 {text} 追加到命令行末尾', async () => {
  const holder = { m: card(['{engine_python}', '-m', 'demo.cli']) }
  await show(holder.m, holder)
  Simulate.click(slotButton('文本'))
  await settle()
  assert.deepEqual(holder.m.call.argv, ['{engine_python}', '-m', 'demo.cli', '{text}'])
})

test('这一项已经绑了开关时不给加，并说明要先清掉那一格', async () => {
  const holder = { m: card(['{engine_python}', '-m', 'demo.cli'], { text: '--text' }) }
  await show(holder.m, holder)
  const b = slotButton('文本')
  assert.equal(b.disabled, true)
  assert.match(b.getAttribute('title'), /--text/)
})

test('已经在词表里的槽位不再重复添加', async () => {
  const holder = { m: card(['{engine_python}', '{text}', '{output_path}']) }
  await show(holder.m, holder)
  assert.equal(slotButton('文本').disabled, true)
  assert.equal(slotButton('输出路径').disabled, true)
  assert.equal(slotButton('参考音频').disabled, false)
})

test('上下按钮换位，删掉一个词', async () => {
  const holder = { m: card(['{engine_python}', '{text}', '{output_path}']) }
  await show(holder.m, holder)
  const rows = () => container.querySelectorAll('.badge')
  // 第二个词（{text}）后移一位
  const second = [...rows()[1].querySelectorAll('button')][1]
  Simulate.click(second)
  await settle()
  assert.deepEqual(holder.m.call.argv, ['{engine_python}', '{output_path}', '{text}'])

  const third = [...rows()[2].querySelectorAll('button')][2]
  Simulate.click(third)
  await settle()
  assert.deepEqual(holder.m.call.argv, ['{engine_python}', '{output_path}'])
})

test('自由加词：输入框回车把词追到末尾', async () => {
  const holder = { m: card(['{engine_python}']) }
  await show(holder.m, holder)
  const input = container.querySelector('input')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '--language')
  Simulate.change(input)
  await settle()
  Simulate.keyDown(input, { key: 'Enter' })
  await settle()
  assert.deepEqual(holder.m.call.argv, ['{engine_python}', '--language'])
})

test('没有 argv 的卡片给出说明，不白屏', async () => {
  const holder = { m: { id: 'x', call: { kind: 'cli', bind: {} } } }
  await show(holder.m, holder)
  assert.match(container.textContent, /还没有命令词/)
  assert.equal(slotButton('文本').disabled, false, '空词表时仍能把占位符加进来')
})

// 扫描结论决定这一块摊不摊开：四个槽位全绑在开关上的引擎，按钮全是灰的，
// 摊着占首屏却给不出任何可填的东西。以下三条钉住开合与逐条列出的行为。
test('⭐⭐⭐ 扫描确认没有位置参数：收成一行，只剩一个展开入口', async () => {
  const holder = { m: card(['{engine_python}', '-m', 'demo.cli'], { text: '--text', output_path: '-o' }) }
  await show(holder.m, holder, [])
  assert.match(container.textContent, /没有位置参数/)
  assert.equal(slotButton('文本'), undefined, '收起来时不该还摆着四个灰按钮')
  assert.equal(container.querySelectorAll('input').length, 0)
  assert.ok(buttonWith('展开编辑'), '`-m 模块名` 只在这一块能改，入口不能消失')
  assert.ok(container.textContent.includes('demo.cli'), '收起不等于看不见这条命令')
})

test('点「展开编辑」把按钮要回来，再点「收起」回去', async () => {
  const holder = { m: card(['{engine_python}', '-m', 'demo.cli'], { text: '--text' }) }
  await show(holder.m, holder, [])
  Simulate.click(buttonWith('展开编辑'))
  await settle()
  assert.ok(slotButton('文本'), '展开后槽位按钮要回来')
  Simulate.click(buttonWith('收起'))
  await settle()
  assert.equal(slotButton('文本'), undefined)
})

test('⭐⭐⭐ 扫到位置参数：摊开并逐条列出，能对上槽位的标明是它供的值', async () => {
  const holder = { m: card(['{engine_python}', '-m', 'demo', '{text}']) }
  await show(holder.m, holder, [{ name: 'text', nargs: null, help: '要念的话' }])
  assert.match(container.textContent, /扫描到这条命令行上有位置参数/)
  assert.match(container.textContent, /已接成 \{text\}/)
  // 已经由位置参数供值的槽位，按钮要说明是谁供的，别让人以为开关也在供。
  assert.match(slotButton('文本').getAttribute('title'), /位置参数「text」/)
})

test('⭐⭐ 对不上槽位的位置参数照实说平台没有值可填，不假装能接', async () => {
  const holder = { m: card(['{engine_python}', '-m', 'demo']) }
  await show(holder.m, holder, [{ name: 'speaker', nargs: null, help: '说话人编号' }])
  assert.match(container.textContent, /平台没有对应的值可填/)
  assert.equal([...buttons()].filter((b) => /接成/.test(b.textContent)).length, 0)
})

test('nargs 收多个值的标记要带出来', async () => {
  const holder = { m: card(['{engine_python}', '-m', 'demo']) }
  await show(holder.m, holder, [{ name: 'text', nargs: '+', help: null }])
  assert.match(container.textContent, /nargs \+/,
    '收多个值的位置参数只填一个词，不说就会在引擎那边报参数不足')
})

test('还没扫过（结论未知）时保持摊开，不擅自收起', async () => {
  const holder = { m: card(['{engine_python}', '-m', 'demo.cli'], { text: '--text' }) }
  await show(holder.m, holder)
  assert.ok(slotButton('文本'), '给不出「有没有位置参数」的结论时，摊开比收起更安全')
})

// 开合是同一个动作：有位置参数的引擎最需要看完整命令，但它同样需要能合上。
test('⭐⭐⭐ 扫到位置参数时也能收起，收起态如实说扫到了几条', async () => {
  const holder = { m: card(['{engine_python}', '-m', 'demo', '{text}']) }
  await show(holder.m, holder, [{ name: 'text', nargs: null, help: null }])
  const collapse = buttonWith('收起')
  assert.ok(collapse, '有位置参数时也要给收起按钮')
  Simulate.click(collapse)
  await settle()
  assert.equal(slotButton('文本'), undefined, '收起后槽位按钮应当消失')
  assert.match(container.textContent, /扫描到 1 个位置参数：text/,
    '收起态不能再说「没有位置参数」——那是另一台引擎的结论')
  assert.ok(container.textContent.includes('{text}'), '收起不等于看不见这条命令')
  Simulate.click(buttonWith('展开编辑'))
  await settle()
  assert.ok(slotButton('文本'), '还能再展开')
})
