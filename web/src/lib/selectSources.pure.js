// ---------------------------------------------------------------------------
//  `select` + `source` 的候选表 —— 不含 React 的那一半
// ---------------------------------------------------------------------------
//
// ⭐⭐ 为什么单独一个文件：带 React 的文件在这个仓库里**跑不了 node --test**
//    （JSX 要先编译）。挑候选、去重、fail-open 这些是会出错的地方，
//    ⛔ 不能因为它们碰巧写在一个 .jsx 里就永远没有判据守着。
//    ⇒ 会错的逻辑放这儿（有测试），只管画的部分放 useSelectSources.js / .jsx。
//
// 名片里一个下拉的选项有两个来源，⛔ 二选一：
//   choices  名片里写死的一串    —— 装引擎的时候就知道
//   source   平台扫盘扫出来的一串 —— **运行时**才知道
//
// 这个文件只负责后者，而且只认三个库：
//   voices   平台里的音色
//   weights  平台已经扫到的模型文件（⛔ 不分 gpt/sovits —— 那是一台引擎的说法）
//   audio    参考音频片段
//
// ⭐ 这三个词是**平台的词汇表**，不是任何一台引擎的。名片说「我这一格要从
//    audio 里挑」，平台就把音频库递过去 —— 至于那一格叫「情绪参考音频」还是
//    「辅助参考音频」，是名片自己的事，平台不认识这两个说法。
//
// ⛔ 这里**不做校验**：不检查用户最后填的值在不在候选里。候选是候选，不是
//    限制。拿一份可能过期的名单去卡，症状是「我明明选了它却没生效」，
//    而且不报错 —— 那是最难查的一类。

/** 平台认识的库。⛔ 与后端 lib/engines/paramTypes.js 的 SELECT_SOURCES 必须一致。 */
export const SELECT_SOURCES = ['voices', 'weights', 'audio']

export function basenameOf(p) {
  const s = String(p == null ? '' : p)
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}

/** 音色 → 候选项。 */
export function voiceOptions(voices) {
  return (Array.isArray(voices) ? voices : [])
    .filter(v => v && v.id)
    .map(v => ({ value: v.id, label: v.display_name || v.id }))
}

/** 模型文件 → 候选项。⛔ 不分种类：种类是 GPT-SoVITS 的说法。 */
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

/**
 * 切片 + 原始录音 → 候选项。
 *
 * ⚠ 去重按路径：同一个文件在切片和原始两个列表里各出现一次是常事，
 *   下拉里出现两条一模一样的会让人以为自己选错了。
 * ⚠ `exists === false` 的切片不进候选：它是资产库知道自己弄丢了的东西，
 *   ⛔ 但只在这里剔 —— 用户手填同一个路径我们照发，不替引擎判断文件在不在。
 */
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

/**
 * 这一格该拿哪一份候选。不是 `select + source` 就返回 null。
 *
 * ⭐ 名片写了一个平台不认识的库名 ⇒ 返回**空数组**，格子照常画（fail-open）。
 *   ⛔ 不是不画：少一格找不到、还不报错，比多一格坏得多。而且 allow_custom
 *     的格子本来就能直接打字，候选空着仍然填得出东西。
 */
export function optionsForField(field, sources) {
  if (!field || !field.source) return null
  const table = sources || {}
  return Array.isArray(table[field.source]) ? table[field.source] : []
}
