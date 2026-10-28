// RecoveryBanner.jsx — 失败任务恢复横幅
//
// 任务失败或中断后，顶部出现的恢复条。
// 两种模式：原地续跑（复用失败点之前的产物）或分叉成新任务
// （参数被改过、或重启点前移到已完成步骤时必须分叉，否则会复用旧缓存、
// 悄悄忽略用户的修改）。
import { Select } from '../common/Select'
import { useT } from '../../lib/i18n'
import { FSTEP_LABELS } from './trainConstants'

export function RecoveryBanner({
  recovery,
  recoveryMode,
  forkByParamChange,
  earliestChangedStep,
  rerunStart,
  rerunStepOptions,
  failedIsTrain,
  restartFailedStep,
  setRestartFailedStep,
  setRerunStart,
  onCancelRecovery,
}) {
  const { t: tr } = useT()

  if (!recovery) return null

  return (
    <div className={`resume-banner ${recoveryMode === 'modify' ? 'resume-banner-fork' : 'resume-banner-continue'}`}>
      <div className="resume-banner-hdr">
        <span className="resume-banner-title">
          {recoveryMode === 'modify' ? tr('↳ Resume as a NEW task (fork)', '↳ 作为新任务恢复（分叉）') : tr('↻ Resume in place', '↻ 原地恢复')}
        </span>
        <button className="btn btn-sm btn-ghost" onClick={onCancelRecovery}>{tr('Exit resume', '退出恢复')}</button>
      </div>
      <p className="resume-banner-body">
        {recoveryMode === 'modify'
          ? <>{forkByParamChange
                ? tr(
                  <>You changed <strong>{FSTEP_LABELS[earliestChangedStep]}</strong> settings. That step runs <strong>before</strong> the failure point,
                   so its output must be regenerated — an in-place resume would reuse the old cache and silently ignore your change.
                   This therefore launches a <strong>brand-new task</strong> (fork) and re-runs from <strong>{FSTEP_LABELS[rerunStart]}</strong>.</>,
                  <>已修改 <strong>{FSTEP_LABELS[earliestChangedStep]}</strong> 的设置。该步骤在失败点<strong>之前</strong>运行，
                   因此它的输出必须重新生成：原地恢复会复用旧缓存并忽略该修改。
                   所以这里会启动一个<strong>全新任务</strong>（分叉），并从 <strong>{FSTEP_LABELS[rerunStart]}</strong> 重新运行。</>)
                : tr(
                  <>You moved the restart point to an earlier, already-completed step (<strong>{FSTEP_LABELS[rerunStart]}</strong>).
                   Changing a completed step means it must be re-run, so this launches a <strong>brand-new task</strong> (fork).</>,
                  <>重启点已移到一个更早、已完成的步骤（<strong>{FSTEP_LABELS[rerunStart]}</strong>）。
                   修改已完成的步骤意味着必须重新运行，因此这里会启动一个<strong>全新任务</strong>（分叉）。</>)}
               {' '}{tr(
                 <>Only the products of steps <strong>before {FSTEP_LABELS[rerunStart]}</strong> are copied to the new task — so make sure you have enough <strong>disk space</strong> for them.
                 The original failed task is kept untouched, and even if this fork succeeds it will publish as a NEW task, not a recovery of the old one.</>,
                 <>只有 <strong>{FSTEP_LABELS[rerunStart]} 之前</strong>步骤的产物会被复制到新任务，所以请确保有足够的<strong>磁盘空间</strong>。
                 原来的失败任务保持不变，即使这个分叉成功，它也会作为一个新任务发布，而不是对旧任务的恢复。</>)}</>
          : tr(
            <>Continuing failed task <code>{recovery.sourceTaskId}</code> from the <strong>{FSTEP_LABELS[recovery.failedStep]}</strong> step,
             reusing everything before it. Same task, same workspace.
             {recovery.failedAt && recovery.failedAt.reason && <><br/><span className="resume-reason">Why it failed: {recovery.failedAt.reason}</span></>}</>,
            <>从 <strong>{FSTEP_LABELS[recovery.failedStep]}</strong> 步骤继续失败任务 <code>{recovery.sourceTaskId}</code>，
             复用它之前的所有产物。同一任务，同一工作区。
             {recovery.failedAt && recovery.failedAt.reason && <><br/><span className="resume-reason">失败原因：{recovery.failedAt.reason}</span></>}</>)}
      </p>
      <div className="resume-controls">
        <label className="field-label" style={{ margin: 0 }}>{tr('Restart from', '从此处重启')}</label>
        <Select className="control control-inline" value={rerunStart}
                onChange={e => setRerunStart(e.target.value)}>
          {rerunStepOptions.map(s => (
            <option key={s} value={s}>{FSTEP_LABELS[s]}{s === recovery.failedStep ? tr(' (failed step)', '（失败的步骤）') : tr(' (redo completed step)', '（重做已完成的步骤）')}</option>
          ))}
        </Select>
        {recoveryMode === 'continue' && failedIsTrain && (
          <label className="toggle-row" style={{ margin: 0 }}>
            <input type="checkbox" checked={restartFailedStep} onChange={e => setRestartFailedStep(e.target.checked)} />
            {tr('Restart this training from scratch (ignore saved checkpoint)', '从零重新开始本次训练（忽略已保存的 checkpoint）')}
          </label>
        )}
      </div>
    </div>
  )
}
