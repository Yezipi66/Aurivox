import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// 三栏的排布：左栏扫到的参数、中栏名片内容、右栏当前项目的前端预览。
//
// 这一层只管「三列怎么排」与「哪一列收起」，不画视觉外壳。
// 视觉外壳由内容自己带：主界面里每一块内容都是 .section（带 .section-hdr
// 与 .section-body）或 .card，而 .workspace-left / .workspace-right 本身
// 没有边框也没有背景，只是定位用的列。
//   （web/src/styles.css:431-469 是 .section，:578-587 是 .workspace-left/right）
// 所以这里不造「栏头」：造了就变成三块互不相干的板子，
// 而主界面是内容自然铺开、栏只是空间位置。
//
// 收起的按钮由内容自己放（放在那一列第一个 .section 的 .section-hdr 右边）；
// 这一层只负责在收起时换成一条能点回来的窄轨。
//
// 收起状态只存在组件 state 里，不落盘：下次打开这一页时回到展开态，
// 避免记住一个上次没看完的状态。

// 窄轨宽度：给 0 会把展开按钮一起藏掉，那一列就再也展不开。
// 窄轨是项目自己的做法（web/src/components/flowgraph/canvasChrome.jsx 的 Rail 用 26px）。
const COLLAPSED_W = '40px'

/**
 * 三栏容器。
 *
 * @param {React.ReactNode} left 左栏内容（扫到的参数）
 * @param {React.ReactNode} center 中栏内容（当前名片内容）
 * @param {React.ReactNode} right 右栏内容（当前项目的前端预览）
 * @param {object} collapsed 哪几栏收起了 {left, right}
 * @param {Function} onToggle 收起/展开某一栏的回调
 */
export default function ThreeZone ({ left, center, right, collapsed, onToggle }) {
  const { t } = useT()
  const isLeft = !!collapsed.left
  const isRight = !!collapsed.right

  // 列宽在这里算，不写死在 CSS 里：CSS 写死的三列不知道哪一栏被收了。
  // 中栏永远是 minmax(0, 1fr) ⇒ 收起哪一栏，那一栏的宽度都归中栏。
  const leftW = isLeft ? COLLAPSED_W : '260px'
  const rightW = isRight ? COLLAPSED_W : '380px'

  // 收起态：内容不渲染（不是隐藏）。参数池与预览都带着自己的 state，
  // 留着不渲染才能在收起再展开后保留用户刚才的滚动位置与选择。
  const rail = (key, labelEn, labelZh) => (
    <div className="wz-rail">
      <button className="btn btn-sm btn-ghost wz-rail-toggle" type="button"
        onClick={() => onToggle(key)}
        title={t(`Expand ${labelEn}`, `展开${labelZh}`)}
        aria-label={t(`Expand ${labelEn}`, `展开${labelZh}`)}
        aria-expanded={false}>
        ▸
      </button>
    </div>
  )

  return (
    <div className="wz-three-zone"
      style={{ gridTemplateColumns: `${leftW} minmax(0, 1fr) ${rightW}` }}>
      {isLeft
        ? rail('left', 'Scanned parameters', '扫到的参数')
        : <div className="workspace-left">{left}</div>}
      <div className="workspace-left">{center}</div>
      {isRight
        ? rail('right', 'Preview', '预览')
        : <div className="workspace-right">{right}</div>}
    </div>
  )
}

