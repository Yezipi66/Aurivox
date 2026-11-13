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

const TIERED = [
  { file: 'pkg/infer_cli.py', module: 'pkg.infer_cli', srcRoot: null, score: 4, flags: 4,
    groups: [], source: 'file', recommended: true, tier: 'recommended', aux: false },
  { file: 'pkg/utils.py', module: 'pkg.utils', srcRoot: null, score: 0, flags: 0,
    groups: [], source: 'file', recommended: false, tier: 'source', aux: false },
  { file: 'demo/tts_demo.py', module: 'demo.tts_demo', srcRoot: null, score: 0, flags: 0,
    groups: [], source: 'file', recommended: false, tier: 'aux', aux: true },
]

const listSelect = () => [...container.querySelectorAll('select')]
  .find((s) => s.getAttribute('aria-label') === 'Pick from scanned files')

let seq = 0
async function show (manifest, candidates, extra = {}) {
  seq += 1
  let state = manifest
  const draw = () => root.render(React.createElement(EntryChoice, {
    key: 'e' + seq, manifest: state, candidates, ...extra,
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

test('入口挂多个子命令时给出下拉，选中的词写进命令行模块名之后', async () => {
  const withGroups = [{
    file: 'cli/main.py', module: 'cli.main', srcRoot: null,
    score: 4, flags: 6, groups: ['synth', 'infer', 'batch'], source: 'file', recommended: true,
  }]
  const holder = await show({
    id: 'demo',
    call: { kind: 'cli', argv: ['{engine_python}', '-m', 'cli.main', '--text', 'x'] },
  }, withGroups)
  const select = [...container.querySelectorAll('select')]
    .find((s) => [...s.options].some((o) => o.value === 'synth'))
  assert.ok(select, '多子命令入口要有下拉')
  assert.deepStrictEqual([...select.options].slice(1).map((o) => o.value),
    ['synth', 'infer', 'batch'])
  Simulate.change(select, { target: { value: 'synth' } })
  await settle()
  assert.deepStrictEqual(holder.get().call.argv,
    ['{engine_python}', '-m', 'cli.main', 'synth', '--text', 'x'])
})

test('python 形态列出静态扫描到的类，选中后写模块 / 类 / 方法', async () => {
  const holder = await show({ id: 'demo', call: {} }, [], {
    pythonEntries: [
      { module: 'pkg.tts', className: 'TTS', method: 'synthesize', srcRoot: null, score: 3.5 },
      { module: 'pkg.tts', className: 'TTS', method: 'infer', srcRoot: null, score: 3 },
    ],
  })
  const select = [...container.querySelectorAll('select')]
    .find((s) => [...s.options].some((o) => o.value === 'pkg.tts|TTS|synthesize'))
  assert.ok(select, 'python 入口下拉没画出来')
  Simulate.change(select, { target: { value: 'pkg.tts|TTS|synthesize' } })
  await settle()
  assert.strictEqual(holder.get().call.kind, 'python')
  assert.strictEqual(holder.get().call.module, 'pkg.tts')
  assert.strictEqual(holder.get().call.class, 'TTS')
  assert.strictEqual(holder.get().call.method, 'synthesize')
})

// 识别结论错了或没有结论时，datalist 的清单要点击输入框才展开，界面上容易被当成
// 一个普通输入框。下面守着一个常显的下拉框，以及它与输入框写同一个字段。
test('不给结论时仍有一个常显下拉，按分档列出全部候选', async () => {
  await show(cliManifest(), TIERED.map((c) => ({ ...c, recommended: false,
    tier: c.tier === 'recommended' ? 'cli' : c.tier })))
  const sel = listSelect()
  assert.ok(sel, '⛔ 只有 datalist：它要点击输入框才展开，看不出这里有清单')
  assert.deepStrictEqual([...sel.querySelectorAll('optgroup')].map((g) => g.label),
    ['Command line switches found', 'Other Python source files',
      'Auxiliary scripts (demo / training / data)'])
  assert.strictEqual(sel.querySelectorAll('option').length, 4, '占位项加三个候选')
  assert.ok(/Recognition gave no conclusion/.test(container.textContent))
})

test('从常显下拉另选一个文件，写的就是那个文件的模块名', async () => {
  const holder = await show(cliManifest(), TIERED)
  const sel = listSelect()
  Simulate.change(sel, { target: { value: 'pkg/utils.py' } })
  await settle()
  assert.deepStrictEqual(holder.get().call.argv,
    ['{engine_python}', '-m', 'pkg.utils'])
  assert.strictEqual(container.querySelector('input').value, 'pkg/utils.py',
    '输入框与下拉显示同一个值，不各说各话')
})

test('有扫描建议时写清它可能不适用，且其它分档照样可选', async () => {
  await show(cliManifest(), TIERED)
  assert.ok(/The suggestion may not apply/.test(container.textContent),
    '⛔ 没告诉使用者推荐可以改：结论错了会一路带到第 5 步')
  const sel = listSelect()
  assert.ok(sel, '有推荐时也要能另选')
  assert.strictEqual(sel.querySelectorAll('optgroup').length, 3)
})

test('手填的值不在清单里时，下拉落回未指定，不假装选中了某一项', async () => {
  await show({
    id: 'demo',
    call: { kind: 'cli', argv: ['{engine_python}', '-m', 'pkg.custom'], bind: {} },
  }, TIERED)
  const sel = listSelect()
  assert.strictEqual(sel.value, '')
  assert.ok(/Current value is typed in/.test(sel.options[0].textContent))
})

test('候选为空时不画一个空下拉，手填入口照旧可用', async () => {
  await show(cliManifest(), [])
  assert.strictEqual(listSelect(), undefined)
  assert.ok(container.querySelector('input'), '手填的输入框不能被收走')
})
