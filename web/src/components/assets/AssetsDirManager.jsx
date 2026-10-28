// AssetsDirManager.jsx — 资源目录迁移与选择
//
// 切换资源根目录的三块界面。
// ① 迁移选择：当前目录非空时，询问这批数据怎么处理（只切换 / 复制 / 移动）。
// ② 迁移进度：后台复制 → 校验 → 删除原文件的流水线。
// ③ 文件夹浏览器：应用内选目录，跨平台可用。
//
// 「只切换」是推荐项：内置复制会被占用文件（已加载的模型、打开的资源管理器）卡住，
// 这类锁很难恢复。只有确定没有文件被占用时才用复制 / 移动。
import { IconFolder } from '../common/Icons'

export function MigrateChoiceDialog({
  migrateTarget,
  assetCount,
  configBusy,
  onApply,
  onCancel,
}) {
  if (!migrateTarget) return null
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={() => { if (!configBusy) onCancel() }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: 24, minWidth: 380, maxWidth: 520,
        boxShadow: 'var(--shadow-soft)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <IconFolder size={20} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 'var(--fs-14)' }}>Change Assets Directory</span>
        </div>
        <p style={{ fontSize: 'var(--fs-13)', color: 'var(--text)', marginBottom: 8 }}>
          New directory:
        </p>
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', background: 'var(--bg)', padding: '6px 8px', borderRadius: 4, wordBreak: 'break-all', marginBottom: 14 }}>
          {migrateTarget}
        </div>
        <p style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', marginBottom: 12 }}>
          The current assets directory contains <strong>{assetCount}</strong> voice{assetCount === 1 ? '' : 's'}.
          What should happen to that data? Changes take effect after a server restart.
        </p>
        <div className="migrate-advisory">
          <strong>Recommended:</strong> choose <em>Switch only</em>, then copy the data yourself
          in your file manager and restart. The built-in copy can stall or fail on files that are
          in use (a loaded model, an open Explorer/audio window), and such locks are hard to
          recover from. Use Copy/Move only when you're sure nothing here is open.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button className="btn btn-primary" disabled={configBusy} onClick={() => onApply(migrateTarget, 'switch')}
            style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
            ➡️ Switch only (recommended) — point at the new directory, migrate the data yourself
          </button>
          <button className="btn" disabled={configBusy} onClick={() => onApply(migrateTarget, 'copy')}
            style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
            📋 Copy — duplicate existing voices into the new directory (keep originals)
          </button>
          <button className="btn" disabled={configBusy} onClick={() => onApply(migrateTarget, 'move')}
            style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
            ✂️ Move — copy, verify, then delete originals (skips locked files check → may fail)
          </button>
          <button className="btn btn-ghost" disabled={configBusy} onClick={onCancel}
            style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
            ✕ Cancel
          </button>
        </div>
        {configBusy && <div style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', marginTop: 12 }}>Starting…</div>}
      </div>
    </div>
  )
}

export function MigrateProgressDialog({ migrateJob, onClose }) {
  if (!migrateJob) return null
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={() => { if (migrateJob.done) onClose() }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: 24, minWidth: 420, maxWidth: 560,
        boxShadow: 'var(--shadow-soft)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <IconFolder size={20} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 'var(--fs-14)' }}>
            {migrateJob.migration === 'move' ? 'Moving' : 'Copying'} assets
          </span>
        </div>
        <div className="migrate-steps">
          {['copy', ...(migrateJob.migration === 'move' ? ['verify', 'delete'] : [])].map(k => {
            const label = k === 'copy' ? 'Copy' : k === 'verify' ? 'Verify integrity' : 'Delete originals'
            const st = migrateJob.steps?.[k] || 'pending'
            const mark = st === 'done' ? '✓' : st === 'running' ? '⋯' : st === 'failed' ? '✕' : '○'
            return (
              <div key={k} className={`migrate-step migrate-step-${st}`}>
                <span className="migrate-step-mark">{mark}</span>
                <span className="migrate-step-label">{label}</span>
                {st === 'running' && migrateJob.total > 0 && (
                  <span className="migrate-step-count">{migrateJob.current}/{migrateJob.total}</span>
                )}
              </div>
            )
          })}
        </div>
        {!migrateJob.done && migrateJob.currentName && (
          <div className="migrate-current" title={migrateJob.currentName}>
            {migrateJob.phase}: {migrateJob.currentName}
          </div>
        )}
        {migrateJob.done && migrateJob.error && (
          <div className="msg msg-error" style={{ marginTop: 12 }}>
            {migrateJob.error}
            <div style={{ marginTop: 6, fontSize: 'var(--fs-12)' }}>
              Nothing was deleted from your current directory. Close anything using these files
              (loaded models, open Explorer/audio windows) and retry, or use Switch only and copy manually.
            </div>
          </div>
        )}
        {migrateJob.done && !migrateJob.error && (
          <div className="msg msg-success" style={{ marginTop: 12 }}>{migrateJob.note || 'Done. Restart to apply.'}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-sm" disabled={!migrateJob.done} onClick={onClose}>
            {migrateJob.done ? 'Close' : 'Working…'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function FolderBrowser({
  open,
  browseData,
  browseBusy,
  browseError,
  onBrowseTo,
  onPathChange,
  onCreateSubfolder,
  onMkdirThenOpen,
  onChoose,
  onClose,
}) {
  if (!open) return null
  return (
    <div className="fs-browser-overlay" onClick={onClose}>
      <div className="fs-browser" onClick={e => e.stopPropagation()}>
        <div className="fs-browser-hdr">
          <IconFolder size={18} color="var(--accent)" />
          <span className="fs-browser-title">Choose assets directory</span>
          <button className="btn-icon" title="Close" onClick={onClose}>✕</button>
        </div>
        <div className="fs-browser-path">
          <button className="btn btn-sm"
            title={browseData?.parent === '' ? 'Back to drive list' : 'Up one level'}
            disabled={browseBusy || browseData?.isDriveList || browseData?.parent == null}
            onClick={() => onBrowseTo(browseData?.parent ?? '')}>
            {browseData?.parent === '' ? '↑ Drives' : '↑ Up'}
          </button>
          <input className="assets-dir-input" style={{ flex: 1 }}
            value={browseData?.isDriveList ? '' : (browseData?.path || '')}
            placeholder={browseData?.isDriveList ? 'Select a drive…' : 'Path…'}
            onChange={e => onPathChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onBrowseTo(e.target.value) }}
            title="Type a path and press Enter, or double-click a folder below" />
          <button className="btn btn-sm" disabled={browseBusy}
            onClick={() => onBrowseTo(browseData?.path || '')}>Go</button>
          <button className="btn btn-sm" title="Create a new sub-folder here"
            disabled={browseBusy || browseData?.isDriveList || !browseData?.path}
            onClick={onCreateSubfolder}>+ New</button>
        </div>
        <div className="fs-browser-list">
          {browseBusy && <div className="fs-browser-empty">Loading…</div>}
          {!browseBusy && browseError && (
            <div className="fs-browser-error">
              <div>{browseError}</div>
              {browseData?.path && !browseData?.isDriveList && (
                <button className="btn btn-sm" style={{ marginTop: 8 }}
                  onClick={() => onMkdirThenOpen(browseData.path)}>
                  Create “{browseData.path}”
                </button>
              )}
            </div>
          )}
          {!browseBusy && !browseError && browseData?.isDriveList && browseData.drives.map(d => (
            <div key={d.path} className="fs-browser-item" onClick={() => onBrowseTo(d.path)}>
              <IconFolder size={14} color="var(--muted)" /> <span>{d.name}</span>
            </div>
          ))}
          {!browseBusy && !browseError && !browseData?.isDriveList && (browseData?.dirs?.length
            ? browseData.dirs.map(d => (
                <div key={d.path} className="fs-browser-item" onClick={() => onBrowseTo(d.path)}>
                  <IconFolder size={14} color="var(--muted)" /> <span>{d.name}</span>
                </div>
              ))
            : <div className="fs-browser-empty">No sub-folders here.</div>)}
        </div>
        <div className="fs-browser-ftr">
          <span className="fs-browser-current" title={browseData?.path || ''}>
            {browseData?.isDriveList ? 'Pick a drive to open' : (browseData?.path || '')}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary btn-sm"
              disabled={browseBusy || browseData?.isDriveList || !browseData?.path}
              onClick={onChoose}>Use this folder</button>
          </div>
        </div>
      </div>
    </div>
  )
}
