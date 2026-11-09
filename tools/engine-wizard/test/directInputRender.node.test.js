'use strict'
// 第 3 步的两个输入区与一张合并清单真的能渲染：
// 模型仓库与文件直链分开填，条目同表、可逐项移除，下载全部共用一个按钮。

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
const destInputs = () => inputs().filter((i) => String(i.placeholder || '').includes('落地位置'))
const buttons = (text) => [...container.querySelectorAll('button')]
  .filter((b) => b.textContent.trim() === text)
const has = (text) => container.textContent.includes(text)

test('第 1 步没有探测结果时，两个输入区仍在，清单为空不显示下载全部', async () => {
  await show()
  assert.ok(has('模型仓库'), '模型仓库区要独立显示')
  assert.ok(has('文件直链 / curl'), '直链区要独立显示')
  assert.ok(repoInput() && fileInput(), '两区各有一个链接输入框')
  assert.strictEqual(destInputs().length, 2, '两区各有一个落地位置输入框')
  assert.ok(!has('No probe data'), '探测缺失不该挡住手填')
  assert.strictEqual(buttons('下载全部').length, 0, '清单为空时没有可下载条目')
})

test('模型仓库区两个主域名共用一个入口，落地位置随条目进入下载命令区', async () => {
  await show()
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
    '手填的落地位置要真的带进列文件请求，而不是只写在界面上')

  Simulate.change(repoInput(), { target: { value: 'https://www.modelscope.cn/models/iic/Demo-Model' } })
  await settle()
  Simulate.click(buttons('引入仓库')[0])
  await settle()
  assert.ok(has('魔搭 仓库 iic/Demo-Model'), '魔搭不需要另开一个控件')
  assert.ok(buttons('嗅探仓库').length >= 2, '两个仓库各有自己的列文件入口')
})

test('文件直链进同一张表，可一键下载全部，也可逐项移除', async () => {
  await show()
  Simulate.change(fileInput(), { target: { value: 'https://example.org/weights/model.safetensors' } })
  await settle()
  Simulate.change(destInputs()[1], { target: { value: 'sub/model.safetensors' } })
  await settle()
  Simulate.click(buttons('加入清单')[0])
  await settle()
  assert.ok(container.querySelector('table tbody').textContent.includes('文件直链'), '表格要标出这一行的来源')
  assert.ok(has('model.safetensors') && has('sub/'), '文件名与落地位置都要看得见')
  assert.strictEqual(container.querySelectorAll('table tbody tr').length, 1)
  assert.strictEqual(buttons('下载全部').length, 1, '只有一个下载全部按钮')
  assert.strictEqual(buttons('移除').length, 1, '每一行都能从清单里去掉')

  Simulate.click(buttons('移除')[0])
  await settle()
  assert.strictEqual(container.querySelectorAll('table tbody tr').length, 0, '移除后这一行要真的消失')
})
