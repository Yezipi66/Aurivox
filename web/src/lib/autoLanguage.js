// Mirrors vendor/tts/gpt-sovits/infer/TTS_infer_pack/TextPreprocessor.py for
// auto_zh_ja_yue. Keep this module dependency-free so the UI preview describes
// the same language routing that is sent to GPT-SoVITS.
export const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u
const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9F]/u
const CLAUSE_END = new Set(['。', '！', '？', '!', '?', '…', '\n', '，', '、', ',', ';', ':'])
const QUOTE_PAIRS = new Map([
  ['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['（', '）'], ['(', ')'],
  ['〈', '〉'], ['《', '》'], ['【', '】'],
])
const YUE_STRONG_RE = /[喺嘅佢哋咩冇唔啲嚟咗噉俾畀]/gu
const YUE_WEAK_RE = /[嘢啱係既咁啦喇咪嘥攞揾餸攰瞓]/gu
const CONCRETE = new Set(['zh', 'yue', 'ja', 'ko', 'en'])

export function normalizeAutoBaseLanguage(value) {
  const lang = String(value || '').toLowerCase().replace(/^all_/, '').replace(/^auto_/, '').trim()
  return CONCRETE.has(lang) ? lang : 'zh'
}

function yueScore(text) {
  const strong = (text.match(YUE_STRONG_RE) || []).length
  const weak = (text.match(YUE_WEAK_RE) || []).length
  const han = (text.match(HAN_RE) || []).length
  return strong * 2 + weak - han * 0.05
}

// This intentionally has the same quote and punctuation boundaries as Python's
// _split_clauses. Kana / Cantonese evidence must not leak into neighbouring text.
export function splitAutoClauses(text) {
  const source = Array.from(String(text || ''))
  const clauses = []
  let buf = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const close = QUOTE_PAIRS.get(ch)
    if (close) {
      const end = source.indexOf(close, i + 1)
      if (end !== -1) {
        if (buf) clauses.push(buf)
        buf = ''
        clauses.push(source.slice(i, end + 1).join(''))
        i = end
        continue
      }
    }
    buf += ch
    if (CLAUSE_END.has(ch)) {
      clauses.push(buf)
      buf = ''
    }
  }
  if (buf) clauses.push(buf)
  return clauses.filter(Boolean)
}

export function inferAutoClauseLanguage(clause, baseLanguage) {
  if (KANA_RE.test(clause)) return 'ja'
  if (yueScore(clause) > 1.5) return 'yue'
  return normalizeAutoBaseLanguage(baseLanguage)
}

// Per-code-point language map for the final preview and Han buttons. This only
// resolves shared Han: script-specific Korean, Latin and Kana stay handled by
// the component itself. Explicit @position overrides always win.
export function inferAutoHanLanguages(text, baseLanguage, assignments = {}) {
  const source = Array.from(String(text || ''))
  const out = {}
  let offset = 0
  for (const clause of splitAutoClauses(source.join(''))) {
    const lang = inferAutoClauseLanguage(clause, baseLanguage)
    for (const ch of Array.from(clause)) {
      if (HAN_RE.test(ch)) out[offset] = assignments[offset] || assignments[`char:${ch}`] || lang
      offset += 1
    }
  }
  return out
}
