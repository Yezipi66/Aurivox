import { useState, useEffect, useCallback, useRef } from 'react'
import { Select } from '../common/Select'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { inferAutoHanLanguages } from '../../lib/autoLanguage'
import {
  HAN_RE,
  HAN_LANGS,
  LANG_LABEL,
  READING_UNIT,
  applyHanRange,
  assignmentAt,
  assignmentList,
  hanPositions,
  normalizeAssignments,
  readingKey,
} from '../../lib/hanLanguage'
import { NO_ENGINE_MSG, langName } from './PronProofing'

// 汉字按位置指定语种与读音：框选汉字定语种，逐字校对读音，最后预览分段结果。
// 覆盖以「位置」为键而不是「字」为键：同一个汉字可能出现多次，每次的语种与读音可以不同。
// 读音由当前选中的那台引擎给出（/api/pron/preview 必带 engine_id），本文件不自己算。
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

// 校对被显式指定过的汉字：调 /api/pron/preview 取回读音，写进按位置索引的
// han_readings 负载。自动判定的汉字不在这里出现。
function HanReadingReview({ text, direction, assignments, readings, setReadings, engineId }) {
  const { t } = useT()
  const selected = assignmentList(assignments, text)
  // engineId 进签名：换一台引擎就是换一套 g2p，这一批建议读音必须重新问。
  // 把它从签名里移除，换引擎后界面会一直显示上一台引擎给的读音。
  const selectionSignature = selected.map(item => `${readingKey(item)}=${item.lang}`).join('|') + `#${engineId || ''}`
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

    // 丢掉已取消选中的位置的读音；仍被选中的位置保留人工填写的值。
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
        // engine_id 必传：缺了不发。engineId 已经进了依赖签名，选上引擎之后
        // 这一批会自己重来。
        if (!engineId) return [key, { reading: '', candidates: [], loading: false, error: NO_ENGINE_MSG(t) }]
        const r = await api('/api/pron/preview', {
          method: 'POST',
          body: { text: item.char, lang: item.lang, engine_id: engineId },
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
    }).catch(err => console.error("[HanReadingReview] 预览请求失败:", err))

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
        {t('Only explicitly selected positions appear here. Characters left on automatic inference stay unlit and are reviewed below.', '这里只显示用户明确框选的位置。保持自动判定的汉字不会高亮显示，继续在下方“读音校对”中处理。')}
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

function HanLangPicker({ text, direction, forced, setForced, readings, setReadings, onDragState, engineId }) {
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

  // 有色方块只表示「这里有手动指定」。自动判定刻意不着色。
  // 手势是整段切换：整段都已经是 target 就清掉整段，否则把 target 加到整段上。
  // 这样重叠选择是叠加的：「这是一段」再选「一段测试」得到「这是一段测试」。
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
      <HanReadingReview text={text} direction={direction} assignments={map} readings={readings || {}} setReadings={setReadings} engineId={engineId} />
    </div>
  )
}

function charLang(ch, direction, assignments, index, inferredHan) {
  // 手动指定只对汉字有意义。这里查的是字符本身而不是位置：位置可能因文本被编辑而错位，
  // 落到假名或拉丁字母上的汉字语种指定没有意义。引擎那侧同样按这条规则丢弃
  // （引擎源码 TextPreprocessor.py 的 _apply_lang_overrides）。
  const positional = HAN_RE.test(ch) ? assignments?.[index] : undefined
  if (positional) return positional
  if (/[\uac00-\ud7a3]/.test(ch)) return 'ko'
  if (/[A-Za-z]/.test(ch)) return 'en'
  if (/[\u3040-\u30ff]/.test(ch)) return 'ja'
  if (HAN_RE.test(ch)) return inferredHan?.[index] || (direction?.base && HAN_LANGS.includes(direction.base) ? direction.base : 'zh')
  return null
}

const SEG_COLORS = { zh: '#3fb98f', yue: '#3fb98f', ja: '#e0a26a', en: '#6fa8dc', ko: '#c08bd6' }

function HanFinalPreview({ text, direction, forced }) {
  const { t } = useT(); const assignments = normalizeAssignments(forced, direction, text); const groups=[]
  const inferredHan=direction?.autoMode?inferAutoHanLanguages(text,direction.base,assignments):{}
  let previous='zh'
  Array.from(String(text||'')).forEach((ch,index)=>{const detected=charLang(ch,direction,assignments,index,inferredHan);const lang=detected||previous;previous=lang;const last=groups[groups.length-1];if(last&&last.lang===lang)last.text+=ch;else groups.push({lang,text:ch})})
  return <div style={{borderTop:'1px solid var(--border)',paddingTop:12}}><div style={{fontSize:13,fontWeight:600,marginBottom:10}}>{t('Final preview','最终预览')}</div><div style={{display:'flex',flexWrap:'wrap',gap:12}}>{groups.map((g,i)=><fieldset key={i} style={{margin:0,padding:'8px 12px',border:`2px solid ${SEG_COLORS[g.lang]||'var(--border)'}`,borderRadius:10}}><legend>{g.lang.toUpperCase()}</legend><span style={{whiteSpace:'pre-wrap'}}>{g.text}</span></fieldset>)}</div></div>
}

export { HanReadingReview, HanLangPicker, HanFinalPreview }
