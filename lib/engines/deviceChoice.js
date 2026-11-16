'use strict'
// 运行设备是启动期设置：每台引擎当前选的是哪块卡，由平台在进程存活期间记着。
//   不进名片（A60：名片只承载形状，不承载具体卡），也不落盘：平台重启后没有选择
//   就是「自动」，引擎用自己的默认值，不需要恢复，也不需要为它做持久化。
// 没声明 role="device" 的引擎根本不出入口，这里也不会被问到。
const { resolveDeviceArgs } = require('./deviceValue')

const choices = new Map()

/** 记下这台引擎选中的卡。auto / 没选等于撤销选择。 */
function setDeviceChoice(id, pick) {
  if (!id) return null
  if (!pick || typeof pick !== 'object' || pick.kind === 'auto') {
    choices.delete(id)
    return null
  }
  choices.set(id, pick)
  return pick
}

/** 起引擎时读一次：换成这台引擎认的写法，作为 loadParams 写进启动 profile。 */
function deviceLoadParams(id, call) {
  const pick = choices.get(id)
  if (!pick) return {}
  return resolveDeviceArgs(call || {}, pick)
}

function getDeviceChoice(id) {
  return choices.get(id) || null
}

module.exports = { setDeviceChoice, deviceLoadParams, getDeviceChoice }
