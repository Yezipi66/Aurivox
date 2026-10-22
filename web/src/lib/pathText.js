// 路径取名与时间格式化的纯函数：取路径最后一段（跨平台）、把时间值格式化成本地时间戳。
// 两者都不做输入合法性之外的事：反斜杠与正斜杠一视同仁，无效时间返回空串。
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
