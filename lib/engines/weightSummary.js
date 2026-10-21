'use strict'

// 「这一次用的是哪几份模型」，写进 meta.json 的那一份。
// 位表只有一个来源：名片的 weight_slots（由 profile.js 产出）。本文件里不出现任何
// 引擎的名字、位名、位的个数。
// 不读盘、不判断文件在不在、不认后缀：一个模型可以是一个文件，也可以是一整个
// checkpoints 目录，凡是「猜它长什么样」的代码都是坑。

// 路径 → 末段名字。正反斜杠都要吃，结尾多余的分隔符要先削掉。
function baseNameOf(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '')
  if (!s) return ''
  const i = s.lastIndexOf('/')
  return i < 0 ? s : s.slice(i + 1)
}

// 这一次合成，每个模型位上落的是哪一份。
// 两个来源都要读：有 `param` 的位（引擎一次调用就能换）→ cfg[param]；没有
// `param` 的位（开进程那一刻吃进去的）→ cfg.launch_weights[位名]。只读前者的话，
// 位全在 launch 上的引擎会得到一张全空的表。
// 位一个不漏（没选的位 value/path 是空串）：界面要能说出「这个位是空的」。
function weightSummary(slots, cfg) {
  const list = Array.isArray(slots) ? slots : []
  const launched = (cfg && cfg.launch_weights && typeof cfg.launch_weights === 'object'
    && !Array.isArray(cfg.launch_weights)) ? cfg.launch_weights : {}
  const out = []
  for (const s of list) {
    if (!s || typeof s.name !== 'string' || !s.name) continue
    const raw = s.param ? (cfg ? cfg[s.param] : undefined) : launched[s.name]
    const path = (raw == null) ? '' : String(raw)
    out.push({
      name: s.name,
      // 位的显示名也是名片说的。平台不给位起名字。
      label: (typeof s.label === 'string' && s.label) ? s.label : s.name,
      value: baseNameOf(path),
      path,
    })
  }
  return out
}

// 一条已经存在盘上的记录，该怎么描述它用了哪台引擎、哪几份模型。
// 老 meta 没有 weights 段，但每份 meta.json 里都存着 `recipe`，那是原样的请求体，
// 里面本来就有 `engine_id`，也有那次选的每一份模型。⇒ 拿 recipe.engine_id 去查
// 名片，按名片的位表把值捡出来：一个位名都不写在代码里。
function storedGeneration(meta, resolveEngine) {
  const m = (meta && typeof meta === 'object') ? meta : {}
  // 新条目：写盘的时候就按名片算好了，直接使用。不重新查名片：这条记录说的是
  // 当时用了什么。
  if (m.engine_id && Array.isArray(m.weights)) {
    return {
      engine_id: m.engine_id,
      engine_label: m.engine_label || m.engine_id,
      weights: m.weights,
    }
  }
  const recipe = (m.recipe && typeof m.recipe === 'object' && !Array.isArray(m.recipe))
    ? m.recipe : null
  const id = m.engine_id || (recipe && typeof recipe.engine_id === 'string' ? recipe.engine_id : '')
  if (!id) return { engine_id: '', engine_label: '', weights: [] }

  let engine = null
  try {
    engine = typeof resolveEngine === 'function' ? resolveEngine(id) : null
  } catch (_err) {
    engine = null // 名片被删了/改名了：不是这一行该管的事故
  }
  return {
    engine_id: id,
    // 名片查不到 ⇒ 至少把 id 说出来：它知道自己是谁执行的，只是那份名片不在了。
    engine_label: (engine && engine.label) || id,
    weights: engine ? weightSummary(engine.weight_slots, recipe || {}) : [],
  }
}

module.exports = { weightSummary, baseNameOf, storedGeneration }
