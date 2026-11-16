'use strict'
// 「推理入口」这一段真的能渲染：构建通过只说明模块图能打包，
// 抓不到未定义的标识符，也抓不到「候选列不出来」「选了不写进名片」「打字被改写」。
//
// 控件是项目统一下拉（web/src/components/common/Select.jsx）的 editable 模式：
//   外观与其它下拉同框同箭头，值可以直接打字，清单是它的候选。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const WEB_SRC = path.join(__dirname, '..', '..', '..', 'web', 'src')
const React = require(resolveFromRoot('react'))
const ReactDOM = require(resolveFromRoot('react-dom'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const JSX_RUNTIME = require(resolveFromRoot('react/jsx-runtime'))
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

// 组件按真源码编译，依赖只认 stubMap 里那几项：测试要的是「真组件 + 假环境」。
function loadJsxAt (absFile, stubMap) {
  const code = esbuild().transformSync(fs.readFileSync(absFile, 'utf8'),
    { loader: 'jsx', format: 'cjs', target: 'node18', jsx: 'automatic' }).code
  const mod = { exports: {} }
  const stub = (id) => {
    for (const [k, v] of Object.entries(stubMap)) {
      if (id === k || id.endsWith(k)) return v
    }
    throw new Error(path.basename(absFile) + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, absFile, path.dirname(absFile))
  return mod.exports
}

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
// jsdom 没有布局，也就没有滚动：下拉让高亮项进入视口那一步是空操作。
dom.window.Element.prototype.scrollIntoView = function () {}

const Select = loadJsxAt(path.join(WEB_SRC, 'components/common/Select.jsx'), {
  react: React,
  'react-dom': { createPortal: ReactDOM.createPortal },
  'react/jsx-runtime': JSX_RUNTIME,
}).default

const EntryChoice = loadJsxAt(path.join(EDITOR_DIR, 'EntryChoice.jsx'), {
  react: React,
  'react/jsx-runtime': JSX_RUNTIME,
  'web/src/lib/i18n': { useT: () => ({ t: (en) => en }) },
  './entryChoiceField': loadEsm(path.join(EDITOR_DIR, 'entryChoiceField.js')),
  'components/common/Select': Select,
}).default

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

const entryBox = () => container.querySelector('.ui-select-editable')
const entryInput = () => entryBox() && entryBox().querySelector('.ui-select-input')
const type = async (text) => { Simulate.change(entryInput(), { target: { value: text } }); await settle() }

// 菜单挂在 document.body 上（页面内的普通 DOM，不受容器裁切）。
const menu = () => dom.window.document.body.querySelector('.ui-select-menu')
const menuOptions = () => (menu() ? [...menu().querySelectorAll('.ui-select-option')] : [])
async function openEntryMenu () {
  entryBox().querySelector('.ui-select-pick').click()
  await settle()
}
async function pickOption (index) {
  menuOptions()[index].click()
  await settle()
}

test('有候选时是一个「可打字的项目下拉」：同框同箭头，只有一个输入框', async () => {
  await show(cliManifest(), CANDIDATES)
  assert.ok(entryBox(), '入口要是项目下拉那一套的外框')
  assert.ok(entryInput(), '框里要是一个能直接打字的输入框')
  assert.ok(entryBox().querySelector('.ui-select-pick .ui-select-arrow'), '右侧要有下拉那个箭头')
  assert.strictEqual(container.querySelectorAll('input').length, 1, '一个值只给一个控件')
  assert.strictEqual(container.querySelectorAll('select').length, 0, '不该再出现原生下拉')
  assert.ok(/Suggested/.test(container.textContent), '有扫描建议时该提示出来')
})

test('展开的清单按证据分档排序，行里说清这一项是什么', async () => {
  await show(cliManifest(), TIERED)
  await openEntryMenu()
  const opts = menuOptions()
  assert.deepStrictEqual(opts.map((o) => o.getAttribute('data-idx')),
    ['0', '1', '2'], '三个候选都在清单里')
  const text = opts.map((o) => o.textContent)
  assert.deepStrictEqual(text, [
    'pkg/infer_cli.py (suggested)',
    'pkg/utils.py',
    'demo/tts_demo.py (auxiliary script)',
  ], '推荐在最前，辅助脚本在最后，且各自标出来')
})

test('从清单里选一项 ⇒ 回填输入框、写进名片、收起', async () => {
  const holder = await show(cliManifest(), TIERED)
  await openEntryMenu()
  await pickOption(0)
  assert.strictEqual(entryInput().value, 'pkg/infer_cli.py', '输入框回到选中的那个文件')
  assert.deepStrictEqual(holder.get().call.argv, ['{engine_python}', '-m', 'pkg.infer_cli'])
  assert.strictEqual(menu(), null, '选完要收起')
})

test('选中辅助脚本：提示直说它可能不是合成入口', async () => {
  const holder = await show(cliManifest(), TIERED)
  await openEntryMenu()
  await pickOption(2)
  assert.ok(/Auxiliary script/.test(container.textContent),
    '演示 / 训练脚本和正常入口长得一样，选中后要说清')
  assert.ok(/as -m demo\.tts_demo/.test(container.textContent), '仍要说清写进命令行的是什么')
  assert.deepStrictEqual(holder.get().call.argv, ['{engine_python}', '-m', 'demo.tts_demo'])
})

test('选中一个文件 ⇒ 写模块名，输入框显示文件路径，下方说清 -m', async () => {
  const holder = await show(cliManifest(), CANDIDATES)
  await openEntryMenu()
  await pickOption(0)
  assert.deepStrictEqual(holder.get().call.argv,
    ['{engine_python}', '-m', 'a.b.c.infer_cli'])
  assert.strictEqual(holder.get().call.cwd, 'engines/demo/src')
  assert.strictEqual(entryInput().value, 'src/a/b/c/infer_cli.py',
    '输入框里要是文件，模块名核不出「读到的是不是那个文件」')
  assert.ok(/as -m a\.b\.c\.infer_cli/.test(container.textContent),
    '要写清这一项在命令行上写成什么')
})

test('名片里存的是模块名：输入框显示它对应的文件，不用自己去猜', async () => {
  await show({
    id: 'demo',
    call: { kind: 'cli', argv: ['{engine_python}', '-m', 'a.b.c.infer_cli'], bind: {} },
  }, CANDIDATES)
  assert.strictEqual(entryInput().value, 'src/a/b/c/infer_cli.py')
})

test('⭐ 自由输入：不在候选里的模块名原样写进名片，且不被改写', async () => {
  const holder = await show(cliManifest(), CANDIDATES)
  await type('pkg.custom')
  assert.deepStrictEqual(holder.get().call.argv, ['{engine_python}', '-m', 'pkg.custom'])
  assert.strictEqual(entryInput().value, 'pkg.custom', '打进去的值不该被换成一串路径')
  assert.ok(/Not in the scan result/.test(container.textContent),
    '既不在清单里也不像文件路径，要说清楚它被当成模块名')
})

test('⭐ 打字打到一半命中候选，输入框也不跳成别的写法', async () => {
  await show({
    id: 'demo',
    call: { kind: 'cli', argv: ['{engine_python}', '-m', 'a.b.c.infer_cli'], bind: {} },
  }, CANDIDATES)
  assert.strictEqual(entryInput().value, 'src/a/b/c/infer_cli.py')
  await type('a.b.c')
  assert.strictEqual(entryInput().value, 'a.b.c', '编辑中按原样显示，不能中途被规范化')
  Simulate.blur(entryInput())
  await settle()
  assert.strictEqual(entryInput().value, 'a.b.c', '失焦后仍是打进去的那个值')
})

test('打进去的脚本路径按脚本写：换成 .py 时用位置而不是 -m', async () => {
  const holder = await show(cliManifest(), [])
  await type('tools/say.py')
  assert.deepStrictEqual(holder.get().call.argv, ['{engine_python}', 'tools/say.py'])
})

test('候选为空时仍是一个可打字的框：没有空清单可点，文案说待扫描', async () => {
  await show(cliManifest(), [])
  assert.ok(entryInput(), '输入框必须还在，否则这一格没法填')
  await openEntryMenu()
  assert.deepStrictEqual(menuOptions().map((o) => o.textContent), ['—'], '没有候选时清单只留一个占位行')
  assert.ok(/Not scanned, or no Python source files/.test(container.textContent))
})

test('有候选但没有扫描建议：提示从清单里选，不谎称已识别', async () => {
  await show(cliManifest(), CANDIDATES.map((c) => ({ ...c, recommended: false })))
  assert.ok(/Recognition gave no conclusion/.test(container.textContent))
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
  const sub = container.querySelector('.ui-select[aria-label="Subcommand"]')
  assert.ok(sub, '多子命令入口要有下拉')
  sub.click()
  await settle()
  const values = menuOptions().map((o) => o.textContent)
  assert.deepStrictEqual(values, ['not specified', 'synth', 'infer', 'batch'])
  await pickOption(1)
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
  const py = container.querySelector('.ui-select[aria-label="Python entry"]')
  assert.ok(py, 'python 入口下拉没画出来')
  py.click()
  await settle()
  const values = menuOptions().map((o) => o.textContent)
  assert.deepStrictEqual(values, ['not specified', 'pkg.tts.TTS.synthesize', 'pkg.tts.TTS.infer'])
  await pickOption(1)
  assert.strictEqual(holder.get().call.kind, 'python')
  assert.strictEqual(holder.get().call.module, 'pkg.tts')
  assert.strictEqual(holder.get().call.class, 'TTS')
  assert.strictEqual(holder.get().call.method, 'synthesize')
})

test('⭐⭐ 有扫描建议时写清它可能不适用，且清单里还有别的档', async () => {
  await show(cliManifest(), TIERED)
  assert.ok(/The suggestion may not apply/.test(container.textContent),
    '没告诉使用者推荐可以改：结论错了会一路带到第 5 步')
  await openEntryMenu()
  assert.strictEqual(menuOptions().length, 3, '推荐之外还有两项候选')
  assert.ok(/\(suggested\)/.test(menuOptions()[0].textContent), '推荐项要标出来')
})

// 打开一台已经有名片的引擎：这次会话还没扫过，清单是空的，但入口明明写着。
//   这时说「没有发现 Python 源文件」是错误结论，而这条命令本身是能跑的。
test('⭐⭐ 名片里已有入口而清单为空：输入框显示它，文案说「待扫描」', async () => {
  await show({
    id: 'demo',
    call: { kind: 'cli', argv: ['{engine_python}', '-m', 'kokoro'], bind: {} },
  }, [])
  assert.strictEqual(entryInput().value, 'kokoro', '输入框要显示名片里那个值')
  const text = container.textContent
  assert.ok(/kokoro/.test(text), '要说清入口沿用名片里的哪一个值')
  assert.ok(/not been scanned/i.test(text), '清单为空的原因是没扫描')
  assert.strictEqual(/no Python source files were found\. A module name/.test(text), false,
    '不能对着一条能跑的命令说没有 Python 源文件')
})
