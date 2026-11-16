// 引擎配置区里「运行设备」占几格。
//   住在单独的 .js 里，是因为 DeviceField.jsx 是组件模块：组件模块只导出组件，
//   多导出一个普通函数会让 Fast Refresh 失效（editorModuleShape 那条守卫管的就是这件事）。
//
//   没声明时也给一格让人填；声明了就按名片里 role=device 的项数。
//   引擎配置区标题的计数与 DeviceField 的渲染都读这一份，免得格子数与徽标各算一份。

/** @returns {Array<[string, object|null]>} [开关名, call.args 里的那一项] */
export function deviceSlots (manifest) {
  const args = ((manifest || {}).call || {}).args || {}
  const rows = Object.entries(args).filter(([, entry]) => entry && entry.role === 'device')
  return rows.length ? rows : [['device', null]]
}
