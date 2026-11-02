// Small presentational bits for the Generate page: voice-option labels plus the
// seed display and the per-segment collapsible list. Seed badges show the RESOLVED
// seed the engine actually used (never -1) with one-click copy.
import { useState } from 'react'
import { API_BASE } from '../../lib/api'
import { Player } from '../common/Player'

// Voice dropdown label. Builtin voices show only their display name. For a
// fine-tuned voice we append the id ONLY when it differs from the display name —
// otherwise the option reads redundantly as "Akafuyu (Akafuyu) [zh]" (item 14).
function voiceOptionLabel(v) {
  if (!v) return ''
  if (v.builtin) return v.display_name
  const name = v.display_name || v.id
  const idPart = (v.id && v.id !== name) ? ` (${v.id})` : ''
  const langPart = v.language ? ` [${v.language}]` : ''
  return `${name}${idPart}${langPart}`
}

// Cross-asset model source picker (issue #3). A compact secondary dropdown under a
// GPT / SoVITS selector that lets the checkpoint be sourced from ANY asset that has
// that model kind, enabling mixes like "A's GPT + B's SoVITS". '' = this voice.
// Reproducibility: a small inline badge that displays the RESOLVED seed (the
// concrete value the engine actually used, never -1) with one-click copy.
// Renders nothing for a missing/random seed.
function SeedBadge({ seed }) {
  const [copied, setCopied] = useState(false)
  if (seed === undefined || seed === null || seed === -1) return null
  const copy = () => {
    try {
      navigator.clipboard?.writeText(String(seed))
      setCopied(true); setTimeout(() => setCopied(false), 1200)
    } catch { /* ignore */ }
  }
  return (
    <span className="seed-badge" title="Resolved seed used for this generation — click to copy">
      <span className="seed-badge-label">seed</span>
      <button type="button" className="seed-badge-val" onClick={copy}
        title="Click to copy this seed">{seed}{copied ? ' ✓' : ''}</button>
    </span>
  )
}

// Compact inline seed for dense meta lines: bold, hover-highlighted, click-to-copy.
function SeedInline({ seed }) {
  const [copied, setCopied] = useState(false)
  if (seed === undefined || seed === null || seed === -1) return null
  const copy = (e) => {
    e.stopPropagation()
    try {
      navigator.clipboard?.writeText(String(seed))
      setCopied(true); setTimeout(() => setCopied(false), 1200)
    } catch { /* ignore */ }
  }
  return (
    <button type="button" className="seed-inline" onClick={copy}
      title="Resolved seed for this generation — click to copy">
      seed <strong>{seed}</strong>{copied ? ' ✓' : ''}
    </button>
  )
}

function CollapsibleSegments({ segments }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="collapsible">
      <div className="collapsible-hdr" onClick={() => setOpen(!open)}>
        <span>Segments ({segments.length})</span>
        <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-12)' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="collapsible-body">
          {segments.map(seg => (
            <div key={seg.index} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginBottom: 8 }}>
              <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>Segment {seg.index}</div>
              <div style={{ fontSize: 'var(--fs-13)', marginBottom: 6 }}>{seg.text}</div>
              <Player src={`${API_BASE}${seg.audio_url}`} size="sm" />
              <a href={`${API_BASE}${seg.audio_url}`} download style={{ color: 'var(--accent)', fontSize: 'var(--fs-12)', display: 'inline-block', marginTop: 4 }}>Download</a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export {
  voiceOptionLabel,
  SeedBadge,
  SeedInline,
  CollapsibleSegments,
}
