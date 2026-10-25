'use strict'
// 第 4 步骨架的运行时行为：界面长什么样、拖拽落下后名片真的变了。
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

const Stage = loadJsx('Stage.jsx', {
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

test('骨架：三根骨头是平级的容器，不在一个大盒子里', async () => {
  const { container, root } = mount()
  root.render(React.createElement(Stage, {
    open: { left: false, right: false },
    onToggle: () => {},
    left: React.createElement('div', { id: 'left' }, 'L'),
    center: React.createElement('div', { id: 'center' }, 'C'),
    right: React.createElement('div', { id: 'right' }, 'R'),
  }))
  await settle()

  const html = container.innerHTML
  assert.ok(html.includes('wz-stage'), '骨架容器没渲染出来')
  // 两根边条是 aside，中栏是 main：三者平级，不是一个容器里的三格。
  assert.equal(container.querySelectorAll('aside.wz-drawer').length, 2,
    '左右两根边条该是 aside')
  assert.equal(container.querySelectorAll('main.wz-stage-main').length, 1,
    '中栏该是 main')
  // 骨架层不许有任何带边框的容器：边框套边框就是套娃。
  assert.ok(!html.includes('node-detail'), '骨架里混进了平台的详情框（紫框）')
  assert.ok(!html.includes('wz-three-zone'), '旧的三列 grid 骨架还在')
})

test('默认两边都收着：边条只露一个箭头，内容不渲染', async () => {
  const { container, root } = mount()
  root.render(React.createElement(Stage, {
    open: { left: false, right: false },
    onToggle: () => {},
    left: React.createElement('div', { id: 'left' }, 'L'),
    center: React.createElement('div', { id: 'center' }, 'C'),
    right: React.createElement('div', { id: 'right' }, 'R'),
  }))
  await settle()

  // 两边收着 ⇒ 两边的内容都不渲染，首屏只剩中栏。
  assert.ok(!container.innerHTML.includes('>L<'), '左边收着但内容还在渲染')
  assert.ok(!container.innerHTML.includes('>R<'), '右边收着但内容还在渲染')
  assert.ok(container.innerHTML.includes('>C<'), '中栏内容没渲染')

  // 两根边条各有一个箭头按钮。
  const handles = container.querySelectorAll('.wz-drawer-handle')
  assert.equal(handles.length, 2, '两根边条上各该有一个箭头按钮')
  assert.equal(handles[0].textContent.trim(), '→', '左边条该露出 →')
  assert.equal(handles[1].textContent.trim(), '←', '右边条该露出 ←')
})

test('点箭头：抽屉滑出来；没有遮罩，中栏照常能点', async () => {
  const { dom, container, root } = mount()
  const toggled = []
  const render = (open) => {
    root.render(React.createElement(Stage, {
      open,
      onToggle: (k) => toggled.push(k),
      left: React.createElement('div', { id: 'left' }, 'L'),
      center: React.createElement('div', { id: 'center' }, 'C'),
      right: React.createElement('div', { id: 'right' }, 'R'),
    }))
  }
  render({ left: false, right: false })
  await settle()

  // 展开左边抽屉。
  render({ left: true, right: false })
  await settle()
  assert.ok(container.innerHTML.includes('>L<'), '左边抽屉展开后内容没渲染')
  assert.ok(!container.innerHTML.includes('>R<'), '右边不该跟着展开')
  const leftDrawer = container.querySelector('.wz-drawer-left')
  assert.ok(leftDrawer.classList.contains('is-open'), '左边抽屉没标成展开态')

  // 抽屉上面不许有遮罩：遮罩会把中栏挡住，点中栏还会收抽屉。
  assert.ok(!container.querySelector('.wz-stage-scrim'), '抽屉展开时又盖上遮罩了')

  // 中栏照常能点：点它不该收起抽屉。
  const center = container.querySelector('.wz-stage-main')
  center.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await settle()
  assert.deepStrictEqual(toggled, [], '点中栏不该收起抽屉')
  assert.ok(leftDrawer.classList.contains('is-open'), '点中栏后抽屉被收起来了')

  // 点箭头才收得回去。
  const handle = container.querySelector('.wz-drawer-left .wz-drawer-handle')
  handle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await settle()
  assert.deepStrictEqual(toggled, ['left'], '点箭头没收左边抽屉')
})

test('箭头按钮用的是方向箭头，不是项目的 ▸', async () => {
  const { container, root } = mount()
  root.render(React.createElement(Stage, {
    open: { left: false, right: false },
    onToggle: () => {},
    left: React.createElement('div', { id: 'left' }, 'L'),
    center: React.createElement('div', { id: 'center' }, 'C'),
    right: React.createElement('div', { id: 'right' }, 'R'),
  }))
  await settle()

  const handles = container.querySelectorAll('.wz-drawer-handle')
  const labels = [...handles].map((h) => h.textContent.trim())
  assert.deepStrictEqual(labels, ['→', '←'],
    '两根边条的箭头应当是 → 与 ←（Owner 指定的符号）')
  // 不用 < 和 > 当图标：那两个在 HTML 里是标签，会被解析成别的意思。
  for (const l of labels) {
    assert.ok(!l.includes('<') && !l.includes('>'),
      '按钮里还有 < 或 > 当图标：' + JSON.stringify(l))
  }
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
