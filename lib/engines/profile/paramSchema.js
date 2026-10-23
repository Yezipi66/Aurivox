'use strict'

// params.schema：「每个参数长什么样」。同一张参数表在项目里只能有一份，
// 两份会各自漂移而漂移不报错。平台只搬运、不认识这里的任何一个参数名，
// 所以本文件不许出现具体参数名。

const { plainObject, profileError } = require('./fields')

// defaults_env：让名片自己声明「哪个环境变量能顶掉我的某个默认值」。那些默认值是平台的调优决策，
// 并留了环境变量旋钮给低显存显卡降回去；丢掉旋钮，显存会在某一天悄悄不够用，且不报错。
// 写法：{ "<引擎键名>": { "var": "环境变量名", "type": "int", "min": 1, "max": 16 } }
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

// 五种预设样式（文本 / 数字 / 下拉 / 勾选 / 路径）+ 一个正交修饰 repeat。
// 类型表定义在 lib/engines/paramTypes.js，这里不再列一份：第二份会和它各自漂移。
// 'file' 的值交给 pathResolver 解析（{base:'asset'|'external', path} 或裸字符串）；
// 不查文件在不在、不查后缀、不填默认路径。
const {
  PARAM_TYPES, SELECT_SOURCES, canonicalType, isIntFlavor, repeatOf,
} = require('../paramTypes')
const { hasDerivedParameters } = require('../parameterDeclaration')

function schemaEntry(manifest, name, raw, defaults) {
  const keyPath = `params.schema.${name}`
  const d = plainObject(manifest, keyPath, raw)

  // 默认值有且只有一处，两处语义不同，只能二选一：
  //   defaults.<键>              「每次合成都发这个值」，界面开没开都发
  //   params.schema.<键>.default  「界面格子的初值」，不因此多发一个键
  // 两处都写会成为各自漂移的副本，两处都不写则界面只能自己编一个：两种都当场抛。
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

  // defaults 优先（它已经过 defaults_env 解析 ⇒ 环境变量旋钮拧了，界面初值会跟着动）。
  // 未触碰的 UI 建议值不跨越引擎边界：只有 touchedParams 记录过的键才发送。
  const out = { name, type }
  const lifecycle = manifest.params || {}
  const loadTime = Array.isArray(lifecycle.load_time) ? lifecycle.load_time : []
  out.phase = loadTime.includes(name) ? 'load' : 'call'
  if (inDefaults || inSchema) out.default = inDefaults ? defaults[name] : d.default
  // 「是不是整数」不是一种样式，是数字的一味：不保留就会把 7.5 悄悄发给只吃整数的引擎。
  if (isIntFlavor(d.type)) out.int = true

  // repeat：正交修饰，不是第六种类型。八维情绪向量 = number × repeat 8。
  // 不写 / 写 1 ⇒ 标量，不是长度 1 的数组：「一格」和「一格但装在数组里」发给引擎是两件事。
  const repeat = repeatOf(d)
  if (d.repeat !== undefined && repeatOf(d) === 1 && Number(d.repeat) !== 1) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 ${keyPath}.repeat 必须是 ≥1 的整数，` +
      `现在写的是 ${JSON.stringify(d.repeat)}`,
      { id: manifest.id, key: `${keyPath}.repeat`, value: d.repeat })
  }
  if (repeat > 1) {
    out.repeat = repeat
    // 默认值必须自己就是一排：不替名片把标量摊成 N 份，否则「默认全都是它」和「只写了一维」长得一样。
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
    // 选项两种来源，二选一。两个都写 = 界面不知道听谁的，而它会默默挑一个。
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
      // 库里没有想要的那个时，让不让用户自己指一个文件。默认 false：替引擎规定
      // 「文件只能放我们指定的地方」是错的，但默认放开又会让「库里应该有却没扫到」穿过去不报警。
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
      // 裸字符串/数字也收：`["natural","news"]` 折成 `{value,label}`。写一串字符串是第一直觉，
      // 不收的话名片装不上，报的还是一句「必须是一个对象」。归一化只发生在这一行。
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
      // 只有「名片写死选项 + 单选 + 不重复」这一种情况才查得动，其余几种在这儿查等于瞎猜。
      const checkable = !d.multi && repeat === 1
      if (checkable && Object.hasOwn(out, 'default') && !values.includes(out.default)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 ${keyPath}.default 是 ${JSON.stringify(out.default)}，` +
          '但它不在 choices 里：界面会显示一个选不中的值。',
          { id: manifest.id, key: `${keyPath}.default`, value: out.default })
      }
    }
    // 多选的值是数组，跟 repeat 不是一回事：multi 的项数由用户定，repeat 的格数由名片定死。
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
    // min / max / step 到此为止只是界面提示（滑块画到哪、箭头跳多大），平台不拿它们当闸门：
    // 它们是名片作者抄录上游文档而来，抄错一位就会拦住引擎能接受的值，
    // 而界面上看起来像「这台引擎不支持」。判据：min=0 max=1 的格子填 5，请求体里就得是 5。
    if (d.unit !== undefined) out.unit = String(d.unit)
  }

  if (type === 'file') {
    // file = 用户自己指定、平台不认识的任意文件，没有候选列表（从平台扫到的库里挑是 select + source）。
    // 这里不查文件在不在、不查后缀、不补默认路径。
    if (d.accept !== undefined) {
      if (!Array.isArray(d.accept) || d.accept.some(x => typeof x !== 'string')) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 ${keyPath}.accept 必须是字符串数组（如 [".wav",".mp3"]）`,
          { id: manifest.id, key: `${keyPath}.accept`, value: d.accept })
      }
      // accept 只是文件选择框的过滤器，不是校验：用户绕过它填进来的路径照发不误。
      out.accept = d.accept.slice()
    }
    // 这一格的值要不要可移植（{base:'asset'} 那种，配方能带着走）。没写 = 不要求，接 pathResolver 的外部路径权限。
    if (d.portable === true) out.portable = true
  }

  // tier：界面把参数分成「常用」和「高级」两屏。没写按 advanced：少露一个格子比多露一个安全。
  out.tier = d.tier === 'common' ? 'common' : 'advanced'
  out.label = d.label && typeof d.label === 'object' ? d.label : { en: name, zh: name }
  if (d.help && typeof d.help === 'object') out.help = d.help

  // group / order / width 只影响格子画在哪，不影响发什么。
  if (typeof d.group === 'string' && d.group) out.group = d.group
  if (d.order !== undefined && Number.isFinite(Number(d.order))) out.order = Number(d.order)
  if (d.width === 'full' || d.width === 'half') out.width = d.width

  // only_when：这一格只在别的格子取某个值时才出现。fail-open：引用了不存在的键照常显示。
  // 少画一格 = 一个本来能用的控件凭空消失且不报错，最难查，所以只校验形状，不校验被引用的键。
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

// 返回数组而不是对象：界面要按声明顺序渲染，而 JSON 对象的键序在 JSON.parse 往返后不保证还在。
function parseParamSchema(manifest, defaults) {
  const params = manifest.params
  if (params === undefined || params === null) return []
  const p = plainObject(manifest, 'params', params)
  if (p.schema === undefined || p.schema === null) return []
  const schema = plainObject(manifest, 'params.schema', p.schema)

  const known = manifest.param_keys || []
  return Object.keys(schema).map(name => {
    // 只描述、不声明：schema 里冒出一个 param_keys 没有的名字，说明两处已经开始漂了，当场拦下。
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
