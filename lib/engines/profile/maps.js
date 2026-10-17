'use strict'

// ---------------------------------------------------------------------------
// 名片里「怎么调用」与「权重位怎么切换」这两段
// ---------------------------------------------------------------------------
// parseMethods 组装界面的方法下拉；parseMaps 把平台的词翻成引擎的键名；
// checkSlot* / retireHotSwap 管权重位的换法与 retire 掉的旧键。
// 依赖 ./fields 的原语（plainObject / profileError）。
// 纪律同 profile.js 顶部那条：本文件里不许出现任何具体引擎的名字。

const { plainObject, profileError } = require('./fields')

// call.methods：一次请求走哪个推理方法。
// 这一段是给界面用的。宿主那侧（host.py / hostProfile.js）
// 交出去的是给引擎进程读的 hostProfile；
// 前端这条路是 profile.js → routes/engines.js → /api/engines。
// 不重复校验 hostProfile.js 已经验过的东西（methods 非空、default_method
// 在 methods 里、方法级 bind/标志/call_time 的形状）：那份是权威，
// 这里再写一遍就是第二份会漂移的事实：本项目已经为此付过学费
// （契约 C11 的原话）。这里只做装配，不做判断。
// 那道闸什么时候跑：hostProfile.js 由 spawnEngine/launchPlan 在起进程前
// 调用；/api/engines 这条路不起进程 ⇒ 一张 methods 写坏的名片，
// 界面上会安静地显示一个空下拉，而不是当场报错。
// 所以这里必须自己再兜一道最低限度的：methods 非空 + default_method
// 在里面。宁可重复这两条，也不要让界面显示一个空下拉。
function parseMethods(manifest, call) {
  const raw = plainObject(manifest, 'call.methods', call.methods)
  const names = Object.keys(raw)
  if (!names.length) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 call.methods 写了个空对象` +
      '不如不写这一段（不写就是单方法，界面画一个固定入口）。',
      { id: manifest.id, key: 'call.methods', value: raw })
  }
  const def = call.default_method
  if (typeof def !== 'string' || !def) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 声明了 ${names.length} 个推理方法（${names.join(', ')}）` +
      '但没写 call.default_method：界面必须知道不选时走哪一个。' +
      ' 不许「取第一个」：那会随名片的编辑顺序漂移。',
      { id: manifest.id, key: 'call.default_method', value: def })
  }
  if (!Object.prototype.hasOwnProperty.call(raw, def)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 call.default_method = ${JSON.stringify(def)}，` +
      `不在 call.methods 里（现有：${names.join(', ')}）`,
      { id: manifest.id, key: 'call.default_method', value: def })
  }
  return { methods: names, default_method: def }
}

// maps：平台的词 → 这台引擎的键名。值必须是非空字符串。
// 特别要拦「映射到空字符串」：那等于说"这个概念我有，但叫空"，拼出来的
// 请求体会多一个 "" 键。写 null 或者干脆不写这一行才是"我没这个概念"。
function parseMaps(manifest, value) {
  const raw = plainObject(manifest, 'maps', value)
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue      // 显式声明「没这个概念」
    if (typeof v !== 'string' || !v.trim()) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 maps.${k} 必须是这台引擎的键名（非空字符串），` +
        `现在写的是 ${JSON.stringify(v)}。没有这个概念请写 null 或者不写这一行。`,
        { id: manifest.id, key: `maps.${k}`, value: v })
    }
    out[k] = v.trim()
  }
  return out
}

/**
 * 权重位声明的 param（发给引擎时用的参数名）必须在 param_keys 里。
 *
 * 跟上面 params.schema 那条守卫是同一句话：名片里两份名单一旦不匹配，
 * 界面上就会出现一个发不出去的格子：而且这一种影响更大，因为用户会以为
 * 自己换了权重，声音却没变，不报任何错。
 *
 * 不写 param 是合法的（= 这台引擎运行中换不了权重），这里只查写了的。
 */
// 换法只有两种，而且穷尽。不许有第三个值：
// 「一个进程同时挂几份」是引擎自己的容量，不是"送到哪一步"这件事。
const APPLIES_AT = Object.freeze(['launch', 'call'])

function checkSlotSwitching(manifest, slots) {
  for (const s of slots) {
    if (!APPLIES_AT.includes(s.applies_at)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的权重位 ${s.name} 写了 applies_at=${JSON.stringify(s.applies_at)}，` +
        `而这里只有两个值：${APPLIES_AT.join(' / ')}` +
        '"launch" = 这一份是开进程那一步吃进去的（换一份要带着它重开一次），' +
        '"call" = 进程活着的时候一次调用就能换。不写的话平台按有没有 param 推。',
        { id: manifest.id, key: `weights.${s.name}.applies_at`, value: s.applies_at })
    }
    // 这两条是同一句话的正反面：一次调用能换 ⇔ 那一份有个参数名可以发出去。
    if (s.applies_at === 'call' && !s.param) {
      throw profileError('ENGINE_MANIFEST_INCOMPLETE',
        `引擎 ${manifest.id} 的权重位 ${s.name} 说自己一次调用就能换（applies_at=call），` +
        '却没说走哪个参数名：平台不知道该把选中的那一份发到哪儿去，' +
        '结果会是「下拉能点、请求体里一个键都没有」。补上 param，或者改成 applies_at=launch。',
        { id: manifest.id, missing: `weights.${s.name}.param` })
    }
    if (s.applies_at === 'launch' && s.param) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的权重位 ${s.name} 说自己是开进程那一步吃进去的（applies_at=launch），` +
        `又写了 param=${s.param}，这个参数名永远不会被发出去。两句话只能留一句。`,
        { id: manifest.id, key: `weights.${s.name}.param`, value: s.param })
    }
  }
  return slots
}

const _hotSwapWarned = new Set()

/**
 * `capabilities.hot_swap_models`：已退休。
 *
 * 为什么非退不可：它是一个引擎级的是非题，回答的却是每个模型位
 * 各自的事。一台引擎两个位、一个能一次调用换掉、一个要开进程时吃进去，
 * 那一位没有正确答案：而这正是 IndexTTS2「下拉能选、声音不变、还不报错」
 * 那个 bug 的根。同一件事现在写在位上（`weight_slots[].applies_at`），
 * 两种送法穷尽：`launch`（带着新的重开一次进程）/ `call`（发一次请求）。
 *
 * 名片里还写着它 ⇒ 不报错、照装。上游作者一行都不用改，这是硬约束。
 * 但也  不静默：每台引擎提醒一次（`_hotSwapWarned` 去重，否则每次解析
 * 名片都刷一行，日志会被淹掉、真正的报错反而看不见）。
 * 这个字段从今往后不参与任何判断：读它的地方一个都不许再有。
 */
function retireHotSwap(manifest, caps) {
  if (caps.hot_swap_models === undefined) return // retired-reader-ok
  if (_hotSwapWarned.has(manifest.id)) return
  _hotSwapWarned.add(manifest.id)
  console.warn(
    `[engine ${manifest.id}] capabilities.hot_swap_models 已退休，平台不再读它。` + // retired-reader-ok
    '「能不能换一份模型」现在写在每个模型位上：weight_slots[].applies_at ' +
    '（launch = 开进程那一步吃进去，换它要带着新的重开一次进程；' +
    'call = 进程活着时一次调用就能换）。这一行可以直接删掉。')
}

function checkSlotParams(manifest, slots) {
  const known = manifest.param_keys || []
  if (!known.length) return slots
  for (const s of slots) {
    if (!s.param) continue
    if (!known.includes(s.param)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的权重位 ${s.name} 说自己走参数 ${s.param}，` +
        '但 param_keys 里没有这个键。选中的模型会被当成拼错的参数拦下' +
        '用户以为换了权重，声音却不变，这是最难查的一类 bug。' +
        '要么把这个键加进 param_keys，要么去掉 param（= 这台引擎换不了权重，' +
        '候选照样列出来给人看）。',
        { id: manifest.id, key: `weights.${s.name}.param` })
    }
  }
  return slots
}

module.exports = {
  parseMethods, parseMaps, checkSlotSwitching, retireHotSwap, checkSlotParams,
}
