'use strict'
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

function loadEsm (file) {
  const code = esbuild().transformSync(fs.readFileSync(file, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(
    mod.exports, () => { throw new Error(path.basename(file) + ' 不该有依赖') }, mod)
  return mod.exports
}

function loadJsx (file, stubs) {
  const code = esbuild().transformSync(fs.readFileSync(path.join(EDITOR_DIR, file), 'utf8'),
    { loader: 'jsx', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  const stub = (id) => {
    for (const [k, v] of Object.entries(stubs)) {
      if (id === k || id.endsWith(k)) return v
    }
    throw new Error(file + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, path.join(EDITOR_DIR, file), EDITOR_DIR)
  return mod.exports
}

const ModeCards = loadJsx('ModeCards.jsx', {
  react: React,
  'web/src/lib/i18n': { useT: () => ({ t: (en, zh) => zh || en }) },
  './entryChoiceField': loadEsm(path.join(EDITOR_DIR, 'entryChoiceField.js')),
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

function baseCard () {
  return {
    id: 'demo', label: 'Demo',
    runtime: { python: 'engines/demo/.venv', checkpoints: 'engines/demo/checkpoints' },
    models: { required: ['a.bin'] },
    capabilities: { requires_reference_audio: false },
    call: { kind: 'cli',
      argv: ['{engine_python}', '-m', 'demo', '--model-path', '{checkpoints}'],
      cwd: 'engines/demo', bind: { text: '--text', output_path: '--output' } },
    parameters: [{ name: 'speed', type: 'number' }],
  }
}

const buttons = () => [...container.querySelectorAll('button')]
const clickText = (needle) => {
  const b = buttons().find((x) => x.textContent.includes(needle))
  assert.ok(b, '按钮不存在：' + needle)
  Simulate.click(b)
}

let seq = 0
async function show () {
  seq += 1
  root.render(React.createElement(ModeCards, {
    key: 'mc' + seq, manifest: baseCard(), onDone: () => {},
  }))
  await settle()
}

test('组件渲染不白屏，展开后说明默认保持一张尽量全的名片', async () => {
  await show()
  assert.ok(buttons().some((b) => b.textContent.includes('按模式生成名片')))
  clickText('按模式生成名片')
  await settle()
  assert.ok(container.textContent.includes('共用同一份环境和权重'))
  assert.ok(container.textContent.includes('请先保存基础名片'))
})

test('读取模式后列出子命令，勾选两个模式一次生成两张派生名片', async () => {
  const calls = []
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse((opts && opts.body) || '{}') })
    if (url.includes('/wizard/cli-args')) {
      return { json: async () => ({ ok: true, subcommands: ['(root)', 'design', 'clone', 'batch'] }) }
    }
    return { json: async () => ({ ok: true, count: 2, results: [
      { id: 'demo-design', ok: true, dryRun: true },
      { id: 'demo-clone', ok: true, dryRun: true },
    ], shared: {} }) }
  }
  await show()
  clickText('按模式生成名片')
  await settle()
  clickText('读取可用模式')
  await settle()

  const rows = [...container.querySelectorAll('tbody tr')]
  assert.strictEqual(rows.length, 3, '(root) 不单列，其余三个模式都在表里')
  assert.ok(container.textContent.includes('design'))
  assert.ok(container.textContent.includes('clone'))

  // 选用列是每行的第一个 checkbox。
  const firstCol = rows.map((tr) => tr.querySelector('input[type=checkbox]'))
  Simulate.change(firstCol[0], { target: { checked: true } })
  Simulate.change(firstCol[1], { target: { checked: true } })
  await settle()

  clickText('预览')
  await settle()
  const cardCall = calls.find((c) => c.url === '/wizard/cards')
  assert.ok(cardCall, '没有调用批量保存端点')
  assert.strictEqual(cardCall.body.variants.length, 2)
  assert.strictEqual(cardCall.body.dryRun, true)
  assert.strictEqual(cardCall.body.base.runtime.python, 'engines/demo/.venv')
  assert.strictEqual(cardCall.body.base.runtime.checkpoints, 'engines/demo/checkpoints')
  assert.ok(cardCall.body.variants[0].argv.includes('design'))
  assert.ok(cardCall.body.variants[1].argv.includes('clone'))
  assert.ok(container.textContent.includes('demo-design'))
})
