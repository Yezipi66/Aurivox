// 拖一个参数落进名片时，纯计算那部分。
//
// 为什么单独一个文件：这两个函数原先在 ParamDropZone.jsx 里并从那儿导出。
// ParamDropZone.jsx 是组件模块，而 vite 的 react 插件要求组件模块只导出组件
// （导出别的函数 ⇒ Fast Refresh 失效，改那个文件会整页 reload，
// 日志里报 Could not Fast Refresh ("..." export is incompatible)）。
// 纯函数放自己的文件，组件模块就干净了。
//
// 这个项目里纯函数都是这么放的：manifestAutoFill.js / scanAutofill.js / paramType.js。

import { paramTypeOf } from './paramType.js'

// 中栏的落点：界面参数区（parameters[]）。
//
// 左栏扫到的参数拖到这里，就变成名片的一条界面参数。
// 名片里 parameters[] 的每一项都有 name / type 等字段；拖进来时按
// 扫到的信息预填，用户再改。
//
// 参数名从哪来：扫到的 cli 参数是命令行开关（--speed），
// 界面参数的名字是平台侧的名字，去掉开头的横线（speed）。
// python 参数本身就是方法参数名，原样用。
//
// 拖进来的 cli 参数还要写 call.args：宿主在命令行形态下只认 call.args 里
// 声明过的名字（host.py 的 args_table），参数名没在那儿声明就被拒。
// 这里写的是用户刚刚拖进来的那个开关，不是平台猜的对应关系。

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
  const m = { ...(manifest || {}) }
  const name = paramNameOf(param)
  if (!name) return m

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
