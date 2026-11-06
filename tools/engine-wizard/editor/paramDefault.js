// 名片里一条参数的「建议值」在界面上的读写。
//
// 单值参数与成排参数（repeat 大于等于 2）在界面上都是一个输入框，
// 但落盘形状不同：单值是标量，成排是长度等于 repeat 的数组。
// 两者混起来会静默出错：把八个值写成一个字符串，引擎只会收到一个词。
//
// 纯函数：不读组件 state。放自己的文件，便于单独测。

/**
 * 这一条参数是不是「一排值」。
 * @param {object} entry parameters[] 里的一条
 * @returns {number} repeat，未声明或非法时算 1
 */
export function repeatOf (entry) {
  const n = Number(entry && entry.repeat)
  return Number.isInteger(n) && n > 1 ? n : 1
}

/**
 * 落盘的默认值 → 输入框里显示的文本。
 * 成排时用逗号连接；缺一维就少一段，不补零。
 *
 * @param {object} entry parameters[] 里的一条
 * @returns {string} 显示文本
 */
export function defaultTextOf (entry) {
  const value = entry && entry.suggested_value
  if (repeatOf(entry) > 1) {
    return Array.isArray(value) ? value.map((v) => (v === null || v === undefined ? '' : String(v))).join(',') : ''
  }
  return value === null || value === undefined ? '' : String(value)
}

/**
 * 输入框里的文本 → 落盘的默认值。
 *
 * 成排时按逗号切开，空的一段写 null（这一维没填），不拿 0 顶替：
 * 0 是一种明确的强度，替人补 0 等于替他做了一个决定。
 *
 * @param {string} raw 输入框内容
 * @param {object} entry parameters[] 里的一条
 * @returns {*} 标量、数组或 undefined
 */
export function defaultFromText (raw, entry) {
  const text = raw == null ? '' : String(raw)
  if (text === '') return undefined
  const type = (entry && entry.type) || 'text'
  if (repeatOf(entry) === 1) {
    if (type === 'boolean') return text === 'true'
    return type === 'number' ? Number(text) : text
  }
  return text.split(',').map((part) => {
    const piece = part.trim()
    if (piece === '') return null
    return type === 'number' ? Number(piece) : piece
  })
}

// 成排参数的默认值在界面上是 N 个格子，一格对一个维度。
// 落盘仍是一个长度等于 repeat 的数组；缺的维留 null，表示这一维没填。

function arrayOf (entry) {
  const value = entry && entry.suggested_value
  return Array.isArray(value) ? value : []
}

/**
 * 第 i 格显示什么。
 * @param {object} entry parameters[] 里的一条
 * @param {number} i 第几维（从 0 开始）
 * @returns {string} 显示文本
 */
export function vectorCellText (entry, i) {
  const value = arrayOf(entry)[i]
  return value === null || value === undefined ? '' : String(value)
}

/**
 * 改第 i 格，返回新的默认值数组。
 * 空的一格写 null，不拿 0 顶替：0 是一种明确的强度。
 *
 * @param {object} entry parameters[] 里的一条
 * @param {number} i 第几维
 * @param {string} raw 输入框内容
 * @returns {Array} 长度等于 repeat 的新数组
 */
export function withVectorCell (entry, i, raw) {
  const type = (entry && entry.type) || 'text'
  const next = Array.from({ length: repeatOf(entry) }, (_, k) => {
    const cur = arrayOf(entry)[k]
    return cur === undefined ? null : cur
  })
  const text = raw == null ? '' : String(raw).trim()
  next[i] = text === '' ? null : (type === 'number' ? Number(text) : text)
  return next
}
