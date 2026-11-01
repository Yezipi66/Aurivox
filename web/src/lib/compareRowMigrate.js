// 对比页的旧 localStorage 迁移：把旧行里摊平的超参、旧行模型里两个写死的权重字段映射到当前名片。
// 旧选择丢失时界面上看不出原因，因此迁移按位置交接，不按旧位名匹配。

// 这一页历史上摊平在行对象上的引擎参数键。历史事实，不是「引擎有哪些参数」：答案被
// 存量 localStorage 冻住了，和 lib/recipeStore.js 的 V3_PARAM_KEYS 同一个道理。
const LEGACY_ROW_PARAM_KEYS = [
  'temperature', 'top_k', 'top_p', 'repetition_penalty',
  'text_split_method', 'speed_factor',
]

// 旧行模型里那两个权重字段：[路径键, 归属角色键]，按位置映射到名片的第 1/2 个位。
const LEGACY_ROW_MODEL_FIELDS = [
  ['gptCheckpoint', 'gptVoiceId'],
  ['sovitsModel', 'sovitsVoiceId'],
]

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

// 一行旧数据 → 新形状。旧行可能被迁移过一半：params 已存在但摊平键仍在；整体覆盖是幂等的，跳过会漏。
export function migrateRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row

  const already = row.params && typeof row.params === 'object' && !Array.isArray(row.params)
  const params = already ? { ...row.params } : {}
  const touched = new Set(
    Array.isArray(row.touched) ? row.touched : (already ? Object.keys(row.params) : []))

  for (const k of LEGACY_ROW_PARAM_KEYS) {
    // undefined 不迁移：旧数据里它表示「界面默认值，不是用户所选」，迁移它就等于改动用户的选择。
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
