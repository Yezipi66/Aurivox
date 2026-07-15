// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { basename, recipeNameError } from '../../lib/format'

function SaveRecipeModal({ open, onClose, source, role, defaults, onSaved }) {
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)

  useEffect(() => { if (open) { setName(''); setNotes(''); setError(null); setBusy(false); setConfirmOverwrite(false) } }, [open])
  if (!open) return null

  const nameErr = name ? recipeNameError(name) : null
  const d = defaults || {}
  const previewId = role && name.trim() ? `${role}/${name.trim()}` : '—'

  const doSave = async (force) => {
    const err = recipeNameError(name)
    if (err) { setError(err); return }
    if (!role) { setError('No voice selected'); return }
    if (!d.reference_audio) { setError('No reference audio to save'); return }
    setBusy(true); setError(null)
    const payload = {
      role, name: name.trim(),
      reference_audio: d.reference_audio,
      reference_text: d.reference_text || '',
      language: d.language || 'ja',
      params: d.params || {},
      gpt_ckpt: d.gpt_ckpt || '',
      sovits_pth: d.sovits_pth || '',
      meta: { source: source || 'generate', notes: notes.trim() },
      force: !!force,
    }
    try {
      const r = await api('/api/recipes', { method: 'POST', body: payload })
      if (r.status === 409 && !force) { setConfirmOverwrite(true); setBusy(false); return }
      if (!r.ok) throw new Error((r.data && r.data.error) || `Server error ${r.status}`)
      setBusy(false)
      onSaved && onSaved(r.data.recipe)
      onClose && onClose()
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose && onClose()}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div className="modal-hdr">Save as recipe</div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">Name (emotion / identifier)</label>
            <input className="control" value={name} autoFocus placeholder="e.g. calm, angry, cheerful"
              onChange={e => setName(e.target.value)} />
            {nameErr && <div className="field-hint" style={{ color: 'var(--danger)' }}>{nameErr}</div>}
          </div>
          <div className="recipe-preview">
            <div><span className="rp-k">Voice</span><span className="rp-v">{role || '—'}</span></div>
            <div><span className="rp-k">OpenAI voice</span><code className="rp-code">{previewId}</code></div>
            <div><span className="rp-k">Reference</span><span className="rp-v" title={d.reference_audio}>{basename(d.reference_audio)}</span></div>
            <div><span className="rp-k">GPT</span><span className="rp-v" title={d.gpt_ckpt}>{d.gpt_ckpt ? basename(d.gpt_ckpt) : '(none)'}</span></div>
            <div><span className="rp-k">SoVITS</span><span className="rp-v" title={d.sovits_pth}>{d.sovits_pth ? basename(d.sovits_pth) : '(none)'}</span></div>
          </div>
          <div className="field">
            <label className="field-label">Notes (optional)</label>
            <input className="control" value={notes} onChange={e => setNotes(e.target.value)} placeholder="free text" />
          </div>
          {error && <div className="msg msg-error">{error}</div>}
          {confirmOverwrite && (
            <div className="msg msg-warn">
              A recipe named <strong>{previewId}</strong> already exists. Overwrite it?
              <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => doSave(true)}>Overwrite</button>
                <button className="btn btn-sm" disabled={busy} onClick={() => setConfirmOverwrite(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        <div className="modal-ftr">
          <button className="btn btn-sm" disabled={busy} onClick={() => onClose && onClose()}>Cancel</button>
          {!confirmOverwrite && (
            <button className="btn btn-sm btn-primary" disabled={busy || !!nameErr || !name.trim()} onClick={() => doSave(false)}>
              {busy ? 'Saving…' : 'Save recipe'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ===========================
//  GENERATE TAB
// ===========================

// Reusable secondary-confirmation modal (replaces the browser's native
// window.confirm, which is unstyled/ugly). Reuses .modal-overlay/.modal-card.
function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger = false, busy = false, icon = null, onConfirm, onCancel }) {
  if (!open) return null
  return (
    <div className="modal-overlay" onClick={busy ? undefined : onCancel}>
      <div className="modal-card confirm-card" onClick={e => e.stopPropagation()}>
        <div className="confirm-hdr">
          {icon}
          <span>{title}</span>
        </div>
        <div className="confirm-body">{message}</div>
        <div className="confirm-actions">
          <button className="btn btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={'btn btn-sm ' + (danger ? 'btn-danger' : 'btn-primary')} onClick={onConfirm} disabled={busy}>
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// Reusable in-app file picker (PC). Reuses the cross-platform /api/fs/browse
// endpoint in file mode (?files=.ckpt,.pth) so a model file can be chosen from
// anywhere, then handed back as an absolute path (the server converts it to a
// project-relative path on save, or rejects it if outside the project).
function FsFilePicker({ open, exts, title, startPath, onPick, onClose }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const extsParam = (exts || []).join(',')

  const go = async (p) => {
    setBusy(true); setError(null)
    try {
      const r = await api(`/api/fs/browse?path=${encodeURIComponent(p || '')}&files=${encodeURIComponent(extsParam)}`)
      if (r.ok) setData(r.data)
      else setError((r.data && r.data.error) || 'Could not open that folder')
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  useEffect(() => { if (open) { setData(null); go(startPath || '') } }, [open]) // eslint-disable-line
  if (!open) return null

  const rowStyle = { padding: '4px 10px', fontSize: 12, cursor: 'pointer', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-hdr">{title || 'Select a file'}</div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
            <button className="btn btn-sm" disabled={busy || data?.isDriveList || data?.parent == null}
              onClick={() => go(data?.parent || '')}>↑ Up</button>
            <input className="control" readOnly
              value={data?.isDriveList ? 'Select a drive…' : (data?.path || '')} />
          </div>
          {error && <div className="msg msg-error">{error}</div>}
          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
            {busy && <div style={{ padding: 8, color: 'var(--muted)' }}>Loading…</div>}
            {!busy && data?.isDriveList && (data.drives || []).map(d => (
              <div key={d.path} style={rowStyle} onClick={() => go(d.path)}>💽 {d.name}</div>
            ))}
            {!busy && !data?.isDriveList && (data?.dirs || []).map(d => (
              <div key={d.path} style={rowStyle} onClick={() => go(d.path)}>📁 {d.name}</div>
            ))}
            {!busy && !data?.isDriveList && (data?.files || []).map(f => (
              <div key={f.path} style={{ ...rowStyle, color: 'var(--accent)' }}
                onClick={() => { onPick(f.path); onClose() }}>📄 {f.name}</div>
            ))}
            {!busy && !data?.isDriveList && (data?.dirs || []).length === 0 && (data?.files || []).length === 0 && (
              <div style={{ padding: 8, color: 'var(--muted)' }}>No sub-folders or matching files here.</div>
            )}
          </div>
          <div className="field-hint" style={{ marginTop: 6 }}>Showing folders and <code>{extsParam}</code> files.</div>
        </div>
        <div className="modal-ftr">
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export {
  SaveRecipeModal,
  ConfirmDialog,
  FsFilePicker,
}
