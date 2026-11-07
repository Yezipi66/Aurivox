'use strict'

// 名片能声明的全部控件形状：text / number / select / boolean / file / vector。
// 六种里没有一种带业务身份：那是名片给格子起的名字，不是平台认识的种类。
//
// vector 是「一项若干同类型的值、每维一个名字」的独立控件：八维情绪向量就是八个
// 文本输入框，外面套一个写着参数名的大框。它不是 number × repeat 的别名，也与
// repeat 无关：repeat 是「同一个标量控件画 N 遍」，vector 是「一个控件内部有 N 维」，
// 两者在界面上是不同的东西，折成一种会让 vector 失去自己的框和标题。
//
// 只传不校验：min/max/step 是名片作者抄录的，画滑块范围，不当闸门。
// 别名在 canonicalType 折成六种之一，出口只有六种；删掉别名表，写别名的名片就读不出类型。
const PARAM_TYPES = Object.freeze(['text', 'number', 'select', 'boolean', 'file', 'vector'])

const TYPE_ALIASES = Object.freeze({
  integer: 'number',
  enum: 'select',
  path: 'file',
  string: 'text',
})

// 下拉选项来自哪里：choices 是名片写死的，source 是平台托管库（要运行时扫盘）。
// source 这三个词是平台的词汇：一台引擎都没装时「本机有哪些音色」依然有意义。
const SELECT_SOURCES = Object.freeze(['voices', 'weights', 'audio'])

// 名片写的那个词 → 六种之一。不认识的返回 null（由调用方决定怎么抱怨）。
function canonicalType (raw) {
  if (typeof raw !== 'string') return null
  if (PARAM_TYPES.includes(raw)) return raw
  return TYPE_ALIASES[raw] || null
}

// 名片写的是不是「整数」那一味（合并进 number 之后仍需记住）。
function isIntFlavor (raw) {
  return raw === 'integer'
}

// 一个条目要重复几格。repeat 8 的 number 就是八个数字框；没写 / 写 1 = 一格，
// 值是标量。两者发给引擎不同，而差别不报错。
// vector 不写 repeat：它的维度数由 dim_labels 的长度定，这里读出来供收取侧对齐长度。
function repeatOf (entry) {
  if (entry && entry.type === 'vector') {
    const labels = entry.dim_labels
    return Array.isArray(labels) ? labels.length : 0
  }
  const n = entry && entry.repeat
  if (n === undefined || n === null) return 1
  const i = Number(n)
  if (!Number.isInteger(i) || i < 1) return 1
  return i
}

// 这一格是不是「重复的一排」。
function isRepeated (entry) {
  return repeatOf(entry) > 1
}

// vector 的维度数。唯一来源是 dim_labels，没有第二处可以写。
function vectorSizeOf (entry) {
  const labels = entry && entry.dim_labels
  return Array.isArray(labels) ? labels.length : 0
}

module.exports = {
  PARAM_TYPES,
  TYPE_ALIASES,
  SELECT_SOURCES,
  VECTOR_TYPE: 'vector',
  canonicalType,
  isIntFlavor,
  repeatOf,
  isRepeated,
  vectorSizeOf,
}
