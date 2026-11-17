'use strict'
// 参数行的明细表默认收起：select 的候选、vector 的维度、boolean 的否定式开关
// 各占一大块，一次扫描进来十几二十行时，主行那五列会被挤得看不见。
// 这里渲染真的 ParamRow，只把下拉换成原生替身。

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

const MODULES = {}
function loadEsm (name) {
  if (MODULES[name]) return MODULES[name]
  const code = esbuild().transformSync(fs.readFileSync(path.join(EDITOR_DIR, name + '.js'), 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, (id) => loadEsm(
    String(id).replace(/^\.\//, '').replace(/\.js$/, '')), mod)
  MODULES[name] = mod.exports
  return mod.exports
}

function loadJsx (file, stubMap) {
  const code = esbuild().transformSync(fs.readFileSync(path.join(EDITOR_DIR, file), 'utf8'),
    { loader: 'jsx', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  const stub = (id) => {
    for (const [k, v] of Object.entries(stubMap)) {
      if (id === k || id.endsWith(k)) return v
    }
    const pure = String(id).replace(/^\.\//, '').replace(/\.js$/, '')
    if (MODULES[pure]) return MODULES[pure]
    if (id === './paramDrop' || id === './paramFields') return loadEsm(pure)
    if (id.endsWith('components/common/Select')) return require('./_selectStub.js')
    throw new Error(file + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, path.join(EDITOR_DIR, file), EDITOR_DIR)
  return mod.exports
}

const ParamRow = loadJsx('ParamRow.jsx', {
  react: React,
  'web/src/lib/i18n': { useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) },
}).default

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5199/', pretendToBeVisual: true,
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
define('requestAnimationFrame', (cb) => setTimeout(() => cb(1), 0))
define('cancelAnimationFrame', (id) => clearTimeout(id))

const container = dom.window.document.getElementById('root')
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

let root = null
let seq = 0
async function show (entry, extra = {}) {
  seq += 1
  if (!root) root = ReactDOMClient.createRoot(container)
  root.render(React.createElement(ParamRow, {
    key: 'r' + seq,
    entry, index: 0, spec: {}, argv: '--x', argStyle: '',
    scanned: [], onChange: () => {}, onDelete: () => {},
    ...extra,
  }))
  await settle()
}

const buttons = () => [...container.querySelectorAll('button')]
const buttonWith = (text) => buttons().find((b) => b.textContent.includes(text))

test('select 行的候选表默认收起，点一下才摊开', async () => {
  await show({ name: 'lang', type: 'select', tier: 'common', choices: [{ value: 'zh' }, { value: 'en' }] })
  const btn = buttonWith('选项（2）')
  assert.ok(btn, '没找到选项的折叠开关')
  assert.strictEqual(btn.getAttribute('aria-expanded'), 'false', '默认应当是收起的')
  assert.strictEqual(container.querySelectorAll('.wz-param-table-row').length, 0,
    '收起时不该渲染候选行')
  Simulate.click(btn)
  await settle()
  assert.strictEqual(buttonWith('选项（2）').getAttribute('aria-expanded'), 'true')
  assert.ok(container.querySelectorAll('.wz-param-table-row').length >= 2, '展开后要看到候选行')
})

test('vector 行的维度表默认收起，点一下才摊开', async () => {
  await show({ name: 'emotion', type: 'vector', tier: 'common',
    dim_labels: [{ zh: '喜' }, { zh: '怒' }], suggested_value: [null, null] })
  const btn = buttonWith('维度（2）')
  assert.ok(btn, '没找到维度的折叠开关')
  assert.strictEqual(container.querySelectorAll('.wz-param-table-row').length, 0)
  Simulate.click(btn)
  await settle()
  assert.ok(container.querySelectorAll('.wz-param-table-row').length >= 2)
})

test('boolean 行只说一句现状，点开才给否定式开关', async () => {
  await show({ name: 'normalize', type: 'boolean', tier: 'common' })
  const btn = buttonWith('否定式开关：未启用')
  assert.ok(btn, '没找到否定式开关的折叠入口')
  assert.strictEqual(container.querySelectorAll('.wz-param-bool-row').length, 0)
  Simulate.click(btn)
  await settle()
  assert.strictEqual(container.querySelectorAll('.wz-param-bool-row').length, 1)
})
