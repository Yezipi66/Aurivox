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
// ⭐ 权重位的规整规则跟磁盘约定住在一起（lib/assets/modelLayout.js）——
//   「名片声明了几个位」和「那几个位在盘上叫什么目录」必须是同一处答案，
//   分成两处的那天就是它们漂开的那天。
const { normalizeWeightSlots } = require('../assets/modelLayout')

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
      `引擎 ${manifest.id} 的 manifest.json 缺少 ${keyPath} —— ${hint}。` +
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
      `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 必须是正整数，现在写的是 ${JSON.stringify(value)}`,
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
        ? `引擎 ${manifest.id} 的 manifest.json 缺少 ${keyPath} —— ${hint}。请写明 true 或 false。`
        : `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 必须是 true 或 false，现在写的是 ${JSON.stringify(value)}`,
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
//
// ⭐⭐ 返回值里有两个地址，它们回答**两个不同的问题**：
//
//   base_url          「合成请求发到哪儿」（连）—— 会被 base_url_env 顶掉。
//   default_base_url  「这台引擎自己该监听哪儿」（听）—— 永远是名片声明的
//                     那个，env 顶不动它。
//
// 第 2c 步之前这个区分不存在，因为没人需要"听哪儿"：进程是 start.ps1 起的，
// 端口写死在脚本里。launchPlan.js 一旦要按名片起进程，两者就必须分开 ——
// 否则把 GPT_SOVITS_BASE_URL 指向一台远程引擎的人，会在本地起出一台
// 监听远程端口号的引擎。
function resolveBaseUrl(manifest, env) {
  // ⚠ 故意不走 required()：base_url_env 命中时保持原来的宽松（那条路径
  //   本来就不读 default_base_url），免得给一批只关心地址的调用方新增一个抛点。
  // ⭐ 刀 A3（2026-09-01）：default_base_url 变成**可选**——不再用 required()
  //   把它拦下来。理由：契约 §5.9 明写「端口是运输不是管理」，平台负责给由它
  //   启动的引擎分配端口，不该让名片作者写下「我该监听 9880」这种运输细节。
  //   名片没写 default_base_url 时，declared_base_url = null，base_url 也是
  //   null：这台引擎的「连」地址由 platform 在 buildLaunchPlan({ port }) 那
  //   一步决定（平台分配端口 → 写进 base_url_env），而不是在名片解析这一步猜。
  const raw = manifest.default_base_url
  const declared_base_url = raw ? String(raw).replace(/\/+$/, '') : null

  const envKey = manifest.base_url_env
  if (envKey && env[envKey]) {
    return {
      base_url: String(env[envKey]).replace(/\/+$/, ''),
      source: `env:${envKey}`,
      declared_base_url,
    }
  }
  // ⭐⭐ 不再 required()：没写 = null，交给平台（见上面）。
  const declared = declared_base_url
  return {
    base_url: declared == null ? null : String(declared).replace(/\/+$/, ''),
    source: declared == null ? 'platform' : 'manifest',
    declared_base_url,
  }
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
      `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 必须是一个对象，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  return value
}

function stringArray(manifest, keyPath, value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((k) => typeof k !== 'string' || !k)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 必须是一个非空字符串数组，现在写的是 ${JSON.stringify(value)}`,
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

// ---------------------------------------------------------------------------
//  runtime —— 这台引擎的进程长什么样
// ---------------------------------------------------------------------------
// 契约 v2 §5.1 早就写了这一段，但在这个函数出现之前它是**零消费者的死数据**：
// 全平台 grep 不到任何人读 manifest.runtime。死数据的代价当场兑现了 ——
// engines/indextts2/manifest.json 把路径写成 `.../venv/Scripts/python.exe`，
// 少了一个点（真的是 `.venv`），写错了不知道多久没人发现，因为没人读它。
//
// ⭐ 平台在这一段上的立场（Owner 2026-08-24 拍板）：**只验不建**。
//    平台不给任何引擎装环境、不装包、不管版本。它只做两件事：
//      1) 核对名片说的那个解释器/模块/类/方法在不在（本段 + envCheck.js）
//      2) 按名片起进程、轮询 ready（supervisor，下一刀）
//    核对不过 = 这台引擎**没装**。平台不代劳，也不背书。
//
// ⛔ 不认识的键要抛错，不能默默忽略：`ready_endoint` 这种拼写错误如果被
//    静默吃掉，表现是"轮询永远超时"，而名片看上去完全正常。
const RUNTIME_KEYS = Object.freeze([
  'python', 'entry', 'args', 'cwd', 'checkpoints',
  'ready_endpoint', 'ready_timeout_ms', 'ready_timeout_ms_source', 'preload', 'verify',
])

const VERIFY_IMPORT_KEYS = Object.freeze(['module', 'class', 'methods', 'init_params'])

// ---------------------------------------------------------------------------
//  刀 B1：**顶层**也要有白名单【2026-08-31】
// ---------------------------------------------------------------------------
// `runtime` 段早就有 RUNTIME_KEYS 了（上面那一段），理由写得很清楚：
// 拼错被静默忽略，表现成「平台反复查询却一直等到超时」而名片看着完全正常。
//
// ⛔ 但**顶层一直没有这道闸**。写 `"max_char": 1`（少个 s）今天的表现是：
//    名片解析成功、平台照常起、然后用它自己那个默认的分段长度去切文本 ——
//    作者调了一个不存在的键，一声不吭。
//    ⭐ 这比 runtime 那一层更值得守：runtime 里拼错至少还会超时，
//      顶层拼错**连症状都没有**，只是「设了没效果」。
//
// ⭐ 名单的来源是**量出来的**，不是想出来的：三张真名片（gpt-sovits 19 键 /
//   indextts2 21 键 / _TEMPLATE 22 键）的并集，加上 registry.js:60-61
//   在读盘时注进来的 `dir`（`id` 它也会覆写，本来就在表上）。
//   ⚠ 以 `_` 开头的注释键到不了这里 —— registry.js:29 的 stripComments 先剥掉了。
//
// ⛔ 加一个新的顶层键时，必须**同时**加进这张表。漏加的表现是那台引擎
//   整个装不上（当场抛），⛔ 不是静默 —— 这是故意的：一个响的错好过一个哑的。
const TOP_KEYS = Object.freeze([
  // 身份
  'contract_version', 'id', 'label', 'dir',
  // 来源与本地改动（C10）
  'upstream', 'local_changes', 'install', 'models',
  // 模型位
  'weights',
  // 地址（⚠ §5.9 五：这两个键在退休路上，A3/C4 会来拆；今天仍然是活键）
  'default_base_url', 'base_url_env',
  // 预算
  'max_chars', 'max_chars_source', 'timeout_ms', 'timeout_ms_source',
  // 能力与进程
  'capabilities', 'runtime', 'call',
  // 请求体三段
  'maps', 'payload_keys', 'defaults', 'defaults_env',
  // 界面参数两段
  'param_keys', 'params', 'parameters', 'input',
  // 输出
  'output_formats',
])

// ⚠⚠ 这里**故意没有**一张「已退休的顶层键」表【2026-08-31 记录，待 Owner 裁决】
//
// 我写过一版：仿照 `capabilities.hot_swap_models` 的退休路，让删掉的那个
// 顶层键「照装 + 提醒一次」，好让上游作者手上的老名片不至于突然装不上。
// ⛔ 它当场撞上刀 A1 的归零守卫（`synthesis.engineRequired.node.test.js:465`：
//   全仓库活代码不许再出现那个词）—— 因为「提醒一次」这条路**必须把那个词
//   写进活代码**，否则提醒不出名字来。
//
// ⭐ 两条规矩在这里是真的打架，⛔ 不是我实现错了：
//     退休路说「老名片照装，别让一次删除弄坏别人的引擎」
//     A1 归零说「那个词一个字都不许再出现，否则它会从后门爬回来」
//
// ⭐ 今天按 **A1 优先**处理（⛔ 我不改那条守卫来让自己的代码过）。
//   ⇒ 老名片写着那个键 ⇒ **装不上**，报的是下面那句「顶层有个平台不认识的键」。
//   **预言**：那句话指名道姓、还列全了认识的键，作者删掉那一行就能装 ——
//   代价是他不知道那个键**曾经**是什么意思。
//   ⚠ 与 hot_swap_models 的处理**不一致**（那个是照装+提醒），
//     两者的区别今天只有一条：那个词没有归零守卫盯着。⛔ 这不是理由，是现状。

// 拼错的键要给出「你是不是想写 X」。⛔ 不猜着改，只提示。
// 经典的 Levenshtein，名单只有二十来个词、一台引擎解析一次，代价忽略不计。
function editDistance(a, b) {
  const m = a.length
  const n = b.length
  let prev = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

function nearestKey(bad) {
  let best = null
  let bestD = Infinity
  for (const k of TOP_KEYS) {
    const d = editDistance(bad, k)
    if (d < bestD) { bestD = d; best = k }
  }
  // 距离 3 以上就不是拼错了，是另一个词 —— ⛔ 别把无关的键"猜"成某个已知键。
  return bestD <= 3 ? best : null
}

/**
 * 顶层键白名单。⛔ 不认识的键**当场抛**，不静默忽略。
 *
 * ⭐ 判据：`{"max_char": 1}`（少个 s）必须报错。
 *   静默忽略它 = 作者调了一个不存在的旋钮而毫无察觉，
 *   这正是 C11 要杀的那类「设了没效果」。
 */
function checkTopKeys(manifest) {
  for (const k of Object.keys(manifest)) {
    if (TOP_KEYS.includes(k)) continue
    const guess = nearestKey(k)
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 顶层有一个平台不认识的键：${k}` +
      (guess ? `——是不是想写 ${guess}？` : '。') +
      '⛔ 平台不静默忽略它：忽略的表现是「你设了它，但什么都没发生」，' +
      '而名片看上去完全正常，这是最难查的一类问题。' +
      `认识的顶层键只有这 ${TOP_KEYS.length} 个：${TOP_KEYS.join(' / ')}。` +
      '（要写给人看的注释，用 _ 开头 —— 那种键读盘时就被剥掉了。）',
      { id: manifest.id, key: k, did_you_mean: guess })
  }
}

// ---------------------------------------------------------------------------
//  刀 #13 / C13.2：实测得来的数，填了就必须带 `_source` 【2026-09-01】
// ---------------------------------------------------------------------------
// 名片里有三个数，接引擎的人第一次是填不出来的（`max_chars` /
// `timeout_ms` / `runtime.ready_timeout_ms`），都得跑过才知道。C13.2 的规矩：
// 这些数**可以不写**（C13.1，另说）；但**写了就必须说明出处**——同级必须有
// 对应的 `_source`（`max_chars_source` / `timeout_ms_source` /
// `ready_timeout_ms_source`），取值只能是 `measured` / `upstream` / `estimated`。
//
// ⭐ 为什么要守：一个 `estimated` 被当成 `measured` 去信，表现是「引擎明明
//   还在正常加载，平台先放弃了」，排查的人去查引擎、不会怀疑这个数——
//   **出处本身就是判据的一部分**。
//
// ⚠ C13.1「留空合法 + 保守默认值」本轮**暂缓**：今天 `timeout_ms` /
// `max_chars` 仍是 `required()`（缺就抛），而 `max_chars` 的保守值契约自己
// 说「没有答案，明记的账」。这轮只落 C13.2 的出处守卫，不动默认值回退。
//
// ⛔ 本函数里**不许出现任何一台引擎的 id**——出处规则对所有引擎通用。
const MEASURED_SOURCES = Object.freeze(['measured', 'upstream', 'estimated'])

// [数据键, _source 键, 所在段名(报错用)]。ready_timeout_ms 在 runtime 段内。
const MEASURED_PAIRS = Object.freeze([
  ['max_chars', 'max_chars_source', 'manifest.json 顶层'],
  ['timeout_ms', 'timeout_ms_source', 'manifest.json 顶层'],
])

function sourceOf(obj, sourceKey, segment) {
  if (!obj || !(sourceKey in obj)) return null
  const v = obj[sourceKey]
  if (!MEASURED_SOURCES.includes(v)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${obj._idForMsg || '<engine>'} 的 ${segment}${sourceKey} 写的是 ${JSON.stringify(v)} —— ` +
      `必须是 ${MEASURED_SOURCES.join(' / ')} 之一（measured=本项目实测，upstream=上游文档写的，estimated=推算/经验拍）。` +
      '⛔ 不认识的出处值不能默默当实测用：一个 estimated 被当成 measured 去信，' +
      '平台会提前放弃一个其实还在正常加载的引擎。',
      { key: sourceKey, value: v, allowed: MEASURED_SOURCES })
  }
  return v
}

function checkMeasuredSources(manifest) {
  // 顶层两个：max_chars / timeout_ms
  for (const [key, srcKey] of MEASURED_PAIRS) {
    if (!(key in manifest)) continue // C13.1 留空合法，不校验
    if (!(srcKey in manifest)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 manifest.json 顶层写了 ${key} 但没有 ${srcKey} —— ` +
        `${key} 是跑过才知道的数，写了就必须说明它怎么来的（measured / upstream / estimated），` +
        '否则半年后没人分得清这是量出来的还是拍出来的。' +
        '（如果还没量过，把这一行删掉即可，平台会用保守值。）',
        { id: manifest.id, key, missing_source: srcKey })
    }
    sourceOf(manifest, srcKey, 'manifest.json 顶层')
  }
  // runtime 段：ready_timeout_ms
  const r = manifest.runtime
  if (r && 'ready_timeout_ms' in r) {
    if (!('ready_timeout_ms_source' in r)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 manifest.json runtime 段写了 ready_timeout_ms 但没有 ready_timeout_ms_source —— ` +
        '同理，写了就得说明出处。',
        { id: manifest.id, key: 'runtime.ready_timeout_ms', missing_source: 'runtime.ready_timeout_ms_source' })
    }
    sourceOf(Object.assign({ _idForMsg: manifest.id }, r), 'ready_timeout_ms_source', 'runtime 段')
  }
}

function relPath(manifest, keyPath, value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 必须是一段非空路径，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  // 绝对路径会让名片只在作者那台机器上成立 —— 这正是契约 C3 禁止的事。
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(value)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 ${keyPath} 写成了绝对路径（${value}）—— ` +
      'manifest.json 要能跟着项目复制到别的机器，路径必须是相对的（python/cwd 相对项目根，entry 相对 manifest.json 所在目录）。',
      { id: manifest.id, key: keyPath, value })
  }
  return value
}

// ---------------------------------------------------------------------------
//  models —— 这台引擎的底模（权重）从哪来、齐不齐
// ---------------------------------------------------------------------------
// 2026-08-29。这一段是为**接入者**加的，不是为我们自己。
//
// ⭐ 加它的直接原因（Owner 原话）：「上游要接入进来，他还得手动把模型放对」。
//    在这一段出现之前，平台对「模型」这件事一个字都不说：
//      · 路径只活在 runtime.checkpoints 里，而那一行**只有启动器读**，
//        界面上零展示 ⇒ 装的人根本不知道该往哪儿放；
//      · 安装计划（installPlan.js）从头到尾没有「拉底模」这一步 ⇒ 放没放对、
//        放齐没有，平台既不查也不说。表现是引擎起不来，而报错来自上游代码深处。
//
// ⚠ 路径**不在这里重写一遍**，它就是 runtime.checkpoints。同一个事实两处写，
//   早晚对不上（server.js 里那两张 GSV 权重表的注释已经为这件事警告过一次）。
//   这一段只回答另外三个问题：听不听环境变量、哪几个文件算齐、拿不到时怎么办。
//
// ⭐⭐ source.command 是**名片自己写的一条 argv**，平台不认识任何下载器。
//    理由和 base_url_env / install.env_command 完全一样：HF、ModelScope、
//    直链、网盘，各家不同；平台一旦替谁生成命令，就等于把那一家写进 lib/，
//    而且生成错了不会报错，只会下到一半或者下错版本。名片说什么就打印什么。
//    ⇒ 这一刀**只打印不执行**（真执行要联网、要动 installPlan.js 的步骤表，
//      单独一刀）。但字段现在就定下来，接入者写一次，第二刀是纯增量。
// ⭐ 2026-09-29 加 external。接 CosyVoice2 时暴露的一整类问题：
//   有些运行必需的权重**不是引擎自己带的**，而是它的第三方包在 import/运行时
//   拉下来的 —— CosyVoice2 的 wetext 包就这样（`snapshot_download("pengzhendong/wetext")`）。
//   ⛔ 平台原来的模型概念只覆盖「引擎自己声明的那些」，于是这一整类**隐形**：
//     平台校验在它出现之前就通过了，用户和平台都不知道它存在。
//   ⭐ external 就是把它从隐形变成声明 —— 名字、谁拉的、缺了会怎样。
const MODELS_KEYS = Object.freeze(['checkpoints_env', 'required', 'hint', 'source', 'external'])

// ⭐ external 里每一项的键。⛔ 刻意**很少** ——
//   它回答的是「这东西是什么」，不是「怎么装」：装是那个包自己的事。
const MODELS_EXTERNAL_KEYS = Object.freeze(['name', 'label', 'via', 'needed_by'])
const MODELS_SOURCE_KEYS = Object.freeze(['url', 'license_gate', 'command', 'cwd'])

// command 里允许出现的占位符。和 launchPlan.js 的那一套是同一批名字，
// ⛔ 但故意不 require 它 —— 那个文件回答的是「怎么起进程」，跟下模型无关，
//    为了共用三个字符串把两件事绑在一起，改一边就得动另一边。
const MODELS_PLACEHOLDERS = Object.freeze(['root', 'engine_dir', 'checkpoints'])

const MODELS_SOURCE_CWDS = Object.freeze(['engine_dir', 'root'])

function parseModelsSource(manifest, raw) {
  if (raw === undefined || raw === null) return null
  const s = plainObject(manifest, 'models.source', raw)

  for (const k of Object.keys(s)) {
    if (!MODELS_SOURCE_KEYS.includes(k)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 manifest.json 里 models.source.${k} 平台不认识 —— ` +
        `认识的只有 ${MODELS_SOURCE_KEYS.join(' / ')}。`,
        { id: manifest.id, key: `models.source.${k}` })
    }
  }

  let command = null
  if (s.command !== undefined && s.command !== null) {
    if (!Array.isArray(s.command) || s.command.length === 0 ||
        s.command.some((x) => typeof x !== 'string' || !x.trim())) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 models.source.command 必须是一个非空的字符串数组` +
        '（argv 形式，例如 ["modelscope","download","--model","作者/仓库","--local_dir","{checkpoints}"]）—— ' +
        '写成一整行命令会在带空格的路径上被拆错，那种错很难查。',
        { id: manifest.id, key: 'models.source.command', value: s.command })
    }
    command = s.command.map((x) => x.trim())
    // 占位符写错必须当场抛。写错了的表现是「命令原样打出来，用户照抄，
    // 下到一个叫 {checkpoint} 的目录里」—— 没有任何一步会报错。
    for (const part of command) {
      const found = String(part).match(/\{([a-z_]+)\}/g) || []
      for (const tok of found) {
        const name = tok.slice(1, -1)
        if (!MODELS_PLACEHOLDERS.includes(name)) {
          throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
            `引擎 ${manifest.id} 的 models.source.command 里有平台不认识的占位符 ${tok} —— ` +
            `认识的只有 ${MODELS_PLACEHOLDERS.map((n) => `{${n}}`).join(' / ')}。`,
            { id: manifest.id, key: 'models.source.command', value: tok })
        }
      }
    }
    if (!command.some((x) => x.includes('{checkpoints}'))) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 models.source.command 里没有出现 {checkpoints} —— ` +
        '那这条命令不会把模型下到平台要找的那个目录里，下完平台照样说"底模没放"。' +
        '如果这个下载器真的不接收目标目录，请去掉 command 只留 hint，把话说清楚让人手动放。',
        { id: manifest.id, key: 'models.source.command', value: command })
    }
  }

  const cwd = s.cwd === undefined || s.cwd === null ? 'engine_dir' : s.cwd
  if (!MODELS_SOURCE_CWDS.includes(cwd)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 models.source.cwd 只能是 ${MODELS_SOURCE_CWDS.join(' / ')}，` +
      `现在写的是 ${JSON.stringify(s.cwd)}`,
      { id: manifest.id, key: 'models.source.cwd', value: s.cwd })
  }

  return {
    url: typeof s.url === 'string' && s.url.trim() ? s.url.trim() : null,
    // 「要先去网站上点同意才能下」。⭐ 显式写出来，是因为它的失败长得像网络
    // 故障（401/403），而真正的解法是去开一次浏览器 —— 猜不出来的。
    license_gate: s.license_gate === true,
    command,
    cwd,
  }
}

/** models.external —— 第三方包在运行时拉的、但运行必需的权重（2026-09-29）。 */
function parseModelsExternal(manifest, raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 models.external 必须是一个数组`,
      { id: manifest.id, key: 'models.external' })
  }
  return raw.map((e, i) => {
    const o = plainObject(manifest, `models.external[${i}]`, e)
    for (const k of Object.keys(o)) {
      if (!MODELS_EXTERNAL_KEYS.includes(k)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 models.external[${i}].${k} 平台不认识 —— ` +
          `认识的只有 ${MODELS_EXTERNAL_KEYS.join(' / ')}。`,
          { id: manifest.id, key: `models.external[${i}].${k}` })
      }
    }
    for (const k of ['name', 'via', 'needed_by']) {
      if (typeof o[k] !== 'string' || !o[k].trim()) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 models.external[${i}].${k} 缺了 —— ` +
          '⛔ 这三项都是「缺了就说不清」的：名字是给人看的，via 是谁拉的，' +
          'needed_by 是缺了会怎样（不写就变成「不知道重不重要」）。',
          { id: manifest.id, key: `models.external[${i}].${k}` })
      }
    }
    return {
      name: o.name,
      label: o.label || o.name,
      via: o.via,
      needed_by: o.needed_by,
    }
  })
}

function parseModels(manifest) {
  const raw = manifest.models
  // 没写 models 段是合法的：那表示这台引擎没有需要单独放置的底模，
  // 或者作者还没来得及说。⛔ 不能当成"底模缺失"——那是把"没说"当成"没有"。
  if (raw === undefined || raw === null) return null
  const m = plainObject(manifest, 'models', raw)

  for (const k of Object.keys(m)) {
    if (!MODELS_KEYS.includes(k)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 manifest.json 里 models.${k} 平台不认识 —— ` +
        `认识的只有 ${MODELS_KEYS.join(' / ')}。` +
        '多半是拼错了（拼错被静默忽略，表现是"体检永远说底模齐"而实际没放）。',
        { id: manifest.id, key: `models.${k}` })
    }
  }

  const required_files = stringArray(manifest, 'models.required', m.required)
  for (const f of required_files) {
    if (/^([A-Za-z]:[\\/]|[\\/])/.test(f)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 models.required 里 ${JSON.stringify(f)} 是绝对路径 —— ` +
        '这里每一项都是**相对底模目录**的路径（例如 "config.yaml" 或 "v2/s2G2333k.pth"）。',
        { id: manifest.id, key: 'models.required', value: f })
    }
  }

  return {
    // 听哪个环境变量报底模目录（名字，不是值）。规矩与 base_url_env 一致：
    // 平台不认识任何具体的变量名，名片说听谁才去读谁。
    checkpoints_env: typeof m.checkpoints_env === 'string' && m.checkpoints_env.trim()
      ? m.checkpoints_env.trim() : null,
    // 哪几个文件在了才算"底模齐"。空数组 = 名片没说，平台只能报"目录在不在"。
    // ⛔ 平台不替任何引擎猜必需文件名。
    required: required_files,
    hint: typeof m.hint === 'string' && m.hint.trim() ? m.hint.trim() : null,
    source: parseModelsSource(manifest, m.source),
    // ⭐ 第三方包在运行时拉的、但运行必需的权重。空数组 = 这台引擎没有这一类。
    //   ⛔ 平台**不去查它们在不在**（那是那个包自己的事）——
    //     平台只负责把它们**说出来**，让「隐形」变成「声明」。
    external: parseModelsExternal(manifest, m.external),
  }
}

// ---- C10：上游从哪来、钉在哪一版 ------------------------------------------
// 契约 C10 原文：「唯一必须留在 git 里的上游信息，是那个 commit 号……
// 删了上游的 .git 之后，这个号事后再也拿不回来 —— 丢了它，安装脚本都不知道
// 该拉哪一版。」
//
// ⭐ 严格程度**故意分两处**，不要合并：
//   - 这里（合成路径要走的解析器）**宽松**：读不出来就交 null。
//     一台引擎已经装好了、正在出声，不该因为「commit 没记」而合成不了 ——
//     那是把「档案不全」当成「引擎坏了」。
//   - 安装工具 tools/install-engine.cjs **严格**：没有 commit 就拒绝安装。
//     「该拉哪一版」这个问题只有在安装那一刻才真正需要答案。
//   - 真名片另有守卫测试（realManifests）盯着，保证我们自己这两台不许漏。
//
// 兼容旧写法：`"upstream": "https://..."` 这种裸字符串是版本 2 之前的形态，
// 只有地址没有版本号。不抛错，但 commit 交 null ⇒ 安装工具会拦下来并说清楚。
function parseUpstream(manifest) {
  const raw = manifest.upstream
  if (raw === undefined || raw === null) return null

  if (typeof raw === 'string') {
    const url = raw.trim()
    if (!url) return null
    return { url, commit: null, commit_unknown_reason: null, license: null }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 upstream 必须是一个对象（或旧写法的地址字符串），` +
      `现在写的是 ${JSON.stringify(raw)}`,
      { id: manifest.id, key: 'upstream', value: raw })
  }

  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (!url) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 upstream.url 是空的 —— ` +
      '不写地址，安装的人无从知道这台引擎的源码该去哪儿拉。',
      { id: manifest.id, key: 'upstream.url', value: raw.url })
  }

  // commit 只认完整 40 位 sha。短 sha 会随仓库长大而歧义，标签和分支会移动，
  // 三者都答不了「半年后我还能不能装回一模一样的版本」。
  let commit = null
  if (raw.commit !== undefined && raw.commit !== null) {
    if (typeof raw.commit !== 'string' || !/^[0-9a-f]{40}$/.test(raw.commit.trim())) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 upstream.commit 必须是完整的 40 位十六进制 sha，` +
        `现在写的是 ${JSON.stringify(raw.commit)} —— ` +
        '短 sha 会随仓库长大而变得有歧义，分支和标签会移动，' +
        '这三种都回答不了「半年后还能不能装回一模一样的版本」。' +
        '真的没有就写 null，并在 upstream.commit_unknown_reason 里说清为什么。',
        { id: manifest.id, key: 'upstream.commit', value: raw.commit })
    }
    commit = raw.commit.trim()
  }

  // 写了 null 就必须说明为什么 —— 与 C13.2「填了要说出处」同一条道理的反面：
  // 空着不是错，但空着而没有解释，半年后没人分得清是「拿不回来了」还是「忘了写」。
  const reason = typeof raw.commit_unknown_reason === 'string'
    ? raw.commit_unknown_reason.trim() : ''
  if (commit === null && 'commit' in raw && !reason) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 upstream.commit 写了 null 却没写 upstream.commit_unknown_reason —— ` +
      '「拿不回来了」和「忘了写」必须能区分开：前者是既成事实，后者是待办。',
      { id: manifest.id, key: 'upstream.commit_unknown_reason' })
  }

  return {
    url,
    commit,
    commit_unknown_reason: reason || null,
    license: typeof raw.license === 'string' && raw.license.trim()
      ? raw.license.trim() : null,
  }
}

function parseVerify(manifest, value) {
  if (value === undefined || value === null) return null
  const v = plainObject(manifest, 'runtime.verify', value)

  const sysPath = stringArray(manifest, 'runtime.verify.sys_path', v.sys_path)
    .map((p, i) => relPath(manifest, `runtime.verify.sys_path[${i}]`, p))

  const rawImports = v.imports
  if (!Array.isArray(rawImports) || rawImports.length === 0) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 写了 runtime.verify 却没写 runtime.verify.imports —— ` +
      '一条都不检查的校验等于没有校验，那还不如整段不写。',
      { id: manifest.id, key: 'runtime.verify.imports', value: rawImports })
  }

  const imports = rawImports.map((raw, i) => {
    const item = plainObject(manifest, `runtime.verify.imports.${i}`, raw)
    for (const k of Object.keys(item)) {
      if (!VERIFY_IMPORT_KEYS.includes(k)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 runtime.verify.imports.${i} 上有平台不认识的键 ${k} —— ` +
          `认识的只有 ${VERIFY_IMPORT_KEYS.join(' / ')}。拼错了就改，真需要新键就先改契约。`,
          { id: manifest.id, key: `runtime.verify.imports.${i}.${k}` })
      }
    }
    const mod = required(manifest, `runtime.verify.imports.${i}.module`, item.module,
      '校验要 import 哪个模块')
    if (typeof mod !== 'string') {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 runtime.verify.imports.${i}.module 必须是模块名字符串`,
        { id: manifest.id, key: `runtime.verify.imports.${i}.module`, value: mod })
    }
    const cls = item.class === undefined || item.class === null ? null : String(item.class)
    const methods = stringArray(manifest, `runtime.verify.imports.${i}.methods`, item.methods)
    const initParams = stringArray(manifest, `runtime.verify.imports.${i}.init_params`, item.init_params)
    // 方法名/构造参数名都是挂在类上的，没有类就无处可挂 —— 写了却没写 class
    // 是名片作者漏了一行，静默忽略会让"我明明写了要检查 infer"变成一句空话。
    if (!cls && (methods.length || initParams.length)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 runtime.verify.imports.${i} 写了 methods/init_params 却没写 class —— ` +
        '这两样都挂在类上，没有类就检查不了。',
        { id: manifest.id, key: `runtime.verify.imports.${i}.class` })
    }
    return { module: mod, class: cls, methods, init_params: initParams }
  })

  return { sys_path: sysPath, imports }
}

function parseRuntime(manifest) {
  const raw = manifest.runtime
  // 缺 runtime = 这台引擎不由平台起（作者自己起、或者还没接上电）。
  // 这是合法状态，不报错 —— 但它同时意味着平台**没法校验**它，
  // 界面上要能看出这个区别，所以返回 null 而不是空对象。
  if (raw === undefined || raw === null) return null
  const r = plainObject(manifest, 'runtime', raw)

  for (const k of Object.keys(r)) {
    if (!RUNTIME_KEYS.includes(k)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 manifest.json 里 runtime.${k} 平台不认识 —— ` +
        `认识的只有 ${RUNTIME_KEYS.join(' / ')}。` +
        '多半是拼错了（拼错被静默忽略，表现是"平台反复查询却一直等到超时"而 manifest.json 看着完全正常）。',
        { id: manifest.id, key: `runtime.${k}` })
    }
  }

  const python = relPath(manifest, 'runtime.python',
    required(manifest, 'runtime.python', r.python,
      '平台不知道该用哪个解释器去核对这台引擎装没装'))
  const entry = relPath(manifest, 'runtime.entry',
    required(manifest, 'runtime.entry', r.entry,
      '平台不知道该跑哪个脚本把这台引擎起起来'))

  const readyEndpoint = required(manifest, 'runtime.ready_endpoint', r.ready_endpoint,
    '平台不知道该访问哪个地址判断引擎起来没有')
  if (typeof readyEndpoint !== 'string' || !readyEndpoint.startsWith('/')) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 runtime.ready_endpoint 必须是以 / 开头的路径，` +
      `现在写的是 ${JSON.stringify(readyEndpoint)}`,
      { id: manifest.id, key: 'runtime.ready_endpoint', value: readyEndpoint })
  }

  const readyTimeout = positiveInt(manifest, 'runtime.ready_timeout_ms',
    required(manifest, 'runtime.ready_timeout_ms', r.ready_timeout_ms,
      '平台不知道等多久还没 ready 就该判定这台引擎起不来'))

  return {
    python,
    entry,
    args: stringArray(manifest, 'runtime.args', r.args),
    cwd: r.cwd === undefined || r.cwd === null ? null : relPath(manifest, 'runtime.cwd', r.cwd),
    checkpoints: r.checkpoints === undefined || r.checkpoints === null
      ? null : relPath(manifest, 'runtime.checkpoints', r.checkpoints),
    ready_endpoint: readyEndpoint,
    ready_timeout_ms: readyTimeout,
    preload: r.preload === true,
    verify: parseVerify(manifest, r.verify),
  }
}

// ⭐ 'path' 是 2026-08-29 加的第五种，理由值得写下来：
//
// 在它之前，一台引擎在 manifest 里**没办法说「我有一个参数，它的值是个文件」**
// —— 只能说数字/整数/布尔/下拉。而模型权重恰恰是文件。
// 于是 GPT-SoVITS 的两个权重当年只能在参数表之外另开一套：抬成 recipe 的
// 顶层字段（gpt_ckpt / sovits_pth），再由前端 5 个文件各画一遍「GPT 槽 +
// SoVITS 槽」。结果就是平台被迫**认识**「什么是权重、有几个、怎么配对」,
// 而 IndexTTS2 根本没有这个概念。
//
// 加上这一种之后，权重不再是平台的一个概念，只是袋子里一个值是路径的参数：
// 有几个、叫什么，那台引擎自己在 params.schema 里说；一个都不写就一个格子
// 都不长；用户没填就不发（payload 那边空值本来就不进请求体）。
//
// 平台对 'path' 只多做一件事：它的值是**平台托管的路径**，交给 pathResolver
// 解析（值的形状是 {base:'asset'|'external', path} 或裸字符串，pathResolver
// 本来就按形状工作、不认字段名）。⛔ 除此之外不校验：不查文件在不在、
// 不查后缀、不填默认路径。
// ⭐⭐ 2026-08-29 收口成**五种预设样式**（Owner 定的：文本 / 数字 / 下拉 /
//    勾选 / 路径）+ 一个正交修饰 repeat。定义搬到 lib/engines/paramTypes.js，
//    那里写着为什么 enum→select、path→file、integer 折进 number。
//    ⛔ 这里不再自己列一份类型表 —— 列第二份就是 C11 要杀的东西。
const {
  PARAM_TYPES, SELECT_SOURCES, canonicalType, isIntFlavor, repeatOf,
} = require('./paramTypes')
const { hasDerivedParameters } = require('./parameterDeclaration')

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
  if (!inDefaults && !inSchema && !hasDerivedParameters(manifest)) {
    throw profileError('ENGINE_MANIFEST_INCOMPLETE',
      `引擎 ${manifest.id} 的 params.schema 描述了 ${name}，却没人给它默认值 —— ` +
      `请写 defaults.${name}（每次都发）或 ${keyPath}.default（只是界面初值）。` +
      '不写的话界面只能自己编一个，那就又多出一份副本（契约 C11）。',
      { id: manifest.id, missing: `defaults.${name} 或 ${keyPath}.default` })
  }

  const type = canonicalType(d.type)
  if (!type) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 ${keyPath}.type 必须是 ${PARAM_TYPES.join(' / ')} 之一，` +
      `现在写的是 ${JSON.stringify(d.type)} —— 界面靠它决定长出哪种控件。` +
      '（老写法 integer / enum / path / string 仍然收，会折进上面五种。）',
      { id: manifest.id, key: `${keyPath}.type`, value: d.type })
  }

  // defaults 优先（它已经过 defaults_env 解析 ⇒ AURIVOX_* 旋钮拧了，界面
  // 初值会跟着动，而不是像今天这样被前端写死的那个数盖掉）。
  // sends_always 已退役（f68421f）：未触碰的 UI 建议值不再跨越引擎边界，
  //   只有 touchedParams 记录过的键才发送。defaults 里的值仍由后端
  //   synthesisService.js 的 engineKnobs 循环填入 payload，前端不再需要
  //   知道「哪些键平台会替你填」—— 它只管「用户动过哪些」。
  const out = { name, type }
  const lifecycle = manifest.params || {}
  const loadTime = Array.isArray(lifecycle.load_time) ? lifecycle.load_time : []
  out.phase = loadTime.includes(name) ? 'load' : 'call'
  if (inDefaults || inSchema) out.default = inDefaults ? defaults[name] : d.default
  // 「是不是整数」不是一种样式，是数字的一味。保留是因为收取侧要 parseInt ——
  // 不保留就会把 7.5 悄悄发给一个只吃整数的引擎，而那不报错。
  if (isIntFlavor(d.type)) out.int = true

  // ⭐ repeat：正交修饰，不是第六种类型。八维情绪向量 = number × repeat 8。
  //   ⛔ 不写 / 写 1 ⇒ 标量，**不是**长度 1 的数组：「一格」和「一格但装在
  //     数组里」发给引擎是两件事，而这个差别一路都不报错。
  const repeat = repeatOf(d)
  if (d.repeat !== undefined && repeatOf(d) === 1 && Number(d.repeat) !== 1) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 ${keyPath}.repeat 必须是 ≥1 的整数，` +
      `现在写的是 ${JSON.stringify(d.repeat)}`,
      { id: manifest.id, key: `${keyPath}.repeat`, value: d.repeat })
  }
  if (repeat > 1) {
    out.repeat = repeat
    // 默认值必须自己就是一排。⛔ 不替名片把标量摊成 N 份：那样「八维默认全 0.5」
    // 和「作者只写了一维」在界面上长得一模一样，而后者是个错。
    if (!Array.isArray(out.default) || out.default.length !== repeat) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 ${name} 声明了 repeat=${repeat}（界面长 ${repeat} 格），` +
        `默认值就必须是长度 ${repeat} 的数组，现在是 ${JSON.stringify(out.default)}。` +
        '⛔ 平台不替你把一个数摊成一排 —— 那样「默认全都是它」和「你只写了一维」' +
        '长得一模一样，而后者是个错。',
        { id: manifest.id, key: `${keyPath}.default`, value: out.default })
    }
    // 每一格的小名（情绪向量的「喜/怒/哀…」）。没写就用序号，界面不会空着。
    if (d.dim_labels !== undefined) {
      if (!Array.isArray(d.dim_labels) || d.dim_labels.length !== repeat) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 ${keyPath}.dim_labels 写了就必须是长度 ${repeat} 的数组` +
          `（跟 repeat 对齐），现在长度是 ${Array.isArray(d.dim_labels) ? d.dim_labels.length : 'not an array'}`,
          { id: manifest.id, key: `${keyPath}.dim_labels` })
      }
      out.dim_labels = d.dim_labels.map(x => (x && typeof x === 'object') ? x : { en: String(x), zh: String(x) })
    }
  }

  if (type === 'select') {
    // 选项两种来源，⭐ 二选一。两个都写 = 界面不知道听谁的，而它会**默默**
    // 挑一个 —— 那正是 C11 说的那种会各自漂移的副本。
    const hasChoices = d.choices !== undefined
    const hasSource = d.source !== undefined
    if (hasChoices && hasSource) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 ${keyPath} 同时写了 choices 和 source —— 只能二选一：` +
        '选项写死在名片里用 choices，选项要平台运行时扫盘才知道用 source。',
        { id: manifest.id, key: `${keyPath}.source` })
    }
    if (hasSource) {
      if (!SELECT_SOURCES.includes(d.source)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 ${keyPath}.source 必须是 ${SELECT_SOURCES.join(' / ')} 之一，` +
          `现在写的是 ${JSON.stringify(d.source)} —— 它说的是「选项从平台的哪个库里扫」。`,
          { id: manifest.id, key: `${keyPath}.source`, value: d.source })
      }
      out.source = d.source
      // 库里没有想要的那个时，让不让用户自己指一个文件。
      // ⛔ 默认 false：替引擎规定「文件只能放我们指定的地方」是错的，但默认
      //   放开又会让「库里应该有却没扫到」这种坏法穿过去不报警。名片说了算。
      out.allow_custom = d.allow_custom === true
    } else {
      const choices = Array.isArray(d.choices) ? d.choices : null
      if (!choices || choices.length === 0) {
        throw profileError('ENGINE_MANIFEST_INCOMPLETE',
          `引擎 ${manifest.id} 的 ${keyPath} 是 select，必须给出 choices（名片写死的选项）` +
          `或 source（${SELECT_SOURCES.join(' / ')}，平台运行时扫出来的选项）`,
          { id: manifest.id, missing: `${keyPath}.choices 或 ${keyPath}.source` })
      }
      out.choices = choices.map((c, i) => {
      // ⭐ 裸字符串/数字也收：`["natural","news"]` 折成 `{value,label}`。
      //   ⛔ 不收的代价不是「作者被教育了一下」，是他的名片装不上、
      //     报的还是一句「必须是一个对象」—— 而 choices 写一串字符串
      //     是每个人的第一直觉。平台是搬运工：能读懂的形状就读进来。
      //   ⚠ 归一化只发生在这一行，出口永远是 { value, label }。
      if (typeof c === 'string' || typeof c === 'number') {
        return { value: c, label: String(c) }
      }
      const item = plainObject(manifest, `${keyPath}.choices[${i}]`, c)
      if (!('value' in item)) {
        throw profileError('ENGINE_MANIFEST_INCOMPLETE',
          `引擎 ${manifest.id} 的 ${keyPath}.choices[${i}] 缺少 value`,
          { id: manifest.id, missing: `${keyPath}.choices[${i}].value` })
      }
      return { value: item.value, label: item.label || String(item.value) }
    })
      const values = out.choices.map(c => c.value)
      // ⚠ 只有「名片写死选项 + 单选 + 不重复」这一种情况才查得动。
      //   多选的 default 是数组、repeat 的 default 是一排、source 的选项要运行时
      //   扫盘才知道 —— 那几种在这儿查等于瞎猜。
      const checkable = !d.multi && repeat === 1
      if (checkable && Object.hasOwn(out, 'default') && !values.includes(out.default)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 ${keyPath}.default 是 ${JSON.stringify(out.default)}，` +
          '但它不在 choices 里 —— 界面会显示一个选不中的值。',
          { id: manifest.id, key: `${keyPath}.default`, value: out.default })
      }
    }
    // 多选一 / 多选多。⭐ 多选的值是数组，跟 repeat 不是一回事：
    //   multi   一个格子里勾好几项，几项由用户定（辅助参考音频挑 3 段）
    //   repeat  格子数由名片定死（情绪向量永远 8 维）
    if (d.multi === true) out.multi = true
  }

  if (type === 'number') {
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
    // ⭐⭐ min / max / step 到此为止只是**界面提示**（滑块画到哪、箭头跳多大）。
    //    平台**不拿它们当闸门**（契约 §5.5「平台是搬运工，不是翻译」）：这几个数
    //    是名片作者手抄上游文档抄来的，抄错一位就会拦住引擎其实能接受的值，而
    //    界面上看起来像「这台引擎不支持」—— 那是最难查的一种假象。
    //    真正该拒绝的是引擎，它比我们清楚自己能吃什么。
    //    判据：min=0 max=1 的格子填 5，请求体里就得是 5。
    if (d.unit !== undefined) out.unit = String(d.unit)
  }

  if (type === 'file') {
    // ⭐ file = custom file：用户自己指定、**平台不认识**的任意文件，没有候选列表。
    //   「从平台扫到的库里挑一个」不是这一种，那是 select + source。
    //   两者的区别就是**候选从哪来**（BrokerTab.jsx:53 的 custom 判据同义）。
    // ⛔ 这里不查文件在不在、不查后缀、不补默认路径 —— 平台不知道这个文件是什么。
    if (d.accept !== undefined) {
      if (!Array.isArray(d.accept) || d.accept.some(x => typeof x !== 'string')) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 ${keyPath}.accept 必须是字符串数组（如 [".wav",".mp3"]）`,
          { id: manifest.id, key: `${keyPath}.accept`, value: d.accept })
      }
      // ⚠ accept 只是文件选择框的过滤器，**不是校验**：用户绕过它填进来的
      //   路径照发不误，理由同上面 min/max 那段。
      out.accept = d.accept.slice()
    }
    // 这一格的值要不要求可移植（{base:'asset'} 那种，配方能带着走）。
    // 没写 = 不要求，接 lib/pathResolver.js 已有的外部路径权限。
    if (d.portable === true) out.portable = true
  }

  // tier：界面把参数分成「常用」和「高级」两屏。没写按 advanced ——
  // 少露一个格子比多露一个安全（多露的那个会被当成推荐设置）。
  out.tier = d.tier === 'common' ? 'common' : 'advanced'
  out.label = d.label && typeof d.label === 'object' ? d.label : { en: name, zh: name }
  if (d.help && typeof d.help === 'object') out.help = d.help

  // ---- 排版。⭐ 这三个字段是「勾选框一个在左上一个在右下」那条丑的根子：
  //      在它们之前，格子的位置完全由名片里的书写顺序 + CSS 两列网格决定，
  //      名片作者说不出「这两格是一伙的」「这格要占满一行」。
  //      ⛔ 它们只影响画在哪，不影响发什么。
  if (typeof d.group === 'string' && d.group) out.group = d.group
  if (d.order !== undefined && Number.isFinite(Number(d.order))) out.order = Number(d.order)
  if (d.width === 'full' || d.width === 'half') out.width = d.width

  // ---- only_when：这一格只在别的格子取某个值时才出现
  //      （emo_text 只在 use_emo_text 勾上时才有意义）。
  //
  // ⭐⭐ fail-open：引用了一个**不存在**的键，照常显示。
  //    这里的坏法不对称，跟 web/src/lib/engines.js 的 hasMappedKey 同一条理由：
  //      多画一格 = 跟今天一样，用户看到的东西没变；
  //      少画一格 = 一个本来能用的控件凭空消失，而且不报错，最难查。
  //    ⛔ 所以这里**只校验形状**（是个对象），不校验被引用的键存不存在 ——
  //      名片作者拼错一个键名，格子该长还得长。
  if (d.only_when !== undefined) {
    if (!d.only_when || typeof d.only_when !== 'object' || Array.isArray(d.only_when)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 ${keyPath}.only_when 必须是对象，形如 ` +
        '{ "别的参数名": 期望值 } 或 { "别的参数名": [值1, 值2] }',
        { id: manifest.id, key: `${keyPath}.only_when`, value: d.only_when })
    }
    out.only_when = { ...d.only_when }
  }

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
 * 权重位声明的 param（发给引擎时用的参数名）必须在 param_keys 里。
 *
 * ⭐ 跟上面 params.schema 那条守卫是**同一句话**：名片里两份名单一旦对不上，
 *   界面上就会出现一个发不出去的格子 —— 而且这一种更毒，因为用户会以为
 *   自己换了权重，声音却没变，不报任何错。
 *
 * ⚠ 不写 param 是合法的（= 这台引擎运行中换不了权重），这里只查写了的。
 */
// 换法只有两种，而且穷尽（Owner 2026-08-30 定案）。⛔ 不许有第三个值：
// 「一个进程同时挂几份」是引擎自己的容量，不是"送到哪一步"这件事。
const APPLIES_AT = Object.freeze(['launch', 'call'])

function checkSlotSwitching(manifest, slots) {
  for (const s of slots) {
    if (!APPLIES_AT.includes(s.applies_at)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的权重位 ${s.name} 写了 applies_at=${JSON.stringify(s.applies_at)}，` +
        `而这里只有两个值：${APPLIES_AT.join(' / ')} —— ` +
        '"launch" = 这一份是开进程那一步吃进去的（换一份要带着它重开一次），' +
        '"call" = 进程活着的时候一次调用就能换。不写的话平台按有没有 param 推。',
        { id: manifest.id, key: `weights.${s.name}.applies_at`, value: s.applies_at })
    }
    // 这两条是同一句话的正反面：一次调用能换 ⇔ 那一份有个参数名可以发出去。
    if (s.applies_at === 'call' && !s.param) {
      throw profileError('ENGINE_MANIFEST_INCOMPLETE',
        `引擎 ${manifest.id} 的权重位 ${s.name} 说自己一次调用就能换（applies_at=call），` +
        '却没说走哪个参数名 —— 平台不知道该把选中的那一份发到哪儿去，' +
        '结果会是「下拉能点、请求体里一个键都没有」。补上 param，或者改成 applies_at=launch。',
        { id: manifest.id, missing: `weights.${s.name}.param` })
    }
    if (s.applies_at === 'launch' && s.param) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的权重位 ${s.name} 说自己是开进程那一步吃进去的（applies_at=launch），` +
        `又写了 param=${s.param} —— 这个参数名永远不会被发出去。两句话只能留一句。`,
        { id: manifest.id, key: `weights.${s.name}.param`, value: s.param })
    }
  }
  return slots
}

const _hotSwapWarned = new Set()

/**
 * `capabilities.hot_swap_models` —— **已退休**（2026-08-30）。
 *
 * ⭐⭐⭐ 为什么非退不可：它是一个**引擎级的是非题**，回答的却是**每个模型位
 *   各自的事**。一台引擎两个位、一个能一次调用换掉、一个要开进程时吃进去，
 *   那一位没有正确答案 —— 而这正是 IndexTTS2「下拉能选、声音不变、还不报错」
 *   那个 bug 的根。同一件事现在写在位上（`weight_slots[].applies_at`），
 *   两种送法穷尽：`launch`（带着新的重开一次进程）/ `call`（发一次请求）。
 *
 * ⛔ 名片里还写着它 ⇒ **不报错、照装**。上游作者一行都不用改，这是硬约束。
 *   但也 ⛔ 不静默：每台引擎提醒一次（`_hotSwapWarned` 去重，否则每次解析
 *   名片都刷一行，日志会被淹掉、真正的报错反而看不见）。
 * ⚠ 这个字段从今往后**不参与任何判断** —— 读它的地方一个都不许再有。
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
        '但 param_keys 里没有这个键。选中的模型会被当成拼错的参数拦下 —— ' +
        '用户以为换了权重，声音却不变，这是最难查的一类 bug。' +
        '要么把这个键加进 param_keys，要么去掉 param（= 这台引擎换不了权重，' +
        '候选照样列出来给人看）。',
        { id: manifest.id, key: `weights.${s.name}.param` })
    }
  }
  return slots
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
  // 刀 B1：先查顶层拼写，再查内容。顺序是故意的 —— `max_char` 拼错了，
  // 报「顶层有个不认识的键 max_char，是不是想写 max_chars」，
  // ⛔ 而不是报「缺少 max_chars」，后者会让人去加第二个键。
  checkTopKeys(manifest)
  checkMeasuredSources(manifest)
  const caps = manifest.capabilities || {}
  retireHotSwap(manifest, caps)

  const { base_url, source, declared_base_url } = resolveBaseUrl(manifest, env)

  const timeout_ms = positiveInt(manifest, 'timeout_ms',
    required(manifest, 'timeout_ms', manifest.timeout_ms,
      '平台不知道一段合成等多久算超时（这个值按「每一段」计，不是整篇）'))

  const max_chars = positiveInt(manifest, 'max_chars',
    required(manifest, 'max_chars', manifest.max_chars,
      '平台不知道该把长文本切成多长一段（慢引擎必须调小，否则单段就撑爆超时）'))

  if (!('reference_clip_seconds' in caps)) {
    throw profileError('ENGINE_MANIFEST_INCOMPLETE',
      `引擎 ${manifest.id} 的 manifest.json 缺少 capabilities.reference_clip_seconds —— ` +
      '不限制请显式写 null。「忘了写」和「不限制」必须能区分开，' +
      '否则一个漏写会静默变成「什么参考音频都收」，等到合成失败才发现。',
      { id: manifest.id, missing: 'capabilities.reference_clip_seconds' })
  }

  // 先算出来：param_schema 的默认值要从这里取，不能再自备一份（C11）。
  const defaults = applyDefaultsEnv(manifest,
    plainObject(manifest, 'defaults', manifest.defaults),
    manifest.defaults_env, env)

  // 模型位要在 capabilities 之前算出来：引擎级那一位现在从它推。
  const weightSlots = checkSlotSwitching(manifest,
    checkSlotParams(manifest, normalizeWeightSlots(manifest.weights)))

  return {
    id: manifest.id,
    label: manifest.label || manifest.id,
    dir: manifest.dir,
    base_url,
    base_url_source: source,
    // 这台引擎听哪个环境变量报地址（名字，不是值）。名片没写就是 null。
    // ⭐ 交出「名字」而不只是读取结果，是为了让启动脚本能**写**它：
    //   起多台引擎时，每台的地址要各自设进各自的变量，脚本里不能写死
    //   GPT_SOVITS_BASE_URL —— 那是第二台引擎起不来的直接原因。
    // ⛔ 不是 base_url 的替代品：读地址仍然用 base_url，那边已经把
    //   env 覆盖算进去了。
    base_url_env: manifest.base_url_env || null,
    // 「这台引擎自己该监听哪儿」。launchPlan.js 用它算启动端口 ——
    // ⛔ 不能用上面那个 base_url，它可能是 env 指向的**别人家**的引擎。
    default_base_url: declared_base_url,
    timeout_ms,
    max_chars,
    // 硬上限 = 软上限 ×2，与 synthesisService 今天的算法一致，不是新规则。
    hard_max_chars: max_chars * 2,
    requires_reference_audio: requiredBool(manifest,
      'capabilities.requires_reference_audio', caps.requires_reference_audio,
      '平台不知道没有参考音频时该不该拦下来'),
    reference_clip_seconds: parseClipSeconds(manifest, caps.reference_clip_seconds),
    // ⛔ 这里原本有 hot_swap_models —— 2026-08-30 退休，见 retireHotSwap()。
    //   它今天由 weight_slots[].applies_at 逐位回答，⛔ 不再有引擎级的那一位。
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
    // ---- 第 2b 步：进程与环境的宿主。缺 = 这台引擎不由平台起（合法）------
    runtime: parseRuntime(manifest),
    // ---- 第 4 步（C10）：源码从哪来、钉在哪一版。缺 = null（合成不受影响）--
    // 严格检查在 tools/install-engine.cjs，理由见 parseUpstream 的注释。
    upstream: parseUpstream(manifest),
    // ---- 2026-08-29：底模从哪来、齐不齐。缺 = null（合成不受影响）---------
    // ⚠ 只是名片上"声明"的那部分。盘上到底有没有，是 lib/engines/checkpoints.js
    //   的活 —— 这里保持纯函数，不碰文件系统（同 installPlan 计划/执行分家）。
    models: parseModels(manifest),
    // ---- 2026-08-30：这台引擎要用户选几个权重、各叫什么 --------------------
    //
    // ⭐⭐ 名片里就写这一样，别的都不用写（Owner 定案）：
    //        "weights": ["gpt", "sovits"]     两个位
    //        "weights": 1                     一个位
    //   位置不用写（平台约定 assets/<角色>/models/<引擎id>/<位名>/），
    //   后缀不用写（平台不筛），版本不用写（平台不需要知道）。
    //
    // ⚠ 缺 = 空数组 = 「这台引擎不需要用户选模型」，**不是出错**：
    //   一台只有一个写死底模的引擎完全合法。⛔ 所以这里不 required()。
    //
    // ⭐ 一个位还可以带 param =「选中的那份用哪个参数名发给引擎」。
    //   不写 = 运行中换不了（候选照列，只是选择不发出去）。
    weight_slots: weightSlots,
  }
}

// parseParamSchema 单独导出，是为了让 C11 的那些「写重了/写漏了要抛」能被
// 直接测到：造假引擎得往 engines/ 里写目录，而那一层有目录清点守卫盯着。
module.exports = { resolveEngineProfile, parseParamSchema, parseRuntime, parseUpstream, parseModels }
