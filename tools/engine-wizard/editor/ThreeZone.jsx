import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// 三栏骨架：左栏扫到的参数、中栏当前名片内容、右栏当前项目的前端预览。
//
// 三栏各自可收起，收起后由剩下的栏占满宽度。收起状态只存在组件 state 里，
// 不落盘：下次打开这一页时回到展开态，避免记住一个上次没看完的状态。
//
// 布局用项目现成的 .workspace-grid > .workspace-left + .workspace-right。
// 三栏时 grid-template-columns 要多一列，而 .workspace-grid 在 styles.css 里
// 写死两列 ⇒ 这里自己定义 .wz-three-zone（editor.css 里），不重画项目容器。

const ZONES = [
  { key: 'left', labelEn: 'Scanned parameters', labelZh: '扫到的参数' },
  { key: 'center', labelEn: 'Manifest', labelZh: '名片内容' },
  { key: 'right', labelEn: 'Preview', labelZh: '预览' },
]

/**
 * 一栏的外壳：标题 + 收起按钮 + 内容。
 * 收起时内容不渲染（不是隐藏）：参数池与预览都带着自己的 state，
 * 留着不渲染才能在收起再展开后保留用户刚才的滚动位置与选择。
 *
 * @param {string} zone 栏位标识，用来算 className
 * @param {boolean} collapsed 这一栏是否收起
 * @param {Function} onToggle 收起/展开的回调
 * @param {string} labelEn 英文标题
 * @param {string} labelZh 中文标题
 * @param {React.ReactNode} children 栏内内容
 */
function Zone ({ zone, collapsed, onToggle, labelEn, labelZh, children }) {
  const { t } = useT()
  return (
    <div className={`wz-zone wz-zone-${zone}`}>
      <div className="wz-zone-hdr">
        <span className="wz-zone-title">{t(labelEn, labelZh)}</span>
        <button className="btn btn-sm btn-ghost" type="button"
          onClick={onToggle}
          title={collapsed ? t('Expand', '展开') : t('Collapse', '收起')}
          aria-expanded={!collapsed}>
          {collapsed ? '>' : '<'}
        </button>
      </div>
      {!collapsed && (
        <div className="wz-zone-body">
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * 三栏容器。
 *
 * @param {React.ReactNode} left 左栏内容（扫到的参数）
 * @param {React.ReactNode} center 中栏内容（当前名片内容）
 * @param {React.ReactNode} right 右栏内容（当前项目的前端预览）
 */
export default function ThreeZone ({ left, center, right }) {
  const [collapsed, setCollapsed] = React.useState({ left: false, right: false })

  const toggle = (key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

  const slots = { left, center, right }

  return (
    <div className="wz-three-zone">
      {ZONES.map((z) => (
        <Zone key={z.key} zone={z.key}
          collapsed={!!collapsed[z.key]}
          onToggle={() => toggle(z.key)}
          labelEn={z.labelEn} labelZh={z.labelZh}>
          {slots[z.key]}
        </Zone>
      ))}
    </div>
  )
}

