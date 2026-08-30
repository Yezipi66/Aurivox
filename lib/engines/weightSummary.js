'use strict'

// ---------------------------------------------------------------------------
//  weightSummary.js —— 「这一次用的是哪几份模型」，写进 meta.json 的那一份
// ---------------------------------------------------------------------------
//
// 病历（Owner 2026-08-31 00:42 真机抓到）：Recent Generations 里那一行写着
//
//     Base model · Auto · GPT - / SoVITS - · ref 交谈2_2.wav · seed 3788417817
//
// 而这一次跑的是 IndexTTS2。IndexTTS2 没有 GPT 这个位，也没有 SoVITS 这个位,
// 它只有一个位、名片里叫 `model`。那两个横杠不是"没选模型"，是**平台在拿
// 第一台引擎的位表去描述第二台引擎**：位名写死、个数写死成 2。
//
// 病灶一共四处，全是同一句话抄了四遍：
//     lib/services/synthesisService.js   metaBase
//     lib/routes/synthesis.js            broker 流式 + 非流式两处
//     server.js                          genItemFromMeta（读回来时又写死一遍）
//
// ⭐⭐ 判据没变，还是那一条：**装一台谁都没见过的引擎，这里一个字都不用改。**
//   所以这个文件里不许出现任何引擎的名字、位名、位的个数。位表只有一个来源：
//   名片的 `weight_slots`（engine.weight_slots，由 profile.js 产出）。
//
// ⛔ 不做的事：不读盘、不判断文件在不在、不认后缀。一个模型可以是一个文件，
//   也可以是一整个目录（IndexTTS2 的 `model` 就是一整个 checkpoints 目录）——
//   凡是"猜它长什么样"的代码，都是下一台引擎的坑。

/** 路径 → 末段名字。正反斜杠都要吃（配方里存的是 Windows 路径），
 *  结尾多余的分隔符要先削掉，否则一个目录位会取到空字符串。 */
function baseNameOf(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '')
  if (!s) return ''
  const i = s.lastIndexOf('/')
  return i < 0 ? s : s.slice(i + 1)
}

/**
 * 这一次合成，每个模型位上落的是哪一份。
 *
 * @param {Array}  slots  这台引擎的模型位 = engine.weight_slots（名片说的）
 * @param {object} cfg    本次合成的配置。两个来源都要读：
 *                          - 有 `param` 的位（引擎一次调用就能换）→ cfg[param]
 *                          - 没有 `param` 的位（开进程那一刻吃进去的）
 *                            → cfg.launch_weights[位名]
 *                        ⭐ 只读前者的话，IndexTTS2 这种"位全在 launch 上"的
 *                          引擎会得到一张全空的表 —— 换了个引擎，症状从
 *                          "写死的两个横杠"变成"一个横杠都没有"，还是错的。
 * @returns {Array<{name:string,label:string,value:string,path:string}>}
 *          位一个不漏（没选的位 value/path 是空串）—— 界面要能说出
 *          "这个位是空的"，而不是让这个位从行里消失。
 */
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
      // 位的显示名也是名片说的。⛔ 平台不给位起名字。
      label: (typeof s.label === 'string' && s.label) ? s.label : s.name,
      value: baseNameOf(path),
      path,
    })
  }
  return out
}

/**
 * 一条**已经存在盘上**的记录，该怎么描述它用了哪台引擎、哪几份模型。
 *
 * ⭐⭐⭐ 这个函数是被 Owner 骂出来的（2026-08-31）。第一版我在读回来的时候写：
 *   「老 meta 没有 weights ⇒ 给空数组」，并且理直气壮地写了一段注释解释
 *   "不去读 meta.gpt 兜底，因为兜底就等于平台里还留着位名"。
 *   他的原话：「那你这个元数据不就炸了？我都不知道是哪个模型生成的。
 *   我们每个名片上不是有 engine_id 嘛？我说你那里是硬编码，
 *   **有没有可能我是想不用硬编码**？」
 *
 *   我把一件事做成了两件：去掉硬编码（对），顺手把老条目的信息扔了（错）。
 *   而它根本没丢 —— 每份 meta.json 里都存着 `recipe`，那是**原样的请求体**，
 *   里面本来就有 `engine_id`，也有那次选的每一份模型。
 *
 *   ⇒ 正确的做法不是"兜底读 meta.gpt"（那才是留着位名），而是
 *     **拿 recipe.engine_id 去查名片，按名片的位表把 recipe 里的值捡出来**。
 *     一个位名都不写在代码里，老条目照样说得清清楚楚。
 *
 * @param {object}   meta          meta.json 读出来的对象
 * @param {function} resolveEngine (id) => 名片档案；查不到可以抛，这里会接住
 */
function storedGeneration(meta, resolveEngine) {
  const m = (meta && typeof meta === 'object') ? meta : {}
  // 新条目：写盘的时候就按名片算好了，直接用。⛔ 不重新查名片 ——
  // 名片今天可能已经改了，而这条记录说的是**当时**用了什么。
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
    // 名片查不到 ⇒ 至少把 id 说出来。⛔ 不把这条记录说成"没有引擎" ——
    // 它明明知道自己是谁跑的，只是那张名片今天不在了。
    engine_label: (engine && engine.label) || id,
    weights: engine ? weightSummary(engine.weight_slots, recipe || {}) : [],
  }
}

module.exports = { weightSummary, baseNameOf, storedGeneration }
