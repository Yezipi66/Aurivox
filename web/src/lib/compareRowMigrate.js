// ============================================================
//  对比页的行数据迁移 —— 老 localStorage 数据不会静默丢参数
// ============================================================
//
// ⭐⭐ 2026-10-01：这一页的行数据在 2026-10-01 换过一次形状。
//
// 老形状（2026-08 一直到现在）：超参**摊平在行对象上**
//     { id, temperature, top_k, top_p, repetition_penalty,
//       text_split_method, speed_factor, seed, ... }
//
// 新形状（按名片驱动）：超参收进两个字段
//     { id, params: {…只装用户动过的…}, touched: [...], method, seed, ... }
//
// ⛔ 为什么必须迁：老数据躺在用户的 localStorage 里（键 `compare.rows`）。
//    不迁的话 —— 用户调过的 `top_k` 一个都读不出来（paramsToSend 的
//    touched 是空集 ⇒ 一个键都不发），而格子显示的却是**名片默认值**。
//    用户看到的是「我明明调过 top_k，界面又变回默认值了」，而且没有任何
//    一处提示。那正是这个任务要消灭的那类静默失败。
//
// 迁移写在**纯函数**里（不是 JSX 里）：只有这样它才能被单测到 ——
// 迁移出错的症状是「用户的老参数没了」，而那种东西不会自己浮出来。
//
// 判据（两条，都来自平台既有纪律）：
//   1. 认得的老键才搬。搬一个不认识的键进 params，等于凭空发明一个参数。
//   2. 搬进来的都算 **touched** —— 老数据里出现的每一个超参，都是用户
//      亲手调过的（它们当初是从 useState 存下来的），标成「没动过」就等于
//      替用户把这些格子重置成默认值。

/**
 * 这一页历史上摊平在行对象上的引擎参数键。
 *
 * ⛔ 这份清单是**历史事实**，不是「引擎有哪些参数」。它回答的是
 *    「2026-08 那版的行对象上出现过哪些键」，答案被存量 localStorage
 *    冻住了 —— 和 lib/recipeStore.js:84 的 V3_PARAM_KEYS 同一个道理。
 *    ⛔ 它不许可再往里加新键：新键该走名片，不该走这份表。
 */
const LEGACY_ROW_PARAM_KEYS = [
  'temperature', 'top_k', 'top_p', 'repetition_penalty',
  'text_split_method', 'speed_factor',
]

/**
 * 一行老数据 → 新形状。
 *
 * @param row localStorage 里读出来的那一行（形状未知，可能很老）
 * @returns 同形状但带 params / touched 的新行
 */
export function migrateRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row

  // 已经是新形状（有过一次迁移，或本来就没老数据）⇒ 什么都不搬。
  // ⛔ 不是「有 params 就整体跳过」：老行可能被后来的代码半迁过一次，
  //    那时 params 有了、老摊平键还在。把它们搬进来是幂等的，重复跑
  //    不会出问题 —— 而跳过就会漏。
  const already = row.params && typeof row.params === 'object' && !Array.isArray(row.params)
  const params = already ? { ...row.params } : {}
  const touched = new Set(
    Array.isArray(row.touched) ? row.touched : (already ? Object.keys(row.params) : []))

  for (const k of LEGACY_ROW_PARAM_KEYS) {
    // 值是 undefined 的不搬：那等于「这个键被搬进来了但没有值」，
    // paramsToSend 会把 undefined 发出去吗？——它会跳，但 touched 里有它，
    // 语义就乱了（旧数据里 undefined 通常是「界面默认值，不算用户选的」）。
    if (!Object.prototype.hasOwnProperty.call(row, k)) continue
    if (row[k] === undefined) continue
    params[k] = row[k]
    touched.add(k)
  }

  return {
    ...row,
    params,
    touched: Array.from(touched),
    // transient 标记：进程死了它们没意义，留着会让重载后那一行显示「生成中」。
    loading: false,
    error: null,
    // Legacy per-row target 'auto' (option removed) falls back to "use default".
    textLang: row.textLang === 'auto' ? '' : row.textLang,
  }
}
