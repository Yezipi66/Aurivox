// 「滞留覆盖」的回归守卫。
//
// 覆盖以字符的绝对下标存进 localStorage，文本改动后没人清掉它们：
// 在旧文本上做的覆盖会落到新文本的同一个下标上，而那里通常是一个假名。
// 选择器里看不见它（它只遍历 hanPositions，只会画出汉字），
// 但有三个消费者不检查字符就读那个下标，于是这条幽灵覆盖会被计数、
// 被画进预览，并以 @N:zh 发给引擎。
//
// 下面每条测试在修好之前都是红的：一个两种情况下都绿的守卫什么也守不住。
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

// 一条在早先的中文文本上做的覆盖，随后文本被换成了以假名开头的日文。
const OLD_TEXT = '你好世界'
const NEW_TEXT = 'こんにちは。これはローカル'
const STALE = [{ index: 0, char: '你', lang: 'zh' }]

test('an override stranded on a kana is not counted', () => {
  const map = normalizeAssignments(STALE, jaDirection, NEW_TEXT)
  assert.deepEqual(map, {}, 'index 0 of the new text is こ, not a Han character')

  // 反证：同一条覆盖落在它被做出来的那段文本上时仍然有效，
  // 所以这里验的确实是字符，而不是把输入一律丢掉。
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
  // 这里要防的正是计数器与选择器不一致：assignmentList() 一直被
  // hanPositions(text) 过滤，计数器读的却是未过滤的表。
  // 现在两者都来自同一张剪过的表。
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
  // BMP 以外的字符占两个 UTF-16 码元。引擎按 Python 字符串下标索引，
  // 而那是码点；选择器用 Array.from 建下标，也是码点。
  // 这里若用 text[i]，每出现一个星芒字符就会错开一位。
  const text = '\u{20BB7}好'          // one astral Han char, then 好
  assert.equal(charAtPosition(text, 0), '\u{20BB7}')
  assert.equal(charAtPosition(text, 1), '好')
  assert.equal(text[1], '\uDFB7', 'the naive form really would disagree here')
  assert.deepEqual(normalizeAssignments([{ index: 1, char: '好', lang: 'ja' }], jaDirection, text), { 1: 'ja' })
})

test('the Han test used for pruning is the same one the picker draws with', () => {
  // 兼容汉字（U+F900-U+FAFF）对 HAN_RE 来说是汉字，选择器会提供它们；
  // 剪枝必须与之一致，否则会把用户看得见的选择删掉。
  const compat = '\uF914'
  assert.ok(HAN_RE.test(compat))
  assert.ok(isLiveAssignment(compat, 0, 'zh'))
  assert.deepEqual(normalizeAssignments([{ index: 0, char: compat, lang: 'zh' }], jaDirection, compat), { 0: 'zh' })
})

test('omitting the text keeps the old permissive behaviour', () => {
  // 故意的：把第三个参数在运行时改成必填，会让页面直接崩掉，而不是降级。
  // 必填这件事由 tools/guard_han_text_arg.cjs 在静态层面守。
  assert.deepEqual(normalizeAssignments(STALE, jaDirection), { 0: 'zh' })
})
