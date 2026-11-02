// TrainingStatusPanel.jsx — 训练运行状态区
//
// 从 TrainingTab.jsx 搬出：任务运行中 / 已完成 / 被中断时的状态显示。
// 等待人工审阅时挂对应的审阅面板（人声试听 / ASR 校对），
// 审阅面板认为前端版本旧时给一句重建提示。
import { DenoiseReviewPanel, AsrReviewPanel } from './ReviewPanels'
import { useT } from '../../lib/i18n'

export function TrainingStatusPanel({
  taskId,
  status,
  form,
  engineId,
  isRunning,
  isAwaitingReview,
  isInterrupted,
  isFinished,
  onCancel,
  onReset,
  onResumed,
}) {
  const { t: tr } = useT()

  if (!taskId) return null
  if (!status) {
    return <div className="msg" style={{ marginTop: 10 }}>{tr('Restoring training state…', '正在恢复训练状态…')}</div>
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 'var(--fs-14)', fontWeight: 600 }}>
          {status.status === 'completed' ? tr('Completed', '已完成')
           : status.status === 'failed' ? tr('Failed', '失败')
           : status.status === 'cancelled' ? tr('Cancelled', '已取消')
           : status.status === 'interrupted' ? tr('Interrupted', '已中断')
           : status.status === 'awaiting_review' ? (status.reviewStage === 'denoise' ? tr('Awaiting audition', '等待试听') : tr('Awaiting proofreading', '等待校对'))
           : tr('Tuning…', '微调中…')}
        </span>
        {(isRunning || isAwaitingReview) && (
          <button className="btn btn-sm btn-danger" onClick={onCancel}>Cancel</button>
        )}
      </div>
      {isAwaitingReview && status?.reviewStage === 'denoise' && (
        <DenoiseReviewPanel taskId={taskId}
          onResumed={onResumed}
          onCancel={onCancel} />
      )}
      {isAwaitingReview && status?.reviewStage !== 'denoise' && status?.reviewStage !== 'asr' && (
        <div className="msg msg-warn" style={{ margin: '8px 0' }}>
          {tr('Paused for review. If this looks stuck, the web build is stale — rebuild the frontend (npm run build) so the audition/proofreading panel loads.',
              '已暂停等待校对。若卡住无法继续，说明前端构建是旧的：请重新构建前端（npm run build）以加载试听/校对面板。')}
        </div>
      )}
      {isAwaitingReview && status?.reviewStage === 'asr' && (
        <AsrReviewPanel taskId={taskId} engineId={engineId} lang={status?.language || form.language} onResumed={onResumed} />
      )}
      {isInterrupted && (
        <div className="msg msg-error" style={{ marginBottom: 8 }}>
          {tr('Tuning was interrupted. Go Back, then use “Recover a failed run” to resume it from where it stopped.',
              '微调被中断。请点击“返回”，然后用“恢复失败的任务”从中断处继续。')}
        </div>
      )}
      {isFinished && (
        <button className="btn btn-sm btn-primary" style={{ marginTop: 4 }} onClick={onReset}>{tr('Back', '返回')}</button>
      )}
    </div>
  )
}
