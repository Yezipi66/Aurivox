'use strict'

// 名片 call.args 里带 role 的项 = 可选能力的输入。
// 平台只认声明：没声明的能力，界面不长控件、请求不带值、宿主不展开开关。
// 这份清单是单一真源，前端（按它长控件）与后端（按它透传）都从这里取。
//
// 与具体引擎无关：role 说的是「这一格由平台的哪个控件喂」，开关名与标签
// 都写在名片上。平台不需要理解那个开关在上游叫什么语义。

const AUDIO_ROLE = 'audio_ref'
const DEVICE_ROLE = 'device'
const FORMAT_ROLE = 'output_format'
const ROLES = Object.freeze([DEVICE_ROLE, AUDIO_ROLE, FORMAT_ROLE])

/**
 * 列出名片声明的输入。
 * @param {object} call 名片的 call 段
 * @returns {{name, role, flag, label, labelEn}[]}
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
    })
  }
  return out
}

/** 只取音频类输入。设备由 deviceValue.js 单独处理，不混进这一路。 */
function audioInputs (call) {
  return declaredInputs(call).filter((x) => x.role === AUDIO_ROLE)
}

/** 输出格式的开关声明。没声明就不长下拉，也不往命令行发格式。 */
function formatInput (call) {
  return declaredInputs(call).find((x) => x.role === FORMAT_ROLE) || null
}

/** 把界面选中的格式换成要下发的引擎参数，只认声明过的那一个名字。 */
function resolveFormatArg (call, value) {
  const decl = formatInput(call)
  if (!decl || value === undefined || value === null || value === '') return {}
  return { [decl.name]: String(value) }
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
    const value = Array.isArray(raw) ? raw.filter(Boolean) : [raw]
    if (!value.length) continue
    // 一律发数组：picker 就是多选列表。单值开关由 host 按 style 展开，
    //   --flag path（value 形式）与 --flag p1 --flag p2（repeat 形式）都认。
    out[decl.name] = value
  }
  return out
}

module.exports = {
  AUDIO_ROLE, DEVICE_ROLE, FORMAT_ROLE, ROLES,
  declaredInputs, audioInputs, resolveAudioArgs, formatInput, resolveFormatArg,
}
