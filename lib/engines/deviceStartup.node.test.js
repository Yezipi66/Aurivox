'use strict'
// 运行设备归启动期：一条链上的三处接线，各守一段。
//   ① 平台记下选中的卡并换成引擎认的写法（deviceChoice）
//   ② 起进程时写进 profile（buildHostProfile）
//   ③ host.py 把启动值拼进 cli 命令行（build_cli_argv）
// 名片一张不改，也没有按引擎名写的分支。

const test = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const { setDeviceChoice, getDeviceChoice, deviceLoadParams } = require('./deviceChoice')
const { buildHostProfile } = require('./hostProfile')

const CALL = {
  args: {
    device: { flag: '--device', style: 'value', role: 'device', device_format: 'torch' },
    speed: { flag: '--speed', style: 'value' },
  },
}

test('选择只记在平台这一层：auto 撤销，未知引擎不受影响', () => {
  setDeviceChoice('probe-device-choice', { kind: 'gpu', index: 1, backend: 'cuda' })
  assert.deepStrictEqual(deviceLoadParams('probe-device-choice', CALL), { device: 'cuda:1' })
  assert.deepStrictEqual(deviceLoadParams('another-engine', CALL), {})
  setDeviceChoice('probe-device-choice', { kind: 'auto' })
  assert.strictEqual(getDeviceChoice('probe-device-choice'), null)
  assert.deepStrictEqual(deviceLoadParams('probe-device-choice', CALL), {})
})

test('没声明 role=device 的引擎，换算恒为空对象', () => {
  assert.deepStrictEqual(deviceLoadParams('x', { args: { speed: { flag: '--speed' } } }), {})
  assert.deepStrictEqual(deviceLoadParams('x', {}), {})
})

test('启动参数允许名片声明的运行设备，并写进 call.init_args', () => {
  const profile = buildHostProfile('fish-audio', process.env, { loadParams: { device: 'cuda' } })
  assert.strictEqual(profile.call.init_args.device, 'cuda',
    '设备值要落进启动 profile，host.py 才读得到')
})

test('启动参数里没声明过的名字仍然当场拒', () => {
  assert.throws(() => buildHostProfile('fish-audio', process.env,
    { loadParams: { not_a_parameter: 'x' } }), /load_params/)
})

const PYTHON = ['python3', 'python'].find((cmd) => {
  try { return spawnSync(cmd, ['--version'], { timeout: 10000 }).status === 0 } catch { return false }
}) || null
const skip = PYTHON ? false : '本机没有 Python'

function py (body) {
  const r = spawnSync(PYTHON, ['-c', [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(__dirname)})`,
    'import host',
    body,
  ].join('\n')], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  })
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

const PY_SETUP = `
call = {"kind": "cli", "argv": ["up", "-m", "demo"], "bind": {"output_path": "-o"},
        "args": {"device": {"flag": "--device", "style": "value", "role": "device"}},
        "init_args": {"device": "cuda", "weights": "{checkpoints}/demo.pth"}}
prof = {"id": "x", "params": {"load_time": [], "call_time": ["device"], "schema": {}}}
slots = {"output_path": "/o.wav"}
`

test('启动期设备值拼进 cli 命令行，构造参数不冒充开关', { skip }, () => {
  const out = py(PY_SETUP + `
print(json.dumps(host.build_cli_argv(call, prof, slots, {}), ensure_ascii=False))
`)
  assert.deepStrictEqual(out, ['up', '-m', 'demo', '-o', '/o.wav', '--device', 'cuda'])
})

test('请求里也带同名键时只发一次，以请求值为准', { skip }, () => {
  const out = py(PY_SETUP + `
print(json.dumps(host.build_cli_argv(call, prof, slots, {"device": "cpu"}), ensure_ascii=False))
`)
  assert.strictEqual(out.filter((w) => w === '--device').length, 1)
  assert.ok(out.includes('cpu') && !out.includes('cuda'))
})

// 设备的唯一来源是平台下发的名片。宿主 import torch 去问本机有什么卡，读的是
// 引擎 venv 里的 torch，同一个字段在不同引擎上就变成三种含义（型号 / cpu / unknown）。
test('⛔ 宿主只回显平台下发的设备，不自己探测本机有什么卡', { skip }, () => {
  const out = py(`
declared = {"kind": "cli", "seed": "none", "init_args": {"device": "xpu"}}
bare = {"kind": "cli", "seed": "none"}
print(json.dumps({
    "with_device": host.Engine({"call": declared}).device,
    "without": host.Engine({"call": bare}).device,
}, ensure_ascii=False))
`)
  assert.strictEqual(out.with_device, 'xpu', '名片里写了什么就回显什么')
  assert.strictEqual(out.without, 'auto',
    '没指定写 auto；写 cpu 会被读成平台替使用者选了 CPU')
})

test('⛔ 宿主源码里不留设备探测，避免平台语义跟着引擎环境走', () => {
  const src = readFileSync(join(__dirname, 'host.py'), 'utf8')
  assert.ok(!/get_device_name\s*\(/.test(src), '型号由平台从系统层读一次，全机一份')
  assert.ok(!/_guess_device/.test(src), '这个探测函数已经撤掉')
})

// 没声明 role=device 的引擎：9886 与向导第 5 步都不该有入口，也不接受选择。
test('设备端点：没声明的引擎 declared=false 且拒绝保存选择', async () => {
  const express = require('express')
  const app = express()
  app.use(express.json())
  app.use(require('../routes/system.js')({ requireApiKey: (req, res, next) => next() }))
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const base = `http://127.0.0.1:${srv.address().port}`
    const get = async (u) => (await fetch(base + u)).json()
    const post = async (u, body) => {
      const r = await fetch(base + u, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: r.status, body: await r.json() }
    }
    const none = await get('/api/devices?engine=kokoro')
    assert.strictEqual(none.declared, false)
    assert.strictEqual(none.choice, null)
    assert.strictEqual((await post('/api/devices/choice',
      { engine: 'kokoro', value: { kind: 'cpu' } })).status, 400)

    const declared = await get('/api/devices?engine=fish-audio')
    assert.strictEqual(declared.declared, true)
    const saved = await post('/api/devices/choice',
      { engine: 'fish-audio', value: { kind: 'cpu' } })
    assert.strictEqual(saved.status, 200)
    assert.deepStrictEqual((await get('/api/devices?engine=fish-audio')).choice, { kind: 'cpu' })
    await post('/api/devices/choice', { engine: 'fish-audio', value: { kind: 'auto' } })
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
})

test('起引擎时设备选择并进 loadParams，显式传值优先', async () => {
  const supPath = require.resolve('./supervisor')
  const ownerPath = require.resolve('../server/engineSupervisor')
  const savedSup = require.cache[supPath]
  const savedOwner = require.cache[ownerPath]
  let seen = null
  require.cache[supPath] = {
    id: supPath, filename: supPath, loaded: true,
    exports: { EngineSupervisor: class {
      reapCrashes() {}
      sweep() {}
      async ensure(profile, selection, opts) { seen = { profile, selection, opts }; return { ok: true } }
    } },
  }
  delete require.cache[ownerPath]
  try {
    const { createEngineSupervisor } = require('../server/engineSupervisor')
    setDeviceChoice('fish-audio', { kind: 'cpu' })
    const sup = createEngineSupervisor(__dirname, { env: {} }, {
      resolveEngineProfile: () => ({}), console: { log() {}, warn() {} },
    })
    await sup.ensure({ id: 'fish-audio' }, {}, {})
    assert.deepStrictEqual(seen.opts.loadParams, { device: 'cpu' },
      'ensure 收到设备值，startupKeyOf 才会因改卡换 key')
    await sup.ensure({ id: 'fish-audio' }, {}, { loadParams: { device: 'cuda' } })
    assert.deepStrictEqual(seen.opts.loadParams, { device: 'cuda' },
      '显式起引擎时传的值优先于平台记录')
    setDeviceChoice('fish-audio', { kind: 'auto' })
  } finally {
    if (savedSup) require.cache[supPath] = savedSup
    else delete require.cache[supPath]
    if (savedOwner) require.cache[ownerPath] = savedOwner
    else delete require.cache[ownerPath]
  }
})

test('向导硬件端点：按引擎回答有没有设备声明', () => {
  const wb = require('../../tools/engine-wizard/core/wizardbridge.js')
  const ask = (url) => {
    let out = null
    const res = { setHeader() {}, writeHead() { return this }, end(s) { out = s } }
    wb.handleHardware({ method: 'GET', url }, res)
    return JSON.parse(out)
  }
  assert.strictEqual(ask('/wizard/hardware?engine=kokoro').device_declared, false)
  assert.strictEqual(ask('/wizard/hardware?engine=fish-audio').device_declared, true)
  assert.strictEqual(ask('/wizard/hardware').device_declared, null)
})
