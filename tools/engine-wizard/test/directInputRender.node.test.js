'use strict'
// 第 3 步的权重来源框真的能渲染：三个页签切换，模型仓库与文件直链
// 都把条目加进同一张清单，可一键下载全部、逐项移除。

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
  new Function('exports', 'require', 'module', code)(mod.exports, () => {
    throw new Error(path.basename(file) + ' 不该有依赖')
  }, mod)
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

const StepModels = loadJsx('StepsExtra.jsx', {
  react: React,
  'web/src/lib/i18n': { useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) },
  './downloadState': { loadDownloadState: () => null, saveDownloadState: () => {} },
  './downloadQueue': { DEFAULT_CONCURRENCY: 2 },
  './downloadRunner': { downloadFiles: async () => ({}), readSse: async () => {} },
  './downloadSource': loadEsm(path.join(EDITOR_DIR, 'downloadSource.js')),
  './StepVerify': { StepVerify: () => null },
}).StepModels

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
const fetched = []
define('fetch', async (url) => {
  fetched.push(String(url))
  return {
    ok: true,
    json: async () => ({ ok: false }),
    headers: { get: () => 'application/json' },
  }
})

const container = dom.window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)
const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

let seq = 0
async function show () {
  seq += 1
  root.render(React.createElement(StepModels, {
    key: 'step' + seq,
    state: { id: 'demo', repoUrl: '' }, onChange: () => {},
    probe: null, prep: null, onFixId: () => {},
  }))
  await settle()
}

const inputs = () => [...container.querySelectorAll('input')]
const repoInput = () => inputs().find((i) => String(i.placeholder || '').includes('huggingface.co/org/model'))
const fileInput = () => inputs().find((i) => String(i.placeholder || '').includes('model.safetensors'))
const destInputs = () => inputs().filter((i) => String(i.placeholder || '').includes('下载位置'))
const buttons = (text) => [...container.querySelectorAll('button')]
  .filter((b) => b.textContent.trim() === text)
const has = (text) => container.textContent.includes(text)

test('第 1 步没有探测结果时仍显示权重来源框，默认在引擎入口页签', async () => {
  await show()
  assert.ok(has('权重来源'), '三种来源要收在同一个框里')
  assert.strictEqual(buttons('引擎自带入口（0）').length, 1, '默认页签是引擎入口')
  assert.strictEqual(buttons('模型仓库').length, 1, '页签按钮要一直在')
  assert.strictEqual(buttons('文件直链 / curl').length, 1)
  assert.strictEqual(repoInput(), undefined, '未切页签时不渲染其它页签的输入框')
  assert.ok(!has('No probe data'), '探测缺失不该挡住手填')
  assert.strictEqual(buttons('下载全部').length, 0, '清单为空时没有可下载条目')
})

test('模型仓库页签：两个主域名共用一个入口，下载位置随条目进入列文件请求', async () => {
  await show()
  Simulate.click(buttons('模型仓库')[0])
  await settle()
  assert.ok(repoInput(), '切到页签后才出现仓库输入框')
  Simulate.change(repoInput(), { target: { value: 'https://huggingface.co/Org/Model-A' } })
  await settle()
  Simulate.change(destInputs()[0], { target: { value: 'sub-a' } })
  await settle()
  Simulate.click(buttons('引入仓库')[0])
  await settle()
  assert.ok(has('已识别为 Hugging Face 仓库 Org/Model-A'))
  assert.ok(buttons('嗅探仓库').length > 0, '加入后要出现真正的嗅探按钮')
  fetched.length = 0
  Simulate.click(buttons('嗅探仓库')[0])
  await settle()
  assert.ok(fetched.some((u) => u.includes('subdir=sub-a')),
    '手填的下载位置要真的带进列文件请求，而不是只写在界面上')

  Simulate.change(repoInput(), { target: { value: 'https://www.modelscope.cn/models/iic/Demo-Model' } })
  await settle()
  Simulate.click(buttons('引入仓库')[0])
  await settle()
  assert.ok(has('魔搭 仓库 iic/Demo-Model'), '魔搭不需要另开一个控件')
})

test('文件直链页签：条目进同一张表，可一键下载全部，也可逐项移除', async () => {
  await show()
  Simulate.click(buttons('文件直链 / curl')[0])
  await settle()
  Simulate.change(fileInput(), { target: { value: 'https://example.org/weights/model.safetensors' } })
  await settle()
  Simulate.change(destInputs()[0], { target: { value: 'sub/model.safetensors' } })
  await settle()
  Simulate.click(buttons('加入清单')[0])
  await settle()
  assert.ok(container.querySelector('table tbody').textContent.includes('文件直链'), '表格要标出这一行的来源')
  assert.ok(has('model.safetensors') && has('sub/'), '文件名与下载位置都要看得见')
  assert.strictEqual(container.querySelectorAll('table tbody tr').length, 1)
  assert.strictEqual(buttons('下载全部').length, 1, '只有一个下载全部按钮')
  assert.strictEqual(buttons('移除').length, 1, '每一行都能从清单里去掉')

  Simulate.click(buttons('移除')[0])
  await settle()
  assert.strictEqual(container.querySelectorAll('table tbody tr').length, 0, '移除后这一行要真的消失')
})
