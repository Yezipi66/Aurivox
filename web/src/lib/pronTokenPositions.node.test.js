import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mutedTokenPositions,
  previewTokenStarts,
  previewTokenText,
} from './pronTokenPositions.js'

test('preview token offsets stay in Unicode code-point space', () => {
  const text = '😀今日 は今日'
  const tokens = [
    { word: '今日' },
    { word: 'は' },
    { word: '今日' },
  ]
  assert.deepEqual(previewTokenStarts(text, tokens), [1, 4, 5])
})

test('char tokens can derive their source text when word is absent', () => {
  assert.equal(previewTokenText({ chars: [{ char: '今' }, { char: '日' }] }), '今日')
})

test('a token reports only explicitly muted positions', () => {
  assert.deepEqual(mutedTokenPositions(4, '今日', new Set([0, 5, 9])), [5])
  assert.deepEqual(mutedTokenPositions(-1, '今日', new Set([0])), [])
})
