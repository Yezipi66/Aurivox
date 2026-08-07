import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyHanRange,
  assignmentList,
  buildLangOverrides,
  hanOverrideDirection,
  normalizeAssignments,
  parseLangOverrides,
  readingKey,
} from './hanLanguage.js'

const zhDirection = hanOverrideDirection('all_zh', 'zh')

test('an explicit fallback-language assignment is still visible and toggleable', () => {
  const forced = [{ index: 0, char: '你', lang: 'zh' }]
  const map = normalizeAssignments(forced, zhDirection)
  assert.deepEqual(map, { 0: 'zh' })
  assert.deepEqual(buildLangOverrides(zhDirection, forced), { '@0': 'zh' })
})

test('alternate Han assignments remain position-specific', () => {
  const text = '你好你'
  const forced = [
    { index: 0, char: '你', lang: 'ja' },
    { index: 2, char: '你', lang: 'yue' },
  ]
  const map = normalizeAssignments(forced, zhDirection)
  assert.deepEqual(assignmentList(map, text), forced)
  assert.deepEqual(buildLangOverrides(zhDirection, forced), { '@0': 'ja', '@2': 'yue' })
})

test('recipe/readback parser ignores unsafe character-global legacy keys', () => {
  assert.deepEqual(parseLangOverrides({ '你': 'ja', '@3': 'yue' }), [{ index: 3, lang: 'yue' }])
})

test('range selection is additive for mixed overlap and subtractive when fully selected', () => {
  const text = '这是一段测试文本'
  const first = [{ index: 0, char: '这' }, { index: 1, char: '是' }, { index: 2, char: '一' }, { index: 3, char: '段' }]
  const overlap = [{ index: 2, char: '一' }, { index: 3, char: '段' }, { index: 4, char: '测' }, { index: 5, char: '试' }]
  const map0 = {}
  const map1 = applyHanRange(map0, first, 'zh').map
  const map2 = applyHanRange(map1, overlap, 'zh').map
  assert.deepEqual(Object.keys(map2).sort(), ['0', '1', '2', '3', '4', '5'])
  const map3 = applyHanRange(map2, overlap, 'zh').map
  assert.deepEqual(Object.keys(map3).sort(), ['0', '1'])
  assert.equal(assignmentList(map3, text).length, 2)
})

test('reading keys preserve repeated-character positions', () => {
  assert.equal(readingKey({ index: 0, char: '你' }), '@0:你')
  assert.equal(readingKey({ index: 2, char: '你' }), '@2:你')
})
