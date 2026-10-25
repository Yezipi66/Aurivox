// 读音校对：文本编辑、逐字逐词读音预览与人工改读音，都在这个面板里。
// 读音由当前选中的那台引擎给出（g2pW），面板不自己算。
import { useState, useEffect, useCallback, useRef } from 'react'
import { Select } from '../common/Select'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { mutedTokenPositions, previewTokenStarts, previewTokenText } from '../../lib/pronTokenPositions'
import { NO_ENGINE_MSG, nestedOverrides, countOverrides, langName } from './PronProofing'

// 读音校对网格的显示辅助
// 标点没有可编辑的读音，用淡色字形内联占位（不做成卡片），
// 既保住朗读顺序，又不把网格弄花。
const PUNCT_RE = /^[\s\p{P}\p{S}]+$/u
// 每种语言一个小圆点加短代码，替掉反复出现的大写语种名，
// 混合语种的行一眼就能分辨。
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

// 读音校对面板：勾选后展开的二级面板，兼作文本编辑器与逐字读音校对。
// 中文（zh）与粤语（yue）走真实 g2pW 预览；其它语言是契约占位（ko 未经测试）。
// 后端 /api/pron/preview 的 engine_id 必传（lib/routes/pron.js 的 preview 路由），
// 不传直接 400 PRON_ENGINE_ID_MISSING。
// 组件的 props：text / setText（被编辑的文本）、lang（语种）、overrides / setOverrides（读音覆盖，
// 按语言分桶）、layout（wide 或默认）、mutedPositions 与 mutedLangByPosition（已交给别的语言朗读的位置），
// 以及 engineId（读音预览要用哪台引擎）。
// 不让后端挑一台兜底的理由：判据在 lib/inference/infer_server.py 的 pron_preview 注释，
// 「复用引擎已加载的 g2pW，保证预览读音 == 实际合成读音」。
// 换一台引擎去预览，读出来可能也对，但它回答的不是当前选中那台引擎的读音。
// 给一个看起来对、与实际合成不一致、又不报错的读音，比没有这个功能更坏。
// engineId 缺席时这个面板主动灰掉并说清原因，不发那个必定 400 的请求（发了用户只会看到一句英文报错，不知道该去哪儿改）。
function PronPanel({ text, setText, lang, overrides, setOverrides, layout, mutedPositions, mutedLangLabel, mutedLangByPosition, engineId }) {
  const { t } = useT()
  const wide = layout === 'wide'
  const mutePositionSet = mutedPositions instanceof Set ? mutedPositions : new Set(mutedPositions || [])
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // 词典按语言存储 {lang: entries}（混合文本可能涉及多种语言）。
  const [lexicons, setLexicons] = useState({})
  // 逐词编辑缓冲（ja 假名 / en ARPABET），键含 segLang 以避免跨语言同形词冲突。
  const [wordEdits, setWordEdits] = useState({})
  // en「谐音改写」输入缓冲：{word -> 另一个英文词}。
  const [respellEdits, setRespellEdits] = useState({})
  // en 每个 token 的「候选 / 谐音」详情默认收起，键为 token 索引，避免纵向拥挤。
  const [openDetail, setOpenDetail] = useState({})
  // 覆盖始终按语言分桶；旧的扁平形态自动归入面板基础语系。
  const nested = nestedOverrides(overrides, lang)
  // zh/yue：逐字选候选；ja：逐词改假名；en：逐词改音标；其它语言契约占位。
  // auto 是真正的多语种校对模式：引擎预览端点把响应切成 ZH/JA/EN/KO 若干 token，
  // 不是占位。
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
    if (!engineId) { setError(NO_ENGINE_MSG(t)); return }
    setLoading(true)
    try {
      const r = await api('/api/pron/preview', { method: 'POST', body: { text, lang, engine_id: engineId } })
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

  // 改单个字的读音：记成该语言的词级覆盖。
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

  // en 的覆盖按每次出现分别记：bucket[word] 是 { "<occ>": [读音], "*": [读音] }，
  // "*" 表示词级默认值；ja/zh 仍是列表形态。
  // 老式的列表在第一次按次编辑时自动迁移成 { "*": 列表 }。
  const editKey = (segLang, word, occ) => `${segLang}::${word}::${occ ?? ''}`
  // 某一次出现当前显示的读音：先看覆盖，没有才用回退值。
  const enReadingFor = (bWord, occ, fallback) => {
    if (Array.isArray(bWord)) return bWord                          // 老式的词级列表
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

  // 词级编辑：ja 逐词，en 逐次出现。
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
        if (Array.isArray(cur)) cur = { '*': cur }   // 老式列表迁移成词级默认值
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
      if (perOccurrence && occ != null && tk.occ !== occ) return tk          // 只改这一次出现
      return isEn ? { ...tk, readings: arr, source: arr.length ? 'override' : 'g2p' }
                  : { ...tk, reading: arr[0] || '', source: arr.length ? 'override' : 'g2p' }
    }) }))
  }

  // 谐音改写：用另一个英文词的读音替换本词的这一次出现（复用 /pron/preview）。
  const respellEn = async (word, occ) => {
    const src = String(respellEdits[editKey('en', word, occ)] || '').trim()
    if (!src) return
    if (!engineId) { setError(NO_ENGINE_MSG(t)); return }
    try {
      const r = await api('/api/pron/preview', { method: 'POST', body: { text: src, lang: 'en', engine_id: engineId } })
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
  // 每个英文词出现了几次（只有重复出现时才显示 #n 角标）。
  const enWordCounts = {}
  const koWordCounts = {}
  for (const tk of (preview?.tokens || [])) {
    if (tk.segLang === 'en' && tk.unit === 'word') enWordCounts[tk.word] = (enWordCounts[tk.word] || 0) + 1
    if (tk.segLang === 'ko' && tk.unit === 'word') koWordCounts[tk.word] = (koWordCounts[tk.word] || 0) + 1
  }
  // 老引擎返回的预览不带偏移。逐个 token 按编辑器原文单调对齐，
  // 这样静音始终按位置算，重复的汉字也不会算成全局字符集。
  const tokenStarts = previewTokenStarts(text, preview?.tokens || [])

  return (
    <div className={`section pron-panel${wide ? ' pron-panel-wide' : ''}`} style={{ margin: '8px 0', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div className="pron-grid">
      <div className="pron-edit">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600 }}>{t('Reading proofing', '读音校对')}</span>
        <span style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>
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
            <span style={{ fontSize: 'var(--fs-11)', color: 'var(--accent)' }}>{t(`${overrideCount} override(s) active this run`, `本次生效 ${overrideCount} 处自定义读音`)}</span>
            <button className="btn btn-sm btn-ghost" onClick={clearOverrides}>{t('Clear overrides', '清除自定义读音')}</button>
          </>
        )}
      </div>

      {showNorm && (
        <div className="field-hint" style={{ marginTop: 6, fontSize: 'var(--fs-11)' }}>
          {t('Normalized text (readings are derived from this):', '规范化文本（读音基于此推导）：')}
          <span style={{ color: 'var(--text)' }}> {preview.norm_text}</span>
        </div>
      )}

      {error && <div className="msg msg-error" style={{ marginTop: 6 }}>{error}</div>}
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
            // 一个词形 token 里可能含汉字，即使预览端点把整个词判成日语（例如
            // 今日 -> JA）。是否已被汉字语言区接管，要看源文本位置，
            // 不能看预览给出的语种。
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
                  <span style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', letterSpacing: 0.4 }}>{SEG_SHORT[seg] || String(seg).toUpperCase()}</span>
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
                        <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }} title={t('This character is set to read in another language; correct its reading in the Han character language section.', '该字已设为按另一种语言朗读；请在“汉字语言”区修改其读音。')}>
                          {'\u2192'} {mutedLang ? langName(t, mutedLang) : (mutedLangLabel || t('other', '其它'))}
                        </div>
                      ) : c.polyphonic && c.candidates.length > 1 ? (
                        <Select
                          className="control" style={{ height: 22, fontSize: 'var(--fs-11)', padding: '0 2px', minWidth: 54 }}
                          value={c.reading}
                          onChange={e => changeReading(seg, tok.word, ci, e.target.value)}
                        >
                          {(c.candidates.includes(c.reading) ? c.candidates : [c.reading, ...c.candidates]).map(cand => (
                            <option key={cand} value={cand}>{cand}</option>
                          ))}
                        </Select>
                      ) : (
                        <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>{c.reading}</div>
                      )}
                    </div>
                    )
                  })}
                </div>
              ) : (
                // ja / en：逐词，直接改写读音（假名 / ARPABET）。en 的候选下拉与谐音改写默认收起，
                // 由展开按钮展开，避免纵向拥挤；en 每次出现独立可改，同一词第 1/2/3 次互不影响。
                <div className={isKo ? 'ko-reading-grid' : undefined} style={{ textAlign: isKo ? 'left' : 'center', minWidth: 0, ...(isKo ? { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 } : {}) }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 15, color: (isEn ? !overridden : tok.source === 'g2p') ? 'var(--text)' : 'var(--accent)' }}>
                    <span style={{ overflowWrap: 'anywhere' }}>{tok.word}
                      {repeated && <sup style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', marginLeft: 2 }} title={t('occurrence number', '第几次出现')}>#{occ + 1}</sup>}
                    </span>
                    {isEn && (
                      <button type="button" className="btn btn-sm btn-ghost" disabled={tokenMuted}
                        style={{ padding: '0 4px', height: 18, fontSize: 'var(--fs-11)', lineHeight: 1, color: openDetail[ti] ? 'var(--accent)' : 'var(--muted)' }}
                        title={tokenMuted ? tokenMutedTip : t('More reading options (dictionary candidates / sounds-like)', '更多读音选项（词典候选 / 谐音改写）')}
                        onClick={() => setOpenDetail(d => ({ ...d, [ti]: !d[ti] }))}
                      >{'\u270e'}</button>
                    )}
                  </div>
                  <input
                    className="control"
                    disabled={enHasRespell || tokenInactive}
                    title={tokenMuted ? tokenMutedTip : respellTip || (koDimmed ? t('Turn on “Show all Korean words” above to edit this reading.', '请先开启“显示全部韩语词”再编辑这个读音。') : undefined)}
                    style={{ height: 24, fontSize: 'var(--fs-12)', padding: '0 6px', width: '100%', boxSizing: 'border-box', marginTop: 3,
                      ...(enHasRespell || tokenInactive ? { color: 'var(--muted)', fontStyle: 'italic', opacity: 0.7 } : {}) }}
                    value={isEn
                      ? (wordEdits[editKey('en', tok.word, occ)] ?? enVal)
                      : isKo ? (wordEdits[editKey('ko', tok.word, occ)] ?? koVal)
                      : (wordEdits[editKey(seg, tok.word)] ?? (bucket[tok.word] ? bucket[tok.word].join(' ') : (tok.reading || '')))}
                    placeholder={readingUnit(seg)}
                    spellCheck={false}
                    onChange={e => changeWordReading(seg, tok.word, occ, e.target.value)}
                  />
                  {isKo && tok.editable && <div style={{marginTop:4}}><button type="button" className="btn btn-sm btn-ghost" disabled={tokenInactive} title={tokenMuted ? tokenMutedTip : koDimmed ? t('Turn on “Show all Korean words” above to inspect this word.', '请先开启上方“显示全部韩语词”再查看这个词。') : undefined} onClick={()=>setExpandedKo(x=>({...x,[ti]:!x[ti]}))}>{expandedKo[ti]?t('Hide syllables','收起音节'):t('Expand syllables','展开音节')}</button>{tok.unresolved&&<span style={{fontSize: 'var(--fs-11)',color:'var(--danger)',marginLeft:6}}>{t('Unresolved','未解析')}</span>}{expandedKo[ti]&&<div style={{display:'flex',gap:5,flexWrap:'wrap',marginTop:5}}>{(tok.syllables||[]).map((sy,i)=><div key={i} style={{border:`1px solid ${sy.changed?'var(--warning)':'var(--border)'}`,borderRadius:4,padding:'3px 6px',textAlign:'center'}}><div>{sy.written||'·'}</div><div style={{fontSize: 'var(--fs-11)',color:sy.changed?'var(--warning)':'var(--muted)'}}>{sy.spoken||'?'}</div></div>)}</div>}</div>}
                  {isEn && openDetail[ti] && (
                    <>
                      {(tok.candidates || []).length > 0 && (
                        <Select
                          className="control" disabled={enHasRespell || tokenMuted}
                          style={{ height: 22, fontSize: 'var(--fs-11)', padding: '0 2px', width: '100%', boxSizing: 'border-box', marginTop: 3,
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
                        style={{ height: 22, fontSize: 'var(--fs-11)', padding: '0 6px', width: '100%', boxSizing: 'border-box', marginTop: 3,
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
                <button className="btn btn-sm btn-ghost" style={{ marginTop: 4, fontSize: 'var(--fs-11)' }} onClick={() => saveToLexicon(seg, tok.word, occ)}>
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
              <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', marginBottom: 4 }}>{t(`Saved lexicon (${lg}):`, `已保存词典（${lg}）：`)}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Object.entries(entries).map(([w, pys]) => (
                  <span key={w} style={{ fontSize: 'var(--fs-11)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {w}: {pys.join(' ')}
                    <button className="btn btn-sm btn-ghost" style={{ padding: 0, fontSize: 'var(--fs-12)', lineHeight: 1 }} onClick={() => deleteFromLexicon(lg, w)}>x</button>
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

export { PronPanel }
