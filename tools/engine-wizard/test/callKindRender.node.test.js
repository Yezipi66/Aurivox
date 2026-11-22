'use strict'
// 第 4 步「调用方式」那一格：cli / python 两种形态必须能看见、能改。
//
// 名片里 call.kind 一直是有的，但界面不暴露它：嗅探给了 cli 就一路走到第 5 步才炸，
//   而报错指向的是「目录里没有音频」，跟真实原因隔了三层。
//
// 守三件事：形态下拉在必填区且默认按名片判；切换时按形态改写名片；
//   返回方式四档齐全，且「逐块生成」只对 python 开放。

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
    if (id.endsWith('components/common/Select')) return require('./_selectStub.js')
    throw new Error(file + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, path.join(EDITOR_DIR, file), EDITOR_DIR)
  return mod.exports
}

const i18n = { useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) }

// 形态下拉与扫描按钮是作为插槽传进 EntryChoice 的：stub 掉它，两个控件都不会渲染，
//   这组断言就全落空。用真组件，只把 Select 换成可操作的原生下拉。
const EntryChoice = loadJsx('EntryChoice.jsx', {
  react: React,
  'web/src/lib/i18n': i18n,
  './entryChoiceField': loadEsm(path.join(EDITOR_DIR, 'entryChoiceField.js')),
}).default

const RequiredFields = loadJsx('RequiredFields.jsx', {
  react: React,
  'web/src/lib/i18n': i18n,
  './EntryChoice': { __esModule: true, default: EntryChoice },
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
  // 形态判定与切换用真实现：stub 掉就验不到改写规则。
  './entryChoiceField': loadEsm(path.join(EDITOR_DIR, 'entryChoiceField.js')),
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

let cur = null
async function show (manifest, extra) {
  cur = manifest
  const host = dom.window.document.createElement('div')
  container.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  const rerender = () => {
    root.render(React.createElement(RequiredFields, {
      manifest: cur,
      autofill: null,
      bindSlots: ['text', 'ref_audio', 'ref_text', 'output_path'],
      ...(extra || {}),
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

// 形态下拉有 cli / python 两个值；返回方式的下拉在「输出」格里，
//   cli 形态只有 file/dir/bytes 三档，python 才有 generator。
//   按 file 认返回方式下拉，不依赖某一档存在。
const kindSelect = (scope) => [...scope.querySelectorAll('select')]
  .find((s) => [...s.options].some((o) => o.value === 'python'))
const returnsSelect = (scope) => [...scope.querySelectorAll('select')]
  .find((s) => [...s.options].some((o) => o.value === 'file'))

const CLI = () => ({
  id: 'demo',
  runtime: { python: 'engines/demo/.venv', entry: 'prog.py' },
  call: { kind: 'cli', argv: ['{engine_python}', '-m', 'pkg.cli'], bind: { text: '--tts-text', output_path: '-f' } },
})

test('调用方式是一个能看见、能改的控件，默认按名片判', async () => {
  const { host } = await show(CLI())
  const sel = kindSelect(host)
  assert.ok(sel, '形态必须能在界面上声明，不能只留给 JSON 视图')
  assert.strictEqual(sel.value, 'cli')
  assert.ok([...sel.options].some((o) => o.value === 'python'), '也要能切到 python')
})

test('切到 python：命令行摘掉，绑定名按方法参数名改写', async () => {
  const { host } = await show(CLI())
  Simulate.change(kindSelect(host), { target: { value: 'python' } })
  assert.strictEqual(cur.call.kind, 'python')
  assert.strictEqual(cur.call.argv, undefined,
    '命令行不摘掉，界面还会按 argv 判成 cli，切了等于没切')
  assert.strictEqual(cur.call.bind.text, 'tts_text',
    '开关名会被当成关键字参数传给 Python 方法')
  assert.strictEqual(cur.call.bind.output_path, '-f',
    '已经是开关形式的绑定不该被改：python 形态也可能收一个路径参数')
})

test('命令行形态下返回方式只有文件 / 目录 / 标准输出三档', async () => {
  const { host } = await show(CLI())
  const sel = returnsSelect(host)
  assert.ok(sel, '返回方式的下拉不见了')
  const values = [...sel.options].map((o) => o.value)
  for (const v of ['file', 'dir', 'bytes']) {
    assert.ok(values.includes(v), '返回方式缺了 ' + v + '：缺一档就有一类引擎接不了')
  }
  assert.ok(!values.includes('generator'),
    '命令行进程结束后只剩文件或字节流，逐块生成在这一页不该出现')
})

test('python 形态下逐块生成可选', async () => {
  const py = CLI()
  py.call = { kind: 'python', bind: { text: 'tts_text', output_path: '-f' } }
  const { host } = await show(py)
  const gen = [...returnsSelect(host).options].find((o) => o.value === 'generator')
  assert.strictEqual(gen.disabled, false, '逐块生成是进程内形态才有的返回方式')
})

test('名片就位后「扫描参数」出现在「调用方式」旁边，点了会回调', async () => {
  let fired = 0
  const { host } = await show(CLI(), { canScan: true, scanBusy: false, onScan: () => { fired += 1 } })
  const btn = [...host.querySelectorAll('button')]
    .find((b) => /扫描参数|Scan parameters/.test(b.textContent))
  assert.ok(btn, '名片就位后要有扫描入口：它改的就是调用方式与入口这两格')
  // 位置：与形态下拉同一个横向容器，视觉上在它右边。
  assert.ok(btn.parentElement === kindSelect(host).parentElement,
    '扫描按钮要和「调用方式」同一行')
  Simulate.click(btn)
  assert.strictEqual(fired, 1, '点扫描没有回调到页面层')
})

test('名片没就位时没有扫描按钮：没有写回的地方', async () => {
  const { host } = await show(CLI(), { canScan: false })
  assert.ok(![...host.querySelectorAll('button')]
    .some((b) => /扫描参数|Scan parameters/.test(b.textContent)),
  '还没名片就摆一个扫描按钮，扫出来的东西没有地方写')
})
