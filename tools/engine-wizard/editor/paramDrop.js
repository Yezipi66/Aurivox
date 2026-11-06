// 拖一个参数落进 Manifest 时，纯计算那部分。
// 纯函数放自己的文件：组件模块只导出组件，导出别的会让 Fast Refresh 失效。

import { paramTypeOf } from './paramType.js'

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
    if (param.help) entry.help = param.help
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
      args[name] = entry
    }
    m.call = { ...m.call, args }
  }
  return m
}
