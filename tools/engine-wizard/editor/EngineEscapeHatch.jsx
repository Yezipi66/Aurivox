import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// 全局逃生口：选择向导作用在哪台引擎目录上。
//
// 只渲染一个下拉（一列），不套第二列：选择器与逃生口是同一个东西。
// 但「选了」不等于「切了」：下拉只暂存选择，提交要走右下的「切换引擎」
//   按钮，点完再过一道二次确认。切换会放弃当前页面的操作记录并按新引擎
//   重新读取，是不可轻率进行的动作；静默切换会让使用者在不知情下丢掉
//   已填的内容。二级弹窗给一次反悔的余地：只有确认才继续。
// dirs 由外层传入（App 已用 useEngineDirs 取过一次，不重复请求）。
// onSwitch(id) 由外层决定怎么落（App 里是 switchEngine：换目标并重读状态）。

export default function EngineEscapeHatch ({ id, dirs, onSwitch }) {
  const { t } = useT()
  // 暂存的选择：与已提交的目标（id）分开记，没提交前不算数。
  const [pending, setPending] = React.useState(id || '')
  // 外部目标变了（提交成功、克隆完成）⇒ 暂存同步过去，按钮行收掉。
  React.useEffect(() => { setPending(id || '') }, [id])
  // 没选（占位项）不算一次待提交的切换：空目标不该能提交。
  const dirty = !!pending && pending !== id
  const [confirming, setConfirming] = React.useState(false)

  const submit = () => {
    setConfirming(false)
    if (onSwitch) onSwitch(pending)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label className="field-label" style={{ margin: 0 }} htmlFor="wz-escape-pick">
          {t('Engine target', '操作引擎')}
        </label>
        <select id="wz-escape-pick" className="control" style={{ minWidth: 240 }}
          value={pending}
          onChange={(e) => setPending(e.target.value)}>
          <option value="">
            {t('Pick a directory under engines/', '选择 engines/ 下的目录')}
          </option>
          {(dirs || []).map((d) => (
            <option key={d.id} value={d.id}
              style={d.usable ? { color: '#4caf50', fontWeight: 600 } : undefined}>
              {d.usable ? '✓ ' : ''}{d.id}
            </option>
          ))}
        </select>
        <span className="field-hint" style={{ margin: 0 }}>
          {t('Pick a directory under engines/, then submit it with the "Switch engine" button. '
            + 'Submitting discards everything on this page and reloads that engine.',
            '选择 engines/ 下的目录后，点右下的「切换引擎」提交。'
            + '提交会放弃当前页面的所有操作，按新引擎重新读取。')}
          {' '}
          {t('A green check marks an engine that is usable (has a valid manifest and weights ready).',
            '绿勾 = 这台能用（有名片且底模就绪）。')}
        </span>
      </div>

      {/* 选了与当前不同的引擎，才出现提交按钮（右对齐） */}
      {dirty && (
        <div className="confirm-actions" style={{ marginTop: 8 }}>
          <button className="btn btn-primary btn-sm" type="button"
            onClick={() => setConfirming(true)}>
            {t('Switch engine', '切换引擎')}
          </button>
        </div>
      )}

      {confirming && dirty && (
        <div className="modal-overlay" onClick={() => setConfirming(false)}>
          <div className="modal-card confirm-card"
            style={{ maxWidth: 520, padding: 20 }}
            onClick={(e) => e.stopPropagation()}>
            <div className="confirm-hdr">
              <span>{t('Switch the wizard to this engine?', '将向导切换到这台引擎？')}</span>
            </div>
            <div className="confirm-body">
              <p style={{ marginTop: 0 }}>
                {t('Target', '目标')} <code>{pending}</code>
              </p>
              <p style={{ marginBottom: 0 }}>
                {t('This discards everything on the current page and reloads that engine '
                  + 'from disk. Continue?',
                  '会放弃当前页面的所有操作，并按新引擎重新读取。是否继续？')}
              </p>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-sm" type="button"
                onClick={() => setConfirming(false)}>
                {t('Cancel', '取消')}
              </button>
              <button className="btn btn-primary btn-sm" type="button"
                onClick={submit}>
                {t('Confirm switch', '确认切换')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
