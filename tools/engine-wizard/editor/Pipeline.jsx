import React from 'react'
import { STEPS, riskNotice } from './steps'
import { useT } from '../../../web/src/lib/i18n'

// ---------------------------------------------------------------------------
//  流程条 —— 全部使用web/src/styles.css 的 .pipe-*，本文件不重定义任何一个。
//
//  交互照 TrainingTab 的 selectedNode：点一下展开那一步，再点收起。
//  ⛔ 不实现「下一步」按钮 —— 流程条是唯一的导航路径，不存在第二套。
//  ⛔ 本文件不许出现任何具体引擎名。
// ---------------------------------------------------------------------------

const GLYPH = { completed: '✓', running: '●', failed: '✗', pending: null }

/**
 * ⭐ 哪些步骤现在能点 —— 门槛：**克隆完成**才解锁后面四步。
 *
 * Owner 2026-10-12 裁决：克隆完成 = 引擎初步接入，此后后面四步才有意义。
 * 所以 prepare 没完成时，env / models / manifest / verify 一律不可点，
 * 点了给人话说明（⛔ 不是点进去一片空）。
 *
 * @param {object} done 各步骤的完成状态（来自 install-state 端点）
 * @returns {{[k:string]:boolean}} 步骤 key ⇒ 能不能点
 */
function unlockedSteps (done) {
  const out = {}
  for (const st of STEPS) out[st.key] = true
  // ⛔ 判据是 prepare 的完成态（真克隆了），⛔ 不是「用户点过克隆按钮」。
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
        // ⛔ 不可点的步骤仍然要能点（点了解释为什么），但样式上要看得出来
        //   —— 项目已有 .pipe-step.disabled-step，⛔ 不自造类。
        const locked = !gate[st.key]
        return (
          <button key={st.key} type="button"
            className={`pipe-step${selected === st.key ? ' selected' : ''}${locked ? ' disabled-step' : ''}`}
            aria-pressed={selected === st.key}
            aria-disabled={locked ? 'true' : undefined}
            onClick={() => onSelect(selected === st.key ? null : st.key, locked)}>
            {i > 0 && <span className={`pipe-seg${prevDone ? ' done' : ''}`} />}
            <span className={`pipe-dot ${status}`}>{glyph}</span>
            <span className={`pipe-label${status === 'running' ? ' running' : ''}`}>
              {lang === 'zh' ? st.label[1] : st.label[0]}
            </span>
            {locked && (
              <span className="field-hint">
                {t('Locked until the repository is cloned.',
                  '克隆完成后解锁。')}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 危险动作的「风险告知 + 显式解锁」
 *
 * 照 TrainingTab.jsx:570-583 的 expert-unlock：说清后果 + 解锁后才执行。
 *
 * ⛔ 告知 ≠ 拦阻：这里**不套盒子**、**不加「我了解风险」复选框**、按钮不disabled。
 *   clone 就是 git clone —— 为人人都会做的事加一道「我了解」门槛是仪式，
 *   不是保护；而那一次点击也保护不了任何东西。
 *   真需要确认的操作放在真正不可逆的地方，不是每一步都放。
 *   ⇒ 保留下面这段 .msg（用户该知道会发生什么），去掉拦阻。
 * ⛔ 不套 .confirm-card：它带一圈 380px 边框，与向导的容器宽度冲突。
 *   .confirm-actions 本来是给弹窗的无框排版，也不当容器用。
 *
 * @param {string} stepKey
 * @param {{[k:string]:string}} [vars] 填进文案的具体名字与路径
 */
export function RiskUnlock ({ stepKey, onUnlock, unlocked, children, vars }) {
  const { t } = useT()
  // vars 透传：风险文案要填具体的项目名与完整路径
  const notice = riskNotice(stepKey, t, vars)
  if (!notice) return children || null
  return (
    <>
      <div className={`msg ${notice.level === 'warn' ? 'msg-warn' : 'msg-danger'}`}
        style={{ marginBottom: 0 }}>
        {notice.text}
      </div>
      <div className="confirm-actions" style={{ marginTop: 6 }}>
        {children}
      </div>
    </>
  )
}
