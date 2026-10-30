import React from 'react'
import { STEPS, riskNotice } from './steps'
import { useT } from '../../../web/src/lib/i18n'

// 接入向导的五步流程图：按 STEPS 的顺序渲染步骤圆点、连线和完成状态。
// 五步一律可点，不锁：锁的判据原本是「第 1 步完成」，而完成状态由真实产物判
//   （GET /wizard/install-state），它与界面上看到的不一致时（界面显示已克隆、
//   后端判未克隆）人会被卡在第 1 步，且无从自救。
//   逃生口改成顶部的引擎下拉：对哪台引擎操作由使用者自己指定。
// 同时导出 RiskUnlock：把 steps.js 给当前步的风险提示包在子元素上方。

const GLYPH = { completed: '✓', running: '●', failed: '✗', pending: null }

export default function Pipeline ({ done, selected, onSelect }) {
  const { lang } = useT()
  return (
    <div className="pipe-map">
      {STEPS.map((st, i) => {
        const status = done[st.key] ? 'completed'
          : selected === st.key ? 'running' : 'pending'
        const glyph = GLYPH[status] === null ? String(i + 1) : GLYPH[status]
        const prevDone = i > 0 && done[STEPS[i - 1].key]
        return (
          <button key={st.key} type="button"
            className={`pipe-step${selected === st.key ? ' selected' : ''}`}
            aria-pressed={selected === st.key}
            onClick={() => onSelect(selected === st.key ? null : st.key)}>
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
