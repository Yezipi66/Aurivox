'use strict'
// 全局逃生口（EngineEscapeHatch）的行为守卫：
//   ① 只渲染一个引擎下拉（一列），值绑全局目标 id；
//   ② 换选即回调 onPick（App 里落成 setWz({...cur, id})）；
//   ③ 只在第 2-5 步渲染（第 1 步是克隆，不选已有引擎）；
//   ④ 第 4 步的 EngineIdentity 下拉换引擎时也同步全局目标（onEngineTarget）。
//
// 组件行为用 jsdom 真渲染（照 engineSwitch.node.test.js 的写法）；
// App.jsx 的门控与 EngineIdentity 的同步用源码断言（照 manifestLayout 的写法）。

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

const DIRS = [
  { id: 'piper', manifestPresent: false },
  { id: 'spark-tts', manifestPresent: true },
]

const EngineEscapeHatch = loadJsx('EngineEscapeHatch.jsx', {
  react: React,
  'web/src/lib/i18n': i18nStub,
}).default

/** 起一个 jsdom 页面。 */
function mount () {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:5199/',
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
  return { dom, container, root: ReactDOMClient.createRoot(container) }
}

const settle = () => new Promise((r) => setTimeout(r, 40))

test('只渲染一个引擎下拉，值绑全局目标 id', async () => {
  const { container, root } = mount()
  root.render(React.createElement(EngineEscapeHatch, {
    id: 'piper', dirs: DIRS, onPick: () => {},
  }))
  await settle()
  const sels = container.querySelectorAll('select')
  assert.strictEqual(sels.length, 1, '逃生口只该有一个下拉（一列）')
  assert.strictEqual(sels[0].value, 'piper', '下拉值应绑全局目标 id')
})

test('换选即回调 onPick（App 落成 setWz({...cur, id})）', async () => {
  const { dom, container, root } = mount()
  const picked = []
  root.render(React.createElement(EngineEscapeHatch, {
    id: 'piper', dirs: DIRS, onPick: (id) => picked.push(id),
  }))
  await settle()
  const sel = container.querySelector('select')
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'spark-tts')
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await settle()
  assert.deepStrictEqual(picked, ['spark-tts'], '换选要回调 onPick 并把新 id 传出去')
})

test('没有目标时显示占位项，不崩', async () => {
  const { container, root } = mount()
  root.render(React.createElement(EngineEscapeHatch, {
    id: '', dirs: DIRS, onPick: () => {},
  }))
  await settle()
  const sel = container.querySelector('select')
  assert.strictEqual(sel.value, '', '空目标应显示占位项')
  assert.strictEqual(sel.options.length, DIRS.length + 1, '占位 + 每个引擎一项')
})

// ---- App.jsx 的门控：逃生口只在第 2-5 步渲染，顶部不再有全局下拉 ----
test('App.jsx 不再有顶部「当前引擎」下拉', () => {
  const app = fs.readFileSync(path.join(EDITOR_DIR, 'App.jsx'), 'utf8')
  assert.ok(!/wz-engine-pick/.test(app),
    '顶部「当前引擎」下拉还在（wz-engine-pick）：应已移除，改由每步的逃生口承担')
})

test('App.jsx 渲染逃生口，且门控排除第 1 步', () => {
  const app = fs.readFileSync(path.join(EDITOR_DIR, 'App.jsx'), 'utf8')
  assert.ok(/EngineEscapeHatch/.test(app), 'App.jsx 没有渲染逃生口')
  assert.ok(/page !== 'prepare'/.test(app),
    '逃生口没排除第 1 步：第 1 步是克隆，不该出现「选已有引擎」')
})

// ---- EngineIdentity 换引擎时同步全局目标 ----
test('EngineIdentity 换引擎回调 onEngineTarget（同步全局目标）', () => {
  const identity = fs.readFileSync(path.join(EDITOR_DIR, 'EngineIdentity.jsx'), 'utf8')
  assert.ok(/onEngineTarget/.test(identity),
    'EngineIdentity 没接 onEngineTarget：第 4 步换引擎不同步全局目标')
})

// ---- 「能用」打绿勾：usable 引擎的 option 带 ✓ 前缀 ----
test('usable 引擎的 option 带 ✓ 前缀，不可用不带', async () => {
  const { container, root } = mount()
  const dirs = [
    { id: 'piper', manifestPresent: false, usable: false },
    { id: 'gpt-sovits', manifestPresent: true, usable: true },
  ]
  root.render(React.createElement(EngineEscapeHatch, {
    id: '', dirs, onPick: () => {},
  }))
  await settle()
  const sel = container.querySelector('select')
  const byId = {}
  for (const o of sel.options) byId[o.value] = o.textContent
  assert.ok(byId['gpt-sovits'].startsWith('✓ '),
    'usable 引擎的 option 该以 ✓ 开头：' + JSON.stringify(byId['gpt-sovits']))
  assert.ok(!byId['piper'].startsWith('✓ '),
    '不可用引擎的 option 不该有 ✓：' + JSON.stringify(byId['piper']))
})
