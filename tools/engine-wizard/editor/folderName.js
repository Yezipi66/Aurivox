/** 目录名：输入框优先，留空用仓库名。 */
export function folderName ({ typed, suggested } = {}) {
  const a = String(typed == null ? '' : typed).trim()
  if (a) return a
  return String(suggested == null ? '' : suggested).trim()
}
