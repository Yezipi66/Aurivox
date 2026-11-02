// AssetsDialogs.jsx — 资源页的独立弹窗与空状态
//
// 从 AssetsTab.jsx 搬出：删除确认的遮罩弹窗，以及没有任何资源时的空状态引导。
import { IconTrash } from '../common/Icons'

export function DeleteAssetDialog({ target, deleting, onConfirm, onCancel }) {
  if (!target) return null
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onCancel}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: 24, minWidth: 320, maxWidth: 420,
        boxShadow: 'var(--shadow-soft)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <IconTrash size={20} color="var(--danger)" />
          <span style={{ fontWeight: 600, fontSize: 'var(--fs-14)' }}>Delete Asset</span>
        </div>
        <p style={{ fontSize: 'var(--fs-13)', color: 'var(--text)', marginBottom: 8 }}>
          Confirm deletion of <strong>{target.displayName}</strong>?
        </p>
        <p style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', marginBottom: 16 }}>
          This will permanently delete the asset folder and its voice configuration.
          This action cannot be undone.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" onClick={onCancel} disabled={deleting}>Cancel</button>
          <button className="btn btn-sm btn-danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AssetsEmptyState({ scanning, onCancelScan, onScan, onStartTuning }) {
  return (
    <div className="empty-state">
      <div className="es-title">No voice assets yet</div>
      <div className="es-sub">Scan the assets directory to detect voices, or fine-tune a new voice to get started.</div>
      <div className="empty-actions">
        {scanning ? (
          <button className="btn btn-sm btn-danger" onClick={onCancelScan}>
            Cancel Scan
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" onClick={onScan}>Scan Dataset</button>
        )}
        <button className="btn btn-sm" onClick={onStartTuning}>Start Tuning</button>
      </div>
    </div>
  )
}
