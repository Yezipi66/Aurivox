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
    { loader: 'jsx', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  const stub = (id) => {
    for (const [k, v] of Object.entries(stubs)) if (id === k || id.endsWith(k)) return v
    throw new Error(file + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, path.join(EDITOR_DIR, file), EDITOR_DIR)
  return mod.exports
}

const ArgvWords = loadJsx('ArgvWords.jsx', {
  react: React,
  'web/src/lib/i18n': { useT: () => ({ t: (en, zh) => zh || en }) },
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
    onChange: (arg) => {
      holder.m = typeof arg === 'function' ? arg(holder.m) : arg
      render(holder.m, holder, key)
    },
  }))
}
async function show (manifest, holder) {
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
