// 扫到的参数类型 → 界面参数类型的映射。
//
// 界面参数的类型是平台那五种（text / number / select / boolean / file），
// 与统一层的类型名（str / int / bool / array）不是一套词 ⇒ 这里做一次映射。
//
// 单独一个文件：左栏参数池与中栏落点都要用它，而落点那侧要能被单独测。

// 统一层的类型名到界面参数类型的对应。
// 映射不到就落到 text：扫不出类型的参数仍然是文本参数。
const KIND_TO_TYPE = {
  str: 'text',
  string: 'text',
  int: 'number',
  integer: 'number',
  float: 'number',
  number: 'number',
  bool: 'boolean',
  boolean: 'boolean',
}

/**
 * 从扫到的参数推出界面参数类型。
 *
 * @param {object} p 扫到的参数
 * @returns {string} 界面参数类型，五种之一
 */
export function paramTypeOf (p) {
  if (!p) return 'text'
  if (p.kind === 'array') return 'text'
  return KIND_TO_TYPE[String(p.kind || '').toLowerCase()] || 'text'
}
