import React from 'react'
import { STEPS, riskNotice } from './steps'
import { useT } from '../../../web/src/lib/i18n'

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

export function RiskUnlock ({ stepKey, onUnlock, unlocked, children, vars }) {
  const { t } = useT()
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
