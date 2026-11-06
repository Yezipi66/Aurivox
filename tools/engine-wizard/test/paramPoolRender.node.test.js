'use strict'
// 左栏参数卡的两件事：必填排序（由 paramPoolOrder 保证，这里验渲染出来的徽标）、
//   以及「已经落进名片」的卡弱化但仍可拖动：只弱化不锁死，同一个参数可以喂两个槽位。
// 还有分组下拉的措辞：(root) 说成「顶层」，其余是上游子命令名，原样保留。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { JSDOM } = require(resolveFromRoot('jsdom'))

function loadEsm (file) {
  const code = esbuild().transformSync(fs.readFileSync(file, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(
    mod.exports, () => { throw new Error(path.basename(file) + ' 不该有依赖') }, mod)
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
    throw new Error(file + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, path.join(EDITOR_DIR, file), EDITOR_DIR)
  return mod.exports
}

const i18n = { useT: () => ({ t: (en, zh) => (zh === undefined ? en : zh) }) }

const ParamPool = loadJsx('ParamPool.jsx', {
  react: React,
  'web/src/lib/i18n': i18n,
  './paramType': loadEsm(path.join(EDITOR_DIR, 'paramType.js')),
  './paramPoolOrder': loadEsm(path.join(EDITOR_DIR, 'paramPoolOrder.js')),
}).default

const EngineScanZone = loadJsx('EngineScanZone.jsx', {
  react: React,
  'web/src/lib/i18n': i18n,
  './ParamPool': () => React.createElement('div', { 'data-stub': 'pool' }),
  './groupLabel': loadEsm(path.join(EDITOR_DIR, 'groupLabel.js')),
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
define('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0))
define('cancelAnimationFrame', (id) => clearTimeout(id))

const container = dom.window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)
const settle = () => new Promise((r) => setTimeout(r, 30))

const P = (name, extra) => ({
  source: 'cli', name, target: '--' + name, kind: 'str', style: 'value',
  kind_certain: true, required: false, group: '(root)', is_tool: false, help: null,
  ...extra,
})

const cards = () => [...container.querySelectorAll('.wz-param-item')]

test('已落进名片的参数卡弱化显示，但仍然可拖', async () => {
  const params = [P('text'), P('voice'), P('unused')]
  root.render(React.createElement(ParamPool, {
    params, selected: null,
    used: (p) => p.name === 'text' || p.name === 'voice',
    onSelect: () => {}, onDragStart: () => {},
  }))
  await settle()
  const list = cards()
  assert.equal(list.length, 3)
  assert.match(list[0].className, /wz-param-item-used/, '已用：text')
  assert.match(list[1].className, /wz-param-item-used/, '已用：voice')
  assert.doesNotMatch(list[2].className, /wz-param-item-used/, '没用过的卡不弱化')
  for (const el of list) {
    assert.equal(el.getAttribute('draggable'), 'true',
      '弱化不等于锁死：已用的卡仍要能再拖一次（换格或复用）')
  }
  assert.match(list[0].getAttribute('title'), /再次拖动/, '标题里要说明还能再拖')
})

test('必填参数排在最前并挂「必填」徽标', async () => {
  const params = [P('voice'), P('text', { required: true })]
  root.render(React.createElement(ParamPool, {
    params, selected: null, used: () => false,
    onSelect: () => {}, onDragStart: () => {},
  }))
  await settle()
  const list = cards()
  assert.match(list[0].textContent, /--text/, '必填排到最前')
  assert.match(list[0].textContent, /必填/, '必填要有徽标')
  assert.doesNotMatch(list[1].textContent, /必填/)
})

test('分组下拉：(root) 说成「顶层」，其余保持上游子命令名', async () => {
  root.render(React.createElement(EngineScanZone, {
    params: [], selected: null, onSelect: () => {}, onDragStart: () => {},
    groups: ['(root)', 'init', 'batch'], group: '(root)', onGroupChange: () => {},
    busy: false, err: null,
  }))
  await settle()
  const opts = [...container.querySelectorAll('option')].map((o) => o.textContent.trim())
  assert.deepStrictEqual(opts,
    ['全部分组', '顶层（无子命令）', 'init（初始化配置）', 'batch（批处理）'],
    '原名在前、中文注在括号里')
  assert.match(container.textContent, /括号前是命令行上要敲的子命令原名/)
})
