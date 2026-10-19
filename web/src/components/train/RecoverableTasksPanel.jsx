// RecoverableTasksPanel.jsx — 失败任务列表
//
// 从 TrainingTab.jsx 搬出：默认折叠的「恢复失败的任务」面板。
// 列出缓存里失败 / 中断的任务，点「恢复」把流程从失败点续上。
// 成功发布的运行会在发布后自动清理，不会出现在这里。
import { useT } from '../../lib/i18n'
import { FSTEP_LABELS } from './trainConstants'

export function RecoverableTasksPanel({
  visible,
  recoverOpen,
  recoverList,
  recoverLoading,
  activeSourceTaskId,
  onToggle,
  onResume,
}) {
  const { t: tr } = useT()

  if (!visible) return null

  return (
    <div className="recover-panel">
      <button type="button" className="recover-toggle" onClick={onToggle}>
        <span className="recover-caret">{recoverOpen ? '▾' : '▸'}</span>
        {tr('Recover a failed run', '恢复失败的任务')}
        {recoverList.length > 0 && <span className="recover-count">{recoverList.length}</span>}
      </button>
      {recoverOpen && (
        <div className="recover-body">
          {recoverLoading && <p className="field-hint">{tr('Loading…', '加载中…')}</p>}
          {!recoverLoading && recoverList.length === 0 && (
            <p className="field-hint">{tr('No failed or interrupted tasks in the cache. Everything is clean.', '缓存中没有失败或中断的任务。一切正常。')}</p>
          )}
          {!recoverLoading && recoverList.length > 0 && (
            <table className="recover-table">
              <thead>
                <tr><th>{tr('Voice', '音色')}</th><th>{tr('Lang', '语言')}</th><th>{tr('Failed at', '失败于')}</th><th>{tr('Reason', '原因')}</th><th>{tr('When', '时间')}</th><th></th></tr>
              </thead>
              <tbody>
                {recoverList.map(t => (
                  <tr key={t.id} className={activeSourceTaskId === t.id ? 'recover-row-active' : ''}>
                    <td>{t.voiceId || <span className="field-hint">—</span>}</td>
                    <td>{t.language || '—'}</td>
                    <td>
                      <span className="badge badge-danger">{FSTEP_LABELS[t.resumeStep] || t.resumeStep || t.status}</span>
                    </td>
                    <td className="recover-reason" title={t.failedAt && t.failedAt.reason || ''}>
                      {(t.failedAt && t.failedAt.reason) || (t.status === 'interrupted' ? tr('Interrupted', '已中断') : tr('Unknown', '未知'))}
                    </td>
                    <td className="recover-when">{t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—'}</td>
                    <td>
                      <button className="btn btn-sm btn-primary" onClick={() => onResume(t)}
                        disabled={activeSourceTaskId === t.id}>
                        {activeSourceTaskId === t.id ? tr('Selected', '已选择') : tr('Resume', '恢复')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="field-hint" style={{ marginTop: 6 }}>
            {tr('Only failed / interrupted tasks appear here. Successful runs are cleaned up automatically after publishing.',
                '这里只显示失败 / 中断的任务。成功的运行在发布后会被自动清理。')}
          </p>
        </div>
      )}
    </div>
  )
}
