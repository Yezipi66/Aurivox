// `select` + `source` 的候选表，不含 React 那一半（带 JSX 的文件没法通过 node --test，
// 而挑候选、去重、fail-open 这些是会出错的地方，不能没有判据守着）。
// 名片里一个下拉的选项有两个来源：choices（名片写死的一串）与 source（平台扫盘
// 扫出来的一串），这里只负责后者，且只认三个库：voices / weights / audio。这三个词
// 是平台的词汇表，不是任何一台引擎的。
// 这里不做校验：候选是候选，不是限制。拿一份可能过期的名单去卡，症状是「我明明
// 选了它却没生效」，而且不报错。

/** 平台认识的库，必须与后端的来源清单保持一致。 */
export const SELECT_SOURCES = ['voices', 'weights', 'audio']

export function basenameOf(p) {
  const s = String(p == null ? '' : p)
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}

export function voiceOptions(voices) {
  return (Array.isArray(voices) ? voices : [])
    .filter(v => v && v.id)
    .map(v => ({ value: v.id, label: v.display_name || v.id }))
}

// 模型文件 → 候选项。不分种类：模型分几种是某台引擎的说法，平台只认路径。
export function weightOptions(paths) {
  const out = []
  const seen = new Set()
  for (const p of (Array.isArray(paths) ? paths : [])) {
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push({ value: p, label: basenameOf(p) })
  }
  return out
}

// 切片 + 原始录音 → 候选项。
//
// 去重按路径：同一个文件在切片和原始两个列表里各出现一次是常事，下拉里出现两条
//   一模一样的会让人以为自己选错了。`exists === false` 的切片不进候选：它是资产库
//   知道自己弄丢了的东西，但只在这里剔，用户手填同一个路径我们照发。
export function audioOptions(segments, raws) {
  const out = []
  const seen = new Set()
  const push = (p) => {
    if (!p || seen.has(p)) return
    seen.add(p)
    out.push({ value: p, label: basenameOf(p) })
  }
  for (const s of (Array.isArray(segments) ? segments : [])) {
    if (!s || s.exists === false) continue
    push(s.audio || s.audio_path || s.audio_filename)
  }
  for (const r of (Array.isArray(raws) ? raws : [])) {
    push(typeof r === 'string' ? r : (r && (r.path || r.audio)))
  }
  return out
}

// 这一格该拿哪一份候选。不是 `select + source` 就返回 null。
//
// 名片写了一个平台不认识的库名 ⇒ 返回空数组，格子照常画（fail-open）：少一格还
//   找不到、还不报错，比多一格坏得多。allow_custom 的格子本来就能直接打字。
export function optionsForField(field, sources) {
  if (!field || !field.source) return null
  const table = sources || {}
  return Array.isArray(table[field.source]) ? table[field.source] : []
}
