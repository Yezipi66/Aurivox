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

/**
 * boolean 那一格要写成哪种命令行样式。
 *
 *   有否定式 ⇒ boolean_optional：勾了发 --x，不勾发 --no-x
 *   没有   ⇒ boolean：勾了发 --x，不勾什么都不发（引擎用自己的默认值）
 *
 * 上游把否定式写在开关后面（click 的 --x/--no-x）时，这个事实由「发送否定式开关」
 * 那一格决定；平台不替上游拼那个词。
 */
export function boolStyle (negatable) {
  return negatable ? 'boolean_optional' : 'boolean'
}

/**
 * 开关改名后，把 call.args 里的键一起搬过去。
 * 参数名既是 parameters[].name，也是 call.args 的键；只改前者会留下一个
 * 永远上不了命令行的旧条目，存盘直接被拒。旧条目的 style / join / role 要跟着搬。
 *
 * style 是可选的一项：boolean 的否定式开关要在这里改掉（boolean / boolean_optional），
 * 不给就保留原样，避免把 join / repeat 这些与类型无关的写法冲掉。
 *
 * @param {object} call 名片的 call 段
 * @param {{from: string, to: string, flag: string, style?: string}} argv 开关改动
 * @returns {object} 新的 call 段
 */
export function withArgKey (call, argv) {
  if (!call || !argv) return call
  const args = { ...(call.args || {}) }
  const { from, to, flag, style } = argv
  const old = (from && args[from]) || {}
  if (from && from !== to) delete args[from]
  if (to && flag && String(flag).startsWith('-')) {
    const next = { ...old, flag }
    if (style) next.style = style
    args[to] = next
  } else if (to) delete args[to]
  return { ...call, args }
}
