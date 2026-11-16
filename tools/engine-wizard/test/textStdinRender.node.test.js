'use strict'
// 第 4 步「合成文本」那格：没有文本开关的程序，正文从标准输入进。
//
// 宿主 lib/engines/host.py 早就认 call.text_via="stdin"，但向导里写不出来：
//   扫描拿不到任何文本候选时，那一格只能空着，人只能手改名片。
//   这一格补的是「第二种文本入口」，且与 bind.text 互斥（两个都写宿主每次请求都拒）。
//
// 守三件事：cli 形态才有这个勾；勾上写 text_via 并摘掉 bind.text；
//   勾上之后这一格不再显示「未匹配，需指定」（它已经有答案了，只是不是参数名）。

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

// 编辑器里的纯函数模块是 ESM：用项目同一个 esbuild 编成 CJS 再取。
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
    // 下拉换成了页面内的组件，这里只要能选值就够，交互细节由真组件那条测试守。
    if (id.endsWith('components/common/Select')) return require('./_selectStub.js')
    throw new Error(file + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, path.join(EDITOR_DIR, file), EDITOR_DIR)
  return mod.exports
}

const RequiredFields = loadJsx('RequiredFields.jsx', {
  react: React,
  'web/src/lib/i18n': { useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) },
  // 推理入口、惯例代填、权重位都不是这次要验的东西，给最小实现。
  './EntryChoice': { __esModule: true, default: () => null },
  './optionalKeys': {
    launchConventions: () => null,
    withRuntimePatch: (m, patch) => ({ ...m, runtime: { ...(m.runtime || {}), ...patch } }),
    withLaunchConventions: (m) => m,
  },
  './weightsField': {
    readWeights: () => ({ name: '', value: '', self: true }),
    writeWeights: (c) => c,
    TOKEN: '{checkpoints}',
  },
  './textEntryField': loadEsm(path.join(EDITOR_DIR, 'textEntryField.js')),
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

const CLI = () => ({
  id: 'demo',
  runtime: { python: 'engines/demo/.venv', entry: 'prog.py' },
  call: { kind: 'cli', argv: ['prog.py'], bind: { output_path: '-f' } },
})

// 扫描过但一个文本候选都没有：这正是「程序没有文本开关」的形状。
const SCANNED_EMPTY = { matched: {}, confidence: {}, argList: [] }

// 挂上去并让写回真的生效：组件的写回是「给我一个函数，对当前名片求值」。
let cur = null
async function show (manifest, autofill) {
  cur = manifest
  // 每个用例换一个新 root：同一个 root 连续 render 会挂住。
  const host = dom.window.document.createElement('div')
  container.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  const rerender = () => {
    root.render(React.createElement(RequiredFields, {
      manifest: cur,
      autofill: autofill || null,
      bindSlots: ['text', 'ref_audio', 'ref_text', 'output_path'],
      onChange: (updater) => {
        cur = typeof updater === 'function' ? updater(cur) : updater
        rerender()
      },
    }))
  }
  rerender()
  await new Promise((resolve) => setTimeout(resolve, 60))
  return { host, root }
}

const stdinBox = (scope) => [...scope.querySelectorAll('input[type=checkbox]')]
  .find((i) => (i.parentElement.textContent || '').includes('标准输入'))
const textInput = (scope) => [...scope.querySelectorAll('input')]
  .find((i) => i.getAttribute('aria-label') === '合成文本')

test('cli 形态：合成文本格有一个「从标准输入读」的勾', async () => {
  const { host } = await show(CLI())
  assert.ok(stdinBox(host), '没有标准输入那一项：没有文本开关的程序这一格没法填')
})

test('勾上标准输入：写 text_via，并摘掉 bind.text', async () => {
  const manifest = CLI()
  manifest.call.bind.text = '--text'
  const { host } = await show(manifest)
  Simulate.change(stdinBox(host), { target: { checked: true } })
  assert.strictEqual(cur.call.text_via, 'stdin')
  assert.strictEqual(cur.call.bind.text, undefined,
    'text_via 与 bind.text 并存，宿主会拒掉每一次请求')
  assert.strictEqual(cur.call.bind.output_path, '-f', '同一份 bind 里的其它键被冲掉了')
})

test('勾上之后：那一格的输入框让位，且不再显示「未匹配，需指定」', async () => {
  const manifest = CLI()
  manifest.call.text_via = 'stdin'
  const { host } = await show(manifest, SCANNED_EMPTY)
  const cell = textInput(host).closest('.field')
  assert.strictEqual(textInput(host).disabled, true, '正文走标准输入时这一格不该还能填参数名')
  assert.ok(!cell.textContent.includes('未匹配，需指定'),
    '已经有答案了（不是参数名），不能说它没匹配上')
})

test('python 形态不出现这个勾：标准输入是命令行的事', async () => {
  const manifest = CLI()
  manifest.call = { kind: 'python', module: 'demo', cls: 'TTS', method: 'synth', bind: {} }
  const { host } = await show(manifest)
  assert.strictEqual(stdinBox(host), undefined)
})

// 扫描可能同时认出过一个文本开关。既然人选了标准输入，那个开关就不再生效：
//   格子不该还顶着「扫描已确定」或匹配高亮，否则看起来像两个入口都在用。
test('扫描认出了文本开关，但人改走标准输入：不再挂匹配状态', async () => {
  const manifest = CLI()
  manifest.call.text_via = 'stdin'
  const { host } = await show(manifest, {
    matched: { text: '--text' },
    confidence: { bind: { text: { level: 'certain', reason: { en: 'ok', zh: '同名' } } } },
    argList: [{ target: '--text', help: '' }],
  })
  const cell = textInput(host).closest('.field')
  assert.ok(!cell.textContent.includes('扫描已确定'), '已经不用这个开关了，不能说它被采纳')
  assert.ok(!cell.querySelector('.wz-field-matched'), '这一格不该还挂着匹配高亮')
})
