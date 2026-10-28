import React from 'react'
import { STEPS, riskNotice } from './steps'
import { useT } from '../../../web/src/lib/i18n'

// 接入向导的五步流程图：按 STEPS 的顺序渲染步骤圆点、连线和锁定状态。
// 解锁判据是 done.prepare：克隆未完成时除第 1 步外全部禁用，禁用态附一句说明。
// 同时导出 RiskUnlock：把 steps.js 给当前步的风险提示包在子元素上方。

const GLYPH = { completed: '✓', running: '●', failed: '✗', pending: null }

function unlockedSteps (done) {
  const out = {}
  for (const st of STEPS) out[st.key] = true
  if (!done.prepare) for (const st of STEPS) if (st.key !== 'prepare') out[st.key] = false
  return out
}

export default function Pipeline ({ done, selected, onSelect }) {
  const { t, lang } = useT()
  const gate = unlockedSteps(done)
  return (
    <div className="pipe-map">
      {STEPS.map((st, i) => {
        const status = done[st.key] ? 'completed'
          : selected === st.key ? 'running' : 'pending'
        const glyph = GLYPH[status] === null ? String(i + 1) : GLYPH[status]
        const prevDone = i > 0 && done[STEPS[i - 1].key]
        const locked = !gate[st.key]
        return (
          <button key={st.key} type="button"
            className={`pipe-step${selected === st.key ? ' selected' : ''}${locked ? ' disabled-step' : ''}`}
            aria-pressed={selected === st.key}
            // 已经展开在下面那一步不该同时标成「锁着」：两者是矛盾的。
            aria-disabled={locked && selected !== st.key ? 'true' : undefined}
            // 锁的原因放悬停里：四枚锁着的步骤若各挂一句，流程条会被重复文案撑高，
            // 读起来也像是四个不同的毛病。
            title={locked ? t('Locked until the repository is cloned.', '克隆完成后解锁。') : undefined}
            onClick={() => onSelect(selected === st.key ? null : st.key, locked)}>
            {i > 0 && <span className={`pipe-seg${prevDone ? ' done' : ''}`} />}
            <span className={`pipe-dot ${status}`}>{glyph}</span>
            <span className={`pipe-label${status === 'running' ? ' running' : ''}`}>
              {lang === 'zh' ? st.label[1] : st.label[0]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function RiskUnlock ({ stepKey, onUnlock, unlocked, children, vars }) {
  const { t } = useT()
  const notice = riskNotice(stepKey, t, vars)
  if (!notice) return children || null
  // 配色语义：蓝=陈述，黄=警告（低风险），红=危险（不可撤回、终止进行中的操作）。
  const LEVEL_CLS = { info: 'msg-info', warn: 'msg-warn', danger: 'msg-danger' }
  return (
    <>
      <div className={`msg ${LEVEL_CLS[notice.level] || 'msg-info'}`}
        style={{ marginBottom: 0 }}>
        {notice.text}
      </div>
      <div className="confirm-actions" style={{ marginTop: 6 }}>
        {children}
      </div>
    </>
  )
}
