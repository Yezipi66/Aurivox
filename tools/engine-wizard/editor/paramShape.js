// 从上游说明文字里读「这一格收的是哪一种数组」。
//
// 判据只用上游自己写下的两个词：值是逗号分隔的、维度是几维。
// 两者都在时按「一个词」处理（join），并给出格数；只有前者时按 join 处理、不推格数
// （猜错格数时名片无法保存：校验要求默认值长度等于 repeat）。
//
// 纯函数、零依赖：扫描回填与拖拽落点两处都要用它。

/**
 * @param {string} help 上游的说明文字
 * @returns {{style: string, join: string, repeat: number}|null} 不是数组形态时返回 null
 */
export function vectorShapeFromHelp (help) {
  const text = String(help == null ? '' : help)
  const isList = /comma[\s-]*separated|comma[\s-]*delimited/i.test(text) || /逗号分隔/.test(text)
  if (!isList) return null
  const dim = text.match(/(\d+)\s*[- ]?\s*dim(?:ensional)?\b/i) || text.match(/(\d+)\s*维/)
  const n = dim ? Number(dim[1]) : 0
  return { style: 'join', join: ',', repeat: n >= 2 && n <= 64 ? n : 0 }
}
