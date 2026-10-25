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
  // 哪几栏可以收起：只有左右两栏。中栏是填名片的地方，收起它等于把
  // 工作区藏起来，那不是「收起一栏」而是「关掉这一页」。
  { key: 'left', labelEn: 'Scanned parameters', labelZh: '扫到的参数', collapsible: true },
  { key: 'center', labelEn: 'Manifest', labelZh: '名片内容', collapsible: false },
  { key: 'right', labelEn: 'Preview', labelZh: '预览', collapsible: true },
]

/**
 * 一栏的外壳：标题 + 收起按钮 + 内容。
 * 收起时内容不渲染（不是隐藏）：参数池与预览都带着自己的 state，
 * 留着不渲染才能在收起再展开后保留用户刚才的滚动位置与选择。
 *
 * @param {string} zone 栏位标识，用来算 className
 * @param {boolean} collapsed 这一栏是否收起
 * @param {boolean} collapsible 这一栏能不能收起
 * @param {Function} onToggle 收起/展开的回调
 * @param {string} labelEn 英文标题
 * @param {string} labelZh 中文标题
 * @param {React.ReactNode} children 栏内内容
 */
function Zone ({ zone, collapsed, collapsible, onToggle, labelEn, labelZh, children }) {
  const { t } = useT()
  return (
    <div className={`wz-zone wz-zone-${zone}${collapsed ? ' is-collapsed' : ''}`}>
      <div className="wz-zone-hdr">
        <span className="wz-zone-title">{t(labelEn, labelZh)}</span>
        {/* 箭头用项目现成的 ▸ / ▾（web/src/components/compare/CompareBatchCard.jsx
            与 tools/engine-wizard/editor/StepDeps.jsx 都是这两个）。
            不用 < 和 >：那两个是 HTML 的标签分隔符，
            在按钮里当图标看着像「上一级」，不是「收起」。 */}
        {collapsible && (
          <button className="btn btn-sm btn-ghost wz-zone-toggle" type="button"
            onClick={onToggle}
            title={collapsed ? t('Expand', '展开') : t('Collapse', '收起')}
            aria-label={collapsed ? t('Expand', '展开') : t('Collapse', '收起')}
            aria-expanded={!collapsed}>
            {collapsed ? '▸' : '▾'}
          </button>
        )}
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

  // 收起的栏把宽度让出来：左栏收起后中栏变宽，右栏收起后中栏也变宽。
  // 列宽在这里算，不写死在 CSS 里：CSS 写死的三列不知道哪一栏被收了。
  // 中栏永远是 minmax(0, 1fr) ⇒ 收起哪一栏，那一栏的宽度都归中栏。
  //
  // 收起后留一条 40px 的窄轨，不给 0：0 宽会把展开按钮也一起藏掉，
  // 那一栏就再也展不开了。窄轨是项目自己的做法（flowgraph 的 Rail 用 26px）。
  const COLLAPSED_W = '40px'
  const leftW = collapsed.left ? COLLAPSED_W : '260px'
  const rightW = collapsed.right ? COLLAPSED_W : '380px'

  return (
    <div className="wz-three-zone"
      style={{ gridTemplateColumns: `${leftW} minmax(0, 1fr) ${rightW}` }}>
      {ZONES.map((z) => (
        <Zone key={z.key} zone={z.key}
          collapsed={!!collapsed[z.key]}
          collapsible={z.collapsible}
          onToggle={() => toggle(z.key)}
          labelEn={z.labelEn} labelZh={z.labelZh}>
          {slots[z.key]}
        </Zone>
      ))}
    </div>
  )
}

