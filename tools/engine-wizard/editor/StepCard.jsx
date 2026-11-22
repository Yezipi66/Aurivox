// 五步共用的一张步骤大框：卡片头放步骤名、完成态与关闭，卡片体放该步内容。
// 外壳一律走平台的 .section 三件套；这里只负责把头部的固定形状收成一份，
// 避免每一步各写一遍 .section-wz-step-card 而各自漂移。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

/**
 * @param {string} title 步骤名
 * @param {boolean} done 该步是否完成
 * @param {Function} onClose 关闭该步
 * @param {React.ReactNode} action 自定义头部右侧；给了就替代完成徽标与关闭按钮（收起态用）
 * @param {React.ReactNode} children 卡片体内容
 */
export default function StepCard ({ title, done, onClose, action, children }) {
  const { t } = useT()
  return (
    <div className="section wz-step-card">
      <div className="section-hdr">
        <span className="wz-step-title">{title}</span>
        {action !== undefined ? action : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`badge ${done ? 'badge-ok' : 'badge-neutral'}`}>
              {done ? t('Done', '已完成') : t('In progress', '进行中')}
            </span>
            <button className="btn btn-sm" type="button" onClick={onClose}>
              {t('Close', '关闭')}
            </button>
          </div>
        )}
      </div>
      <div className="section-body wz-step-body">
        {children}
      </div>
    </div>
  )
}
