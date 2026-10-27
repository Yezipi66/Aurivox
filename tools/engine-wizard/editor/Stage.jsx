import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { clampPreviewWidth, PREVIEW_DEFAULT } from './drawerWidth'

// 第 4 步的页面骨架：左侧边条、中栏、右侧边条，三根平级的骨头，外层只有一个 flex 行，
// 没有带边框圆角背景的容器把它们套起来；骨架铺满视口，不受主容器 1400px 限制。
//
// 两根边条默认收成 32px 只露方向箭头：进来时两边内容都还没准备好，两个空盒子是噪音。
// 抽屉推开时中栏被压窄，但照常能点、能填表、能接拖拽，所以抽屉上不盖遮罩——
// 遮罩会让点中栏变成收抽屉，一打开抽屉表单就废了；再点箭头才收。
// 两根边条 sticky 在视口里：拖拽的源（左）与预览（右）任何时候都在眼前。
// 中栏 flex 撑满剩下的宽度，内容对齐平台的大容器（max-width 1400px）。
//
// 右边条（预览）宽度可调：拖左边缘的分隔条改宽，拖的那一刻在 JS 里夹一次，之后左抽屉
// 开合与视口变化由 CSS 的 max-width 兜住，中栏始终留 320px；「全屏」按钮把预览铺满
// 视口（再点一次或按 Esc 退出）——预览要按平台真实尺寸看才有意义。

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

  const stageRef = React.useRef(null)
  const leftRef = React.useRef(null)
  // 预览宽度（px）与全屏只是界面状态，不写进名片。收起预览时退出全屏，宽度保留。
  //   null = 没拖过，用 CSS 的默认宽度（窄屏降级规则才管得到它）。
  const [rightW, setRightW] = React.useState(null)
  const [full, setFull] = React.useState(false)
  const [resizing, setResizing] = React.useState(false)
  React.useEffect(() => { if (!rightOpen) setFull(false) }, [rightOpen])

  // 全屏时 Esc 退出；背后的页面锁住不滚，退出后回到进入时的位置。
  React.useEffect(() => {
    if (!full) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setFull(false) }
    window.addEventListener('keydown', onKey)
    const root = document.documentElement
    const prevOverflow = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      root.style.overflow = prevOverflow
    }
  }, [full])

  const geometry = () => ({
    stageW: stageRef.current ? stageRef.current.getBoundingClientRect().width : window.innerWidth,
    leftW: leftRef.current ? leftRef.current.getBoundingClientRect().width : 32,
  })
  const resizeTo = (want) => setRightW(clampPreviewWidth(want, geometry()))

  // 拖分隔条：往左拖变宽。用 pointer capture，拖出分隔条之外也跟手。
  const onResizeStart = (e) => {
    if (e.button !== undefined && e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const el = e.currentTarget
    // 从「看到的」宽度起拖：存下的 rightW 可能正被 CSS 的 max-width 压着
    // （左抽屉后开的情况），从它起拖会让抽屉一下跳一截。
    const startW = el.parentElement.getBoundingClientRect().width || rightW || PREVIEW_DEFAULT
    if (el.setPointerCapture && e.pointerId !== undefined) el.setPointerCapture(e.pointerId)
    setResizing(true)
    const move = (ev) => resizeTo(startW + (startX - ev.clientX))
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setResizing(false)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  const onResizeKey = (e) => {
    const cur = e.currentTarget.parentElement.getBoundingClientRect().width || rightW || PREVIEW_DEFAULT
    if (e.key === 'ArrowLeft') { e.preventDefault(); resizeTo(cur + 32) }
    if (e.key === 'ArrowRight') { e.preventDefault(); resizeTo(cur - 32) }
  }

  const fullLabel = full ? t('Exit full screen', '退出全屏') : t('Full screen', '全屏')

  return (
    <div className={`wz-stage${leftOpen ? ' wz-stage-left-open' : ''}`} ref={stageRef}>
      <Drawer
        side="left"
        open={leftOpen}
        onToggle={() => onToggle('left')}
        title={t('Scanned parameters', '扫到的参数')}
        arrow="→"
        asideRef={leftRef}
      >
        {left}
      </Drawer>

      <main className="wz-stage-main">{center}</main>

      <Drawer
        side="right"
        open={rightOpen}
        onToggle={() => { setFull(false); onToggle('right') }}
        title={t('Preview', '预览')}
        arrow="←"
        full={full}
        resizing={resizing}
        width={rightOpen && !full ? rightW : null}
        resizer={rightOpen && !full
          ? (
            <div className="wz-drawer-resizer" role="separator" aria-orientation="vertical"
              tabIndex={0}
              aria-label={t('Resize the preview', '拖动改变预览宽度')}
              aria-valuenow={rightW || undefined}
              title={t('Drag to resize, double-click to reset', '拖动改宽，双击还原')}
              onPointerDown={onResizeStart}
              onKeyDown={onResizeKey}
              onDoubleClick={() => setRightW(null)} />
            )
          : null}
        extra={(
          <button className="wz-drawer-handle" type="button"
            onClick={() => setFull((f) => !f)}
            aria-pressed={full}
            title={fullLabel} aria-label={fullLabel}>
            {full ? '⤡' : '⤢'}
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
 * @param {boolean} full 是否全屏（只有右边条用）
 * @param {boolean} resizing 正在拖宽（拖的时候关掉宽度动画，否则不跟手）
 * @param {number|null} width 人拖出来的宽度（px）；null 用 CSS 的默认宽度
 * @param {React.ReactNode} resizer 左边缘的分隔条（只有右边条用）
 * @param {object} asideRef 外层 aside 的 ref（量左边条此刻的宽度）
 * @param {React.ReactNode} extra 展开时箭头旁的额外按钮
 * @param {React.ReactNode} children 抽屉里的内容
 */
function Drawer ({
  side, open, onToggle, title, arrow, full, resizing, width, resizer, asideRef, extra, children,
}) {
  const { t } = useT()
  const cls = `wz-drawer wz-drawer-${side}${open ? ' is-open' : ''}`
    + `${open && full ? ' is-full' : ''}${resizing ? ' is-resizing' : ''}`
  return (
    <aside
      ref={asideRef}
      className={cls}
      style={width ? { width: `${width}px` } : undefined}
      aria-label={title}
    >
      {resizer}
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

export { RAIL_W, DRAWER_W }
