// 模型下拉的候选计算，纯函数。候选 = 当前角色在当前引擎下的模型；底模是虚拟角色 __base__。
// 不跨角色列出（会连带换掉参考音频）。不写任何引擎 id 或位名，有守卫测试。

// 模型目录：assets/<角色>/models/<引擎id>/<模型位>/…
export const MODELS_SEGMENT = 'models'

// 名片未声明模型位时返回空数组，不兜底成固定个数。
// engine 是 /api/engines 返回的一项，取其中的 weight_slots。
// 返回 [{ name, label, param, applies_at }]，applies_at 只取 'call' 或 'launch'。
export function slotsOf(engine) {
  const slots = engine && engine.weight_slots
  if (!Array.isArray(slots)) return []
  return slots
    .filter(s => s && typeof s.name === 'string' && s.name)
    // applies_at 缺省按 launch：误判为 call 会静默失效，误判为 launch 只多一次重启。
    .map(s => ({
      name: s.name,
      label: s.label || s.name,
      param: s.param || null,
      applies_at: s.applies_at === 'call' ? 'call' : 'launch',
    }))
}

// 从模型路径取出角色名，不匹配（含底模路径）返回 ''。判断底模用 ownerOfPath。
// p 是模型路径，可以是 Windows 或 POSIX 分隔符。
export function assetIdFromModelPath(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/')
  // 必须匹配完整三层，否则 assets/<角色>/raw/ 下的素材也会被当成模型。
  const m = s.match(/(?:^|\/)assets\/([^/]+)\/models\/[^/]+\/[^/]+\//)
  return m ? m[1] : ''
}

// 按是否在候选清单中判断归属，不按路径形状：底模目录可被环境变量覆盖。
// groups 是候选分组数组，path 是要判定的路径。
// 返回 { voiceId, displayName, builtin }，不在清单里返回 null。
export function ownerOfPath(groups, path) {
  if (!path) return null
  for (const g of (groups || [])) {
    if ((g.items || []).some(it => it && it.path === path)) {
      return { voiceId: g.voiceId, displayName: g.displayName, builtin: !!g.builtin }
    }
  }
  return null
}

// 某个位的候选分组，只取当前角色；assets 为 /api/assets/voices-with-models 的 voices。
// 返回 [{ voiceId, displayName, builtin, items }]，该位没有任何候选时返回空数组。
export function candidatesForSlot(assets, engineId, slotName, voiceId) {
  if (!engineId || !slotName) return []
  const out = []
  for (const a of (assets || [])) {
    if (!a) continue
    if (a.voiceId !== voiceId) continue
    const items = ((a.models || {})[engineId] || {})[slotName]
    if (!Array.isArray(items) || items.length === 0) continue
    out.push({
      voiceId: a.voiceId,
      displayName: a.displayName || a.voiceId,
      builtin: !!a.builtin,
      items,
    })
  }
  out.sort((x, y) => (x.builtin === y.builtin ? x.voiceId.localeCompare(y.voiceId) : (x.builtin ? -1 : 1)))
  return out
}

// 音色下拉：底模，加上在该引擎每个位上都有自己模型的角色。引擎没有模型位时不筛选。
// 借用其他角色参考音频走另一个入口，不受此筛选影响。
// voices 是音色清单，assets 是角色与模型的清单，slots 是该引擎的模型位。
export function voicesForEngine(voices, assets, engineId, slots) {
  const list = Array.isArray(voices) ? voices : []
  const need = Array.isArray(slots) ? slots : []
  if (!engineId || need.length === 0) return list

  const own = new Map()
  for (const a of (assets || [])) {
    if (!a || a.builtin || !a.voiceId) continue
    own.set(a.voiceId, (a.models || {})[engineId] || {})
  }

  return list.filter(v => {
    if (!v) return false
    if (v.builtin) return true               // 底模始终保留，位置不变
    const bySlot = own.get(v.id)
    if (!bySlot) return false
    return need.every(s => {
      const items = bySlot[s.name]
      return Array.isArray(items) && items.length > 0
    })
  })
}

// 把候选分组摊平成一份候选清单。分组为空时返回空数组。
export function flattenGroups(groups) {
  const out = []
  for (const g of (groups || [])) for (const it of (g.items || [])) if (it) out.push(it)
  return out
}

// 候选在下拉里显示的一行文字。item 为空时返回空串。
export function itemLabel(item) {
  if (!item) return ''
  const bits = []
  if (item.steps != null) bits.push(`step ${item.steps}`)
  if (item.version) bits.push(item.version)
  // complete 为 null 表示无法判断，只在 false 时标注。
  if (item.complete === false) {
    const n = Array.isArray(item.missing) ? item.missing.length : 0
    bits.push(n ? `⚠ 缺 ${n} 项` : '⚠ 不完整')
  }
  return bits.length ? `${item.name} (${bits.join(' · ')})` : String(item.name || '')
}

// 后端生成的模型提示，用于解释下拉为何为空。
// 返回该角色在该引擎下的提示数组，没有提示时返回空数组。
export function modelNotesFor(assets, engineId, voiceId) {
  if (!engineId || !voiceId) return []
  for (const a of (assets || [])) {
    if (!a || a.builtin || a.voiceId !== voiceId) continue
    return (a.model_notes || []).filter(n => n && n.engine === engineId && n.text)
  }
  return []
}

// 有 param 的位按 param 发给引擎；其余位（启动时载入）由 launchWeightsToSend 交给平台。
// 引擎不读的键不发，否则用户会以为已经切换。
// selection 是按位名索引的选择，返回按参数名索引的对象。
export function weightsToSend(slots, selection) {
  const out = {}
  for (const s of (slots || [])) {
    if (!s || !s.param) continue
    const v = selection && selection[s.name]
    if (!v) continue
    out[s.param] = v
  }
  return out
}

// 启动时载入的位交给平台：键是位名，因为收件人是平台而不是引擎。
// 与 weightsToSend 分工明确，两者合起来把每个位分完，不重不漏。
export function launchWeightsToSend(slots, selection) {
  const out = {}
  for (const s of (slots || [])) {
    // 名片解析出的位两个条件等价，同时检查以兼容手写位表。
    if (!s || s.param || s.applies_at === 'call') continue
    const v = selection && selection[s.name]
    if (!v) continue
    out[s.name] = v
  }
  return out
}

// 从请求体或配方读回选择（Rerun、载入配方）。必须同时读 launch_weights，否则会回到底模。
// 返回按位名索引的对象，读到的值一律转成字符串，值为 null 时读成空串。
export function weightsFromParams(slots, params) {
  const out = {}
  const launched = (params && params.launch_weights) || {}
  for (const s of (slots || [])) {
    if (!s) continue
    if (s.param) {
      const v = params ? params[s.param] : undefined
      if (v !== undefined) out[s.name] = v == null ? '' : String(v)
      continue
    }
    const lv = launched[s.name]
    if (lv !== undefined) out[s.name] = lv == null ? '' : String(lv)
  }
  return out
}

// 是否有任何一位可以换模型：一个位都没有时返回 false。
export function anySlotSwitchable(slots) {
  return (slots || []).some(s => s && (!!s.param || s.applies_at !== 'call'))
}

// 换一份就要重开引擎的位名清单。启动时载入的位在列表里，一次调用就能换的不在。
export function slotsNeedingRelaunch(slots) {
  return (slots || []).filter(s => s && s.applies_at !== 'call').map(s => s.name)
}

// 历史记录的「引擎 · 位名 模型」文字。不假设位数，未选的位写「位名 -」。
// 旧条目没有 weights 时返回 ''。
export function describeGeneration(item) {
  const parts = []
  const engine = item && (item.engine_label || item.engine_id)
  if (engine) parts.push(String(engine))
  const weights = (item && Array.isArray(item.weights)) ? item.weights : []
  const slots = weights
    .filter(w => w && w.name)
    .map(w => `${w.label || w.name} ${w.value || '-'}`)
  if (slots.length) parts.push(slots.join(' / '))
  return parts.join(' · ')
}

// 读取角色 meta.json：meta.assets.models = { <引擎id>: { <模型位>: [模型…] } }。
// 须与后端 lib/assets/modelLayout.js 保持一致。
// 返回这个角色有模型的引擎 id 清单，目录在但里面为空的不算。
export function enginesInMeta(meta) {
  const models = (meta && meta.assets && meta.assets.models) || {}
  return Object.keys(models)
    .filter(e => Object.values(models[e] || {}).some(l => Array.isArray(l) && l.length > 0))
    .sort()
}

// 取某个引擎某个位的候选清单。取不到时返回空数组，不是 undefined。
export function modelsFromMeta(meta, engineId, slotName) {
  const byEngine = (meta && meta.assets && meta.assets.models) || {}
  const slots = byEngine[engineId] || {}
  const list = slots[slotName]
  return Array.isArray(list) ? list : []
}

// 这个角色一共装了多少个模型，各引擎各位的清单长度之和。
export function countModelsInMeta(meta) {
  const models = (meta && meta.assets && meta.assets.models) || {}
  let n = 0
  for (const slots of Object.values(models)) {
    for (const list of Object.values(slots || {})) if (Array.isArray(list)) n += list.length
  }
  return n
}

// 按引擎分组的模型数量，返回 [{ engineId, count }]，只列数量大于 0 的引擎。
export function modelCountsByEngine(meta) {
  const models = (meta && meta.assets && meta.assets.models) || {}
  return Object.keys(models).sort().map(engineId => ({
    engineId,
    count: Object.values(models[engineId] || {})
      .reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0),
  })).filter(x => x.count > 0)
}

// 默认选择：旧选择仍在清单中则保留，否则取 default 项或第一项。
// 失效的必须替换（否则发出别的引擎的模型），有效的必须保留（否则刷新会重置用户选择）。
// slots 是模型位，groupsBySlot 按位名索引候选分组，prev 是上一次的按位名索引的选择。
// 返回按位名索引的选择，该位没有候选时是空串。
export function reconcileSelection(slots, groupsBySlot, prev) {
  const out = {}
  for (const s of (slots || [])) {
    const flat = flattenGroups((groupsBySlot || {})[s.name])
    const keep = prev && prev[s.name]
    out[s.name] = (keep && flat.some(i => i.path === keep))
      ? keep
      : ((flat.find(i => i.default) || flat[0] || {}).path || '')
  }
  return out
}

// 平台自有字段，不进参数摘要。
const PLATFORM_PARAM_KEYS = new Set([
  'seed', 'aux_ref_audio_paths', 'pron_overrides', 'lang_overrides', 'han_readings',
  'media_type', 'mediaType', 'format', 'batch_id', 'batch_seq', 'batch_total', 'batch_label',
])

// 配方参数摘要：先按 param_schema 顺序，再追加 schema 外的键（引擎可能未安装）。
// 返回 { short, full, count, unknown }，unknown 为 schema 外的键数。
export function paramsSummaryOf(params, engine, limit = 3) {
  const p = (params && typeof params === 'object') ? params : {}
  const schema = (engine && Array.isArray(engine.param_schema)) ? engine.param_schema : []
  const known = new Map()
  for (const f of schema) {
    if (f && f.name !== undefined && !PLATFORM_PARAM_KEYS.has(f.name)) known.set(f.name, f)
  }

  const ordered = []
  const seen = new Set()
  for (const f of schema) {
    const n = f && f.name
    if (n === undefined || seen.has(n)) continue
    if (!Object.prototype.hasOwnProperty.call(p, n)) continue
    if (PLATFORM_PARAM_KEYS.has(n)) continue
    ordered.push(n); seen.add(n)
  }
  for (const k of Object.keys(p)) {
    if (seen.has(k) || PLATFORM_PARAM_KEYS.has(k)) continue
    if (p[k] === undefined) continue
    ordered.push(k); seen.add(k)
  }

  const fmt = (k, v) => {
    const val = Array.isArray(v) ? `[${v.length}]` : (v && typeof v === 'object' ? '{…}' : String(v))
    return `${k} ${val}`
  }
  const all = ordered.map(k => fmt(k, p[k]))
  const count = all.length
  let unknown = 0
  for (const k of ordered) if (!known.has(k)) unknown += 1

  const n = Math.max(0, limit)
  return {
    short: all.slice(0, n).join(' · '),
    full: all.join(' · '),
    count,
    unknown,
  }
}
