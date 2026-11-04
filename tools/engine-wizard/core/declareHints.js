'use strict'

// 声明的自动嗅探：只把「形式明确」的参数升级成可选能力的输入，拿不准的一律不猜。
// 猜错的代价不是少一个控件，是平台把一个普通参数当成自己的语义去接管，且不报错。
// 这里全是纯函数，产出「建议」；写不写进名片由调用方按「已有声明不覆盖」决定。

// 归一化：--emotion-audio / --emotionAudio / --emotion_audio 是同一个词。
function normWord (name) {
  return String(name || '')
    .replace(/^-+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

// 音频类输入：明确带「情绪 / 辅助 / 风格 / 音色」这类前缀的音频路径参数。
// 主参考音频（ref_audio / voice / prompt_wav）不在这里：那是 bind 的四个核心槽位之一，
//   再标一次会让平台把同一个开关发两遍。情绪文本与情绪向量也不是音频，不收。
const AUDIO_REF_RE = /^(emotion|aux|secondary|style|timbre|reference)(_?(ref|reference))?_?(audio|wav|wave|speech)s?(_paths?)?$/

/** 命中返回 'audio_ref'，否则 null。 */
function audioRoleFor (name) {
  return AUDIO_REF_RE.test(normWord(name)) ? 'audio_ref' : null
}

const FORMAT_PARAM_RE = /^(output_)?(audio_)?format$/
const FORMAT_RE = /^(wav|mp3|flac|ogg|opus|aac|m4a|pcm)$/i

/**
 * 从 argparse 的 choices 里推出输出格式声明。没有 choices 就不给建议：
 * 引擎能出什么格式，参数名说明不了，替它猜等于给出错误的 400 判据。
 * @returns {string[]} 建议的 output_formats，拿不准时空数组
 */
function formatHintsFrom (params) {
  for (const p of (params || [])) {
    if (!p || !FORMAT_PARAM_RE.test(normWord(p.name))) continue
    const choices = Array.isArray(p.choices) ? p.choices : []
    const found = choices.map((c) => String(c).toLowerCase()).filter((c) => FORMAT_RE.test(c))
    if (found.length) return [...new Set(found)]
  }
  return []
}

/**
 * 认出「参数从哪个开关进去」：值域明确的格式参数才建议，返回归一化后的参数名。
 * 与 formatHintsFrom 同源，两个结果必须落在同一个开关上，否则下拉给的值送不到命令行。
 * @returns {string|null}
 */
function formatArgNameFrom (params) {
  for (const p of (params || [])) {
    if (!p || !FORMAT_PARAM_RE.test(normWord(p.name))) continue
    const choices = Array.isArray(p.choices) ? p.choices : []
    if (choices.some((c) => FORMAT_RE.test(String(c).toLowerCase()))) return normWord(p.name)
  }
  return null
}

// 权重位：只有同时出现两个以上「模型类」开关才建议。单个开关是必填区
//   「模型权重」那一格（{checkpoints}）的事，不是多权重位。
// 权重位只认带明确角色前缀的模型开关（gpt / llm / vocoder / decoder …），
//   前缀一律用通用架构词，不收任何上游专有的名字。
// model_dir / checkpoint_path 这类通用权重路径不是「用户可挑的模型位」，
//   跨脚本凑成一对更不该当成两位，它们由必填区的 {checkpoints} 那一格管。
const WEIGHT_ROLE_RE = /^(gpt|llm|vocoder|decoder|acoustic|generator|speaker_encoder|semantic|flow|duration)_?(model|ckpt|path|weights?)?$/

/**
 * 只有同一个文件里同时出现两个以上「角色型」模型开关才建议。
 * @returns {{name, label, param, applies_at}[]}
 */
function weightSlotHintsFrom (params) {
  const byFile = new Map()
  for (const p of (params || [])) {
    if (!p || p.source !== 'cli' || !p.name) continue
    const n = normWord(p.name)
    if (!WEIGHT_ROLE_RE.test(n)) continue
    const f = p.source_file || '(unknown)'
    if (!byFile.has(f)) byFile.set(f, [])
    const list = byFile.get(f)
    if (!list.includes(n)) list.push(n)
  }
  for (const [, list] of byFile) {
    if (list.length < 2) continue
    return list.map((n) => ({
      name: n,
      label: n.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      param: n,
      applies_at: 'call',
    }))
  }
  return []
}

module.exports = {
  normWord, audioRoleFor, formatHintsFrom, formatArgNameFrom, weightSlotHintsFrom,
}
