'use strict'
// 第 4 步「引擎配置」区里「运行设备」那一格：开关名 + 「取值写法」小下拉。
//
// 这一格只填开关名时，平台只能按 torch 设备字符串换算。收整数的引擎
//   会把 'cpu' 塞给一个 int 参数，表现是引擎报个类型错，而名片看着没问题。
// 下拉补的是这一件事：这一格的值该怎么写（设备名 / 编号 / 引擎自己列的值）。
//
// 同时守另一件事：写了 parameters[] 的新版名片，这一格不能再写 params.call_time
//   （两份事实并存会被 lib/engines/parameterDeclaration.js 当场拒），
//   要加减 parameters[] 里那一条。旧版名片照旧写 params。

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

const DeviceField = loadJsx('DeviceField.jsx', {
  react: React,
  'web/src/lib/i18n': { useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) },
  './callWhitelist': loadEsm(path.join(EDITOR_DIR, 'callWhitelist.js')),
  './deviceSlots': loadEsm(path.join(EDITOR_DIR, 'deviceSlots.js')),
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
const root = ReactDOMClient.createRoot(container)
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

const NEW = () => ({
  id: 'demo',
  call: { kind: 'cli', argv: ['x.py'], args: {}, seed: 'none' },
  parameters: [{ name: 'speed', type: 'number', phase: 'call' }],
})

const OLD = () => ({
  id: 'demo',
  call: { kind: 'cli', argv: ['x.py'], args: {}, seed: 'none' },
  params: { load_time: [], call_time: ['speed'] },
})

// 挂上去并让写回真的生效：组件的写回是「给我一个函数，对当前名片求值」，
// 这里那个当前名片就是 cur，写完立刻按它重渲染，与 ManifestForm 的行为一致。
let cur = null
async function show (manifest) {
  cur = manifest
  const rerender = () => {
    root.render(React.createElement(DeviceField, {
      manifest: cur,
      onChange: (updater) => {
        cur = typeof updater === 'function' ? updater(cur) : updater
        rerender()
      },
    }))
  }
  rerender()
  await settle()
}

const deviceInput = () => [...container.querySelectorAll('input')]
  .find((i) => i.placeholder === '--device')
const formatSelect = () => container.querySelector('select.wz-device-format')
const optionTexts = (sel) => [...sel.querySelectorAll('option')].map((o) => o.textContent.trim())
const byName = (m, name) => (m.parameters || []).find((p) => p && p.name === name)

test('设备格同时给出开关名与「取值写法」下拉，默认按设备名', async () => {
  await show(NEW())
  assert.ok(deviceInput(), '没有开关名输入框')
  const sel = formatSelect()
  assert.ok(sel, '没有取值写法下拉：收整数的引擎只能拿到 torch 写法的值')
  assert.deepStrictEqual(optionTexts(sel), ['设备名', '编号'])
  assert.strictEqual(sel.value, 'torch', '缺省写法应为设备名')
})

test('填上开关名：进 call.args 与 parameters[]，且不写第二份 params', async () => {
  await show(NEW())
  Simulate.change(deviceInput(), { target: { value: '--device' } })
  await settle()

  const sub = cur.call.args.device
  assert.ok(sub, '开关名没进 call.args')
  assert.strictEqual(sub.flag, '--device')
  assert.strictEqual(sub.role, 'device', '缺 role=device，平台就不知道这一格由设备控件喂')
  assert.strictEqual(sub.device_format, 'torch')

  assert.ok(byName(cur, 'device'), 'parameters[] 里没有 device：派生不出 call_time，宿主会丢掉这个值')
  assert.strictEqual(byName(cur, 'device').type, 'text')
  assert.strictEqual(cur.params, undefined, '新格式名片被写了一份 params：平台加载会当场拒')
})

test('改成「编号」：名片里写上 index，界面能再改回设备名', async () => {
  await show(NEW())
  Simulate.change(deviceInput(), { target: { value: '--device' } })
  await settle()
  Simulate.change(formatSelect(), { target: { value: 'index' } })
  await settle()
  assert.strictEqual(cur.call.args.device.device_format, 'index')

  Simulate.change(formatSelect(), { target: { value: 'torch' } })
  await settle()
  // 设备名是缺省写法：改回来时把字段收走，名片里不留一个会漂的值
  assert.strictEqual(cur.call.args.device.device_format, undefined)
  assert.strictEqual(formatSelect().value, 'torch')
})

test('引擎自己列了候选值时，下拉多出「候选值」这一档', async () => {
  const m = NEW()
  m.call.args.device = { flag: '--device', style: 'value', role: 'device',
    device_format: 'enum', choices: ['cpu', 'cuda'] }
  await show(m)
  assert.deepStrictEqual(optionTexts(formatSelect()), ['设备名', '编号', '候选值'])
  assert.strictEqual(formatSelect().value, 'enum')
})

test('清空开关名：参数、parameters[] 那一条一起收走', async () => {
  await show(NEW())
  Simulate.change(deviceInput(), { target: { value: '--device' } })
  await settle()
  assert.ok(byName(cur, 'device'))

  Simulate.change(deviceInput(), { target: { value: '  ' } })
  await settle()
  assert.strictEqual(cur.call.args.device, undefined)
  assert.strictEqual(byName(cur, 'device'), undefined,
    'parameters[] 里还留着 device：宿主会以为这一格还在收值')
  assert.ok(byName(cur, 'speed'), '别的参数不该被带走')
})

test('旧格式名片照旧写 params.call_time，不会被悄悄升级成新格式', async () => {
  await show(OLD())
  Simulate.change(deviceInput(), { target: { value: '--device' } })
  await settle()
  assert.strictEqual(cur.parameters, undefined)
  assert.deepStrictEqual(cur.params.call_time, ['speed', 'device'])
})

test('没填开关名时下拉不可点（免得以为选个写法就把能力打开了）', async () => {
  await show(NEW())
  assert.strictEqual(formatSelect().disabled, true)
  Simulate.change(deviceInput(), { target: { value: '--device' } })
  await settle()
  assert.strictEqual(formatSelect().disabled, false)
})
