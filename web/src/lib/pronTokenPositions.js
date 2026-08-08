// Position helpers for the Reading proofing preview.
//
// Han-language overrides are indexed by Unicode code point (@0, @1, ...),
// while JavaScript's String#indexOf uses UTF-16 code-unit offsets. Keep the
// preview lookup in code-point space so a token after an emoji or another
// supplementary-plane character still maps to the same position as the Han
// picker.

export function previewTokenText(token) {
  if (!token || typeof token !== 'object') return ''
  if (token.word !== undefined && token.word !== null && String(token.word).length > 0) return String(token.word)
  if (Array.isArray(token.chars)) return token.chars.map(item => String(item?.char || '')).join('')
  return token.word == null ? '' : String(token.word)
}

function findSequence(source, needle, from) {
  if (!needle.length) return -1
  const start = Math.max(0, Number.isInteger(from) ? from : 0)
  for (let i = start; i <= source.length - needle.length; i += 1) {
    let matches = true
    for (let j = 0; j < needle.length; j += 1) {
      if (source[i + j] !== needle[j]) {
        matches = false
        break
      }
    }
    if (matches) return i
  }
  return -1
}

export function previewTokenStarts(text, tokens) {
  const source = Array.from(String(text || ''))
  let cursor = 0
  return (Array.isArray(tokens) ? tokens : []).map(token => {
    const needle = Array.from(previewTokenText(token))
    const start = findSequence(source, needle, cursor)
    if (start >= 0) cursor = start + needle.length
    return start
  })
}

export function mutedTokenPositions(start, tokenText, mutedPositions) {
  if (!Number.isInteger(start) || start < 0) return []
  const muted = mutedPositions instanceof Set ? mutedPositions : new Set(mutedPositions || [])
  return Array.from(String(tokenText || ''))
    .map((_, offset) => start + offset)
    .filter(position => muted.has(position))
}
