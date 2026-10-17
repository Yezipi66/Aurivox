'use strict'

// ---------------------------------------------------------------------------
// Engine profile — 把「名片上写的」翻成「合成路径能用的」
// ---------------------------------------------------------------------------
// 连哪台、等多久、切多长、参考音频多长、要不要换权重、采样率，
// 这些的唯一来源是 engines/<id>/manifest.json。lib/ 下不再有
// 任何一个具体引擎的默认值，这就是「加引擎不改代码」的字面意思。
// 本文件里不允许出现任何具体引擎的名字（和 registry.js 同一条纪律，
// profile.node.test.js 里有一条守卫盯着）。一旦为了图快写 if (id==='xxx')，
// 那台引擎的特殊性就永久留在了平台层，下一个人只会照抄。

const { requireEngine } = require('./registry')
// 权重位的规整规则跟磁盘约定住在一起（lib/assets/modelLayout.js）
// 「名片声明了几个位」和「那几个位在盘上叫什么目录」必须是同一处答案，
// 分成两处的那天就是它们漂开的那天。
const { normalizeWeightSlots } = require('../assets/modelLayout')
// 字段原语拆到 lib/engines/profile/fields.js：缺字段报错、形状规整、路径相对性。
const {
  profileError, required, positiveInt, requiredBool,
  parseClipSeconds, plainObject, stringArray, relPath,
} = require('./profile/fields')
// 「怎么调用」与「权重位切换」拆到 lib/engines/profile/maps.js。
const {
  parseMethods, parseMaps, checkSlotSwitching, retireHotSwap, checkSlotParams,
} = require('./profile/maps')
// 底模（models）与上游来源（upstream）拆到 lib/engines/profile/models.js。
const { parseModels, parseUpstream } = require('./profile/models')
// 顶层键白名单与 _source 出处守卫拆到 lib/engines/profile/topkeys.js。
const { checkTopKeys, checkMeasuredSources } = require('./profile/topkeys')
// 参数表（params.schema / defaults_env）拆到 lib/engines/profile/paramSchema.js。
const { parseParamSchema, applyDefaultsEnv } = require('./profile/paramSchema')

// 环境变量覆盖：由名片自己指定变量名，平台不认识任何具体的变量名。
// 这是为了让 GPT_SOVITS_BASE_URL 这种环境变量继续工作，同时不把
// 「GPT_SOVITS」这几个字写进 lib/。名片说「我听 XXX 这个变量」，平台才去读。
// 下游引擎想要同样的能力，写一行 base_url_env 就有，不用求我们改代码。
// 返回值里有两个地址，它们回答两个不同的问题：
// base_url          「合成请求发到哪儿」（连）：会被 base_url_env 顶掉。
// default_base_url  「这台引擎自己该监听哪儿」（听）：永远是名片声明的
// 那个，env 顶不动它。
// 两者必须分开，否则把 GPT_SOVITS_BASE_URL 指向一台远程引擎的人，
// 会在本地起出一台监听远程端口号的引擎。
function resolveBaseUrl(manifest, env) {
  // 故意不走 required()：base_url_env 命中时保持宽松（那条路径
  // 本来就不读 default_base_url），免得给一批只关心地址的调用方新增一个抛点。
  // default_base_url 变成可选：不再用 required()
  // 把它拦下来。理由：契约 §5.9 明写「端口是运输不是管理」，平台负责给由它
  // 启动的引擎分配端口，不该让名片作者写下「我该监听 9880」这种运输细节。
  // 名片没写 default_base_url 时，declared_base_url = null，base_url 也是
  // null：这台引擎的「连」地址由 platform 在 buildLaunchPlan({ port }) 那
  // 一步决定（平台分配端口 → 写进 base_url_env），而不是在名片解析这一步猜。
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
  // 不再 required()：没写 = null，交给平台（见上面）。
  const declared = declared_base_url
  return {
    base_url: declared == null ? null : String(declared).replace(/\/+$/, ''),
    source: declared == null ? 'platform' : 'manifest',
    declared_base_url,
  }
}

// ---------------------------------------------------------------------------
// runtime，这台引擎的进程长什么样
// ---------------------------------------------------------------------------
// manifest.runtime 必须是有消费者的数据（契约 v2 §5.1）：全平台 grep 不到任何人读它，
// 就等于写错了也没人发现（真出现过：engines/indextts2/manifest.json 把
// 路径写成 `.../venv/Scripts/python.exe`，少了一个点，`.venv`）。
// 平台在这一段上的立场：只验不建。
// 平台不给任何引擎装环境、不装包、不管版本。它只做两件事：
// 1) 核对名片说的那个解释器/模块/类/方法在不在（本段 + envCheck.js）
// 2) 按名片起进程、轮询 ready（supervisor）
// 核对不过 = 这台引擎没装。平台不代劳，也不背书。
// 不认识的键要抛错，不能默默忽略：`ready_endoint` 这种拼写错误如果被
// 静默吃掉，表现是"轮询永远超时"，而名片看上去完全正常。
const RUNTIME_KEYS = Object.freeze([
  'python', 'entry', 'args', 'cwd', 'checkpoints',
  'ready_endpoint', 'ready_timeout_ms', 'ready_timeout_ms_source', 'preload', 'verify',
])

const VERIFY_IMPORT_KEYS = Object.freeze(['module', 'class', 'methods', 'init_params'])

function parseVerify(manifest, value) {
  if (value === undefined || value === null) return null
  const v = plainObject(manifest, 'runtime.verify', value)

  const sysPath = stringArray(manifest, 'runtime.verify.sys_path', v.sys_path)
    .map((p, i) => relPath(manifest, `runtime.verify.sys_path[${i}]`, p))

  const rawImports = v.imports
  if (!Array.isArray(rawImports) || rawImports.length === 0) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 写了 runtime.verify 却没写 runtime.verify.imports` +
      '一条都不检查的校验等于没有校验，那还不如整段不写。',
      { id: manifest.id, key: 'runtime.verify.imports', value: rawImports })
  }

  const imports = rawImports.map((raw, i) => {
    const item = plainObject(manifest, `runtime.verify.imports.${i}`, raw)
    for (const k of Object.keys(item)) {
      if (!VERIFY_IMPORT_KEYS.includes(k)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 runtime.verify.imports.${i} 上有平台不认识的键 ${k}` +
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
    // 方法名/构造参数名都是挂在类上的，没有类就无处可挂：写了却没写 class
    // 是名片作者漏了一行，静默忽略会让"我明明写了要检查 infer"变成一句空话。
    if (!cls && (methods.length || initParams.length)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 runtime.verify.imports.${i} 写了 methods/init_params 却没写 class` +
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
  // 这是合法状态，不报错，但它同时意味着平台没法校验它，
  // 界面上要能看出这个区别，所以返回 null 而不是空对象。
  if (raw === undefined || raw === null) return null
  const r = plainObject(manifest, 'runtime', raw)

  for (const k of Object.keys(r)) {
    if (!RUNTIME_KEYS.includes(k)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 manifest.json 里 runtime.${k} 平台不认识` +
        `认识的只有 ${RUNTIME_KEYS.join(' / ')}。` +
        '通常是拼写错误（拼写错误被静默忽略，表现是"平台反复查询却一直等到超时"而 manifest.json 看着完全正常）。',
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

/**
 * 读一张名片，产出合成路径要用的东西。缺一项就抛，不猜。
 *
 * @param {string} id     引擎目录名 = 引擎 id
 * @param {object} [env]  环境变量表（测试用），默认 process.env
 * @throws FG_ENGINE_UNSUPPORTED / ENGINE_MANIFEST_INCOMPLETE / ENGINE_MANIFEST_INVALID_VALUE
 */
function resolveEngineProfile(id, env = process.env) {
  const manifest = requireEngine(id)          // 没装这个引擎 ⇒ FG_ENGINE_UNSUPPORTED
  // 先查顶层拼写，再查内容。顺序是故意的：`max_char` 拼错了，
  // 报「顶层有个不认识的键 max_char，是不是想写 max_chars」，
  // 而不是报「缺少 max_chars」，后者会让人去加第二个键。
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
      `引擎 ${manifest.id} 的 manifest.json 缺少 capabilities.reference_clip_seconds` +
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

  // ---- 一次请求一个方法，界面上要有个下拉 ------------------------------
  // 这段不是给引擎进程读的（那条路是 hostProfile.js，写盘给 host.py），
  // 是给 /api/engines 用的：界面靠它画「这次走哪个推理方法」。
  // 过去它一个字都没交，于是界面上一个方法都选不到。
  // 单方法引擎（没写 call.methods）⇒ methods: null，不是 []。
  // [] 的意思是「声明了但空的」（当场抛），null 是「这台引擎就一个入口」。
  // 这两种在界面上画出来的东西不一样，不能混。
  const call = plainObject(manifest, 'call', manifest.call)
  const { methods, default_method: defaultMethod } = call.methods
    ? parseMethods(manifest, call)
    : { methods: null, default_method: null }

  return {
    id: manifest.id,
    label: manifest.label || manifest.id,
    dir: manifest.dir,
    base_url,
    base_url_source: source,
    // 这台引擎听哪个环境变量报地址（名字，不是值）。名片没写就是 null。
    // 交出「名字」而不只是读取结果，是为了让启动脚本能写它：
    // 起多台引擎时，每台的地址要各自设进各自的变量，脚本里不能写死
    // GPT_SOVITS_BASE_URL：那是第二台引擎起不来的直接原因。
    // 不是 base_url 的替代品：读地址仍然用 base_url，那边已经把
    // env 覆盖算进去了。
    base_url_env: manifest.base_url_env || null,
    // 「这台引擎自己该监听哪儿」。launchPlan.js 用它算启动端口
    // 不能用上面那个 base_url，它可能是 env 指向的别人家的引擎。
    default_base_url: declared_base_url,
    timeout_ms,
    max_chars,
    // 硬上限 = 软上限 ×2，与 synthesisService 今天的算法一致，不是新规则。
    hard_max_chars: max_chars * 2,
    requires_reference_audio: requiredBool(manifest,
      'capabilities.requires_reference_audio', caps.requires_reference_audio,
      '平台不知道没有参考音频时该不该拦下来'),
    reference_clip_seconds: parseClipSeconds(manifest, caps.reference_clip_seconds),
    // hot_swap_models 已退休，见 retireHotSwap()：
    // 它今天由 weight_slots[].applies_at 逐位回答， 不再有引擎级的那一位。
    output_sample_rate: positiveInt(manifest, 'capabilities.output_sample_rate',
      required(manifest, 'capabilities.output_sample_rate', caps.output_sample_rate,
        '平台生成段间静音和做拼接时要用它；猜错了会得到变调或长度不匹配的静音')),
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
    // ---- 界面上「这次走哪个推理方法」要用的那两个 ---------------------
    // 交的是名字列表，不是方法配置：界面只需要画一个下拉 + 知道默认
    // 选哪个，方法内部怎么绑参数、要不要参考音频，那是拼请求体的事
    // （lib/engines/payload.js + host.py 的 resolve_method）。
    // 别把 call.methods 整个透出去：那是宿主契约，前端碰它就成了
    // 第二份「方法有哪些」的事实。
    methods,
    default_method: defaultMethod,
    // ---- 第 2b 步：进程与环境的宿主。缺 = 这台引擎不由平台起（合法）------
    runtime: parseRuntime(manifest),
    // ---- 第 4 步（C10）：源码从哪来、钉在哪一版。缺 = null（合成不受影响）--
    // 严格检查在拉源码那一侧（tools/engine-wizard/core/），理由见 parseUpstream 的注释。
    upstream: parseUpstream(manifest),
    // ---- 底模从哪来、齐不齐。缺 = null（合成不受影响）-----------------
    // 只是名片上"声明"的那部分。盘上到底有没有，是 lib/engines/checkpoints.js
    // 的活，这里保持纯函数，不碰文件系统（同 launchPlan.js 计划/执行分家）。
    models: parseModels(manifest),
    // ---- 这台引擎要用户选几个权重、各叫什么 --------------------------
    // 名片里就写这一样，别的都不用写：
    // "weights": ["gpt", "sovits"]     两个位
    // "weights": 1                     一个位
    // 位置不用写（平台约定 assets/<角色>/models/<引擎id>/<位名>/），
    // 后缀不用写（平台不筛），版本不用写（平台不需要知道）。
    // 缺 = 空数组 = 「这台引擎不需要用户选模型」，不是出错：
    // 一台只有一个写死底模的引擎完全合法。 所以这里不 required()。
    // 一个位还可以带 param =「选中的那份用哪个参数名发给引擎」。
    // 不写 = 运行中换不了（候选照列，只是选择不发出去）。
    weight_slots: weightSlots,
  }
}

// parseParamSchema 单独导出，是为了让 C11 的那些「写重了/写漏了要抛」能被
// 直接测到：造假引擎得往 engines/ 里写目录，而那一层有目录清点守卫盯着。
module.exports = { resolveEngineProfile, parseParamSchema, parseRuntime, parseUpstream, parseModels }
