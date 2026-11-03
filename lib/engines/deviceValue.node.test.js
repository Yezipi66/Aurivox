'use strict'
// 运行设备换算的守卫：同一个 --device，引擎之间写法不通用，界面却只让使用者选设备。
// 守住三条：没指定就不传（让引擎用自己的默认值）；选了哪块卡就落到对应的编号；
// 引擎自己列了可选值时只照表里填，不拼一个它没写过的值。

const { test } = require('node:test')
const assert = require('node:assert')

const {
  inferFormat, deviceValue, deviceOptions, resolveDeviceArgs,
} = require('./deviceValue.js')

test('格式按扫描到的类型推断：有 choices 照 choices，整数类型是编号写法，其余是 torch 写法', () => {
  assert.strictEqual(inferFormat('int', null), 'index')
  assert.strictEqual(inferFormat(null, null), 'torch')
  assert.strictEqual(inferFormat('str', null), 'torch')
  assert.strictEqual(inferFormat('int', ['cpu', 'cuda']), 'enum')
})

test('未指定就返回 null：这个参数不出现在命令行，引擎走自己的默认值', () => {
  assert.strictEqual(deviceValue({ pick: { kind: 'auto' }, format: 'torch' }), null)
  assert.strictEqual(deviceValue({ pick: null, format: 'index' }), null)
  assert.strictEqual(deviceValue({}), null)
})

test('选 CPU 时给 cpu', () => {
  assert.strictEqual(deviceValue({ pick: { kind: 'cpu' }, format: 'torch' }), 'cpu')
  assert.strictEqual(deviceValue({ pick: { kind: 'cpu' }, format: 'index' }), 'cpu')
})

test('torch 写法：第 0 块给 cuda（不写序号就是第 0 块），其余带序号', () => {
  const fmt = 'torch'
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 0, backend: 'cuda' }, format: fmt }), 'cuda')
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 1, backend: 'cuda' }, format: fmt }), 'cuda:1')
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 3, backend: 'cuda' }, format: fmt }), 'cuda:3')
})

test('编号写法：给整数，不给 cuda', () => {
  const fmt = 'index'
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 0, backend: 'cuda' }, format: fmt }), '0')
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 2, backend: 'cuda' }, format: fmt }), '2')
})

test('编号写法只对 CUDA 成立：核显与 Apple 芯片不传编号，否则会静默用错设备', () => {
  // Spark-TTS 的 --device 是 CUDA 编号。选核显却传 0，等于悄悄跑了独显。
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 1, backend: 'xpu' }, format: 'index' }), null)
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 0, backend: 'mps' }, format: 'index' }), null)
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 1, backend: 'cuda' }, format: 'index' }), '1')
})

test('Intel 显卡给 xpu', () => {
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 0, backend: 'xpu' }, format: 'torch' }), 'xpu')
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 1, backend: 'xpu' }, format: 'torch' }), 'xpu:1')
})

test('引擎列了可选值就只照表里填：表里没有就返回 null，不拼一个它没写过的值', () => {
  const choices = ['cpu', 'cuda', 'cuda:1']
  assert.strictEqual(deviceValue({ pick: { kind: 'cpu' }, format: 'enum', choices }), 'cpu')
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 1, backend: 'cuda' }, format: 'enum', choices }), 'cuda:1')
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 0, backend: 'cuda' }, format: 'enum', choices }), 'cuda')
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 5, backend: 'cuda' }, format: 'enum', choices }), null)
})

test('非法编号当没选：负数与小数都不落成命令行参数', () => {
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: -1, backend: 'cuda' }, format: 'torch' }), null)
  assert.strictEqual(deviceValue({ pick: { kind: 'gpu', index: 1.5, backend: 'cuda' }, format: 'torch' }), null)
})

test('设备清单：自动、CPU，然后独显与核显并排列出，编号连续', () => {
  const opts = deviceOptions([
    { vendor: 'nvidia', index: 0, name: 'NVIDIA GeForce RTX 4090' },
    { vendor: 'intel', index: null, name: 'Intel(R) Arc(TM) 140T GPU' },
  ])
  assert.strictEqual(opts[0].value.kind, 'auto')
  assert.strictEqual(opts[1].value.kind, 'cpu')
  const gpus = opts.filter((o) => o.value.kind === 'gpu')
  assert.strictEqual(gpus.length, 2, '核显也要列出来')
  assert.strictEqual(gpus[0].labelZh, 'GPU 0: NVIDIA GeForce RTX 4090')
  assert.strictEqual(gpus[1].labelZh, 'GPU 1: Intel(R) Arc(TM) 140T GPU')
})

test('CUDA 编号与界面序号错位时，把真实编号标出来', () => {
  const opts = deviceOptions([
    { vendor: 'intel', index: null, name: 'Intel(R) Arc(TM) 140T GPU' },
    { vendor: 'nvidia', index: 0, name: 'NVIDIA GeForce RTX 4090' },
  ])
  const gpus = opts.filter((o) => o.value.kind === 'gpu')
  assert.strictEqual(gpus[1].labelZh, 'GPU 1: NVIDIA GeForce RTX 4090（CUDA 0）',
    '核显排在前面时，NVIDIA 的界面序号与 CUDA 编号会错位，必须标出来')
  assert.strictEqual(gpus[1].value.index, 0, '传给引擎的仍是 CUDA 编号，不是界面序号')
})

test('CUDA 没有编号就不能选；XPU 不写编号就落到第 0 块，可以选', () => {
  const opts = deviceOptions([
    { vendor: 'nvidia', index: null, name: 'NVIDIA GeForce MX150' },
    { vendor: 'intel', index: null, name: 'Intel(R) Arc(TM) 140T GPU' },
  ])
  const gpus = opts.filter((o) => o.value.kind === 'gpu')
  assert.strictEqual(gpus[0].selectable, false, 'CUDA 没编号就分不清选的是哪块卡')
  assert.strictEqual(gpus[1].selectable, true)
})

test('设备清单不认识厂商时不硬塞一项', () => {
  const opts = deviceOptions([{ vendor: 'unknown', index: null, name: 'Some Display Adapter' }])
  assert.strictEqual(opts.filter((o) => o.value.kind === 'gpu').length, 0)
})

test('从名片里认出运行设备的参数并换算，没声明的参数不碰', () => {
  const call = {
    args: {
      speed: { flag: '--speed', style: 'value' },
      device: { flag: '--device', role: 'device', device_format: 'torch' },
    },
  }
  const got = resolveDeviceArgs(call, { kind: 'gpu', index: 1, backend: 'cuda' })
  assert.deepStrictEqual(got, { device: 'cuda:1' }, '只算标了 role="device" 的那一项')
})

test('没选设备时不下发这个参数，引擎用自己的默认值', () => {
  const call = { args: { device: { flag: '--device', role: 'device' } } }
  assert.deepStrictEqual(resolveDeviceArgs(call, { kind: 'auto' }), {})
  assert.deepStrictEqual(resolveDeviceArgs(call, null), {})
})

test('名片没声明运行设备时返回空对象，不硬塞一个', () => {
  assert.deepStrictEqual(resolveDeviceArgs({ args: { speed: { flag: '--speed' } } }, { kind: 'cpu' }), {})
  assert.deepStrictEqual(resolveDeviceArgs({}, { kind: 'cpu' }), {})
  assert.deepStrictEqual(resolveDeviceArgs(null, { kind: 'cpu' }), {})
})

test('编号写法的引擎选核显时不下发，避免静默用了独显', () => {
  const call = { args: { device: { flag: '--device', role: 'device', device_format: 'index' } } }
  assert.deepStrictEqual(resolveDeviceArgs(call, { kind: 'gpu', index: 1, backend: 'xpu' }), {})
  assert.deepStrictEqual(resolveDeviceArgs(call, { kind: 'gpu', index: 1, backend: 'cuda' }), { device: '1' })
})
