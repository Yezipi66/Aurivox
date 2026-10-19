// UndoClone.jsx — 撤销克隆
//
// 克隆完成后会删掉 engines/<id>/ 那一棵，让使用者回到第 1 步重来。
// 放在第 1 步与第 2 步都能用：克隆完成即跳到第 2 步，
// 使用者在那儿才真正看到「下一步该做什么」，
// 想反悔时手边就得有这条路。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

export function UndoClone ({ engineId, onUndone, label }) {
  const { t } = useT()
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)

  if (!engineId) return null

  const undo = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/wizard/clone/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: engineId }),
      })
      const j = await r.json()
      if (j.ok) {
        if (onUndone) onUndone(j)
      } else {
        setErr(j.error || j.errorZh || t('Cannot remove the directory.', '删不掉该目录。'))
      }
    } catch (e) {
      setErr((e && e.message) || String(e))
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button className="btn btn-sm" type="button"
        disabled={busy}
        onClick={undo}>
        {busy
          ? t('Removing…', '正在清除…')
          : (label || t('Undo clone', '撤销克隆'))}
      </button>
      {err && <span className="msg msg-error" style={{ margin: 0 }}>{err}</span>}
    </div>
  )
}
