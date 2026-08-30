// ============================================================
//  引擎列表 + 参数面板的数据层（契约 §12 第 3 步）
// ============================================================
//
// 这个文件回答一件事：**界面上该长出什么，全部由 manifest.json 决定。**
//
// 在它出现之前，`/api/engines` 已经把两台引擎的完整 param_schema 吐出来了，
// 而 web/src 里 `api/engines` 出现 **0 次** —— 后端算好的东西没有任何消费者，
// 界面上那排滑块是手写死的 GPT-SoVITS 参数（GenerateTab.jsx:127 起的
// temperature / top_k / top_p …）。契约 §9 把这类叫「名片里已经写好、但平台
// 还没读的字段」。
//
// ⛔ 本文件里不允许出现任何具体引擎的名字、参数名、参数个数。
//    规矩同 lib/engines/registry.js 和 lib/routes/engines.js，下面有守卫测试盯着。
//    判据很简单：**装一台谁都没见过的引擎，这里的代码一个字都不用改。**
//
// ⚠ 为什么这些函数全是纯函数、不碰 React：
//    这个仓库跑单元测试的环境里没有 jsdom（web/package.json 声明了，但测试
//    是 `node --test` 直接跑的，不经过 vite），JSX 渲染不了。把「界面长什么样」
//    的判断全部挪进纯函数，才有可能真的写出会红的测试 —— 否则只能写
//    advancedParamsMemory.node.test.js 那种读源码的文本守卫。

// ⚠ 这里带 `.js` 后缀，跟本目录其他文件的写法（`from './api'`）不一样，是故意的：
//   不带后缀只有 vite 能解析，`node --test` 会直接 ERR_MODULE_NOT_FOUND ——
//   也就是说这个文件将永远无法被单元测试导入。带上后缀两边都认。
import { api } from './api.js'

/** 后端把参数分成两档，界面上就是两个页签。 */
export const TIERS = ['common', 'advanced']

/**
 * 拉引擎列表。
 *
 * probe=0：只问「装了哪几台」，不去挨个探活。挑引擎、长面板都不需要知道
 * 它现在活没活，而探活要打网络、一台超时就拖住整张列表。在线状态是另一件
 * 事，谁要谁自己带 probe 去问。
 */
export function fetchEngines({ probe = false } = {}) {
  return api(`/api/engines?probe=${probe ? 1 : 0}`).then(r => {
    if (!r.ok) {
      return { ok: false, engines: [], errors: [], error: (r.data && r.data.error) || `HTTP ${r.status}` }
    }
    const d = r.data || {}
    return {
      ok: true,
      engines: Array.isArray(d.engines) ? d.engines : [],
      // 名片坏掉的引擎在这里，不是在 engines 里。界面必须把它显示出来 ——
      // 一台引擎因为少写一个键而从列表里消失，是最难查的那种症状。
      errors: Array.isArray(d.errors) ? d.errors : [],
      notice: d.notice || null,
      error: null,
    }
  })
}

/**
 * 选哪一台。
 *
 * 顺序：上次选的（如果还在） → 列表第一台 → null。
 *
 * ⛔ 刻意不写「默认选 xxx」。那正是契约要消灭的东西 —— 一旦这里点名一台，
 *    卸载那台引擎之后界面就会选中一个不存在的 id。
 */
export function pickEngine(engines, savedId) {
  const list = Array.isArray(engines) ? engines : []
  if (savedId) {
    const found = list.find(e => e && e.id === savedId)
    if (found) return found
  }
  return list.length ? list[0] : null
}

/**
 * 训练页显不显示（契约 §11 判据 11）。
 *
 * ⚠ 这条判据是「藏得住」，不是「训练接得通」—— 微调不在版本 2 范围内。
 *
 * ⭐ 故意 fail-closed：只有名片明写 `supports_finetune: true` 才显示。
 *    引擎还没加载出来（undefined / null）也不显示。
 *    理由是两边的坏法不对称：
 *      少显示一个页签 = 用户点不到一个他本来也用不了的东西，刷新一下就有了；
 *      多显示一个页签 = 用户点进去、填完表、跑一遍，才发现这台引擎根本不支持微调。
 */
export function showsTrainingTab(engine) {
  return !!(engine && engine.supports_finetune === true)
}

// ⛔⛔ 这里原本有一个 showsModelPickers(engine)：名片说这台引擎不能热换权重，
//    就把模型下拉整个藏掉。2026-08-30 删除。
//
//    它拿「**能不能换**」回答了「**有没有**」——两件事。一台启动时装权重的
//    引擎，盘上照样躺着好几个模型；把清单藏掉，等于对用户说"你没有模型"，
//    而"装了引擎却在模型清单里一个入口都没有"正是这轮要修的痛点本身。
//
// ⭐ 现在：候选**永远**列出来；选中的那一份发不发得出去，由名片在每个模型位
//    上写没写「用哪个参数名发」决定；发不出去的时候界面必须**写明**为什么。
//
// ⭐⭐ 2026-08-30 补记：引擎级的 capabilities.hot_swap_models **已经退休**，
//    ⛔ 界面和后端都不许再读它。换一份模型走哪一步，逐位写在
//    weight_slots[].applies_at 上：call = 发一次请求就换掉；
//    launch = 平台带着新的那一份把引擎重开一次（第一次要多等）。
//    ⇒ 「换不了」这个状态从此不存在，只剩「换法不同」。

/**
 * 这台引擎认不认识某个**平台的词**（名片 maps 里有没有这一条）。
 *
 * ⭐ 跟 param_schema 分工不同，别混：
 *     param_schema  引擎自己的参数 —— Advanced Settings 里那一袋，平台不认识
 *     mapped_keys   平台的词 —— 文本 / 参考音频 / 参考转写 / 语种 / speed …
 *                   名片给它铺了映射，这一格才发得出去
 *
 * ⛔ 名单没回来（旧后端、engine 还没读出来）时返回 true 而不是 false ——
 *    fail-open。这里的坏法不对称：
 *      多画一格 = 跟今天一模一样，用户看到的东西没变；
 *      少画一格 = 一个本来能用的控件凭空消失，而且不报错，最难查。
 *    ⚠ 与 showsTrainingTab 的 fail-closed 相反是故意的：那边多显示会让人
 *      白填一整张表，这边多显示只是多一个格子。
 */
export function hasMappedKey(engine, key) {
  if (!engine) return true
  const keys = engine.mapped_keys
  if (!Array.isArray(keys)) return true
  return keys.includes(key)
}

/**
 * 把 manifest.json 的 params.schema 翻成「这一档要画哪几个格子」。
 *
 * 返回的是描述，不是组件 —— 画成什么样是 JSX 的事，画哪些是这里的事。
 */
export function fieldsForTier(engine, tier) {
  const schema = (engine && Array.isArray(engine.param_schema)) ? engine.param_schema : []
  // 没写 tier 的落进 advanced —— 跟后端 lib/engines/profile.js:556 同一条规则
  // （`out.tier = d.tier === 'common' ? 'common' : 'advanced'`）。
  // ⛔ 不能写成 `f.tier === tier` 就完事：那样一个没写 tier 的参数会从两档里
  //    同时消失，名片作者明明写了一格，界面上却怎么也找不到。
  //    后端确实已经兜过一次底，但前端也吃得到手写/缓存的旧数据，
  //    两边说同一句话才不会有「只在某条路径上消失」的格子。
  return schema.filter(f => f && (f.tier === 'common' ? 'common' : 'advanced') === tier)
}

/**
 * 面板该不该显示「这张 manifest.json 没写 params.schema」。
 *
 * ⭐ `param_schema: []` 和「这台引擎没有参数」是两件事 —— 真机上 IndexTTS2
 *    的 param_schema 是空的，而它的 param_keys 有 12 个。空面板会让人以为
 *    这台引擎调不了，实际是名片作者还没写那一段。
 *    ⛔ 所以这里不能直接渲染一个空面板了事，要说出是哪一种。
 */
export function schemaGap(engine) {
  if (!engine) return null
  const schema = Array.isArray(engine.param_schema) ? engine.param_schema : []
  if (schema.length) return null
  const keys = Array.isArray(engine.param_keys) ? engine.param_keys : []
  if (!keys.length) return null
  return {
    engine_id: engine.id,
    param_key_count: keys.length,
    message:
      `engines/${engine.id}/manifest.json 里没有写 params.schema，` +
      `所以这里画不出参数格子。这台引擎实际接受 ${keys.length} 个参数` +
      `（manifest.json 的 param_keys 列着），补上 params.schema 就会出现在这里。`,
  }
}

/**
 * 面板的初值：每个格子取名片里的 default。
 *
 * ⚠ `default` 是**界面初值**，跟 `defaults.<键>`（每次都发的值）不是一回事 ——
 *    契约 C11 把这两者分得很开，这里只取前者。
 */
export function initialParamValues(engine) {
  const out = {}
  for (const f of (engine && Array.isArray(engine.param_schema) ? engine.param_schema : [])) {
    if (f && f.name !== undefined && f.default !== undefined) out[f.name] = f.default
  }
  return out
}

/**
 * 界面上收到的那一下（多半是字符串）翻成这个格子该有的类型。
 *
 * 翻不动就返回名片里的 default —— ⛔ 不返回 0 也不返回空字符串：
 * 输入框清空的一瞬间值是 ''，`parseFloat('')` 是 NaN，塞进请求体会变成 null，
 * 而那看起来跟「用户特意设成 0」一模一样。
 */
/**
 * 五种预设样式 —— 与后端 `lib/engines/paramTypes.js` 是**同一张表**。
 * ⛔ 想在这儿加第六种之前，先去改那个文件；两边分叉的症状是
 *    「后端收得下、前端画不出」，而画不出的格子不会报错。
 */
export const PARAM_TYPES = ['text', 'number', 'select', 'boolean', 'file']

/**
 * 老名字折成五种之一。
 *
 * ⭐ 前端**必须**也认老名字：缓存下来的旧 `param_schema`、用户机器上没跟着
 *    升级的第三方名片，都会带着 `enum` / `path` 进来。认不出的下场是走到
 *    `default:` 分支原样返回 —— 那正是「无声丢值」那类 bug 的入口。
 */
export function canonicalType(t) {
  switch (t) {
    case 'integer': case 'int': case 'float': case 'number': return 'number'
    case 'enum': case 'select': return 'select'
    case 'path': case 'file': return 'file'
    case 'string': case 'str': case 'text': return 'text'
    case 'bool': case 'boolean': return 'boolean'
    default: return typeof t === 'string' ? t : 'text'
  }
}

/** 这一格是不是「一排 N 个」。⛔ 不写 / 写 1 ⇒ 标量，不是长度 1 的数组。 */
export function repeatOf(field) {
  const n = field && field.repeat
  return Number.isInteger(n) && n > 1 ? n : 1
}

/** 这一格的值是不是数组：一排（repeat）或多选（multi）。 */
export function wantsArray(field) {
  return repeatOf(field) > 1 || (field && field.multi === true)
}

export function coerceParamValue(field, raw) {
  if (!field) return raw
  const fallback = field.default

  // 一排 / 多选：整条都是数组，逐格按标量规则翻。
  // ⛔ 任何一格翻不动就整条退回 default —— 不半条半条地留：
  //    发一条长度对不上的数组给引擎，多半不报错，只是声音不对。
  if (wantsArray(field)) {
    if (!Array.isArray(raw)) return fallback
    const n = repeatOf(field)
    if (n > 1 && raw.length !== n) return fallback
    const scalar = { ...field, repeat: 1, multi: false }
    const out = raw.map(v => coerceScalarValue(scalar, v))
    return out.some(v => v === undefined) ? fallback : out
  }
  return coerceScalarValue(field, raw)
}

function coerceScalarValue(field, raw) {
  const fallback = field.default
  switch (canonicalType(field.type)) {
    case 'number': {
      // ⭐ int 是数字的**一味**，不是另一种类型：丢了它，7.5 会悄悄发给
      //    只吃整数的引擎，一路不报错。
      const n = (field.int === true || field.type === 'integer' || field.type === 'int')
        ? parseInt(raw, 10)
        : parseFloat(raw)
      return Number.isFinite(n) ? n : fallback
    }
    case 'boolean':
      return raw === true || raw === 'true'
    case 'select': {
      // ⭐ 选项来自平台扫盘（source）时**一律放行**：有哪些要运行时才知道，
      //    拿一份可能过期的名单去卡，症状是「我明明选了它却没生效」。
      //    allow_custom 同理 —— 名片明说了库里没有的也让填。
      if (field.source || field.allow_custom === true) {
        return raw === null || raw === undefined ? fallback : raw
      }
      const choices = Array.isArray(field.choices) ? field.choices : []
      return choices.some(c => (c && typeof c === 'object' ? c.value : c) === raw) ? raw : fallback
    }
    case 'file': {
      // 空 = 用户没选 / 特意清空了。⛔ 这里不能退到 default：
      // 「清空这一格」是用户表达「这一项不要」的唯一方式，退回默认值等于
      // 他清不掉。空值到了 paramsToSend 那里会被拦下不发。
      if (raw === '' || raw === null || raw === undefined) return ''
      // 配方里存的托管路径是 { base, path } 这个形状，界面上显示的是字符串。
      // 两种都原样收下 —— 解析是 pathResolver 的活，不是这里的。
      if (typeof raw === 'string' || typeof raw === 'object') return raw
      return String(raw)
    }
    case 'text':
      // ⛔ 不 trim、不截断、不改大小写：用户打的空格可能就是他要的。
      return raw === null || raw === undefined ? fallback : String(raw)
    default:
      return raw
  }
}

/**
 * 这一格要不要画成「挑一个文件」（custom file）。
 *
 * ⭐ 平台不认识「权重」这个概念，只认识「这个参数的值是一个路径」。
 *    有几个、叫什么、是不是模型，那台引擎自己在 params.schema 里说；
 *    一个都不写，界面上就一个文件格子都不长。
 *
 * ⚠ 「从平台的库里挑一个」不是 file，是 `select` + `source` —— 区别是候选
 *    列表从哪来。混了的后果：给 file 硬配候选 = 替引擎规定文件只能放我们
 *    指定的地方。
 */
export function isPathField(field) {
  return !!(field && canonicalType(field.type) === 'file')
}

/**
 * 这一格的选项要不要平台去扫盘，扫哪一个库（voices / weights / audio）。
 * 不是就返回 null。
 */
export function selectSourceOf(field) {
  if (!field || canonicalType(field.type) !== 'select') return null
  return typeof field.source === 'string' && field.source ? field.source : null
}

/**
 * 这一格现在该不该显示（`only_when`）。
 *
 * ⭐⭐ **fail-open**：`only_when` 引用一个面板上没有的键 ⇒ 照常显示。
 *    与 `showsTrainingTab` 的 fail-closed 相反，是故意的 ——
 *    名片作者拼错一个键名，多画一格他一眼看得见；少画一格他找不到，
 *    而且没有任何报错。少画一格是更坏的失败。
 */
export function isFieldVisible(field, values) {
  const cond = field && field.only_when
  if (!cond || typeof cond !== 'object') return true
  const v = values || {}
  for (const [key, want] of Object.entries(cond)) {
    if (!Object.prototype.hasOwnProperty.call(v, key)) continue // fail-open
    if (v[key] !== want) return false
  }
  return true
}

/** 这台引擎要挑几个文件。没有就是空数组 —— 那是完全正常的一种引擎。 */
export function pathFields(engine) {
  const schema = (engine && Array.isArray(engine.param_schema)) ? engine.param_schema : []
  return schema.filter(isPathField)
}

/**
 * 面板上的值 → 请求体里 engine_params.<engine_id> 那一格。
 *
 * 只发名片认识的键。⛔ 不做「不认识就原样带上」：服务端会静默忽略不认识的
 * 键，表现是「我明明调了却没效果」，极难查（这正是 param_keys 要列全白名单
 * 的理由，见 registry 那段）。
 *
 * `sends_always` 为 false 的键，只有用户真的动过才发 —— 名片用它表达
 * 「这个参数只在某些模型上有意义，别无条件塞给引擎」。
 */
export function paramsToSend(engine, values, touched) {
  const schema = (engine && Array.isArray(engine.param_schema)) ? engine.param_schema : []
  const seen = touched instanceof Set ? touched : new Set(Array.isArray(touched) ? touched : [])
  const out = {}
  for (const f of schema) {
    if (!f || f.name === undefined) continue
    const has = values && Object.prototype.hasOwnProperty.call(values, f.name)
    if (!has) continue
    // 路径格子空着 = 用户没选这个文件 ⇒ 不发这个键。
    // ⛔ 不能发空字符串：引擎那边会当成「路径是空的」去打开文件而不是
    //    「没给路径」，报出来的错跟用户做的事对不上。
    if (isPathField(f) && (values[f.name] === '' || values[f.name] == null)) continue
    if (f.sends_always === true || seen.has(f.name)) out[f.name] = values[f.name]
  }
  return out
}

/**
 * 取当前语言的那一句。名片里 label / help 都是 { en, zh }。
 * 缺当前语言就退到英文，再缺就退到键名本身 —— ⛔ 不返回空字符串：
 * 一个没有名字的格子，用户既不知道它是什么，也没法搜。
 */
export function textOf(node, lang, fallback = '') {
  if (node == null) return fallback
  if (typeof node === 'string') return node
  return node[lang] || node.en || fallback
}

/** 格子的显示名。 */
export function fieldLabel(field, lang) {
  return textOf(field && field.label, lang, (field && field.name) || '')
}

/** 格子底下那行说明。名片没写就是空 —— 说明可以没有，名字不行。 */
export function fieldHelp(field, lang) {
  return textOf(field && field.help, lang, '')
}

// ---------------------------------------------------------------------------
//  底模徽章（2026-08-29）
// ---------------------------------------------------------------------------
// 来历是 Owner 的一句话：「你都读不到底模在哪里」。
// 在这之前，底模在界面上是**完全不存在**的一个概念 —— 放对了没有、放在哪，
// 界面一个字都不说，只能靠引擎起不起得来事后倒推。
//
// ⛔ 这里不做任何判断，判断在服务端（lib/engines/checkpoints.js）做完了。
//   这个函数只把 checkpoints 那一段翻成"徽章上写什么、悬停显示什么"。
//   ⇒ 前后端不会各判一次然后说出两种话。

/**
 * @returns {null|{tone:'ok'|'bad'|'unknown', label:string, title:string}}
 *   null = 不显示这个徽章（列表还没回来，或者这台引擎没有 checkpoints 段）
 */
export function checkpointBadge(engine, lang = 'zh') {
  const c = engine && engine.checkpoints
  if (!c) return null

  const zh = lang !== 'en'
  const lines = []

  if (!c.declared) {
    // ⚠ "说不出来"必须和"缺"分开显示。名片没写路径不代表底模没放，
    //   显示成红色会让一台好好的引擎永远挂着红灯。
    return {
      tone: 'unknown',
      label: zh ? '底模 ?' : 'weights ?',
      title: c.reason || (zh ? '这台引擎的名片没写底模在哪' : 'manifest does not declare a checkpoints dir'),
    }
  }

  lines.push((zh ? '底模目录：' : 'Checkpoints: ') + c.abs_path)
  if (c.path_source && c.path_source !== 'manifest') {
    // 路径和名片写的不一样时，人第一个问题一定是"为什么"。
    lines.push((zh ? '（来自环境变量 ' : '(from env ') + c.path_source.replace(/^env:/, '') + '）')
  }
  if (c.reason) lines.push(c.reason)
  if (c.ready !== true && c.hint) lines.push('', c.hint)
  if (c.ready !== true && c.source) {
    if (c.source.license_gate) {
      lines.push('', zh
        ? '⚠ 这个模型要先去主页上点同意才能下（不点会 401/403，看着像网络故障）'
        : '⚠ You must accept the license on the model page first (otherwise 401/403)')
    }
    if (c.source.url) lines.push((zh ? '模型主页：' : 'Model page: ') + c.source.url)
    if (Array.isArray(c.source.command)) {
      // ⛔ 命令原样来自名片，界面不改写、不拼装。
      lines.push(zh
        ? `取回命令（在 ${c.source.cwd} 下执行）：`
        : `Fetch (run in ${c.source.cwd}):`)
      lines.push(c.source.command.join(' '))
    }
  }

  if (c.ready === true) {
    return { tone: 'ok', label: zh ? '底模齐' : 'weights ok', title: lines.join('\n') }
  }
  if (c.ready === false) {
    const n = Array.isArray(c.missing) ? c.missing.length : 0
    return {
      tone: 'bad',
      label: n > 0 ? (zh ? `底模缺 ${n}` : `weights: ${n} missing`) : (zh ? '底模没放' : 'weights missing'),
      title: lines.join('\n'),
    }
  }
  return { tone: 'unknown', label: zh ? '底模 ?' : 'weights ?', title: lines.join('\n') }
}

// ---------------------------------------------------------------------------
//  进程徽章（2026-08-30，契约 §12 第 5 步）
// ---------------------------------------------------------------------------
// 来历：引擎从「开机全点着」改成「用到才起、不用就放」之后，
//   界面上出现了一个以前不存在的状态 —— **这台引擎现在没在跑，而这是正常的**。
//
// ⭐⭐⭐ 为什么非画不可，只有一个理由，但足够：
//   一台把权重在开进程那一刻吃进内存的引擎（6 GB 起步），换模型 = 整个重开。
//   第一次点下去要**几十秒到几分钟**没有任何声音出来。
//   界面什么都不说的话，正常人的反应是「卡死了」⇒ 再点一次 ⇒ 再排一次队 ⇒
//   更慢 ⇒ 更确信卡死了。⇒ `phase` 必须有个去处。
//
// ⛔ 这里不做任何判断。跑没跑、在忙没忙、装的是哪一份，服务端都算完了，
//   这个函数只负责翻成"徽章上写什么、悬停显示什么"。
//
// ⭐⭐ 三种「没在跑」必须说成三句不同的话，⛔ 不许合并：
//   · process === null   → 这台机器**不管进程**（后端没装看管人）⇒ 不画徽章。
//       报成"停着"会让人去点一个不存在的启动按钮。
//   · running === false  → 确实没起，**而这是正常的**，下次要用会自己起。
//       ⇒ 语气必须是中性的"待命"，⛔ 不是红色的"离线/挂了"。
//   · online 为真但 running 为假 → 引擎在跑，**但不是这个平台起的**
//       （开发机上最常见）。⇒ 这两个字段有意不合并，见 /api/engines。

/**
 * @returns {null|{tone:'ok'|'busy'|'idle'|'unknown', label:string, title:string}}
 *   null = 不画这个徽章（列表还没回来，或这台机器不管引擎进程）
 */
export function processBadge (engine, lang = 'zh') {
  if (!engine) return null
  const p = engine.process
  // ⭐ null / undefined = 「不管」，⛔ 不是「没跑」。这两个必须分开。
  if (p === null || p === undefined) return null

  const zh = lang !== 'en'
  const lines = []

  if (p.running !== true) {
    // ⚠ 引擎在跑但不是我们起的 —— 这不是错误，是开发机的日常。
    if (engine.online === true) {
      return {
        tone: 'unknown',
        label: zh ? '外部进程' : 'external',
        title: zh
          ? '这台引擎正在跑，但不是本平台起的（多半是你自己在另一个窗口开着）。\n' +
            '⇒ 本平台不会去停它，换模型也不会重开它。'
          : 'Engine is up but was not started by this app; it will not be stopped or relaunched here.',
      }
    }
    return {
      tone: 'idle',
      label: zh ? '待命' : 'idle',
      title: zh
        ? '现在没在跑 —— 这是正常的。\n' +
          '⇒ 下一次用到它时会自动起来；起的那一下要等模型装进内存。'
        : 'Not running — this is normal. It will start automatically on first use.',
    }
  }

  if (p.pid) lines.push((zh ? '进程号：' : 'PID: ') + p.pid)
  if (p.launch_key) {
    // ⭐ 这一行是 A 那件事唯一看得见的证据：
    //   "我选的模型到底装进去了没有" —— 以前只能靠听声音猜。
    lines.push((zh ? '现在装的是：' : 'Loaded: ') + p.launch_key)
  }

  // ⭐⭐⭐ phase 优先于 busy：正在把权重装进内存的那几十秒，
  //   是这整套东西里**唯一**会让人以为卡死的时刻。
  if (p.phase && p.phase !== 'ready') {
    lines.push('', zh
      ? '正在把模型装进内存，这一下可能要等几十秒到几分钟。\n⛔ 不用再点一次 —— 再点只会排在后面，更慢。'
      : 'Loading the model into memory; this can take a while. No need to click again.')
    return {
      tone: 'busy',
      label: zh ? '启动中…' : 'starting…',
      title: lines.join('\n'),
    }
  }

  if (p.busy === true) {
    lines.push('', zh ? '正在合成。' : 'Synthesising.')
    return { tone: 'busy', label: zh ? '合成中' : 'busy', title: lines.join('\n') }
  }

  return { tone: 'ok', label: zh ? '在跑' : 'running', title: lines.join('\n') }
}

/**
 * 把一份新拉到的引擎列表里的**进程状态**合并进手上这份。
 *
 * ⭐⭐⭐ 为什么不能直接 setEngines(新列表)：
 *   引擎列表本身（名片、参数表、模型位）**开页面时拉一次就够了** —— 它只有
 *   装卸引擎时才变。但进程状态是每几秒都在变的东西。
 *   直接整份换掉的话，每一轮都会产出一个**全新的数组**，于是所有
 *   `useEffect([engines])` 每几秒重跑一次 —— 包括那个"选中的引擎还在不在"，
 *   它会不停地 setState，把整棵树每 8 秒重画一遍。
 *
 * ⭐⭐ 所以这个函数的核心承诺是：**什么都没变时，原样把旧数组还回去**
 *   （连同每一个没变的引擎对象本身）。
 *   ⛔ 别改成"每次都 map 一份新的" —— 那样每个元素身份都变，等于没优化。
 *
 * ⛔ 只合并 process 这一个字段。新拉到的名片/参数一概不采纳：那是另一件事，
 *   混进来会让用户填了一半的参数面板在轮询到的某一秒被换掉。
 */
export function mergeProcessState (engines, fresh) {
  if (!Array.isArray(engines) || !Array.isArray(fresh)) return engines
  const byId = new Map()
  for (const f of fresh) if (f && f.id) byId.set(f.id, f)

  let changed = false
  const next = engines.map((e) => {
    if (!e || !e.id || !byId.has(e.id)) return e
    const p = byId.get(e.id).process
    // ⚠ 深比较，⛔ 不用 !== ：服务端每次都吐一个新对象，
    //   引用比较会让"没变"永远判成"变了"，这个函数就白写了。
    if (JSON.stringify(p ?? null) === JSON.stringify(e.process ?? null)) return e
    changed = true
    return Object.assign({}, e, { process: p ?? null })
  })
  return changed ? next : engines
}

// ---------------------------------------------------------------------------
//  引擎徽章 —— 顶栏关于「当前这台引擎」的**唯一**一枚灯（2026-08-30）
// ---------------------------------------------------------------------------
// 来历是 Owner 的一句话：「你现在右上角的指示灯越来越多了，是非常不好的兆头，
//   底模齐这种东西要写出来吗？idle 这种东西下面不是有一个指示灯了嘛？
//   你再加是想变成飞机仪表盘嘛」。
//
// ⭐⭐⭐ 他说的不只是"占地方"，底下还压着一个真的坏掉的东西：
//
//   引擎改成「用到才起」之后，老那枚「Connected / Unreachable」**天天红**。
//   它报的是探活通不通；而现在"没起"是常态、是**设计如此**。
//   ⇒ 一枚在正常状态下常亮红灯的指示灯，唯一的效果是训练人忽略所有红灯。
//   这跟"少一枚灯好看一点"是两件事：并不是把三枚塞进一枚省地方，
//   而是那三枚里有两枚在新世界里已经**说错话**了。
//
// ⭐⭐ 三枚合一之后，谁来当那一句话，按「谁最需要人动手」排：
//
//   ┌───┬──────────────┬──────┬────────────────────────────────────────┐
//   │ 1 │ 底模缺       │ 红   │ 你不动手它永远起不来 ⇒ 唯一有资格红的   │
//   │ 2 │ 启动中…      │ 橙   │ 唯一会让人以为卡死的时刻 ⇒ 见下         │
//   │ 3 │ 合成中       │ 橙   │ 在干活                                  │
//   │ 4 │ 在跑         │ 绿   │                                         │
//   │ 5 │ 待命         │ 灰   │ 没起，**而这是正常的** ⇒ ⛔ 绝不许红     │
//   └───┴──────────────┴──────┴────────────────────────────────────────┘
//
// ⭐ 「底模齐」不占格子了 —— 它是一次性的事实，放对了就永远绿，
//   一枚永远绿的灯不携带任何信息。⇒ 降级进悬停。
//   ⛔ 但「底模缺」必须留在**灯面上**：那是唯一一种"看不见就会被卡住一小时"的坏。
//
// ⛔ 这个函数一个判断都不新加。底模齐没齐、进程跑没跑，服务端早算完了，
//   上面两个函数早翻好了 —— 这里只决定**谁上台**和**悬停里怎么排**。
//   ⇒ 不会出现"顶栏说一句、别处说另一句"。

/**
 * @param {object|null} engine  当前选中的引擎（含 checkpoints / process / online）
 * @param {object|null} health  /api/health 的结果，只用它的 engine_online
 * @returns {null|{tone:'ok'|'busy'|'idle'|'bad'|'unknown', label:string, title:string}}
 *   null = 引擎列表还没读出来 ⇒ 不画（⛔ 不画成"离线"）
 */
export function engineBadge (engine, health, lang = 'zh') {
  if (!engine) return null

  const zh = lang !== 'en'
  const name = engine.label || engine.id || (zh ? '引擎' : 'engine')
  const ck = checkpointBadge(engine, lang)
  const pr = processBadge(engine, lang)

  // 悬停 = 把两段原样叠起来，中间空一行。⛔ 不重写、不摘要：
  //   那两段里有绝对路径和取回命令，那才是"我该去哪儿放什么"的答案。
  const detail = []
  if (pr && pr.title) detail.push(pr.title)
  if (ck && ck.title) detail.push(ck.title)
  const title = (head) => [head, '', ...detail].join('\n').trim()

  // ── 1. 底模缺 —— 唯一有资格红的 ──────────────────────────────────
  if (ck && ck.tone === 'bad') {
    return {
      tone: 'bad',
      label: `${name} · ${ck.label}`,
      title: title(zh
        ? '底模没放齐 ⇒ 这台引擎起不来。下面写了该放在哪、怎么取回。'
        : 'Base weights incomplete — this engine cannot start. See below.'),
    }
  }

  // ── 2..5. 进程状态 ───────────────────────────────────────────────
  if (pr) {
    return { tone: pr.tone, label: `${name} · ${pr.label}`, title: title('') }
  }

  // ── 兜底：这台机器**不管进程**（process 为 null）──────────────────
  // ⭐ 只有在这种时候，「探活不通」才真的是一件坏事 —— 因为没有人会去起它。
  //   ⇒ 老那枚 Connected/Unreachable 的语义原样保留在这里，一个字没丢。
  const up = health?.engine_online === true
  if (health == null) {
    return { tone: 'unknown', label: `${name} · …`, title: title(zh ? '正在读取状态…' : 'Loading…') }
  }
  return {
    tone: up ? 'ok' : 'bad',
    label: `${name} · ${up ? (zh ? '已连接' : 'connected') : (zh ? '连不上' : 'unreachable')}`,
    title: title(up
      ? (zh ? '探活通。' : 'Reachable.')
      : (zh
        ? '探活不通，而这台机器不由本平台管进程 ⇒ 得你自己把引擎起起来。'
        : 'Not reachable, and this host does not manage engine processes — start it yourself.')),
  }
}
