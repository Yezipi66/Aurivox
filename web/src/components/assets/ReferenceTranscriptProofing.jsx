// Patch #13 — Reference Transcript Proofing.
// Lets the user hand-edit an asset's EXISTING reference transcript (the text that
// will be used when this audio is picked as an inference reference) and, per line,
// open the shared reading-proofing UI to fix pronunciations. Reading corrections are
// saved to the GLOBAL personal lexicon (applied at inference), while text edits are
// written back to the asset's .list. This never runs ASR, never touches checkpoints.
//
// "Re-run ASR" is a deliberately SECONDARY action here: it backs up the current
// transcript first and replaces it with a fresh machine-generated one.
import { useState, useEffect, useRef } from 'react'
import { Select } from '../common/Select'
import { api } from '../../lib/api'
import { LANG_LABEL, TextPrepModal, hanOverrideDirection } from '../pron/PronProofing'

// Patch #23 — ASR confidence coloring. faster-whisper 的 word/segment 概率折算成
// [0,1] 置信度，映射到 绿(高)/黄(可疑)/红(可能识别错误) 三档，辅助用户校对。
const CONF_HI = 0.85   // ≥ → green
const CONF_MID = 0.6   // ≥ → yellow, else red
function confTier(c) {
  if (typeof c !== 'number') return null
  if (c >= CONF_HI) return 'hi'
  if (c >= CONF_MID) return 'mid'
  return 'lo'
}
const CONF_COLORS = {
  hi: { fg: '#2ecc71', bg: 'rgba(46,204,113,0.16)' },
  mid: { fg: '#f1c40f', bg: 'rgba(241,196,15,0.18)' },
  lo: { fg: '#e74c3c', bg: 'rgba(231,76,60,0.18)' },
}

// 行级置信度徽标：一个色点 + 百分比。
function ConfidenceBadge({ conf }) {
  const tier = confTier(conf)
  if (!tier) return null
  const c = CONF_COLORS[tier]
  return (
    <div style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}
         title={`识别置信度 ${(conf * 100).toFixed(0)}%（绿=高 / 黄=可疑 / 红=可能识别错误）`}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.fg, display: 'inline-block' }} />
      <span style={{ fontSize: 10, color: c.fg }}>{(conf * 100).toFixed(0)}%</span>
    </div>
  )
}

// 词级置信度预览：把每个词按其概率着色（只读，不影响可编辑文本框）。
function WordConfidence({ words }) {
  if (!Array.isArray(words) || words.length === 0) return null
  return (
    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: '2px 3px', lineHeight: 1.5 }}
         title="逐词置信度着色（绿=高 / 黄=可疑 / 红=可能识别错误），仅供校对参考">
      {words.map((w, j) => {
        const tier = confTier(w && typeof w.p === 'number' ? w.p : null)
        const c = tier ? CONF_COLORS[tier] : null
        return (
          <span key={j} style={{
            fontSize: 12, padding: '0 2px', borderRadius: 3,
            color: c ? c.fg : 'var(--muted)', background: c ? c.bg : 'transparent',
          }}>{(w && w.w != null ? String(w.w) : '').trim() || '␠'}</span>
        )
      })}
    </div>
  )
}

// Compact dark-theme audio play/pause control — replaces the raw <audio controls>
// widget (which clashes with the app's styling). One <audio> per row, lazily loaded.
function RowAudio({ url }) {
  const ref = useRef(null)
  const [playing, setPlaying] = useState(false)
  const toggle = () => {
    const el = ref.current
    if (!el) return
    if (el.paused) { el.play().catch(() => {}) } else { el.pause() }
  }
  return (
    <div style={{ marginTop: 4 }}>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={toggle}
        title={playing ? 'Pause' : 'Play'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', height: 26 }}
      >
        <span style={{ fontSize: 11, lineHeight: 1 }}>{playing ? '❚❚' : '▶'}</span>
        <span style={{ fontSize: 11 }}>{playing ? 'Pause' : 'Play'}</span>
      </button>
      <audio
        ref={ref}
        src={url}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        style={{ display: 'none' }}
      />
    </div>
  )
}

export default function ReferenceTranscriptProofing({ voiceId, onClose, onSaved, onRerunAsr, asrRunning }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [buckets, setBuckets] = useState([])
  const [kind, setKind] = useState(null)
  const [rowsByKind, setRowsByKind] = useState({})
  const [language, setLanguage] = useState('ja')
  const [provenance, setProvenance] = useState(null)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState(null)
  const [confirmAsr, setConfirmAsr] = useState(false)

  // Reading-proofing modal (reuse TextPrepModal) for one focused line at a time.
  const [proofIdx, setProofIdx] = useState(null)
  const [pronOverrides, setPronOverrides] = useState({})
  const [hanForced, setHanForced] = useState([])
  const [hanReadings, setHanReadings] = useState({})

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    api(`/api/assets/${voiceId}/transcript`).then(r => {
      if (cancelled) return
      if (!r.ok) { setError(r.data?.error || 'Failed to load transcript'); setLoading(false); return }
      const bs = r.data?.buckets || []
      setBuckets(bs)
      setLanguage(r.data?.language || 'ja')
      setProvenance(r.data?.transcript || null)
      const map = {}
      for (const b of bs) map[b.kind] = (b.rows || []).map(row => ({ ...row }))
      setRowsByKind(map)
      setKind(bs.length ? bs[0].kind : null)
      setLoading(false)
    }).catch(e => { if (!cancelled) { setError(e.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [voiceId])

  const rows = (kind && rowsByKind[kind]) || []
  const setRowText = (i, text) =>
    setRowsByKind(m => ({ ...m, [kind]: m[kind].map((r, idx) => idx === i ? { ...r, text } : r) }))

  const handleSave = async (verified = false) => {
    if (!kind) return
    setSaving(true); setError(null); setSavedMsg(null)
    try {
      const r = await api(`/api/assets/${voiceId}/transcript`, {
        method: 'POST',
        body: { kind, verified, rows: rows.map(row => ({ audio_filename: row.audio_filename, text: row.text })) },
      })
      if (!r.ok) throw new Error(r.data?.error || 'Save failed')
      setSavedMsg(`Saved ${r.data?.changed ?? 0} change(s).`)
      if (onSaved) onSaved()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  const startRerunAsr = () => {
    if (onRerunAsr) onRerunAsr(kind === 'raw' ? 'raw' : 'slices')
    setConfirmAsr(false)
  }

  // Reading-proofing wiring for the focused line (text edits round-trip to the row).
  const proofText = proofIdx != null ? (rows[proofIdx]?.text || '') : ''
  const setProofText = (t) => { if (proofIdx != null) setRowText(proofIdx, t) }
  const panelLang = language
  const hanDir = hanOverrideDirection(language, language)

  const provLabel = provenance && provenance.source
    ? ({ machine_generated: 'Machine-generated', human_edited: 'Human-edited', human_verified: 'Human-verified' }[provenance.source] || provenance.source)
    : 'Unknown'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 860, width: '94%' }}>
        <div className="modal-hdr">Reference Transcript Proofing</div>
        <div className="modal-body">
          {/* Required scope notices (English, per product decision). */}
          <div className="field-note" style={{ marginBottom: 8 }}>
            This edit does not modify or retrain existing S1/S2 checkpoints.
          </div>
          <div className="field-note" style={{ marginBottom: 10, color: 'var(--muted)' }}>
            The updated transcript will be used when this audio is selected as an inference reference.
            Future refinement tasks created from the current asset data may also use the updated transcript.
          </div>

          {loading && <div className="field-hint">Loading transcript…</div>}
          {error && <div className="field-hint" style={{ color: 'var(--danger)' }}>{error}</div>}

          {!loading && buckets.length === 0 && !error && (
            <div className="field-hint">
              No reference transcript is available for this asset. Run ASR to create one?
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-sm btn-primary" disabled={asrRunning} onClick={() => setConfirmAsr(true)}>
                  Run ASR
                </button>
              </div>
            </div>
          )}

          {!loading && buckets.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                {buckets.length > 1 && (
                  <Select className="control control-sm" value={kind || ''} onChange={e => setKind(e.target.value)}>
                    {buckets.map(b => <option key={b.kind} value={b.kind}>{b.kind === 'raw' ? 'Raw' : 'Slices'} ({(b.rows || []).length})</option>)}
                  </Select>
                )}
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Source: {provLabel}{provenance && provenance.revision ? ` · rev ${provenance.revision}` : ''} · {rows.length} line(s) · {LANG_LABEL[language] || language}
                </span>
                {rows.some(r => typeof r.confidence === 'number') && (
                  <span style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    置信度：
                    <span style={{ color: CONF_COLORS.hi.fg }}>● 高</span>
                    <span style={{ color: CONF_COLORS.mid.fg }}>● 可疑</span>
                    <span style={{ color: CONF_COLORS.lo.fg }}>● 存疑</span>
                  </span>
                )}
              </div>

              <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                {rows.map((row, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ width: 150, flexShrink: 0 }}>
                      <div style={{ fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all' }}>{row.audio_filename}</div>
                      {row.url && <RowAudio url={row.url} />}
                      <ConfidenceBadge conf={row.confidence} />
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                      <textarea
                        className="control"
                        value={row.text}
                        onChange={e => setRowText(i, e.target.value)}
                        rows={2}
                        style={{ resize: 'vertical', fontSize: 13 }}
                      />
                      <WordConfidence words={row.words} />
                    </div>
                    <button
                      className="btn btn-sm btn-ghost"
                      style={{ flexShrink: 0 }}
                      onClick={() => { setPronOverrides({}); setProofIdx(i) }}
                      title="Open reading proofing for this line (saves pronunciations to the personal lexicon)"
                    >
                      Reading…
                    </button>
                  </div>
                ))}
              </div>

              {savedMsg && <div className="field-hint" style={{ color: 'var(--success)', marginTop: 8 }}>{savedMsg}</div>}

              {/* Secondary, explicit Re-run ASR action with a backup warning. */}
              <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                {!confirmAsr ? (
                  <button className="btn btn-sm btn-ghost" disabled={asrRunning} onClick={() => setConfirmAsr(true)}>
                    Re-run ASR…
                  </button>
                ) : (
                  <div className="field-hint" style={{ color: 'var(--warning)' }}>
                    Re-running ASR will create a new machine-generated transcript. Your current transcript will be backed up before replacement.
                    <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                      <button className="btn btn-sm btn-danger" disabled={asrRunning} onClick={startRerunAsr}>Back Up and Re-run ASR</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => setConfirmAsr(false)}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className="modal-ftr">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          {buckets.length > 0 && (
            <>
              <button className="btn" disabled={saving} onClick={() => handleSave(true)} title="Mark this transcript as human-verified">
                Save &amp; Mark Verified
              </button>
              <button className="btn btn-primary" disabled={saving} onClick={() => handleSave(false)}>
                {saving ? 'Saving…' : 'Save Transcript'}
              </button>
            </>
          )}
        </div>
      </div>

      {proofIdx != null && (
        <TextPrepModal
          onClose={() => setProofIdx(null)}
          text={proofText} setText={setProofText} panelLang={panelLang}
          pronOverrides={pronOverrides} setPronOverrides={setPronOverrides}
          hanDirection={hanDir} hanForced={hanForced} setHanForced={setHanForced}
          hanReadings={hanReadings} setHanReadings={setHanReadings}
        />
      )}
    </div>
  )
}
