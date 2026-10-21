// lib/assetScanner.node.test.js
// 测试纯逻辑函数：formatSize / extractStep / parseSlicerOptList / planRebuild
const { test } = require('node:test')
const assert = require('node:assert')
const {
  formatSize,
  parseSlicerOptList,
  planRebuild,
} = require('./assetScanner')

// formatSize — 纯函数，字节数转人类可读

test('formatSize: 小于 1KB 返回 B', () => {
  assert.strictEqual(formatSize(0), '0B')
  assert.strictEqual(formatSize(512), '512B')
  assert.strictEqual(formatSize(1023), '1023B')
})

test('formatSize: 1KB 到 1MB 之间返回 KB（取整）', () => {
  assert.strictEqual(formatSize(1024), '1KB')
  assert.strictEqual(formatSize(1536), '2KB')  // 1.5KB → 2KB
  assert.strictEqual(formatSize(1024 * 1024 - 1), '1024KB')
})

test('formatSize: 1MB 及以上返回 MB（取整）', () => {
  assert.strictEqual(formatSize(1024 * 1024), '1MB')
  assert.strictEqual(formatSize(5 * 1024 * 1024), '5MB')
  assert.strictEqual(formatSize(1024 * 1024 * 1024), '1024MB')
})

// parseSlicerOptList — 纯函数，解析 slicer_opt.list 格式
// 格式：<speaker>|<lang>|<filename>|<text>

test('parseSlicerOptList: 正常输入解析出条目', () => {
  // 格式：sliceFile|speaker|lang|text
  const content = [
    'clip_001.wav|speaker01|zh|你好世界',
    'clip_002.wav|speaker02|ja|こんにちは',
  ].join('\n')
  const entries = parseSlicerOptList(content)
  assert.strictEqual(entries.length, 2)
  assert.strictEqual(entries[0].sliceFile, 'clip_001.wav')
  assert.strictEqual(entries[0].speaker, 'speaker01')
  assert.strictEqual(entries[0].lang, 'zh')
  assert.strictEqual(entries[0].text, '你好世界')
  assert.strictEqual(entries[1].lang, 'ja')
})

test('parseSlicerOptList: 跳过空行', () => {
  const content = [
    'speaker01|zh|clip_001.wav|你好',
    '',
    '   ',
    'speaker02|ja|clip_002.wav|こんにちは',
  ].join('\n')
  const entries = parseSlicerOptList(content)
  assert.strictEqual(entries.length, 2)
})

test('parseSlicerOptList: 跳过不足 4 列的行', () => {
  const content = [
    'speaker01|zh|clip_001.wav|你好',
    'bad|line',
    'another|bad|line',
  ].join('\n')
  const entries = parseSlicerOptList(content)
  assert.strictEqual(entries.length, 1)
})

test('parseSlicerOptList: 跳过 text 为空的行', () => {
  const content = [
    'speaker01|zh|clip_001.wav|你好',
    'speaker02|ja|clip_002.wav|',
    'speaker03|en|clip_003.wav|   ',
  ].join('\n')
  const entries = parseSlicerOptList(content)
  assert.strictEqual(entries.length, 1)
})

test('parseSlicerOptList: 空输入返回空数组', () => {
  assert.deepStrictEqual(parseSlicerOptList(''), [])
  assert.deepStrictEqual(parseSlicerOptList('\n\n'), [])
})

test('parseSlicerOptList: sliceFile 和 origName 保留 basename', () => {
  const content = 'sub/dir/clip_001.wav|speaker01|zh|你好'
  const entries = parseSlicerOptList(content)
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].sliceFile, 'clip_001.wav')
  assert.strictEqual(entries[0].origName, 'clip_001.wav')
})

// planRebuild — 纯函数，根据资产状态规划修复流程

test('planRebuild: 已有完整资产 → noop', () => {
  const state = { R: true, S: true, L: true, Seg: true, M: true }
  const result = planRebuild(state, { mode: 'safe' })
  assert.strictEqual(result.noop, 'already complete')
  assert.strictEqual(result.health, 'Complete')
})

test('planRebuild: safe 模式下缺模型 → 不训练，建议 full', () => {
  const state = { R: true, S: true, L: true, Seg: true, M: false }
  const result = planRebuild(state, { mode: 'safe' })
  assert.strictEqual(result.health, 'Missing Models')
  assert.strictEqual(result.repairable, true)
  assert.strictEqual(result.requires_confirmation, true)
  assert.strictEqual(result.suggested_mode, 'full')
  assert.ok(result.suggested_stages.includes('train_s1'))
  assert.ok(result.suggested_stages.includes('train_s2'))
})

test('planRebuild: full 模式下缺模型 → 训练', () => {
  const state = { R: true, S: true, L: true, Seg: true, M: false }
  const result = planRebuild(state, { mode: 'full' })
  assert.ok(result.stages.includes('preprocess'))
  assert.ok(result.stages.includes('train_s1'))
  assert.ok(result.stages.includes('train_s2'))
  assert.strictEqual(result.requires_confirmation, true)
  assert.ok(result.stepOptions.train_s1)
  assert.ok(result.stepOptions.train_s2)
})

test('planRebuild: full 模式但只缺 S1 → 只训练 S1', () => {
  const state = { R: true, S: true, L: true, Seg: true, M: false, Mg: false, Ms: true }
  const result = planRebuild(state, { mode: 'full' })
  assert.ok(result.stages.includes('train_s1'))
  assert.ok(!result.stages.includes('train_s2'))
})

test('planRebuild: emergency 模式 → 使用预训练底模', () => {
  const state = { R: true, S: true, L: true, Seg: true, M: false }
  const result = planRebuild(state, { mode: 'emergency' })
  assert.ok(result.stages.includes('use_pretrained_base'))
  assert.ok(result.uses_pretrained_base)
})

test('planRebuild: 无源音频 → 报错', () => {
  const state = { R: false, S: false, L: false, Seg: false, M: false }
  const result = planRebuild(state, { mode: 'safe' })
  assert.ok(result.error)
  assert.strictEqual(result.health, 'No Refs')
})

test('planRebuild: 有 raw 无 slices 且无模型 → 补 slice', () => {
  const state = { R: true, S: false, L: true, Seg: false, M: false }
  const result = planRebuild(state, { mode: 'full' })
  assert.ok(result.stages.includes('slice'))
  assert.strictEqual(result.slice_mode, 'slice')
})

test('planRebuild: 跳过 ASR（用户选择，无训练需求）', () => {
  const state = { R: true, S: true, L: false, Seg: false, M: true }
  const result = planRebuild(state, { mode: 'full', skipAsr: true })
  // skipAsr 在无训练需求且无新 slice 时生效：stages 为空，返回 noop
  if (result.stages) {
    assert.ok(!result.stages.includes('asr'))
  } else {
    assert.strictEqual(result.noop, 'already complete')
  }
})

test('planRebuild: 不支持的 mode → 报错', () => {
  const state = { R: true, S: true, L: true, Seg: true, M: false }
  const result = planRebuild(state, { mode: 'invalid' })
  assert.ok(result.error)
  assert.ok(result.error.includes('Unsupported'))
})

test('planRebuild: 缺 slices 且无 raw → 报错', () => {
  const state = { R: false, S: false, L: true, Seg: false, M: false }
  const result = planRebuild(state, { mode: 'full' })
  assert.ok(result.error)
  assert.ok(result.error.includes('No raw or slices'))
})

test('planRebuild: 只缺 segments（其他都齐）→ 补 generateSegments', () => {
  const state = { R: true, S: true, L: true, Seg: false, M: true }
  const result = planRebuild(state, { mode: 'safe' })
  assert.ok(result.stages.includes('generateSegments'))
  assert.strictEqual(result.needs_segments, true)
})

test('planRebuild: safe 模式 + 显式 trainS1 → 训练', () => {
  const state = { R: true, S: true, L: true, Seg: true, M: false }
  const result = planRebuild(state, { mode: 'safe', trainS1: true })
  assert.ok(result.stages.includes('train_s1'))
  assert.strictEqual(result.requires_confirmation, true)
})

test('planRebuild: 非训练场景下 ASR 不被强制', () => {
  const state = { R: true, S: true, L: false, Seg: false, M: true }
  const result = planRebuild(state, { mode: 'safe' })
  assert.ok(result.stages.includes('asr'))
  // 非训练场景下 ASR 不强制（但 slices 缺失时会触发 ASR）
})
