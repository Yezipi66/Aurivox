'use strict'
// 三栏工作台的运行时行为：界面长什么样、拖拽落下后名片真的变了。
//
// 这一层测的是「组件跑起来对不对」，和 paramDrop.node.test.js 测的
// 「纯函数算得对不对」是两回事：那个函数算对了但没人把它的结果接到
// 名片上，这里就看不见。
//
// 用 jsdom + 真 React 渲染，不开浏览器：向导页要后端在跑才能测全流程，
// 而这里要验的是组件收到拖拽后写了什么，直接驱动组件更快也更准。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')

const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { JSDOM } = require(resolveFromRoot('jsdom'))

/** 编译并加载一个 JSX 模块；外部依赖用 stub。 */
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

const i18nStub = { useT: () => ({ t: (en) => en }) }

const ThreeZone = loadJsx('ThreeZone.jsx', {
  react: React,
  'web/src/lib/i18n': i18nStub,
}).default

const ParamDropZone = loadJsx('ParamDropZone.jsx', {
  react: React,
  'web/src/lib/i18n': i18nStub,
  'paramType': require(path.join(EDITOR_DIR, 'paramType.js')),
}).default

/** 起一个 jsdom 页面，返回容器与 React 根。 */
function mount () {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:5199/',
    pretendToBeVisual: true,
  })
  // 新版 Node 的 globalThis.navigator 是只读的 getter，直接赋值会抛
  // 「Cannot set property navigator」⇒ 一律走 defineProperty。
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
  return { dom, container, root: ReactDOMClient.createRoot(container) }
}

/** 等 React 把这一轮画完。 */
const settle = () => new Promise((r) => setTimeout(r, 30))

/** 造一个真的 drop 事件：jsdom 不带 DragEvent，用 Event 加 dataTransfer 补上。 */
function dropEvent (dom, payload) {
  const dt = {
    data: { 'text/plain': JSON.stringify(payload) },
    getData: (type) => dt.data[type] || '',
    setData: (type, val) => { dt.data[type] = val },
    effectAllowed: 'all',
    dropEffect: 'move',
    types: ['text/plain'],
  }
  const ev = new dom.window.Event('drop', { bubbles: true, cancelable: true })
  ev.dataTransfer = dt
  return ev
}

const CLI_PARAM = {
  source: 'cli', name: 'speed', target: '--speed', kind: 'number', style: 'value',
}

test('三栏骨架：三列都排出来了，内容各自在自己的列里', async () => {
  const { container, root } = mount()
  root.render(React.createElement(ThreeZone, {
    collapsed: { left: false, right: false },
    onToggle: () => {},
    left: React.createElement('div', { id: 'left' }, 'L'),
    center: React.createElement('div', { id: 'center' }, 'C'),
    right: React.createElement('div', { id: 'right' }, 'R'),
  }))
  await settle()

  const html = container.innerHTML
  assert.ok(html.includes('wz-three-zone'), '三栏容器没渲染出来')
  // 这一层不画栏头：栏头是内容自己带的（主界面里每一块内容都是 .section）。
  assert.ok(!html.includes('wz-zone-hdr'), '这一层不该造栏头，栏头由内容的 .section 带')
  assert.ok(!html.includes('wz-zone-title'), '这一层不该造栏标题')
  // 三列各用项目现成的列容器：左栏与中栏是 .workspace-left，右栏是 .workspace-right。
  assert.equal(container.querySelectorAll('.workspace-left').length, 2,
    '左栏与中栏该各用 .workspace-left')
  assert.equal(container.querySelectorAll('.workspace-right').length, 1,
    '右栏该用 .workspace-right')
  assert.ok(html.includes('>L<') && html.includes('>C<') && html.includes('>R<'), '栏里的内容没渲染')
})

test('收起的栏：内容不渲染，留一条能点回来的窄轨', async () => {
  const { dom, container, root } = mount()
  const toggled = []
  const render = (collapsed) => {
    root.render(React.createElement(ThreeZone, {
      collapsed,
      onToggle: (k) => toggled.push(k),
      left: React.createElement('div', { id: 'left' }, 'L'),
      center: React.createElement('div', { id: 'center' }, 'C'),
      right: React.createElement('div', { id: 'right' }, 'R'),
    }))
  }
  render({ left: false, right: false })
  await settle()

  const grid = container.querySelector('.wz-three-zone')
  const cols = () => grid.style.gridTemplateColumns
  assert.match(cols(), /^260px minmax\(0, 1fr\) 380px$/, '三栏展开时的列宽不对')

  // 收起左栏。
  render({ left: true, right: false })
  await settle()
  assert.match(cols(), /^40px minmax\(0, 1fr\) 380px$/, '收起左栏后列宽没让出来')
  assert.ok(!container.innerHTML.includes('>L<'), '收起后左栏内容还在渲染')
  assert.ok(container.innerHTML.includes('>C<'), '收起左栏不该影响中栏')

  // 窄轨上那个按钮点得回来。
  const railBtn = container.querySelector('.wz-rail button[aria-expanded]')
  assert.ok(railBtn, '窄轨上没有展开按钮，这一栏再也展不开')
  railBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await settle()
  assert.deepStrictEqual(toggled, ['left'], '窄轨按钮没把 left 这个键传出去')

  // 收起右栏。
  render({ left: false, right: true })
  await settle()
  assert.match(cols(), /^260px minmax\(0, 1fr\) 40px$/, '收起右栏后列宽没让出来')
  assert.ok(!container.innerHTML.includes('>R<'), '收起后右栏内容还在渲染')
})

test('窄轨按钮用项目的 ▸，不用 < 和 >', async () => {
  const { container, root } = mount()
  root.render(React.createElement(ThreeZone, {
    collapsed: { left: true, right: false },
    onToggle: () => {},
    left: React.createElement('div', { id: 'left' }, 'L'),
    center: React.createElement('div', { id: 'center' }, 'C'),
    right: React.createElement('div', { id: 'right' }, 'R'),
  }))
  await settle()

  const btn = container.querySelector('.wz-rail button[aria-expanded]')
  assert.equal(btn.textContent.trim(), '▸',
    '窄轨上的箭头应当是 ▸（项目现成的符号），不用 < 和 >')
  const label = btn.textContent.trim()
  assert.ok(!label.includes('<') && !label.includes('>'),
    '按钮里还有 < 或 > 当图标：' + JSON.stringify(label))
})

test('拖一个 cli 参数进落点：parameters[] 多一条，call.args 同时写上 flag', async () => {
  const { dom, container, root } = mount()
  let manifest = { id: 'x', call: { kind: 'cli', args: {} } }
  const changed = []
  root.render(React.createElement(ParamDropZone, {
    manifest,
    onChange: (m) => { manifest = m; changed.push(m) },
    params: manifest.parameters || [],
    selectedParam: null,
    spec: { sections: [] },
    ParamRow: () => null,
  }))
  await settle()

  const dropEl = container.querySelector('.wz-dropzone')
  assert.ok(dropEl, '落点区没渲染出来')
  dropEl.dispatchEvent(dropEvent(dom, CLI_PARAM))
  await settle()

  assert.ok(changed.length >= 1, '落下后名片没变')
  assert.equal(manifest.parameters.length, 1)
  assert.equal(manifest.parameters[0].name, 'speed')
  assert.equal(manifest.parameters[0].type, 'number', '类型没按扫到的 kind 映射')
  assert.deepStrictEqual(manifest.call.args.speed, { flag: '--speed', style: 'value' },
    'cli 形态没写 call.args，宿主会当场拒')
})

test('已有名片：原 call.args 原样保留，新参数照样进 parameters[]', async () => {
  const { dom, container, root } = mount()
  let manifest = { id: 'x', call: { kind: 'cli', args: { speed: { flag: '--my-speed' } } } }
  root.render(React.createElement(ParamDropZone, {
    manifest,
    onChange: (m) => { manifest = m },
    params: [],
    selectedParam: null,
    spec: { sections: [] },
    ParamRow: () => null,
  }))
  await settle()

  container.querySelector('.wz-dropzone').dispatchEvent(dropEvent(dom, CLI_PARAM))
  await settle()

  assert.equal(manifest.call.args.speed.flag, '--my-speed',
    '用户手填过的映射被扫描结果盖掉了')
  assert.equal(manifest.parameters.length, 1)
  assert.equal(manifest.parameters[0].name, 'speed')
})

test('python 形态：参数进 parameters[]，不写 call.args', async () => {
  const { dom, container, root } = mount()
  let manifest = { id: 'y', call: { kind: 'python', module: 'x', method: 'y' } }
  root.render(React.createElement(ParamDropZone, {
    manifest,
    onChange: (m) => { manifest = m },
    params: [],
    selectedParam: null,
    spec: { sections: [] },
    ParamRow: () => null,
  }))
  await settle()

  container.querySelector('.wz-dropzone').dispatchEvent(dropEvent(dom, {
    source: 'python', name: 'speed', target: 'speed', kind: 'int',
  }))
  await settle()

  assert.equal(manifest.parameters.length, 1)
  assert.equal(manifest.parameters[0].name, 'speed')
  assert.equal(manifest.call.args, undefined, 'python 形态的名片里写 args 段，存的时候会被拒')
})
