// Reading-proofing / multilingual module. Extracted verbatim from App.jsx (no logic change).
import { useState, useEffect, useCallback, useRef } from 'react'
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
  // en 每个 token 的「候选 / 谐音」详情默认收起，键为 token 索引，避免纵向拥挤。
  const [openDetail, setOpenDetail] = useState({})
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
        <div className="pron-tokens" style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 8, alignItems: 'start' }}>
          {(preview.tokens || []).map((tok, ti) => {
            const seg = tok.segLang || lang
            const bucket = nested[seg] || {}
            const isChar = tok.unit === 'char' || tok.chars
            const isEn = seg === 'en'
            const occ = isEn ? tok.occ : undefined
            const repeated = isEn && (enWordCounts[tok.word] || 0) > 1
            const enVal = isEn ? enReadingFor(bucket[tok.word], occ, tok.readings).join(' ') : ''
            const overridden = isEn ? enHasOverride(bucket[tok.word], occ) : !!bucket[tok.word]
            // 「谐音改写」一旦填入内容，本词读音即以该谐音为准；此时上方音标框（含候选下拉）
            // 置灰并禁用，hover 给出书面说明，清空谐音后方可手动编辑音标。
            const enHasRespell = isEn && String(respellEdits[editKey('en', tok.word, occ)] || '').trim().length > 0
            const respellTip = enHasRespell
              ? t('This phoneme input is currently inactive. The reading of this word is determined by the “sounds like” homophone entered below; clear that field to resume manual editing of the phonemes.',
                  '此音标输入当前不生效。该词读音以下方“谐音”单词为准；清空该谐音后即可恢复手动编辑音标。')
              : undefined

            // 标点不做成卡片：以淡色字形内联占位，保留朗读顺序但去噪。
            if (tokIsPunct(tok)) {
              const glyph = isChar ? tok.chars.map(c => c.char).join('') : (tok.word || '')
              return (
                <div key={ti} className="pron-punct" style={{ alignSelf: 'center', textAlign: 'center', fontSize: 15, color: 'var(--muted)', opacity: 0.5 }}>{glyph}</div>
              )
            }

            return (
            <div key={ti} className="pron-tok" style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${overridden ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6, padding: '4px 6px', background: 'var(--surface)', minWidth: 0 }}>
              {multiLang && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }} title={langName(t, seg)}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: SEG_COLORS[seg] || 'var(--muted)', flex: '0 0 auto' }} />
                  <span style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: 0.4 }}>{SEG_SHORT[seg] || String(seg).toUpperCase()}</span>
                </div>
              )}
              {isChar ? (
                // zh / yue：逐字，多音字给候选下拉
                <div style={{ display: 'flex', gap: 4, justifyContent: 'center', flexWrap: 'wrap' }}>
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
                // ja / en：逐词，直接改写读音（假名 / ARPABET）。en 的候选下拉 + 谐音改写默认收起，
                // 由 ✎ 展开，避免纵向拥挤；en 逐次出现独立可改（item 19-C：同一词第 1/2/3 次互不影响）。
                <div style={{ textAlign: 'center', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 15, color: (isEn ? !overridden : tok.source === 'g2p') ? 'var(--text)' : 'var(--accent)' }}>
                    <span style={{ overflowWrap: 'anywhere' }}>{tok.word}
                      {repeated && <sup style={{ fontSize: 9, color: 'var(--muted)', marginLeft: 2 }} title={t('occurrence number', '第几次出现')}>#{occ + 1}</sup>}
                    </span>
                    {isEn && (
                      <button type="button" className="btn btn-sm btn-ghost"
                        style={{ padding: '0 4px', height: 18, fontSize: 11, lineHeight: 1, color: openDetail[ti] ? 'var(--accent)' : 'var(--muted)' }}
                        title={t('More reading options (dictionary candidates / sounds-like)', '更多读音选项（词典候选 / 谐音改写）')}
                        onClick={() => setOpenDetail(d => ({ ...d, [ti]: !d[ti] }))}
                      >{'\u270e'}</button>
                    )}
                  </div>
                  <input
                    className="control"
                    disabled={enHasRespell}
                    title={respellTip}
                    style={{ height: 24, fontSize: 12, padding: '0 6px', width: '100%', boxSizing: 'border-box', marginTop: 3,
                      ...(enHasRespell ? { color: 'var(--muted)', fontStyle: 'italic', opacity: 0.55 } : {}) }}
                    value={isEn
                      ? (wordEdits[editKey('en', tok.word, occ)] ?? enVal)
                      : (wordEdits[editKey(seg, tok.word)] ?? (bucket[tok.word] ? bucket[tok.word].join(' ') : (tok.reading || '')))}
                    placeholder={readingUnit(seg)}
                    spellCheck={false}
                    onChange={e => changeWordReading(seg, tok.word, occ, e.target.value)}
                  />
                  {isEn && openDetail[ti] && (
                    <>
                      {(tok.candidates || []).length > 0 && (
                        <Select
                          className="control" disabled={enHasRespell}
                          style={{ height: 22, fontSize: 11, padding: '0 2px', width: '100%', boxSizing: 'border-box', marginTop: 3,
                            ...(enHasRespell ? { color: 'var(--muted)', fontStyle: 'italic', opacity: 0.55 } : {}) }}
                          value={enVal}
                          onChange={e => changeWordReading('en', tok.word, occ, e.target.value)}
                          title={respellTip || t('Pick a dictionary pronunciation', '选择词典读音')}
                        >
                          {(() => {
                            const opts = tok.candidates.includes(enVal) || !enVal ? tok.candidates : [enVal, ...tok.candidates]
                            return opts.map(cand => <option key={cand} value={cand}>{cand}</option>)
                          })()}
                        </Select>
                      )}
                      <input
                        className="control"
                        style={{ height: 22, fontSize: 11, padding: '0 6px', width: '100%', boxSizing: 'border-box', marginTop: 3 }}
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
// Shared Han-character language override. Keep the original compact per-character
// buttons and per-character reading editor; add drag selection and a selectable
// Mandarin/Cantonese/Japanese override language without replacing PronPanel.
const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/
const LANG_LABEL = { zh: 'Mandarin', yue: 'Cantonese', ja: 'Japanese' }
const HAN_LANGS = ['zh', 'yue', 'ja']
const READING_UNIT = {
  ja: { label: 'kana', placeholder: 'e.g. かな' },
  zh: { label: 'pinyin', placeholder: 'e.g. hao3' },
  yue: { label: 'Jyutping', placeholder: 'e.g. hou2' },
}
const HAN_VISUAL = {
  zh: { background: '#26735f', borderColor: '#62d4b2', borderRadius: 10, color: '#fff' },
  yue: { background: '#8a5b16', borderColor: '#f0b85a', borderRadius: 3, color: '#fff', clipPath: 'polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)' },
  ja: { background: '#365f9f', borderColor: '#8db8ff', borderRadius: 10, color: '#fff', boxShadow: 'inset 0 -3px 0 #b9d3ff' },
}
const PENDING_VISUAL = { background: '#8d55c7', borderColor: '#d0a7ff', borderStyle: 'dashed', borderRadius: 10, color: '#fff' }
function distinctHanChars(text) {
  const seen = new Set(); const out = []
  for (const ch of String(text || '')) if (HAN_RE.test(ch) && !seen.has(ch)) { seen.add(ch); out.push(ch) }
  return out
}
function normalizeAssignments(forced, direction) {
  const fallback = direction?.choices?.[0] || (direction?.base === 'ja' ? 'zh' : 'ja')
  const out = {}
  for (const item of (forced || [])) {
    if (typeof item === 'string') out[item] = fallback
    else if (item?.char && HAN_LANGS.includes(item.lang) && item.lang !== direction?.base) out[item.char] = item.lang
  }
  return out
}
function assignmentList(map) { return Object.entries(map).map(([char, lang]) => ({ char, lang })) }
function hanOverrideDirection(textLang, voiceLang) {
  const rawVoice = String(voiceLang || '').toLowerCase()
  const v = rawVoice.replace(/^all_/, '').replace(/^auto.*/, '')
  let base
  if (textLang === 'all_zh') base = 'zh'
  else if (textLang === 'all_yue') base = 'yue'
  else if (textLang === 'all_ja') base = 'ja'
  else if (textLang === 'auto_zh_ja' || textLang === 'auto') base = HAN_LANGS.includes(v) ? v : 'zh'
  else return null
  const assetIsAuto = !v || rawVoice.startsWith('auto')
  return { base, choices: assetIsAuto ? HAN_LANGS : HAN_LANGS.filter(l => l !== base), assetIsAuto }
}
function buildLangOverrides(direction, forced) {
  if (!direction) return undefined
  const out = normalizeAssignments(forced, direction)
  return Object.keys(out).length ? out : undefined
}
function isNestedOverrides(o) {
  const vals = Object.values(o || {})
  return vals.length > 0 && vals.every(v => v && typeof v === 'object' && !Array.isArray(v))
}
function nestedOverrides(o, fallbackLang) {
  if (!o || Object.keys(o).length === 0) return {}
  return isNestedOverrides(o) ? o : { [fallbackLang || 'zh']: o }
}
function countOverrides(o) {
  const n = nestedOverrides(o, 'zh'); let c = 0
  for (const k of Object.keys(n)) c += Object.keys(n[k] || {}).length
  return c
}
function buildPronPayload(pronOverrides, baseLang, direction, forced, readings) {
  const nested = nestedOverrides(pronOverrides, baseLang), out = {}
  for (const [lg, words] of Object.entries(nested)) if (words && Object.keys(words).length) out[lg] = { ...words }
  const assignments = normalizeAssignments(forced, direction)
  for (const [ch, lang] of Object.entries(assignments)) {
    const r = String((readings || {})[ch] || '').trim()
    if (r) out[lang] = { ...(out[lang] || {}), [ch]: [r] }
  }
  return Object.keys(out).length ? out : undefined
}
function HanLangPicker({ text, direction, forced, setForced, readings, setReadings }) {
  const { t } = useT()
  const chars = distinctHanChars(text)
  const assignments = normalizeAssignments(forced, direction)
  const [targetLang, setTargetLang] = useState(direction?.choices?.[0] || 'zh')
  const [dragging, setDragging] = useState(false)
  const [dragChars, setDragChars] = useState([])
  const dragRef = useRef([])
  const draggingRef = useRef(false)
  useEffect(() => {
    if (direction && !direction.choices.includes(targetLang)) setTargetLang(direction.choices[0] || 'zh')
  }, [direction?.base, direction?.assetIsAuto]) // eslint-disable-line react-hooks/exhaustive-deps
  const applyChars = (picked) => {
    if (!direction || !picked.length) return
    const next = { ...assignments }
    const toggleSingle = picked.length === 1 && targetLang !== '__default__' && next[picked[0]] === targetLang
    for (const ch of picked) {
      if (targetLang === '__default__' || targetLang === direction.base || toggleSingle) {
        delete next[ch]
      } else {
        next[ch] = targetLang
      }
    }
    if (targetLang === '__default__' || toggleSingle) {
      const nextReadings = { ...(readings || {}) }
      for (const ch of picked) delete nextReadings[ch]
      setReadings?.(nextReadings)
    }
    setForced(assignmentList(next))
  }
  const begin = (ch, e) => {
    e.preventDefault()
    draggingRef.current = true
    dragRef.current = [ch]
    setDragging(true)
    setDragChars([ch])
  }
  const enter = (ch) => {
    if (!draggingRef.current || dragRef.current.includes(ch)) return
    dragRef.current = [...dragRef.current, ch]
    setDragChars(dragRef.current)
  }
  const end = useCallback(() => {
    if (!draggingRef.current) return
    const picked = [...dragRef.current]
    draggingRef.current = false
    dragRef.current = []
    setDragging(false)
    setDragChars([])
    applyChars(picked)
  }, [assignments, direction, targetLang]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end) }
  }, [end])
  const assignedChars = chars.filter(ch => assignments[ch])
  const assignedKey = assignedChars.map(ch => `${ch}:${assignments[ch]}`).join('|')
  const [defaults, setDefaults] = useState({}), [defCands, setDefCands] = useState({}), [defLoading, setDefLoading] = useState(false)
  useEffect(() => {
    if (!assignedChars.length) { setDefaults({}); setDefCands({}); return }
    let cancelled = false; setDefLoading(true)
    Promise.all(assignedChars.map(ch => api('/api/pron/preview', { method:'POST', body:{ text:ch, lang:assignments[ch] } }).then(r => ({ch,lang:assignments[ch],r})).catch(() => ({ch,r:null}))))
      .then(results => {
        if (cancelled) return
        const nd={}, nc={}
        for (const {ch,lang,r} of results) {
          if (!r?.ok || !r.data) continue
          const toks=r.data.tokens||[]
          if (lang==='ja') { const reading=toks.map(t=>t.reading||'').join(''); if(reading) nd[ch]=reading }
          else for(const tok of toks) for(const c of (tok.chars||[])) if(c.char===ch){if(c.reading)nd[ch]=c.reading;if(c.candidates?.length)nc[ch]=c.candidates}
        }
        setDefaults(nd); setDefCands(nc)
      }).finally(()=>{if(!cancelled)setDefLoading(false)})
    return()=>{cancelled=true}
  }, [assignedKey]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!direction) return <div className="field-hint">{t('Han-language override applies to Mandarin, Cantonese, Japanese, and Auto targets.', '汉字语言覆盖适用于普通话、粤语、日语与 Auto 目标。')}</div>
  if (!chars.length) return <div className="field-hint">{t('No Han characters in the text yet.', '文本中暂无汉字。')}</div>
  const rd=readings||{}
  const setReading=(ch,val)=>{const next={...rd};if(val.trim())next[ch]=val;else delete next[ch];setReadings?.(next)}
  return <div>
    <div style={{fontSize:12,color:'var(--muted)',marginBottom:8,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
      <span>{t(<>Han characters read as <strong>{LANG_LABEL[direction.base]}</strong> by default. Click or drag across characters to read them as:</>, <>汉字默认按 <strong>{langName(t,direction.base)}</strong> 朗读。点击或按住拖选字符，将其设为：</>)}</span>
      <Select className="control" value={targetLang} onChange={e=>setTargetLang(e.target.value)} style={{height:28,width:180}}>
        <option value="__default__">{t('Default / remove override', '默认 / 取消覆盖')}</option>
        {direction.choices.map(lg=><option key={lg} value={lg}>{langName(t,lg)}</option>)}
      </Select>
    </div>
    <div style={{display:'flex',flexWrap:'wrap',gap:6,userSelect:'none',touchAction:'none'}}>
      {chars.map(ch=>{const lang=assignments[ch];const pending=dragChars.includes(ch);const visual=pending?PENDING_VISUAL:(lang?HAN_VISUAL[lang]:null);return <button key={ch} type="button" className="btn btn-sm"
        onPointerDown={e=>begin(ch,e)} onPointerEnter={()=>enter(ch)}
        title={lang?t(`Reads as ${LANG_LABEL[lang]}; click with the same language or choose Default to remove.`,`按 ${langName(t,lang)} 朗读；使用相同语言单击或选择“默认”可取消。`):t(`Reads as ${LANG_LABEL[direction.base]}`,`按 ${langName(t,direction.base)} 朗读`)}
        style={{minWidth:34,fontSize:16,padding:'4px 8px',background:visual?.background||'var(--surface)',color:visual?.color||'var(--text)',border:`2px ${visual?.borderStyle||'solid'} ${visual?.borderColor||'var(--border)'}`,borderRadius:visual?.borderRadius,clipPath:visual?.clipPath,boxShadow:visual?.boxShadow}}><span style={{fontSize:9,marginRight:3,opacity:lang?1:0.45}}>{lang?lang.toUpperCase():'·'}</span>{ch}</button>})}
    </div>
    {assignedChars.length>0&&<div style={{marginTop:10}}>
      <div style={{fontSize:11,color:'var(--muted)',marginBottom:6}}>{t('Set the reading for each overridden character. Grey text is the engine default; keep it, choose a candidate, or type your own.', '为每个覆盖字符设置读音。灰色为引擎默认读音，可保持不变、选择候选或自行输入。')}</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:10}}>{assignedChars.map(ch=>{const lang=assignments[ch], unit=READING_UNIT[lang], overridden=rd[ch]!==undefined, def=defaults[ch]||'', shown=overridden?rd[ch]:def, pool=[];for(const v of [def,...(defCands[ch]||[]),shown])if(v&&!pool.includes(v))pool.push(v);return <div key={ch} style={{display:'flex',flexDirection:'column',gap:2}}><div style={{display:'flex',alignItems:'center',gap:4}}><span style={{fontSize:15}}>{ch}</span><span style={{fontSize:10,color:'var(--muted)'}}>{lang.toUpperCase()}</span><input className="control" spellCheck={false} style={{height:24,fontSize:12,padding:'0 6px',width:lang==='ja'?96:84,fontStyle:overridden?'normal':'italic',color:overridden?'var(--text)':'var(--muted)'}} value={shown} placeholder={def||unit.placeholder} onChange={e=>setReading(ch,e.target.value)}/>{pool.length>1&&<Select className="control" style={{height:24,fontSize:12,maxWidth:96}} value={pool.includes(shown)?shown:''} onChange={e=>setReading(ch,e.target.value)}>{pool.map(v=><option key={v} value={v}>{v===def?`${v} (default)`:v}</option>)}</Select>}{overridden&&<button type="button" className="btn btn-sm btn-ghost" style={{padding:'0 6px',height:24}} onClick={()=>setReading(ch,'')}>↺</button>}</div><div style={{fontSize:10,color:'var(--muted)',paddingLeft:20}}>{def?<>default: <span style={{fontFamily:'monospace'}}>{def}</span></>:defLoading?'loading default…':'no default reading available'}</div></div>})}</div>
      <div style={{marginTop:8,fontSize:11,color:'var(--accent)',display:'flex',gap:8,alignItems:'center'}}><span>{t(`${assignedChars.length} character(s) overridden`, `已覆盖 ${assignedChars.length} 个字符`)}</span><button className="btn btn-sm btn-ghost" onClick={()=>{setForced([]);setReadings?.({})}}>{t('Clear','清除')}</button></div>
    </div>}
  </div>
}

function HanFinalPreview({ text, direction, forced }) {
  const { t } = useT()
  if (!direction) return null
  const assignments = normalizeAssignments(forced, direction)
  const groups = []
  for (const ch of String(text || '')) {
    const lang = assignments[ch] || direction.base
    const last = groups[groups.length - 1]
    if (last && last.lang === lang) last.text += ch
    else groups.push({ lang, text: ch })
  }
  return <div style={{borderTop:'1px solid var(--border)',paddingTop:12}}>
    <div style={{fontSize:13,fontWeight:600,marginBottom:10}}>{t('Final preview','最终预览')}</div>
    <div style={{display:'flex',flexWrap:'wrap',gap:12,alignItems:'flex-start'}}>
      {groups.map((group,index)=><fieldset key={index} style={{margin:0,minWidth:80,maxWidth:'100%',padding:'8px 12px 10px',border:`2px solid ${HAN_VISUAL[group.lang]?.borderColor||'var(--border)'}`,borderRadius:10,background:'var(--surface)'}}>
        <legend style={{padding:'0 6px',fontSize:11,fontWeight:700,color:HAN_VISUAL[group.lang]?.borderColor||'var(--text)'}}>{group.lang.toUpperCase()}</legend>
        <span style={{whiteSpace:'pre-wrap',lineHeight:1.7}}>{group.text}</span>
      </fieldset>)}
    </div>
  </div>
}

// One modal that houses BOTH the per-character language picker and reading
// proofing, so the page keeps only a compact trigger button (no tall panels).
function TextPrepModal({ onClose, text, setText, panelLang, pronOverrides, setPronOverrides, hanDirection, hanForced, setHanForced, hanReadings, setHanReadings }) {
  const { t } = useT()
  // Characters forced to the reverse language are read in that language, so the
  // Chinese/Cantonese reading proofing below does not apply to them (they are
  // muted there). Their reading is set in the Han character language section.
  const forcedInText = (hanDirection && hanForced && hanForced.length)
    ? distinctHanChars(text).filter(ch => normalizeAssignments(hanForced, hanDirection)[ch])
    : []
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 1180, width: '94%' }}>
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
                  `${forcedInText.join(' ')} ${forcedInText.length > 1 ? 'are' : 'is'} assigned to another Han language; the ${LANG_LABEL[panelLang] || panelLang} reading below does not apply. Set the reading in the Han character language section above.`,
                  `${forcedInText.join(' ')} 已分配给另一种汉字语言；下方的 ${langName(t, panelLang)} 读音不生效。请在上方“汉字语言”区设置读音。`,
                )}
              </div>
            )}
            <PronPanel
              text={text} setText={setText} lang={panelLang}
              overrides={pronOverrides} setOverrides={setPronOverrides} layout="wide"
              mutedChars={forcedInText}
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
  LANG_LABEL,
}
