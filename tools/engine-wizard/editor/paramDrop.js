// 拖一个参数落进 Manifest 时，纯计算那部分。
// 纯函数放自己的文件：组件模块只导出组件，导出别的会让 Fast Refresh 失效。

import { paramTypeOf } from './paramType.js'
import { vectorShapeFromHelp } from './paramShape.js'

// 中栏的落点：界面参数区（parameters[]）。扫到的参数拖进来，按扫到的信息预填，接入者再改。
//
// 参数名：扫到的 cli 参数是命令行开关（--speed），界面参数名去掉开头的横线（speed）；
// python 参数本身就是方法参数名，原样用。
//
// cli 参数拖进来还要写进 call.args：命令行形态下只认声明过的名字，没声明就被拒。
// 写的是刚刚拖进来的那个开关，不是平台猜的对应关系。

/**
 * 去掉开关前面的横线，得到界面参数名。
 * @param {object} param 扫到的参数
 * @returns {string} 参数名
 */
export function paramNameOf (param) {
  if (!param) return ''
  if (param.source === 'cli') return String(param.name || param.target || '').replace(/^-+/, '')
  return String(param.name || param.target || '')
}

// 拖拽时放在 dataTransfer 里的机器可读那一份。text/plain 放给人看的写法
//   （跟着光标走的拖影显示的就是 text/plain），自定义类型放整条参数。
//   两者分工：前者让人一眼认出拖的是哪个开关，后者让落点不必从显示文字反推。
export const PARAM_MIME = 'application/x-aurivox-param'

/**
 * 拖动时显示的文字：命令行上要敲的那个写法。
 * @param {object} param 扫到的参数
 * @returns {string} 例如 --emotion-vector，python 形态是方法参数名
 */
export function dragLabelOf (param) {
  if (!param) return ''
  return String(param.target || param.name || '')
}

// 旧格式（params.schema + load_time/call_time）与新格式（parameters[]）只允许存在一份。
// 拖参数进来写的是新格式，所以旧的那份必须先搬过去，否则两份共存会被校验直接拒掉。
// 形状对应关系：schema 的键 → name；schema.default → suggested_value；
// load_time 里有的 → phase: "load"，其余是 call。
const CARRIED = [
  'type', 'label', 'help', 'min', 'max', 'step', 'choices', 'source',
  'allow_custom', 'multi', 'repeat', 'dim_labels', 'tier', 'group',
  'order', 'width', 'only_when', 'int',
]

/**
 * 把旧格式的 params 迁移成 parameters[]。已经新格式的名片原样返回。
 *
 * @param {object} manifest 当前名片
 * @returns {object} 迁移后的名片（旧键已删除）
 */
export function migrateLegacyParams (manifest) {
  const m = { ...(manifest || {}) }
  if (m.parameters !== undefined || m.params === undefined) return m

  const legacy = m.params || {}
  const schema = legacy.schema || {}
  const loadTime = Array.isArray(legacy.load_time) ? legacy.load_time : []
  const callTime = Array.isArray(legacy.call_time) ? legacy.call_time : []

  // 顺序：先按 schema 的键序，再把只在 load/call_time 里出现的补在后面。
  //   schema 的顺序是接入者写名片时的顺序，界面按它排，不该被这次迁移打乱。
  const names = [...Object.keys(schema)]
  for (const name of [...loadTime, ...callTime]) {
    if (!names.includes(name)) names.push(name)
  }

  const parameters = names.map((name) => {
    const d = schema[name] || {}
    const entry = { name, type: d.type || 'text' }
    if (loadTime.includes(name)) entry.phase = 'load'
    for (const key of CARRIED) {
      if (d[key] !== undefined) entry[key] = d[key]
    }
    // 新格式里默认值叫 suggested_value，旧格式叫 default。名字不同，含义一样。
    if (d.default !== undefined) entry.suggested_value = d.default
    if (entry.tier === undefined) entry.tier = 'common'
    return entry
  })

  m.parameters = parameters.length ? parameters : undefined
  if (m.parameters === undefined) delete m.parameters
  delete m.params
  return m
}

/**
 * 拖一个参数落进 parameters[] 时要改哪些地方。
 *
 * 纯函数：不读组件 state，不调 onChange。这样这一步能单独测。
 *
 * @param {object} manifest 当前名片
 * @param {object} param 扫到的参数
 * @returns {object} 新的名片
 */
export function applyParamDrop (manifest, param) {
  const name = paramNameOf(param)
  if (!name) return { ...(manifest || {}) }

  // 先迁移：旧格式还在的名片，直接写 parameters 会变成两份事实，存盘时被拒。
  const m = migrateLegacyParams(manifest)

  const list = Array.isArray(m.parameters) ? [...m.parameters] : []
  // 已经声明过同名参数就不重复加：拖两次同一个东西不该出现两条。
  if (!list.some((p) => p && p.name === name)) {
    const entry = { name, type: paramTypeOf(param), tier: 'common' }
    if (param.help) entry.help = { zh: param.help, en: param.help }
    // 下拉一律留逃生口：候选里没有想要的值时，使用者仍能自己打一个。
    if (entry.type === 'select') entry.allow_custom = true
    // 上游说明里写了「逗号分隔的 N 维」时，这一条声明成 vector：
    //   维度数由 dim_labels 的长度定，每维一个名字（先留空，让使用者自己填，
    //   上游只写了几维、没写每维叫什么）。默认值跟着长成 N 格，每格 null。
    //   替人填 0 等于替他做了决定；只写维度不写默认值，名片会被校验拒掉。
    const shape = vectorShapeFromHelp(param.help)
    if (shape && shape.repeat > 1) {
      entry.type = 'vector'
      entry.dim_labels = new Array(shape.repeat).fill('').map(() => ({ zh: '', en: '' }))
      entry.suggested_value = new Array(shape.repeat).fill(null)
    }
    list.push(entry)
  }
  m.parameters = list.length ? list : undefined

  // cli 形态：把参数名写进 call.args，声明它对应哪个命令行开关。
  // 名片里已有的条目不动：用户手填过的映射比扫描猜的准。
  if (param.source === 'cli' && m.call && m.call.kind === 'cli') {
    const args = { ...(m.call.args || {}) }
    if (!args[name]) {
      const entry = { flag: param.target }
      if (param.style) entry.style = param.style
      // 上游明说「逗号分隔」时命令行上只该出现一个词，不是 N 个词：
      //   写成 default 的 value 会被按 nargs 展开，上游只吃第一个，而且不报错。
      const shape = vectorShapeFromHelp(param.help)
      if (shape) {
        entry.style = shape.style
        entry.join = shape.join
      }
      args[name] = entry
    }
    m.call = { ...m.call, args }
  }
  return m
}
