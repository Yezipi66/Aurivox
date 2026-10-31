// 对比页的模型轴：按名片的权重位生成组合、读回本地存储的选择、决定参考音频跟随哪个位。
// 位名、位标签与参数名全部来自名片。只有存量 localStorage 的迁移认得旧界面写死的两个位名。

import { weightsToSend, launchWeightsToSend } from '../../lib/modelPickers.pure.js'

// 每个角色最多列出的模型组合数。位与候选一多，笛卡尔积会迅速越过下拉能用的规模。
export const MODEL_COMBO_LIMIT = 24

// 按位取笛卡尔积。limit 只限制返回的组合，total 仍是完整积：调用方据此报告被丢弃的数量。
// 任何一个位没有候选时返回 0 组：缺一个位的组合在合成时必然缺权重。
// 返回 { combos: [{ picks: {位名: 路径}, items: {位名: 候选项} }], total, dropped }。
export function modelCombos(slots, listsBySlot, limit = MODEL_COMBO_LIMIT) {
  const usable = (slots || []).filter(s => s && typeof s.name === 'string' && s.name)
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  if (usable.length === 0 || cap === 0) return { combos: [], total: 0, dropped: 0 }
  const lists = usable.map(s => {
    const list = (listsBySlot && listsBySlot[s.name]) || []
    return list.filter(it => it && typeof it.path === 'string' && it.path)
  })
  if (lists.some(l => l.length === 0)) return { combos: [], total: 0, dropped: 0 }
  let total = 1
  for (const l of lists) total *= l.length

  const combos = []
  const picks = {}
  const items = {}
  // 先出现的位变化最慢，最后一位变化最快，与旧下拉逐层展开的顺序一致。
  const walk = (i) => {
    if (combos.length >= cap) return
    if (i === usable.length) {
      combos.push({ picks: { ...picks }, items: { ...items } })
      return
    }
    const name = usable[i].name
    for (const it of lists[i]) {
      picks[name] = it.path
      items[name] = it
      walk(i + 1)
      if (combos.length >= cap) return
    }
  }
  walk(0)
  return { combos, total, dropped: total - combos.length }
}

// 一个候选项在下拉与摘要里的文字。名称缺失时退回路径，版本与步数只在存在时标注。
export function slotItemText(item) {
  if (!item) return ''
  const name = item.name || item.path || ''
  return `${name}${item.version ? ` [${item.version}]` : ''}${item.steps ? ` (${item.steps})` : ''}`
}

// 参考音频跟随第一个能换的位（带 param 的位）。名片没有音色位的概念，不替它发明一个。
export function referenceSlotOf(slots) {
  const slot = (slots || []).find(s => s && s.name && s.param)
  return slot ? slot.name : ''
}

// 参考侧的角色：该位跨角色选过就用它归属的角色，否则用这一行的主角色。
export function referenceVoiceOf(rowModel, slots, fallback = '') {
  const rm = normalizeRowModel(rowModel)
  const name = referenceSlotOf(slots)
  const owner = name ? rm.owners[name] : ''
  return owner || rm.voiceId || fallback || ''
}

// 请求体里的权重字段：call 位按参数名平铺，launch 位按位名交给平台。
export function weightRequestFields(slots, picks) {
  return {
    params: weightsToSend(slots, picks),
    launch_weights: launchWeightsToSend(slots, picks),
  }
}

// 统一成 { voiceId, picks: {位名: 路径}, owners: {位名: 角色}, mix }。
// 旧形状把两个位写死成 gptCheckpoint/sovitsModel 与 gptVoiceId/sovitsVoiceId，
// 这里只为读回存量 localStorage 与旧配方保留这条兼容路径。
export function normalizeRowModel(rowModel) {
  const src = (rowModel && typeof rowModel === 'object' && !Array.isArray(rowModel)) ? rowModel : {}
  const picks = {}
  const owners = {}
  const srcPicks = (src.picks && typeof src.picks === 'object' && !Array.isArray(src.picks)) ? src.picks : null
  if (srcPicks) {
    for (const [k, v] of Object.entries(srcPicks)) if (v) picks[k] = v
  } else {
    if (src.gptCheckpoint) picks.gpt = src.gptCheckpoint
    if (src.sovitsModel) picks.sovits = src.sovitsModel
  }
  const srcOwners = (src.owners && typeof src.owners === 'object' && !Array.isArray(src.owners)) ? src.owners : null
  if (srcOwners) {
    for (const [k, v] of Object.entries(srcOwners)) if (v) owners[k] = v
  } else {
    if (src.gptVoiceId) owners.gpt = src.gptVoiceId
    if (src.sovitsVoiceId) owners.sovits = src.sovitsVoiceId
  }
  return { voiceId: src.voiceId || '', picks, owners, mix: !!src.mix }
}
