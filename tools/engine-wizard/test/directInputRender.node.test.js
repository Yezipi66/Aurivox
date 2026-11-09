'use strict'
// 第 3 步的输入口子真的能渲染：一个输入框按主域名分流，
// 模型仓库页进入下载清单并出现嗅探按钮，单文件地址仍走下载。

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
  './downloadRunner': { downloadFiles: async () => {}, readSse: async () => {} },
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
define('fetch', async () => ({
  ok: true,
  json: async () => ({ ok: false }),
  headers: { get: () => 'application/json' },
}))

const container = dom.window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)
const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

async function show () {
  root.render(React.createElement(StepModels, {
    state: { id: 'demo', repoUrl: '' }, onChange: () => {},
    probe: null, prep: null, onFixId: () => {},
  }))
  await settle()
}

const mainInput = () => [...container.querySelectorAll('input')]
  .find((i) => String(i.placeholder || '').includes('huggingface.co'))
const actionButton = () => [...container.querySelectorAll('button')]
  .find((b) => /下载|引入仓库/.test(b.textContent) && !/下载全部/.test(b.textContent))
const probeButtons = () => [...container.querySelectorAll('button')]
  .filter((b) => b.textContent.trim() === '嗅探仓库')

test('第 1 步没有探测结果时，第 3 步仍给出统一输入框，不报整步不可用', async () => {
  await show()
  assert.ok(container.textContent.includes('模型仓库或文件直链'), '标题要说明两种输入')
  assert.ok(mainInput(), '要有一个输入框，不分叉成两个站点各一个')
  assert.ok(!container.textContent.includes('No probe data'), '探测缺失不该挡住手填')
  assert.strictEqual(actionButton().textContent.trim(), '下载')
  assert.strictEqual(probeButtons().length, 0, '还没有仓库可嗅探')
})

test('两个主域名共用同一个入口：仓库页改成加入清单，并出现嗅探按钮', async () => {
  await show()
  Simulate.change(mainInput(), { target: { value: 'https://huggingface.co/Org/Model-A' } })
  await settle()
  assert.strictEqual(actionButton().textContent.trim(), '引入仓库')

  Simulate.click(actionButton())
  await settle()
  assert.ok(container.textContent.includes('已识别为 Hugging Face 仓库 Org/Model-A'))
  assert.ok(probeButtons().length > 0, '加入清单后要出现真正的嗅探按钮')

  Simulate.change(mainInput(), { target: { value: 'https://www.modelscope.cn/models/iic/Demo-Model' } })
  await settle()
  assert.strictEqual(actionButton().textContent.trim(), '引入仓库', '魔搭不需要另开一个控件')

  Simulate.change(mainInput(), { target: { value: 'https://example.org/weights/model.safetensors' } })
  await settle()
  assert.strictEqual(actionButton().textContent.trim(), '下载', '单文件地址仍走下载')
})
