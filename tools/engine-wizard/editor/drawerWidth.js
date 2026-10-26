// 右边条（预览）拖动改宽时的纯计算：宽度夹在哪个范围里。
//
// 单独一个文件：Stage.jsx 是组件模块，只该导出组件（Fast Refresh 的要求），
//   而这一步要能脱离 DOM 单独测。

/** 预览抽屉最窄：再窄平台的参数面板就折行折得没法看。 */
export const PREVIEW_MIN = 280
/** 拖宽时中栏至少要留的宽度：再窄表单就没法填。要更大就用「全屏」。 */
export const CENTER_MIN = 320
/** 预览抽屉的默认宽度，与 editor.css 的 --wz-drawer-w 一致。 */
export const PREVIEW_DEFAULT = 360

/**
 * 把拖出来的宽度夹进可用范围。
 *
 * 上限按「此刻」左边条实际占的宽度算：左栏收着是 32px 的边条，
 * 展开是抽屉。只按 32px 算的话，左抽屉开着时中栏会被压成一条缝。
 *
 * @param {number} want 想要的宽度（px）
 * @param {object} box 当前几何
 * @param {number} box.stageW 三栏骨架的总宽（px）
 * @param {number} box.leftW 左边条此刻占的宽度（px）
 * @returns {number} 夹过之后的宽度（px，整数）
 */
export function clampPreviewWidth (want, { stageW, leftW }) {
  const max = Math.max(PREVIEW_MIN, Math.floor(stageW - leftW - CENTER_MIN))
  const w = Number.isFinite(want) ? want : PREVIEW_DEFAULT
  return Math.round(Math.min(max, Math.max(PREVIEW_MIN, w)))
}
