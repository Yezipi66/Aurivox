'use strict'
// 权重位的接线：界面上填一位，名片里必须同时长出四样东西。
//
// 只写 weights[] 不写那几处时，症状全是「下拉能选、引擎没收到」，而且几乎不报错：
//   param_keys      缺 ⇒ 名片装不上（这条是四者里唯一会响的）
//   payload_keys    缺 ⇒ 请求体里没有这一份，引擎用回自己的默认权重
//   params.call_time 缺 ⇒ 宿主把它当陌生键丢掉或 400
//   call.args       缺（命令行形态）⇒ 宿主开口就抛「参数没有在 call.args 里说明」
//
// 所以判据不看界面长什么样，而是把写出来的名片真的交给平台解析一遍。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')
const { resolveEngineProfile } = require(path.join(ROOT, 'lib', 'engines', 'profile.js'))
const { buildHostProfile } = require(path.join(ROOT, 'lib', 'engines', 'hostProfile.js'))

// weightSlots.js 是 ESM 纯函数模块：用项目 Vite 依赖的同一个 esbuild 编成 CJS 取导出。
function loadWeightSlots () {
  const esbuild = require(path.join(ROOT, 'lib', 'testDeps.js')).esbuild()
  assert.ok(esbuild, '拿不到 esbuild，没法读 weightSlots.js')
  const file = path.join(__dirname, '..', 'editor', 'weightSlots.js')
  const code = esbuild.transformSync(fs.readFileSync(file, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(
    mod.exports, () => { throw new Error('weightSlots.js 不该有依赖') }, mod)
  return mod.exports
}

// 一张按旧写法（param_keys / params）声明参数的命令行名片：
// 第二位以下的参数都要靠接线补，正好用来验「补得对不对」。
const cliManifest = () => ({
  contract_version: 2,
  id: 'demo',
  label: 'Demo',
  runtime: {
    python: 'engines/demo/.venv',
    entry: '../../lib/engines/host.py',
    args: ['--profile-json', '{profile_json}', '--host', '{host}', '--port', '{port}'],
  },
  call: {
    kind: 'cli',
    argv: ['{engine_python}', '-m', 'demo.cli'],
    args: { alpha: { flag: '--alpha' } },
    bind: { text: '--text', output_path: '--out' },
    seed: 'none',
  },
  param_keys: ['alpha'],
  payload_keys: ['alpha'],
  params: { load_time: [], call_time: ['alpha'], schema: { alpha: { type: 'number', default: 1 } } },
})

function planted (manifest) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wslot-')))
  const dir = path.join(root, 'engines', manifest.id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { root, enginesDir: path.join(root, 'engines') }
}

const threeSlots = () => ([
  { name: 'slow', label: 'Slow AR', param: '--weight1', applies_at: 'call' },
  { name: 'fast', label: 'Fast AR', param: '--weight2', applies_at: 'call' },
  { name: 'codec', label: '', param: '--weight3', applies_at: 'call' },
])

test('参数名去掉开关前缀：界面上填 --weight1，名片里存 weight1', () => {
  const { slotParamName } = loadWeightSlots()
  assert.equal(slotParamName('--weight1'), 'weight1')
  assert.equal(slotParamName('  -w  '), 'w')
  assert.equal(slotParamName(''), '')
})

test('⭐ 填三位：weights 与四处接线一起写，平台与宿主都认', () => {
  const { writeSlots } = loadWeightSlots()
  const m = writeSlots(cliManifest(), threeSlots())

  assert.deepStrictEqual(m.weights.map((s) => [s.name, s.param, s.applies_at]), [
    ['slow', 'weight1', 'call'],
    ['fast', 'weight2', 'call'],
    ['codec', 'weight3', 'call'],
  ])
  assert.equal(m.weights[2].label, 'codec', '显示名留空时用位名，不留一个空标题')

  for (const k of ['weight1', 'weight2', 'weight3']) {
    assert.ok(m.param_keys.includes(k), `param_keys 少了 ${k}：名片装不上`)
    assert.ok(m.payload_keys.includes(k), `payload_keys 少了 ${k}：请求体里没有这一份`)
    assert.ok(m.params.call_time.includes(k), `params.call_time 少了 ${k}：宿主不认这个键`)
    assert.deepStrictEqual(m.call.args[k], { flag: '--' + k }, `call.args 少了 ${k}：命令行上没有这个开关`)
  }

  const { root, enginesDir } = planted(m)
  try {
    const prof = resolveEngineProfile('demo', {}, { enginesDir, localRoot: root })
    assert.deepStrictEqual(prof.weight_slots.map((s) => s.name), ['slow', 'fast', 'codec'],
      '名片里三位，合成页才长得出三个下拉')
    assert.deepStrictEqual(prof.weight_slots.map((s) => s.param), ['weight1', 'weight2', 'weight3'])
    assert.deepStrictEqual(prof.param_schema.map((f) => f.name), ['alpha'],
      '权重位指向的参数不该再出现在参数面板里：两个编辑口会互相盖')
    const host = buildHostProfile('demo', {}, { enginesDir, localRoot: root })
    assert.deepStrictEqual(host.params.call_time, ['alpha', 'weight1', 'weight2', 'weight3'])
    assert.equal(host.call.args.weight1.flag, '--weight1')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('删一位：它的键从那几处一起收走，人写过的开关不动', () => {
  const { writeSlots } = loadWeightSlots()
  const m = writeSlots(cliManifest(), threeSlots())
  const back = writeSlots(m, threeSlots().filter((s) => s.name !== 'fast'))

  assert.deepStrictEqual(back.weights.map((s) => s.name), ['slow', 'codec'])
  assert.ok(!back.param_keys.includes('weight2') && !back.payload_keys.includes('weight2'))
  assert.ok(!back.params.call_time.includes('weight2'))
  assert.ok(!('weight2' in back.call.args))
  assert.ok('alpha' in back.call.args, '人写过的开关不许被顺手删掉')

  const none = writeSlots(back, [])
  assert.equal(none.weights, undefined, '一位都不剩时不留一个空的 weights 段')
  assert.deepStrictEqual(none.params.call_time, ['alpha'])
})

test('launch 位不许带 param：两句话矛盾，平台会当场拒收', () => {
  const { writeSlots } = loadWeightSlots()
  const m = writeSlots(cliManifest(), [
    { name: 'model', label: 'Model', param: '--weight1', applies_at: 'launch' },
  ])
  assert.deepStrictEqual(m.weights, [{ name: 'model', label: 'Model', applies_at: 'launch' }],
    '选了 launch 就把参数名摘掉，别存下一张装不上的名片')
  assert.ok(!m.param_keys.includes('weight1'))
})

test('重名与空名都不写：位名就是磁盘目录名', () => {
  const { writeSlots } = loadWeightSlots()
  const m = writeSlots(cliManifest(), [
    { name: 'slow', label: '', param: '--w1', applies_at: 'call' },
    { name: 'slow', label: '第二个 slow', param: '--w2', applies_at: 'call' },
    { name: '   ', label: '空名字', param: '--w3', applies_at: 'call' },
  ])
  assert.deepStrictEqual(m.weights.map((s) => s.name), ['slow'])
  assert.deepStrictEqual(m.weights.map((s) => s.param), ['w1'])
})
