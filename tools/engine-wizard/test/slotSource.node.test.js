'use strict'
// 一个值只有一个去处：同一个槽位要么在 call.bind 里给开关名，要么在 call.argv 里给占位符。
//
// 这条互斥由平台强制：lib/engines/hostProfile.js 与 core/validate.js 都拒「同一槽位两处都写」
//（一次合成会把这个值发两遍）。界面必须跟着同一口径，否则会催人填一个填了就被拒的格子。
//
// 守的三条：
//   ① 由位置参数供值的槽位，必填区那格不可填、挂「位置参数供值」、不画成未填；
//   ② 把 argv 里的占位符删掉后，那一格恢复可填；
//   ③ 界面认的槽位名集合与平台 BIND_SLOTS 一致，平台加槽位时这里不会漏掉。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const EDITOR = path.join(__dirname, '..', 'editor')
const BIND_SLOTS = require('../../../lib/engines/hostProfile.js').BIND_SLOTS

const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { act } = require(resolveFromRoot('react-dom/test-utils'))
const { JSDOM } = require(resolveFromRoot('jsdom'))

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url: 'http://localhost:5199/', pretendToBeVisual: true })
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(global, k, { value: dom.window[k] || dom.window, writable: true, configurable: true })
}

function loadModule (file, stubs) {
  const code = esbuild().transformSync(fs.readFileSync(path.join(EDITOR, file), 'utf8'),
    { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, (id) => {
      for (const [k, v] of Object.entries(stubs)) if (id === k || id.endsWith(k)) return v
      if (id.endsWith('components/common/Select')) return require('./_selectStub.js')
      throw new Error('缺少依赖：' + id)
    }, mod, file, EDITOR)
  return mod.exports
}

const i18n = { __esModule: true, useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) }
// 推理入口与本组断言无关，换成一个不渲染的替身，省掉它自己那一串依赖。
const RequiredFields = loadModule('RequiredFields.jsx', {
  react: React,
  'web/src/lib/i18n': i18n,
  './EntryChoice': { __esModule: true, default: () => null },
  './optionalKeys': loadModule('optionalKeys.js', {}),
  './weightsField': loadModule('weightsField.js', {}),
  './textEntryField': loadModule('textEntryField.js', {}),
}).default

const container = dom.window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)
let seq = 0
async function show (manifest) {
  seq += 1
  act(() => {
    root.render(React.createElement(RequiredFields, { key: 'rf' + seq, manifest, onChange: () => {} }))
  })
  await act(async () => { await Promise.resolve() })
}

const card = (argv, bind) => ({
  id: 'demo',
  label: 'demo',
  contract_version: 2,
  runtime: {
    python: 'engines/demo/.venv/Scripts/python.exe',
    entry: 'engines/demo/tts.py',
    checkpoints: 'engines/demo/checkpoints',
  },
  call: { kind: 'cli', argv, bind: bind || {}, args: {}, seed: 'none' },
})

const fieldOf = (label) => [...container.querySelectorAll('.field')]
  .find((f) => (f.querySelector('.field-label') || {}).textContent === label)
const inputOf = (label) => fieldOf(label).querySelector('input')
const badgeText = (label) => [...fieldOf(label).querySelectorAll('.badge')]
  .map((b) => b.textContent).join(' | ')

test('⭐⭐⭐ 位置参数供值的槽位在必填区不可填，且挂「位置参数供值」', async () => {
  await show(card(['{engine_python}', '-m', 'tts', '{text}', '{output_path}'], { ref_audio: '--ref-audio' }))

  for (const label of ['合成文本', '输出']) {
    assert.strictEqual(inputOf(label).disabled, true,
      label + '：值已经在命令行词序里按位置给了，这里再填就会把同一个值发两遍')
    assert.match(inputOf(label).placeholder, /位置参数/, label + '：要说清值是从哪来的')
    assert.match(badgeText(label), /位置参数供值/)
    assert.ok(!/未匹配|需指定/.test(badgeText(label)),
      label + '：已经有值了，不能还挂着「需指定」')
  }
  // 绑了开关的槽位照旧可填，不能被这一条连坐。
  assert.strictEqual(inputOf('参考音频').disabled, false)
  assert.strictEqual(inputOf('参考音频').value, '--ref-audio')
})

test('⭐⭐ 位置参数供值的槽位不画成「未填」', async () => {
  await show(card(['{engine_python}', '-m', 'tts', '{text}', '{output_path}']))
  const unset = [...container.querySelectorAll('.field.wz-unset')]
    .map((f) => (f.querySelector('.field-label') || {}).textContent)
  assert.ok(!unset.includes('合成文本'), '合成文本已由位置参数供值，不该是未填态')
  assert.ok(!unset.includes('输出'), '输出已由位置参数供值，不该是未填态')
})

test('⭐⭐ 删掉 argv 里的占位符后，那一格恢复可填', async () => {
  await show(card(['{engine_python}', '-m', 'tts', '{output_path}']))
  assert.strictEqual(inputOf('合成文本').disabled, false,
    '文本不再由位置参数供值，必填区要把它收回来')
  assert.ok(!/位置参数供值/.test(badgeText('合成文本')))
  assert.strictEqual(inputOf('输出').disabled, true, '输出的占位符还在，仍然不可填')
})

test('⭐⭐⭐ 界面认的槽位名与平台 BIND_SLOTS 一致', () => {
  const src = fs.readFileSync(path.join(EDITOR, 'RequiredFields.jsx'), 'utf8')
  const m = /matchAll\(\/\\\{\(([^)]*)\)\\\}\/g\)/.exec(src)
  assert.ok(m, '从 argv 里认占位符的那条正则找不到了')
  const names = m[1].split('|').map((x) => x.trim()).sort()
  assert.deepStrictEqual(names, [...BIND_SLOTS].sort(),
    '平台加了槽位就必须在这里同步，否则新槽位按位置给值时这一区认不出来')
})

test('⭐⭐ argv 里的路径占位符不算槽位', async () => {
  await show(card(['{engine_python}', '-m', 'tts']))
  for (const label of ['合成文本', '输出']) {
    assert.strictEqual(inputOf(label).disabled, false,
      label + '：{engine_python} 这类路径占位符不是输入槽位，不该让这一格不可填')
  }
})
