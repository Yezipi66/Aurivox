// 路径取名与时间格式化。
// 取路径的最后一段。跨平台：先把反斜杠换成正斜杠再切。
function basename(p) {
  if (!p || typeof p !== 'string') return '(none)'
  const a = p.replace(/\\/g, '/').split('/')
  return a[a.length - 1]
}

// 把时间值格式化成完整的本地时间戳（YYYY-MM-DD HH:MM:SS）。无效时间返回空串。
function fmtRecentTime(value) {
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export { basename, fmtRecentTime }
