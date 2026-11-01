'use strict'

// 平台语种词表与历史写法的读取归一。
// 这两张表只在 lib/langCodes.js 定义一份：任何一处再写一份，两处就会各自漂移。

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  PLATFORM_LANGUAGES, LEGACY_LANG_ALIAS, toPlatformLang, legacyLangToPlatform, isPlatformLang,
} = require('./langCodes')

test('平台词表包含的语种', () => {
  assert.deepEqual([...PLATFORM_LANGUAGES], ['zh', 'yue', 'ja', 'en', 'ko', 'auto', 'auto_zh_ja', 'auto_zh_ja_yue'])
  for (const code of PLATFORM_LANGUAGES) {
    assert.equal(isPlatformLang(code), true, `${code} 本身必须被识别`)
    assert.equal(toPlatformLang(code), code, '平台码不经改写')
  }
})

test('历史写法归一成平台码（大小写与首尾空白不敏感）', () => {
  for (const [legacy, platform] of Object.entries(LEGACY_LANG_ALIAS)) {
    assert.equal(toPlatformLang(legacy), platform)
    assert.equal(toPlatformLang(` ${legacy.toUpperCase()} `), platform)
    assert.equal(isPlatformLang(toPlatformLang(legacy)), true, `${legacy} 归一后必须是平台码`)
  }
})

test('平台词表里没有的值原样返回，合法性由调用处判断', () => {
  assert.equal(toPlatformLang('fr'), 'fr', '未知值不改写')
  assert.equal(isPlatformLang('fr'), false)
  assert.equal(toPlatformLang(''), '')
  assert.equal(toPlatformLang(undefined), '')
  assert.equal(toPlatformLang(null), '')
})

test('legacyLangToPlatform 只识别固定的历史写法，不处理大小写与空白', () => {
  assert.equal(legacyLangToPlatform('all_ja'), 'ja')
  assert.equal(legacyLangToPlatform('ALL_JA'), null, '没有历史数据使用这种写法，改写等于替调用方推测')
  assert.equal(legacyLangToPlatform(' all_ja'), null)
  assert.equal(legacyLangToPlatform('ja'), null, '裸码在这条路径上是引擎的写法，不是平台码')
  assert.equal(legacyLangToPlatform(7), null)
  assert.equal(legacyLangToPlatform(undefined), null)
})
