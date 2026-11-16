'use strict'
// 一个参数与「调用期白名单」一起写（tools/engine-wizard/editor/callWhitelist.js）。
//
// 这条守的是第 4 步「可选能力」区那几格（运行设备 / 辅助参考音频 / 输出格式）写回名片的方式。
// 原来那几处直接改 params.call_time，而写了 parameters[] 的新版名片白名单是派生的：
//   两份事实并存会被 parameterDeclaration.js 当场拒（ENGINE_MANIFEST_INVALID_VALUE），
//   表现是「在向导里改一格设备，保存就报错」，而名片本身是好的。
//
// 判据分两层：
//   1. 行为：新格式只加减 parameters[]、旧格式照旧写 params.call_time；
//   2. 后果：新格式那一路的结果必须能真的被平台派生，且派生出的 call_time 与预期一致
//      （host.py 只把 call_time 里的键交给引擎，派生出错等于引擎收不到参数）。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { esbuild } = require('../../../lib/testDeps.js')

const ROOT = path.join(__dirname, '..', '..', '..')

// 编辑器里的纯函数模块是 ESM（Vite 前端那一套）：用项目同一个 esbuild 编成 CJS 再取。
function loadEsm (file) {
  const code = esbuild().transformSync(fs.readFileSync(file, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(
    mod.exports, () => { throw new Error(path.basename(file) + ' 不该有依赖') }, mod)
  return mod.exports
}

const { withCallKey } = loadEsm(path.join(ROOT, 'tools/engine-wizard/editor/callWhitelist.js'))
const { deriveParameterViews } = require(path.join(ROOT, 'lib/engines/parameterDeclaration'))

const NEW = () => ({
  id: 'demo',
  call: { kind: 'cli', argv: ['x.py'], args: {} },
  parameters: [
    { name: 'speed', type: 'number', phase: 'call' },
    { name: 'device', type: 'text', phase: 'call', label: { en: 'Device', zh: '设备' } },
  ],
})

const OLD = () => ({
  id: 'demo',
  call: { kind: 'cli', argv: ['x.py'], args: {} },
  params: { load_time: [], call_time: ['speed'] },
})

test('新格式：加一个键只动 parameters[]，不产生 params', () => {
  const out = withCallKey(NEW(), 'emotion-audio', true, 'file')
  assert.strictEqual(out.params, undefined, '新格式名片被写了一份 params：平台会当场拒')
  assert.deepStrictEqual(out.parameters.map((p) => p.name),
    ['speed', 'device', 'emotion-audio'])
  const added = out.parameters.find((p) => p.name === 'emotion-audio')
  assert.strictEqual(added.type, 'file')
  assert.strictEqual(added.phase, 'call')
  assert.strictEqual(added.tier, 'advanced')
})

test('新格式：已经声明过的条目不重写（label / type 是人写的）', () => {
  const out = withCallKey(NEW(), 'device', true, 'file')
  const dev = out.parameters.find((p) => p.name === 'device')
  assert.strictEqual(out.parameters.length, 2, '同一个参数被写成了两条')
  assert.strictEqual(dev.type, 'text', '已有的 type 被补条目那一步覆盖了')
  assert.deepStrictEqual(dev.label, { en: 'Device', zh: '设备' }, 'label 被冲掉了')
})

test('新格式：结果能被平台派生，且派生出的 call_time 含这个键', () => {
  const out = withCallKey(NEW(), 'device', true, 'text')
  const derived = deriveParameterViews(out) // 并存会在这里抛
  assert.ok(derived.params.call_time.includes('device'),
    '派生的 call_time 里没有 device：host 不会把它交给引擎')
  assert.ok(derived.payload_keys.includes('device'))
})

test('新格式：摘一个键就少一条，派生后白名单也不含它', () => {
  const out = withCallKey(NEW(), 'device', false)
  assert.deepStrictEqual(out.parameters.map((p) => p.name), ['speed'])
  const derived = deriveParameterViews(out)
  assert.ok(!derived.params.call_time.includes('device'))
})

test('新格式：最后一条也摘掉时删掉整份 parameters，不留空数组', () => {
  const one = { id: 'demo', call: { kind: 'cli', argv: ['x.py'], args: {} },
    parameters: [{ name: 'device', type: 'text', phase: 'call' }] }
  const out = withCallKey(one, 'device', false)
  assert.strictEqual(out.parameters, undefined)
})

test('旧格式：照旧写 params.call_time，且不凭空长出 parameters', () => {
  const out = withCallKey(OLD(), 'device', true, 'text')
  assert.strictEqual(out.parameters, undefined, '旧格式名片被升级成了新格式')
  assert.deepStrictEqual(out.params.call_time, ['speed', 'device'])
})

test('旧格式：不重复加同一个键', () => {
  const out = withCallKey(OLD(), 'speed', true)
  assert.deepStrictEqual(out.params.call_time, ['speed'])
})

test('旧格式：摘最后一个键时删掉 call_time 整段，不留空数组', () => {
  const out = withCallKey(OLD(), 'speed', false)
  assert.strictEqual(out.params.call_time, undefined)
  // load_time 是别的段的事，不该被这一步带走
  assert.deepStrictEqual(out.params.load_time, [])
})

test('不改入参：两次调用互不影响', () => {
  const before = NEW()
  const snapshot = JSON.stringify(before)
  withCallKey(before, 'device', false)
  withCallKey(before, 'emotion-audio', true, 'file')
  assert.strictEqual(JSON.stringify(before), snapshot, 'withCallKey 改了传进来的名片')
})

test('变异自证：新格式里再写一份 params，平台必须拒（这条守的是根因）', () => {
  // 如果哪次把实现改成「两种都写」，上面几条会红；这条说明红了之后平台侧到底会怎么坏。
  const bad = { ...NEW(), params: { load_time: [], call_time: ['device'] } }
  assert.throws(() => deriveParameterViews(bad), (e) => {
    assert.strictEqual(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.strictEqual(e.key, 'params')
    return true
  })
})
