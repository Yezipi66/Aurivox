// 对比页的旧 localStorage 迁移：老行里的超参不许静默丢掉，老行模型里的两个权重字段
// 不许按旧位名搬运。迁移出错的症状都是用户的旧选择没了，而界面上看不出原因。

// 这一页历史上摊平在行对象上的引擎参数键。历史事实，不是「引擎有哪些参数」：答案被
// 存量 localStorage 冻住了，和 lib/recipeStore.js 的 V3_PARAM_KEYS 同一个道理。
const LEGACY_ROW_PARAM_KEYS = [
  'temperature', 'top_k', 'top_p', 'repetition_penalty',
  'text_split_method', 'speed_factor',
]

// 旧行模型把两个权重位写死成 gptCheckpoint/sovitsModel 与其归属角色。位名是旧界面的
// 事实，不是任何一台引擎的约定：按位置交给当前名片的第 1/2 个位，位名不同的引擎也不丢选择。
const LEGACY_ROW_MODEL_FIELDS = [
  ['gptCheckpoint', 'gptVoiceId'],
  ['sovitsModel', 'sovitsVoiceId'],
]

// 旧行模型 → 按位名索引的 { picks, owners }。slots 是当前引擎的权重位，按顺序对位。
export function migrateRowModelShape(src, slots) {
  const picks = {}
  const owners = {}
  LEGACY_ROW_MODEL_FIELDS.forEach(([pathKey, ownerKey], i) => {
    const s = (slots || [])[i]
    if (!s || !s.name) return
    if (src[pathKey]) picks[s.name] = src[pathKey]
    if (src[ownerKey]) owners[s.name] = src[ownerKey]
  })
  return { picks, owners }
}

// 一行老数据 → 新形状。
export function migrateRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row

  // 不是「有 params 就整体跳过」：老行可能被后来的代码半迁过一次，那时 params 有了、老摊平
  // 键还在。搬进来是幂等的，跳过就会漏。
  const already = row.params && typeof row.params === 'object' && !Array.isArray(row.params)
  const params = already ? { ...row.params } : {}
  const touched = new Set(
    Array.isArray(row.touched) ? row.touched : (already ? Object.keys(row.params) : []))

  for (const k of LEGACY_ROW_PARAM_KEYS) {
    // undefined 不搬：touched 里有它、params 里没值，语义就乱了（旧数据里 undefined 通常是
    // 「界面默认值，不算用户选的」）。
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