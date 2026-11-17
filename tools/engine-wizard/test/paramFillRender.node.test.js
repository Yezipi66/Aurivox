'use strict'
// 「合成参数」区真的能把类型补齐：手敲开关加进来的行一律停在 text，
// 按扫描结果定类型这个动作要能从界面上点到、点完真的写进名片。
//
// 这里渲染的是真组件（ParamDropZone），参数行用替身：这一组测的是
// 「按钮出不出、点击改了什么」，不是参数行长什么样。

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

// 纯函数模块：编辑器里这几个文件互相 import，编译成 CJS 后按文件名登记。
// 注意登记的是跑完之后的对象：esbuild 对 ESM 输入会整份替换 module.exports。
const MODULES = {}
function loadEsm (name) {
  if (MODULES[name]) return MODULES[name]
  const file = path.join(EDITOR_DIR, name + '.js')
  const code = esbuild().transformSync(fs.readFileSync(file, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, (id) => loadEsm(
    String(id).replace(/^\.\//, '').replace(/\.js$/, '')), mod)
  MODULES[name] = mod.exports
  return mod.exports
}

const PARAM_DROP = loadEsm('paramDrop')

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

const ParamDropZone = loadJsx('ParamDropZone.jsx', {
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

// 扫到的四条：类型都写明，一条带候选值，一条上游没写明类型。
const SCANNED = [
  { source: 'cli', name: 'guidance-scale', target: '--guidance-scale', kind: 'number',
    kind_certain: true, style: 'value', default: 1.5, help: 'scale of CFG', group: 'infer' },
  { source: 'cli', name: 'seed', target: '--seed', kind: 'number',
    kind_certain: true, style: 'value', help: 'random seed', group: 'infer' },
  { source: 'cli', name: 'tokenizer', target: '--tokenizer', kind: 'str',
    kind_certain: true, style: 'value', choices: ['espeak', 'pinyin'], help: 'tokenizer', group: 'infer' },
  { source: 'cli', name: 'raw-evaluation', target: '--raw-evaluation', kind: 'str',
    kind_certain: false, style: 'value', help: 'raw evaluation', group: 'infer' },
]

// 参数行的替身：只把名片里的类型打出来，够断言就够了。
function RowStub ({ entry }) {
  return React.createElement('div', { className: 'row-stub' }, entry.name + '|' + (entry.type || 'text'))
}

// 21 行全部停在 text：与手敲开关 / 从别处粘进来的名片一致。
const ROWS = [
  'guidance-scale', 'seed', 'tokenizer', 'raw-evaluation', 'num-step', 'speed',
  't-shift', 'target-rms', 'feat-scale', 'max-duration', 'num-thread', 'model-name',
  'model-dir', 'checkpoint-name', 'vocoder-path', 'lang', 'test-list', 'res-dir',
  'res-wav-path', 'remove-long-sil', 'trt-engine-path',
// 英文名都填上：这几条只测类型补齐，英文名那条路由另有测试守。
].map((name) => ({ name, type: 'text', tier: 'common', label: { en: name } }))

let changed = null
function Host ({ rows = ROWS }) {
  const [mf, setMf] = React.useState({
    id: 'demo',
    call: { kind: 'cli', argv: ['{engine_python}'], args: {} },
    parameters: rows,
  })
  return React.createElement(ParamDropZone, {
    manifest: mf,
    params: mf.parameters,
    onChange: (next) => { changed = next; setMf(next) },
    selectedParam: null,
    spec: {},
    ParamRow: RowStub,
    scanned: SCANNED,
    guessed: new Set(),
    onParamDropped: () => {},
    onTypeConfirmed: () => {},
  })
}

let root = null
let seq = 0
async function show (rows) {
  seq += 1
  changed = null
  if (!root) root = ReactDOMClient.createRoot(container)
  root.render(React.createElement(Host, { key: 'h' + seq, rows }))
  await settle()
}

const buttons = (text) => [...container.querySelectorAll('button')]
  .filter((b) => b.textContent.trim() === text)
const rowTexts = () => [...container.querySelectorAll('.row-stub')].map((e) => e.textContent)

test('21 行都停在 text 时，区里给出「按扫描结果定类型」并写明数量', async () => {
  await show()
  assert.strictEqual(buttons('按扫描结果定类型（3）').length, 1,
    '只数类型真会变的那几行：raw-evaluation 按扫描结果仍是文本，不算')
  assert.ok(rowTexts().every((t) => t.endsWith('|text')), '前提：这些行确实都停在 text')
})

test('点一下：扫到的行换成扫描结果的类型，扫不到的保持原样', async () => {
  await show()
  Simulate.click(buttons('按扫描结果定类型（3）')[0])
  await settle()
  const types = Object.fromEntries(changed.parameters.map((p) => [p.name, p.type]))
  assert.strictEqual(types['guidance-scale'], 'number')
  assert.strictEqual(types.seed, 'number')
  assert.strictEqual(types.tokenizer, 'select', '上游给了候选值就是下拉')
  assert.strictEqual(types['num-step'], 'text', '扫描结果里没有的开关不瞎猜')
  assert.strictEqual(changed.parameters.length, 21, '不能顺手删行或加行')
  assert.strictEqual(changed.parameters[0].suggested_value, 1.5, '上游默认值成为界面初值')
})

test('补齐之后按钮消失：没有可补的行就不留一个点了没反应的入口', async () => {
  await show()
  Simulate.click(buttons('按扫描结果定类型（3）')[0])
  await settle()
  assert.strictEqual(buttons('按扫描结果定类型（3）').length, 0)
})

test('人挑过类型的行不参与补齐，也不出现在数量里', async () => {
  const rows = [
    { name: 'guidance-scale', type: 'select', tier: 'common', choices: [{ value: '0.7' }], label: { en: 'guidance-scale' } },
    { name: 'seed', type: 'number', tier: 'common', label: { en: 'seed' } },
  ]
  await show(rows)
  assert.strictEqual(buttons('按扫描结果定类型（2）').length, 0,
    '两行都已定过类型，按钮不该出现')
})
