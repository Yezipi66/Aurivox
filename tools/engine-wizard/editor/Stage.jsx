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
// 再点箭头（或点抽屉里的 ×）就收回去。
//
// 抽屉推开时中栏会被压窄，但中栏照常能点、能填表、能接收拖拽：
// 这三样东西是同时用着的，左边扫参、中间填表、右边看预览。
// 抽屉上面不盖遮罩：遮罩会把中栏挡住，点中栏就收抽屉，
// 等于一打开抽屉表单就废了。再点箭头才收。
//
// 中栏是这页的主角：flex 撑满剩下的宽度，里面的内容对齐平台的大容器
// （max-width 1400px），免得在超宽屏上字段拉得太开。
//
// 整个骨架铺满页面宽度，不受 .workspace-container 的 1400px 限制：
//   边条贴着视口两边，不是贴着主容器两边。
// 两根边条 sticky 在视口里：页面往下滚，边条跟着走，
//   拖拽的源（左）和预览（右）任何时候都在眼前。
// 右边条可以再放大一档到平台前端的宽度：预览要按平台真实尺寸看才有意义，
//   360px 的抽屉里看到的是被挤坏的版式。

/** 收着时边条占的宽度。 */
const RAIL_W = '32px'
/** 展开时抽屉占的宽度。 */
const DRAWER_W = '360px'
/** 右边条放大后的宽度上限：平台前端主容器的宽度。 */
const WIDE_MAX = '1400px'
/**
 * 右边条放大后，中栏至少要留的宽度。
 * 中栏是填表的地方，压到这么窄表单就没法用了。
 */
const CENTER_MIN = '480px'
/**
 * 右边条放大后的宽度。
 *
 * 要给中栏留够宽度，而中栏剩多少取决于左栏此刻占多宽：
 * 左栏收着是 32px 的边条，展开是 360px 的抽屉。
 * 只按 32px 算 ⇒ 左抽屉开着时中栏会被压到 152px，表单没法用。
 * 所以这个宽度由 CSS 按实际占位算（见 editor.css 的 --wz-drawer-w-wide）。
 */
const DRAWER_W_WIDE = `min(${WIDE_MAX}, calc(100vw - var(--wz-left-w, 32px) - ${CENTER_MIN}))`

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
  // 放大只是界面状态，收起右边条时一并还原。
  const [wide, setWide] = React.useState(false)
  React.useEffect(() => { if (!rightOpen) setWide(false) }, [rightOpen])

  return (
    <div className={`wz-stage${leftOpen ? ' wz-stage-left-open' : ''}`}>
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
        wide={wide}
        extra={(
          <button className="wz-drawer-handle" type="button"
            onClick={() => setWide((w) => !w)}
            aria-pressed={wide}
            title={wide ? t('Back to drawer width', '还原为抽屉宽度') : t('Expand to the platform width', '放大到平台前端尺寸')}
            aria-label={wide ? t('Back to drawer width', '还原为抽屉宽度') : t('Expand to the platform width', '放大到平台前端尺寸')}>
            {wide ? '⇥' : '⇤'}
          </button>
        )}
      >
        {right}
      </Drawer>

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
 * @param {boolean} wide 是否放大到平台前端宽度（只有右边条用）
 * @param {React.ReactNode} extra 展开时箭头旁的额外按钮
 * @param {React.ReactNode} children 抽屉里的内容
 */
function Drawer ({ side, open, onToggle, title, arrow, wide, extra, children }) {
  const { t } = useT()
  return (
    <aside
      className={`wz-drawer wz-drawer-${side}${open ? ' is-open' : ''}${open && wide ? ' is-wide' : ''}`}
      aria-label={title}
    >
      <div className="wz-drawer-handles">
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
        {open && extra}
      </div>
      {open && <div className="wz-drawer-body">{children}</div>}
    </aside>
  )
}

export { RAIL_W, DRAWER_W, DRAWER_W_WIDE }
