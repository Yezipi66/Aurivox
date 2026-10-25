import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// 第 4 步的页面骨架：左侧边条、中栏、右侧边条，三根平级的骨头。
//
// 这三个容器不在同一个大盒子里：它们是页面自己的三根骨头，
// 不是一张卡片里的三个格子。外层只有一个 flex 行，没有任何
// 带边框、带圆角、带背景的容器把它们套起来。
//
// 左右两根边条默认收成 32px，只露一个方向箭头：
//   左边条露出「→」，表示「往里看还有东西」；
//   右边条露出「←」，同理。
// 默认不展开，是因为第 4 步进来时两边的内容都还没准备好：
// 左边还没扫过参数，右边还没选引擎。两个空盒子摆在首屏上，
// 是噪音，不是信息。点一下箭头，那一根边条变成抽屉滑出来，
// 抽屉上盖一层半透明遮罩，点遮罩或再点箭头就收回去。
//
// 中栏是这页的主角：flex 撑满剩下的宽度，里面的内容另有宽度上限，
// 免得在超宽屏上字段拉得太开、读起来要来回扫视。

/** 收着时边条占的宽度。 */
const RAIL_W = '32px'
/** 展开时抽屉占的宽度。 */
const DRAWER_W = '360px'

/**
 * 第 4 步的三根骨头。
 *
 * @param {React.ReactNode} left 左边条里的内容（扫到的参数）
 * @param {React.ReactNode} center 中栏（当前名片）
 * @param {React.ReactNode} right 右边条里的内容（当前项目的前端预览）
 * @param {object} open 哪边抽屉开着 {left, right}
 * @param {Function} onToggle 开合某一边的抽屉
 */
export default function Stage ({ left, center, right, open, onToggle }) {
  const { t } = useT()
  const leftOpen = !!open.left
  const rightOpen = !!open.right

  return (
    <div className="wz-stage">
      <Drawer
        side="left"
        open={leftOpen}
        onToggle={() => onToggle('left')}
        title={t('Scanned parameters', '扫到的参数')}
        arrow="→"
      >
        {left}
      </Drawer>

      <main className="wz-stage-main">{center}</main>

      <Drawer
        side="right"
        open={rightOpen}
        onToggle={() => onToggle('right')}
        title={t('Preview', '预览')}
        arrow="←"
      >
        {right}
      </Drawer>

      {/* 遮罩：抽屉开着时盖住中栏，点它收回去。
          z-index 高于抽屉 ⇒ 抽屉本身仍然可点。 */}
      {(leftOpen || rightOpen) && (
        <div className="wz-stage-scrim" onClick={() => onToggle(leftOpen ? 'left' : 'right')} />
      )}
    </div>
  )
}

/**
 * 一根边条。收着的时候只有一条窄边与一个箭头；展开时是抽屉。
 *
 * @param {string} side 'left' 或 'right'
 * @param {boolean} open 抽屉是否展开
 * @param {Function} onToggle 开合
 * @param {string} title 抽屉的标题与无障碍标签
 * @param {string} arrow 收着时露出的箭头
 * @param {React.ReactNode} children 抽屉里的内容
 */
function Drawer ({ side, open, onToggle, title, arrow, children }) {
  const { t } = useT()
  return (
    <aside
      className={`wz-drawer wz-drawer-${side}${open ? ' is-open' : ''}`}
      aria-label={title}
    >
      <button
        className="wz-drawer-handle"
        type="button"
        onClick={onToggle}
        title={open ? t('Close', '收起') : title}
        aria-label={open ? t('Close', '收起') : title}
        aria-expanded={open}
      >
        {open ? '×' : arrow}
      </button>
      {open && <div className="wz-drawer-body">{children}</div>}
    </aside>
  )
}

export { RAIL_W, DRAWER_W }
