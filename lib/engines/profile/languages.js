'use strict'

// languages：平台语种码在这台引擎里的原话。
// 左边只能是平台的词，右边由引擎自己决定；名片没写这张表 ⇒ 空表，平台语种原样发出。
// 平台不猜引擎认哪些写法，也不替它补前缀。

const { plainObject, profileError } = require('./fields')
const { PLATFORM_LANGUAGES, isPlatformLang, toPlatformLang, legacyLangToPlatform } = require('../../langCodes')

function parseLanguages(manifest) {
  if (manifest.languages === undefined || manifest.languages === null) return {}
  const raw = plainObject(manifest, 'languages', manifest.languages)
  const out = {}
  for (const [platformLang, engineValue] of Object.entries(raw)) {
    if (!isPlatformLang(platformLang)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 languages 里有键 '${platformLang}'，它不是平台语种码。` +
        `左边只能写这些：${PLATFORM_LANGUAGES.join(' / ')}。` +
        '（这台引擎的原话写在右边；历史写法到平台码的换算是平台的事，不在名片里。）',
        { id: manifest.id, key: `languages.${platformLang}`, value: engineValue })
    }
    if (typeof engineValue !== 'string' || engineValue === '') {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 languages.${platformLang} 必须是非空字符串（这台引擎认的写法）。`,
        { id: manifest.id, key: `languages.${platformLang}`, value: engineValue })
    }
    out[platformLang] = engineValue
  }
  return out
}

// 取这台引擎的写法。表里没有的值原样返回：平台不替引擎猜一个写法，
// 也不把引擎可能不认识的值改成别的值。
function mapLanguage(languageMap, value) {
  const map = languageMap || {}
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : value
}

// 平台边界（/v1 的 language 参数）：先把旧写法读成平台码，再换成这台引擎的原话。
function platformLangToEngine(languageMap, raw) {
  return mapLanguage(languageMap, toPlatformLang(raw))
}

// 引擎形状的位置（/api/generate 的 text_lang / prompt_lang）：只翻译认得的旧写法。
// 认不得的写法（包括引擎自己的裸码 zh / ja / ko）原样发出。
function legacyLangToEngine(languageMap, raw) {
  const platform = legacyLangToPlatform(raw)
  return platform === null ? raw : mapLanguage(languageMap, platform)
}

module.exports = { parseLanguages, mapLanguage, platformLangToEngine, legacyLangToEngine }
