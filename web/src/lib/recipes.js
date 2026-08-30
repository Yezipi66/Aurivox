// 配方 ←→ 合成页 的搬运。
//
// ⭐ 这个文件唯一的规矩：**不认识任何一个引擎参数的名字**。
//
// 原来这里是一整行写死的 GPT-SoVITS 参数表（temperature / top_k / …
// 二十来个键名逐个抄）。后果只在装第三台引擎时才露出来，而且是无声的：
// 存配方能存进去（后端 recipeStore v4 会把不认识的键收进 engine_params），
// 打开配方却读不回来 —— 这里读的是 recipe.params.<写死的名字>，
// 而那台引擎的参数在 engine_params[它的id] 里。用户看到的是「参数全变回
// 默认值了，也没报错」。
//
// 现在改成：**整袋拿出来，原样交给界面**。界面那边（handleReload）已经会
// 按当前引擎的 manifest 过滤，认不出的键自己会丢掉 —— 过滤该发生在那里，
// 不该发生在这里。

export function recipePath(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value.base === 'asset' && value.path) return `assets/${String(value.path).replace(/^assets\//, '')}`
  if (value.base === 'external' && value.path) return value.path
  return ''
}

// 平台自己要读的那几个键：它们不是任何一台引擎的参数（一台引擎都没装也
// 有意义），下面要单独搬运和整形，所以先从袋子里拿掉，避免搬两遍。
const PLATFORM_OWNED = new Set([
  'aux_ref_audio_paths',
  'pron_overrides',
  'lang_overrides',
  'han_readings',
])

/**
 * 取出这张配方里、属于某台引擎的那一袋参数。
 *
 * 两个来源合并，engine_params 优先：
 *   recipe.params            —— v3 老配方全在这里；v4 也仍然往这里写一份
 *                               （后端为兼容留的），所以它是底。
 *   recipe.engine_params[id] —— v4 每台引擎自己的格子，原样存原样取。
 *
 * 找不到对应格子时依次退到「配方自己记的引擎」和 "_unassigned"（后端在
 * 引擎未知时用的占位格，见 recipeStore 的兜底），⛔ 不猜、不填默认值。
 */
export function recipeParamBag(recipe, engineId = '') {
  const boxes = (recipe && typeof recipe.engine_params === 'object' && recipe.engine_params) || {}
  const box =
    (engineId && boxes[engineId]) ||
    (recipe && recipe.engine_id && boxes[recipe.engine_id]) ||
    boxes._unassigned ||
    {}
  return { ...((recipe && recipe.params) || {}), ...box }
}

/**
 * 配方 → 合成页的一份「重新载入」参数。
 *
 * @param engineId 当前选中的引擎。传空也能用（退到配方自己记的那台），
 *                 只是拿不到跨引擎的格子。
 */
// 配方顶层那两个权重字段（gpt_ckpt / sovits_pth）↔ 合成请求里的参数名。
//
// ⚠⚠ 这张表是**配方格式还没升级**留下的账，不是设计。配方顶层只留得下两个
//   权重字段，是照着第一台引擎的形状定的；第三个位、第四个位都没地方放。
//   所以整个仓库里**只有这一个文件**认识这两个字段名 —— 界面别处一律按
//   「名片说这台引擎有几个位」来处理，将来配方升级只用改这里。
//
// ⭐ 对不上这张表的位（比如第三个位、或者某台引擎自己的位）就是存不进配方，
//   这时**什么都不写**。⛔ 不许硬塞进这两个格子：存的时候不报错，取出来
//   却发给了另一个参数，声音不对而且查不出来。
const RECIPE_WEIGHT_FIELDS = { gpt_model: 'gpt_ckpt', sovits_model: 'sovits_pth' }

/**
 * 把「这次要发给引擎的权重参数」翻成配方顶层的那两个字段。
 * @param {object} weightParams 形如 { gpt_model: '路径', sovits_model: '路径' }
 * @returns {object} 形如 { gpt_ckpt: '路径', sovits_pth: '路径' }（存不下的位不出现）
 */
export function weightsToRecipeFields(weightParams) {
  const out = {}
  for (const [param, field] of Object.entries(RECIPE_WEIGHT_FIELDS)) {
    const v = weightParams && weightParams[param]
    out[field] = v == null ? '' : v
  }
  return out
}

// 这两个字段在界面上显示成什么。⚠ 同样是上面那笔账的一部分 —— 名字是第一台
// 引擎的形状，所以标签也是。⛔ 别在别的文件里再写一遍这两个词。
const RECIPE_WEIGHT_LABELS = { gpt_ckpt: 'GPT', sovits_pth: 'SoVITS' }

/**
 * 「保存为配方」的预览里，权重那几行该显示什么。
 *
 * ⭐⭐ 只列**真的存进去了**的那些。原来这里是写死的两行，于是选了别的引擎时
 *   永远显示「GPT（无）/ SoVITS（无）」—— 那是在说"你没有模型"，正是这一轮
 *   要消灭的那句谎话。真实情况是：配方格式还装不下这台引擎的模型选择。
 *
 * @returns {{rows: Array<{key,label,path}>, storable: boolean}}
 *          storable=false ⇒ 一个位都存不进配方，界面应当说明原因而不是显示"无"。
 */
export function recipeWeightPreview(d) {
  const rows = []
  for (const [field, label] of Object.entries(RECIPE_WEIGHT_LABELS)) {
    const v = d && d[field]
    if (v) rows.push({ key: field, label, path: v })
  }
  return { rows, storable: rows.length > 0 }
}

export function recipeToGenerateParams(recipe, currentText = '', engineId = '') {
  const bag = recipeParamBag(recipe, engineId)

  // ① 引擎自己的参数：整袋倒过去，一个名字都不认。
  const out = {}
  for (const [k, v] of Object.entries(bag)) {
    if (PLATFORM_OWNED.has(k)) continue
    out[k] = v
  }

  // ② 老配方的兼容：v3 把语速存成平台通用的 speed，而界面上那一格叫什么
  //    由引擎的 manifest 说了算。新存的配方里已经是引擎自己的键名了
  //    （存的时候就整袋存），所以这一条只对**没有 engine_params 格子的
  //    老配方**生效，且只在袋子里真有 speed 时才动。
  //    ⚠ 保留它是因为盘上真有这样的配方；⛔ 它不是新引擎要走的路。
  if (out.speed !== undefined && out.speed_factor === undefined) {
    out.speed_factor = out.speed
  }

  // ③ 平台自己的那几样，形状要整（路径要解析、缺省要给空容器）。
  Object.assign(out, {
    voice: (recipe && recipe.role) || '',
    text: currentText,
    ref_audio: recipePath(recipe && recipe.reference_audio),
    reference_text: (recipe && recipe.reference_text) || '',
    text_lang: (recipe && recipe.language) || '',
    gpt_model: recipePath(recipe && recipe.gpt_ckpt),
    sovits_model: recipePath(recipe && recipe.sovits_pth),
    aux_ref_audio_paths: (bag.aux_ref_audio_paths || []).map(recipePath).filter(Boolean),
    pron_overrides: bag.pron_overrides || {},
    lang_overrides: bag.lang_overrides || {},
    han_readings: bag.han_readings || {},
  })

  return out
}
