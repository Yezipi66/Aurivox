// 合成页与对比页共用的纯函数：参考音频时长、语种、配方命名与路径归一。
// 参考音频的硬约束是 3 到 10 秒，超出时长后 /tts 返 400。
const REF_MIN_SEC = 3

const REF_MAX_SEC = 10

const refInRange = (dur) => typeof dur === 'number' && dur >= REF_MIN_SEC && dur <= REF_MAX_SEC

// 默认参考音频优先选时长合规的那一条，否则第一段太短会直接合成失败。
const pickDefaultRef = (segs) => {
  const usable = (segs || []).filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
  return usable.find(s => refInRange(s.duration)) || usable[0] || null
}

// 从文本猜语种。汉字数多于拉丁字母时按字符集细分，否则算英文。
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

// 给 /api/outputs/* 的调用拼一条能指路的错误。404 几乎总是因为后端跑的是
// 旧构建、没有这些路由，所以把 HTTP 状态一起带出去。
function outputsError(r, fallback) {
  if (r && r.data && typeof r.data === 'object' && r.data.error) return r.data.error
  const status = r ? r.status : 0
  if (status === 404) return 'HTTP 404 - the /api/outputs endpoints are missing. The backend is running an older build; restart it after applying the server patch.'
  return `${fallback} (HTTP ${status || '?'})`
}

// 布尔型后端检查的结果徽章（如 /api/voices/:id/validate）
function statusBadge(ok, okLabel = 'Selected', missLabel = 'Missing') {
  return <span className={`badge ${ok ? 'badge-ok' : 'badge-danger'}`}>{ok ? okLabel : missLabel}</span>
}

function basename(p) {
  if (!p || typeof p !== 'string') return '(none)'
  const a = p.replace(/\\/g, '/').split('/')
  return a[a.length - 1]
}

// 配方是按角色划分的可复用推理预设。这个弹窗由生成页与对比页共用：
// 收一个名字（情绪/标签）加备注，把当前的参考音频、参数与钉住的模型
// POST 到 /api/recipes。409（同名已存在）会就地弹覆盖确认，带 force:true 重发。

// 与服务端同名规则保持一致：允许 Unicode 字母，只禁文件系统里危险的符号。
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

// 各个 text_lang 取值在「最近生成」等处的显示名。
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

// 音色级裸语言码的显示名。
const VOICE_LANG_LABEL = { zh: 'Mandarin', yue: 'Cantonese', ja: 'Japanese', en: 'English', ko: 'Korean' }

// 算出有效的 CJK 回落语种（zh/ja/yue/ko/en）。
// 与 synthesis.js 的 generateService/speechService 以及引擎的 _norm_base_lang 一致：
// auto、空值、任何不具体的值都归到 zh。
function effectiveBaseLang(voiceLanguage) {
  const raw = String(voiceLanguage || '').toLowerCase().replace(/^all_/, '').replace(/^auto.*/, '')
  return (['zh', 'ja', 'yue', 'ko', 'en'].includes(raw)) ? raw : 'zh'
}

// 粤语(yue)与韩语(ko)不在可选目标里（没有维护这两种语种的资产）。
// 老的 yue/ko 音色退到 auto，而不是变成一个不存在的选项。
const VOICE_TO_TARGET = { zh: 'all_zh', yue: 'all_yue', ja: 'all_ja', en: 'en', ko: 'all_ko' }

// 把音色语言（裸码）映射到默认 text_lang 选项（等于微调源语言，保证零回归）。
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

// 最近生成的条目显示完整的本地时间戳（YYYY-MM-DD HH:MM:SS），
// 这样不同日期生成的条目仍然分得开。
function fmtRecentTime(value) {
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 最近生成那一行的参考音频文件名。
function refBasename(item) {
  const raw = item?.ref_audio || item?.params?.ref_audio || ''
  if (!raw) return ''
  const parts = String(raw).split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

// 参考路径的身份。托管的参考音频按【完整的归一路径】认定，绝不按文件名认定：
// assets/A/raw/x.wav 与 assets/B/raw/x.wav 是两份不同的参考，尽管文件名相同。
// 归一时统一反斜杠，并去掉开头的 "./" 或 "/" 以及旧的 "assets/" 前缀，
// 让字符串、v3 对象、项目相对路径三种写法能比较相等。
function normRefPath(p) {
  if (p == null) return ''
  // 既接受 v3 的托管参考对象 { base, path }，也接受纯字符串。
  const raw = (typeof p === 'object') ? (p.path || '') : p
  return String(raw)
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^assets\//, '')
}

// 两个参考是不是同一个文件（base + 归一后的路径）。
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
