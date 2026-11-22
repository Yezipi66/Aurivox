'use strict'
// 运行设备归到「引擎配置」区之后的位置守卫：默认收起时不画，展开后那一格在
//   引擎配置的折叠体里，而不是可选能力区。设备格本身的读写由 deviceFormatRender 守。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { act } = require(resolveFromRoot('react-dom/test-utils'))
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

function loadJsx (file, stubs) {
  const code = esbuild().transformSync(fs.readFileSync(path.join(EDITOR_DIR, file), 'utf8'),
    { loader: 'jsx', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, (id) => {
      for (const [k, v] of Object.entries(stubs)) if (id === k || id.endsWith(k)) return v
      if (id.endsWith('components/common/Select')) return require('./_selectStub.js')
      throw new Error(file + ' 的依赖不该被求值：' + id)
    }, mod, path.join(EDITOR_DIR, file), EDITOR_DIR)
  return mod.exports
}

const i18n = { useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) }
const DeviceFieldModule = loadJsx('DeviceField.jsx', {
  react: React,
  'web/src/lib/i18n': i18n,
  './callWhitelist': loadEsm(path.join(EDITOR_DIR, 'callWhitelist.js')),
  './deviceSlots': loadEsm(path.join(EDITOR_DIR, 'deviceSlots.js')),
})

const OptionalConfig = loadJsx('OptionalConfig.jsx', {
  react: React,
  'web/src/lib/i18n': i18n,
  './optionalKeys': loadEsm(path.join(EDITOR_DIR, 'optionalKeys.js')),
  './OptionalCapabilities': { __esModule: true, default: () => React.createElement('div', { id: 'caps' }, '可选能力区') },
  './DeviceField': { __esModule: true, ...DeviceFieldModule },
  './deviceSlots': loadEsm(path.join(EDITOR_DIR, 'deviceSlots.js')),
}).default

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url: 'http://localhost:5199/', pretendToBeVisual: true })
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(global, k, { value: dom.window[k] || dom.window, writable: true, configurable: true })
}
global.IS_REACT_ACT_ENVIRONMENT = true
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) })
const container = dom.window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)

const CARD = () => ({ id: 'demo', call: { kind: 'cli', argv: ['x.py'], args: {}, seed: 'none' } })
const settle = async () => { await act(async () => { await Promise.resolve() }) }

const engineHead = () => [...container.querySelectorAll('.wz-subhead')]
  .find((el) => /引擎配置|Engine settings/.test(el.textContent))
const badgeCount = () => Number(engineHead().querySelector('.badge').textContent.trim())

test('区标题数的是这一区的格子数：OPTIONAL_KEYS 九行 + 运行设备一格 = 10', async () => {
  await act(async () => {
    root.render(React.createElement(OptionalConfig, { manifest: CARD(), onChange: () => {} }))
  })
  await settle()
  assert.strictEqual(badgeCount(), 10, '搬进来的设备格要计入引擎配置的计数')

  await act(async () => {
    engineHead().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle()
  const deviceCells = [...container.querySelectorAll('input[placeholder="--device"]')]
    .map((i) => i.closest('.field'))
  const rows = container.querySelectorAll('.wz-opt-grid .wz-opt-row')
  assert.strictEqual(deviceCells.length + rows.length, badgeCount(),
    '徽标要等于展开后真实摆出来的格子数')
})

test('名片声明了多台设备时，计数跟着实际格子数走', async () => {
  const card = CARD()
  card.call.args = {
    device: { flag: '--device', role: 'device' },
    gpu: { flag: '--gpu', role: 'device' },
  }
  await act(async () => {
    root.render(React.createElement(OptionalConfig, { key: 'two', manifest: card, onChange: () => {} }))
  })
  await settle()
  assert.strictEqual(badgeCount(), 11, '两台设备各占一格：9 + 2')
})

test('引擎配置默认收起：运行设备格不出现；展开后出现在折叠体里', async () => {
  await act(async () => {
    root.render(React.createElement(OptionalConfig, { manifest: CARD(), onChange: () => {} }))
  })
  await settle()
  assert.ok(!container.querySelector('input[placeholder="--device"]'),
    '收起时这一格不画，跟其它引擎配置一致')

  const head = [...container.querySelectorAll('.wz-subhead')]
    .find((el) => /引擎配置|Engine settings/.test(el.textContent))
  assert.ok(head, '找不到引擎配置的折叠标题')
  await act(async () => { head.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await settle()
  const dev = container.querySelector('input[placeholder="--device"]')
  assert.ok(dev, '展开后运行设备格要在')
  // 它在折叠体里，不在可选能力区的替身里。
  assert.ok(!container.querySelector('#caps').contains(dev), '运行设备不该回到可选能力区')
  assert.ok(dev.closest('.wz-subhead') === null && !/可选能力区/.test(dev.parentElement.textContent))
})
