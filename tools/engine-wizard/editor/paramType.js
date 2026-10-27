// 扫到的参数类型 → 界面参数类型的映射。左栏参数池与中栏落点共用，放这里才能单独测。
// 两套词不同：界面参数类型是平台那五种（text / number / select / boolean / file），
// 统一层的类型名是 str / int / bool / array。

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
