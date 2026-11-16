// 运行设备下拉：选项按引擎声明的形状摆（设备名 / 编号 / 引擎候选值），
// 末尾留自定义入口，并把「这次下发」原样显示出来。
//
// web/ 下是 ESM（web/package.json 的 type），所以这里用 import，
// 需要同步 require 的地方走 createRequire 拿回来。

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const DIR = path.dirname(fileURLToPath(import.meta.url))

const { resolveFromRoot, esbuild } = require('../../../../lib/testDeps.js')
const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { JSDOM } = require(resolveFromRoot('jsdom'))
const { Simulate } = require(resolveFromRoot('react-dom/test-utils'))

function loadJsx (file, stubMap) {
  // 组件用的是现代 JSX 运行时（不 import React），所以按 automatic 编译，
  // 否则会生成 React.createElement 而作用域里没有 React。
  const code = esbuild().transformSync(fs.readFileSync(path.join(DIR, file), 'utf8'),
    { loader: 'jsx', format: 'cjs', target: 'node18', jsx: 'automatic' }).code
  const mod = { exports: {} }
  const stub = (id) => {
    for (const [k, v] of Object.entries(stubMap)) {
      if (id === k || id.endsWith(k)) return v
    }
    throw new Error(file + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, path.join(DIR, file), DIR)
  return mod.exports
}

const DeviceSelect = loadJsx('DeviceSelect.jsx', {
  react: React,
  'react/jsx-runtime': require(resolveFromRoot('react/jsx-runtime')),
  'lib/i18n': { useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) },
}).default

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:9886/', pretendToBeVisual: true,
})
const define = (key, value) => {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
}
define('window', dom.window)
define('document', dom.window.document)
define('navigator', dom.window.navigator)
define('HTMLElement', dom.window.HTMLElement)
define('Element', dom.window.Element)
define('Node', dom.window.Node)

const container = dom.window.document.getElementById('root')
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
let root = null

const AUTO = {
  value: { kind: 'auto' }, labelZh: '自动（不指定）', labelEn: 'Auto (unset)',
  selectable: true, sends: '不传这个开关，引擎用自己的默认值',
}
const CPU = { value: { kind: 'cpu' }, labelZh: 'CPU', labelEn: 'CPU', selectable: true, sends: '--device cpu' }
const GPU = {
  value: { kind: 'gpu', index: 0, backend: 'xpu' }, labelZh: 'GPU 0: Arc', labelEn: 'GPU 0: Arc',
  selectable: true, sends: '--device xpu',
}

let last = null
let current = null
// 受控组件：onChange 之后要像真实父组件那样把新值回灌，否则组件内看到的值不变，
//   预览行测的就是上一帧。
function render (props) {
  current = props
  root.render(React.createElement(DeviceSelect, {
    id: 'dev',
    ...props,
    onChange: (v) => {
      last = v
      render({ ...current, value: v })
    },
  }))
}
async function show (props) {
  last = null
  // 每条用例一棵新树：同一个 root 连着换 props 时，React 的并发调度会把上一帧的
  //   更新排到测试之外，表现为整条用例挂住。
  if (root) {
    root.unmount()
    root = null
  }
  container.innerHTML = ''
  root = ReactDOMClient.createRoot(container)
  render(props)
  await settle()
}
const select = () => container.querySelector('select')
const textInput = () => container.querySelector('input')
const selectedText = () => {
  const s = select()
  return s && s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent : ''
}

test('选项按引擎形状摆好，末尾留自定义入口，并把下发形态显示出来', async () => {
  await show({ options: [AUTO, CPU, GPU], value: undefined })
  const labels = [...select().options].map((o) => o.textContent)
  assert.deepStrictEqual(labels, ['自动（不指定）', 'CPU', 'GPU 0: Arc', '自定义…'])
  assert.strictEqual(container.textContent.includes('不传这个开关'), true,
    '自动这一项要说清「不发这个参数」，否则人以为平台替他选了')
  await show({ options: [AUTO, CPU, GPU], value: { kind: 'gpu', index: 0, backend: 'xpu' } })
  assert.ok(container.textContent.includes('--device xpu'), '选中显卡时显示真正下发的开关')
})

test('选自定义才出输入框，输入的值原样交给调用方', async () => {
  await show({ options: [AUTO, CPU, GPU], value: { kind: 'auto' } })
  assert.strictEqual(textInput(), null, '没点自定义时不该多一个空输入框')

  Simulate.change(select(), { target: { value: '__custom__' } })
  await settle()
  assert.ok(textInput(), '点了自定义要出现输入框')
  assert.strictEqual(selectedText(), '自定义…')

  Simulate.change(textInput(), { target: { value: 'cuda:0,1' } })
  await settle()
  assert.deepStrictEqual(last, { kind: 'raw', value: 'cuda:0,1' },
    '多卡串这类引擎私有写法只能原样下发，平台不换算')
  assert.ok(container.textContent.includes('原样下发：cuda:0,1'))
})

test('回读时值不在候选里：直接落回自定义，不能显示成别的选项', async () => {
  // 保存的配方里留着 cuda:0,1，而本机现在只剩 xpu 那一块卡：候选里没有它。
  await show({ options: [AUTO, CPU, GPU], value: { kind: 'raw', value: 'cuda:0,1' } })
  assert.strictEqual(selectedText(), '自定义…', '否则下拉会显示成别的卡，而请求里发的是另一个值')
  assert.strictEqual(textInput().value, 'cuda:0,1', '原值要看得见，能改')
})

test('值刚好在候选里时不进自定义模式', async () => {
  const opts = [AUTO, {
    value: { kind: 'raw', value: 'npu' }, labelZh: 'npu', labelEn: 'npu', selectable: true, sends: '--device npu',
  }]
  await show({ options: opts, value: { kind: 'raw', value: 'npu' } })
  assert.strictEqual(textInput(), null)
  assert.strictEqual(selectedText(), 'npu')
  assert.ok(container.textContent.includes('--device npu'))
})

test('选回候选项时收起输入框', async () => {
  await show({ options: [AUTO, CPU, GPU], value: { kind: 'raw', value: 'cuda:0,1' } })
  Simulate.change(select(), { target: { value: JSON.stringify({ kind: 'cpu' }) } })
  await settle()
  assert.deepStrictEqual(last, { kind: 'cpu' })
  assert.strictEqual(textInput(), null, '切回候选项后输入框要收起来')
})
