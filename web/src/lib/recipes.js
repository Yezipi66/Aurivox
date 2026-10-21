// 配方与合成页之间的搬运。这个文件唯一的规矩：不认识任何一个引擎参数的名字。
// 引擎参数整袋搬运、原样交给界面，由界面按当前引擎的 manifest 过滤。

export function recipePath(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value.base === 'asset' && value.path) return `assets/${String(value.path).replace(/^assets\//, '')}`
  if (value.base === 'external' && value.path) return value.path
  return ''
}

// 平台自己要读的那几个键：它们不是任何一台引擎的参数，所以先从袋子里移除，避免搬两遍。
const PLATFORM_OWNED = new Set([
  'aux_ref_audio_paths',
  'pron_overrides',
  'lang_overrides',
  'han_readings',
])

// 取出这张配方里、属于某台引擎的那一袋参数。两个来源合并，engine_params 优先：
// recipe.params（v3 老配方全在这里，是底）与 recipe.engine_params[id]（v4 每台引擎自己
// 的格子）。找不到对应格子时依次退到「配方自己记的引擎」和 "_unassigned"（后端在引擎
// 未知时用的占位格，见 recipeStore 的兜底），不猜、不填默认值。
export function recipeParamBag(recipe, engineId = '') {
  const boxes = (recipe && typeof recipe.engine_params === 'object' && recipe.engine_params) || {}
  const box =
    (engineId && boxes[engineId]) ||
    (recipe && recipe.engine_id && boxes[recipe.engine_id]) ||
    boxes._unassigned ||
    {}
  return { ...((recipe && recipe.params) || {}), ...box }
}

// 配方顶层那两个权重字段（gpt_ckpt / sovits_pth）与合成请求里的参数名之间的对照。
//
// 这张表是配方格式还没升级留下的账，不是设计：配方顶层只留得下两个权重字段，是照着
//   第一台引擎的形状定的，第三个位、第四个位无位置放置。
//
// 不匹配这张表的位就是无法保存到配方，这时什么都不写。不许硬塞进这两个格子：存的
//   时候不报错，取出来却发给了另一个参数，声音不对而且查不出来。
const RECIPE_WEIGHT_FIELDS = { gpt_model: 'gpt_ckpt', sovits_model: 'sovits_pth' }

// 把「这次要发给引擎的权重参数」翻成配方顶层的那两个字段。存不下的位不出现。
export function weightsToRecipeFields(weightParams) {
  const out = {}
  for (const [param, field] of Object.entries(RECIPE_WEIGHT_FIELDS)) {
    const v = weightParams && weightParams[param]
    out[field] = v == null ? '' : v
  }
  return out
}

// 这两个字段在界面上显示成什么。同样是上面那笔账的一部分，名字是第一台引擎的形状，
// 所以标签也是。
const RECIPE_WEIGHT_LABELS = { gpt_ckpt: 'GPT', sovits_pth: 'SoVITS' }

// 「保存为配方」的预览里，权重那几行该显示什么。
//
// 只列真的存进去了的那些。没存下的位不列：显示成「无」等于对用户说「你没有模型」，
// 而真实情况是配方格式还装不下这台引擎的模型选择。storable=false ⇒ 一个位都无法保存
// 到配方，界面应当说明原因而不是显示「无」。
export function recipeWeightPreview(d) {
  const rows = []
  for (const [field, label] of Object.entries(RECIPE_WEIGHT_LABELS)) {
    const v = d && d[field]
    if (v) rows.push({ key: field, label, path: v })
  }
  return { rows, storable: rows.length > 0 }
}

// 配方 → 合成页的一份「重新载入」参数。engineId 传空也能用（退到配方自己记的那台），
// 只是拿不到跨引擎的格子。
export function recipeToGenerateParams(recipe, currentText = '', engineId = '') {
  const bag = recipeParamBag(recipe, engineId)

  // ① 引擎自己的参数：整袋倒过去，一个名字都不认。
  const out = {}
  for (const [k, v] of Object.entries(bag)) {
    if (PLATFORM_OWNED.has(k)) continue
    out[k] = v
  }

  // ② 老配方的兼容：v3 把语速存成平台通用的 speed，而界面上那一格叫什么由引擎的
  //    manifest 说了算。新存的配方里已经是引擎自己的键名了，所以这一条只对没有
  //    engine_params 格子的老配方生效，且只在袋子里真有 speed 时才动。
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
