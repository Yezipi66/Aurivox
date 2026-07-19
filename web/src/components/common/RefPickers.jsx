// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef } from 'react'
import { Select } from './Select'
import { api } from '../../lib/api'
import { AudioPlayer } from './Player'
import { REF_MAX_SEC, REF_MIN_SEC, basename, refInRange, sameRefPath } from '../../lib/format'
import { useT } from '../../lib/i18n'

// Build a static playback URL from a stored managed-reference path
// ("assets/<voice>/…" or "voices/custom_refs/…"). The server serves both roots
// statically, so a leading slash + per-segment encoding is all that's needed.
function refPlaybackUrl(p) {
  const s = String(p == null ? '' : (typeof p === 'object' ? (p.path || '') : p)).replace(/\\/g, '/').replace(/^\/+/, '')
  if (!s) return ''
  return '/' + s.split('/').map(encodeURIComponent).join('/')
}

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
  const { t } = useT()
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
      <Select className="control" value={vid} onChange={e => setVid(e.target.value)} style={{ marginBottom: 6 }}>
        {others.map(o => <option key={o.id} value={o.id}>{o.display_name} ({o.language || '?'})</option>)}
      </Select>
      <div className="field-hint" style={{ color: 'var(--warning)', marginBottom: 6 }}>
        {t('Cross-voice reference — timbre and quality may differ from this model.',
           '跨音色参考 — 音色和质量可能与本模型不同。')}
      </div>
      <div className="ref-tabs">
        <span className={`ref-tab ${refTab === 'slices' ? 'active' : ''}`}
              onClick={() => setRefTab('slices')}>
          {t('Slices', '切片')} {availSlices.length > 0 && <span className="ref-tab-count">{availSlices.length}</span>}
        </span>
        <span className={`ref-tab ${refTab === 'raw' ? 'active' : ''}`}
              onClick={() => setRefTab('raw')}>
          {t('Raw', '原始')} {availRaw.length > 0 && <span className="ref-tab-count">{availRaw.length}</span>}
        </span>
      </div>
      {loading && <div className="field-hint">{t('Loading reference audio…', '正在加载参考音频…')}</div>}
      {!loading && (
        <div className="ref-list">
          {refTab === 'slices' && availSlices.length === 0 && refTab === 'raw' && availRaw.length === 0 && <div className="ref-col-empty">{t('No reference audio in this voice', '该音色没有参考音频')}</div>}
          {refTab === 'slices' && availSlices.length === 0 && <div className="ref-col-empty">{t('No slices in this voice', '该音色没有切片')}</div>}
          {refTab === 'raw' && availRaw.length === 0 && <div className="ref-col-empty">{t('No raw audio in this voice', '该音色没有原始音频')}</div>}
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
function CustomRefPicker({ custom, onPick, onClear, multiple = false }) {
  const { t } = useT()
  const fileRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState(null)
  const [text, setText] = useState('')
  const [plang, setPlang] = useState('')
  const [dur, setDur] = useState(null)

  const onFile = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length === 0) return
    setErr(null); setUploading(true)
    try {
      // Multi-select reuses the single-file endpoint, uploading sequentially and
      // accumulating via onPick — no batch protocol (Patch #11 aux custom files).
      for (const f of files) {
        const fd = new FormData(); fd.append('audio', f)
        const r = await api('/api/custom-ref-audio', { method: 'POST', body: fd, contentType: 'multipart' })
        if (!r.ok) throw new Error(r.data?.error || `Upload failed (${r.status})`)
        onPick(r.data.path, '', '', { path: r.data.path, url: r.data.url, name: r.data.name })
      }
      setText(''); setPlang(''); setDur(null)
    } catch (e2) { setErr(e2.message) }
    finally { setUploading(false) }
  }

  // Audio-only multi-select variant (auxiliary references): just a picker button.
  // No transcript/prompt-lang editor — auxiliary refs are audio-only (inp_refs).
  if (multiple) {
    return (
      <div style={{ marginTop: 8 }}>
        <input ref={fileRef} type="file" multiple accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg,.webm" style={{ display: 'none' }} onChange={onFile} />
        <button className="btn btn-sm" onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading} title={t('Pick one or more audio files from your computer', '从你的电脑选择一个或多个音频文件')}>
          {'\uD83D\uDCC1'} {uploading ? t('Uploading\u2026', '上传中\u2026') : t('Custom files\u2026', '自定义文件\u2026')}
        </button>
        <div className="field-hint" style={{ marginTop: 4 }}>
          {t("Custom files are imported into this voice's managed assets when you save a recipe.",
             '保存配方时，自定义文件会被导入到该音色的托管资产中。')}
        </div>
        {err && <div className="field-hint" style={{ color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
      </div>
    )
  }

  return (
    <div style={{ marginTop: 8 }}>
      <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg,.webm" style={{ display: 'none' }} onChange={onFile} />
      <button className="btn btn-sm" onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading} title={t('Pick any audio file from your computer', '从你的电脑选择任意音频文件')}>
        {'\uD83D\uDCC1'} {uploading ? t('Uploading\u2026', '上传中\u2026') : t('Custom file\u2026', '自定义文件\u2026')}
      </button>
      {err && <div className="field-hint" style={{ color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
      {custom && (
        <div style={{ marginTop: 6 }}>
          <div className="field-hint" style={{ color: 'var(--warning)' }}>
            {t('Custom reference — no aligned transcript. Add one below (optional).',
               '自定义参考 — 没有对齐的文本。可在下方添加（可选）。')}
          </div>
          <div style={{ fontSize: 12, wordBreak: 'break-all', margin: '4px 0' }}>{custom.name}</div>
          <AudioPlayer src={custom.url} onDuration={d => setDur(d)} />
          {typeof dur === 'number' && dur > 0 && !refInRange(dur) && (
            <div className="ref-range-warn">{'\u26a0'} {dur.toFixed(1)}s &mdash; {t(`the engine requires ${REF_MIN_SEC}–${REF_MAX_SEC}s.`, `引擎要求 ${REF_MIN_SEC}–${REF_MAX_SEC} 秒。`)}</div>
          )}
          <input className="control" placeholder={t('Reference transcript (optional)', '参考文本（可选）')} value={text}
            onChange={e => { setText(e.target.value); onPick(custom.path, e.target.value, plang, custom) }}
            style={{ marginTop: 6 }} />
          <label className="field-hint" style={{ display: 'block', marginTop: 4 }}>{t('Reference language (prompt_lang)', '参考语言 (prompt_lang)')}</label>
          <Select className="control" value={plang}
            onChange={e => { setPlang(e.target.value); onPick(custom.path, text, e.target.value, custom) }}>
            <option value="">{t('Follow current voice', '跟随当前音色')}</option>
            {REF_PROMPT_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
          <div><button className="btn btn-sm" style={{ marginTop: 6 }} onClick={onClear}>{t('Remove custom reference', '移除自定义参考')}</button></div>
        </div>
      )}
    </div>
  )
}

// Single-voice reference list: Slices / Raw tabs + inline audition players.
// Hoisted from Compare's RefAudioTabs and parameterized (Patch #11) so a single
// implementation serves BOTH the main reference (selectMode="single") and the
// auxiliary references (selectMode="multi"). onPick(path,text) for single;
// onToggle(path,text) for multi. `selectedPaths` (multi) drives the checked/
// highlighted state; `mainRef` (multi) disables the row already used as the main
// reference. Identity is base+normalized-path (sameRefPath), never basename.
function RefAudioList({ voiceId, selectMode = 'single', activeRef, selectedPaths = [], mainRef, onPick, onToggle, maxHeight = 260 }) {
  const { t } = useT()
  const [segs, setSegs] = useState(null)
  const [raws, setRaws] = useState(null)
  const [loading, setLoading] = useState(false)
  const [rawDur, setRawDur] = useState({})
  const [tab, setTab] = useState('slices')

  useEffect(() => {
    if (!voiceId) { setSegs([]); setRaws([]); return }
    setLoading(true); setRawDur({}); setTab('slices')
    Promise.all([
      api(`/api/assets/${voiceId}/segments`)
        .then(r => setSegs(r.ok && r.data.segments ? (r.data.segments.segments || []) : []))
        .catch(() => setSegs([])),
      api(`/api/assets/${voiceId}/raw-list`)
        .then(r => setRaws(r.ok && r.data.raw ? r.data.raw : []))
        .catch(() => setRaws([])),
    ]).finally(() => setLoading(false))
  }, [voiceId])

  const multi = selectMode === 'multi'
  const availSlices = Array.isArray(segs) ? segs.filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename)) : []
  const availRaw = Array.isArray(raws) ? raws : []

  const isSelected = (rpath) => multi
    ? selectedPaths.some(sp => sameRefPath(sp, rpath))
    : (sameRefPath(activeRef, rpath) || basename(activeRef) === basename(rpath))
  const isMain = (rpath) => multi && mainRef && sameRefPath(mainRef, rpath)

  const renderItem = (key, rpath, playSrc, name, dur, known, text) => {
    const selected = isSelected(rpath)
    const main = isMain(rpath)
    const oor = known && !refInRange(dur)
    const click = () => {
      if (main) return
      if (multi) onToggle && onToggle(rpath, text || '')
      else onPick && onPick(rpath, text || '')
    }
    return (
      <div key={key}
        className={`ref-item ${selected ? 'active' : ''}`}
        onClick={click}
        title={text || name}
        style={main ? { opacity: 0.4, cursor: 'default' } : undefined}>
        <div className="ref-item-row">
          {multi && <input type="checkbox" checked={selected} disabled={!!main} readOnly style={{ accentColor: 'var(--accent)', width: 11, height: 11, marginRight: 4 }} />}
          <span className="ref-item-name">
            {name}
            {main && <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 4 }}>(main)</span>}
            {oor && <span title={`Outside the ${REF_MIN_SEC}\u2013${REF_MAX_SEC}s range`} style={{ color: 'var(--warning)', marginLeft: 4 }}>{'\u26a0'}</span>}
          </span>
          {known && <span className={`ref-item-dur ${oor ? 'ref-dur-warn' : ''}`}>{dur.toFixed(1)}s</span>}
          {!multi && <span className="ref-item-mark" style={{ color: selected ? 'var(--accent)' : 'var(--muted)' }}>{selected ? '\u2713' : '\u2192'}</span>}
        </div>
        <AudioPlayer src={playSrc} onDuration={d => setRawDur(prev => (prev[key] ? prev : { ...prev, [key]: d }))} />
      </div>
    )
  }

  return (
    <div>
      <div className="ref-tabs">
        <span className={`ref-tab ${tab === 'slices' ? 'active' : ''}`} onClick={() => setTab('slices')}>
          {t('Slices', '切片')} {availSlices.length > 0 && <span className="ref-tab-count">{availSlices.length}</span>}
        </span>
        <span className={`ref-tab ${tab === 'raw' ? 'active' : ''}`} onClick={() => setTab('raw')}>
          {t('Raw', '原始')} {availRaw.length > 0 && <span className="ref-tab-count">{availRaw.length}</span>}
        </span>
      </div>
      {loading && <div className="field-hint">{t('Loading reference audio…', '正在加载参考音频…')}</div>}
      {!loading && (
        <div className="ref-list" style={{ maxHeight, overflowY: 'auto' }}>
          {tab === 'slices' && availSlices.length === 0 && <div className="ref-col-empty">{t('No slices in this voice', '该音色没有切片')}</div>}
          {tab === 'raw' && availRaw.length === 0 && <div className="ref-col-empty">{t('No raw audio in this voice', '该音色没有原始音频')}</div>}
          {tab === 'slices' && availSlices.map((seg, i) => {
            const p = seg.audio || seg.audio_path || seg.audio_filename
            const fn = p ? p.replace(/\\/g, '/').split('/').pop() : ''
            const rpath = `assets/${voiceId}/slicer_opt/${fn}`
            const dur = seg.duration || 0
            return renderItem(`s${i}`, rpath, `/assets/${voiceId}/slicer_opt/${fn}`, `${seg.scene} #${seg.index}`, dur, typeof seg.duration === 'number', seg.text || '')
          })}
          {tab === 'raw' && availRaw.map((rf, i) => {
            const rpath = `assets/${voiceId}/raw/${rf.filename}`
            const key = `r${i}`
            const dur = (rf.duration && rf.duration > 0) ? rf.duration : rawDur[key]
            const known = typeof dur === 'number' && dur > 0
            return renderItem(key, rpath, rf.url, rf.filename, dur, known, rf.text || '')
          })}
        </div>
      )}
    </div>
  )
}

// Auxiliary-reference picker (Patch #11): the ONE shared multi-select reference
// selector used by BOTH Generate and Compare. Sources: This voice's segments
// (Slices/Raw, multi) · Another voice's segments (CrossRefPicker) · Custom files
// (multi upload). Identity uses base+normalized path so the current main
// reference is excluded and duplicates across voices are distinguished.
// Props: voiceId, voices, value(array of stored paths), onAdd(path),
//        onRemove(index), mainRef(optional, excluded from selection).
function AuxReferencePicker({ voiceId, voices, value = [], onAdd, onRemove, mainRef }) {
  const { t } = useT()
  const [source, setSource] = useState('this') // 'this' | 'cross' | 'custom'
  const has = (p) => value.some(v => sameRefPath(v, p))
  const add = (p) => { if (p && !has(p) && !(mainRef && sameRefPath(mainRef, p))) onAdd && onAdd(p) }

  return (
    <div style={{ marginTop: 4 }}>
      <Select className="control" value={source} onChange={e => setSource(e.target.value)} style={{ marginBottom: 6 }}>
        <option value="this">{t("This voice's segments", '当前音色的片段')}</option>
        <option value="cross">{t("Another voice's segments", '其他音色的片段')}</option>
        <option value="custom">{t('Custom files…', '自定义文件…')}</option>
      </Select>
      {source === 'this' && (
        <RefAudioList
          voiceId={voiceId}
          selectMode="multi"
          selectedPaths={value}
          mainRef={mainRef}
          onToggle={(rpath) => {
            const idx = value.findIndex(v => sameRefPath(v, rpath))
            if (idx >= 0) onRemove && onRemove(idx)
            else add(rpath)
          }}
          maxHeight={200}
        />
      )}
      {source === 'cross' && (
        <CrossRefPicker
          voices={voices}
          currentVoiceId={voiceId}
          activeRef={''}
          onPick={(path) => add(path)}
        />
      )}
      {source === 'custom' && (
        <CustomRefPicker multiple onPick={(path) => add(path)} onClear={() => {}} />
      )}
      {value.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {value.map((p, i) => (
            <div key={i} className="ref-item" style={{ marginBottom: 4 }}>
              <div className="ref-item-row">
                <span style={{ color: 'var(--muted)', minWidth: 14, fontSize: 11 }}>{i + 1}.</span>
                <span className="ref-item-name" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{basename(p)}</span>
                <button
                  onClick={() => onRemove && onRemove(i)}
                  style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1 }}
                  title={t('Remove', '移除')}>{'\u00d7'}</button>
              </div>
              <AudioPlayer src={refPlaybackUrl(p)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export {
  CrossRefPicker,
  CustomRefPicker,
  RefAudioList,
  AuxReferencePicker,
}
