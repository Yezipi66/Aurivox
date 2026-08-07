// Pure helpers for the per-position Han-language override workflow.
//
// The important distinction here is between automatic inference and an explicit
// position selected in the Han-character picker. The fallback language may also
// be explicitly selected: it is then visible and can be range-toggled off back to
// automatic inference.
//
// Only explicit positional selections are persisted and sent to the engine. A
// character-name-only legacy value is deliberately ignored: applying it to every
// occurrence would make one selection silently affect unrelated occurrences.

export const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u
export const HAN_LANGS = ['zh', 'yue', 'ja']
export const LANG_LABEL = { zh: 'Mandarin', yue: 'Cantonese', ja: 'Japanese' }
export const READING_UNIT = {
  ja: { label: 'kana', placeholder: 'e.g. かな' },
  zh: { label: 'pinyin', placeholder: 'e.g. hao3' },
  yue: { label: 'Jyutping', placeholder: 'e.g. hou2' },
}

export function hanPositions(text) {
  const out = []
  Array.from(String(text || '')).forEach((char, index) => {
    if (HAN_RE.test(char)) out.push({ char, index })
  })
  return out
}

// Read only the positional form. Old {char, lang} / string entries are not
// allowed to become global character overrides, because repeated Han characters
// may intentionally be assigned different languages.
export function normalizeAssignments(forced, direction) {
  const out = {}
  for (const item of (forced || [])) {
    if (!item || typeof item !== 'object') continue
    if (!Number.isInteger(item.index) || !HAN_LANGS.includes(item.lang)) continue
    // The fallback language can still be explicitly selected: it is visible as
    // a manual choice and may later be range-toggled off. Only a second gesture
    // over an entirely same-language range clears it.
    out[item.index] = item.lang
  }
  return out
}

export function assignmentAt(map, pos) {
  return map && Number.isInteger(pos?.index) ? map[pos.index] : undefined
}

export function assignmentList(map, text) {
  return hanPositions(text)
    .filter(pos => assignmentAt(map, pos))
    .map(pos => ({ index: pos.index, char: pos.char, lang: assignmentAt(map, pos) }))
}

// Range gesture semantics: a mixed/unselected range is assigned as a whole;
// a range whose every position already has the target language is cleared as a
// whole. This is what makes overlapping selections additive while still allowing
// an exact/sub-range re-selection to deselect it.
export function applyHanRange(map, positions, target) {
  const current = map || {}
  const touched = positions || []
  const allSameTarget = touched.length > 0 && touched.every(pos => current[pos.index] === target)
  const next = { ...current }
  for (const pos of touched) {
    if (allSameTarget) delete next[pos.index]
    else next[pos.index] = target
  }
  return { map: next, cleared: allSameTarget }
}

export function readingKey(itemOrIndex, char) {
  if (itemOrIndex && typeof itemOrIndex === 'object') {
    return `@${itemOrIndex.index}:${itemOrIndex.char}`
  }
  return `@${itemOrIndex}:${char || ''}`
}

export function readingAt(readings, item) {
  const source = readings && typeof readings === 'object' ? readings : {}
  const key = readingKey(item)
  // `String(index)` is a short-lived compatibility form from the broken
  // pre-position UI. Never fall back to a bare character name: that would apply
  // one reading to every repeated occurrence of the character.
  return source[key] ?? source[String(item.index)] ?? ''
}

export function hanOverrideDirection(textLang, voiceLang) {
  const target = String(textLang || '').toLowerCase()
  const rawVoice = String(voiceLang || '').toLowerCase()
  const voiceBase = rawVoice.replace(/^all_/, '').replace(/^auto.*/, '')
  let base
  if (target === 'zh' || target === 'all_zh') base = 'zh'
  else if (target === 'yue' || target === 'all_yue') base = 'yue'
  else if (target === 'ja' || target === 'all_ja') base = 'ja'
  else if (['auto_zh_ja_yue', 'auto_zh_ja', 'auto'].includes(target)) {
    base = HAN_LANGS.includes(voiceBase) ? voiceBase : 'zh'
  } else if (target === 'all_ko') {
    // The engine's all_ko path keeps shared Han in the Chinese pipeline.
    base = 'zh'
  } else {
    return null
  }
  if (!HAN_LANGS.includes(base)) base = 'zh'
  const assetIsAuto = !voiceBase || rawVoice.startsWith('auto') || ['ko', 'en'].includes(voiceBase)
  return {
    base,
    choices: HAN_LANGS,
    assetIsAuto,
    autoMode: ['auto_zh_ja_yue', 'auto_zh_ja'].includes(target),
  }
}

export function buildLangOverrides(direction, forced) {
  if (!direction) return undefined
  const map = normalizeAssignments(forced, direction)
  const out = {}
  for (const [index, lang] of Object.entries(map)) out[`@${index}`] = lang
  return Object.keys(out).length ? out : undefined
}

export function parseLangOverrides(value) {
  let raw = value
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return []
    try { raw = JSON.parse(trimmed) } catch { return [] }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (Array.isArray(raw.lang_overrides)) raw = raw.lang_overrides
    else if (Array.isArray(raw.han_forced)) raw = raw.han_forced
    else {
      raw = Object.entries(raw)
        .filter(([key]) => /^@\d+$/.test(key))
        .map(([key, lang]) => ({ index: Number(key.slice(1)), lang }))
    }
  }
  if (!Array.isArray(raw)) return []
  return raw.filter(item => (
    item && typeof item === 'object'
    && Number.isInteger(item.index)
    && HAN_LANGS.includes(item.lang)
  ))
}

export { HAN_RE as HAN_CHARACTER_RE }
