'use strict'

// 平台语种码，以及历史写法（all_zh 这类引擎原值）到平台码的读取归一：全平台只在这一处识别历史写法。
// 换成哪台引擎的写法由那台引擎名片的 languages 表决定；两个归一函数各用在哪个位置见 lib/engines/profile/languages.js。

const PLATFORM_LANGUAGES = Object.freeze(['zh', 'yue', 'ja', 'en', 'ko', 'auto', 'auto_zh_ja', 'auto_zh_ja_yue'])

const LEGACY_LANG_ALIAS = Object.freeze({ all_zh: 'zh', all_yue: 'yue', all_ja: 'ja', all_ko: 'ko' })

function toPlatformLang(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase()
  if (!value) return ''
  return Object.prototype.hasOwnProperty.call(LEGACY_LANG_ALIAS, value) ? LEGACY_LANG_ALIAS[value] : value
}

// 只认 LEGACY_LANG_ALIAS 里那四个写法，其余返回 null：值本身就是引擎写法的位置不能顺手归一，
// 引擎自己的裸码 zh / ja 与历史写法 all_ja 在引擎里走的是两条分支。
function legacyLangToPlatform(raw) {
  if (typeof raw !== 'string') return null
  return Object.prototype.hasOwnProperty.call(LEGACY_LANG_ALIAS, raw) ? LEGACY_LANG_ALIAS[raw] : null
}

function isPlatformLang(value) {
  return PLATFORM_LANGUAGES.includes(value)
}

module.exports = { PLATFORM_LANGUAGES, LEGACY_LANG_ALIAS, toPlatformLang, legacyLangToPlatform, isPlatformLang }
