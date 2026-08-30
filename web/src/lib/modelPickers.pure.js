// ============================================================
//  模型下拉的候选是怎么来的（纯函数，无 React、无 fetch）
// ============================================================
//
// 这个文件回答一个问题：**当前这台引擎 + 当前这个角色，模型下拉里该出现谁。**
//
// ─── 为什么会有这个文件 ───────────────────────────────────────
// 在它出现之前，界面上是写死的两个下拉（GPT / SoVITS），候选从后端两个写死的
// 字段里拼。于是：
//   * 只有一个模型位的引擎，界面上永远是两个下拉，其中一个是空的；
//   * 它的模型即使躺在盘上，也没有任何一个字段能承载 ⇒ 一个入口都没有。
// Owner 的原话是「你的意思是没有微调接口，就没有其他模型是嘛？」——
// ⭐ 自检句：我是不是拿「**怎么生产它**」定义「它存不存在」？
//
// ─── Owner 定案的模型二分（穷尽，没有第三类）────────────────
//   ① 底模      放在引擎自己的全局位置；**来源无关** —— 官方发的、社区微调
//                的、用户自己手放的，都算，平台不问是谁训的。
//   ② 微调模型  走「接入」落在**某个角色**的资产目录下。
//
// ─── 筛选是二维的：引擎 × 角色 ──────────────────────────────
//   下拉 = 这台引擎的底模  ∪  **当前角色**下这台引擎的模型
//
//   ⛔ 别的角色的模型**不进这个下拉**。此前是可以跨角色挑的，代价是：挑了
//      别人的权重，参考音频会被一起带走（音色跟着走），而用户在界面上既看
//      不见也管不着。Owner 判定：「不会出现自己看不到的模型，也不会影响用
//      其他角色的参考音频」。
//
// ⛔ 本文件里不允许出现任何引擎 id、任何模型位名字（gpt / sovits / model …）。
//    判据：装一台谁都没见过的引擎，这里一个字都不用改。下面有守卫测试盯着。

/** 模型在盘上的三层约定：assets/<角色>/models/<引擎id>/<模型位>/… */
export const MODELS_SEGMENT = 'models'

/**
 * 这台引擎有几个模型位、每个位叫什么。
 *
 * 数据来自 /api/engines 的 weight_slots（名片的 weights 段解析而来）。
 *
 * ⛔ 名片没写就是空数组 —— **不兜底成两个**。漏写的正确表现是「一个模型下拉
 *    都不长」，作者一眼看得见；替他猜个数字会让下拉里出现装不进去的候选，
 *    而那不报错，只是声音不对。
 *
 * ⚠ 跟「换的时候要不要重开进程」（每个位上的 applies_at）无关：
 *    那个只说换一份的**代价**，⛔ 不决定给不给选。
 *    拿「怎么装载它」定义「它存不存在」是这个项目栽过两次的坑。
 */
export function slotsOf(engine) {
  const slots = engine && engine.weight_slots
  if (!Array.isArray(slots)) return []
  return slots
    .filter(s => s && typeof s.name === 'string' && s.name)
    // ⚠⚠ param 必须原样带过来 —— 它是「选中的这一份用哪个参数名发出去」。
    //   这里一旦漏掉，下面 weightsToSend 会对**每一台**引擎都返回空：
    //   下拉照样能点，请求体里却一个键都没有 —— 不报错，只是换了没用。
    //   （2026-08-30 真的漏过一次，是端到端跑通那一遍才抓到的，
    //     单元测试全绿，因为测试是直接手写带 param 的位喂进去的。）
    // ⭐ applies_at = 这一份选择**送到哪一步**：'call'（进程活着时一次调用）
    //   / 'launch'（开进程那一步吃进去的，换一份要带着它重开一次）。
    //   ⛔ 兜底取 'launch'，跟名片那一侧同一个理由：填错的后果不对称。
    .map(s => ({
      name: s.name,
      label: s.label || s.name,
      param: s.param || null,
      applies_at: s.applies_at === 'call' ? 'call' : 'launch',
    }))
}

/**
 * 从一条模型路径倒推它属于哪个角色。
 *
 *   ".../assets/<角色>/models/<引擎id>/<模型位>/<文件或目录>"  ->  "<角色>"
 *
 * 只认这一种形状。底模不在 assets/ 下（它是全局的），所以底模路径在这里
 * 返回 '' —— 想知道某条路径是不是底模，问 `ownerOfPath` 的 `builtin` 那一侧，
 * 不要在这里靠路径特征猜。
 *
 * ⛔ 不筛后缀、不认识任何引擎名：一个模型可以是一个文件，也可以是一整个目录。
 */
export function assetIdFromModelPath(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/')
  // 三层：assets/<角色>/models/<引擎>/<位>/  —— 中间三段一个都不能少，
  // 否则 assets/<角色>/raw/… 这种素材路径也会被认成模型。
  const m = s.match(/(?:^|\/)assets\/([^/]+)\/models\/[^/]+\/[^/]+\//)
  return m ? m[1] : ''
}

/**
 * 这条路径在**当前这份候选清单**里属于谁。
 *
 * ⭐ 判据是「它在不在清单里」，不是「它的路径长什么样」：底模的位置由名片
 *    声明、还能被环境变量顶掉，靠路径特征去猜的那套（老代码里那条认
 *    版本目录名的正则）在用户改了底模目录之后就会认错。
 *
 * @returns {{voiceId:string, displayName:string, builtin:boolean}|null}
 */
export function ownerOfPath(groups, path) {
  if (!path) return null
  for (const g of (groups || [])) {
    if ((g.items || []).some(it => it && it.path === path)) {
      return { voiceId: g.voiceId, displayName: g.displayName, builtin: !!g.builtin }
    }
  }
  return null
}

/**
 * 一个模型位的候选，按来处分组。
 *
 * @param assets  /api/assets/voices-with-models 的 voices 数组。每一项：
 *                { voiceId, displayName, builtin?, engines:[…],
 *                  models: { <引擎id>: { <模型位>: [ {name,path,…}, … ] } } }
 * @param engineId  当前选中的引擎
 * @param slotName  这一个下拉对应哪个模型位
 * @param voiceId   当前选中的角色
 *
 * @returns [{ voiceId, displayName, builtin, items:[…] }]  空组已经剔掉
 *
 * ⭐ 底模那一组永远排在最前：它是「不挑角色都能用的那一份」，用户找它的频率
 *    最高，而且它出现在**每一个**角色下面（底模是全局的）。
 */
export function candidatesForSlot(assets, engineId, slotName, voiceId) {
  if (!engineId || !slotName) return []
  const out = []
  for (const a of (assets || [])) {
    if (!a) continue
    // 二维筛选就在这两行：非底模的，只留当前角色。
    if (!a.builtin && a.voiceId !== voiceId) continue
    const items = ((a.models || {})[engineId] || {})[slotName]
    if (!Array.isArray(items) || items.length === 0) continue
    out.push({
      voiceId: a.voiceId,
      displayName: a.displayName || a.voiceId,
      builtin: !!a.builtin,
      items,
    })
  }
  // 底模在前，其余按角色名排（当前实现下"其余"最多一项，排序是为了以后
  // 放宽筛选时行为仍然确定，不靠接口的返回顺序）。
  out.sort((x, y) => (x.builtin === y.builtin ? x.voiceId.localeCompare(y.voiceId) : (x.builtin ? -1 : 1)))
  return out
}

/**
 * 音色下拉里该出现哪些角色。
 *
 * > **底模那一条 ∪「在这台引擎下每一个模型位都有自己模型」的角色**
 *
 * ⭐ 为什么要筛：列一个在这台引擎下没有任何自己模型的角色，选中它之后
 *    每一个模型位都只能落回底模 —— 也就是说，选它和选底模发出去的东西
 *    一模一样，而界面却告诉用户"你选中了这个角色"。那是一句假话。
 *
 * ⭐⭐ 为什么筛掉了也不影响用别人的声音：借参考音频是**另一条入口**
 *    （底模条目下面那个「使用其他音色的参考音频」），它不经过这个下拉，
 *    也不因为这里筛掉了谁而少一个人。⛔ 别把"选中某个角色"当成"用到某个
 *    角色的声音"的唯一途径 —— 界面上从来不是。
 *
 * ⚠ **每一个位都要有**，不是"有任意一个位就算"。只训出一半的模型是特殊
 *    需求，不在这个下拉里照顾；真要混搭，在模型位的下拉里各挑各的，引擎
 *    报什么错原样传回去。
 *
 * ⚠ 名片一个模型位都没写的引擎 ⇒ **不筛**。那种引擎压根没有"自己的模型"
 *    这个概念，按"有没有模型"去筛只会把所有角色都筛没。
 *
 * @param voices   音色清单（/api/voices 的返回，第一条是 builtin 的底模）
 * @param assets   /api/assets/voices-with-models 的 voices 数组
 * @param engineId 当前选中的引擎
 * @param slots    这台引擎的模型位（slotsOf 的结果）
 */
export function voicesForEngine(voices, assets, engineId, slots) {
  const list = Array.isArray(voices) ? voices : []
  const need = Array.isArray(slots) ? slots : []
  if (!engineId || need.length === 0) return list

  // 角色 → 这台引擎下它自己的模型（按位）。⛔ builtin 那条是底模，不是谁的资产。
  const own = new Map()
  for (const a of (assets || [])) {
    if (!a || a.builtin || !a.voiceId) continue
    own.set(a.voiceId, (a.models || {})[engineId] || {})
  }

  return list.filter(v => {
    if (!v) return false
    if (v.builtin) return true               // 底模永远在，且永远排在原位
    const bySlot = own.get(v.id)
    if (!bySlot) return false
    return need.every(s => {
      const items = bySlot[s.name]
      return Array.isArray(items) && items.length > 0
    })
  })
}

/** 把分好组的候选压平 —— 用来判断"选中的这条还在不在"。 */
export function flattenGroups(groups) {
  const out = []
  for (const g of (groups || [])) for (const it of (g.items || [])) if (it) out.push(it)
  return out
}

/**
 * 一条候选在下拉里显示成什么。
 *
 * ⭐ steps / version 是**扫盘时能看出来就贴上的标签**，不是每台引擎都有。
 *    没有就不显示，⛔ 不填 "-"、不填 "unknown" —— 那看起来像"扫出来是空的"。
 */
export function itemLabel(item) {
  if (!item) return ''
  const bits = []
  if (item.steps != null) bits.push(`step ${item.steps}`)
  if (item.version) bits.push(item.version)
  // ⭐⭐ 「这一份装不起来」必须写在**下拉那一行**上，不是等选完了再报。
  //   后端按名片的 models.required 逐项核对过（三态：true/false/null）。
  //   ⚠ 只在 false 时说话 —— null 是"说不出来"（单文件的候选、或者名片
  //     没写 required），⛔ 不许把"说不出来"画成"有问题"。
  if (item.complete === false) {
    const n = Array.isArray(item.missing) ? item.missing.length : 0
    bits.push(n ? `⚠ 缺 ${n} 项` : '⚠ 不完整')
  }
  return bits.length ? `${item.name} (${bits.join(' · ')})` : String(item.name || '')
}

/**
 * 这个角色 + 这台引擎，后端有没有话要说。
 *
 * ⭐⭐ 存在的理由（2026-08-30 真机）：盘上明明放了模型，界面上下拉却是空的，
 *   而且**没有任何一处解释为什么** —— 「这个角色没有模型」「放错了一层」
 *   「目录名不是权重位名」三件事在界面上长得一模一样。静默是这个仓库最难查
 *   的一种坏法。
 *
 * ⛔ 这里不判断、不拼话：整句人话是后端生成的（那边才知道名片写了什么）。
 *   前端只负责把它放到用户能看见的地方。
 */
export function modelNotesFor(assets, engineId, voiceId) {
  if (!engineId || !voiceId) return []
  for (const a of (assets || [])) {
    if (!a || a.builtin || a.voiceId !== voiceId) continue
    return (a.model_notes || []).filter(n => n && n.engine === engineId && n.text)
  }
  return []
}

// ---------------------------------------------------------------------------
//  选中的模型怎么发给引擎
// ---------------------------------------------------------------------------
/**
 * 把「每个位选了哪一份」翻成一份可以直接并进请求体的参数。
 *
 * ⭐⭐ 一个位用哪个参数名发，是**名片**说的（每个位上的 param）。平台不认识
 *   任何一个具体的参数名 —— 换一台引擎，这里发出去的键就跟着变。
 *
 * ⛔⛔ 名片没写 param 的位，这里**一个字节都不发**。那意味着这台引擎运行中
 *   换不了权重（比如启动时就把权重装好了）。候选照样列出来给人看
 *   —— 「能不能换」和「有没有」是两件事 —— 但发一个引擎不读的键就是撒谎：
 *   不报错，用户以为换了，声音却没变。
 *
 * ⚠ 没选的位也不发（空字符串不是"选了空"，是"还没选出来"）。
 */
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

/**
 * 「开进程那一步吃进去」的那些位，选了哪一份 —— 单独一份，⛔ 不并进请求体。
 *
 * ⭐⭐⭐ 为什么要分成两份发
 * ------------------------
 * 上面 weightsToSend 明说：名片没写 param 的位一个字节都不发。那条规则是对的
 * （发一个引擎不读的键 = 不报错的撒谎），但它有个后果：这些位选了什么，
 * **后端根本不知道** —— 于是界面上选了模型，后端连"你选过"都看不见，
 * 表现就是「选了不生效，还不报错」。
 *
 * ⇒ 这些位的选择走一个**平台级**的键。它给的是平台，不是引擎：
 *   平台拿它决定「要不要带着这一份把引擎重开一次」。
 *   ⛔ 它不会进引擎的请求体（引擎那道出门关也会拦它）。
 *   ⛔ 名片一个字都不用改，上游作者什么都不用做。
 *
 * ⚠ 键是**位名**不是参数名：这一份的收件人是平台，而位名才是平台认识的东西。
 */
export function launchWeightsToSend(slots, selection) {
  const out = {}
  for (const s of (slots || [])) {
    // ⭐ 这两份必须**正好把位分完，不重不漏**：有参数名的位走上面那份（进请求体），
    //   剩下的走这一份（给平台）。同一个位进两份 = 同一次选择说了两遍，
    //   哪天两边不一致就再也说不清听谁的。
    //   ⚠ 两个条件其实是同一句话（名片解析时 applies_at 就是按有没有 param 推的），
    //     两个都写是因为这个函数也会拿到手写的位表。
    if (!s || s.param || s.applies_at === 'call') continue
    const v = selection && selection[s.name]
    if (!v) continue
    out[s.name] = v
  }
  return out
}

/**
 * 反过来：从一份请求体 / 已存的配方参数里，把各个位的选择读回来。
 * Rerun、载入配方都要走这一步。
 *
 * ⭐ 两个来源都要读：能一次调用换掉的位读它自己的参数名，开进程那一步吃进去的
 *   位读平台级的那一份（launchWeightsToSend 发出去的那个）。
 *   ⛔ 只读前者的话，Rerun 会**悄悄换回底模** —— 参数全对、声音不是那个人。
 */
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

/**
 * 这台引擎有没有哪怕一个位是能换的（一个都没有 ⇒ 界面要说明"看得见但换不了"）。
 *
 * ⭐ 开进程那一步吃进去的位现在**也算能换** —— 平台会带着新的那一份把它
 *   重开一次。以前这里只认有参数名的位，因为那时候确实换不了。
 */
export function anySlotSwitchable(slots) {
  return (slots || []).some(s => s && (!!s.param || s.applies_at !== 'call'))
}

/**
 * 换了这几个位，就得让引擎带着新的那一份重开一次。
 *
 * ⭐ 这是**位级**的事，不是引擎级的：一台引擎完全可以一个位能一次调用换掉、
 *    另一个位是开进程时吃进去的。原来那个引擎级的布尔位在这种引擎上
 *    没有正确答案 —— 这个函数是它的替代。
 */
export function slotsNeedingRelaunch(slots) {
  return (slots || []).filter(s => s && s.applies_at !== 'call').map(s => s.name)
}

// ---------------------------------------------------------------------------
//  直接读一个角色的 meta.json（扫盘缓存）
// ---------------------------------------------------------------------------
// 新形状：meta.assets.models = { <引擎id>: { <模型位>: [ {name,path,…}, … ] } }
// ⛔ 老的 meta.assets.checkpoints.{gpt,sovits} 已经不存在了 —— 它把一台引擎的
//    形状焊进了元数据，第二台引擎的模型连一个能放的字段都没有。
//
// ⚠ 这两个函数跟后端 lib/assets/modelLayout.js 的 slotFromMeta / enginesInMeta
//    是**同一句话**。两边分叉的症状是「后端扫到了、界面上没有」，不报错。

/** 这个角色有哪几台引擎的模型（目录名就是引擎 id）。空的位不算数。 */
export function enginesInMeta(meta) {
  const models = (meta && meta.assets && meta.assets.models) || {}
  return Object.keys(models)
    .filter(e => Object.values(models[e] || {}).some(l => Array.isArray(l) && l.length > 0))
    .sort()
}

/**
 * 取某台引擎某个位下的模型清单。没有就是空数组。
 *
 * ⚠ 调用方必须自己说出引擎 id —— 「我要这台引擎的模型」是调用方的题目，
 *    不是这个文件的。本文件里一个引擎 id 都不许出现。
 */
export function modelsFromMeta(meta, engineId, slotName) {
  const byEngine = (meta && meta.assets && meta.assets.models) || {}
  const slots = byEngine[engineId] || {}
  const list = slots[slotName]
  return Array.isArray(list) ? list : []
}

/** 这个角色在所有引擎、所有位上一共有几个模型。 */
export function countModelsInMeta(meta) {
  const models = (meta && meta.assets && meta.assets.models) || {}
  let n = 0
  for (const slots of Object.values(models)) {
    for (const list of Object.values(slots || {})) if (Array.isArray(list)) n += list.length
  }
  return n
}

/**
 * 按引擎汇总这个角色的模型数：[{ engineId, count }]，已剔掉 0 的。
 * 界面上一台引擎一个计数格 —— ⛔ 不再是写死的「GPT / SoVITS」两格。
 */
export function modelCountsByEngine(meta) {
  const models = (meta && meta.assets && meta.assets.models) || {}
  return Object.keys(models).sort().map(engineId => ({
    engineId,
    count: Object.values(models[engineId] || {})
      .reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0),
  })).filter(x => x.count > 0)
}

/**
 * 各个模型位的默认选择：沿用还有效的旧选择，否则取第一条。
 *
 * @param slots   slotsOf(engine)
 * @param groupsBySlot  { <模型位>: [分组…] }
 * @param prev    { <模型位>: <路径> }  上一次的选择（可能来自别的引擎/角色）
 *
 * ⛔ 换引擎/换角色之后，旧选择多半已经不在新清单里 —— 那时**必须**换掉，
 *    留着会把一条别的引擎的权重发出去。反过来，还在清单里的要留住，
 *    否则每次列表异步刷新都会把用户刚挑的那条弹回第一条。
 */
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
