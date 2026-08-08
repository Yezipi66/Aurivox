import test from 'node:test'
import assert from 'node:assert/strict'
import { inferAutoHanLanguages } from './autoLanguage.js'

function tagged(text, base = 'zh') {
  const langs = inferAutoHanLanguages(text, base)
  return Array.from(text).map((ch, i) => ({ ch, lang: langs[i] })).filter(x => /[\u3400-\u9fff]/u.test(x.ch))
}

test('Auto preview assigns Han in a kana clause to Japanese', () => {
  assert.ok(tagged('今日は少し長い文章を読み上げてもらいます。').every(x => x.lang === 'ja'))
})

test('Auto preview keeps kana-free Chinese at the chosen fallback', () => {
  assert.ok(tagged('你好，这里是一段测试文本。', 'zh').every(x => x.lang === 'zh'))
})

test('Auto preview matches backend Cantonese marker routing without leaking across a comma', () => {
  const items = tagged('好，我故且相信佢哋经常嚟过问我嘅近况。', 'zh')
  assert.equal(items[0].lang, 'zh')
  assert.ok(items.slice(1).every(x => x.lang === 'yue'))
})

test('explicit position override wins over contextual Japanese routing', () => {
  const text = '今日は。'
  const read = inferAutoHanLanguages(text, 'zh', { 0: 'zh' })
  assert.equal(read[0], 'zh')
  assert.equal(read[1], 'ja')
})
