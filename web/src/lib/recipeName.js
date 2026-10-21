// 配方名称的校验规则。
// 与服务端同名规则保持一致（两边必须同进同出）：允许 Unicode 字母，只禁文件系统里危险的符号。
const RECIPE_NAME_BLACKLIST = /[\\/:*?"<>|]/

// 校验配方名称，返回可展示的错误信息；通过时返回 null。
// 长度上限 64 与服务端一致。
function recipeNameError(name) {
  const t = (name || '').trim()
  if (!t) return 'Name is required'
  if (t.length > 64) return 'Name too long (max 64)'
  if (RECIPE_NAME_BLACKLIST.test(t)) return 'Name must not contain / \\ : * ? " < > |'
  if (t.startsWith('.')) return "Name must not start with '.'"
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(t)) return 'Name contains control characters'
  return null
}

export { recipeNameError }
