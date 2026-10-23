// autoLanguage.js 的守卫：汉字语种的自动判定。判据只有三个：假名指向日语、粤字把分值推过阈值、
// 否则取调用方给的兜底语种；显式的按位置覆盖始终优先。
// 与 Python 侧 TextPreprocessor.py 的 auto_zh_ja_yue 同一条分句边界，所以证据不会越过逗号串到别处。

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
