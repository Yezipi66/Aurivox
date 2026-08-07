// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
// GPT-SoVITS engine hard constraint: reference audio must be 3~10s, else /tts 400.
const REF_MIN_SEC = 3

const REF_MAX_SEC = 10

const refInRange = (dur) => typeof dur === 'number' && dur >= REF_MIN_SEC && dur <= REF_MAX_SEC

// Prefer an in-range slice as the auto-default so generation doesn't fail on a too-short first slice.
const pickDefaultRef = (segs) => {
  const usable = (segs || []).filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
  return usable.find(s => refInRange(s.duration)) || usable[0] || null
}

// ---- Language detection ----
function detectLang(text) {
  const s = text.replace(/\s/g, '')
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length
  const en = (s.match(/[a-zA-Z]/g) || []).length
  if (cjk > en) {
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) return 'ja'
    if (/[\uac00-\ud7af]/.test(s)) return 'ko'
    return 'zh'
  }
  return 'en'
}

// Build a helpful error for /api/outputs/* calls. A 404 here almost always means
// the backend is running an older build without these routes; surface the HTTP
// status so the fix (apply the server patch, then restart the backend) is obvious.
function outputsError(r, fallback) {
  if (r && r.data && typeof r.data === 'object' && r.data.error) return r.data.error
  const status = r ? r.status : 0
  if (status === 404) return 'HTTP 404 - the /api/outputs endpoints are missing. The backend is running an older build; restart it after applying the server patch.'
  return `${fallback} (HTTP ${status || '?'})`
}

// Status badge for a boolean backend check (e.g. /api/voices/:id/validate)
function statusBadge(ok, okLabel = 'Selected', missLabel = 'Missing') {
  return <span className={`badge ${ok ? 'badge-ok' : 'badge-danger'}`}>{ok ? okLabel : missLabel}</span>
}

function basename(p) {
  if (!p || typeof p !== 'string') return '(none)'
  const a = p.replace(/\\/g, '/').split('/')
  return a[a.length - 1]
}

// ===========================
//  SAVE AS RECIPE (P1)
// ===========================
// A recipe is a role-scoped, reusable inference preset (D1/D2). This modal is
// shared by the Generate and Compare pages: it collects a name (emotion/label)
// + notes and POSTs the current reference + params + pinned models to
// /api/recipes. A 409 (already exists) raises an inline overwrite confirm that
// re-POSTs with { force:true }.

// Client-side mirror of the server name rule: Unicode letters allowed, only
// filesystem-dangerous symbols blacklisted (locked 2026-07-07).
const RECIPE_NAME_BLACKLIST = /[\/\\:*?"<>|]/

function recipeNameError(name) {
  const t = (name || '').trim()
  if (!t) return 'Name is required'
  if (t.length > 64) return 'Name too long (max 64)'
  if (RECIPE_NAME_BLACKLIST.test(t)) return 'Name must not contain / \\ : * ? " < > |'
  if (t.startsWith('.')) return "Name must not start with '.'"
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(t)) return 'Name contains control characters'
  return null
}

// 目标语言（text_lang）：解除「合成语言 == 微调语言」的硬绑定。任一微调音色可合成
// 目标语言（zh/ja/en）或 auto 混排。粤语(yue)、韩语(ko)已下线。prompt_lang（参考音频文本语言）仍跟随音色。
const TARGET_LANG_OPTIONS = [
  { value: 'auto_zh_ja_yue', label: 'Auto' },
  { value: 'all_zh', label: 'Mandarin (\u666e\u901a\u8bdd)' },
  { value: 'all_yue', label: 'Cantonese (\u7cb5\u8bed)' },
  { value: 'all_ja', label: 'Japanese (\u65e5\u672c\u8a9e)' },
  { value: 'en', label: 'English' },
  { value: 'all_ko', label: 'Korean (\ud55c\uad6d\uc5b4)' },
]

// Human-readable labels for every text_lang value shown in Recent Generations etc.
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

// Voice-level bare language codes → human-readable label.
const VOICE_LANG_LABEL = { zh: 'Mandarin', yue: 'Cantonese', ja: 'Japanese', en: 'English', ko: 'Korean' }

// Compute the effective kana-free CJK fallback language (zh/ja/yue/ko/en).
// Mirrors synthesis.js generateService/speechService + engine _norm_base_lang:
// "auto" / blank / anything non-concrete → "zh".
function effectiveBaseLang(voiceLanguage) {
  const raw = String(voiceLanguage || '').toLowerCase().replace(/^all_/, '').replace(/^auto.*/, '')
  return (['zh', 'ja', 'yue', 'ko', 'en'].includes(raw)) ? raw : 'zh'
}

// Cantonese (yue) and Korean (ko) are intentionally omitted from the selectable
// targets (no yue/ko assets maintained). A legacy yue/ko voice degrades to
// 'auto' rather than a missing option.
const VOICE_TO_TARGET = { zh: 'all_zh', yue: 'all_yue', ja: 'all_ja', en: 'en', ko: 'all_ko' }

// 把音色语言（裸码）映射到默认 text_lang 选项（== 微调源语言，保证零回归）。
function defaultTargetLang(voiceLang) {
  const raw = String(voiceLang || '')
  const base = raw.replace(/^all_/, '').replace(/^auto.*/, '')
  if (!base || raw.startsWith('auto')) return 'auto_zh_ja_yue'
  return VOICE_TO_TARGET[base] || 'auto_zh_ja_yue'
}

// 归一 text_lang 到语言族（all_zh -> zh；auto -> null 不判定失配）。
function normalizeLangFamily(textLang) {
  if (!textLang || String(textLang).startsWith('auto')) return null
  return String(textLang).replace(/^all_/, '')
}

// PD: Recent items show a full local timestamp (YYYY-MM-DD HH:MM:SS) rather than
// time-only, so entries generated on different days stay distinguishable.
function fmtRecentTime(value) {
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// PD: reference-audio basename for the Recent meta line.
function refBasename(item) {
  const raw = item?.ref_audio || item?.params?.ref_audio || ''
  if (!raw) return ''
  const parts = String(raw).split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

// Reference-path identity (Patch #11). A managed reference is identified by its
// FULL normalized path — never by basename alone — so `assets/A/raw/x.wav` and
// `assets/B/raw/x.wav` are distinct references even though they share a filename.
// Backslashes are normalized, a leading "./" or "/" and a legacy "assets/" prefix
// are stripped so the string / v3-object / project-relative forms compare equal.
function normRefPath(p) {
  if (p == null) return ''
  // Accept a v3 managed-reference object { base, path } as well as a plain string.
  const raw = (typeof p === 'object') ? (p.path || '') : p
  return String(raw)
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^assets\//, '')
}

// True when two references point at the same file (base + normalized path).
function sameRefPath(a, b) {
  const na = normRefPath(a), nb = normRefPath(b)
  if (!na || !nb) return false
  return na === nb
}

export {
  REF_MIN_SEC,
  REF_MAX_SEC,
  refInRange,
  pickDefaultRef,
  outputsError,
  statusBadge,
  basename,
  recipeNameError,
  TARGET_LANG_OPTIONS,
  LANG_LABEL_MAP,
  langLabel,
  VOICE_LANG_LABEL,
  effectiveBaseLang,
  defaultTargetLang,
  fmtRecentTime,
  refBasename,
  normalizeLangFamily,
  normRefPath,
  sameRefPath,
}
