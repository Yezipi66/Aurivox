'use strict'

// languages：平台语种码在该引擎里的写法。
// 左边只能是平台语种码，右边由引擎自己决定；名片没写这张表 ⇒ 空表。

const { plainObject, profileError } = require('./fields')
const { PLATFORM_LANGUAGES, isPlatformLang, legacyLangToPlatform } = require('../../langCodes')

function parseLanguages(manifest) {
  if (manifest.languages === undefined || manifest.languages === null) return {}
  const raw = plainObject(manifest, 'languages', manifest.languages)
  const out = {}
  for (const [platformLang, engineValue] of Object.entries(raw)) {
    if (!isPlatformLang(platformLang)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 languages 里有键 '${platformLang}'，它不是平台语种码。` +
        `左边只能写这些：${PLATFORM_LANGUAGES.join(' / ')}。` +
        '（该引擎的写法写在右边；历史写法到平台码的换算由平台负责，不在名片里。）',
        { id: manifest.id, key: `languages.${platformLang}`, value: engineValue })
    }
    if (typeof engineValue !== 'string' || engineValue === '') {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 languages.${platformLang} 必须是非空字符串（该引擎支持的写法）。`,
        { id: manifest.id, key: `languages.${platformLang}`, value: engineValue })
    }
    out[platformLang] = engineValue
  }
  return out
}

// 两个读法各管一类位置：调用方给的就是平台语种码（/v1/audio/speech 的 language）走 mapLanguage，
// 值本身可能就是引擎写法（/api/generate 的 text_lang / prompt_lang 与音色登记值）走 legacyLangToEngine。
function mapLanguage(languageMap, value) {
  // 表里没有的值按原值返回：平台不推测引擎的写法，也不把引擎可能不支持的值改成别的值。
  return Object.prototype.hasOwnProperty.call(languageMap, value) ? languageMap[value] : value
}

function legacyLangToEngine(languageMap, raw) {
  // 只转换可识别的历史写法；认不出的写法（包括引擎自己的裸码 zh / ja / ko）按原值发送。
  const platform = legacyLangToPlatform(raw)
  return platform === null ? raw : mapLanguage(languageMap, platform)
}

module.exports = { parseLanguages, mapLanguage, legacyLangToEngine }
