// 参数池的渲染顺序：必填置顶，其余保持扫描原序。
//
// required 是上游自己声明的事实（argparse 的 required=True、python 必填参数），
//   paramDigest 原样搬运（core/paramDigest.js：required: x.required === true），
//   不是平台猜的，所以按它置顶是替使用者排序，不是替他决定。
//   扫几十个 flag 时必填的散在列表各处要翻找；先把「不填引擎起不来」的
//   那几个挑到顶上，组内仍保持扫描原序：平台不替参数排座次。

/**
 * 必填排到池顶，其余保持原序。
 *
 * 用分区而不用 sort：sort 的稳定性虽然在 ES2019 以后有保证，但分区把
 * 「必填在上、其余不动」这两条意图直接写在代码里，不用绕弯子读比较函数。
 *
 * @param {Array} params 扫到的参数（/wizard/discover 的返回形状）
 * @returns {Array} 渲染顺序（新数组，不改动入参）
 */
export function orderForPool (params) {
  if (!Array.isArray(params)) return []
  const pinned = []
  const rest = []
  for (const p of params) {
    if (p && p.required === true) pinned.push(p)
    else rest.push(p)
  }
  return pinned.concat(rest)
}
