// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { AudioPlayer } from './Player'
import { REF_MAX_SEC, REF_MIN_SEC, refInRange } from '../../lib/format'

// prompt_lang（参考音频语言）选项，裸码，与音色 language 字段一致。
const REF_PROMPT_LANG_OPTIONS = [
  { value: 'ja', label: 'Japanese (\u65e5\u672c\u8a9e)' },
  { value: 'zh', label: 'Chinese (\u4e2d\u6587)' },
  { value: 'en', label: 'English' },
  { value: 'yue', label: 'Cantonese (\u7ca4\u8bed)' },
  { value: 'ko', label: 'Korean (\ud55c\uad6d\uc5b4)' },
]

// 跨资产参考音频选择器：列出「其他音色」并读取其全部 slices/raw，点选即用。
// 复用现有 /api/assets/<id>/segments + /raw-list。onPick(path, text)。
// 独立组件，便于后续 Compare Refs 页复用（预留接口）。
function CrossRefPicker({ voices, currentVoiceId, onPick, activeRef }) {
  const others = (voices || []).filter(v => v.id !== currentVoiceId)
  const [vid, setVid] = useState(others[0]?.id || '')
  const [segs, setSegs] = useState(null)
  const [raws, setRaws] = useState(null)
  const [loading, setLoading] = useState(false)
  const [rawDur, setRawDur] = useState({})

  useEffect(() => {
    if (others.length && !others.find(o => o.id === vid)) setVid(others[0].id)
  }, [currentVoiceId])   // eslint-disable-line

  useEffect(() => {
    if (!vid) { setSegs([]); setRaws([]); return }
    setLoading(true); setRawDur({})
    Promise.all([
      api(`/api/assets/${vid}/segments`)
        .then(r => setSegs(r.ok && r.data.segments ? (r.data.segments.segments || []) : []))
        .catch(() => setSegs([])),
      api(`/api/assets/${vid}/raw-list`)
        .then(r => setRaws(r.ok && r.data.raw ? r.data.raw : []))
        .catch(() => setRaws([])),
    ]).finally(() => setLoading(false))
  }, [vid])

  if (others.length === 0) return <div className="field-hint">No other voices available.</div>

  const [refTab, setRefTab] = useState('slices') // 'slices' | 'raw'
  useEffect(() => { setRefTab('slices') }, [vid])

  const availSlices = Array.isArray(segs) ? segs.filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename)) : []
  const availRaw = Array.isArray(raws) ? raws : []
  const pickSlice = (seg) => {
    const p = seg.audio || seg.audio_path || seg.audio_filename
    const fn = p ? p.replace(/\\/g, '/').split('/').pop() : ''
    if (fn) onPick(`assets/${vid}/slicer_opt/${fn}`, seg.text || '')
  }
  const pickRaw = (rf) => onPick(`assets/${vid}/raw/${rf.filename}`, rf.text || '')

  return (
    <div>
      <select className="control" value={vid} onChange={e => setVid(e.target.value)} style={{ marginBottom: 6 }}>
        {others.map(o => <option key={o.id} value={o.id}>{o.display_name} ({o.language || '?'})</option>)}
      </select>
      <div className="field-hint" style={{ color: 'var(--warning)', marginBottom: 6 }}>
        Cross-voice reference &mdash; timbre and quality may differ from this model.
      </div>
      <div className="ref-tabs">
        <span className={`ref-tab ${refTab === 'slices' ? 'active' : ''}`}
              onClick={() => setRefTab('slices')}>
          Slices {availSlices.length > 0 && <span className="ref-tab-count">{availSlices.length}</span>}
        </span>
        <span className={`ref-tab ${refTab === 'raw' ? 'active' : ''}`}
              onClick={() => setRefTab('raw')}>
          Raw {availRaw.length > 0 && <span className="ref-tab-count">{availRaw.length}</span>}
        </span>
      </div>
      {loading && <div className="field-hint">Loading reference audio&hellip;</div>}
      {!loading && (
        <div className="ref-list">
          {refTab === 'slices' && availSlices.length === 0 && refTab === 'raw' && availRaw.length === 0 && <div className="ref-col-empty">No reference audio in this voice</div>}
          {refTab === 'slices' && availSlices.length === 0 && <div className="ref-col-empty">No slices in this voice</div>}
          {refTab === 'raw' && availRaw.length === 0 && <div className="ref-col-empty">No raw audio in this voice</div>}
          {refTab === 'slices' && availSlices.map((seg, i) => {
            const p = seg.audio || seg.audio_path || seg.audio_filename
            const fn = p ? p.replace(/\\/g, '/').split('/').pop() : ''
            const rpath = `assets/${vid}/slicer_opt/${fn}`
            const isActive = activeRef === rpath
            const oor = !refInRange(seg.duration)
            return (
              <div key={`s${i}`} className={`ref-item ${isActive ? 'active' : ''}`} onClick={() => pickSlice(seg)} title={seg.text || ''}>
                <div className="ref-item-row">
                  <span className="ref-item-name">{seg.scene} #{seg.index}</span>
                  <span className={`ref-item-dur ${oor ? 'ref-dur-warn' : ''}`}>{(seg.duration || 0).toFixed(1)}s{oor ? ' \u26a0' : ''}</span>
                  <span className="ref-item-mark" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }}>{isActive ? '\u2713' : '\u2192'}</span>
                </div>
                <AudioPlayer src={`/assets/${vid}/slicer_opt/${fn}`} />
              </div>
            )
          })}
          {refTab === 'raw' && availRaw.map((rf, i) => {
            const rpath = `assets/${vid}/raw/${rf.filename}`
            const isActive = activeRef === rpath
            const dur = (rf.duration && rf.duration > 0) ? rf.duration : rawDur[rf.filename]
            const known = typeof dur === 'number' && dur > 0
            const oor = known && !refInRange(dur)
            return (
              <div key={`r${i}`} className={`ref-item ${isActive ? 'active' : ''}`} onClick={() => pickRaw(rf)} title={rf.text || rf.filename}>
                <div className="ref-item-row">
                  <span className="ref-item-name">{rf.filename}</span>
                  {known && <span className={`ref-item-dur ${oor ? 'ref-dur-warn' : ''}`}>{dur.toFixed(1)}s{oor ? ' \u26a0' : ''}</span>}
                  <span className="ref-item-mark" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }}>{isActive ? '\u2713' : '\u2192'}</span>
                </div>
                <AudioPlayer src={rf.url} onDuration={d => setRawDur(prev => (prev[rf.filename] ? prev : { ...prev, [rf.filename]: d }))} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 完全自选参考音频：浏览器文件选择（跨平台，非原生对话框），上传到
// voices/custom_refs 后作为任意音色的 ref_audio。可选手填参考文本 + prompt_lang。
// onPick(path, text, promptLang, customObj)；独立组件，Compare 页可复用（预留接口）。
function CustomRefPicker({ custom, onPick, onClear }) {
  const fileRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState(null)
  const [text, setText] = useState('')
  const [plang, setPlang] = useState('')
  const [dur, setDur] = useState(null)

  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!f) return
    setErr(null); setUploading(true)
    try {
      const fd = new FormData(); fd.append('audio', f)
      const r = await api('/api/custom-ref-audio', { method: 'POST', body: fd, contentType: 'multipart' })
      if (!r.ok) throw new Error(r.data?.error || `Upload failed (${r.status})`)
      setText(''); setPlang(''); setDur(null)
      onPick(r.data.path, '', '', { path: r.data.path, url: r.data.url, name: r.data.name })
    } catch (e2) { setErr(e2.message) }
    finally { setUploading(false) }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg,.webm" style={{ display: 'none' }} onChange={onFile} />
      <button className="btn btn-sm" onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading} title="Pick any audio file from your computer">
        {'\uD83D\uDCC1'} {uploading ? 'Uploading\u2026' : 'Custom file\u2026'}
      </button>
      {err && <div className="field-hint" style={{ color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
      {custom && (
        <div style={{ marginTop: 6 }}>
          <div className="field-hint" style={{ color: 'var(--warning)' }}>
            Custom reference &mdash; no aligned transcript. Add one below (optional).
          </div>
          <div style={{ fontSize: 12, wordBreak: 'break-all', margin: '4px 0' }}>{custom.name}</div>
          <AudioPlayer src={custom.url} onDuration={d => setDur(d)} />
          {typeof dur === 'number' && dur > 0 && !refInRange(dur) && (
            <div className="ref-range-warn">{'\u26a0'} {dur.toFixed(1)}s &mdash; the engine requires {REF_MIN_SEC}&ndash;{REF_MAX_SEC}s.</div>
          )}
          <input className="control" placeholder="Reference transcript (optional)" value={text}
            onChange={e => { setText(e.target.value); onPick(custom.path, e.target.value, plang, custom) }}
            style={{ marginTop: 6 }} />
          <label className="field-hint" style={{ display: 'block', marginTop: 4 }}>Reference language (prompt_lang)</label>
          <select className="control" value={plang}
            onChange={e => { setPlang(e.target.value); onPick(custom.path, text, e.target.value, custom) }}>
            <option value="">Follow current voice</option>
            {REF_PROMPT_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <div><button className="btn btn-sm" style={{ marginTop: 6 }} onClick={onClear}>Remove custom reference</button></div>
        </div>
      )}
    </div>
  )
}

export {
  CrossRefPicker,
  CustomRefPicker,
}
