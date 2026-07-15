// Reading-proofing / multilingual module. Extracted verbatim from App.jsx (no logic change).
import { useState, useEffect, useCallback } from 'react'
import { api } from '../../lib/api'

// 读音校对面板（task6）：勾选后展开的二级面板，兼作文本编辑器 + 逐字读音校对。
// 中文(zh)/粤语(yue) 走真实 g2pW 预览；其它语言为契约占位（ko 未经测试）。
function PronPanel({ text, setText, lang, overrides, setOverrides, layout, mutedChars, mutedLangLabel }) {
  const wide = layout === 'wide'
  const muteSet = mutedChars instanceof Set ? mutedChars : new Set(mutedChars || [])
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lexicon, setLexicon] = useState({})
  // 逐词编辑缓冲（ja 假名 / en ARPABET）：保留用户正在输入的原始字符串，避免受控输入吞空格。
  const [wordEdits, setWordEdits] = useState({})
  // zh/yue：逐字选候选；ja：逐词改假名；en：逐词改音标；其它语言契约占位。
  const supported = lang === 'zh' || lang === 'yue' || lang === 'ja' || lang === 'en'
  const isCharUnit = lang === 'zh' || lang === 'yue'
  const readingLabel = lang === 'ja' ? 'kana' : lang === 'en' ? 'ARPABET (space-separated)' : 'reading'

  const loadLexicon = useCallback(() => {
    if (!supported) return
    api(`/api/pron/lexicon?lang=${encodeURIComponent(lang)}`).then(r => {
      if (r.ok && r.data?.entries) setLexicon(r.data.entries)
    }).catch(() => {})
  }, [lang, supported])

  useEffect(() => { loadLexicon() }, [loadLexicon])

  const doPreview = async () => {
    setError(null); setPreview(null); setWordEdits({})
    if (!text.trim()) { setError('Enter text above first.'); return }
    if (!supported) { setError(`Reading proofing does not support "${lang}" yet.`); return }
    setLoading(true)
    try {
      const r = await api('/api/pron/preview', { method: 'POST', body: { text, lang } })
      if (!r.ok) throw new Error(r.data?.error || `Preview failed (${r.status})`)
      setPreview(r.data)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  // Change a single character's reading -> record a word-level override.
  const changeReading = (word, charIndex, newReading) => {
    const token = (preview?.tokens || []).find(t => t.word === word)
    if (!token) return
    const readings = token.chars.map((c, i) => i === charIndex ? newReading : (overrides[word]?.[i] ?? c.reading))
    setOverrides({ ...overrides, [word]: readings })
    setPreview(pv => ({ ...pv, tokens: pv.tokens.map(t => t.word === word
      ? { ...t, chars: t.chars.map((c, i) => i === charIndex ? { ...c, reading: newReading, source: 'override' } : c) }
      : t) }))
  }

  // Word-level edit (ja kana / en ARPABET). Stores a word-level override.
  const changeWordReading = (word, str) => {
    setWordEdits(e => ({ ...e, [word]: str }))
    const arr = lang === 'en'
      ? str.trim().split(/\s+/).filter(Boolean)
      : (str.trim() ? [str.trim()] : [])
    const next = { ...overrides }
    if (arr.length) next[word] = arr; else delete next[word]
    setOverrides(next)
    setPreview(pv => ({ ...pv, tokens: pv.tokens.map(t => t.word === word
      ? (lang === 'en' ? { ...t, readings: arr, source: arr.length ? 'override' : 'g2p' }
                       : { ...t, reading: arr[0] || '', source: arr.length ? 'override' : 'g2p' })
      : t) }))
  }

  const saveToLexicon = async (word) => {
    let readings = overrides[word]
    if (!readings) {
      const tok = preview?.tokens.find(t => t.word === word)
      if (!tok) return
      if (tok.unit === 'char') readings = tok.chars.map(c => c.reading)
      else if (lang === 'en') readings = tok.readings
      else readings = [tok.reading]
    }
    if (!readings) return
    const r = await api('/api/pron/lexicon', { method: 'POST', body: { lang, word, pinyins: readings } })
    if (r.ok) { setLexicon(r.data.entries || {}) }
    else setError(r.data?.error || 'Failed to save to lexicon')
  }

  const deleteFromLexicon = async (word) => {
    const r = await api(`/api/pron/lexicon?lang=${encodeURIComponent(lang)}&word=${encodeURIComponent(word)}`, { method: 'DELETE' })
    if (r.ok) setLexicon(r.data.entries || {})
  }

  const clearOverrides = () => { setOverrides({}); if (preview) doPreview() }

  return (
    <div className={`section pron-panel${wide ? ' pron-panel-wide' : ''}`} style={{ margin: '8px 0', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div className="pron-grid">
      <div className="pron-edit">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Reading proofing</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {!supported ? `Language "${lang}" is contract-only for now.`
            : isCharUnit ? 'Edit text, preview readings, fix polyphonic characters.'
            : lang === 'ja' ? 'Edit text, preview readings, fix a word\u2019s kana reading.'
            : 'Edit text, preview readings, fix a word\u2019s ARPABET phonemes.'}
        </span>
      </div>

      <textarea
        className="control" rows={3} placeholder="Edit the text to synthesize here..."
        value={text} onChange={e => setText(e.target.value)}
        style={{ marginBottom: 8 }}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-sm" onClick={doPreview} disabled={loading || !supported}>
          {loading ? 'Previewing...' : 'Preview readings'}
        </button>
        {Object.keys(overrides).length > 0 && (
          <>
            <span style={{ fontSize: 11, color: 'var(--accent)' }}>{Object.keys(overrides).length} override(s) active this run</span>
            <button className="btn btn-sm btn-ghost" onClick={clearOverrides}>Clear overrides</button>
          </>
        )}
      </div>

      {error && <div className="field-hint" style={{ color: 'var(--danger)', marginTop: 6 }}>{error}</div>}
      </div>{/* .pron-edit */}
      <div className="pron-out">
      {preview && supported && (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(preview.tokens || []).map((tok, ti) => (
            <div key={ti} style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', background: 'var(--surface)' }}>
              {(tok.unit === 'char' || tok.chars) ? (
                // zh / yue：逐字，多音字给候选下拉
                <div style={{ display: 'flex', gap: 4 }}>
                  {tok.chars.map((c, ci) => {
                    const muted = muteSet.has(c.char)
                    return (
                    <div key={ci} style={{ textAlign: 'center', opacity: muted ? 0.45 : 1 }}>
                      <div style={{ fontSize: 15, color: muted ? 'var(--muted)' : (c.polyphonic ? 'var(--warning)' : 'var(--text)') }}>{c.char}</div>
                      {muted ? (
                        <div style={{ fontSize: 10, color: 'var(--muted)' }} title="This character is set to read in another language; correct its reading in the Han character language section.">
                          {'\u2192'} {mutedLangLabel || 'other'}
                        </div>
                      ) : c.polyphonic && c.candidates.length > 1 ? (
                        <select
                          className="control" style={{ height: 22, fontSize: 11, padding: '0 2px', minWidth: 54 }}
                          value={c.reading}
                          onChange={e => changeReading(tok.word, ci, e.target.value)}
                        >
                          {(c.candidates.includes(c.reading) ? c.candidates : [c.reading, ...c.candidates]).map(cand => (
                            <option key={cand} value={cand}>{cand}</option>
                          ))}
                        </select>
                      ) : (
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.reading}</div>
                      )}
                    </div>
                    )
                  })}
                </div>
              ) : (
                // ja / en：逐词，直接改写读音（假名 / ARPABET），无候选下拉，输入框做宽
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 15, color: tok.source === 'g2p' ? 'var(--text)' : 'var(--accent)' }}>{tok.word}</div>
                  <input
                    className="control"
                    style={{ height: 24, fontSize: 12, padding: '0 6px', minWidth: lang === 'en' ? 180 : 120 }}
                    value={wordEdits[tok.word] ?? (
                      overrides[tok.word]
                        ? overrides[tok.word].join(' ')
                        : (lang === 'en' ? (tok.readings || []).join(' ') : (tok.reading || ''))
                    )}
                    placeholder={readingLabel}
                    spellCheck={false}
                    onChange={e => changeWordReading(tok.word, e.target.value)}
                  />
                </div>
              )}
              {overrides[tok.word] && (
                <button className="btn btn-sm btn-ghost" style={{ marginTop: 4, fontSize: 10 }} onClick={() => saveToLexicon(tok.word)}>
                  Save to lexicon
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {supported && Object.keys(lexicon).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Saved lexicon ({lang}):</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.entries(lexicon).map(([w, pys]) => (
              <span key={w} style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 12, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {w}: {pys.join(' ')}
                <button className="btn btn-sm btn-ghost" style={{ padding: 0, fontSize: 12, lineHeight: 1 }} onClick={() => deleteFromLexicon(w)}>x</button>
              </span>
            ))}
          </div>
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

// Merge base-language reading proofing with the reverse-language readings of the
// forced Han characters into the engine's pron_overrides payload.
//   * No forced readings -> return the flat base overrides unchanged (zero regression).
//   * With forced readings -> nested {lang: {word: [readings]}} form, which the
//     backend already understands (base bucket + reverse bucket per forced char).
function buildPronPayload(pronOverrides, baseLang, direction, forced, readings) {
  const base = pronOverrides && Object.keys(pronOverrides).length > 0 ? pronOverrides : null
  const reverseBucket = {}
  if (direction && forced && forced.length && readings) {
    const forcedSet = new Set(forced)
    for (const ch of Object.keys(readings)) {
      const r = String(readings[ch] || '').trim()
      if (r && forcedSet.has(ch)) reverseBucket[ch] = [r]
    }
  }
  const hasReverse = Object.keys(reverseBucket).length > 0
  if (!hasReverse) return base || undefined
  const out = {}
  if (base) out[baseLang] = base
  out[direction.reverse] = { ...(out[direction.reverse] || {}), ...reverseBucket }
  return out
}

function HanLangPicker({ text, direction, forced, setForced, readings, setReadings }) {
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
      Per-character language override applies to Chinese / Cantonese / Japanese targets only.
    </div>
  }
  if (chars.length === 0) {
    return <div className="field-hint" style={{ color: 'var(--muted)' }}>No Han characters in the text yet.</div>
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
        Han characters read as <strong>{LANG_LABEL[direction.base]}</strong> by default. Click a character to force it to read as <strong>{LANG_LABEL[direction.reverse]}</strong>.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {chars.map(ch => {
          const on = forcedSet.has(ch)
          return (
            <button
              key={ch} type="button" onClick={() => toggle(ch)} className="btn btn-sm"
              title={on ? `Reads as ${LANG_LABEL[direction.reverse]}` : `Reads as ${LANG_LABEL[direction.base]}`}
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
            {LANG_LABEL[direction.reverse]} reading ({unit.label}) for each forced character.
            The engine default is shown in grey{defLoading ? ' (loading\u2026)' : ''} \u2014 keep it as-is,
            pick another reading, or type your own. Han characters have multiple readings
            (e.g. Japanese kun\u2019yomi / on\u2019yomi).
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
                      title={overridden ? 'Custom reading (overrides the engine default)'
                                        : (def ? 'Engine default reading' : '')}
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
                      <select
                        className="control" title="Pick a reading"
                        style={{ height: 24, fontSize: 12, maxWidth: 96 }}
                        value={pool.includes(shown) ? shown : ''}
                        onChange={e => setReading(ch, e.target.value)}
                      >
                        {pool.map(cd => (
                          <option key={cd} value={cd}>{cd === def ? `${cd} (default)` : cd}</option>
                        ))}
                      </select>
                    )}
                    {overridden && (
                      <button
                        type="button" className="btn btn-sm btn-ghost"
                        title="Reset to the engine default reading"
                        style={{ padding: '0 6px', height: 24 }}
                        onClick={() => setReading(ch, '')}
                      >{'\u21ba'}</button>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', paddingLeft: 20 }}>
                    {def
                      ? <>default: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{def}</span></>
                      : defLoading ? 'loading default\u2026' : 'no default reading available'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {forcedSet.size > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{forcedSet.size} character(s) forced to {LANG_LABEL[direction.reverse]}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => { setForced([]); setReadings && setReadings({}) }}>Clear</button>
        </div>
      )}
    </div>
  )
}

// One modal that houses BOTH the per-character language picker and reading
// proofing, so the page keeps only a compact trigger button (no tall panels).
function TextPrepModal({ onClose, text, setText, panelLang, pronOverrides, setPronOverrides, hanDirection, hanForced, setHanForced, hanReadings, setHanReadings }) {
  // Characters forced to the reverse language are read in that language, so the
  // Chinese/Cantonese reading proofing below does not apply to them (they are
  // muted there). Their reading is set in the Han character language section.
  const forcedInText = (hanDirection && hanForced && hanForced.length)
    ? distinctHanChars(text).filter(ch => hanForced.includes(ch))
    : []
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 780, width: '92%' }}>
        <div className="modal-hdr">Text preparation</div>
        <div className="modal-body">
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Han character language</div>
            <HanLangPicker text={text} direction={hanDirection} forced={hanForced} setForced={setHanForced} readings={hanReadings} setReadings={setHanReadings} />
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Reading proofing</div>
            {forcedInText.length > 0 && (
              <div className="field-hint" style={{ color: 'var(--warning)', marginBottom: 8 }}>
                {forcedInText.join(' ')} {forcedInText.length > 1 ? 'are' : 'is'} set to read as {LANG_LABEL[hanDirection.reverse]}; the {LANG_LABEL[panelLang] || panelLang} reading below does not apply to {forcedInText.length > 1 ? 'them' : 'it'}. Set {forcedInText.length > 1 ? 'their' : 'its'} reading in the Han character language section above.
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
          <button className="btn" onClick={onClose}>Done</button>
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
  LANG_LABEL,
}
