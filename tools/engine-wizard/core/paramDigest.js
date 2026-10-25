'use strict'
//  paramDigest：统一层：cli 路与 python 路的参数输出对齐成同一形状
//
// 两条路的输入形状不同，但输出形状相同：
//     cli 路   {name, flag, style, help, required, is_tool, subcommand}
//     python 路 {name, phase, required, default, kind, help, ...}
//     输出     {source, name, target, kind, kind_certain, style, help, required, group, is_tool}
//     cli 路的 style 一并透出（只有它有）：该表是名片 args 段要用的，
//       与 kind 是两张不同的表，不能互相顶替。

// kind 映射表：把两条路的类型名映射到统一形状
const KIND_MAP = {
  text: 'str',
  str: 'str',
  string: 'str',
  boolean: 'boolean',
  bool: 'boolean',
  number: 'number',
  integer: 'number',
  int: 'number',
  float: 'number',
  array: 'array',
  list: 'array',
  unknown: 'unknown',
}

// cli 路 style → 统一 kind
function kindFromStyle (style) {
  if (style === 'boolean' || style === 'boolean_optional') return 'boolean'
  if (style === 'repeat') return 'array'
  if (style === 'value') return 'str'
  return 'unknown'
}

// python 路 kind → 统一 kind
// 兼容两种输入：反射原始条目（kind 是对象 {kind: 'text'}）和草稿条目（type 是字符串 'text'）
function kindFromPython (kind) {
  if (!kind) return 'unknown'
  if (typeof kind === 'object') kind = kind.kind
  if (!kind) return 'unknown'
  return KIND_MAP[kind] || 'unknown'
}

// cli 路条目 → 统一形状
// style 与 kind 一起带出来：kind 是界面显示的类型名（str/boolean/array），
//   style 是名片 args 段认的写法词（value/boolean/repeat）。
//   只带 kind 的话，前端写进 args 的就是类型名，该名片无法写入
//   （宿主认得的那几个词与统一层的那几个词不是同一张表）。
function fromCli (a) {
  const typed = cliKindAndCertainty(a)
  return {
    source: 'cli',
    name: a.name,
    target: a.flag,
    kind: typed.kind,
    kind_certain: typed.certain,
    style: a.style,
    help: a.help || null,
    required: a.required === true,
    group: a.subcommand || '(root)',
    is_tool: a.is_tool === true,
  }
}

// python 路条目 → 统一形状
function fromPython (p) {
  const kind = p.kind || p.type
  return {
    source: 'python',
    name: p.name,
    target: p.name,
    kind: kindFromPython(kind),
    kind_certain: pythonCertainty(p),
    // python 路不写 style：它没有命令行开关，写一个占位词进去，
    //   反而像是这台引擎有那个开关。
    help: p.help || null,
    required: p.required === true,
    group: p.phase || 'call',
    is_tool: false,
  }
}

// argparse type= → 统一 kind。认不出的词返回 null（交回 style 去猜）。
const ARGPARSE_TYPE = {
  int: 'number', float: 'number', str: 'str', Path: 'str', bool: 'boolean',
}

// 类型是「上游说的」还是「我们猜的」。
//   左栏用它上色：确定 = 绿，不确定 = 灰。
//   判据只认上游自己写下的东西，不认默认值与参数名：
//     cli    action=store_true/store_false/BooleanOptionalAction、type=、choices=
//     python 注解（annotation）、Literal 选项、默认值是 bool（confidence: strong）
//   默认值是 1.0 推成 number、名字叫 speed 推成 number，都算猜。
function cliKindAndCertainty (a) {
  if (a.style === 'boolean' || a.style === 'boolean_optional') return { kind: 'boolean', certain: true }
  if (a.style === 'repeat') return { kind: 'array', certain: !!a.type }
  if (a.type && ARGPARSE_TYPE[a.type]) return { kind: ARGPARSE_TYPE[a.type], certain: true }
  if (Array.isArray(a.choices) && a.choices.length) return { kind: 'str', certain: true }
  // TODO(骨架)：没写 type= 时 argparse 实际收到的就是 str，但界面类型往往是 number
  //   （--speed 1.0）。这里先按默认值给个猜测，标成不确定，让人在中栏确认。
  if (typeof a.default === 'number') return { kind: 'number', certain: false }
  return { kind: kindFromStyle(a.style), certain: false }
}

function pythonCertainty (p) {
  if (p.annotation && p.annotation.raw) return true
  if (p.upstream_choices && p.upstream_choices.length) return true
  const k = p.kind
  if (k && typeof k === 'object' && k.confidence === 'strong') return true
  // TODO(骨架)：经 paramsFromReflect 草稿过来的条目已经丢了 confidence / annotation，
  //   这里拿到的只有 type 字符串 ⇒ 一律算不确定。要在草稿里把这两个字段带过来。
  return false
}

// 合并两条路的参数
function merge (cliArgs, pythonParams) {
  const params = []
  const groups = new Set()
  if (Array.isArray(cliArgs)) {
    for (const a of cliArgs) {
      const d = fromCli(a)
      params.push(d)
      groups.add(d.group)
    }
  }
  if (Array.isArray(pythonParams)) {
    for (const p of pythonParams) {
      const d = fromPython(p)
      params.push(d)
      groups.add(d.group)
    }
  }
  return { params, groups: [...groups] }
}

module.exports = { fromCli, fromPython, merge, kindFromStyle, kindFromPython, cliKindAndCertainty, pythonCertainty }
