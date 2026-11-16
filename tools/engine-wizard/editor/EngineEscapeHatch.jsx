// 每一步的引擎目标选择器，切换即全局重定向。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import Select from '../../../web/src/components/common/Select'

// 全局逃生口：选择向导作用在哪台引擎目录上。
//
// 之前顶部有一个「当前引擎」下拉，但「当前」读起来像状态，而它实际是
// 自由切换的全局目标选择器（绑 wz.id，完成状态、权重路径、会话段、名片
// 编辑对象全跟它走），与各步骤的编辑对象不一致。改为在每一步各放一个
// 同样的下拉，明确它是「操作哪台」的选择器，切换即全局重定向。
//
// 只渲染一个下拉（一列），不套第二列：选择器与逃生口是同一个东西。
// 但「选了」不等于「切了」：下拉只暂存选择，提交要走「切换引擎」按钮，
// 点完再过一道二次确认。切换会放弃当前页面的操作记录并按新引擎
// 重新读取，是不可轻率进行的动作；静默切换会让使用者在不知情下丢掉
// 已填的内容。二级弹窗给一次反悔的余地：只有确认才继续。
//
// 按钮常驻，不再按暂存值是否变化来隐藏：动作必须始终可见才可预期。
// 没有换成另一台时按钮禁用，并在 title 写清原因；提交成功后就地给出
// 一条状态反馈，只说「切到了哪台」。
// 反馈不提本步内容的时态：逃生口是五步共用的，不知道当前是哪一步，
//   也不掌握那一步的请求何时回来。「正在读」没有终点，「已读完」抢在
//   数据前面，两句都没证据。内容状态由各步界面自己显示（右下角状态条
//   按真实完成状态判断），这里只陈述自己确证的事实。
// 反馈显示外层传进来的 id（实际生效的目标），不是提交瞬间的暂存值：
//   切换若被别处回滚，暂存值就成了一条看起来很确定的假消息。
// dirs 由外层传入（App 已用 useEngineDirs 取过一次，不重复请求）。
// onSwitch(id) 由外层决定怎么落（App 里是 switchEngine：换目标并重读状态）。

export default function EngineEscapeHatch ({ id, dirs, onSwitch }) {
  const { t } = useT()
  // 暂存的选择：与已提交的目标（id）分开记，没提交前不算数。
  const [pending, setPending] = React.useState(id || '')
  // 外部目标变了（提交成功、克隆完成）⇒ 暂存同步过去。
  React.useEffect(() => { setPending(id || '') }, [id])
  // 没选（占位项）或没换目标，都不算一次待提交的切换。
  const dirty = !!pending && pending !== id
  const [confirming, setConfirming] = React.useState(false)
  // 提交期间的进行态与成功后的反馈：切换不再是一个静默动作。
  const [busy, setBusy] = React.useState(false)
  const [switched, setSwitched] = React.useState(false)

  const submit = async () => {
    setConfirming(false)
    if (!dirty || !onSwitch) return
    setBusy(true)
    setSwitched(false)
    try {
      await onSwitch(pending)
      setSwitched(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label className="field-label" style={{ margin: 0 }} id="wz-escape-pick-label">
          {t('Engine target', '操作引擎')}
        </label>
        <Select id="wz-escape-pick" className="control" style={{ minWidth: 240 }}
          aria-labelledby="wz-escape-pick-label"
          value={pending}
          onChange={(e) => { setPending(e.target.value); setSwitched(null) }}>
          <option value="">
            {t('Pick a directory under engines/', '选择 engines/ 下的目录')}
          </option>
          {(dirs || []).map((d) => (
            <option key={d.id} value={d.id}>{d.id}</option>
          ))}
        </Select>
        {/* 按钮常驻：动作存在与否不该取决于当前恰好选了什么。
            没换成另一台时禁用，title 说明原因，而不是把按钮藏起来。 */}
        <button className="btn btn-primary btn-sm" type="button"
          data-wz-switch="engine"
          disabled={!dirty || busy}
          title={dirty ? '' : t('Pick a different engine first', '先在上方选一台不同的引擎')}
          onClick={() => setConfirming(true)}>
          {busy ? t('Switching…', '切换中…') : t('Switch engine', '切换引擎')}
        </button>
      </div>

      {switched && (
        <div className="msg msg-info" style={{ marginTop: 6 }}>
          {t('Switched to', '已切换到')} <code>{id}</code>
          {t('.', '。')}
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
