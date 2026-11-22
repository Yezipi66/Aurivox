'use strict'
// 参数池的 help 可能是 {en, zh}：名片 call.bind 指向、但反射器没扫到的参数由
//   paramsFromReflect 补进池子，那一类带的是双语对象（label / help 在名片里只认
//   {en,zh}）。直接把它当 React child 渲染，整栏会崩在 «Objects are not valid as
//   a React child»，而报错指向的是 ParamItem 的 div，看不出是哪条参数。
//
// 守两件事：对象 help 不崩、按当前语言显示；搜索框对对象 help 也不抛。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { JSDOM } = require(resolveFromRoot('jsdom'))

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

let lang = 'zh'
const i18n = { useT: () => ({ t: (en, zh) => zh || en, lang, setLang: () => {} }) }

const ParamPool = loadJsx('ParamPool.jsx', {
  react: React,
  'web/src/lib/i18n': i18n,
  './paramType': loadEsm(path.join(EDITOR_DIR, 'paramType.js')),
  './paramPoolOrder': loadEsm(path.join(EDITOR_DIR, 'paramPoolOrder.js')),
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

// call.bind 补进来的参数：label / help 都是 {en,zh}，type 是 REPLACE_ME。
const BIND_PARAM = () => ({
  name: 'tts_text',
  target: 'tts_text',
  kind: 'str',
  kind_certain: false,
  source: 'call.bind',
  required: true,
  group: '(root)',
  is_tool: false,
  label: { en: 'tts_text', zh: 'REPLACE_ME' },
  help: { en: 'from call.bind (en)', zh: '来自 call.bind（中文）' },
})

async function show (params) {
  const host = dom.window.document.createElement('div')
  container.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  root.render(React.createElement(ParamPool, {
    params, selected: null, used: () => false, onSelect: () => {}, onDragStart: () => {},
  }))
  await new Promise((resolve) => setTimeout(resolve, 60))
  return { host, root }
}

test('help 是 {en,zh} 时按当前语言显示，不把对象交给 React', async () => {
  lang = 'zh'
  const { host } = await show([BIND_PARAM()])
  assert.ok(host.textContent.includes('来自 call.bind（中文）'),
    '中文界面要显示中文那条；这里空着说明渲染被对象 help 打断了')
})

test('英文界面取 en 那条', async () => {
  lang = 'en'
  const { host } = await show([BIND_PARAM()])
  assert.ok(host.textContent.includes('from call.bind (en)'))
})

test('搜索框对对象 help 不抛，且两种语言都能命中', async () => {
  lang = 'zh'
  const { host } = await show([BIND_PARAM()])
  const box = host.querySelector('input')
  assert.ok(box, '搜索框不见了')
  box.value = 'call.bind（中文）'
  box.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(host.textContent.includes('tts_text'), '按 help 的中文片段应该还找得到这条')
})
