'use strict'
// 「推理入口」这一段真的能渲染：构建通过只说明模块图能打包，
// 抓不到未定义的标识符，也抓不到「下拉里根本没有候选项」。

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

const EntryChoice = loadJsx('EntryChoice.jsx', {
  react: React,
  'web/src/lib/i18n': { useT: () => ({ t: (en) => en }) },
  './entryChoiceField': loadEsm(path.join(EDITOR_DIR, 'entryChoiceField.js')),
}).default

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5299/', pretendToBeVisual: true,
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
const root = ReactDOMClient.createRoot(container)
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

const cliManifest = () => ({
  id: 'demo',
  label: 'Demo',
  call: { kind: 'cli', argv: ['{engine_python}', '-m', '_MODULE_'], bind: {}, seed: 'none' },
})

const CANDIDATES = [
  {
    file: 'src/a/b/c/infer_cli.py', module: 'a.b.c.infer_cli', srcRoot: 'src',
    score: 4, flags: 4, groups: [], source: 'file', recommended: true,
  },
  {
    file: 'cli/infer.py', module: 'cli.infer', srcRoot: null,
    score: 2, flags: 2, groups: [], source: 'file', recommended: false,
  },
]

let seq = 0
async function show (manifest, candidates) {
  seq += 1
  let state = manifest
  const draw = () => root.render(React.createElement(EntryChoice, {
    key: 'e' + seq, manifest: state, candidates,
    onChange: (arg) => { state = typeof arg === 'function' ? arg(state) : arg; draw() },
  }))
  draw()
  await settle()
  return { get: () => state }
}

test('同一个控件既能从清单选，也能直接输入；候选项按文件路径列出', async () => {
  await show(cliManifest(), CANDIDATES)
  const input = container.querySelector('input')
  assert.ok(input, '推理入口的输入框没画出来')
  assert.ok(input.getAttribute('list'), '输入框要挂 datalist，否则只能手填')
  const opts = [...container.querySelectorAll('datalist option')].map((o) => o.value)
  assert.deepStrictEqual(opts, ['src/a/b/c/infer_cli.py', 'cli/infer.py'])
  assert.strictEqual(input.value, '', '占位符不该当成已声明显示在输入框里')
  assert.ok(/Suggested/.test(container.textContent), '有扫描建议时该提示出来')
})

test('选中一个文件 ⇒ 名片里写的是模块名，工作目录按 src 布局落定', async () => {
  const holder = await show(cliManifest(), CANDIDATES)
  const input = container.querySelector('input')
  Simulate.change(input, { target: { value: 'src/a/b/c/infer_cli.py' } })
  await settle()
  assert.deepStrictEqual(holder.get().call.argv,
    ['{engine_python}', '-m', 'a.b.c.infer_cli'])
  assert.strictEqual(holder.get().call.cwd, 'engines/demo/src')
  assert.strictEqual(container.querySelector('input').value, 'src/a/b/c/infer_cli.py',
    '选完仍显示使用者选的那个文件，不跳成一串模块名')
})

test('识别不出结论时下拉为空，但输入口还在，且明确说明要选或输入', async () => {
  await show(cliManifest(), [])
  const input = container.querySelector('input')
  assert.ok(input, '没有候选时也要能直接输入模块名')
  assert.strictEqual(container.querySelectorAll('datalist option').length, 0)
  assert.ok(/Not scanned, or no Python source files were found/.test(container.textContent))
})

test('有候选但没有扫描建议：提示从清单中选，不谎称已识别', async () => {
  await show(cliManifest(), CANDIDATES.map((c) => ({ ...c, recommended: false })))
  assert.ok(/Recognition gave no conclusion/.test(container.textContent))
  assert.ok(container.querySelectorAll('datalist option').length === 2,
    '候选项照样列全，识别不出结论不等于没有选项')
})

test('手输模块名也写进名片：清单不是唯一入口', async () => {
  const holder = await show(cliManifest(), [])
  Simulate.change(container.querySelector('input'), { target: { value: 'pkg.custom' } })
  await settle()
  assert.deepStrictEqual(holder.get().call.argv, ['{engine_python}', '-m', 'pkg.custom'])
})
