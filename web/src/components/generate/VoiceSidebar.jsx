// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect } from 'react'
import { useT } from '../../lib/i18n'
import { API_BASE, api } from '../../lib/api'
import { basename, pickDefaultRef, refInRange, REF_MIN_SEC, REF_MAX_SEC, statusBadge } from '../../lib/format'
import { AudioPlayer } from '../common/Player'
import { CrossRefPicker, CustomRefPicker, refMatches } from '../common/RefPickers'

function VoiceSidebar({ voice, refVoiceId, voices, validation, onVoiceUpdate, selectedRefAudio, selectedRefText, selectedPromptLang, onSelectRef, refTextOverride, onRefTextOverride }) {
  const { t } = useT()
  // Reference clips are loaded from the timbre (SoVITS) voice (C3); it equals the
  // primary voice unless the SoVITS model was sourced from another asset.
  const rvid = refVoiceId || voice.id
  const refVoice = voices.find(v => v.id === rvid)
  const mixedRef = rvid !== voice.id
  const [segments, setSegments] = useState(null)
  const [rawRefs, setRawRefs] = useState(null)
  const [segLoading, setSegLoading] = useState(false)
  const [refTab, setRefTab] = useState('slices') // 'slices' | 'raw'
  const [refSearch, setRefSearch] = useState('') // main reference search box
  // Client-measured raw durations (filename -> seconds). Raw clips are often mp3,
  // whose length the server can't read from a WAV header, so the <audio> element
  // reports it on loadedmetadata — used for the same 3–10s guard as slices.
  const [rawDurations, setRawDurations] = useState({})
  // 跨选/自选参考音频（本次会话内有效，切换音色时重置；不写入音色配置）。
  const [crossMode, setCrossMode] = useState(false)
  const [customRef, setCustomRef] = useState(null) // { path, url, name } | null

  useEffect(() => {
    if (!rvid) return
    setSegLoading(true)
    setRawDurations({})
    setCrossMode(false)
    setCustomRef(null)
    setRefSearch('')
    Promise.all([
      api(`/api/assets/${rvid}/segments`).then(r => {
        setSegments(r.ok && r.data.segments ? (r.data.segments.segments || []) : [])
      }).catch(() => setSegments([])),
      api(`/api/assets/${rvid}/raw-list`).then(r => {
        setRawRefs(r.ok && r.data.raw ? r.data.raw : [])
      }).catch(() => setRawRefs([])),
    ]).finally(() => setSegLoading(false))
  }, [rvid])

  const pickSlice = (seg) => {
    const audioPath = seg.audio || seg.audio_path || seg.audio_filename
    if (!audioPath) return
    const filename = audioPath.replace(/\\/g, '/').split('/').pop()
    onSelectRef(`assets/${rvid}/slicer_opt/${filename}`, seg.text || '')
  }
  const pickRaw = (rf) => {
    // Reference text comes from asr_opt/raw_opt.list (server-enriched rf.text);
    // may be empty if the raw list hasn't been transcribed yet.
    onSelectRef(`assets/${rvid}/raw/${rf.filename}`, rf.text || '')
  }
  // Cross-voice pick: prompt_lang stays = current voice language (decision: do NOT
  // switch it), just warn. Custom pick: carries an optional prompt_lang override.
  const handleCrossPick = (path, text) => onSelectRef(path, text)
  const handleCustomPick = (path, text, plang, obj) => { if (obj) setCustomRef(obj); onSelectRef(path, text, plang) }
  const handleCustomClear = () => { setCustomRef(null); onSelectRef('', '', '') }
  // Effective duration for a raw clip: server WAV-header value, else client-measured.
  const rawDur = (rf) => (rf.duration && rf.duration > 0 ? rf.duration : rawDurations[rf.filename])

  // Privacy: only offer slices whose .wav still exists on disk right now
  // (server sets `exists` via a live re-check; deleted slices are excluded).
  const availableRefs = segments && Array.isArray(segments)
    ? segments.filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
    : []
  const availableRaw = Array.isArray(rawRefs) ? rawRefs : []
  // Search-filtered views (name + transcript). Empty query => unchanged lists.
  const shownRefs = availableRefs.filter(s => refMatches(refSearch, `${s.scene} #${s.index}`, s.text))
  const shownRaw = availableRaw.filter(rf => refMatches(refSearch, rf.filename, rf.text))

  // Active ref: user selection (from App) > auto-picked in-range slice
  const firstRef = pickDefaultRef(availableRefs)
  const activeRef = selectedRefAudio || (firstRef ? (firstRef.audio || firstRef.audio_path || firstRef.audio_filename) : '')
  // Explicit selection wins verbatim (empty for raw); only auto-fill from the picked
  // slice when the user hasn't chosen anything, so raw picks clear the transcript.
  const activeRefText = selectedRefAudio ? selectedRefText : (firstRef?.text || '')
  const activeFilename = activeRef ? activeRef.replace(/\\/g, '/').split('/').pop() : ''
  const activeIsRaw = /\/raw\//.test(activeRef)

  return (
    <div className="section">
      <div className="section-hdr"><span>{voice.display_name}</span><span style={{ fontSize: 11, color: 'var(--muted)' }}>{voice.id}</span></div>
      <div className="section-body">
        <div className="field">
          <label className="field-label">Language</label>
          <div style={{ fontSize: 13 }}>{voice.language || '?'}</div>
        </div>

        {mixedRef && (
          <div className="field-hint" style={{ color: 'var(--warning)', marginBottom: 6 }}>
            {t(`Reference audio is sourced from the SoVITS voice “${refVoice?.display_name || rvid}” (timbre side).`,
               `参考音频取自 SoVITS 音色「${refVoice?.display_name || rvid}」（音色侧）。`)}
          </div>
        )}

        {/* Reference Audio selector — Slices (default) / Raw as tabs to avoid crowding */}
        <div className="field">
          <div className="ref-hdr">
            <label className="field-label" style={{ margin: 0 }}>Reference Audio</label>
            {!crossMode && (
              <div className="ref-tabs">
                <button
                  className={`ref-tab ${refTab === 'slices' ? 'active' : ''}`}
                  onClick={() => setRefTab('slices')}
                >Slices <span className="ref-tab-count">{availableRefs.length}</span></button>
                <button
                  className={`ref-tab ${refTab === 'raw' ? 'active' : ''}`}
                  onClick={() => setRefTab('raw')}
                >Raw <span className="ref-tab-count">{availableRaw.length}</span></button>
              </div>
            )}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '4px 0 6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={crossMode} onChange={e => {
              const on = e.target.checked
              setCrossMode(on)
              // PE-1: leaving cross-voice mode drops any cross/custom selection so the
              // reference falls back to this voice's own slices, avoiding a stale ref.
              if (!on) { setCustomRef(null); onSelectRef('', '', '') }
            }} />
            {t('Use reference from another voice', '使用其他音色的参考音频')}
          </label>
          {activeRef && (
            <div style={{ fontSize: 12, color: 'var(--text)', background: 'var(--bg)', padding: '6px 8px', borderRadius: 4, wordBreak: 'break-all', marginBottom: activeRefText ? 2 : 6 }}>
              {basename(activeRef)}
            </div>
          )}
          {(() => {
            // Out-of-range warning for the ACTIVE ref — works for both a slice and
            // a raw clip (raw duration may be client-measured, so only warn once known).
            let dur = null
            if (activeIsRaw) {
              const rf = availableRaw.find(r => r.filename === activeFilename)
              if (rf) dur = rawDur(rf)
            } else {
              const activeSeg = availableRefs.find(s => {
                const p = s.audio || s.audio_path || s.audio_filename
                return p && p.replace(/\\/g, '/').split('/').pop() === activeFilename
              })
              if (activeSeg) dur = activeSeg.duration
            }
            if (typeof dur === 'number' && dur > 0 && !refInRange(dur)) {
              return (
                <div className="ref-range-warn">
                  {t(`⚠ Reference is ${dur.toFixed(1)}s — the engine requires ${REF_MIN_SEC}–${REF_MAX_SEC}s. Pick another ${activeIsRaw ? 'clip' : 'slice'} or generation will fail.`,
                     `⚠ 参考音频为 ${dur.toFixed(1)} 秒，引擎要求 ${REF_MIN_SEC}–${REF_MAX_SEC} 秒。请另选一个${activeIsRaw ? '片段' : '切片'}，否则生成将失败。`)}
                </div>
              )
            }
            return null
          })()}
          {activeRef ? (
            // Editable reference transcript (THIS RUN ONLY): edits change the prompt
            // text sent to the engine but never modify the source file. Seeded with the
            // active ref's own text; the override lives in the parent (effectiveRefText).
            <div style={{ marginBottom: 6 }}>
              <textarea
                className="control"
                rows={2}
                style={{ fontSize: 11, width: '100%', fontStyle: refTextOverride != null ? 'normal' : 'italic', whiteSpace: 'pre-wrap' }}
                value={refTextOverride != null ? refTextOverride : activeRefText}
                onChange={e => onRefTextOverride?.(e.target.value)}
                placeholder={activeIsRaw ? t('No aligned transcript — type a reference text for this run (optional)…', '没有对齐的转写文本：可为本次生成输入一段参考文本（可选）…') : t('Reference text…', '参考文本…')}
              />
              <div style={{ fontSize: 10, color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 2 }}>
                <span>
                  {refTextOverride != null
                    ? t('✎ Edited for this run only — the source file is unchanged.', '✎ 仅对本次生成有效，源文件不会被修改。')
                    : (activeIsRaw && !activeRefText
                        ? t('Raw audio has no aligned reference text — type one to guide this run (optional).', '原始音频没有对齐的参考文本：可输入一段以引导本次生成（可选）。')
                        : t('Reference transcript — edits here affect only this run, not the file.', '参考转写文本：此处的修改仅影响本次生成，不会改动文件。'))}
                </span>
                {refTextOverride != null && (
                  <button type="button" className="btn btn-sm" style={{ padding: '0 6px', height: 18, fontSize: 10, flex: '0 0 auto' }}
                    onClick={() => onRefTextOverride?.(null)}>Reset</button>
                )}
              </div>
            </div>
          ) : null}
          {!crossMode && segLoading && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t('Loading reference audio…', '正在加载参考音频…')}</div>}
          {!crossMode && !segLoading && availableRefs.length === 0 && availableRaw.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t('No reference audio available', '没有可用的参考音频')}</div>
          )}
          {!crossMode && !segLoading && (availableRefs.length > 0 || availableRaw.length > 0) && (
            <input
              className="control"
              value={refSearch}
              onChange={e => setRefSearch(e.target.value)}
              placeholder={t('Search reference audio (name or transcript)…', '搜索参考音频（文件名或文本）…')}
              style={{ margin: '4px 0 6px', fontSize: 12 }}
            />
          )}
          {!crossMode && !segLoading && refTab === 'slices' && (
            <div className="ref-list">
              {availableRefs.length === 0 && <div className="ref-col-empty">{t('No slices available', '没有可用的切片')}</div>}
              {availableRefs.length > 0 && shownRefs.length === 0 && <div className="ref-col-empty">{t('No slices match your search', '没有匹配搜索的切片')}</div>}
              {shownRefs.map((seg, i) => {
                const rawPath = seg.audio || seg.audio_path || seg.audio_filename
                const segFilename = rawPath ? rawPath.replace(/\\/g, '/').split('/').pop() : ''
                const isActive = activeFilename === segFilename && !!activeRef
                const outOfRange = !refInRange(seg.duration)
                return (
                  <div key={segFilename || i} className={`ref-item ${isActive ? 'active' : ''}`} title={outOfRange ? `${seg.text || ''}\n⚠ ${(seg.duration || 0).toFixed(1)}s is outside the engine's ${REF_MIN_SEC}–${REF_MAX_SEC}s reference window` : (seg.text || '')} onClick={() => pickSlice(seg)}>
                    <div className="ref-item-row">
                      <span className="ref-item-name">{seg.scene} #{seg.index}</span>
                      <span className={`ref-item-dur ${outOfRange ? 'ref-dur-warn' : ''}`}>{(seg.duration || 0).toFixed(1)}s{outOfRange ? ' ⚠' : ''}</span>
                      <span className="ref-item-mark" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }}>{isActive ? '✓' : '→'}</span>
                    </div>
                    <AudioPlayer src={`/assets/${rvid}/slicer_opt/${segFilename}`} />
                  </div>
                )
              })}
            </div>
          )}
          {!crossMode && !segLoading && refTab === 'raw' && (
            <div className="ref-list">
              {availableRaw.length === 0 && <div className="ref-col-empty">{t('No raw audio available', '没有可用的原始音频')}</div>}
              {availableRaw.length > 0 && shownRaw.length === 0 && <div className="ref-col-empty">{t('No raw audio matches your search', '没有匹配搜索的原始音频')}</div>}
              {shownRaw.map((rf, i) => {
                const isActive = activeFilename === rf.filename && !!activeRef
                const dur = rawDur(rf)
                const known = typeof dur === 'number' && dur > 0
                const outOfRange = known && !refInRange(dur)
                const durTitle = known
                  ? (outOfRange ? `\n⚠ ${dur.toFixed(1)}s is outside the engine's ${REF_MIN_SEC}–${REF_MAX_SEC}s reference window` : '')
                  : ''
                return (
                  <div key={rf.filename || i} className={`ref-item ${isActive ? 'active' : ''}`} title={`${rf.text || rf.filename}${durTitle}`} onClick={() => pickRaw(rf)}>
                    <div className="ref-item-row">
                      <span className="ref-item-name">{rf.filename}</span>
                      {known && (
                        <span className={`ref-item-dur ${outOfRange ? 'ref-dur-warn' : ''}`}>{dur.toFixed(1)}s{outOfRange ? ' ⚠' : ''}</span>
                      )}
                      <span className="ref-item-mark" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }}>{isActive ? '✓' : '→'}</span>
                    </div>
                    <AudioPlayer
                      src={rf.url}
                      onDuration={d => setRawDurations(prev => (prev[rf.filename] ? prev : { ...prev, [rf.filename]: d }))}
                    />
                  </div>
                )
              })}
            </div>
          )}
          {crossMode && (
            <CrossRefPicker voices={voices} currentVoiceId={rvid} onPick={handleCrossPick} activeRef={selectedRefAudio} />
          )}
          {/* PE: the custom-file picker only makes sense as a cross-voice/external
              reference, so it is shown only while "Use reference from another voice"
              is checked. Unchecking clears any custom pick (see checkbox handler). */}
          {crossMode && (
            <CustomRefPicker custom={customRef} onPick={handleCustomPick} onClear={handleCustomClear} />
          )}
        </div>

        {validation && (
          <div className="field" style={{ marginTop: 8 }}>
            <label className="field-label">Model Validity</label>
            {/* ：这里过去写死两行「GPT Model / SoVITS Model」，
                那是一台引擎的零件清单被抄进了平台。换一台引擎，这两行要么
                恒为红叉（它实际什么都不缺），要么答非所问（IndexTTS2 只有
                一个位，界面却追问它 SoVITS 在不在）。
                现在：几行、叫什么，是这台引擎的名片说的，前端一个位名
                都不认识，后端 /api/voices/:id/validate 直接给 slots[]。
                别再往这里加任何具体名字。 */}
            <div className="validity-list">
              {(validation.slots || []).map(s => (
                <div className="validity-row" key={`${s.engine_id}:${s.name}`}>
                  <span>{s.label || s.name}</span>{statusBadge(s.present)}
                </div>
              ))}
              <div className="validity-row"><span>Reference Audio</span>{statusBadge(validation.reference_audio_exists)}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export {
  VoiceSidebar,
}
