'use strict'
// 参数行收起来时必须只剩一行：明细表的开合按钮在行尾，和删除按钮同一排，
// 收起时不渲染任何第二行的内容。这里渲染真的 ParamRow，只把下拉换成原生替身。

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

// 行尾的开合按钮：唯一带 aria-expanded 的那一个。
const toggle = () => container.querySelector('.wz-param-tail button[aria-expanded]')
const inTail = (el) => !!(el && el.closest('.wz-param-tail'))

test('select 行收起时只有主行一行：开合按钮在行尾，明细表不渲染', async () => {
  await show({ name: 'lang', type: 'select', tier: 'common', choices: [{ value: 'zh' }, { value: 'en' }] })
  const btn = toggle()
  assert.ok(btn, 'select 行要有开合按钮')
  assert.ok(inTail(btn), '开合按钮要摆在行尾，不能独占第二行')
  assert.strictEqual(btn.getAttribute('aria-expanded'), 'false', '默认应当是收起的')
  assert.strictEqual(container.querySelectorAll('.wz-param-table').length, 0,
    '收起时不该渲染明细表（它会把这一行撑成两行）')
  Simulate.click(btn)
  await settle()
  assert.strictEqual(toggle().getAttribute('aria-expanded'), 'true')
  assert.ok(container.querySelectorAll('.wz-param-table-row').length >= 2, '展开后要看到候选行')
})

test('vector 行收起时只有主行一行，展开才铺维度表', async () => {
  await show({ name: 'emotion', type: 'vector', tier: 'common',
    dim_labels: [{ zh: '喜' }, { zh: '怒' }], suggested_value: [null, null] })
  const btn = toggle()
  assert.ok(btn && inTail(btn), 'vector 行也要有摆在行尾的开合按钮')
  assert.strictEqual(container.querySelectorAll('.wz-param-table-row').length, 0)
  Simulate.click(btn)
  await settle()
  assert.ok(container.querySelectorAll('.wz-param-table-row').length >= 2)
})

test('boolean 行收起时只有主行一行，展开才给否定式开关', async () => {
  await show({ name: 'normalize', type: 'boolean', tier: 'common' })
  const btn = toggle()
  assert.ok(btn && inTail(btn), 'boolean 行也要有摆在行尾的开合按钮')
  assert.strictEqual(container.querySelectorAll('.wz-param-bool-row').length, 0)
  Simulate.click(btn)
  await settle()
  assert.strictEqual(container.querySelectorAll('.wz-param-bool-row').length, 1)
})

test('没有明细表的类型不摆开合按钮：text / number / file 就是一行', async () => {
  for (const type of ['text', 'number', 'file']) {
    await show({ name: 'x-' + type, type, tier: 'common' })
    assert.strictEqual(toggle(), null, type + ' 没有明细表，不该有开合按钮')
    assert.strictEqual(container.querySelectorAll('.wz-param-table').length, 0)
  }
})

test('手敲一个扫到的开关，类型与推测徽标一并补上', async () => {
  // 照上游 README 抄命令是常见路径：手敲开关之后，类型、说明、候选值都要跟上，
  //   否则这一行停在 text，合成页上长成一个文本框。
  let picked = null
  let marked = null
  const scanned = [
    { source: 'cli', name: 'output-dir', target: '--output-dir', kind: 'str', kind_certain: false,
      style: 'value', help: 'Directory for outputs' },
  ]
  await show({ name: '', type: 'text', tier: 'common' }, {
    scanned,
    onChange: (i, next) => { picked = next },
    onTypeGuessed: (param, name) => { marked = { param, name } },
  })
  const input = container.querySelector('.wz-param-argv')
  assert.ok(input, '参数行要有命令行开关输入框')
  Simulate.change(input, { target: { value: '--output-dir' } })
  await settle()
  assert.ok(picked, '敲开关之后要写回名片')
  assert.strictEqual(picked.name, 'output-dir', '参数名由开关派生')
  assert.strictEqual(picked.type, 'file', '说明里写着目录，类型要认成 file')
  assert.ok(marked, '类型来自扫描结果的，要通知外层标推测')
})
