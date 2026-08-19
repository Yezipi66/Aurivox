// Reading-proofing / multilingual module. Extracted verbatim from App.jsx (no logic change).
import { useState, useEffect, useCallback, useRef } from 'react'
import { Select } from '../common/Select'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { inferAutoHanLanguages } from '../../lib/autoLanguage'
import { mutedTokenPositions, previewTokenStarts, previewTokenText } from '../../lib/pronTokenPositions'
import {
  HAN_RE,
  HAN_LANGS,
  LANG_LABEL,
  READING_UNIT,
  applyHanRange,
  assignmentAt,
  assignmentList,
  buildLangOverrides,
  hanOverrideDirection,
  hanPositions,
  normalizeAssignments,
  parseLangOverrides,
  pruneForced,
  readingAt,
  readingKey,
} from '../../lib/hanLanguage'

// Item 17: localised language name for use inside translated sentences. Technical
// reading units (kana, ARPABET, pinyin, jyutping) always stay English.
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

// --- Token visual helpers (reading-proofing grid) ---------------------------
// Punctuation tokens carry no editable reading; they are rendered as a faint
// inline glyph (not a card) so the grid stays clean while keeping reading order.
const PUNCT_RE = /^[\s\p{P}\p{S}]+$/u
// Small per-language accent (colored dot + short code) replaces the repeated
// uppercase language label so mixed-language rows read at a glance.
const SEG_COLORS = { zh: '#3fb98f', yue: '#3fb98f', ja: '#e0a26a', en: '#6fa8dc', ko: '#c08bd6' }
const SEG_SHORT = { zh: 'ZH', yue: 'YUE', ja: 'JA', en: 'EN', ko: 'KO' }
function tokIsPunct(tok) {
  if (!tok) return false
  if (tok.unit === 'char' || tok.chars) {
    const cs = tok.chars || []
    return cs.length > 0 && cs.every(c => PUNCT_RE.test(c.char || ''))
  }
  return PUNCT_RE.test(tok.word || '')
}

// 读音校对面板（task6）：勾选后展开的二级面板，兼作文本编辑器 + 逐字读音校对。
// 中文(zh)/粤语(yue) 走真实 g2pW 预览；其它语言为契约占位（ko 未经测试）。
function PronPanel({ text, setText, lang, overrides, setOverrides, layout, mutedPositions, mutedLangLabel, mutedLangByPosition }) {
  const { t } = useT()
  const wide = layout === 'wide'
  const mutePositionSet = mutedPositions instanceof Set ? mutedPositions : new Set(mutedPositions || [])
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // item 19-A: 词典按语言存储 {lang: entries}（混合文本可能涉及多种语言）。
  const [lexicons, setLexicons] = useState({})
  // 逐词编辑缓冲（ja 假名 / en ARPABET），键含 segLang 以避免跨语言同形词冲突。
  const [wordEdits, setWordEdits] = useState({})
  // en「谐音改写」输入缓冲：{word -> 另一个英文词}。
  const [respellEdits, setRespellEdits] = useState({})
  // en 每个 token 的「候选 / 谐音」详情默认收起，键为 token 索引，避免纵向拥挤。
  const [openDetail, setOpenDetail] = useState({})
  // item 19-A：覆盖始终按语言分桶；旧的扁平形态自动归入面板基础语系。
  const nested = nestedOverrides(overrides, lang)
  // zh/yue：逐字选候选；ja：逐词改假名；en：逐词改音标；其它语言契约占位。
  // `auto` is a real multilingual review mode. The engine preview endpoint
  // segments its response into ZH/JA/EN/KO tokens; it is not a placeholder.
  const supported = ['zh', 'yue', 'ja', 'en', 'ko', 'auto'].includes(lang)
  const isCharUnit = lang === 'zh' || lang === 'yue'
  const [showAllKo, setShowAllKo] = useState(false)
  const [expandedKo, setExpandedKo] = useState({})
  const readingUnit = (segLang) => segLang === 'ja' ? 'kana' : segLang === 'en' ? 'ARPABET (space-separated)' : segLang === 'ko' ? 'Hangul reading' : 'reading'

  const loadLexicon = useCallback((lg) => {
    if (!lg) return
    api(`/api/pron/lexicon?lang=${encodeURIComponent(lg)}`).then(r => {
      if (r.ok && r.data?.entries) setLexicons(prev => ({ ...prev, [lg]: r.data.entries }))
    }).catch(() => {})
  }, [])

  useEffect(() => { if (supported) loadLexicon(lang) }, [lang, supported, loadLexicon])

  const doPreview = async () => {
    setError(null); setPreview(null); setWordEdits({}); setRespellEdits({}); setOpenDetail({})
    if (!text.trim()) { setError(t('Enter text above first.', '请先在上方输入文本。')); return }
    if (!supported) { setError(t(`Reading proofing does not support "${lang}" yet.`, `读音校对暂不支持 “${lang}”。`)); return }
    setLoading(true)
    try {
      const r = await api('/api/pron/preview', { method: 'POST', body: { text, lang } })
      if (!r.ok) throw new Error(r.data?.error || `Preview failed (${r.status})`)
      setPreview(r.data)
      // 按预览里出现的每种语言加载词典。
      for (const lg of (r.data?.langs || [])) loadLexicon(lg)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  // 写入某语言桶（函数式，保证并发编辑不丢失）。
  const setBucket = (segLang, updater) => {
    setOverrides(prev => {
      const cur = nestedOverrides(prev, lang)
      const bucket = cur[segLang] || {}
      const nextBucket = typeof updater === 'function' ? updater(bucket) : updater
      const out = { ...cur }
      if (nextBucket && Object.keys(nextBucket).length) out[segLang] = nextBucket
      else delete out[segLang]
      return out
    })
  }

  // Change a single character's reading -> record a word-level override (per segLang).
  const changeReading = (segLang, word, charIndex, newReading) => {
    const token = (preview?.tokens || []).find(t => t.segLang === segLang && t.word === word && (t.unit === 'char' || t.chars))
    if (!token) return
    const bucket = nested[segLang] || {}
    const readings = token.chars.map((c, i) => i === charIndex ? newReading : (bucket[word]?.[i] ?? c.reading))
    setBucket(segLang, b => ({ ...b, [word]: readings }))
    setPreview(pv => ({ ...pv, tokens: pv.tokens.map(t => (t.segLang === segLang && t.word === word)
      ? { ...t, chars: t.chars.map((c, i) => i === charIndex ? { ...c, reading: newReading, source: 'override' } : c) }
      : t) }))
  }

  // item 19-C: English overrides are per-occurrence. bucket[word] for en is a dict
  // { "<occ>": [readings], "*": [readings] } ("*" = word-level default); ja/zh stay
  // list-form. A legacy list is auto-migrated to { "*": list } on first per-occ edit.
  const editKey = (segLang, word, occ) => `${segLang}::${word}::${occ ?? ''}`
  // Resolve the reading array a given occurrence currently shows (override first).
  const enReadingFor = (bWord, occ, fallback) => {
    if (Array.isArray(bWord)) return bWord                          // legacy word-level list
    if (bWord && typeof bWord === 'object') {
      const k = String(occ)
      if (bWord[k]) return bWord[k]
      if (bWord['*']) return bWord['*']
    }
    return fallback || []
  }
  const enHasOverride = (bWord, occ) => {
    if (Array.isArray(bWord)) return true
    if (bWord && typeof bWord === 'object') return bWord[String(occ)] != null || bWord['*'] != null
    return false
  }

  // Word-level edit for ja (occ undefined) / per-occurrence edit for en.
  const changeWordReading = (segLang, word, occ, str) => {
    const isEn = segLang === 'en'
    const isKo = segLang === 'ko'
    const perOccurrence = isEn || isKo
    setWordEdits(e => ({ ...e, [editKey(segLang, word, perOccurrence ? occ : undefined)]: str }))
    const arr = isEn ? str.trim().split(/\s+/).filter(Boolean) : (str.trim() ? [str.trim()] : [])
    setBucket(segLang, b => {
      const n = { ...b }
      if (perOccurrence && occ != null) {
        let cur = n[word]
        if (Array.isArray(cur)) cur = { '*': cur }   // migrate legacy list -> word-level default
        cur = { ...(cur || {}) }
        if (arr.length) cur[String(occ)] = arr; else delete cur[String(occ)]
        if (Object.keys(cur).length) n[word] = cur; else delete n[word]
      } else {
        if (arr.length) n[word] = arr; else delete n[word]
      }
      return n
    })
    setPreview(pv => ({ ...pv, tokens: pv.tokens.map(tk => {
      if (tk.segLang !== segLang || tk.word !== word) return tk
      if (perOccurrence && occ != null && tk.occ !== occ) return tk          // only this occurrence
      return isEn ? { ...tk, readings: arr, source: arr.length ? 'override' : 'g2p' }
                  : { ...tk, reading: arr[0] || '', source: arr.length ? 'override' : 'g2p' }
    }) }))
  }

  // item 19-B: 谐音改写——用另一个英文词的读音替换本词的这一次出现（复用 /pron/preview）。
  const respellEn = async (word, occ) => {
    const src = String(respellEdits[editKey('en', word, occ)] || '').trim()
    if (!src) return
    try {
      const r = await api('/api/pron/preview', { method: 'POST', body: { text: src, lang: 'en' } })
      if (r.ok) {
        const arpa = (r.data?.tokens || []).flatMap(tk => tk.readings || [])
        if (arpa.length) changeWordReading('en', word, occ, arpa.join(' '))
        else setError(t(`No English reading found for "${src}".`, `未找到 “${src}” 的英文读音。`))
      }
    } catch (e) { setError(e.message) }
  }

  const saveToLexicon = async (segLang, word, occ) => {
    // 存词典 = 词级（list）。en 存的是当前这一次出现所显示的读音。
    const tok = preview?.tokens.find(t => t.segLang === segLang && t.word === word && (segLang !== 'en' || t.occ === occ))
    let readings
    if (segLang === 'en') {
      readings = enReadingFor((nested[segLang] || {})[word], occ, tok?.readings)
    } else if (tok && (tok.unit === 'char' || tok.chars)) {
      readings = (nested[segLang] || {})[word] || tok.chars.map(c => c.reading)
    } else {
      readings = (nested[segLang] || {})[word] || (tok ? [tok.reading] : null)
    }
    if (!readings || !readings.length) return
    const r = await api('/api/pron/lexicon', { method: 'POST', body: { lang: segLang, word, pinyins: readings } })
    if (r.ok) { setLexicons(prev => ({ ...prev, [segLang]: r.data.entries || {} })) }
    else setError(r.data?.error || t('Failed to save to lexicon', '保存到词典失败'))
  }

  const deleteFromLexicon = async (segLang, word) => {
    const r = await api(`/api/pron/lexicon?lang=${encodeURIComponent(segLang)}&word=${encodeURIComponent(word)}`, { method: 'DELETE' })
    if (r.ok) setLexicons(prev => ({ ...prev, [segLang]: r.data.entries || {} }))
  }

  const clearOverrides = () => { setOverrides({}); if (preview) doPreview() }

  const overrideCount = countOverrides(overrides)
  const showNorm = preview && preview.norm_text && preview.norm_text.trim() && preview.norm_text.trim() !== text.trim()
  const multiLang = !!(preview && preview.multilingual)
  // item 19-C: how many times each English word occurs (to show #n badges only when repeated).
  const enWordCounts = {}
  const koWordCounts = {}
  for (const tk of (preview?.tokens || [])) {
    if (tk.segLang === 'en' && tk.unit === 'word') enWordCounts[tk.word] = (enWordCounts[tk.word] || 0) + 1
    if (tk.segLang === 'ko' && tk.unit === 'word') koWordCounts[tk.word] = (koWordCounts[tk.word] || 0) + 1
  }
  // Preview payloads from older engines do not contain offsets. Resolve each
  // token monotonically against the exact editor text so muting remains POSITION
  // based, including repeated Han characters (never a global character set).
  const tokenStarts = previewTokenStarts(text, preview?.tokens || [])

  return (
    <div className={`section pron-panel${wide ? ' pron-panel-wide' : ''}`} style={{ margin: '8px 0', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div className="pron-grid">
      <div className="pron-edit">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{t('Reading proofing', '读音校对')}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {!supported ? t(`Language "${lang}" is contract-only for now.`, `语言 “${lang}” 目前仅为占位支持。`)
            : lang === 'auto' ? t('Preview actual multilingual reading units. ZH / JA / YUE characters selected above are reviewed there; the remaining text stays available below.', '预览实际的多语言读音单元。上方已选择 ZH / JA / YUE 的汉字在上方校对；其余文本在下方校对。')
            : isCharUnit ? t('Edit text, preview readings, fix polyphonic characters.', '编辑文本、预览读音、修正多音字。')
            : lang === 'ja' ? t('Edit text, preview readings, fix a word\u2019s kana reading.', '编辑文本、预览读音、修正单词的 kana 读音。')
            : lang === 'ko' ? t('Review changed or unresolved Korean readings; expand only the word you need.', '优先检查发生音变或未解析的韩语词；按需展开单个词的音节。')
            : t('Edit text, preview readings, fix each English word\u2019s pronunciation (each occurrence separately).', '编辑文本、预览读音，逐个（可逐次）修正英文单词的发音。')}
        </span>
      </div>

      <textarea
        className="control" rows={3} placeholder={t('Edit the text to synthesize here...', '在此编辑要合成的文本…')}
        value={text} onChange={e => setText(e.target.value)}
        style={{ marginBottom: 8 }}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-sm" onClick={doPreview} disabled={loading || !supported}>
          {loading ? t('Previewing...', '预览中…') : t('Preview readings', '预览读音')}
        </button>
        {overrideCount > 0 && (
          <>
            <span style={{ fontSize: 11, color: 'var(--accent)' }}>{t(`${overrideCount} override(s) active this run`, `本次生效 ${overrideCount} 处自定义读音`)}</span>
            <button className="btn btn-sm btn-ghost" onClick={clearOverrides}>{t('Clear overrides', '清除自定义读音')}</button>
          </>
        )}
      </div>

      {showNorm && (
        <div className="field-hint" style={{ marginTop: 6, fontSize: 11 }}>
          {t('Normalized text (readings are derived from this):', '规范化文本（读音基于此推导）：')}
          <span style={{ color: 'var(--text)' }}> {preview.norm_text}</span>
        </div>
      )}

      {error && <div className="field-hint" style={{ color: 'var(--danger)', marginTop: 6 }}>{error}</div>}
      </div>{/* .pron-edit */}
      <div className="pron-out">
      {preview?.langs?.includes('ko') && <div style={{marginTop:10,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}><button type="button" className="btn btn-sm btn-ghost" onClick={()=>setShowAllKo(v=>!v)}>{showAllKo?t('Show suggested Korean checks','仅显示建议检查'):t('Show all Korean words','显示全部韩语词')}</button><span className="field-hint">{t('Latin text remains English/ARPABET. Han characters remain ZH/YUE/JA and never fall back to Korean.','拉丁字母继续使用英语/ARPABET；汉字保持 ZH/YUE/JA，绝不回落到韩语。')}</span></div>}
      {preview && supported && (
        <div className={`pron-tokens${preview?.langs?.includes('ko') ? ' pron-tokens-ko' : ''}`} style={{ marginTop: 10, display: preview?.langs?.includes('ko') ? 'flex' : 'grid', flexWrap: preview?.langs?.includes('ko') ? 'wrap' : undefined, gridTemplateColumns: preview?.langs?.includes('ko') ? undefined : 'repeat(auto-fill, minmax(132px, 1fr))', gap: 8, alignItems: 'flex-start' }}>
          {(preview.tokens || []).map((tok, ti) => {
            const tokenStart = tokenStarts[ti]
            const tokenText = previewTokenText(tok)
            const seg = tok.segLang || lang
            const bucket = nested[seg] || {}
            const isChar = tok.unit === 'char' || tok.chars
            const isEn = seg === 'en'
            const isKo = seg === 'ko'
            const occurrenceBased = isEn || isKo
            const occ = occurrenceBased ? tok.occ : undefined
            const koDimmed = isKo && tok.editable && !showAllKo && !tok.needsReview && !enHasOverride(bucket[tok.word], occ)
            // A word token can contain Han characters even when the preview
            // segmenter classified the whole word as Japanese (for example
            // 今日 -> JA). Use source positions, not the preview language, to
            // determine whether the Han-language picker has taken ownership.
            const mutedPositionsForToken = mutedTokenPositions(tokenStart, tokenText, mutePositionSet)
            const tokenMuted = mutedPositionsForToken.length > 0
            const mutedLangs = [...new Set(mutedPositionsForToken.map(position => mutedLangByPosition?.[position]).filter(Boolean))]
            const mutedLanguageLabel = mutedLangs.length
              ? mutedLangs.map(code => langName(t, code)).join(' / ')
              : (mutedLangLabel || t('another Han language', '另一种汉字语言'))
            const tokenMutedTip = tokenMuted
              ? t(
                  `This token is assigned to ${mutedLanguageLabel} above. Its ${langName(t, seg)} reading here is inactive; adjust the reading in the Han character language section above.`,
                  `此片段已在上方指定为${mutedLanguageLabel}；下方的${langName(t, seg)}读音不生效，请在上方“已选汉字读音校对”中调整。`,
                )
              : undefined
            const repeated = (isEn && (enWordCounts[tok.word] || 0) > 1) || (isKo && (koWordCounts[tok.word] || 0) > 1)
            const enVal = isEn ? enReadingFor(bucket[tok.word], occ, tok.readings).join(' ') : ''
            const koVal = isKo ? enReadingFor(bucket[tok.word], occ, tok.reading ? [tok.reading] : []).join('') : ''
            const overridden = occurrenceBased ? enHasOverride(bucket[tok.word], occ) : !!bucket[tok.word]
            // 「谐音改写」一旦填入内容，本词读音即以该谐音为准；此时上方音标框（含候选下拉）
            // 置灰并禁用，hover 给出书面说明，清空谐音后方可手动编辑音标。
            const enHasRespell = isEn && String(respellEdits[editKey('en', tok.word, occ)] || '').trim().length > 0
            const tokenInactive = tokenMuted || koDimmed
            const respellTip = enHasRespell
              ? t('This phoneme input is currently inactive. The reading of this word is determined by the “sounds like” homophone entered below; clear that field to resume manual editing of the phonemes.',
                  '此音标输入当前不生效。该词读音以下方“谐音”单词为准；清空该谐音后即可恢复手动编辑音标。')
              : tokenMuted ? tokenMutedTip : undefined

            // 标点不做成卡片：以淡色字形内联占位，保留朗读顺序但去噪。
            if (tokIsPunct(tok)) {
              const glyph = isChar ? tok.chars.map(c => c.char).join('') : (tok.word || '')
              return (
                <div key={ti} className="pron-punct" style={{ alignSelf: 'center', textAlign: 'center', fontSize: 15, color: 'var(--muted)', opacity: 0.5 }}>{glyph}</div>
              )
            }

            return (
            <div key={ti} className={`pron-tok${isKo ? ' pron-tok-ko' : ''}`} title={tokenMuted ? tokenMutedTip : koDimmed ? t('This Korean word has no detected pronunciation issue. Turn on “Show all Korean words” above to inspect or edit it.', '当前韩语词语未检测到需要复核的读音。开启上方“显示全部韩语词”后，可以查看或编辑它。') : undefined} style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${tokenMuted ? 'var(--muted)' : overridden ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6, padding: '6px 8px', background: tokenMuted ? 'var(--bg)' : 'var(--surface)', minWidth: 0, ...(tokenMuted ? { opacity: 0.48, filter: 'grayscale(0.7)' } : {}), ...(koDimmed ? { opacity: 0.48, filter: 'grayscale(0.35)' } : {}) }}>
              {multiLang && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }} title={langName(t, seg)}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: SEG_COLORS[seg] || 'var(--muted)', flex: '0 0 auto' }} />
                  <span style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: 0.4 }}>{SEG_SHORT[seg] || String(seg).toUpperCase()}</span>
                </div>
              )}
              {tokenMuted && !isChar && (
                <div className="pron-muted-hint" title={tokenMutedTip}>
                  ↑ {t('Adjust this reading above', '请在上方调整读音')}
                </div>
              )}
              {isChar ? (
                // zh / yue：逐字，多音字给候选下拉
                <div style={{ display: 'flex', gap: 4, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {tok.chars.map((c, ci) => {
                    const absolutePosition = tokenStart >= 0 ? tokenStart + ci : -1
                    const muted = absolutePosition >= 0 && mutePositionSet.has(absolutePosition)
                    const mutedLang = absolutePosition >= 0 ? mutedLangByPosition?.[absolutePosition] : null
                    return (
                    <div key={ci} style={{ textAlign: 'center', opacity: muted ? 0.45 : 1 }}>
                      <div style={{ fontSize: 15, color: muted ? 'var(--muted)' : (c.polyphonic ? 'var(--warning)' : 'var(--text)') }}>{c.char}</div>
                      {muted ? (
                        <div style={{ fontSize: 10, color: 'var(--muted)' }} title={t('This character is set to read in another language; correct its reading in the Han character language section.', '该字已设为按另一种语言朗读；请在“汉字语言”区修改其读音。')}>
                          {'\u2192'} {mutedLang ? langName(t, mutedLang) : (mutedLangLabel || t('other', '其它'))}
                        </div>
                      ) : c.polyphonic && c.candidates.length > 1 ? (
                        <Select
                          className="control" style={{ height: 22, fontSize: 11, padding: '0 2px', minWidth: 54 }}
                          value={c.reading}
                          onChange={e => changeReading(seg, tok.word, ci, e.target.value)}
                        >
                          {(c.candidates.includes(c.reading) ? c.candidates : [c.reading, ...c.candidates]).map(cand => (
                            <option key={cand} value={cand}>{cand}</option>
                          ))}
                        </Select>
                      ) : (
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.reading}</div>
                      )}
                    </div>
                    )
                  })}
                </div>
              ) : (
                // ja / en：逐词，直接改写读音（假名 / ARPABET）。en 的候选下拉 + 谐音改写默认收起，
                // 由 ✎ 展开，避免纵向拥挤；en 逐次出现独立可改（item 19-C：同一词第 1/2/3 次互不影响）。
                <div className={isKo ? 'ko-reading-grid' : undefined} style={{ textAlign: isKo ? 'left' : 'center', minWidth: 0, ...(isKo ? { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 } : {}) }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 15, color: (isEn ? !overridden : tok.source === 'g2p') ? 'var(--text)' : 'var(--accent)' }}>
                    <span style={{ overflowWrap: 'anywhere' }}>{tok.word}
                      {repeated && <sup style={{ fontSize: 9, color: 'var(--muted)', marginLeft: 2 }} title={t('occurrence number', '第几次出现')}>#{occ + 1}</sup>}
                    </span>
                    {isEn && (
                      <button type="button" className="btn btn-sm btn-ghost" disabled={tokenMuted}
                        style={{ padding: '0 4px', height: 18, fontSize: 11, lineHeight: 1, color: openDetail[ti] ? 'var(--accent)' : 'var(--muted)' }}
                        title={tokenMuted ? tokenMutedTip : t('More reading options (dictionary candidates / sounds-like)', '更多读音选项（词典候选 / 谐音改写）')}
                        onClick={() => setOpenDetail(d => ({ ...d, [ti]: !d[ti] }))}
                      >{'\u270e'}</button>
                    )}
                  </div>
                  <input
                    className="control"
                    disabled={enHasRespell || tokenInactive}
                    title={tokenMuted ? tokenMutedTip : respellTip || (koDimmed ? t('Turn on “Show all Korean words” above to edit this reading.', '请先开启“显示全部韩语词”再编辑这个读音。') : undefined)}
                    style={{ height: 24, fontSize: 12, padding: '0 6px', width: '100%', boxSizing: 'border-box', marginTop: 3,
                      ...(enHasRespell || tokenInactive ? { color: 'var(--muted)', fontStyle: 'italic', opacity: 0.7 } : {}) }}
                    value={isEn
                      ? (wordEdits[editKey('en', tok.word, occ)] ?? enVal)
                      : isKo ? (wordEdits[editKey('ko', tok.word, occ)] ?? koVal)
                      : (wordEdits[editKey(seg, tok.word)] ?? (bucket[tok.word] ? bucket[tok.word].join(' ') : (tok.reading || '')))}
                    placeholder={readingUnit(seg)}
                    spellCheck={false}
                    onChange={e => changeWordReading(seg, tok.word, occ, e.target.value)}
                  />
                  {isKo && tok.editable && <div style={{marginTop:4}}><button type="button" className="btn btn-sm btn-ghost" disabled={tokenInactive} title={tokenMuted ? tokenMutedTip : koDimmed ? t('Turn on “Show all Korean words” above to inspect this word.', '请先开启上方“显示全部韩语词”再查看这个词。') : undefined} onClick={()=>setExpandedKo(x=>({...x,[ti]:!x[ti]}))}>{expandedKo[ti]?t('Hide syllables','收起音节'):t('Expand syllables','展开音节')}</button>{tok.unresolved&&<span style={{fontSize:10,color:'var(--danger)',marginLeft:6}}>{t('Unresolved','未解析')}</span>}{expandedKo[ti]&&<div style={{display:'flex',gap:5,flexWrap:'wrap',marginTop:5}}>{(tok.syllables||[]).map((sy,i)=><div key={i} style={{border:`1px solid ${sy.changed?'var(--warning)':'var(--border)'}`,borderRadius:4,padding:'3px 6px',textAlign:'center'}}><div>{sy.written||'·'}</div><div style={{fontSize:10,color:sy.changed?'var(--warning)':'var(--muted)'}}>{sy.spoken||'?'}</div></div>)}</div>}</div>}
                  {isEn && openDetail[ti] && (
                    <>
                      {(tok.candidates || []).length > 0 && (
                        <Select
                          className="control" disabled={enHasRespell || tokenMuted}
                          style={{ height: 22, fontSize: 11, padding: '0 2px', width: '100%', boxSizing: 'border-box', marginTop: 3,
                            ...(enHasRespell || tokenMuted ? { color: 'var(--muted)', fontStyle: 'italic', opacity: 0.55 } : {}) }}
                          value={enVal}
                          onChange={e => changeWordReading('en', tok.word, occ, e.target.value)}
                          title={tokenMuted ? tokenMutedTip : respellTip || t('Pick a dictionary pronunciation', '选择词典读音')}
                        >
                          {(() => {
                            const opts = tok.candidates.includes(enVal) || !enVal ? tok.candidates : [enVal, ...tok.candidates]
                            return opts.map(cand => <option key={cand} value={cand}>{cand}</option>)
                          })()}
                        </Select>
                      )}
                      <input
                        className="control"
                        disabled={tokenMuted}
                        title={tokenMuted ? tokenMutedTip : undefined}
                        style={{ height: 22, fontSize: 11, padding: '0 6px', width: '100%', boxSizing: 'border-box', marginTop: 3,
                          ...(tokenMuted ? { color: 'var(--muted)', fontStyle: 'italic', opacity: 0.7 } : {}) }}
                        value={respellEdits[editKey('en', tok.word, occ)] ?? ''}
                        placeholder={t('sounds like (English word)…', '谐音（英文单词）…')}
                        spellCheck={false}
                        onChange={e => setRespellEdits(r => ({ ...r, [editKey('en', tok.word, occ)]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); respellEn(tok.word, occ) } }}
                        onBlur={() => respellEn(tok.word, occ)}
                      />
                    </>
                  )}
                </div>
              )}
              {overridden && !tokenMuted && (
                <button className="btn btn-sm btn-ghost" style={{ marginTop: 4, fontSize: 10 }} onClick={() => saveToLexicon(seg, tok.word, occ)}>
                  {t('Save to lexicon', '保存到词典')}
                </button>
              )}
            </div>
            )
          })}
        </div>
      )}

      {supported && Object.entries(lexicons).some(([, e]) => e && Object.keys(e).length > 0) && (
        <div style={{ marginTop: 10 }}>
          {Object.entries(lexicons).filter(([, e]) => e && Object.keys(e).length > 0).map(([lg, entries]) => (
            <div key={lg} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{t(`Saved lexicon (${lg}):`, `已保存词典（${lg}）：`)}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Object.entries(entries).map(([w, pys]) => (
                  <span key={w} style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 12, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {w}: {pys.join(' ')}
                    <button className="btn btn-sm btn-ghost" style={{ padding: 0, fontSize: 12, lineHeight: 1 }} onClick={() => deleteFromLexicon(lg, w)}>x</button>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      </div>{/* .pron-out */}
      </div>{/* .pron-grid */}
    </div>
  )
}

// --- Per-character Han-character language override (task #4) ------------------
// The picker is intentionally position-based. A raw character key is not enough:
// the same Han character may occur several times and each occurrence can have a
// different language/reading.
const HAN_VISUAL = {
  zh: { background: '#26735f', borderColor: '#62d4b2', borderRadius: 10, color: '#fff' },
  yue: { background: '#8a5b16', borderColor: '#f0b85a', borderRadius: 3, color: '#fff', clipPath: 'polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)' },
  ja: { background: '#365f9f', borderColor: '#8db8ff', borderRadius: 10, color: '#fff', boxShadow: 'inset 0 -3px 0 #b9d3ff' },
}
const PENDING_VISUAL = { background: '#8d55c7', borderColor: '#d0a7ff', borderStyle: 'dashed', borderRadius: 10, color: '#fff' }

function previewReading(data, lang) {
  const tokens = Array.isArray(data?.tokens) ? data.tokens : []
  if (lang === 'zh' || lang === 'yue') {
    const token = tokens.find(t => (t.unit === 'char' || t.chars) && Array.isArray(t.chars) && t.chars.length)
    const c = token?.chars?.[0]
    return { reading: c?.reading || '', candidates: Array.isArray(c?.candidates) ? c.candidates : [] }
  }
  const token = tokens.find(t => t.unit === 'word' && (t.reading || (Array.isArray(t.readings) && t.readings.length)))
  return {
    reading: token?.reading || (Array.isArray(token?.readings) ? token.readings.join(' ') : ''),
    candidates: Array.isArray(token?.candidates) ? token.candidates : [],
  }
}

// Review the characters that were explicitly assigned above. This is the missing
// bridge in the old UI: it calls the already-existing /api/pron/preview endpoint
// for the selected language, displays the returned reading, and writes the edited
// value into the position-keyed han_readings payload used by inference.
function HanReadingReview({ text, direction, assignments, readings, setReadings }) {
  const { t } = useT()
  const selected = assignmentList(assignments, text)
  const selectionSignature = selected.map(item => `${readingKey(item)}=${item.lang}`).join('|')
  const [suggestions, setSuggestions] = useState({})

  useEffect(() => {
    let cancelled = false
    const activeKeys = new Set(selected.map(readingKey))
    if (!selected.length) {
      setSuggestions({})
      if (typeof setReadings === 'function') setReadings(prev => {
        const next = { ...(prev || {}) }
        for (const key of Object.keys(next)) if (key.startsWith('@')) delete next[key]
        return next
      })
      return () => { cancelled = true }
    }

    // Drop readings for positions no longer selected. Manual values for the active
    // positions are kept; changing the language in the picker clears them there.
    if (typeof setReadings === 'function') setReadings(prev => {
      const next = { ...(prev || {}) }
      for (const key of Object.keys(next)) {
        if (key.startsWith('@') && !activeKeys.has(key)) delete next[key]
      }
      return next
    })

    setSuggestions(prev => Object.fromEntries(selected.map(item => [
      readingKey(item), { ...(prev[readingKey(item)] || {}), loading: true, error: null },
    ])))

    Promise.all(selected.map(async item => {
      const key = readingKey(item)
      try {
        const r = await api('/api/pron/preview', {
          method: 'POST',
          body: { text: item.char, lang: item.lang },
        })
        if (!r.ok) throw new Error(r.data?.error || `Preview failed (${r.status})`)
        const value = previewReading(r.data, item.lang)
        return [key, { ...value, loading: false, error: null }]
      } catch (e) {
        return [key, { reading: '', candidates: [], loading: false, error: e.message }]
      }
    })).then(rows => {
      if (cancelled) return
      setSuggestions(prev => ({ ...prev, ...Object.fromEntries(rows) }))
    })

    return () => { cancelled = true }
  }, [selectionSignature])

  const setReading = (item, value) => {
    if (typeof setReadings !== 'function') return
    const key = readingKey(item)
    setReadings(prev => {
      const next = { ...(prev || {}) }
      const v = String(value ?? '').trim()
      if (v) next[key] = v
      else delete next[key]
      return next
    })
  }

  const groups = HAN_LANGS
    .map(lang => ({ lang, items: selected.filter(item => item.lang === lang) }))
    .filter(group => group.items.length > 0)

  if (!groups.length) {
    return (
      <div className="field-hint" style={{ marginTop: 10, padding: 8, border: '1px dashed var(--border)', borderRadius: 6 }}>
        {t('No Han character positions selected. Select and drag characters above to review their readings here.', '尚未选择汉字位置。请先在上方选择并拖拽汉字，然后在这里校对这些位置的读音。')}
      </div>
    )
  }

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        {t('Selected Han readings', '已选汉字读音校对')}
      </div>
      <div className="field-hint" style={{ marginBottom: 8 }}>
        {t('Only explicitly selected positions appear here. Characters left on automatic inference stay unlit and are reviewed below.', '这里只显示用户明确框选的位置。保持自动判定的汉字不会点亮，继续在下方“读音校对”中处理。')}
      </div>
      {groups.map(group => {
        const unit = READING_UNIT[group.lang]
        return (
          <fieldset key={group.lang} style={{ margin: '0 0 8px', padding: '8px 10px', border: `1px solid ${HAN_VISUAL[group.lang]?.borderColor || 'var(--border)'}`, borderRadius: 8 }}>
            <legend style={{ padding: '0 6px', color: HAN_VISUAL[group.lang]?.borderColor || 'var(--text)', fontSize: 11 }}>
              {langName(t, group.lang)} · {group.items.length}
            </legend>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6 }}>
              {group.items.map(item => {
                const key = readingKey(item)
                const suggestion = suggestions[key] || {}
                const manual = Object.prototype.hasOwnProperty.call(readings || {}, key)
                const value = manual ? readings[key] : (suggestion.reading || '')
                return (
                  <div key={key} style={{ display: 'grid', gridTemplateColumns: '32px 1fr', gap: 6, alignItems: 'center', padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 17 }}>{item.char}</div>
                      <div style={{ fontSize: 9, color: 'var(--muted)' }}>@{item.index}</div>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      {suggestion.candidates?.length > 1 && (
                        <Select
                          className="control"
                          value={value}
                          onChange={e => setReading(item, e.target.value)}
                          style={{ height: 23, fontSize: 11, padding: '0 3px', width: '100%', marginBottom: 3 }}
                          title={t('Choose a suggested reading', '选择候选读音')}
                        >
                          {!suggestion.candidates.includes(value) && value && <option value={value}>{value}</option>}
                          {suggestion.candidates.map(candidate => <option key={candidate} value={candidate}>{candidate}</option>)}
                        </Select>
                      )}
                      <input
                        className="control"
                        value={value}
                        onChange={e => setReading(item, e.target.value)}
                        placeholder={unit?.placeholder || t('reading', '读音')}
                        spellCheck={false}
                        style={{ height: 24, fontSize: 11, padding: '0 6px', width: '100%', boxSizing: 'border-box', color: manual ? 'var(--accent)' : 'var(--text)' }}
                        title={suggestion.error || `${unit?.label || 'reading'} · ${item.char}`}
                      />
                      {suggestion.loading && <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 2 }}>{t('Previewing…', '预览中…')}</div>}
                      {suggestion.error && <div style={{ fontSize: 9, color: 'var(--warning)', marginTop: 2 }}>{t('Preview unavailable; enter it manually.', '预览不可用；请手动输入。')}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          </fieldset>
        )
      })}
    </div>
  )
}

function HanLangPicker({ text, direction, forced, setForced, readings, setReadings, onDragState }) {
  const { t } = useT()
  const positions = hanPositions(text)
  const map = normalizeAssignments(forced, direction, text)
  const [target, setTarget] = useState(direction?.choices?.[0] || 'zh')
  const [drag, setDrag] = useState([])
  const ref = useRef([])
  const pointerId = useRef(null)

  useEffect(() => {
    if (direction && !direction.choices.includes(target)) setTarget(direction.choices[0] || 'zh')
  }, [direction?.base, direction?.choices, target])

  // A coloured box means ONLY a manual position override. Automatic language
  // inference deliberately stays invisible. The gesture is a range toggle:
  //   * if every position in the range already has `target`, clear the range;
  //   * otherwise assign `target` to the whole range (union/incremental select).
  // This gives the desired behaviour for overlapping selections such as
  // “这是一段” then “一段测试” -> “这是一段测试”.
  const finish = useCallback(() => {
    if (!ref.current.length || !direction) return
    const touched = ref.current.slice()
    const { map: next, cleared: allSameTarget } = applyHanRange(map, touched, target)
    const clearReading = new Set()

    for (const pos of touched) {
      const current = assignmentAt(map, pos)
      if (allSameTarget || current !== target) clearReading.add(readingKey(pos))
    }

    setForced(assignmentList(next, text))
    if (typeof setReadings === 'function' && clearReading.size) {
      setReadings(prev => {
        const out = { ...(prev || {}) }
        for (const key of clearReading) delete out[key]
        return out
      })
    }
    ref.current = []
    pointerId.current = null
    setDrag([])
    onDragState?.(false)
  }, [direction, map, onDragState, setForced, setReadings, target, text])

  const extendTo = useCallback((pos) => {
    if (!pos || !ref.current.length) return
    const anchor = ref.current[0].index
    const lo = Math.min(anchor, pos.index)
    const hi = Math.max(anchor, pos.index)
    const range = positions.filter(item => item.index >= lo && item.index <= hi)
    ref.current = range
    setDrag(range)
  }, [positions])

  const extendFromPoint = useCallback((event) => {
    if (pointerId.current == null || event.pointerId !== pointerId.current) return
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-han-index]')
    if (!hit) return
    extendTo(positions.find(item => item.index === Number(hit.getAttribute('data-han-index'))))
  }, [extendTo, positions])

  useEffect(() => {
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('pointermove', extendFromPoint)
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('pointermove', extendFromPoint)
      window.removeEventListener('blur', finish)
    }
  }, [extendFromPoint, finish])

  if (!direction) {
    return <div className="field-hint">{t('Han-language override is available for multilingual text.', '多语言文本可使用汉字语言覆盖。')}</div>
  }

  const overriddenCount = Object.keys(map).filter(k => /^\d+$/.test(k)).length
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span className="field-hint">
          {t('Choose Mandarin, Cantonese, or Japanese, then drag across Han characters. A range with mixed/unselected states is added to that language; a range already fully in that language is cleared back to automatic fallback.', '选择普通话、粤语或日语后拖拽框选汉字：包含未选中或其他语言的范围会增量设为当前语言；已经全部是当前语言的范围会清除覆盖并回退自动判定。')}
        </span>
        <Select className="control" value={target} onChange={e => setTarget(e.target.value)} style={{ height: 28, width: 190 }}>
          {direction.choices.map(x => <option key={x} value={x}>{langName(t, x)}</option>)}
        </Select>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, userSelect: 'none' }}>
        {positions.map(pos => {
          const explicit = assignmentAt(map, pos)
          const pending = drag.some(x => x.index === pos.index)
          const visual = pending ? PENDING_VISUAL : (explicit ? HAN_VISUAL[explicit] : null)
          return (
            <button
              key={pos.index}
              type="button"
              className="btn btn-sm"
              data-han-index={pos.index}
              onPointerDown={e => {
                e.preventDefault()
                pointerId.current = e.pointerId
                e.currentTarget.setPointerCapture?.(e.pointerId)
                ref.current = [pos]
                setDrag([pos])
                onDragState?.(true)
              }}
              onPointerEnter={() => {
                if (pointerId.current != null) extendTo(pos)
              }}
              title={explicit
                ? t(`Manually set to ${LANG_LABEL[explicit]}. Select ${langName(t, explicit)} again to clear it.`, `已手动设为 ${langName(t, explicit)}；再次选择 ${langName(t, explicit)} 可清除。`)
                : t('Automatic/fallback inference (not manually overridden).', '自动/回退判定（未手动覆盖）。')}
              style={{ minWidth: 38, fontSize: 16, background: visual?.background || 'var(--surface)', border: `2px ${visual?.borderStyle || 'solid'} ${visual?.borderColor || 'var(--border)'}`, color: visual?.color || 'var(--text)', borderRadius: visual?.borderRadius, boxShadow: visual?.boxShadow, clipPath: visual?.clipPath }}
            >
              {explicit && <span style={{ fontSize: 9, marginRight: 3 }}>{explicit.toUpperCase()}</span>}{pos.char}
            </button>
          )
        })}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: overriddenCount ? 'var(--accent)' : 'var(--muted)' }}>
        {t(`${overriddenCount} position(s) manually overridden`, `${overriddenCount} 个位置已手动覆盖`)}
      </div>
      <HanReadingReview text={text} direction={direction} assignments={map} readings={readings || {}} setReadings={setReadings} />
    </div>
  )
}

function charLang(ch, direction, assignments, index, inferredHan) {
  // A manual override only ever applies to a Han character. Checking the actual
  // character here (rather than trusting the index) keeps the preview honest
  // even if a stale entry reaches this far: a Han-language override sitting on
  // a kana or a Latin letter is meaningless by definition. The engine's
  // _apply_lang_overrides enforces the same rule on its side.
  const positional = HAN_RE.test(ch) ? assignments?.[index] : undefined
  if (positional) return positional
  if (/[\uac00-\ud7a3]/.test(ch)) return 'ko'
  if (/[A-Za-z]/.test(ch)) return 'en'
  if (/[\u3040-\u30ff]/.test(ch)) return 'ja'
  if (HAN_RE.test(ch)) return inferredHan?.[index] || (direction?.base && HAN_LANGS.includes(direction.base) ? direction.base : 'zh')
  return null
}
function HanFinalPreview({ text, direction, forced }) {
  const { t } = useT(); const assignments = normalizeAssignments(forced, direction, text); const groups=[]
  const inferredHan=direction?.autoMode?inferAutoHanLanguages(text,direction.base,assignments):{}
  let previous='zh'
  Array.from(String(text||'')).forEach((ch,index)=>{const detected=charLang(ch,direction,assignments,index,inferredHan);const lang=detected||previous;previous=lang;const last=groups[groups.length-1];if(last&&last.lang===lang)last.text+=ch;else groups.push({lang,text:ch})})
  return <div style={{borderTop:'1px solid var(--border)',paddingTop:12}}><div style={{fontSize:13,fontWeight:600,marginBottom:10}}>{t('Final preview','最终预览')}</div><div style={{display:'flex',flexWrap:'wrap',gap:12}}>{groups.map((g,i)=><fieldset key={i} style={{margin:0,padding:'8px 12px',border:`2px solid ${SEG_COLORS[g.lang]||'var(--border)'}`,borderRadius:10}}><legend>{g.lang.toUpperCase()}</legend><span style={{whiteSpace:'pre-wrap'}}>{g.text}</span></fieldset>)}</div></div>
}

// One modal that houses BOTH the per-character language picker and reading
// proofing, so the page keeps only a compact trigger button (no tall panels).
function TextPrepModal({ onClose, text, setText, panelLang, pronOverrides, setPronOverrides, hanDirection, hanForced, setHanForced, hanReadings, setHanReadings }) {
  const { t } = useT()
  const dragActiveRef = useRef(false)
  const backdropPointerDownRef = useRef(false)
  const handleBackdropPointerDown = e => {
    backdropPointerDownRef.current = e.target === e.currentTarget
  }
  const handleBackdropClick = e => {
    const close = e.target === e.currentTarget && backdropPointerDownRef.current && !dragActiveRef.current
    backdropPointerDownRef.current = false
    if (close) onClose()
  }
  const updateText = value => {
    const next = typeof value === 'function' ? value(text) : value
    if (next !== text) {
      // Absolute positions are no longer trustworthy after insertion/deletion.
      // Clear only the Han-language layer and its position-keyed readings; the
      // ordinary Reading proofing buckets remain available for the new text.
      setHanForced([])
      setHanReadings({})
    }
    setText(value)
  }
  // Characters forced to the reverse language are read in that language, so the
  // Chinese/Cantonese reading proofing below does not apply to them (they are
  // muted there). Their reading is set in the Han character language section.
  const assignmentMap = normalizeAssignments(hanForced, hanDirection, text)
  const forcedPositions = hanDirection ? assignmentList(assignmentMap, text) : []
  const mutedLangByPosition = Object.fromEntries(forcedPositions.map(pos => [pos.index, pos.lang]))
  const forcedInText = forcedPositions.map(pos => pos.char)
  return (
    <div className="modal-backdrop" onPointerDown={handleBackdropPointerDown} onClick={handleBackdropClick}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 1180, width: '94%' }}>
        <div className="modal-hdr">{t('Text preparation', '文本预处理')}</div>
        <div className="modal-body">
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t('Han character language', '汉字语言')}</div>
            <HanLangPicker
              text={text}
              direction={hanDirection}
              forced={hanForced}
              setForced={setHanForced}
              readings={hanReadings}
              setReadings={setHanReadings}
              onDragState={active => { dragActiveRef.current = active }}
            />
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t('Reading proofing', '读音校对')}</div>
            {forcedInText.length > 0 && (
              <div className="field-hint" style={{ color: 'var(--warning)', marginBottom: 8 }}>
                {t(
                  `${forcedInText.join(' ')} ${forcedInText.length > 1 ? 'are' : 'is'} assigned to another Han language; the ${LANG_LABEL[panelLang] || panelLang} reading below does not apply. Set the reading in the Han character language section above.`,
                  `${forcedInText.join(' ')} 已分配给另一种汉字语言；下方的 ${langName(t, panelLang)} 读音不生效。请在上方“汉字语言”区设置读音。`,
                )}
              </div>
            )}
            <PronPanel
              text={text} setText={updateText} lang={panelLang}
              overrides={pronOverrides} setOverrides={setPronOverrides} layout="wide"
              mutedPositions={forcedPositions.map(pos => pos.index)}
              mutedLangByPosition={mutedLangByPosition}
              mutedLangLabel={hanDirection ? t('another Han language', '另一种汉字语言') : null}
            />
          </div>
          <HanFinalPreview text={text} direction={hanDirection} forced={hanForced} />
        </div>
        <div className="modal-ftr">
          <button className="btn" onClick={onClose}>{t('Done', '完成')}</button>
        </div>
      </div>
    </div>
  )
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
