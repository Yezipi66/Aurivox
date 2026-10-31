// 对比页的模型轴：每个角色的逐位候选、默认选择、参考位、请求体权重字段与旧行模型归一。
// 位名、位标签与参数名全部来自名片；旧行模型的两个位字段按位置迁移（compareRowMigrate）。

import { modelsFromMeta, slotsOf, weightsToSend, launchWeightsToSend } from '../../lib/modelPickers.pure.js'
import { migrateRowModelShape } from '../../lib/compareRowMigrate.js'

// 一个候选项在下拉与摘要里的文字。名称缺失时退回路径，版本与步数只在存在时标注。
export function slotItemText(item) {
  if (!item) return ''
  const name = item.name || item.path || ''
  return `${name}${item.version ? ` [${item.version}]` : ''}${item.steps ? ` (${item.steps})` : ''}`
}

// 混搭表头的每段文字：有版本只标版本，没有版本标步数。与同角色表头的完整标注不同，
// 这是混搭路径上逐段拼标签的格式。
export function slotHeaderText(item) {
  if (!item) return ''
  const name = item.name || item.path || ''
  if (item.version) return `${name} [${item.version}]`
  return `${name}${item.steps ? ` (${item.steps})` : ''}`
}

// 一个角色在某个引擎下的候选：每个权重位一份清单，不做组合展开。
// 任一位没有候选时返回 null：缺一个位的行合成时必然缺权重。
export function voiceEntry(slots, engineId, meta, voiceId) {
  if (!Array.isArray(slots) || slots.length === 0) return null
  const itemsBySlot = {}
  for (const s of slots) {
    const list = modelsFromMeta(meta, engineId, s.name)
    if (list.length === 0) return null
    itemsBySlot[s.name] = list
  }
  return {
    voiceId,
    voiceName: (meta && meta.display_name) || voiceId,
    language: (meta && meta.language) || '',
    builtin: !!(meta && meta.builtin),
    itemsBySlot,
    // 所有位都有 default 候选 ⇒ 这个角色带着推荐默认组合。
    default: slots.every(s => itemsBySlot[s.name].some(it => it && it.default)),
  }
}

// 某个角色某个位的候选。角色不存在或该位没有候选时返回空数组。
export function slotOptions(models, slotName, voiceId) {
  if (!voiceId || !slotName) return []
  const m = (models || []).find(x => x && x.voiceId === voiceId)
  const list = (m && m.itemsBySlot && m.itemsBySlot[slotName]) || []
  return list.filter(it => it && it.path)
}

// 某个路径属于哪个角色。找不到返回空串。
export function ownerOfModel(models, slotName, path) {
  if (!path) return ''
  const m = (models || []).find(x => ((x.itemsBySlot || {})[slotName] || []).some(it => it && it.path === path))
  return (m && m.voiceId) || ''
}

// 某个角色某个位当前选中的候选项。找不到返回 null。
export function modelItem(models, voiceId, slotName, path) {
  return slotOptions(models, slotName, voiceId).find(it => it.path === path) || null
}

// 一个角色的默认选择：每个位都有 default 项时取各位的 default，否则取各位的第一项。
// 只有一个位带 default 时不能只取它：旧界面找的是所有位都 default 的组合，找不到就取第一组。
export function defaultPicksOf(slots, entry) {
  const out = {}
  const usable = (slots || []).filter(s => s && s.name)
  if (usable.length === 0) return out
  const lists = usable.map(s => (((entry && entry.itemsBySlot) || {})[s.name] || []).filter(it => it && it.path))
  const allDefault = lists.every(l => l.some(it => it.default))
  usable.forEach((s, i) => {
    const pick = allDefault ? lists[i].find(it => it.default) : lists[i][0]
    if (pick) out[s.name] = pick.path
  })
  return out
}

// 全部角色、全部位的候选路径，按位名索引。请求体只发这里面的路径：
// 下拉里展示不出来的选择发出去，用户看到的是 A、引擎收到的是 B。
export function candidatePathsBySlot(models) {
  const out = {}
  for (const m of (models || [])) {
    for (const [name, items] of Object.entries((m && m.itemsBySlot) || {})) {
      if (!out[name]) out[name] = new Set()
      for (const it of (items || [])) if (it && it.path) out[name].add(it.path)
    }
  }
  return out
}

// 参考音频跟随第一个能换的位（带 param 的位）。名片没有音色位的概念，不替它发明一个。
export function referenceSlotOf(slots) {
  const slot = (slots || []).find(s => s && s.name && s.param)
  return slot ? slot.name : ''
}

// 参考侧的角色：该位跨角色选过就用它归属的角色，否则用这一行的主角色。
export function referenceVoiceOf(rowModel, slots, fallback = '') {
  const name = referenceSlotOf(slots)
  const owner = name ? (rowModel && rowModel.owners && rowModel.owners[name]) : ''
  return owner || (rowModel && rowModel.voiceId) || fallback || ''
}

// 行模型 → 要合并进请求体的权重字段：call 位按参数名平铺，launch 位放进 launch_weights。
// candidatesBySlot 给出当前候选路径时，不在其中的选择不发（没有候选的位不拦）。
export function compareWeightBody(engine, rowModel, candidatesBySlot) {
  const slots = slotsOf(engine)
  const rm = normalizeRowModel(rowModel, slots)
  const picks = {}
  for (const [name, p] of Object.entries(rm.picks)) {
    const known = candidatesBySlot && candidatesBySlot[name]
    if (known && known.size > 0 && !known.has(p)) continue
    picks[name] = p
  }
  const params = weightsToSend(slots, picks)
  const launch = launchWeightsToSend(slots, picks)
  return Object.keys(launch).length > 0 ? { ...params, launch_weights: launch } : params
}

// 统一成 { voiceId, picks: {位名: 路径}, owners: {位名: 角色}, mix }。
// 旧形状的两个位字段由 compareRowMigrate 按位置交给当前名片的位。
export function normalizeRowModel(rowModel, slots) {
  const src = (rowModel && typeof rowModel === 'object' && !Array.isArray(rowModel)) ? rowModel : {}
  const picks = {}
  const owners = {}
  const srcPicks = (src.picks && typeof src.picks === 'object' && !Array.isArray(src.picks)) ? src.picks : null
  if (srcPicks) {
    for (const [k, v] of Object.entries(srcPicks)) if (v) picks[k] = v
    const srcOwners = (src.owners && typeof src.owners === 'object' && !Array.isArray(src.owners)) ? src.owners : null
    if (srcOwners) for (const [k, v] of Object.entries(srcOwners)) if (v) owners[k] = v
  } else {
    const legacy = migrateRowModelShape(src, slots)
    Object.assign(picks, legacy.picks)
    Object.assign(owners, legacy.owners)
  }
  return { voiceId: src.voiceId || '', picks, owners, mix: !!src.mix }
}
