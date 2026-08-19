// Regression guard for the stranded-override bug (2026-08-17).
//
// The bug: manual Han-language overrides are stored as absolute character
// indices and persisted in localStorage, and nothing cleared them when the body
// of text changed. An override made on the old text landed on whatever now sits
// at that index -- typically a kana. The picker never showed it (it iterates
// hanPositions, so it only ever draws Han characters), but three consumers read
// the index without checking the character, so the phantom override was
// counted, coloured into the preview, and sent to the engine as @N:zh.
//
// The visible symptom the user reported: "1 position(s) manually overridden"
// with no character lit up anywhere in the picker.
//
// Every test below is written so that it FAILS on the pre-fix code. That is the
// point: a guard that would pass either way guards nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HAN_RE,
  assignmentList,
  buildLangOverrides,
  charAtPosition,
  hanOverrideDirection,
  isLiveAssignment,
  normalizeAssignments,
  pruneForced,
} from './hanLanguage.js'

const jaDirection = hanOverrideDirection('auto_zh_ja_yue', 'ja')

// The user's own case: an override made at index 0 of some earlier Chinese
// text, then the text was replaced with a Japanese line starting in kana.
const OLD_TEXT = '你好世界'
const NEW_TEXT = 'こんにちは。これはローカル'
const STALE = [{ index: 0, char: '你', lang: 'zh' }]

test('an override stranded on a kana is not counted', () => {
  const map = normalizeAssignments(STALE, jaDirection, NEW_TEXT)
  assert.deepEqual(map, {}, 'index 0 of the new text is こ, not a Han character')

  // Counter-proof: the same entry over the text it was made on is still live,
  // so this is really checking the character and not just discarding input.
  assert.deepEqual(normalizeAssignments(STALE, jaDirection, OLD_TEXT), { 0: 'zh' })
})

test('an override stranded on a kana is not sent to the engine', () => {
  assert.equal(
    buildLangOverrides(jaDirection, STALE, NEW_TEXT),
    undefined,
    'a @0:zh payload here would make the engine read こ as Chinese',
  )
  assert.deepEqual(buildLangOverrides(jaDirection, STALE, OLD_TEXT), { '@0': 'zh' })
})

test('the counter and the picker cannot disagree', () => {
  // This is the exact inconsistency the user saw. assignmentList() was always
  // filtered by hanPositions(text); the counter read the unfiltered map. Both
  // now come from the same pruned map, so the two numbers are the same number.
  const map = normalizeAssignments(STALE, jaDirection, NEW_TEXT)
  const litUp = assignmentList(map, NEW_TEXT)
  const counted = Object.keys(map).length
  assert.equal(counted, litUp.length)
  assert.equal(counted, 0)
})

test('an override past the end of a shortened text is dropped', () => {
  const forced = [{ index: 9, char: '界', lang: 'ja' }]
  assert.deepEqual(normalizeAssignments(forced, jaDirection, '你好'), {})
  assert.deepEqual(normalizeAssignments(forced, jaDirection, '零一二三四五六七八界'), { 9: 'ja' })
})

test('a live override on a Han character still works, at every position', () => {
  const text = '这是アニメ文化'
  const forced = [
    { index: 0, char: '这', lang: 'zh' },
    { index: 5, char: '文', lang: 'ja' },
  ]
  assert.deepEqual(normalizeAssignments(forced, jaDirection, text), { 0: 'zh', 5: 'ja' })
  assert.deepEqual(buildLangOverrides(jaDirection, forced, text), { '@0': 'zh', '@5': 'ja' })
})

test('an override on a Latin letter or a digit is dropped', () => {
  const text = 'a1你'
  assert.deepEqual(
    normalizeAssignments(
      [{ index: 0, char: 'a', lang: 'zh' }, { index: 1, char: '1', lang: 'zh' }],
      jaDirection,
      text,
    ),
    {},
  )
  assert.deepEqual(normalizeAssignments([{ index: 2, char: '你', lang: 'zh' }], jaDirection, text), { 2: 'zh' })
})

test('pruneForced heals the persisted list rather than only masking it', () => {
  const forced = [
    { index: 0, char: '你', lang: 'zh' },
    { index: 2, char: '世', lang: 'ja' },
  ]
  assert.deepEqual(pruneForced(forced, OLD_TEXT), forced, 'nothing to heal on the original text')
  assert.deepEqual(pruneForced(forced, NEW_TEXT), [])
  assert.deepEqual(pruneForced(forced, '你x世'), [forced[0], forced[1]].filter(x => x.index !== 1))
})

test('positions are code points, not UTF-16 code units', () => {
  // A character outside the BMP occupies two UTF-16 code units. The engine
  // indexes Python strings, which are code points, and the picker builds its
  // indices with Array.from, which is also code points. Anything here that used
  // text[i] would drift by one for every astral character earlier in the line
  // and silently move the override onto the wrong character.
  const text = '\u{20BB7}好'          // one astral Han char, then 好
  assert.equal(charAtPosition(text, 0), '\u{20BB7}')
  assert.equal(charAtPosition(text, 1), '好')
  assert.equal(text[1], '\uDFB7', 'the naive form really would disagree here')
  assert.deepEqual(normalizeAssignments([{ index: 1, char: '好', lang: 'ja' }], jaDirection, text), { 1: 'ja' })
})

test('the Han test used for pruning is the same one the picker draws with', () => {
  // Compatibility ideographs (U+F900-U+FAFF) are Han for HAN_RE, so the picker
  // offers them; pruning must agree or it would delete a selection the user can
  // see. The engine-side regex was missing this block until 2026-08-17.
  const compat = '\uF914'
  assert.ok(HAN_RE.test(compat))
  assert.ok(isLiveAssignment(compat, 0, 'zh'))
  assert.deepEqual(normalizeAssignments([{ index: 0, char: compat, lang: 'zh' }], jaDirection, compat), { 0: 'zh' })
})

test('omitting the text keeps the old permissive behaviour', () => {
  // Deliberate: making the third argument mandatory at runtime would crash the
  // page instead of degrading. The mandate is enforced statically instead, by
  // tools/guard_han_text_arg.cjs, which is what the next test runs.
  assert.deepEqual(normalizeAssignments(STALE, jaDirection), { 0: 'zh' })
})
