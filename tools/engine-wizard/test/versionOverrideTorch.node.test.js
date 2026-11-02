'use strict'
// 「选依赖版本」时 torch 系不能被静默降级。
//
// 判据的理由：改任何一个包的版本都会重写整份清单副本，而上游钉的 torch
//   版本在本机后端上可能装不上（XPU 上没有 2.5.1）。若原样保留那几行，
//   选一个普通包的版本就会把 torch 装成 CPU 版 ⇒ 本机显卡用不上。
//   所以：使用者显式选了 torch 就照他选的；没选就取本机后端上可用的版本。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const VO = require(path.join(__dirname, '..', 'core', 'versionOverrides.js'))

test('改写 torch 系：使用者没选 torch 时，按本机后端上可用的版本改', () => {
  const text = 'einops==0.8.1\ntorch==2.5.1\ntorchaudio==2.5.1\n'
  const r = VO.rewriteTorchFamily(text, { einops: '0.7.0' }, {
    torchVersion: '2.6.0',
    torchNames: ['torch', 'torchaudio', 'torchvision'],
  })
  assert.ok(r.text.includes('einops==0.7.0'), '使用者选的那个要改')
  assert.ok(r.text.includes('torch==2.6.0'), 'torch 要按本机后端改')
  assert.ok(r.text.includes('torchaudio==2.6.0'), 'torchaudio 要跟着改')
  assert.deepStrictEqual(r.torchRewritten.sort(), ['torch', 'torchaudio'])
})

test('改写 torch 系：使用者显式选了 torch 时，照他选的来', () => {
  const text = 'torch==2.5.1\ntorchaudio==2.5.1\n'
  const r = VO.rewriteTorchFamily(text, { torch: '2.7.0' }, {
    torchVersion: '2.6.0',
    torchNames: ['torch', 'torchaudio', 'torchvision'],
  })
  assert.ok(r.text.includes('torch==2.7.0'), '显式选的版本要照用')
  assert.ok(r.text.includes('torchaudio==2.6.0'), '没显式选的那几个按本机后端改')
})

test('改写 torch 系：本机后端上没有可用版本时，不动 torch 那几行', () => {
  const text = 'einops==0.8.1\ntorch==2.5.1\n'
  const r = VO.rewriteTorchFamily(text, { einops: '0.7.0' }, {
    torchVersion: '',
    torchNames: ['torch', 'torchaudio', 'torchvision'],
  })
  assert.ok(r.text.includes('einops==0.7.0'), '使用者选的那个要改')
  assert.ok(r.text.includes('torch==2.5.1'), '给不出可用版本时不动 torch 那行')
  assert.deepStrictEqual(r.torchRewritten, [])
})

test('改写 torch 系：不是 torch 系的包不受影响', () => {
  const text = 'numpy==2.2.3\ntorch==2.5.1\n'
  const r = VO.rewriteTorchFamily(text, {}, {
    torchVersion: '2.6.0',
    torchNames: ['torch', 'torchaudio', 'torchvision'],
  })
  assert.ok(r.text.includes('numpy==2.2.3'), 'numpy 不能动')
  assert.ok(r.text.includes('torch==2.6.0'), 'torch 要改')
})

test('改写 torch 系：区间写法的 torch 保留区间形式', () => {
  const text = 'torch>=2.5.1\n'
  const r = VO.rewriteTorchFamily(text, {}, {
    torchVersion: '2.6.0',
    torchNames: ['torch', 'torchaudio', 'torchvision'],
  })
  assert.ok(r.text.includes('torch>=2.6.0'), '区间形式要保留')
})
