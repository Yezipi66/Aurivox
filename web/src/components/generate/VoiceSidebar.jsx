// 生成页的音色侧栏：列出参考音频（切片与原始音频）、显示当前参考与时长警告、编辑参考转写文本。
// 参考音频取自音色（SoVITS）那一侧；用户手动选定的参考与转写文本只对本次生成有效。
import { useState, useEffect } from 'react'
import { useT } from '../../lib/i18n'
import { API_BASE, api } from '../../lib/api'
import { basename } from '../../lib/pathText'
import { pickDefaultRef, refInRange, REF_MIN_SEC, REF_MAX_SEC } from '../../lib/refAudio'
import { statusBadge } from '../common/StatusBadge'
import { AudioPlayer } from '../common/Player'
import { CrossRefPicker, CustomRefPicker, refMatches } from '../common/RefPickers'

function VoiceSidebar({ voice, refVoiceId, voices, validation, onVoiceUpdate, selectedRefAudio, selectedRefText, selectedPromptLang, onSelectRef, refTextOverride, onRefTextOverride }) {
  const { t } = useT()
  // 参考音频取自音色（SoVITS）那一侧；除非 SoVITS 模型来自另一份资产，否则它就是当前音色。
  const rvid = refVoiceId || voice.id
  const refVoice = voices.find(v => v.id === rvid)
  const mixedRef = rvid !== voice.id
  const [segments, setSegments] = useState(null)
  const [rawRefs, setRawRefs] = useState(null)
  const [segLoading, setSegLoading] = useState(false)
  const [refTab, setRefTab] = useState('slices') // 'slices' | 'raw'
  const [refSearch, setRefSearch] = useState('') // 主参考的搜索框
  // 客户端量出的原始音频时长（文件名 -> 秒数）。原始音频常是 mp3，
  // 服务端读 WAV 头拿不到长度，由 audio 元素在 loadedmetadata 时报出来，
  // 用来与切片走同一套 3 到 10 秒检查。
  const [rawDurations, setRawDurations] = useState({})
  // 跨选与自选的参考音频：只在本次会话内有效，切换音色时重置，不写进音色配置。
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
    // 参考文本取自 asr_opt/raw_opt.list（服务端补进了 rf.text）；
    // 原始音频还没转写时它可能是空的。
    onSelectRef(`assets/${rvid}/raw/${rf.filename}`, rf.text || '')
  }
  // 跨选：prompt_lang 保持当前音色的语种不变，只做提示。自选：可带一个 prompt_lang 覆盖值。
  const handleCrossPick = (path, text) => onSelectRef(path, text)
  const handleCustomPick = (path, text, plang, obj) => { if (obj) setCustomRef(obj); onSelectRef(path, text, plang) }
  const handleCustomClear = () => { setCustomRef(null); onSelectRef('', '', '') }
  // 原始音频的有效时长：优先用服务端从 WAV 头读出的值，否则用客户端量出的值。
  const rawDur = (rf) => (rf.duration && rf.duration > 0 ? rf.duration : rawDurations[rf.filename])

  // 只提供盘上还存在的切片：服务端实时复查并给出 exists 字段，已删除的切片被排除。
  const availableRefs = segments && Array.isArray(segments)
    ? segments.filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
    : []
  const availableRaw = Array.isArray(rawRefs) ? rawRefs : []
  // 按名称与转写文本过滤后的视图。搜索词为空时列表不变。
  const shownRefs = availableRefs.filter(s => refMatches(refSearch, `${s.scene} #${s.index}`, s.text))
  const shownRaw = availableRaw.filter(rf => refMatches(refSearch, rf.filename, rf.text))

  // 当前参考：用户在父组件选定的优先于自动挑出的合规切片。
  const firstRef = pickDefaultRef(availableRefs)
  const activeRef = selectedRefAudio || (firstRef ? (firstRef.audio || firstRef.audio_path || firstRef.audio_filename) : '')
  // 用户显式选的参考原样生效（原始音频时为空）；只有在用户还没选过时才用挑出的切片补上，
  // 这样选原始音频会把转写文本清空。
  const activeRefText = selectedRefAudio ? selectedRefText : (firstRef?.text || '')
  const activeFilename = activeRef ? activeRef.replace(/\\/g, '/').split('/').pop() : ''
  const activeIsRaw = /\/raw\//.test(activeRef)

  return (
    <div className="section">
      <div className="section-hdr"><span>{voice.display_name}</span><span style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>{voice.id}</span></div>
      <div className="section-body">
        <div className="field">
          <label className="field-label">Language</label>
          <div style={{ fontSize: 'var(--fs-13)' }}>{voice.language || '?'}</div>
        </div>

        {mixedRef && (
          <div className="field-hint" style={{ color: 'var(--warning)', marginBottom: 6 }}>
            {t(`Reference audio is sourced from the SoVITS voice “${refVoice?.display_name || rvid}” (timbre side).`,
               `参考音频取自 SoVITS 音色「${refVoice?.display_name || rvid}」（音色侧）。`)}
          </div>
        )}

        {/* 参考音频选择器：切片（默认）与原始音频分两个页签，避免挤在一处 */}
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', margin: '4px 0 6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={crossMode} onChange={e => {
              const on = e.target.checked
              setCrossMode(on)
              // 退出跨选模式时清掉跨选与自选的参考，参考回到本音色自己的切片，
              // 免得留下一条已经失效的参考。
              if (!on) { setCustomRef(null); onSelectRef('', '', '') }
            }} />
            {t('Use reference from another voice', '使用其他音色的参考音频')}
          </label>
          {activeRef && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text)', background: 'var(--bg)', padding: '6px 8px', borderRadius: 4, wordBreak: 'break-all', marginBottom: activeRefText ? 2 : 6 }}>
              {basename(activeRef)}
            </div>
          )}
          {(() => {
            // 当前参考的时长警告：切片与原始音频都适用（原始音频的时长可能是客户端量的，
            // 所以量出来才警告）。
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
            // 可编辑的参考转写文本，只对本次生成有效：改的是发给引擎的提示文本，
            // 不会改动源文件。初始值取当前参考自带的文本，覆盖值由父组件持有（effectiveRefText）。
            <div style={{ marginBottom: 6 }}>
              <textarea
                className="control"
                rows={2}
                style={{ fontSize: 'var(--fs-11)', width: '100%', fontStyle: refTextOverride != null ? 'normal' : 'italic', whiteSpace: 'pre-wrap' }}
                value={refTextOverride != null ? refTextOverride : activeRefText}
                onChange={e => onRefTextOverride?.(e.target.value)}
                placeholder={activeIsRaw ? t('No aligned transcript — type a reference text for this run (optional)…', '没有对齐的转写文本：可为本次生成输入一段参考文本（可选）…') : t('Reference text…', '参考文本…')}
              />
              <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 2 }}>
                <span>
                  {refTextOverride != null
                    ? t('✎ Edited for this run only — the source file is unchanged.', '✎ 仅对本次生成有效，源文件不会被修改。')
                    : (activeIsRaw && !activeRefText
                        ? t('Raw audio has no aligned reference text — type one to guide this run (optional).', '原始音频没有对齐的参考文本：可输入一段以引导本次生成（可选）。')
                        : t('Reference transcript — edits here affect only this run, not the file.', '参考转写文本：此处的修改仅影响本次生成，不会改动文件。'))}
                </span>
                {refTextOverride != null && (
                  <button type="button" className="btn btn-sm" style={{ padding: '0 6px', height: 18, fontSize: 'var(--fs-11)', flex: '0 0 auto' }}
                    onClick={() => onRefTextOverride?.(null)}>Reset</button>
                )}
              </div>
            </div>
          ) : null}
          {!crossMode && segLoading && <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>{t('Loading reference audio…', '正在加载参考音频…')}</div>}
          {!crossMode && !segLoading && availableRefs.length === 0 && availableRaw.length === 0 && (
            <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>{t('No reference audio available', '没有可用的参考音频')}</div>
          )}
          {!crossMode && !segLoading && (availableRefs.length > 0 || availableRaw.length > 0) && (
            <input
              className="control"
              value={refSearch}
              onChange={e => setRefSearch(e.target.value)}
              placeholder={t('Search reference audio (name or transcript)…', '搜索参考音频（文件名或文本）…')}
              style={{ margin: '4px 0 6px', fontSize: 'var(--fs-12)' }}
            />
          )}
          {!crossMode && !segLoading && refTab === 'slices' && (
            <div className="ref-list">
              {availableRefs.length === 0 && <div className="ref-col-empty">{t('No slices available', '没有可用的切片')}</div>}
              {availableRefs.length > 0 && shownRefs.length === 0 && <div className="ref-col-empty">{t('No slices match the search', '没有匹配搜索的切片')}</div>}
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
              {availableRaw.length > 0 && shownRaw.length === 0 && <div className="ref-col-empty">{t('No raw audio matches the search', '没有匹配搜索的原始音频')}</div>}
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
          {/* 自选文件只对跨选或外部参考有意义，所以只在「使用其他音色的参考音频」勾上时显示。
              取消勾选会清掉自选的参考（见上面的复选框处理）。 */}
          {crossMode && (
            <CustomRefPicker custom={customRef} onPick={handleCustomPick} onClear={handleCustomClear} />
          )}
        </div>

        {validation && (
          <div className="field" style={{ marginTop: 8 }}>
            <label className="field-label">Model Validity</label>
            {/* 显示几行、每行叫什么，由当前引擎的名片决定：
                后端 /api/voices/:id/validate 直接给 slots[]，前端不认识任何位名。
                前端不写死任何具体引擎的零件名，换一台引擎照样显示它自己的位。 */}
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
