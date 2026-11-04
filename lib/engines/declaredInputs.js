'use strict'

// 名片 call.args 里带 role 的项 = 平台声明的输入。
// 平台只认声明：没声明的能力，界面不长控件、请求不带值、宿主不展开开关。
// 这份清单是单一真源，前端（按它长控件）与后端（按它透传）都从这里取。
//
// 与具体引擎无关：role 说的是「这一格由平台的哪个控件喂」，开关名、标签、
// 单值还是多值都写在名片上。平台不需要理解那个开关在上游叫什么语义。

const AUDIO_ROLE = 'audio_ref'
const DEVICE_ROLE = 'device'
const ROLES = Object.freeze([DEVICE_ROLE, AUDIO_ROLE])

/**
 * 列出名片声明的输入。
 * @param {object} call 名片的 call 段
 * @returns {{name, role, flag, label, labelEn, multiple}[]}
 */
function declaredInputs (call) {
  const args = (call && call.args) || {}
  const out = []
  for (const [name, entry] of Object.entries(args)) {
    if (!entry || !ROLES.includes(entry.role)) continue
    out.push({
      name,
      role: entry.role,
      flag: entry.flag || '--' + name,
      label: entry.label || name,
      labelEn: entry.label_en || entry.label || name,
      // repeat / join 是 cli 形态里「多个值」的两种写法，界面据此给多选控件。
      multiple: entry.style === 'repeat' || entry.style === 'join',
    })
  }
  return out
}

/** 只取音频类输入。设备由 deviceValue.js 单独处理，不混进这一路。 */
function audioInputs (call) {
  return declaredInputs(call).filter((x) => x.role === AUDIO_ROLE)
}

/**
 * 把界面选中的音频路径换成要下发的引擎参数。
 * 只认声明过的名字：没声明的键一律丢掉，避免请求里多出一个引擎不认的开关。
 * 路径解析（受管路径 → 绝对路径）在调用方做，这里不碰文件系统。
 *
 * @param {object} call 名片 call 段
 * @param {object} picked { [参数名]: string | string[] }
 * @returns {object} 要并进 engine_params 的键值
 */
function resolveAudioArgs (call, picked) {
  const out = {}
  const src = picked && typeof picked === 'object' ? picked : {}
  for (const decl of audioInputs(call)) {
    const raw = src[decl.name]
    if (raw === undefined || raw === null) continue
    let value = Array.isArray(raw) ? raw.filter(Boolean) : [raw]
    if (!value.length) continue
    if (!decl.multiple) value = value.slice(0, 1)
    // 单选发字符串，多选发数组；host 的 style=value / repeat 分别展开。
    out[decl.name] = decl.multiple ? value : value[0]
  }
  return out
}

module.exports = { AUDIO_ROLE, DEVICE_ROLE, ROLES, declaredInputs, audioInputs, resolveAudioArgs }
