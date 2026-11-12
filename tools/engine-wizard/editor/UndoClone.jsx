// UndoClone.jsx — 撤销克隆
//
// 克隆完成后会删掉 engines/<id>/ 那一棵，让使用者回到第 1 步重来。
// 放在第 1 步与第 2 步都能用：克隆完成即跳到第 2 步，
// 使用者在那儿才真正看到「下一步该做什么」，想反悔时手边就得有这条路。
//
// 删的是整棵目录（含已装好的环境与权重），不可撤回，所以两段式：
// 第一次点变成「确认删除」，并把将要删掉的路径写出来；再点一次才真的删。
// 只按一下红按钮就删掉一台引擎的代价太大，而这个按钮离「下一步」只有几十像素。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

export function UndoClone ({ engineId, target, onUndone, label }) {
  const { t } = useT()
  const [busy, setBusy] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
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
        setConfirming(false)
        if (onUndone) onUndone(engineId, j)
      } else {
        setErr(j.error || j.errorZh || t('Cannot remove the directory.', '无法删除该目录。'))
      }
    } catch (e) {
      setErr((e && e.message) || String(e))
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {/* 红色：删掉整个引擎目录，不可撤回。点第一次只是进入确认态。 */}
      <button className="btn btn-sm btn-danger" type="button"
        disabled={busy}
        onClick={() => {
          if (!confirming) { setConfirming(true); setErr(null); return }
          undo()
        }}>
        {busy
          ? t('Removing…', '正在清除…')
          : (confirming
              ? t('Click again to delete', '再点一次，确认删除')
              : (label || t('Undo clone', '撤销克隆')))}
      </button>
      {confirming && !busy && (
        <span className="field-hint" style={{ margin: 0 }}>
          {t('This removes the whole directory, including any environment and weights inside: ',
            '这会删掉整棵目录，包括里面已装好的环境与权重：')}
          <code>{target || ('engines/' + engineId)}</code>
        </span>
      )}
      {err && <span className="msg msg-danger" style={{ margin: 0 }}>{err}</span>}
    </div>
  )
}
