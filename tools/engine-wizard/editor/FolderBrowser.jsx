import React from 'react'

// 应用内文件夹浏览器：与主界面 assets 迁移同一套（.fs-browser），
// 目录数据走平台 /api/fs/browse（向导 vite 已代理 /api → 9886）。
// 选中一个目录 → onChoose(绝对路径)。
export default function FolderBrowser ({ open, onChoose, onClose }) {
  const [path, setPath] = React.useState('')
  const [data, setData] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)

  const load = async (p) => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/fs/browse?path=${encodeURIComponent(p || '')}`)
      const j = await r.json().catch(() => null)
      if (j && j.ok) setData(j.data || j)
      else setErr((j && j.error) || `HTTP ${r.status}`)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  React.useEffect(() => { if (open) { setPath(''); setData(null); load('') } }, [open])
  if (!open) return null

  const isDriveList = data && data.isDriveList
  const dirs = (data && data.dirs) || []
  const drives = (data && data.drives) || []

  return (
    <div className="fs-browser-overlay" onClick={onClose}>
      <div className="fs-browser" onClick={(e) => e.stopPropagation()}>
        <div className="fs-browser-hdr">
          <span className="fs-browser-title">选择存放目录</span>
          <button className="btn-icon" title="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="fs-browser-path">
          <button className="btn btn-sm"
            title={data && data.parent === '' ? '返回盘符列表' : '上一级'}
            disabled={busy || isDriveList || !data || data.parent == null}
            onClick={() => load((data && data.parent) ?? '')}>
            {data && data.parent === '' ? '↑ 盘符' : '↑ 上一级'}
          </button>
          <input className="assets-dir-input" style={{ flex: 1 }}
            value={isDriveList ? '' : ((data && data.path) || '')}
            placeholder={isDriveList ? '先选一个盘符…' : '路径…'}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setPath(e.target.value); load(e.target.value) } }} />
          <button className="btn btn-sm" disabled={busy} onClick={() => load(path || (data && data.path) || '')}>前往</button>
        </div>
        <div className="fs-browser-list">
          {busy && <div className="fs-browser-empty">读取中…</div>}
          {!busy && err && <div className="fs-browser-error">{err}</div>}
          {!busy && !err && isDriveList && drives.map((d) => (
            <div key={d.path} className="fs-browser-item" onClick={() => load(d.path)}>
              <span>{d.name}</span>
            </div>
          ))}
          {!busy && !err && !isDriveList && (dirs.length
            ? dirs.map((d) => (
                <div key={d.path} className="fs-browser-item" onClick={() => load(d.path)}>
                  <span>{d.name}</span>
                </div>
              ))
            : <div className="fs-browser-empty">这里没有子目录</div>)}
        </div>
        <div className="fs-browser-ftr">
          <span className="fs-browser-current" title={(data && data.path) || ''}>
            {isDriveList ? '先选一个盘符' : ((data && data.path) || '')}
          </span>
          <div style={{ display: 'flex', gap: 'var(--sp-6)' }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>取消</button>
            <button className="btn btn-primary btn-sm"
              disabled={busy || isDriveList || !(data && data.path)}
              onClick={() => onChoose(data.path)}>用这个目录</button>
          </div>
        </div>
      </div>
    </div>
  )
}
