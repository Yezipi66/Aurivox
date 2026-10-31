'use strict'

// 平台语种码，和旧写法（引擎原值）到平台码的读取归一：全平台只这一处认旧写法。
// 换成哪台引擎的原话由那台引擎名片的 languages 表说，这里不管。
// toPlatformLang 给「说的是平台的话」的位置（/v1 的 language），大小写与空白不敏感。
// legacyLangToPlatform 只认写死的旧写法本身，给「值本来就是引擎原话」的位置（/api/generate 的 text_lang）：那里的裸码 zh / ja 在引擎里另是一支分支，不许改写。

const PLATFORM_LANGUAGES = Object.freeze(['zh', 'yue', 'ja', 'en', 'ko', 'auto', 'auto_zh_ja', 'auto_zh_ja_yue'])

const LEGACY_LANG_ALIAS = Object.freeze({ all_zh: 'zh', all_yue: 'yue', all_ja: 'ja', all_ko: 'ko' })

function toPlatformLang(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase()
  if (!value) return ''
  return Object.prototype.hasOwnProperty.call(LEGACY_LANG_ALIAS, value) ? LEGACY_LANG_ALIAS[value] : value
}

function legacyLangToPlatform(raw) {
  if (typeof raw !== 'string') return null
  return Object.prototype.hasOwnProperty.call(LEGACY_LANG_ALIAS, raw) ? LEGACY_LANG_ALIAS[raw] : null
}

function isPlatformLang(value) {
  return PLATFORM_LANGUAGES.includes(value)
}

module.exports = { PLATFORM_LANGUAGES, LEGACY_LANG_ALIAS, toPlatformLang, legacyLangToPlatform, isPlatformLang }
