'use strict'

// ---------------------------------------------------------------------------
//  Engine profile — 把「名片上写的」翻成「合成路径能用的」
// ---------------------------------------------------------------------------
// 契约 v2 第 1 步。在这个文件出现之前，六件事写死在 lib/ 里，全都按
// GPT-SoVITS 的样子写死：
//
//   连哪台        lib/gsv/client.js:10   "http://127.0.0.1:9880"
//   等多久        lib/gsv/client.js      300000（三处重复）
//   切多长        synthesisService.js    30 / 60
//   参考音频多长  synthesisService.js    3–10 秒
//   要不要换权重  无条件调 switchModels
//   采样率        22050（生成段间静音用）
//
// 从这里开始，它们的唯一来源是 engines/<id>/manifest.json。lib/ 下不再有
// 任何一个具体引擎的默认值 —— 这就是「加引擎不改代码」的字面意思。
//
// ⚠ 本文件里**不允许出现任何具体引擎的名字**（和 registry.js 同一条纪律，
//   profile.node.test.js 里有一条守卫盯着）。一旦为了图快写 if (id==='xxx')，
//   那台引擎的特殊性就永久留在了平台层，下一个人只会照抄。

const { requireEngine } = require('./registry')

function profileError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// 缺字段就报错，不回落 —— Owner 2026-08-23 拍板选 A。
//
// 理由不是洁癖：回落到默认值意味着「名片写错了」和「名片写对了」表现完全
// 一样，作者不会发现，直到有一天连到了别人的引擎上。报错是这里唯一能给出
// 「你少写了哪一行」这个信息的时刻，错过了就再也没有了。
function required(manifest, keyPath, value, hint) {
  if (value === undefined || value === null || value === '') {
    throw profileError('ENGINE_MANIFEST_INCOMPLETE',
      `引擎 ${manifest.id} 的名片缺少 ${keyPath} —— ${hint}。` +
      `请在 ${manifest.dir}/manifest.json 里补上这一行；` +
      '平台不为它准备默认值（默认值会让「写错」和「没写」表现一致）。',
      { id: manifest.id, missing: keyPath })
  }
  return value
}

function positiveInt(manifest, keyPath, value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的名片里 ${keyPath} 必须是正整数，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  return n
}

// 布尔位必须显式写 true/false。缺了要报错，所以不能用 `|| false` 兜。
function requiredBool(manifest, keyPath, value, hint) {
  if (typeof value !== 'boolean') {
    throw profileError(
      value === undefined ? 'ENGINE_MANIFEST_INCOMPLETE' : 'ENGINE_MANIFEST_INVALID_VALUE',
      value === undefined
        ? `引擎 ${manifest.id} 的名片缺少 ${keyPath} —— ${hint}。请写明 true 或 false。`
        : `引擎 ${manifest.id} 的名片里 ${keyPath} 必须是 true 或 false，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  return value
}

// 参考音频时长约束。三种写法含义不同，不能混为一谈：
//   null        —— 明确声明「不限制」
//   [min, max]  —— 闭区间，秒
//   缺这个键    —— 报错。「忘了写」和「不限制」必须能区分开，否则一个漏写
//                 会静默变成「什么音频都收」，等到合成失败才发现。
function parseClipSeconds(manifest, value) {
  if (value === null) return null
  if (!Array.isArray(value) || value.length !== 2) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 capabilities.reference_clip_seconds 要么写 null（不限制），` +
      `要么写 [最短秒, 最长秒]，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: 'capabilities.reference_clip_seconds', value })
  }
  const min = Number(value[0])
  const max = Number(value[1])
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max <= min) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 reference_clip_seconds 区间不成立：${JSON.stringify(value)}（要求 0 ≤ 最短 < 最长）`,
      { id: manifest.id, key: 'capabilities.reference_clip_seconds', value })
  }
  return { min, max }
}

// 环境变量覆盖：**由名片自己指定变量名**，平台不认识任何具体的变量名。
//
// 这是为了让 GPT_SOVITS_BASE_URL 这种历史环境变量继续工作，同时不把
// 「GPT_SOVITS」这几个字写进 lib/。名片说「我听 XXX 这个变量」，平台才去读。
// 下游引擎想要同样的能力，写一行 base_url_env 就有，不用求我们改代码。
function resolveBaseUrl(manifest, env) {
  const envKey = manifest.base_url_env
  if (envKey && env[envKey]) {
    return { base_url: String(env[envKey]).replace(/\/+$/, ''), source: `env:${envKey}` }
  }
  const declared = required(manifest, 'default_base_url', manifest.default_base_url,
    '平台不知道该把合成请求发到哪个地址')
  return { base_url: String(declared).replace(/\/+$/, ''), source: 'manifest' }
}

// 名片上的 maps / payload_keys / defaults —— 第 1c 步新增的三段。
//
// ⚠ 这三段**不在这里报"缺"**，而是缺省成空。理由是它们的缺失有一个更靠后、
//   更准确的报错点：真正要拼请求体的时候（payload.js 会因为缺 maps.text 而抛，
//   并且能把「你少写了哪一行」指到具体文件）。在这里提前拦，会让一批只关心
//   地址和超时的调用方（换权重、健康检查）也被迫写全这三段。
//   ⛔ 但"缺省成空"不等于"随便"：realManifests.node.test.js 有一条体检，
//   盯着盘上每一张真名片都必须把这三段写全。空是给测试夹具用的，不是给真引擎的。
function plainObject(manifest, keyPath, value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的名片里 ${keyPath} 必须是一个对象，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  return value
}

function stringArray(manifest, keyPath, value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((k) => typeof k !== 'string' || !k)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的名片里 ${keyPath} 必须是一个非空字符串数组，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  return value.slice()
}

// maps：平台的词 → 这台引擎的键名。值必须是非空字符串。
//
// ⛔ 特别要拦「映射到空字符串」：那等于说"这个概念我有，但叫空"，拼出来的
//   请求体会多一个 "" 键。写 null 或者干脆不写这一行才是"我没这个概念"。
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

// defaults_env：让名片自己声明「哪个环境变量能顶掉我的某个默认值」。
//
// 这一段的存在有一个具体的由头，不是为了对称好看：batch_size 的默认值
// **不是 GPT-SoVITS 的默认值，是我们自己的调优决策** —— 搬家前 server.js
// 把它从引擎默认的 1 提到了 4，并留了 AURIVOX_TTS_BATCH_SIZE 这个旋钮给
// 低显存显卡降回 1。如果搬家时只把 4 写进名片、把旋钮丢掉，那台机器上的
// 显存就会在某一天悄悄不够用，而且不会报任何错。
//
// 写法：{ "<引擎键名>": { "var": "环境变量名", "type": "int", "min": 1, "max": 16 } }
// 取值不合法（不是整数 / 越界）⇒ 回落名片里的值，与搬家前 parseInt 那一段
// 的判断逐条一致。
function applyDefaultsEnv(manifest, defaults, spec, env) {
  const raw = plainObject(manifest, 'defaults_env', spec)
  const out = { ...defaults }
  for (const [key, decl] of Object.entries(raw)) {
    const d = plainObject(manifest, `defaults_env.${key}`, decl)
    if (!d.var || typeof d.var !== 'string') {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 defaults_env.${key} 必须写明 "var"（环境变量名）`,
        { id: manifest.id, key: `defaults_env.${key}`, value: decl })
    }
    const rawVal = env[d.var]
    if (rawVal === undefined || rawVal === null || rawVal === '') continue
    if (d.type === 'int') {
      const n = parseInt(rawVal, 10)
      if (!Number.isInteger(n)) continue
      if (d.min !== undefined && n < Number(d.min)) continue
      if (d.max !== undefined && n > Number(d.max)) continue
      out[key] = n
    } else if (d.type === 'bool') {
      if (rawVal === 'true' || rawVal === '1') out[key] = true
      else if (rawVal === 'false' || rawVal === '0') out[key] = false
    } else {
      out[key] = String(rawVal)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
//  params.schema —— 契约 §5.4「每个参数长什么样」
// ---------------------------------------------------------------------------
// 这一段是在还 C11 的账（契约 §8:590「参数表只有一份」）。在它出现之前，
// 同一张参数表在项目里存在两份**各自漂移**的副本：
//
//   engines/gpt-sovits/manifest.json   param_keys + defaults（键名、默认值）
//   web/.../GenerateTab.jsx            19 个 useState + 两块 form-grid
//                                      （控件类型、min/max/step、分层、标签，
//                                       以及**第二份默认值**）
//
// 漂移不会报错，只会表现为「说明书写的和界面上的不一样」。实测已经漂了一处：
// batch_size 名片写 4（profile.js:159 那段注释说明这是我们自己的调优决策，
// 还配了 AURIVOX_TTS_BATCH_SIZE 旋钮），而前端写死 1 且无条件发出去 ——
// 那个 4 和那个旋钮在 webui 路径上从来没生效过，而且不会有任何日志提到它。
//
// ⭐ 平台不认识这里的任何一个参数名，这是契约 §5.5 明写的：
//    「平台只知道『有一个数字参数，范围 0 到 1，界面上叫情绪强度』，
//      至于它是什么意思，平台不需要知道，也不应该知道。」
//    所以下面这个函数里不许出现任何具体参数名 —— 与文件顶部那条
//    「不许出现引擎名」是同一条纪律，profile.node.test.js 有守卫盯着。

const SCHEMA_TYPES = Object.freeze(['number', 'integer', 'boolean', 'enum'])

function schemaEntry(manifest, name, raw, defaults) {
  const keyPath = `params.schema.${name}`
  const d = plainObject(manifest, keyPath, raw)

  // ⭐⭐ 默认值有且只有一处，但可以是两处**之一** —— 因为这两处语义不同：
  //
  //   defaults.<键>                「每次合成都发这个值」，界面开没开都发
  //   params.schema.<键>.default   「界面格子的初值」，不因此多发一个键
  //
  // 这个区分不是设计洁癖，是被 lib/engines/payload.node.test.js 的 7 条
  // 黄金样本逼出来的：把 sample_steps / if_sr / overlap_length /
  // min_chunk_length 写进 defaults 之后，OpenAI 兼容口和 Flow 这些**从来
  // 没发过它们**的路径凭空多了 4 个键。那是行为变更，不是重构。
  //
  // 两处都写 = C11 说的那种会各自漂移的副本 ⇒ 当场抛。两处都不写 = 界面
  // 只能自己编一个初值 ⇒ 也当场抛。
  const inDefaults = name in defaults
  const inSchema = 'default' in d
  if (inDefaults && inSchema) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 ${name} 在 defaults 和 ${keyPath}.default 里各写了一个默认值 —— ` +
      '只能二选一：每次都发写 defaults，只是界面初值写 schema.default。' +
      '两处都写会各自漂移，而漂移不报错（契约 C11：参数表只有一份）。',
      { id: manifest.id, key: `${keyPath}.default` })
  }
  if (!inDefaults && !inSchema) {
    throw profileError('ENGINE_MANIFEST_INCOMPLETE',
      `引擎 ${manifest.id} 的 params.schema 描述了 ${name}，却没人给它默认值 —— ` +
      `请写 defaults.${name}（每次都发）或 ${keyPath}.default（只是界面初值）。` +
      '不写的话界面只能自己编一个，那就又多出一份副本（契约 C11）。',
      { id: manifest.id, missing: `defaults.${name} 或 ${keyPath}.default` })
  }

  if (!SCHEMA_TYPES.includes(d.type)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 ${keyPath}.type 必须是 ${SCHEMA_TYPES.join(' / ')} 之一，` +
      `现在写的是 ${JSON.stringify(d.type)} —— 界面靠它决定长出哪种控件。`,
      { id: manifest.id, key: `${keyPath}.type`, value: d.type })
  }

  // defaults 优先（它已经过 defaults_env 解析 ⇒ AURIVOX_* 旋钮拧了，界面
  // 初值会跟着动，而不是像今天这样被前端写死的那个数盖掉）。
  // sends_always 让界面知道：这个键即使不放进请求体，平台也会替它填上。
  const out = {
    name,
    type: d.type,
    default: inDefaults ? defaults[name] : d.default,
    sends_always: inDefaults,
  }

  if (d.type === 'enum') {
    const choices = Array.isArray(d.choices) ? d.choices : null
    if (!choices || choices.length === 0) {
      throw profileError('ENGINE_MANIFEST_INCOMPLETE',
        `引擎 ${manifest.id} 的 ${keyPath} 是 enum，必须给出 choices（下拉框的选项）`,
        { id: manifest.id, missing: `${keyPath}.choices` })
    }
    out.choices = choices.map((c, i) => {
      const item = plainObject(manifest, `${keyPath}.choices[${i}]`, c)
      if (!('value' in item)) {
        throw profileError('ENGINE_MANIFEST_INCOMPLETE',
          `引擎 ${manifest.id} 的 ${keyPath}.choices[${i}] 缺少 value`,
          { id: manifest.id, missing: `${keyPath}.choices[${i}].value` })
      }
      return { value: item.value, label: item.label || String(item.value) }
    })
    const values = out.choices.map(c => c.value)
    if (!values.includes(out.default)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 ${keyPath}.default 是 ${JSON.stringify(out.default)}，` +
        '但它不在 choices 里 —— 界面会显示一个选不中的值。',
        { id: manifest.id, key: `${keyPath}.default`, value: out.default })
    }
  }

  if (d.type === 'number' || d.type === 'integer') {
    for (const k of ['min', 'max', 'step']) {
      if (d[k] === undefined) continue
      const n = Number(d[k])
      if (!Number.isFinite(n)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 ${keyPath}.${k} 必须是数字，现在写的是 ${JSON.stringify(d[k])}`,
          { id: manifest.id, key: `${keyPath}.${k}`, value: d[k] })
      }
      out[k] = n
    }
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 ${keyPath} 的 min(${out.min}) 比 max(${out.max}) 还大`,
        { id: manifest.id, key: keyPath })
    }
  }

  // tier：界面把参数分成「常用」和「高级」两屏。没写按 advanced ——
  // 少露一个格子比多露一个安全（多露的那个会被当成推荐设置）。
  out.tier = d.tier === 'common' ? 'common' : 'advanced'
  out.label = d.label && typeof d.label === 'object' ? d.label : { en: name, zh: name }
  if (d.help && typeof d.help === 'object') out.help = d.help
  return out
}

// 返回**数组**而不是对象：界面要按声明顺序渲染，而 JSON 对象的键序
// 在往返一趟 JSON.parse 之后不保证还在（数字型键名会被重排）。
function parseParamSchema(manifest, defaults) {
  const params = manifest.params
  if (params === undefined || params === null) return []
  const p = plainObject(manifest, 'params', params)
  if (p.schema === undefined || p.schema === null) return []
  const schema = plainObject(manifest, 'params.schema', p.schema)

  const known = manifest.param_keys || []
  return Object.keys(schema).map(name => {
    // 只描述、不声明：schema 里冒出一个 param_keys 没有的名字，说明两处
    // 已经开始漂了 —— 正是 C11 要防的那件事，当场拦下。
    if (known.length && !known.includes(name)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 params.schema 里有 ${name}，但 param_keys 里没有它。` +
        'schema 只负责描述「这个参数长什么样」，不负责声明「有这个参数」；' +
        '两份名单一旦对不上，界面上就会出现一个发不出去的格子。',
        { id: manifest.id, key: `params.schema.${name}` })
    }
    return schemaEntry(manifest, name, schema[name], defaults)
  })
}

/**
 * 读一张名片，产出合成路径要用的东西。缺一项就抛，不猜。
 *
 * @param {string} id     引擎目录名 = 引擎 id
 * @param {object} [env]  环境变量表（测试用），默认 process.env
 * @throws FG_ENGINE_UNSUPPORTED / ENGINE_MANIFEST_INCOMPLETE / ENGINE_MANIFEST_INVALID_VALUE
 */
function resolveEngineProfile(id, env = process.env) {
  const manifest = requireEngine(id)          // 没装这个引擎 ⇒ FG_ENGINE_UNSUPPORTED
  const caps = manifest.capabilities || {}

  const { base_url, source } = resolveBaseUrl(manifest, env)

  const timeout_ms = positiveInt(manifest, 'timeout_ms',
    required(manifest, 'timeout_ms', manifest.timeout_ms,
      '平台不知道一段合成等多久算超时（这个值按「每一段」计，不是整篇）'))

  const max_chars = positiveInt(manifest, 'max_chars',
    required(manifest, 'max_chars', manifest.max_chars,
      '平台不知道该把长文本切成多长一段（慢引擎必须调小，否则单段就撑爆超时）'))

  if (!('reference_clip_seconds' in caps)) {
    throw profileError('ENGINE_MANIFEST_INCOMPLETE',
      `引擎 ${manifest.id} 的名片缺少 capabilities.reference_clip_seconds —— ` +
      '不限制请显式写 null。「忘了写」和「不限制」必须能区分开，' +
      '否则一个漏写会静默变成「什么参考音频都收」，等到合成失败才发现。',
      { id: manifest.id, missing: 'capabilities.reference_clip_seconds' })
  }

  // 先算出来：param_schema 的默认值要从这里取，不能再自备一份（C11）。
  const defaults = applyDefaultsEnv(manifest,
    plainObject(manifest, 'defaults', manifest.defaults),
    manifest.defaults_env, env)

  return {
    id: manifest.id,
    label: manifest.label || manifest.id,
    dir: manifest.dir,
    base_url,
    base_url_source: source,
    timeout_ms,
    max_chars,
    // 硬上限 = 软上限 ×2，与 synthesisService 今天的算法一致，不是新规则。
    hard_max_chars: max_chars * 2,
    requires_reference_audio: requiredBool(manifest,
      'capabilities.requires_reference_audio', caps.requires_reference_audio,
      '平台不知道没有参考音频时该不该拦下来'),
    reference_clip_seconds: parseClipSeconds(manifest, caps.reference_clip_seconds),
    hot_swap_models: requiredBool(manifest,
      'capabilities.hot_swap_models', caps.hot_swap_models,
      '平台不知道每次合成前该不该去换权重（不支持热切的引擎，换权重只能重启进程）'),
    output_sample_rate: positiveInt(manifest, 'capabilities.output_sample_rate',
      required(manifest, 'capabilities.output_sample_rate', caps.output_sample_rate,
        '平台生成段间静音和做拼接时要用它；猜错了会得到变调或对不上的静音')),
    // 契约 v2 只管推理：这个键唯一的用途是决定训练页显不显示。
    // 没写 = false，这是契约明文规定的默认，不算「猜」。
    supports_finetune: caps.supports_finetune === true,
    streaming: caps.streaming === true,
    param_keys: manifest.param_keys || [],
    // ---- 第 1c 步：拼请求体要用的三段 --------------------------------------
    // maps         平台的词 → 这台引擎的键名
    // payload_keys 允许从 cfg 透传的引擎原生键名白名单
    // defaults     这台引擎的默认值（引擎原生键名），只填没人填过的键
    maps: parseMaps(manifest, manifest.maps),
    payload_keys: stringArray(manifest, 'payload_keys', manifest.payload_keys),
    defaults,
    // ---- C11：界面长面板要用的那份，也只有这一处 --------------------------
    param_schema: parseParamSchema(manifest, defaults),
  }
}

// parseParamSchema 单独导出，是为了让 C11 的那些「写重了/写漏了要抛」能被
// 直接测到：造假引擎得往 engines/ 里写目录，而那一层有目录清点守卫盯着。
module.exports = { resolveEngineProfile, parseParamSchema }
