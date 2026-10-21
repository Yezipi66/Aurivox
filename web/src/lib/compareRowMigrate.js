// 对比页的行数据迁移：老 localStorage 数据里的超参不许静默丢掉。老形状把超参摊平在行
// 对象上，新形状收进 { params: {…只装用户动过的…}, touched: [...] }。不迁的话用户调过
// 的 top_k 一个都读不出来（touched 是空集 ⇒ 一个键都不发），而格子显示的是名片默认值。
// 两条判据：只搬认得的老键；搬进来的都算 touched。

// 这一页历史上摊平在行对象上的引擎参数键。历史事实，不是「引擎有哪些参数」：答案被
// 存量 localStorage 冻住了，和 lib/recipeStore.js 的 V3_PARAM_KEYS 同一个道理。
const LEGACY_ROW_PARAM_KEYS = [
  'temperature', 'top_k', 'top_p', 'repetition_penalty',
  'text_split_method', 'speed_factor',
]

// 一行老数据 → 新形状。迁移出错的症状是用户的老参数没了，那种失败不会自己浮出来。
export function migrateRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row

  // 已经是新形状（有过一次迁移，或本来就没老数据）⇒ 什么都不搬。不是「有 params 就
  // 整体跳过」：老行可能被后来的代码半迁过一次，那时 params 有了、老摊平键还在。把它们
  // 搬进来是幂等的，重复跑不会出问题，而跳过就会漏。
  const already = row.params && typeof row.params === 'object' && !Array.isArray(row.params)
  const params = already ? { ...row.params } : {}
  const touched = new Set(
    Array.isArray(row.touched) ? row.touched : (already ? Object.keys(row.params) : []))

  for (const k of LEGACY_ROW_PARAM_KEYS) {
    // 值是 undefined 的不搬：那等于「这个键被搬进来了但没有值」，touched 里有它，语义
    // 就乱了（旧数据里 undefined 通常是「界面默认值，不算用户选的」）。
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
    // 老行上逐段语言为 'auto' 的，落成「跟随默认」。
    textLang: row.textLang === 'auto' ? '' : row.textLang,
  }
}