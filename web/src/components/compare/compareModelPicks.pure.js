// 对比页的模型轴：每个角色的逐位候选、默认选择、参考位、请求体权重字段与旧行模型归一。
// 位名、位标签与参数名全部来自名片；旧行模型的两个位字段按位置迁移（compareRowMigrate）。

import { modelsFromMeta, slotsOf, weightsToSend, launchWeightsToSend } from '../../lib/modelPickers.pure.js'
import { migrateRowModelShape } from '../../lib/compareRowMigrate.js'

// 一个候选项在下拉与摘要里的文字。名称缺失时改用路径，版本与步数只在存在时标注。
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
// 任一位没有候选时返回 null：缺少任一位的行在合成时必然缺权重。
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
    // 所有位都有 default 候选 ⇒ 该角色有推荐的默认组合。
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

// 某个角色某个位当前选中的候选项。找不到时返回 null。
export function modelItem(models, voiceId, slotName, path) {
  return slotOptions(models, slotName, voiceId).find(it => it.path === path) || null
}

// 一个角色每个位可选的候选项（按名片位序，路径为空的候选项排除）。
function picksBySlotList(slots, entry) {
  return (slots || [])
    .filter(s => s && s.name)
    .map(s => ({ slot: s, items: (((entry && entry.itemsBySlot) || {})[s.name] || []).filter(it => it && it.path) }))
}

// 各位的第一项：忽略推荐标记。
export function firstPicksOf(slots, entry) {
  const out = {}
  for (const { slot, items } of picksBySlotList(slots, entry)) {
    if (items[0]) out[slot.name] = items[0].path
  }
  return out
}

// 每个位都标了推荐项时取各位的推荐项，否则取各位的第一项：只有一个位有推荐项时不能只取它，
// 另一位按它在候选中的实际顺序取。
export function defaultPicksOf(slots, entry) {
  const lists = picksBySlotList(slots, entry)
  if (lists.length === 0 || !lists.every(({ items }) => items.some(it => it.default))) return firstPicksOf(slots, entry)
  const out = {}
  for (const { slot, items } of lists) {
    const pick = items.find(it => it.default)
    if (pick) out[slot.name] = pick.path
  }
  return out
}

// 全部角色、全部位的候选路径，按位名索引。
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

// 一条选择相对「该位现有候选路径集合」是否已失效。集合由调用方算一次复用，不在渲染每一位时重算全表。
// 该位的候选清单为空时不判断：说明清单尚未加载完成，界面不能替它推测。
export function isPathStale(knownBySlot, slotName, path) {
  const known = (knownBySlot || {})[slotName]
  return !!(path && known && known.size > 0 && !known.has(path))
}

// 发请求前逐位检查，返回 { slot, path } 的问题清单；空清单表示可以发送。
export function stalePicks(slots, rowModel, models) {
  const known = candidatePathsBySlot(models)
  return (slots || [])
    .map(s => ({ slot: s, path: (rowModel && rowModel.picks[s.name]) || '' }))
    .filter(x => isPathStale(known, x.slot.name, x.path))
}

// 参考音频跟随带 param 的位里排在最后的那一位。名片没有说明哪一位是音色位，能用的判据只剩位序：
// 调整名片 weights 的顺序，参考侧跟随的位就跟着变。
export function referenceSlotOf(slots) {
  const withParam = (slots || []).filter(s => s && s.name && s.param)
  const slot = withParam[withParam.length - 1]
  return slot ? slot.name : ''
}

// 参考侧的角色：该位跨角色选过就用它归属的角色，否则用这一行的主角色。
export function referenceVoiceOf(rowModel, slots, fallback = '') {
  const name = referenceSlotOf(slots)
  const owner = name ? (rowModel && rowModel.owners && rowModel.owners[name]) : ''
  return owner || (rowModel && rowModel.voiceId) || fallback || ''
}

// 参考角色的语种：先查逐位候选表（它带 language），再查角色清单，都没有用调用方给的回落值。
// 界面每一处都要问这同一件事，查找顺序写在一处；回落值仍由调用方给，它知道自己那层还有什么可用。
export function rowVoiceLanguage({ models, voices, voiceId, fallback = 'ja' }) {
  const fromModels = (models || []).find(m => m && m.voiceId === voiceId)
  if (fromModels && fromModels.language) return fromModels.language
  const fromVoices = (voices || []).find(v => v && (v.id || v.voiceId) === voiceId)
  if (fromVoices && fromVoices.language) return fromVoices.language
  return fallback || 'ja'
}

// 换某一位之后要不要把参考来源切到跨角色选择器。
// 只有混搭下、换的正是参考位、新选的那份属于底模（底模自己没有切片）、且当前还停在「本音色切片」
// 时才切：其余情况用户的来源选择是他自己定的，界面不动它。
export function shouldSwitchRefToCross({ mix, slotName, owner, refSlot, refSource, baseVoiceId }) {
  return !!(mix && refSlot && slotName === refSlot && owner === baseVoiceId && refSource === 'slices')
}

// 行模型 → 要合并进请求体的权重字段：call 位按参数名平铺，launch 位写入 launch_weights。
// 这里不筛候选：所选已不在候选中时由界面在发请求前拦下（stalePicks）；静默不发送会让
// 引擎沿用上一行切换的那份权重，结果取决于行的执行顺序。
export function compareWeightBody(engine, rowModel) {
  const slots = slotsOf(engine)
  const rm = normalizeRowModel(rowModel, slots)
  const params = weightsToSend(slots, rm.picks)
  const launch = launchWeightsToSend(slots, rm.picks)
  return Object.keys(launch).length > 0 ? { ...params, launch_weights: launch } : params
}

// 统一成 { voiceId, picks: {位名: 路径}, owners: {位名: 角色}, mix }。
// 旧形状的两个位字段由 compareRowMigrate 按位置映射到当前名片的位。
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
