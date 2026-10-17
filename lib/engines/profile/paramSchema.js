'use strict'

// ---------------------------------------------------------------------------
// params.schema：契约 §5.4「每个参数长什么样」
// ---------------------------------------------------------------------------
// 同一张参数表在项目里只能存在一份（契约 §8:590「参数表只有一份」），否则两份会各自漂移：
// engines/gpt-sovits/manifest.json   param_keys + defaults（键名、默认值）
// web/.../GenerateTab.jsx            19 个 useState + 两块 form-grid
// （控件类型、min/max/step、分层、标签，
// 以及第二份默认值）
// 漂移不会报错，只会表现为「说明书写的和界面上的不一样」。实测已经漂了一处：
// batch_size 名片写 4（profile.js 那段注释说明这是我们自己的调优决策，
// 还配了 AURIVOX_TTS_BATCH_SIZE 旋钮），而前端写死 1 且无条件发出去
// 那个 4 和那个旋钮在 webui 路径上从来没生效过，而且不会有任何日志提到它。
// 平台不认识这里的任何一个参数名，这是契约 §5.5 明写的：
// 「平台只知道『有一个数字参数，范围 0 到 1，界面上叫情绪强度』，
// 至于它是什么意思，平台不需要知道，也不应该知道。」
// 所以下面这个函数里不许出现任何具体参数名：与文件顶部那条
// 「不许出现引擎名」是同一条纪律，profile.node.test.js 有守卫盯着。

const { plainObject, profileError } = require('./fields')

// defaults_env：让名片自己声明「哪个环境变量能顶掉我的某个默认值」。
// 存在的理由不是对称好看：batch_size 的默认值
// 不是引擎的默认值，是平台自己的调优决策（4），并留了
// AURIVOX_TTS_BATCH_SIZE 这个旋钮给低显存显卡降回 1。丢掉旋钮，该机上的
// 显存就会在某一天悄悄不够用，而且不会报任何错。
// 写法：{ "<引擎键名>": { "var": "环境变量名", "type": "int", "min": 1, "max": 16 } }
// 取值不合法（不是整数 / 越界）⇒ 回落名片里的值，与 parseInt 那一段
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

// 'path' 是五种里唯一的文件型，理由值得写下来：
// 有了它，一台引擎在 manifest 里能说「我有一个参数，它的值是个文件」。
// 于是 GPT-SoVITS 的两个权重当年只能在参数表之外另开一套：抬成 recipe 的
// 顶层字段（gpt_ckpt / sovits_pth），再由前端 5 个文件各画一遍「GPT 槽 +
// SoVITS 槽」。结果就是平台被迫认识「什么是权重、有几个、怎么配对」,
// 而 IndexTTS2 根本没有这个概念。
// 加上这一种之后，权重不再是平台的一个概念，只是袋子里一个值是路径的参数：
// 有几个、叫什么，那台引擎自己在 params.schema 里说；一个都不写就一个格子
// 都不长；用户没填就不发（payload 那边空值本来就不进请求体）。
// 平台对 'path' 只多做一件事：它的值是平台托管的路径，交给 pathResolver
// 解析（值的形状是 {base:'asset'|'external', path} 或裸字符串，pathResolver
// 本来就按形状工作、不认字段名）。 除此之外不校验：不查文件在不在、
// 不查后缀、不填默认路径。
// 收口成五种预设样式（文本 / 数字 / 下拉 /
// 勾选 / 路径）+ 一个正交修饰 repeat。定义搬到 lib/engines/paramTypes.js，
// 那里写着为什么 enum→select、path→file、integer 折进 number。
// 这里不再自己列一份类型表：列第二份就是 C11 要杀的东西。
const {
  PARAM_TYPES, SELECT_SOURCES, canonicalType, isIntFlavor, repeatOf,
} = require('../paramTypes')
const { hasDerivedParameters } = require('../parameterDeclaration')

function schemaEntry(manifest, name, raw, defaults) {
  const keyPath = `params.schema.${name}`
  const d = plainObject(manifest, keyPath, raw)

  // 默认值有且只有一处，但可以是两处之一：因为这两处语义不同：
  // defaults.<键>                「每次合成都发这个值」，界面开没开都发
  // params.schema.<键>.default   「界面格子的初值」，不因此多发一个键
  // 这个区分不是设计洁癖，是被 lib/engines/payload.node.test.js 的 7 条
  // 黄金样本逼出来的：把 sample_steps / if_sr / overlap_length /
  // min_chunk_length 写进 defaults 之后，OpenAI 兼容口和 Flow 这些从来
  // 没发过它们的路径凭空多了 4 个键。那是行为变更，不是重构。
  // 两处都写 = C11 说的那种会各自漂移的副本 ⇒ 当场抛。两处都不写 = 界面
  // 只能自己编一个初值 ⇒ 也当场抛。
  const inDefaults = name in defaults
  const inSchema = 'default' in d
  if (inDefaults && inSchema) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 ${name} 在 defaults 和 ${keyPath}.default 里各写了一个默认值` +
      '只能二选一：每次都发写 defaults，只是界面初值写 schema.default。' +
      '两处都写会各自漂移，而漂移不报错（契约 C11：参数表只有一份）。',
      { id: manifest.id, key: `${keyPath}.default` })
  }
  if (!inDefaults && !inSchema && !hasDerivedParameters(manifest)) {
    throw profileError('ENGINE_MANIFEST_INCOMPLETE',
      `引擎 ${manifest.id} 的 params.schema 描述了 ${name}，却没人给它默认值` +
      `请写 defaults.${name}（每次都发）或 ${keyPath}.default（只是界面初值）。` +
      '不写的话界面只能自己编一个，那就又多出一份副本（契约 C11）。',
      { id: manifest.id, missing: `defaults.${name} 或 ${keyPath}.default` })
  }

  const type = canonicalType(d.type)
  if (!type) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 ${keyPath}.type 必须是 ${PARAM_TYPES.join(' / ')} 之一，` +
      `现在写的是 ${JSON.stringify(d.type)}：界面靠它决定长出哪种控件。` +
      '（老写法 integer / enum / path / string 仍然收，会折进上面五种。）',
      { id: manifest.id, key: `${keyPath}.type`, value: d.type })
  }

  // defaults 优先（它已经过 defaults_env 解析 ⇒ AURIVOX_* 旋钮拧了，界面
  // 初值会跟着动，而不是像今天这样被前端写死的那个数盖掉）。
  // sends_always 已退役（f68421f）：未触碰的 UI 建议值不再跨越引擎边界，
  // 只有 touchedParams 记录过的键才发送。defaults 里的值仍由后端
  // synthesisService.js 的 engineKnobs 循环填入 payload，前端不再需要
  // 知道「哪些键平台会替你填」：它只管「用户动过哪些」。
  const out = { name, type }
  const lifecycle = manifest.params || {}
  const loadTime = Array.isArray(lifecycle.load_time) ? lifecycle.load_time : []
  out.phase = loadTime.includes(name) ? 'load' : 'call'
  if (inDefaults || inSchema) out.default = inDefaults ? defaults[name] : d.default
  // 「是不是整数」不是一种样式，是数字的一味。保留是因为收取侧要 parseInt
  // 不保留就会把 7.5 悄悄发给一个只吃整数的引擎，而那不报错。
  if (isIntFlavor(d.type)) out.int = true

  // repeat：正交修饰，不是第六种类型。八维情绪向量 = number × repeat 8。
  // 不写 / 写 1 ⇒ 标量，不是长度 1 的数组：「一格」和「一格但装在
  // 数组里」发给引擎是两件事，而这个差别一路都不报错。
  const repeat = repeatOf(d)
  if (d.repeat !== undefined && repeatOf(d) === 1 && Number(d.repeat) !== 1) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 ${keyPath}.repeat 必须是 ≥1 的整数，` +
      `现在写的是 ${JSON.stringify(d.repeat)}`,
      { id: manifest.id, key: `${keyPath}.repeat`, value: d.repeat })
  }
  if (repeat > 1) {
    out.repeat = repeat
    // 默认值必须自己就是一排。 不替名片把标量摊成 N 份：那样「八维默认全 0.5」
    // 和「作者只写了一维」在界面上长得一模一样，而后者是个错。
    if (!Array.isArray(out.default) || out.default.length !== repeat) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 ${name} 声明了 repeat=${repeat}（界面长 ${repeat} 格），` +
        `默认值就必须是长度 ${repeat} 的数组，现在是 ${JSON.stringify(out.default)}。` +
        ' 平台不替你把一个数摊成一排：那样「默认全都是它」和「你只写了一维」' +
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
    // 选项两种来源， 二选一。两个都写 = 界面不知道听谁的，而它会默默
    // 挑一个：那正是 C11 说的那种会各自漂移的副本。
    const hasChoices = d.choices !== undefined
    const hasSource = d.source !== undefined
    if (hasChoices && hasSource) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 ${keyPath} 同时写了 choices 和 source：只能二选一：` +
        '选项写死在名片里用 choices，选项要平台运行时扫盘才知道用 source。',
        { id: manifest.id, key: `${keyPath}.source` })
    }
    if (hasSource) {
      if (!SELECT_SOURCES.includes(d.source)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 ${keyPath}.source 必须是 ${SELECT_SOURCES.join(' / ')} 之一，` +
          `现在写的是 ${JSON.stringify(d.source)}：它说的是「选项从平台的哪个库里扫」。`,
          { id: manifest.id, key: `${keyPath}.source`, value: d.source })
      }
      out.source = d.source
      // 库里没有想要的那个时，让不让用户自己指一个文件。
      // 默认 false：替引擎规定「文件只能放我们指定的地方」是错的，但默认
      // 放开又会让「库里应该有却没扫到」这种坏法穿过去不报警。名片说了算。
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
      // 裸字符串/数字也收：`["natural","news"]` 折成 `{value,label}`。
      // 不收的代价不是「作者被教育了一下」，是他的名片装不上、
      // 报的还是一句「必须是一个对象」：而 choices 写一串字符串
      // 是每个人的第一直觉。平台是搬运工：能读懂的形状就读进来。
      // 归一化只发生在这一行，出口永远是 { value, label }。
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
      // 只有「名片写死选项 + 单选 + 不重复」这一种情况才查得动。
      // 多选的 default 是数组、repeat 的 default 是一排、source 的选项要运行时
      // 扫盘才知道：那几种在这儿查等于瞎猜。
      const checkable = !d.multi && repeat === 1
      if (checkable && Object.hasOwn(out, 'default') && !values.includes(out.default)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 ${keyPath}.default 是 ${JSON.stringify(out.default)}，` +
          '但它不在 choices 里：界面会显示一个选不中的值。',
          { id: manifest.id, key: `${keyPath}.default`, value: out.default })
      }
    }
    // 多选一 / 多选多。 多选的值是数组，跟 repeat 不是一回事：
    // multi   一个格子里勾好几项，几项由用户定（辅助参考音频挑 3 段）
    // repeat  格子数由名片定死（情绪向量永远 8 维）
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
    // min / max / step 到此为止只是界面提示（滑块画到哪、箭头跳多大）。
    // 平台不拿它们当闸门（契约 §5.5「平台是搬运工，不是翻译」）：这几个数
    // 是名片作者手动抄录上游文档而来，抄录错误一位就会拦住引擎能接受的值，而
    // 界面上看起来像「这台引擎不支持」：那是最难查的一种假象。
    // 真正该拒绝的是引擎，它比我们清楚自己能吃什么。
    // 判据：min=0 max=1 的格子填 5，请求体里就得是 5。
    if (d.unit !== undefined) out.unit = String(d.unit)
  }

  if (type === 'file') {
    // file = custom file：用户自己指定、平台不认识的任意文件，没有候选列表。
    // 「从平台扫到的库里挑一个」不是这一种，那是 select + source。
    // 两者的区别就是候选从哪来（BrokerTab.jsx:53 的 custom 判据同义）。
    // 这里不查文件在不在、不查后缀、不补默认路径：平台不知道这个文件是什么。
    if (d.accept !== undefined) {
      if (!Array.isArray(d.accept) || d.accept.some(x => typeof x !== 'string')) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 ${keyPath}.accept 必须是字符串数组（如 [".wav",".mp3"]）`,
          { id: manifest.id, key: `${keyPath}.accept`, value: d.accept })
      }
      // accept 只是文件选择框的过滤器，不是校验：用户绕过它填进来的
      // 路径照发不误，理由同上面 min/max 那段。
      out.accept = d.accept.slice()
    }
    // 这一格的值要不要求可移植（{base:'asset'} 那种，配方能带着走）。
    // 没写 = 不要求，接 lib/pathResolver.js 已有的外部路径权限。
    if (d.portable === true) out.portable = true
  }

  // tier：界面把参数分成「常用」和「高级」两屏。没写按 advanced
  // 少露一个格子比多露一个安全（多露的那个会被当成推荐设置）。
  out.tier = d.tier === 'common' ? 'common' : 'advanced'
  out.label = d.label && typeof d.label === 'object' ? d.label : { en: name, zh: name }
  if (d.help && typeof d.help === 'object') out.help = d.help

  // ---- 排版。 这三个字段是「勾选框一个在左上一个在右下」那条丑的根子：
  // 在它们之前，格子的位置完全由名片里的书写顺序 + CSS 两列网格决定，
  // 名片作者说不出「这两格是一伙的」「这格要占满一行」。
  // 它们只影响画在哪，不影响发什么。
  if (typeof d.group === 'string' && d.group) out.group = d.group
  if (d.order !== undefined && Number.isFinite(Number(d.order))) out.order = Number(d.order)
  if (d.width === 'full' || d.width === 'half') out.width = d.width

  // ---- only_when：这一格只在别的格子取某个值时才出现
  // （emo_text 只在 use_emo_text 勾上时才有意义）。
  // fail-open：引用了一个不存在的键，照常显示。
  // 这里的坏法不对称，跟 web/src/lib/engines.js 的 hasMappedKey 同一条理由：
  // 多画一格 = 跟今天一样，用户看到的东西没变；
  // 少画一格 = 一个本来能用的控件凭空消失，而且不报错，最难查。
  // 所以这里只校验形状（是个对象），不校验被引用的键存不存在
  // 名片作者拼错一个键名，格子该长还得长。
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

// 返回数组而不是对象：界面要按声明顺序渲染，而 JSON 对象的键序
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
    // 已经开始漂了：正是 C11 要防的那件事，当场拦下。
    if (known.length && !known.includes(name)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 params.schema 里有 ${name}，但 param_keys 里没有它。` +
        'schema 只负责描述「这个参数长什么样」，不负责声明「有这个参数」；' +
        '两份名单一旦不一致，界面上就会出现一个发不出去的格子。',
        { id: manifest.id, key: `params.schema.${name}` })
    }
    return schemaEntry(manifest, name, schema[name], defaults)
  })
}

module.exports = { schemaEntry, parseParamSchema, applyDefaultsEnv }
