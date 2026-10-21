// 逐字指定汉语言种的纯函数。
//
// 要分清两件事：自动推断，与用户在汉字符选择器里显式选定的位置。
// 回落语种也可以被显式选定：选定后它可见，并能再被整段切换关回自动推断。
//
// 只有带位置的显式选择会被持久化并发给引擎。只按字名的旧值一律忽略：
// 把它套到每一次出现上，会让一次选择悄悄影响所有不相干的位置。

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

// 位置是码点下标，与这里的 Array.from()、引擎侧的 Python 字符串下标、
// 以及请求体里的 @N 键一致。不能用 String.charAt / str[i]：那是 UTF-16
// 码元下标，遇到星芒平面字符就会与引擎的编号错开。
export function charAtPosition(text, index) {
  if (!Number.isInteger(index) || index < 0) return undefined
  const chars = Array.from(String(text ?? ''))
  return index < chars.length ? chars[index] : undefined
}

// 覆盖只在它指的位置仍然是一个汉字时才成立。选定之后文本仍可随意编辑，
// 而存下来的是绝对下标，同一个下标可能落到假名、拉丁字母或者行尾之外。
// 这种条目必须消失：选择器里看不见它（选择器只遍历 hanPositions），
// 却仍会被计数、预览，并发给引擎。
export function isLiveAssignment(text, index, lang) {
  if (!HAN_LANGS.includes(lang)) return false
  const char = charAtPosition(text, index)
  return char !== undefined && HAN_RE.test(char)
}

// 丢掉所有位置已不再对应汉字的条目。用于修复持久化状态（localStorage 活得比文本久）。
export function pruneForced(forced, text) {
  return (forced || []).filter(item => (
    item && typeof item === 'object'
    && Number.isInteger(item.index)
    && isLiveAssignment(text, item.index, item.lang)
  ))
}

// 只读带位置的形式。旧的 {char, lang} / 字符串条目不许变成全局的字级覆盖：
// 同一个汉字的多次出现可能本来就该读成不同语种。
//
// text 是下标所指的那段正文。实践上必传：没有它就无法分辨一条覆盖是活的，
// 还是被编辑落在空处的，而这张表的每个消费者（预览着色、计数器、引擎请求体）
// 都会对后者照做。tools/guard_han_text_arg.cjs 守着每个调用点都传了它。
export function normalizeAssignments(forced, direction, text) {
  const out = {}
  const checkText = text !== undefined && text !== null
  for (const item of (forced || [])) {
    if (!item || typeof item !== 'object') continue
    if (!Number.isInteger(item.index) || !HAN_LANGS.includes(item.lang)) continue
    if (checkText && !isLiveAssignment(text, item.index, item.lang)) continue
    // 回落语种也可以被显式选定：它作为一次手动选择可见，之后能被整段切换关掉。
    // 只有对整段同语种再做一次手势才会清掉它。
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

// 整段手势的语义：混合或未选中的整段按目标语种整体赋值；
// 整段已经是目标语种时整体清除。这样重叠选择是叠加的，
// 而对同一段做一次完全相同的选择又能把它取消。
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
  // 裸字符串下标是早期按位置界面的兼容形式。绝不回落到只按字名取：
  // 那会把一条读音套到该字的每一次出现上。
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
    // 引擎的 all_ko 路径仍把共用汉字留在中文管线里。
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

export function buildLangOverrides(direction, forced, text) {
  if (!direction) return undefined
  const map = normalizeAssignments(forced, direction, text)
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
