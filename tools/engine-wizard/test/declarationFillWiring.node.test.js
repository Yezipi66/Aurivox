'use strict'
// 声明兜底（models.required / runtime.verify）自动填的接线守卫。
//
// 症状（P0-1b 修的缺口）：名片里没声明 models.required 与 runtime.verify，
//   于是第 3 步只能说「目录在不在」、第 5 步的「权重齐不齐」「起不起得来」
//   永远是说不出来（checkpoints.js 的 ready:null、env_deep 无 spec）。
//
// 纯函数测试（declarationFill.node.test.js）只管判定与填值，
//   接线的错（effect 条件挂错、onChange 拿快照写回冲掉别处、徽标没渲染）
//   纯函数抓不到。这里真渲染 ManifestForm，由宿主组件持有名片状态，
//   与 App 一样直接把 onChange 交给 setState。
//
// 置信度呈现（确定=绿，猜的=黄）一并守：确定两格 = badge-ok（绿），
//   猜的那格（sys_path）= badge-warn（黄）。

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const REACT = resolveFromRoot('react')
const REACT_DOM = resolveFromRoot('react-dom/client')
const JSDOM_PATH = resolveFromRoot('jsdom')
const skip = (REACT && REACT_DOM && JSDOM_PATH) ? false : '没有 react / react-dom / jsdom'

const HARNESS = `
import React from 'react'
import ManifestForm from './ManifestForm.jsx'
import { manifestForEngineSwitch } from './manifestAutoFill.js'

const spec = { sections: [], bindSlots: ['text', 'ref_audio', 'output_path'] }
export const api = {}
export function Host ({ initial, ck, files }) {
  const [m, setM] = React.useState(initial)
  const [path, setCk] = React.useState(ck)
  const [mf, setMf] = React.useState(files)
  api.m = m; api.setM = setM; api.setCk = setCk; api.setMf = setMf
  api.switchTo = (id) => setM((cur) => manifestForEngineSwitch(cur, id, id))
  return React.createElement(ManifestForm, {
    manifest: m, spec, onChange: setM, checkpointsPath: path, modelFiles: mf,
    autofill: null, selectedParam: null, guessed: new Set(),
    onParamDropped: () => {}, onTypeConfirmed: () => {},
  })
}
`

function loadHarness () {
  const esb = esbuild()
  const reactDir = path.dirname(REACT)
  const out = esb.buildSync({
    stdin: { contents: HARNESS, resolveDir: path.join(__dirname, '..', 'editor'), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs',
    jsx: 'automatic', loader: { '.js': 'jsx' }, logLevel: 'silent',
    external: ['react', 'react-dom', 'react-dom/*', 'react/*'],
    nodePaths: [path.join(reactDir, '..')],
  })
  const Module = require('node:module')
  const mod = new Module('declarationFillWiring-harness')
  mod.paths = [path.join(reactDir, '..')]
  mod._compile(out.outputFiles[0].text, path.join(__dirname, 'declarationFillWiring-harness.js'))
  return mod.exports
}

async function withDom (fn) {
  const { JSDOM } = require(JSDOM_PATH)
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const saved = {}
  for (const k of ['window', 'document', 'localStorage', 'HTMLElement']) saved[k] = global[k]
  global.window = dom.window
  global.document = dom.window.document
  global.localStorage = dom.window.localStorage
  global.HTMLElement = dom.window.HTMLElement
  const navDesc = Object.getOwnPropertyDescriptor(global, 'navigator')
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
  global.IS_REACT_ACT_ENVIRONMENT = true
  try { await fn() } finally {
    for (const k of Object.keys(saved)) global[k] = saved[k]
    if (navDesc) Object.defineProperty(global, 'navigator', navDesc)
    dom.window.close()
  }
}

async function mount (initial, ck, files) {
  const React = require(REACT)
  const { createRoot } = require(REACT_DOM)
  const { Host, api } = loadHarness()
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await React.act(async () => root.render(React.createElement(Host, { initial, ck, files })))
  return { api, act: React.act, root, el }
}

// spark-tts 形状的素材：权重嵌套在子目录、混着杂质文件
const FILES = ['BiCodec/bcodec.pt', 'LLM/qwen.pt', 'README.md', 'm.bin.lock']
const SPARK = { id: 'spark-tts', label: 'Spark TTS', contract_version: 2,
  runtime: { python: 'engines/spark-tts/.venv', entry: '../../lib/engines/host.py',
    checkpoints: 'engines/spark-tts/checkpoints' },
  call: { kind: 'python', module: 'sparktts.api', class: 'SparkTTS',
    method: 'infer', bind: { text: 'text' }, returns: 'file', seed: 'none' } }

test('名片缺声明 + 盘上有文件 + call 有模块 ⇒ required 与 verify 都填上', { skip }, () => withDom(async () => {
  const { api, act, root } = await mount(SPARK, 'engines/spark-tts/checkpoints', FILES)
  // 杂质（README / .lock）剔掉，只剩两个权重文件
  assert.deepStrictEqual(api.m.models.required, ['BiCodec/bcodec.pt', 'LLM/qwen.pt'])
  // sys_path 猜克隆根；imports 照 call 段的模块，module-only
  assert.deepStrictEqual(api.m.runtime.verify.sys_path, ['engines/spark-tts'])
  assert.deepStrictEqual(api.m.runtime.verify.imports, [{ module: 'sparktts.api' }])
  await act(async () => root.unmount())
}))

test('使用者声明过 required（哪怕一个文件）⇒ 不覆盖他的判断', { skip }, () => withDom(async () => {
  const { api, act, root } = await mount(
    { ...SPARK, models: { required: ['only_this.pt'] } },
    'engines/spark-tts/checkpoints', FILES)
  assert.deepStrictEqual(api.m.models.required, ['only_this.pt'])
  // verify 两格照填（那是另一件事，互不干扰）
  assert.deepStrictEqual(api.m.runtime.verify.sys_path, ['engines/spark-tts'])
  assert.deepStrictEqual(api.m.runtime.verify.imports, [{ module: 'sparktts.api' }])
  await act(async () => root.unmount())
}))

test('盘上清单后到（第 3 步下完了）⇒ 到了就填', { skip }, () => withDom(async () => {
  const { api, act, root } = await mount(SPARK, 'engines/spark-tts/checkpoints', null)
  assert.strictEqual(api.m.models && api.m.models.required, undefined, '没文件就别填')
  await act(async () => api.setMf(FILES))
  assert.deepStrictEqual(api.m.models.required, ['BiCodec/bcodec.pt', 'LLM/qwen.pt'])
  await act(async () => root.unmount())
}))

test('填过之后模型文件清单再变 ⇒ 不再覆盖（已是使用者的声明）', { skip }, () => withDom(async () => {
  const { api, act, root } = await mount(SPARK, 'engines/spark-tts/checkpoints', FILES)
  assert.deepStrictEqual(api.m.models.required, ['BiCodec/bcodec.pt', 'LLM/qwen.pt'])
  await act(async () => api.setMf(['BiCodec/bcodec.pt', 'LLM/qwen.pt', 'extra.pt']))
  assert.deepStrictEqual(api.m.models.required, ['BiCodec/bcodec.pt', 'LLM/qwen.pt'],
    '⛔ 填过之后又按新清单覆盖了：使用者（或上一次填）的声明被冲掉了')
  await act(async () => root.unmount())
}))

test('填值与扫描/别处的自动填同一次提交不互冲（checkpoints 与 required 都在）', { skip }, () => withDom(async () => {
  // checkpoints 路径晚到：与 required 的 effect 在不同时机写名片，不许互相冲掉
  const { api, act, root } = await mount(
    { ...SPARK, runtime: { python: 'engines/spark-tts/.venv' } }, null, FILES)
  await act(async () => api.setCk('engines/spark-tts/checkpoints'))
  assert.strictEqual(api.m.runtime.checkpoints, 'engines/spark-tts/checkpoints',
    'checkpoints 填没上')
  assert.deepStrictEqual(api.m.models.required, ['BiCodec/bcodec.pt', 'LLM/qwen.pt'],
    'required 被 checkpoints 的写回冲掉了')
  assert.deepStrictEqual(api.m.runtime.verify.sys_path, ['engines/spark-tts'],
    'verify 被 checkpoints 的写回冲掉了')
  await act(async () => root.unmount())
}))

test('置信度标注：确定两格绿徽标、猜的那格黄徽标，且文本出现键名', { skip }, () => withDom(async () => {
  const { el, act, root } = await mount(SPARK, 'engines/spark-tts/checkpoints', FILES)
  const text = el.textContent || ''
  const oks = el.querySelectorAll('.badge-ok')
  const warns = el.querySelectorAll('.badge-warn')
  // 必填槽位区也可能有 badge（未匹配需指定），这里只守自动填这三条：
  //   出现「models.required」说明的那个提示块里，确定的两条带 badge-ok，
  //   猜的那条带 badge-warn。
  // 先定位到声明那一个提示块（文本里有 models.required 与 runtime.verify.sys_path）
  const blocks = [...el.querySelectorAll('.field-hint')]
  const block = blocks.find((b) => b.textContent.includes('models.required')
    && b.textContent.includes('runtime.verify.sys_path'))
  assert.ok(block, '声明置信度的提示块没渲染出来')
  assert.strictEqual(block.querySelectorAll('.badge-ok').length, 2, '确定的那两条该是绿徽标')
  assert.strictEqual(block.querySelectorAll('.badge-warn').length, 1, '猜的那条该是黄徽标')
  assert.ok(oks.length >= 2 && warns.length >= 1, '徽标计数异常（全文）')
  assert.ok(text.includes('models.required') && text.includes('runtime.verify.sys_path'))
  await act(async () => root.unmount())
}))

test('没有任何可填素材（空名片、没文件）⇒ 不填，也没有提示块', { skip }, () => withDom(async () => {
  const { api, el, act, root } = await mount({}, null, null)
  assert.strictEqual(api.m.models, undefined)
  assert.strictEqual(api.m.runtime && api.m.runtime.verify, undefined)
  const blocks = [...el.querySelectorAll('.field-hint')]
  const block = blocks.find((b) => b.textContent.includes('models.required'))
  assert.strictEqual(block, undefined, 'nothing was filled, but a confidence note appeared')
  await act(async () => root.unmount())
}))
