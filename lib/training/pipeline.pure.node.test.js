// lib/training/pipeline.pure.node.test.js
// 纯函数测试：parseListToSegments / mergeCustomParams / classifyFailure
const { test } = require('node:test')
const assert = require('node:assert')
const { parseListToSegments, mergeCustomParams, classifyFailure } = require('./pipeline')

// parseListToSegments — 解析 slicer_opt.list 格式为 segments 数组
// 格式：<path>|<speaker>|<lang>|<text>  （至少 4 列，text 可含 | ）

test('parseListToSegments: 正常输入解析出条目', () => {
  const content = [
    'raw/clip_001.wav|speaker01|zh|你好世界',
    'raw/clip_002.wav|speaker02|ja|こんにちは',
  ].join('\n')
  const segs = parseListToSegments(content)
  assert.strictEqual(segs.length, 2)
  assert.strictEqual(segs[0].index, 0)
  assert.strictEqual(segs[0].scene, 'clip_001')
  assert.strictEqual(segs[0].audio_filename, 'clip_001.wav')
  assert.strictEqual(segs[0].audio_path, 'raw/clip_001.wav')
  assert.strictEqual(segs[0].text, '你好世界')
  assert.strictEqual(segs[0].lang, 'zh')
  assert.strictEqual(segs[0].matched, true)
  assert.strictEqual(segs[0].duration, 0)
  assert.strictEqual(segs[1].index, 1)
  assert.strictEqual(segs[1].lang, 'ja')
})

test('parseListToSegments: 跳过空行', () => {
  const content = [
    'clip_001.wav|spk|zh|你好',
    '',
    '   ',
    'clip_002.wav|spk|ja|こんにちは',
  ].join('\n')
  const segs = parseListToSegments(content)
  assert.strictEqual(segs.length, 2)
})

test('parseListToSegments: 跳过不足 4 列的行', () => {
  const content = [
    'clip_001.wav|spk|zh|你好',
    'bad|line',
    'another|bad|line',
  ].join('\n')
  const segs = parseListToSegments(content)
  assert.strictEqual(segs.length, 1)
})

test('parseListToSegments: text 列可含 | 字符', () => {
  const content = 'clip_001.wav|spk|zh|你好|世界|再见'
  const segs = parseListToSegments(content)
  assert.strictEqual(segs.length, 1)
  assert.strictEqual(segs[0].text, '你好|世界|再见')
})

test('parseListToSegments: lang 为空时返回 undefined', () => {
  const content = 'clip_001.wav|spk||你好'
  const segs = parseListToSegments(content)
  assert.strictEqual(segs[0].lang, undefined)
})

test('parseListToSegments: 空输入返回空数组', () => {
  assert.deepStrictEqual(parseListToSegments(''), [])
  assert.deepStrictEqual(parseListToSegments(null), [])
  assert.deepStrictEqual(parseListToSegments(undefined), [])
})

test('parseListToSegments: 处理 \\r\\n 换行', () => {
  const content = 'clip_001.wav|spk|zh|你好\r\nclip_002.wav|spk|ja|こんにちは'
  const segs = parseListToSegments(content)
  assert.strictEqual(segs.length, 2)
})

test('parseListToSegments: 文件名含多层目录时 scene 取 basename', () => {
  const content = 'a/b/c/clip_001.wav|spk|zh|你好'
  const segs = parseListToSegments(content)
  assert.strictEqual(segs[0].scene, 'clip_001')
  assert.strictEqual(segs[0].audio_filename, 'clip_001.wav')
})

// mergeCustomParams — 深合并 custom 进 base

test('mergeCustomParams: 深合并 training 参数', () => {
  const base = { training: { epochs: 10, batch: 2 } }
  const custom = { training: { epochs: 20 } }
  const result = mergeCustomParams(base, custom)
  assert.strictEqual(result.training.epochs, 20)
  assert.strictEqual(result.training.batch, 2)  // 保留未覆盖的
})

test('mergeCustomParams: 深合并 steps 参数', () => {
  const base = { training: {}, steps: { slice: { params: { dur: 10 } } } }
  const custom = { steps: { slice: { params: { dur: 5, extra: true } } } }
  const result = mergeCustomParams(base, custom)
  assert.strictEqual(result.steps.slice.params.dur, 5)
  assert.strictEqual(result.steps.slice.params.extra, true)
})

test('mergeCustomParams: 新增 steps 键', () => {
  const base = { training: {}, steps: {} }
  const custom = { steps: { train_s1: { params: { lr: 0.001 } } } }
  const result = mergeCustomParams(base, custom)
  assert.deepStrictEqual(result.steps.train_s1.params, { lr: 0.001 })
})

test('mergeCustomParams: custom 为 null 时返回 base', () => {
  const base = { training: { epochs: 10 } }
  const result = mergeCustomParams(base, null)
  assert.strictEqual(result.training.epochs, 10)
})

test('mergeCustomParams: custom 为非对象时返回 base', () => {
  const base = { training: { epochs: 10 } }
  const result = mergeCustomParams(base, 'bad')
  assert.strictEqual(result.training.epochs, 10)
})

test('mergeCustomParams: 不修改原 base', () => {
  const base = { training: { epochs: 10 } }
  const custom = { training: { epochs: 20 } }
  mergeCustomParams(base, custom)
  assert.strictEqual(base.training.epochs, 10)  // 原对象不变
})

// classifyFailure — 将错误消息分类为 OOM / file_locked / error

test('classifyFailure: CUDA OOM 识别', () => {
  const result = classifyFailure('CUDA error: out of memory')
  assert.strictEqual(result.reasonCode, 'oom')
  assert.strictEqual(result.recoverable, true)
})

test('classifyFailure: exit code 137 (OOM kill)', () => {
  const result = classifyFailure('exit code 137')
  assert.strictEqual(result.reasonCode, 'oom')
})

test('classifyFailure: SIGKILL', () => {
  const result = classifyFailure('process killed by SIGKILL')
  assert.strictEqual(result.reasonCode, 'oom')
})

test('classifyFailure: EBUSY 文件锁', () => {
  const result = classifyFailure('EBUSY: resource busy')
  assert.strictEqual(result.reasonCode, 'file_locked')
  assert.strictEqual(result.recoverable, true)
})

test('classifyFailure: EPERM 权限拒绝', () => {
  const result = classifyFailure('EPERM: operation not permitted')
  assert.strictEqual(result.reasonCode, 'file_locked')
})

test('classifyFailure: 未知错误归为 error', () => {
  const result = classifyFailure('something went wrong')
  assert.strictEqual(result.reasonCode, 'error')
  assert.strictEqual(result.recoverable, true)
  assert.strictEqual(result.reason, 'something went wrong')
})

test('classifyFailure: 空消息归为 error', () => {
  const result = classifyFailure('')
  assert.strictEqual(result.reasonCode, 'error')
  assert.strictEqual(result.recoverable, true)
})

test('classifyFailure: 非字符串输入不崩溃', () => {
  const result = classifyFailure(null)
  assert.strictEqual(result.reasonCode, 'error')
})
