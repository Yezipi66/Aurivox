// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { basename, recipeNameError, TARGET_LANG_OPTIONS, defaultTargetLang } from '../../lib/format'
import { useT } from '../../lib/i18n'

// A recipe's pinned language must be an explicit, conscious choice: the reading
// of shared Han characters (中日) depends entirely on it. `null` if the value is
// not one of the offered options.
const _canonicalLang = (v) => (TARGET_LANG_OPTIONS.some(o => o.value === v) ? v : null)
// A concrete (non-auto) asset language means we can preselect confidently and
// skip the warning; anything else (auto / auto_zh_ja / blank / unknown) means the
// asset carries no definite language, so we default to auto AND warn.
const _isConcreteLang = (v) =>
  ['all_zh', 'all_ja', 'en', 'all_ko', 'all_yue', 'zh', 'ja', 'ko', 'yue'].includes(String(v || ''))

function SaveRecipeModal({ open, onClose, source, role, defaults, onSaved }) {
  const { t } = useT()
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [language, setLanguage] = useState('auto')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)

  const d = defaults || {}
  // Preselect the asset's current language; if it can't be determined, fall back
  // to 'auto' and surface a strong warning (below) so the user picks knowingly.
  const _assetLang = d.language
  const _initLang = _canonicalLang(_assetLang) || defaultTargetLang(_assetLang)
  const langIsFallback = !_isConcreteLang(_assetLang)

  useEffect(() => {
    if (open) { setName(''); setNotes(''); setLanguage(_initLang || 'auto'); setError(null); setBusy(false); setConfirmOverwrite(false) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null

  const nameErr = name ? recipeNameError(name) : null
  const previewId = role && name.trim() ? `${role}/${name.trim()}` : '—'

  const doSave = async (force) => {
    const err = recipeNameError(name)
    if (err) { setError(err); return }
    if (!role) { setError(t('No voice selected', '未选择 Voice')); return }
    if (!d.reference_audio) { setError(t('No reference audio to save', '没有可保存的参考音频')); return }
    if (!language) { setError(t('Please choose a language', '请选择语言')); return }
    setBusy(true); setError(null)
    const payload = {
      role, name: name.trim(),
      reference_audio: d.reference_audio,
      reference_text: d.reference_text || '',
      language,
      params: d.params || {},
      gpt_ckpt: d.gpt_ckpt || '',
      sovits_pth: d.sovits_pth || '',
      meta: { source: source || 'generate', notes: notes.trim() },
      force: !!force,
    }
    try {
      const r = await api('/api/recipes', { method: 'POST', body: payload })
      if (r.status === 409 && !force) { setConfirmOverwrite(true); setBusy(false); return }
      if (!r.ok) throw new Error((r.data && r.data.error) || t(`Server error ${r.status}`, `服务器错误 ${r.status}`))
      setBusy(false)
      onSaved && onSaved(r.data.recipe)
      onClose && onClose()
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose && onClose()}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div className="modal-hdr">{t('Save as recipe', '保存为 recipe')}</div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">{t('Name (emotion / identifier)', '名称（emotion / 标识符）')}</label>
            <input className="control" value={name} autoFocus placeholder={t('e.g. calm, angry, cheerful', '例如 calm、angry、cheerful')}
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
            <label className="field-label">{t('Language (required)', '语言（必选）')}</label>
            <select className="control" value={language} onChange={e => setLanguage(e.target.value)}>
              {TARGET_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <div className="field-hint">
              {t('Pinned as the recipe\u2019s target-text language. It decides how shared Han characters (\u4e2d\u65e5) are read.',
                 '固定为该 recipe 的目标文本语言，决定共享汉字（中日）如何朗读。')}
            </div>
            {langIsFallback && (
              <div className="msg msg-warn" style={{ marginTop: 6 }}>
                {t('\u26a0 This asset has no definite language, so the default is \u201cAuto\u201d. Auto guesses per segment and may mis-read pure-Han text. Please pick the correct language deliberately.',
                   '\u26a0 该资产没有明确语言，已默认置为「自动」。自动模式按分段猜测，纯汉字文本可能读错，请谨慎手动选择正确的语言。')}
              </div>
            )}
          </div>
          <div className="field">
            <label className="field-label">{t('Notes (optional)', '备注（可选）')}</label>
            <input className="control" value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('free text', '自由文本')} />
          </div>
          {error && <div className="msg msg-error">{error}</div>}
          {confirmOverwrite && (
            <div className="msg msg-warn">
              {t(<>A recipe named <strong>{previewId}</strong> already exists. Overwrite it?</>,
                 <>已存在名为 <strong>{previewId}</strong> 的 recipe。是否覆盖？</>)}
              <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => doSave(true)}>{t('Overwrite', '覆盖')}</button>
                <button className="btn btn-sm" disabled={busy} onClick={() => setConfirmOverwrite(false)}>{t('Cancel', '取消')}</button>
              </div>
            </div>
          )}
        </div>
        <div className="modal-ftr">
          <button className="btn btn-sm" disabled={busy} onClick={() => onClose && onClose()}>{t('Cancel', '取消')}</button>
          {!confirmOverwrite && (
            <button className="btn btn-sm btn-primary" disabled={busy || !!nameErr || !name.trim() || !language} onClick={() => doSave(false)}>
              {busy ? t('Saving…', '保存中…') : t('Save recipe', '保存 recipe')}
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
function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel, danger = false, busy = false, icon = null, onConfirm, onCancel }) {
  const { t } = useT()
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
          <button className="btn btn-sm" onClick={onCancel} disabled={busy}>{cancelLabel || t('Cancel', '取消')}</button>
          <button className={'btn btn-sm ' + (danger ? 'btn-danger' : 'btn-primary')} onClick={onConfirm} disabled={busy}>
            {busy ? '…' : (confirmLabel || t('Confirm', '确认'))}
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
  const { t } = useT()
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const extsParam = (exts || []).join(',')

  const go = async (p) => {
    setBusy(true); setError(null)
    try {
      const r = await api(`/api/fs/browse?path=${encodeURIComponent(p || '')}&files=${encodeURIComponent(extsParam)}`)
      if (r.ok) setData(r.data)
      else setError((r.data && r.data.error) || t('Could not open that folder', '无法打开该文件夹'))
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  useEffect(() => { if (open) { setData(null); go(startPath || '') } }, [open]) // eslint-disable-line
  if (!open) return null

  const rowStyle = { padding: '4px 10px', fontSize: 12, cursor: 'pointer', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-hdr">{title || t('Select a file', '选择文件')}</div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
            <button className="btn btn-sm" disabled={busy || data?.isDriveList || data?.parent == null}
              onClick={() => go(data?.parent || '')}>↑ {t('Up', '上一级')}</button>
            <input className="control" readOnly
              value={data?.isDriveList ? t('Select a drive…', '选择驱动器…') : (data?.path || '')} />
          </div>
          {error && <div className="msg msg-error">{error}</div>}
          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
            {busy && <div style={{ padding: 8, color: 'var(--muted)' }}>{t('Loading…', '加载中…')}</div>}
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
              <div style={{ padding: 8, color: 'var(--muted)' }}>{t('No sub-folders or matching files here.', '此处没有子文件夹或匹配的文件。')}</div>
            )}
          </div>
          <div className="field-hint" style={{ marginTop: 6 }}>{t(<>Showing folders and <code>{extsParam}</code> files.</>, <>显示文件夹与 <code>{extsParam}</code> 文件。</>)}</div>
        </div>
        <div className="modal-ftr">
          <button className="btn btn-sm" onClick={onClose}>{t('Cancel', '取消')}</button>
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
