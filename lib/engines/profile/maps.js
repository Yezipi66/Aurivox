'use strict'

// 名片里「怎么调用」与「权重位怎么切换」这两段的解析：parseMethods 组装界面的方法下拉，
// parseMaps 把平台的词翻成引擎的键名，checkSlot* / retireHotSwap 管权重位的换法与已退休的旧键。
// 本文件里不许出现具体引擎名。

const { plainObject, profileError } = require('./fields')

// call.methods：一次请求走哪个推理方法，给界面画方法下拉。宿主那侧由 hostProfile.js 校验，
// 但那道闸只在起进程前跑，/api/engines 这条路不起进程，写坏的名片只会显示一个空下拉。
// 这里只兜最低限度的：重复校验会变成各自漂移的第二份事实。
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

// maps：平台的词 → 这台引擎的键名，值必须是非空字符串。空字符串要拦：那等于说「这个概念
// 我有，但叫空」，拼出来的请求体会多一个 "" 键。没有这个概念请写 null 或者不写这一行。
function parseMaps(manifest, value) {
  const raw = plainObject(manifest, 'maps', value)
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue      // null = 显式声明「没这个概念」
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

// applies_at 只有 launch / call 两种且穷尽：「一个进程同时挂几份」是引擎自己的容量，不是这件事。
const APPLIES_AT = Object.freeze(['launch', 'call'])

// 换法与 param 必须自洽：call 位要有 param（否则选中的那一份无处可发），launch 位不能有。
// switch 是可选的「换这一份时平台额外发的请求」，只对 HTTP 形态有意义：stdio 引擎的
// 权重值随请求体送进宿主，平台不发额外请求；没有地址的 http 引擎也发不出去。
function checkSlotSwitching(manifest, slots, transport, base_url) {
  for (const s of slots) {
    if (!APPLIES_AT.includes(s.applies_at)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的权重位 ${s.name} 写了 applies_at=${JSON.stringify(s.applies_at)}，` +
        `而这里只有两个值：${APPLIES_AT.join(' / ')}` +
        '"launch" = 这一份是开进程那一步吃进去的（换一份要带着它重开一次），' +
        '"call" = 进程活着的时候一次调用就能换。不写的话平台按有没有 param 推。',
        { id: manifest.id, key: `weights.${s.name}.applies_at`, value: s.applies_at })
    }
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
    if (s.switch !== undefined) {
      if (s.applies_at !== 'call') {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的权重位 ${s.name} 写了 switch，但它是 launch 位：` +
          'switch 只在进程活着、一次调用就能换的位上才发得出去。',
          { id: manifest.id, key: `weights.${s.name}.switch` })
      }
      if (!s.switch || typeof s.switch !== 'object' || Array.isArray(s.switch)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的权重位 ${s.name} 的 switch 必须是对象：` +
          '{ "endpoint": "/...", "query": "..." }。',
          { id: manifest.id, key: `weights.${s.name}.switch` })
      }
      const { endpoint, query } = s.switch
      if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的权重位 ${s.name} 的 switch.endpoint 必须以 / 开头，` +
          `现在写的是 ${JSON.stringify(endpoint)}。`,
          { id: manifest.id, key: `weights.${s.name}.switch.endpoint` })
      }
      if (typeof query !== 'string' || !query) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的权重位 ${s.name} 的 switch.query 必须是非空字符串：` +
          '平台要把选中的那一份放在这个查询参数里发出去。',
          { id: manifest.id, key: `weights.${s.name}.switch.query` })
      }
      if (transport === 'stdio') {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的权重位 ${s.name} 写了 switch，但这台引擎走 stdio：` +
          '它的权重值随请求体送进宿主，平台不会额外发任何请求。' +
          '删掉 switch，或者给名片一个监听地址（default_base_url）。',
          { id: manifest.id, key: `weights.${s.name}.switch` })
      }
      if (!base_url) {
        throw profileError('ENGINE_MANIFEST_INCOMPLETE',
          `引擎 ${manifest.id} 的权重位 ${s.name} 写了 switch，但这台引擎没有地址：` +
          '切换请求没有地方发。补 default_base_url 或 base_url_env。',
          { id: manifest.id, missing: `weights.${s.name}.switch 的地址` })
      }
    }
  }
  return slots
}

const _hotSwapWarned = new Set()

/**
 * capabilities.hot_swap_models：已退休，只提醒不拦截，不参与任何判断。退休的理由是它答错了
 * 层级：「能不能换一份模型」是每个模型位各自的事，现在由 weight_slots[].applies_at 回答。
 * 名片里还留着它就照装，但每台引擎只提醒一次：每次解析都刷一行，真正的报错反而看不见。
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

// 权重位的 param（发给引擎时用的参数名）必须在 param_keys 里：两份名单不匹配时，界面上会
// 出现一个发不出去的格子，用户以为换了权重而声音却没变，且不报任何错。不写 param 合法。
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
