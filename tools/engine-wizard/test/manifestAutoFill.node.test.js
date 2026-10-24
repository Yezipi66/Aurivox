'use strict'
// manifestAutoFill 守的 bug：第 4 步的名片把 runtime.checkpoints 填到别的目录，
//   于是第 3 步说权重下好了、第 5 步说目录不存在（两个判据看的是两个地方）。
//
// 判据：runtime.checkpoints 自动填成第 3 步的落盘路径，且只在该填的时候填。
//   该填：引擎 id 定了、这一格还是空的、落盘路径拿得到。
//   不该填：使用者已经填过（不许覆盖）、id 还没定（算不出路径）、没有路径。

const { test } = require('node:test')
const assert = require('node:assert')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

const AUTO_FILL = path.join(__dirname, '..', 'editor', 'manifestAutoFill.js')

let shouldAutoFillCheckpoints
let withAutoFilledCheckpoints

test('加载 manifestAutoFill.js', async () => {
  const m = await import(pathToFileURL(AUTO_FILL).href)
  shouldAutoFillCheckpoints = m.shouldAutoFillCheckpoints
  withAutoFilledCheckpoints = m.withAutoFilledCheckpoints
  assert.strictEqual(typeof shouldAutoFillCheckpoints, 'function')
  assert.strictEqual(typeof withAutoFilledCheckpoints, 'function')
})

const CP = 'engines/index-tts/checkpoints'

// ① 该填
test('引擎 id 定了、这一格空着、路径拿得到 ⇒ 该填', () => {
  assert.strictEqual(
    shouldAutoFillCheckpoints({ id: 'index-tts' }, CP), true)
})

test('runtime 段在但没有 checkpoints 这一格 ⇒ 该填', () => {
  assert.strictEqual(
    shouldAutoFillCheckpoints({ id: 'index-tts', runtime: { python: 'engines/x/.venv' } }, CP),
    true)
})

// ② 不该填
test('使用者已经填过 ⇒ 不填（不许覆盖他填的）', () => {
  assert.strictEqual(
    shouldAutoFillCheckpoints({ id: 'index-tts', runtime: { checkpoints: 'models/tts/x' } }, CP),
    false)
})

test('引擎 id 还没定 ⇒ 不填（算不出这一台的路径）', () => {
  assert.strictEqual(shouldAutoFillCheckpoints({}, CP), false)
  assert.strictEqual(shouldAutoFillCheckpoints(null, CP), false)
  assert.strictEqual(shouldAutoFillCheckpoints({ id: '' }, CP), false)
})

test('落盘路径还没拿到 ⇒ 不填', () => {
  assert.strictEqual(shouldAutoFillCheckpoints({ id: 'index-tts' }, null), false)
  assert.strictEqual(shouldAutoFillCheckpoints({ id: 'index-tts' }, ''), false)
})

// ③ 填出来的样子
test('填完的那一格就是落盘路径，别的一格不动', () => {
  const before = { id: 'index-tts', runtime: { python: 'engines/x/.venv' } }
  const after = withAutoFilledCheckpoints(before, CP)
  assert.strictEqual(after.runtime.checkpoints, CP)
  assert.strictEqual(after.runtime.python, 'engines/x/.venv')
  assert.strictEqual(after.id, 'index-tts')
  // 原对象不动：React 靠引用变化判断要不要重渲染
  assert.strictEqual(before.runtime.checkpoints, undefined)
})

test('名片没有 runtime 段 ⇒ 填完会多出一个 runtime 段', () => {
  const after = withAutoFilledCheckpoints({ id: 'index-tts' }, CP)
  assert.strictEqual(after.runtime.checkpoints, CP)
})

// ④ 与后端同源：填的值必须是后端算出来的那个
test('填的值与后端落盘路径同源（core/checkpointsPath.js）', async () => {
  const { checkpointsRelPath } = require('../core/checkpointsPath.js')
  const rel = checkpointsRelPath('index-tts')
  assert.strictEqual(rel, CP)
  // 后端送来的路径与它算出来的一致
  const after = withAutoFilledCheckpoints({ id: 'index-tts' }, rel)
  assert.strictEqual(after.runtime.checkpoints, checkpointsRelPath('index-tts'))
})

// ⑤ 文件里不许出现具体引擎名（活代码）
test('manifestAutoFill.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const fs = require('node:fs')
  const src = fs.readFileSync(AUTO_FILL, 'utf8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})
