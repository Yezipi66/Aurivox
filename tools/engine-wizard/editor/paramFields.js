// 「合成参数」一条的纯计算部分：命令行开关、中英文名字、按类型的选项表。
//
// 这些形状写错时界面照样画得出，值却发不到引擎或不显示名字，所以单独可测。
// 纯函数放自己的文件：组件模块只导出组件，导出别的会让 Fast Refresh 失效。

/** 开关去掉开头的横线就是参数名，也是 call.args 的键。 */
export function nameFromFlag (flag) {
  return String(flag == null ? '' : flag).trim().replace(/^-+/, '')
}

/** label 可能是旧版字符串，也可能是 { zh, en }。读出来一律成对。 */
export function readLabel (entry) {
  const raw = entry && entry.label
  if (raw && typeof raw === 'object') {
    return { zh: String(raw.zh || ''), en: String(raw.en || '') }
  }
  const one = String(raw == null ? '' : raw)
  return { zh: one, en: one }
}

/** 改一种语言，另一种原样保留；两种都空就删掉这个键，让平台用参数名兜底。 */
export function withLabel (entry, lang, text) {
  const next = { ...(entry || {}) }
  const label = { ...readLabel(entry), [lang]: String(text == null ? '' : text) }
  if (!label.zh && !label.en) delete next.label
  else next.label = label
  return next
}

/** select 的选项：统一读成 { value, zh, en } 三列。 */
export function readChoices (entry) {
  const list = entry && Array.isArray(entry.choices) ? entry.choices : []
  return list.map((c) => {
    if (typeof c === 'string' || typeof c === 'number') return { value: String(c), zh: '', en: '' }
    const label = c && c.label && typeof c.label === 'object'
      ? c.label
      : { zh: String((c && c.label) || ''), en: String((c && c.label_en) || '') }
    return {
      value: String((c && c.value) ?? ''),
      zh: String(label.zh || ''),
      en: String(label.en || ''),
    }
  })
}

/** vector 的维度名：统一读成 { zh, en } 两列。 */
export function readDims (entry) {
  const list = entry && Array.isArray(entry.dim_labels) ? entry.dim_labels : []
  return list.map((d) => {
    if (typeof d === 'string' || typeof d === 'number') return { zh: String(d), en: String(d) }
    return { zh: String((d && d.zh) || ''), en: String((d && d.en) || '') }
  })
}

/** 把一张表改成 n 行：多出来的补空行，少掉的从末尾截掉，不替使用者挪值。 */
export function resizeRows (rows, n, empty) {
  const count = Number.isInteger(n) && n >= 1 ? Math.min(n, 64) : 0
  const out = rows.slice(0, count)
  while (out.length < count) out.push(empty())
  return out
}

/** 改表里某一行的某一列，返回新的表。 */
export function withCell (rows, i, key, value) {
  const next = rows.map((row) => ({ ...row }))
  if (!next[i]) return next
  next[i][key] = String(value == null ? '' : value)
  return next
}
