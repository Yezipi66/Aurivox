// Reading-proofing / multilingual module. Extracted verbatim from App.jsx (no logic change).
import { useT } from '../../lib/i18n'
import { readingAt, readingKey } from '../../lib/hanLanguage'
import {
  buildLangOverrides,
  hanOverrideDirection,
  parseLangOverrides,
  pruneForced,
  LANG_LABEL,
} from '../../lib/hanLanguage'
import { PronPanel } from './PronPanel'
import { TextPrepModal } from './TextPrepModal'

// Item 17: localised language name for use inside translated sentences. Technical
// reading units (kana, ARPABET, pinyin, jyutping) always stay English.
// 刀 A1（2026-08-31）：读音预览必须跟着当前选中的那台引擎走。
//   缺引擎时说的是「去哪儿能补上」，不是一句 "Preview failed (400)"。
//   也不许改成"帮你挑一台"，理由写在 PronPanel 的文件内注释里。
const NO_ENGINE_MSG = (t) => t(
  'Reading preview follows the engine you picked on the Generate page. Pick an engine there first.',
  '读音预览跟着「合成」页选中的那台引擎走（换一台引擎读音可能就不一样了）。请先在那里选一台引擎。',
)

function langName(t, code) {
  return t(
    ({ zh: 'Chinese', yue: 'Cantonese', ja: 'Japanese', en: 'English', ko: 'Korean' })[code] || code,
    ({ zh: '中文', yue: '粤语', ja: '日语', en: '英语', ko: '韩语' })[code] || code,
  )
}

function isNestedOverrides(o) {
  const vals = Object.values(o || {})
  return vals.length > 0 && vals.every(v => v && typeof v === 'object' && !Array.isArray(v))
}

function nestedOverrides(o, fallbackLang) {
  if (!o || !Object.keys(o).length) return {}
  return isNestedOverrides(o) ? o : { [fallbackLang || 'zh']: o }
}

function countOverrides(o) {
  const nested = nestedOverrides(o, 'zh')
  return Object.values(nested).reduce((total, bucket) => total + Object.keys(bucket || {}).length, 0)
}

// Merge the ordinary Reading proofing buckets with position-specific readings
// from the Han-language section. The engine consumes the latter as
// { lang: { '@absoluteIndex:char': ['reading'] } }.
function buildPronPayload(pronOverrides, baseLang, direction, forced, readings) {
  const nested = nestedOverrides(pronOverrides, baseLang)
  const out = {}
  for (const [lang, words] of Object.entries(nested)) {
    if (words && Object.keys(words).length) out[lang] = { ...words }
  }
  for (const item of (forced || [])) {
    if (!item || typeof item !== 'object' || !Number.isInteger(item.index) || !item.lang) continue
    const value = String(readingAt(readings || {}, item) || '').trim()
    if (!value) continue
    out[item.lang] = { ...(out[item.lang] || {}), [readingKey(item)]: [value] }
  }
  return Object.keys(out).length ? out : undefined
}

export {
  PronPanel,
  TextPrepModal,
  buildLangOverrides,
  buildPronPayload,
  hanOverrideDirection,
  countOverrides,
  parseLangOverrides,
  pruneForced,
  LANG_LABEL,
}

export {
  NO_ENGINE_MSG,
  langName,
  isNestedOverrides,
  nestedOverrides,
}
