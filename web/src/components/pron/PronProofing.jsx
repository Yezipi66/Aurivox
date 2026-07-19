// Reading-proofing / multilingual module. Extracted verbatim from App.jsx (no logic change).
import { useState, useEffect, useCallback } from 'react'
import { Select } from '../common/Select'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'

// Item 17: localised language name for use inside translated sentences. Technical
// reading units (kana, ARPABET, pinyin, jyutping) always stay English.
function langName(t, code) {
  return t(
    ({ zh: 'Chinese', yue: 'Cantonese', ja: 'Japanese', en: 'English', ko: 'Korean' })[code] || code,
    ({ zh: '中文', yue: '粤语', ja: '日语', en: '英语', ko: '韩语' })[code] || code,
  )
}

// 读音校对面板（task6）：勾选后展开的二级面板，兼作文本编辑器 + 逐字读音校对。
// 中文(zh)/粤语(yue) 走真实 g2pW 预览；其它语言为契约占位（ko 未经测试）。
function PronPanel({ text, setText, lang, overrides, setOverrides, layout, mutedChars, mutedLangLabel }) {
  const { t } = useT()
  const wide = layout === 'wide'
  const muteSet = mutedChars instanceof Set ? mutedChars : new Set(mutedChars || [])
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // item 19-A: 词典按语言存储 {lang: entries}（混合文本可能涉及多种语言）。
  const [lexicons, setLexicons] = useState({})
  // 逐词编辑缓冲（ja 假名 / en ARPABET），键含 segLang 以避免跨语言同形词冲突。
  const [wordEdits, setWordEdits] = useState({})
  // en「谐音改写」输入缓冲：{word -> 另一个英文词}。
  const [respellEdits, setRespellEdits] = useState({})
  // item 19-A：覆盖始终按语言分桶；旧的扁平形态自动归入面板基础语系。
  const nested = nestedOverrides(overrides, lang)
  // zh/yue：逐字选候选；ja：逐词改假名；en：逐词改音标；其它语言契约占位。
  const supported = lang === 'zh' || lang === 'yue' || lang === 'ja' || lang === 'en'
  const isCharUnit = lang === 'zh' || lang === 'yue'
  const readingUnit = (segLang) => segLang === 'ja' ? 'kana' : segLang === 'en' ? 'ARPABET (space-separated)' : 'reading'

  const loadLexicon = useCallback((lg) => {
    if (!lg) return
    api(`/api/pron/lexicon?lang=${encodeURIComponent(lg)}`).then(r => {
      if (r.ok && r.data?.entries) setLexicons(prev => ({ ...prev, [lg]: r.data.entries }))
    }).catch(() => {})
  }, [])

  useEffect(() => { if (supported) loadLexicon(lang) }, [lang, supported, loadLexicon])

  const doPreview = async () => {
    setError(null); setPreview(null); setWordEdits({}); setRespellEdits({})
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
    setWordEdits(e => ({ ...e, [editKey(segLang, word, isEn ? occ : undefined)]: str }))
    const arr = isEn ? str.trim().split(/\s+/).filter(Boolean) : (str.trim() ? [str.trim()] : [])
    setBucket(segLang, b => {
      const n = { ...b }
      if (isEn && occ != null) {
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
      if (isEn && occ != null && tk.occ !== occ) return tk          // only this occurrence
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
  for (const tk of (preview?.tokens || [])) {
    if (tk.segLang === 'en' && tk.unit === 'word') enWordCounts[tk.word] = (enWordCounts[tk.word] || 0) + 1
  }

  return (
    <div className={`section pron-panel${wide ? ' pron-panel-wide' : ''}`} style={{ margin: '8px 0', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div className="pron-grid">
      <div className="pron-edit">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{t('Reading proofing', '读音校对')}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {!supported ? t(`Language "${lang}" is contract-only for now.`, `语言 “${lang}” 目前仅为占位支持。`)
            : isCharUnit ? t('Edit text, preview readings, fix polyphonic characters.', '编辑文本、预览读音、修正多音字。')
            : lang === 'ja' ? t('Edit text, preview readings, fix a word\u2019s kana reading.', '编辑文本、预览读音、修正单词的 kana 读音。')
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
      {preview && supported && (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(preview.tokens || []).map((tok, ti) => {
            const seg = tok.segLang || lang
            const bucket = nested[seg] || {}
            const isChar = tok.unit === 'char' || tok.chars
            const isEn = seg === 'en'
            const occ = isEn ? tok.occ : undefined
            const repeated = isEn && (enWordCounts[tok.word] || 0) > 1
            const enVal = isEn ? enReadingFor(bucket[tok.word], occ, tok.readings).join(' ') : ''
            const overridden = isEn ? enHasOverride(bucket[tok.word], occ) : !!bucket[tok.word]
            return (
            <div key={ti} style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', background: 'var(--surface)' }}>
              {multiLang && (
                <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{langName(t, seg)}</div>
              )}
              {isChar ? (
                // zh / yue：逐字，多音字给候选下拉
                <div style={{ display: 'flex', gap: 4 }}>
                  {tok.chars.map((c, ci) => {
                    const muted = muteSet.has(c.char)
                    return (
                    <div key={ci} style={{ textAlign: 'center', opacity: muted ? 0.45 : 1 }}>
                      <div style={{ fontSize: 15, color: muted ? 'var(--muted)' : (c.polyphonic ? 'var(--warning)' : 'var(--text)') }}>{c.char}</div>
                      {muted ? (
                        <div style={{ fontSize: 10, color: 'var(--muted)' }} title={t('This character is set to read in another language; correct its reading in the Han character language section.', '该字已设为按另一种语言朗读；请在“汉字语言”区修改其读音。')}>
                          {'\u2192'} {mutedLangLabel || t('other', '其它')}
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
                // ja / en：逐词，直接改写读音（假名 / ARPABET）；en 额外给候选下拉 + 谐音改写，
                // 且 en 逐次出现独立可改（item 19-C：同一词第 1/2/3 次出现互不影响）。
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 15, color: (isEn ? !overridden : tok.source === 'g2p') ? 'var(--text)' : 'var(--accent)' }}>
                    {tok.word}
                    {repeated && <sup style={{ fontSize: 9, color: 'var(--muted)', marginLeft: 2 }} title={t('occurrence number', '第几次出现')}>#{occ + 1}</sup>}
                  </div>
                  {isEn && (tok.candidates || []).length > 0 && (
                    <Select
                      className="control" style={{ height: 22, fontSize: 11, padding: '0 2px', minWidth: 180, marginBottom: 3 }}
                      value={enVal}
                      onChange={e => changeWordReading('en', tok.word, occ, e.target.value)}
                      title={t('Pick a dictionary pronunciation', '选择词典读音')}
                    >
                      {(() => {
                        const opts = tok.candidates.includes(enVal) || !enVal ? tok.candidates : [enVal, ...tok.candidates]
                        return opts.map(cand => <option key={cand} value={cand}>{cand}</option>)
                      })()}
                    </Select>
                  )}
                  <input
                    className="control"
                    style={{ height: 24, fontSize: 12, padding: '0 6px', minWidth: isEn ? 180 : 120 }}
                    value={isEn
                      ? (wordEdits[editKey('en', tok.word, occ)] ?? enVal)
                      : (wordEdits[editKey(seg, tok.word)] ?? (bucket[tok.word] ? bucket[tok.word].join(' ') : (tok.reading || '')))}
                    placeholder={readingUnit(seg)}
                    spellCheck={false}
                    onChange={e => changeWordReading(seg, tok.word, occ, e.target.value)}
                  />
                  {isEn && (
                    <input
                      className="control"
                      style={{ height: 22, fontSize: 11, padding: '0 6px', minWidth: 180, marginTop: 3 }}
                      value={respellEdits[editKey('en', tok.word, occ)] ?? ''}
                      placeholder={t('sounds like (English word)…', '谐音（英文单词）…')}
                      spellCheck={false}
                      onChange={e => setRespellEdits(r => ({ ...r, [editKey('en', tok.word, occ)]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); respellEn(tok.word, occ) } }}
                      onBlur={() => respellEn(tok.word, occ)}
                    />
                  )}
                </div>
              )}
              {overridden && (
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
// Only Han characters are ambiguous between Chinese/Cantonese and Japanese; every
// other script (Hangul, Latin, kana) is unambiguous and auto-detected. So the
// override toggle appears ONLY on Han characters, and its direction is always the
// reverse of the dominant language (auto-decided — the user never picks zh vs ja).
const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/
const LANG_LABEL = { zh: 'Chinese', yue: 'Cantonese', ja: 'Japanese' }
// Reading unit + placeholder for a forced character's reverse-language reading.
// ja carries kun/on kana; zh/yue carry a single tone-numbered pinyin syllable.
const READING_UNIT = {
  ja: { label: 'kana', placeholder: 'e.g. \u304b\u306a' },
  zh: { label: 'pinyin', placeholder: 'e.g. hao3' },
  yue: { label: 'jyutping/pinyin', placeholder: 'e.g. hou2' },
}

function distinctHanChars(text) {
  const seen = new Set(); const out = []
  for (const ch of String(text || '')) {
    if (HAN_RE.test(ch) && !seen.has(ch)) { seen.add(ch); out.push(ch) }
  }
  return out
}

// Reverse-language routing direction for shared Han characters. Returns null when
// the current target language has no zh/ja ambiguity (en / ko / plain auto).
function hanOverrideDirection(textLang, voiceLang) {
  const v = String(voiceLang || '').replace(/^all_/, '').replace(/^auto.*/, '')
  let base
  if (textLang === 'all_zh') base = 'zh'
  else if (textLang === 'all_yue') base = 'yue'
  else if (textLang === 'all_ja') base = 'ja'
  else if (textLang === 'auto_zh_ja') base = v === 'ja' ? 'ja' : (v === 'yue' ? 'yue' : 'zh')
  else return null
  return { base, reverse: base === 'ja' ? 'zh' : 'ja' }
}

// Build the {char -> reverseLang} payload sent to the engine as lang_overrides.
function buildLangOverrides(direction, forced) {
  if (!direction || !forced || !forced.length) return undefined
  const out = {}
  for (const ch of forced) out[ch] = direction.reverse
  return Object.keys(out).length ? out : undefined
}

// --- Nested per-language override helpers (item 19-A) ------------------------
// Reading-proofing overrides are stored per language: {lang: {word: [readings]}}.
// A legacy flat {word: [readings]} (older recipes / prior state) is auto-wrapped
// under fallbackLang for backward compatibility (zero regression).
function isNestedOverrides(o) {
  const vals = Object.values(o || {})
  return vals.length > 0 && vals.every(v => v && typeof v === 'object' && !Array.isArray(v))
}
function nestedOverrides(o, fallbackLang) {
  if (!o || Object.keys(o).length === 0) return {}
  if (isNestedOverrides(o)) return o
  return { [fallbackLang || 'zh']: o }
}
function countOverrides(o) {
  const n = nestedOverrides(o, 'zh')
  let c = 0
  for (const k of Object.keys(n)) c += Object.keys(n[k] || {}).length
  return c
}

// Merge the per-language reading proofing with the reverse-language readings of
// the forced Han characters into the engine's pron_overrides payload.
// Always returns nested {lang: {word: [readings]}} (the backend understands both,
// and mixed-language runs require the nested, per-language form).
function buildPronPayload(pronOverrides, baseLang, direction, forced, readings) {
  const nested = nestedOverrides(pronOverrides, baseLang)
  const out = {}
  for (const [lg, words] of Object.entries(nested)) {
    if (words && Object.keys(words).length) out[lg] = { ...words }
  }
  if (direction && forced && forced.length && readings) {
    const forcedSet = new Set(forced)
    const reverseBucket = {}
    for (const ch of Object.keys(readings)) {
      const r = String(readings[ch] || '').trim()
      if (r && forcedSet.has(ch)) reverseBucket[ch] = [r]
    }
    if (Object.keys(reverseBucket).length) {
      out[direction.reverse] = { ...(out[direction.reverse] || {}), ...reverseBucket }
    }
  }
  return Object.keys(out).length ? out : undefined
}

function HanLangPicker({ text, direction, forced, setForced, readings, setReadings }) {
  const { t } = useT()
  const chars = distinctHanChars(text)
  // Hooks must run unconditionally (before the early returns below).
  const forcedSet = new Set(forced || [])
  const forcedChars = chars.filter(ch => forcedSet.has(ch))   // forced chars in text order
  const reverse = direction ? direction.reverse : null
  // Engine default readings for each forced char in the reverse language, so the
  // editor never shows an empty box with no reference. { char -> reading } plus
  // { char -> [candidates] } for the polyphonic zh/yue case.
  const [defaults, setDefaults] = useState({})
  const [defCands, setDefCands] = useState({})
  const [defLoading, setDefLoading] = useState(false)
  const forcedKey = forcedChars.join('')
  useEffect(() => {
    if (!reverse || forcedChars.length === 0) { setDefaults({}); setDefCands({}); return }
    let cancelled = false
    setDefLoading(true)
    // Preview each forced char in isolation in the reverse language to read its
    // default reading (ja -> kana word token; zh/yue -> char token + candidates).
    Promise.all(forcedChars.map(ch =>
      api('/api/pron/preview', { method: 'POST', body: { text: ch, lang: reverse } })
        .then(r => ({ ch, r })).catch(() => ({ ch, r: null }))
    )).then(results => {
      if (cancelled) return
      const nd = {}, nc = {}
      for (const { ch, r } of results) {
        if (!r || !r.ok || !r.data) continue
        const toks = r.data.tokens || []
        if (reverse === 'ja') {
          const reading = toks.map(t => t.reading || '').join('')
          if (reading) nd[ch] = reading
        } else {
          for (const t of toks) for (const c of (t.chars || [])) {
            if (c.char !== ch) continue
            if (c.reading) nd[ch] = c.reading
            if (Array.isArray(c.candidates) && c.candidates.length) nc[ch] = c.candidates
          }
        }
      }
      setDefaults(nd); setDefCands(nc)
    }).finally(() => { if (!cancelled) setDefLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forcedKey, reverse])
  if (!direction) {
    return <div className="field-hint" style={{ color: 'var(--muted)' }}>
      {t('Per-character language override applies to Chinese / Cantonese / Japanese targets only.', '逐字语言覆盖仅适用于 Chinese / Cantonese / Japanese 目标。')}
    </div>
  }
  if (chars.length === 0) {
    return <div className="field-hint" style={{ color: 'var(--muted)' }}>{t('No Han characters in the text yet.', '文本中暂无汉字。')}</div>
  }
  const rd = readings || {}
  const unit = READING_UNIT[direction.reverse] || { label: 'reading', placeholder: '' }
  const toggle = (ch) => {
    const next = new Set(forcedSet)
    if (next.has(ch)) next.delete(ch); else next.add(ch)
    setForced([...next])
  }
  const setReading = (ch, val) => {
    const next = { ...rd }
    if (val && val.trim()) next[ch] = val; else delete next[ch]
    setReadings && setReadings(next)
  }
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
        {t(<>Han characters read as <strong>{LANG_LABEL[direction.base]}</strong> by default. Click a character to force it to read as <strong>{LANG_LABEL[direction.reverse]}</strong>.</>,
           <>汉字默认按 <strong>{langName(t, direction.base)}</strong> 朗读。点击某个字可强制它按 <strong>{langName(t, direction.reverse)}</strong> 朗读。</>)}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {chars.map(ch => {
          const on = forcedSet.has(ch)
          return (
            <button
              key={ch} type="button" onClick={() => toggle(ch)} className="btn btn-sm"
              title={on ? t(`Reads as ${LANG_LABEL[direction.reverse]}`, `按 ${langName(t, direction.reverse)} 朗读`) : t(`Reads as ${LANG_LABEL[direction.base]}`, `按 ${langName(t, direction.base)} 朗读`)}
              style={{
                minWidth: 34, fontSize: 16, padding: '4px 8px',
                background: on ? 'var(--accent)' : 'var(--surface)',
                color: on ? '#fff' : 'var(--text)',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >{ch}</button>
          )
        })}
      </div>
      {forcedChars.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
            {t(
              `${LANG_LABEL[direction.reverse]} reading (${unit.label}) for each forced character. The engine default is shown in grey${defLoading ? ' (loading\u2026)' : ''} \u2014 keep it as-is, pick another reading, or type your own. Han characters have multiple readings (e.g. Japanese kun\u2019yomi / on\u2019yomi).`,
              `为每个强制字设置 ${langName(t, direction.reverse)} 读音（${unit.label}）。灰色显示的是引擎默认读音${defLoading ? '（加载中…）' : ''}——可保持不变、选择其它读音，或自行输入。汉字常有多种读音（如日语 kun\u2019yomi / on\u2019yomi）。`,
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {forcedChars.map(ch => {
              const overridden = rd[ch] !== undefined
              const def = defaults[ch] || ''
              const shown = overridden ? rd[ch] : def
              const cands = defCands[ch] || []
              // Candidate pool for the dropdown: default + engine candidates + any custom value.
              const pool = []
              for (const v of [def, ...cands, shown]) {
                if (v && !pool.includes(v)) pool.push(v)
              }
              return (
                <div key={ch} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 15 }}>{ch}</span>
                    <input
                      className="control" spellCheck={false}
                      title={overridden ? t('Custom reading (overrides the engine default)', '自定义读音（覆盖引擎默认）')
                                        : (def ? t('Engine default reading', '引擎默认读音') : '')}
                      style={{
                        height: 24, fontSize: 12, padding: '0 6px',
                        width: direction.reverse === 'ja' ? 96 : 84,
                        fontStyle: overridden ? 'normal' : 'italic',
                        color: overridden ? 'var(--text)' : 'var(--muted)',
                      }}
                      value={shown}
                      placeholder={def || unit.placeholder}
                      onChange={e => setReading(ch, e.target.value)}
                    />
                    {pool.length > 1 && (
                      <Select
                        className="control" title="Pick a reading"
                        style={{ height: 24, fontSize: 12, maxWidth: 96 }}
                        value={pool.includes(shown) ? shown : ''}
                        onChange={e => setReading(ch, e.target.value)}
                      >
                        {pool.map(cd => (
                          <option key={cd} value={cd}>{cd === def ? t(`${cd} (default)`, `${cd}（默认）`) : cd}</option>
                        ))}
                      </Select>
                    )}
                    {overridden && (
                      <button
                        type="button" className="btn btn-sm btn-ghost"
                        title={t('Reset to the engine default reading', '重置为引擎默认读音')}
                        style={{ padding: '0 6px', height: 24 }}
                        onClick={() => setReading(ch, '')}
                      >{'\u21ba'}</button>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', paddingLeft: 20 }}>
                    {def
                      ? <>{t('default:', '默认：')} <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{def}</span></>
                      : defLoading ? t('loading default\u2026', '加载默认读音…') : t('no default reading available', '无可用默认读音')}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {forcedSet.size > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{t(`${forcedSet.size} character(s) forced to ${LANG_LABEL[direction.reverse]}`, `已强制 ${forcedSet.size} 个字按 ${langName(t, direction.reverse)} 朗读`)}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => { setForced([]); setReadings && setReadings({}) }}>{t('Clear', '清除')}</button>
        </div>
      )}
    </div>
  )
}

// One modal that houses BOTH the per-character language picker and reading
// proofing, so the page keeps only a compact trigger button (no tall panels).
function TextPrepModal({ onClose, text, setText, panelLang, pronOverrides, setPronOverrides, hanDirection, hanForced, setHanForced, hanReadings, setHanReadings }) {
  const { t } = useT()
  // Characters forced to the reverse language are read in that language, so the
  // Chinese/Cantonese reading proofing below does not apply to them (they are
  // muted there). Their reading is set in the Han character language section.
  const forcedInText = (hanDirection && hanForced && hanForced.length)
    ? distinctHanChars(text).filter(ch => hanForced.includes(ch))
    : []
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 780, width: '92%' }}>
        <div className="modal-hdr">{t('Text preparation', '文本预处理')}</div>
        <div className="modal-body">
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t('Han character language', '汉字语言')}</div>
            <HanLangPicker text={text} direction={hanDirection} forced={hanForced} setForced={setHanForced} readings={hanReadings} setReadings={setHanReadings} />
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t('Reading proofing', '读音校对')}</div>
            {forcedInText.length > 0 && (
              <div className="field-hint" style={{ color: 'var(--warning)', marginBottom: 8 }}>
                {t(
                  `${forcedInText.join(' ')} ${forcedInText.length > 1 ? 'are' : 'is'} set to read as ${LANG_LABEL[hanDirection.reverse]}; the ${LANG_LABEL[panelLang] || panelLang} reading below does not apply to ${forcedInText.length > 1 ? 'them' : 'it'}. Set ${forcedInText.length > 1 ? 'their' : 'its'} reading in the Han character language section above.`,
                  `${forcedInText.join(' ')} 已设为按 ${langName(t, hanDirection.reverse)} 朗读；下方的 ${langName(t, panelLang)} 读音对${forcedInText.length > 1 ? '它们' : '它'}不生效。请在上方“汉字语言”区设置${forcedInText.length > 1 ? '它们' : '它'}的读音。`,
                )}
              </div>
            )}
            <PronPanel
              text={text} setText={setText} lang={panelLang}
              overrides={pronOverrides} setOverrides={setPronOverrides} layout="wide"
              mutedChars={forcedInText}
              mutedLangLabel={hanDirection ? LANG_LABEL[hanDirection.reverse] : null}
            />
          </div>
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
  LANG_LABEL,
}
