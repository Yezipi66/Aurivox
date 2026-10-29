'use strict'
// 第 4 步「引擎目录 / 启动脚本」代填被冲掉的回归守卫。
//
// 症状：选了一台还没有名片的引擎，两格只显示灰色占位提示（文字恰好就是代填值），
//   没有「平台代填，可改」徽标，保存时报缺 runtime.python / runtime.entry。
//
// 根因：RequiredFields 的代填与 ManifestForm 的权重路径自动填，在同一次提交里各自
//   拿渲染时的名片快照整份写回，后写的把先写的冲掉；代填只盯 id，冲掉后不会再补。
//   选引擎那一刻权重路径不为空就必中：上一台留下的旧路径，或第 1 步克隆的就是这台。
//
// 纯函数测试抓不到：两边各自算得都对，错在写回的方式。所以这里真渲染 ManifestForm，
//   由一个持有名片状态的宿主组件接 onChange（和 App 一样把它直接交给 setState）。

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
export function Host ({ initial, ck }) {
  const [m, setM] = React.useState(initial)
  const [path, setCk] = React.useState(ck)
  api.m = m; api.setM = setM; api.setCk = setCk
  api.switchTo = (id) => setM((cur) => manifestForEngineSwitch(cur, id, id))
  return React.createElement(ManifestForm, {
    manifest: m, spec, onChange: setM, checkpointsPath: path,
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
  const mod = new Module('manifestPrefillRace-harness')
  mod.paths = [path.join(reactDir, '..')]
  mod._compile(out.outputFiles[0].text, path.join(__dirname, 'manifestPrefillRace-harness.js'))
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

async function mount (initial, ck) {
  const React = require(REACT)
  const { createRoot } = require(REACT_DOM)
  const { Host, api } = loadHarness()
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await React.act(async () => root.render(React.createElement(Host, { initial, ck })))
  return { api, act: React.act, root }
}

const CONV = { python: 'engines/cosyvoice2/.venv', entry: '../../lib/engines/host.py' }

test('换引擎时权重路径还是上一台的 ⇒ 代填的引擎目录与启动脚本不被冲掉', { skip }, () => withDom(async () => {
  const prev = {
    id: 'gpt-sovits', label: 'gpt-sovits', contract_version: 2,
    runtime: { python: 'engines/gpt-sovits/.venv', entry: 'x.py', checkpoints: 'engines/gpt-sovits/checkpoints' },
  }
  const { api, act, root } = await mount(prev, 'engines/gpt-sovits/checkpoints')
  await act(async () => api.switchTo('cosyvoice2'))
  assert.strictEqual(api.m.runtime.python, CONV.python)
  assert.strictEqual(api.m.runtime.entry, CONV.entry)
  // 新引擎的权重路径随后到达：只改 checkpoints，两格还在。
  await act(async () => api.setCk('engines/cosyvoice2/checkpoints'))
  assert.deepStrictEqual(api.m.runtime, { ...CONV, checkpoints: 'engines/cosyvoice2/checkpoints' })
  await act(async () => root.unmount())
}))

test('空名片直接选这台、权重路径早已到达 ⇒ 两项都在', { skip }, () => withDom(async () => {
  const { api, act, root } = await mount({}, 'engines/cosyvoice2/checkpoints')
  await act(async () => api.switchTo('cosyvoice2'))
  assert.deepStrictEqual(api.m.runtime, { ...CONV, checkpoints: 'engines/cosyvoice2/checkpoints' })
  await act(async () => root.unmount())
}))

test('两格被别处整段清掉 ⇒ 按惯例补回；写过任何一格 ⇒ 不动', { skip }, () => withDom(async () => {
  const { api, act, root } = await mount({}, null)
  await act(async () => api.switchTo('cosyvoice2'))
  assert.deepStrictEqual(api.m.runtime, CONV)
  await act(async () => api.setM((cur) => ({ ...cur, runtime: undefined })))
  assert.deepStrictEqual(api.m.runtime, CONV)
  await act(async () => api.setM((cur) => ({ ...cur, runtime: { entry: 'engines/cosyvoice2/server.py' } })))
  assert.deepStrictEqual(api.m.runtime, { entry: 'engines/cosyvoice2/server.py' })
  await act(async () => root.unmount())
}))
