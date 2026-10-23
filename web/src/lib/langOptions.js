// 语种的选项表、显示名与取值归一。
// text_lang 解除「合成语言 == 微调语言」的绑定：任一微调音色都能合成下列语言或 auto 混排。
// prompt_lang（参考音频文本语言）仍跟随音色。
const TARGET_LANG_OPTIONS = [
  { value: 'auto_zh_ja_yue', label: 'Auto' },
  { value: 'all_zh', label: 'Mandarin (\u666e\u901a\u8bdd)' },
  { value: 'all_yue', label: 'Cantonese (\u7ca4\u8bed)' },
  { value: 'all_ja', label: 'Japanese (\u65e5\u672c\u8a9e)' },
  { value: 'en', label: 'English' },
  { value: 'all_ko', label: 'Korean (\ud55c\uad6d\uc5b4)' },
]

// 各 text_lang 取值的显示名。
const LANG_LABEL_MAP = {
  auto_zh_ja_yue: 'Auto',
  auto_zh_ja: 'Auto',
  auto: 'Auto',
  all_zh: 'Mandarin',
  all_yue: 'Cantonese',
  all_ja: 'Japanese',
  en: 'English',
  all_ko: 'Korean',
}

function langLabel(code) {
  return LANG_LABEL_MAP[code] || String(code || '').toUpperCase()
}

// 音色级语言码（不含 all_/auto_ 前缀）的显示名。
const VOICE_LANG_LABEL = { zh: 'Mandarin', yue: 'Cantonese', ja: 'Japanese', en: 'English', ko: 'Korean' }

// 计算有效的 CJK 回落语种（zh/ja/yue/ko/en）：auto、空值与不具体的值都归到 zh。
// 取值与 synthesis.js 的 generateService/speechService 以及引擎的 _norm_base_lang 一致。
function effectiveBaseLang(voiceLanguage) {
  const raw = String(voiceLanguage || '').toLowerCase().replace(/^all_/, '').replace(/^auto.*/, '')
  return (['zh', 'ja', 'yue', 'ko', 'en'].includes(raw)) ? raw : 'zh'
}

// 音色语言到目标语言选项的映射。
const VOICE_TO_TARGET = { zh: 'all_zh', yue: 'all_yue', ja: 'all_ja', en: 'en', ko: 'all_ko' }

// 把音色语言映射到默认 text_lang 选项：默认等于微调源语言；auto 音色默认 auto_zh_ja_yue。
function defaultTargetLang(voiceLang) {
  const raw = String(voiceLang || '')
  const base = raw.replace(/^all_/, '').replace(/^auto.*/, '')
  if (!base || raw.startsWith('auto')) return 'auto_zh_ja_yue'
  return VOICE_TO_TARGET[base] || 'auto_zh_ja_yue'
}

// 归一 text_lang 到语言族：all_zh 变成 zh；auto 返回 null（不判定失配）。
function normalizeLangFamily(textLang) {
  if (!textLang || String(textLang).startsWith('auto')) return null
  return String(textLang).replace(/^all_/, '')
}

export {
  TARGET_LANG_OPTIONS,
  LANG_LABEL_MAP,
  langLabel,
  VOICE_LANG_LABEL,
  effectiveBaseLang,
  defaultTargetLang,
  normalizeLangFamily,
}
