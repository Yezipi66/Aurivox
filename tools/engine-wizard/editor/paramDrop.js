// 拖一个参数落进 Manifest 时，纯计算那部分。
// 纯函数放自己的文件：组件模块只导出组件，导出别的会让 Fast Refresh 失效。

import { paramTypeOf } from './paramType.js'
import { vectorShapeFromHelp } from './paramShape.js'
import { boolStyle } from './paramFields.js'

// 中栏的落点：界面参数区（parameters[]）。扫到的参数拖进来，按扫到的信息预填，接入者再改。
//
// 参数名：扫到的 cli 参数是命令行开关（--speed），界面参数名去掉开头的横线（speed）；
// python 参数本身就是方法参数名，原样用。
//
// cli 参数拖进来还要写进 call.args：命令行形态下只认声明过的名字，没声明就被拒。
// 写的是刚刚拖进来的那个开关，不是平台猜的对应关系。

/**
 * 去掉开关前面的横线，得到界面参数名。
 * @param {object} param 扫到的参数
 * @returns {string} 参数名
 */
export function paramNameOf (param) {
  if (!param) return ''
  if (param.source === 'cli') return String(param.name || param.target || '').replace(/^-+/, '')
  return String(param.name || param.target || '')
}

// 参数行记的是「这一行从哪个入口形态扫出来」，写回时按它与 call.kind 比对清场。
//   不叫 source：参数行的 source 已被 paramTable.js 用作「select 选项来自托管库」，
//   一个词两种含义比没有文档更坏。这个名字也不进 UI_KEYS，host 收不到。
//   python-static 是 python 形态的静态反射，归到同一类。
export function scanKindOf (param) {
  const s = param && param.source
  if (s === 'cli') return 'cli'
  if (s === 'python' || s === 'python-static') return 'python'
  return null
}

// 拖拽时放在 dataTransfer 里的机器可读那一份。text/plain 放给人看的写法
//   （跟着光标走的拖影显示的就是 text/plain），自定义类型放整条参数。
//   两者分工：前者让人一眼认出拖的是哪个开关，后者让落点不必从显示文字反推。
export const PARAM_MIME = 'application/x-aurivox-param'
// 第 5 步参考音频抽屉的拖拽载荷类型，与 PARAM_MIME 一并集中在这里：
//   两者都是「自定义类型放机器可读的整条数据」，落点各读各的类型。
export const REF_MIME = 'application/x-aurivox-ref'

/**
 * 拖动时显示的文字：命令行上要敲的那个写法。
 * @param {object} param 扫到的参数
 * @returns {string} 例如 --emotion-vector，python 形态是方法参数名
 */
export function dragLabelOf (param) {
  if (!param) return ''
  return String(param.target || param.name || '')
}

// 旧格式（params.schema + load_time/call_time）与新格式（parameters[]）只允许存在一份。
// 拖参数进来写的是新格式，所以旧的那份必须先搬过去，否则两份共存会被校验直接拒掉。
// 形状对应关系：schema 的键 → name；schema.default → suggested_value；
// load_time 里有的 → phase: "load"，其余是 call。
const CARRIED = [
  'type', 'label', 'help', 'min', 'max', 'step', 'choices', 'source',
  'allow_custom', 'multi', 'repeat', 'dim_labels', 'tier', 'group',
  'order', 'width', 'only_when', 'int',
]

/**
 * 把旧格式的 params 迁移成 parameters[]。已经新格式的名片原样返回。
 *
 * @param {object} manifest 当前名片
 * @returns {object} 迁移后的名片（旧键已删除）
 */
export function migrateLegacyParams (manifest) {
  const m = { ...(manifest || {}) }
  if (m.parameters !== undefined || m.params === undefined) return m

  const legacy = m.params || {}
  const schema = legacy.schema || {}
  const loadTime = Array.isArray(legacy.load_time) ? legacy.load_time : []
  const callTime = Array.isArray(legacy.call_time) ? legacy.call_time : []

  // 顺序：先按 schema 的键序，再把只在 load/call_time 里出现的补在后面。
  //   schema 的顺序是接入者写名片时的顺序，界面按它排，不该被这次迁移打乱。
  const names = [...Object.keys(schema)]
  for (const name of [...loadTime, ...callTime]) {
    if (!names.includes(name)) names.push(name)
  }

  const parameters = names.map((name) => {
    const d = schema[name] || {}
    const entry = { name, type: d.type || 'text' }
    if (loadTime.includes(name)) entry.phase = 'load'
    for (const key of CARRIED) {
      if (d[key] !== undefined) entry[key] = d[key]
    }
    // 新格式里默认值叫 suggested_value，旧格式叫 default。名字不同，含义一样。
    if (d.default !== undefined) entry.suggested_value = d.default
    if (entry.tier === undefined) entry.tier = 'common'
    return entry
  })

  m.parameters = parameters.length ? parameters : undefined
  if (m.parameters === undefined) delete m.parameters
  delete m.params
  return m
}

/** 上游候选值 → 选项表；上游没给时留两行空表让人自己填。 */
function choicesFrom (param) {
  const opts = Array.isArray(param.choices) ? param.choices : []
  return opts.length
    ? opts.map((v) => ({ value: String(v), label: { zh: '', en: '' } }))
    : [{ value: '', label: { zh: '', en: '' } }, { value: '', label: { zh: '', en: '' } }]
}

/**
 * 扫到的默认值 → 界面初值。只收与类型对得上的标量：
 *   上游的文本默认值常常是示例句子，抄进界面等于替人写了正文。
 */
function suggestedFrom (param, type) {
  const d = param.default
  if (d === null || d === undefined) return undefined
  if (type === 'number' && typeof d === 'number') return d
  if (type === 'boolean' && typeof d === 'boolean') return d
  if (type === 'select' && typeof d === 'string') return d
  return undefined
}

/**
 * 扫到的参数 → call.args 里那一条：开关写法与样式词。
 * 样式词是宿主认的那几个（value / boolean / boolean_optional / join / repeat），
 * 写错词宿主展开命令行时当场抛错。
 */
export function argsEntryFor (param) {
  const entry = { flag: param.target }
  // 上游明说「逗号分隔」时命令行上只该出现一个词，不是 N 个词：
  //   写成 default 的 value 会被按 nargs 展开，上游只吃第一个，而且不报错。
  const shape = vectorShapeFromHelp(param.help)
  if (shape) {
    entry.style = shape.style
    entry.join = shape.join
  } else if (param.kind === 'boolean' || param.style === 'boolean' || param.style === 'boolean_optional') {
    // 双写法（--x/--no-x）必须写成 boolean_optional：boolean 发不出否定式，
    //   上游默认开着的那种开关就永远关不掉。
    entry.style = boolStyle(param.style === 'boolean_optional' || !!param.negative)
  } else if (param.style) {
    entry.style = param.style
  }
  return entry
}

/**
 * 把扫描结果里的形状补进一条参数行：控件类型、上游原话、候选值、默认值。
 *
 * 只补空着的字段（help / choices / suggested_value），名字与中英文名不动：
 * 那两项是人写的部分，扫描结果里没有。返回副本，不改入参。
 *
 * @param {object} row 参数行
 * @param {object} param 扫到的参数
 * @returns {object} 补过的参数行
 */
export function applyScanShape (row, param) {
  const type = paramTypeOf(param)
  const out = { ...(row || {}) }
  // 形态标记跟着扫描结果走：重扫时同一行换了形态，标记也要跟着换。
  //   manual 是人接管的行，扫描与拖拽补全都不许改回扫描来源；
  //   来源域因此封闭成 cli / python / manual 三态，不出现「未知」。
  if (out.scan_kind !== 'manual') {
    const scanKind = scanKindOf(param)
    if (scanKind) out.scan_kind = scanKind
  }
  // 类型只在还没定过时按扫描写：人挑过的 select / boolean 不能被盖掉。
  //   英文名等其它字段仍照补，两者互不牵连。
  if (typeUndecided(row)) out.type = type
  // 英文名默认取参数名：--model-dir 去掉横线就是 model-dir。
  //   合成页在英文名空时会回退到 name，但那是隐含回退，界面上这一格仍看着空；
  //   这里是「按扫描结果写进去」，让人一眼看见它填了什么，也允许改。
  const en = row && row.label && row.label.en
  if (!en && param && param.name) {
    out.label = { ...(row && row.label ? row.label : {}), en: String(param.name).replace(/^-+/, '') }
  }
  if (!out.help && param.help) out.help = { zh: param.help, en: param.help }
  // 空数组等于没有选项表：切过一次 select 又清空的行仍算没配好。
  if (out.type === 'select' && !(Array.isArray(out.choices) && out.choices.length)) {
    out.allow_custom = true
    out.choices = choicesFrom(param)
  }
  const suggested = suggestedFrom(param, type)
  if (suggested !== undefined && out.suggested_value === undefined) out.suggested_value = suggested

  // 上游说明里写了「逗号分隔的 N 维」时，这一条声明成 vector：
  //   维度数由 dim_labels 的长度定，每维一个名字（先留空，让使用者自己填，
  //   上游只写了几维、没写每维叫什么）。默认值跟着长成 N 格，每格 null。
  //   替人填 0 等于替他做了决定；只写维度不写默认值，名片会被校验拒掉。
  const shape = vectorShapeFromHelp(param.help)
  if (shape && shape.repeat > 1 && typeUndecided(row)) {
    out.type = 'vector'
    if (!Array.isArray(out.dim_labels)) {
      out.dim_labels = new Array(shape.repeat).fill('').map(() => ({ zh: '', en: '' }))
      out.suggested_value = new Array(shape.repeat).fill(null)
    }
  }
  return out
}

// 参数行与扫描结果按参数名对齐：命令行开关去掉横线就是参数名，两边是同一个词。
//   同名参数在多个子命令里各有一份时取扫描顺序里的第一条。
export function scanParamFor (name, scanned) {
  const key = String(name == null ? '' : name).trim()
  if (!key) return null
  for (const p of scanned || []) {
    if (p && paramNameOf(p) === key) return p
  }
  return null
}

/**
 * 扫描结果给出的控件类型。上游说明里写了「逗号分隔的 N 维」时是 vector，
 * 其余按 paramType 的映射走。
 */
export function scannedTypeOf (param) {
  const shape = vectorShapeFromHelp(param && param.help)
  if (shape && shape.repeat > 1) return 'vector'
  return paramTypeOf(param)
}

/**
 * 这一行的控件类型是不是还没定过：只有默认的 text，也没有选项表与维度表。
 *
 * 手敲开关加进来的行、「添加一个参数」加的行都落在这里；拖进来的行与手动改过
 * 类型的行不落在这里，不该被补一遍。
 */
export function typeUndecided (row) {
  if (!row) return false
  const type = row.type
  if (type && type !== 'text') return false
  const hasChoices = Array.isArray(row.choices) ? row.choices.length > 0 : !!row.choices
  const hasDims = Array.isArray(row.dim_labels) ? row.dim_labels.length > 0 : !!row.dim_labels
  return !hasChoices && !hasDims
}

/** 这一行按扫描结果补完之后，类型会不会真的变。文本参数本来就是文本，不算可补。 */
export function typeWouldChange (row, param) {
  if (!param) return false
  return scannedTypeOf(param) !== ((row && row.type) || 'text')
}

/**
 * 这一行的控件类型是不是仍然只是「从扫描结果推出来的」，可以跟着新开关一起换。
 *
 * 换开关时用：由扫描结果推出来的类型随开关换掉，人在下拉里挑过的类型保持不变。
 * 判据是「当前类型等于旧开关在扫描结果里的类型，且没有选项表与维度表」，
 * 不另存标记：多一个字段，就多一处可能与真实配置不一致的地方。
 */
export function typeDerivedFrom (row, oldName, scanned) {
  if (typeUndecided(row)) return true
  const prev = scanParamFor(oldName, scanned)
  if (!prev) return false
  return (row && row.type) === scannedTypeOf(prev) && !row.choices && !row.dim_labels
}

/**
 * 有多少行能按扫描结果改掉类型。界面用它在按钮上写数量，数量为 0 时不出按钮。
 *
 * 只数类型真会变的行：文本参数按扫描结果还是文本，把它算进来，
 * 按钮上的数字点完也降不到 0，读起来像没生效。
 *
 * @param {object} manifest 当前名片
 * @param {Array} scanned /wizard/discover 的 params
 * @returns {number} 可补的行数
 */
export function countUnshapedParams (manifest, scanned) {
  const list = Array.isArray(manifest && manifest.parameters) ? manifest.parameters : []
  let n = 0
  for (const row of list) {
    if (!row || !row.name) continue
    const param = scanParamFor(row.name, scanned)
    if (!typeUndecided(row) && !labelWouldFill(row, param)) continue
    if (!param) continue
    if (typeWouldChange(row, param) || labelWouldFill(row, param)) n++
  }
  return n
}

/** 这一行的英文名是不是空得能按扫描结果补上（参数名去掉横线）。 */
function labelWouldFill (row, param) {
  const en = row && row.label && row.label.en
  return !en && !!(param && param.name)
}

/**
 * 按扫描结果把还没定类型的参数行补齐：类型、说明、候选值、默认值，命令行样式一并改对。
 *
 * 为什么需要它：参数行有两条来路。拖/点左栏进来的自带类型；在表格里手敲开关的
 * 只有名字，类型停在默认的 text。手敲是常见路径（照上游 README 抄命令），
 * 于是整张表都是 text，合成页上每个旋钮长成一个文本框。
 *
 * 只改「还没定过类型、且扫描结果会改掉它的类型」的行，其余原样返回
 * （文本参数按扫描结果仍是文本，列进来只会让按钮上的数字永远降不到 0）。
 * 返回新名片，不改入参。
 *
 * @param {object} manifest 当前名片
 * @param {Array} scanned /wizard/discover 的 params
 * @returns {{manifest: object, filled: number, names: string[]}} 新名片、补齐的行数与行名
 */
export function fillTypesFromScan (manifest, scanned) {
  const m = migrateLegacyParams(manifest)
  const list = Array.isArray(m.parameters) ? m.parameters : []
  const names = []
  const next = list.map((row) => {
    if (!row || !row.name) return row
    // 类型只在「还没定过」时按扫描改：手动挑过的类型要尊重。
    //   英文名不受这条限制，空就补，即使类型是人手挑的。
    if (!typeUndecided(row) && !labelWouldFill(row, scanParamFor(row.name, scanned))) return row
    const param = scanParamFor(row.name, scanned)
    if (!param || (!typeWouldChange(row, param) && !labelWouldFill(row, param))) return row
    names.push(row.name)
    return applyScanShape(row, param)
  })
  if (!names.length) return { manifest: m, filled: 0, names: [] }

  const out = { ...m, parameters: next }
  // cli 形态：布尔型开关的命令行样式要跟着改。
  //   留空时宿主按 `--x True` 发，而 `--x` 是不收值的开关，上游当场报错；
  //   值型开关本来就不写 style，写不写一个样，不必动。
  const call = m.call
  if (call && call.kind === 'cli' && call.args) {
    const args = { ...call.args }
    next.forEach((row, i) => {
      if (row === list[i] || !row || row.type !== 'boolean') return
      const param = scanParamFor(row.name, scanned)
      const want = param ? argsEntryFor(param) : null
      const cur = args[row.name]
      if (want && cur && cur.flag && cur.style !== want.style) {
        args[row.name] = { ...cur, style: want.style }
      }
    })
    out.call = { ...call, args }
  }
  return { manifest: out, filled: names.length, names }
}

/**
 * 拖一个参数落进 parameters[] 时要改哪些地方。
 *
 * 纯函数：不读组件 state，不调 onChange。这样这一步能单独测。
 *
 * @param {object} manifest 当前名片
 * @param {object} param 扫到的参数
 * @returns {object} 新的名片
 */
export function applyParamDrop (manifest, param) {
  const name = paramNameOf(param)
  if (!name) return { ...(manifest || {}) }

  // 先迁移：旧格式还在的名片，直接写 parameters 会变成两份事实，存盘时被拒。
  const m = migrateLegacyParams(manifest)

  const list = Array.isArray(m.parameters) ? [...m.parameters] : []
  // 已经声明过同名参数就不重复加：拖两次同一个东西不该出现两条。
  if (!list.some((p) => p && p.name === name)) {
    // 类型、上游原话、候选值、默认值都来自扫描结果，与「按扫描结果定类型」共用一份判定。
    const entry = applyScanShape({ name, tier: 'common' }, param)
    // 英文名由参数名派生：上游已经写明了这个开关叫什么，平台不需要再问一遍。
    //   中文名留空：那是唯一需要人写的一项，空着也一眼看得出来还没填。
    //   两种名字都不写时界面上只剩灰色占位字，读起来像「已经填好了」。
    if (name) entry.label = { en: name, zh: '' }
    list.push(entry)
  }
  m.parameters = list.length ? list : undefined

  // cli 形态：把参数名写进 call.args，声明它对应哪个命令行开关。
  // 名片里已有的条目不动：用户手填过的映射比扫描猜的准。
  if (param.source === 'cli' && m.call && m.call.kind === 'cli') {
    const args = { ...(m.call.args || {}) }
    if (!args[name]) args[name] = argsEntryFor(param)
    m.call = { ...m.call, args }
  }
  return m
}

/**
 * 这个开关是不是已经有归属了。
 *
 * 与「必填参数」用的是同一条规矩：谁把它填了，它就归谁，别人不再拿它做第二格。
 * 三个归属方各自把开关名写在名片的不同位置：
 *   ① 必填参数区：call.bind 的取值（正文、参考音频、参考文本、输出路径）；
 *   ② 可选能力与引擎配置：call.args 里带 role 的条目（audio_ref、device、output_format）；
 *   ③ 合成参数区：parameters[] 里已经有一行。
 * 另外进了 argv 的位置参数也算有归属：它本来就不是开关。
 *
 * 只看「call.args 里有没有这条」不够：扫描会把入口文件的开关全写进 call.args
 * 当作命令行映射，那只是映射，不等于已经有了格子，所以这里按 role 判，不按有无判。
 *
 * @param {object} manifest 当前名片
 * @param {object} param 扫到的参数
 * @returns {boolean}
 */
export function isParamTaken (manifest, param) {
  if (!param) return false
  const name = paramNameOf(param)
  const m = manifest || {}
  const call = m.call || {}
  const declared = Array.isArray(m.parameters) ? m.parameters : []
  if (name && declared.some((x) => x && x.name === name)) return true
  // bind 槽位在 cli 里填的是开关名（--prompt_text），在 python 里填的是方法参数名（prompt_text）。
  //   两种形态的扫描参数分别带 target 与 name：按 source 取对应的那个去比，
  //   只看 target 会让 python 的 bind 参数漏判，同一个参数在必填区与合成表里各出现一次。
  const bindName = param.source === 'cli' ? String(param.target || '') : String(param.name || param.target || '')
  if (bindName && Object.values(call.bind || {}).some((v) => typeof v === 'string' && v === bindName)) return true
  const flag = String(param.target || '')
  if (!flag) return false
  const args = call.args || {}
  if (name && args[name] && args[name].role) return true
  // 键名与扫描到的参数名不一致时按开关名再认一遍：名片里的键可以自己起名
  //   （ref-audio → --voice），扫描到的参数名则从开关名派生，两边不保证同名。
  if (Object.values(args).some((e) => e && e.role && String(e.flag || '') === flag)) return true
  return Array.isArray(call.argv) && call.argv.includes(flag)
}

/**
 * 一次把一组扫描到的参数写进 parameters[]。
 *
 * 与逐个拖进来走同一条路（applyParamDrop），所以类型、英文名、call.args 的
 * 结果完全一致；区别只是入口从「拖一个」变成「一次加一组」。
 * 已经有归属的开关跳过（见 isParamTaken）：它已经在别的格子里，加进来就是两份事实；
 * 已有的行一律不动。
 *
 * @param {object} manifest 当前名片
 * @param {Array} scannedParams 扫描到的参数（调用方已按入口与分组筛过）
 * @returns {{manifest: object, added: string[]}} added 是这次新加进来的参数名
 */
export function addParamsFromScan (manifest, scannedParams) {
  const xs = Array.isArray(scannedParams) ? scannedParams : []
  const added = []
  if (!xs.length) return { manifest: manifest || {}, added }
  const declared = new Set(
    (Array.isArray(manifest && manifest.parameters) ? manifest.parameters : [])
      .map((p) => p && p.name).filter(Boolean))
  let m = manifest || {}
  // 换引擎后名片是空壳，没有 call 段。cli 参数的开关名就写在 call.args 里，
  //   没有这一段，加进来的行只剩一个空白的开关格，等于把「上游叫什么」丢掉。
  //   只在整组都是 cli 来源时立这个骨架：python 形态的参数不走命令行。
  if (!m.call && xs.some((p) => p && p.source === 'cli')) {
    m = { ...m, call: { kind: 'cli', args: {} } }
  }
  for (const param of xs) {
    const name = paramNameOf(param)
    if (!name || declared.has(name)) continue
    // 已经有归属的开关不再做成旋钮：与它那一格是同一个开关，加进来等于两份事实。
    if (isParamTaken(m, param)) continue
    m = applyParamDrop(m, param)
    declared.add(name)
    added.push(name)
  }
  return { manifest: m, added }
}

/**
 * 扫描写回用的整表同步：扫描是这一形态的事实来源，另一形态的行要跟着走。
 *
 * 来源域三态：cli / python 是扫描写的，manual 是人编辑时写的，没有第四态。
 *
 *   manual 一行不动：不删、不覆盖字段。人接过手的参数扫描不再替他做主。
 *   cli / python 与当前 call.kind 不符的直接删，那是另一形态的存量。
 *   被 bind / role / argv 接管的行删：它在必填区或可选区另有格子，合成表不再摆第二份。
 *   没有 scan_kind 的存量行（加这个字段之前写的）无来源可判，退回原判据：
 *   中文名为空、说明双语两份相同、且本次没扫到，才当成旧扫描行删掉；
 *   人填过中文名或改过说明的当成手动行，补标 manual 留住。
 * 本次扫到的无标记存量行顺手补上形态，名片扫一次就完成升级。
 *
 * @param {object} manifest 当前名片
 * @param {Array} scannedParams 本次扫描结果（调用方已按入口与分组筛过）
 * @returns {{manifest: object, added: string[], removed: string[]}}
 */
export function syncParamsFromScan (manifest, scannedParams) {
  const xs = Array.isArray(scannedParams) ? scannedParams : []
  const m0 = manifest || {}
  // 已被 bind / role / argv 接管的参数在必填区或可选区另有格子，合成表里不再留第二行。
  //   传一份清空 parameters 的名片给 isParamTaken：那条判据把「表里已有同名行」也算归属，
  //   而这里要判的只是「有没有别的格子接手了它」，不能让合成表自己把自己判成已归属。
  const withoutTable = { ...m0, parameters: undefined }
  const taken = new Set(xs.filter((p) => isParamTaken(withoutTable, p))
    .map(paramNameOf).filter(Boolean))
  const xsFresh = xs.filter((p) => !taken.has(paramNameOf(p)))
  const names = new Set(xsFresh.map(paramNameOf).filter(Boolean))
  const callKind = (m0.call && m0.call.kind) || null
  const list = Array.isArray(m0.parameters) ? m0.parameters : []
  const removed = []
  const kept = []
  for (const p of list) {
    const name = p && p.name
    const marked = p && p.scan_kind
    const label = (p && p.label) || {}
    const help = (p && p.help) || {}
    const untouched = !label.zh && (help.zh || '') === (help.en || '')
    // manual 是人接管的行，原样留住：不删，也不被下面的补标记改写。
    if (marked === 'manual') {
      kept.push(p)
      continue
    }
    // cli / python 是扫描写的：不符当前入口就是另一形态的存量，删。
    const otherKind = marked && callKind && marked !== callKind
    // 被 bind / role / argv 接管的行在别处有格子，合成表里不再留第二行。
    const takenElsewhere = name && taken.has(name)
    // 无标记的旧行没有来源可判，退回原判据，只清人没碰过且本次没扫到的。
    const staleLegacy = !marked && name && !names.has(name) && untouched
    if (name && (otherKind || takenElsewhere || staleLegacy)) {
      removed.push(name)
      continue
    }
    // 本次扫到的无标记行补上形态；人改过的无标记存量行补 manual 留住。
    if (!marked && callKind) {
      const asManual = name && !names.has(name) && !untouched
      kept.push({ ...p, scan_kind: asManual ? 'manual' : callKind })
    } else {
      kept.push(p)
    }
  }
  let m = manifest || {}
  const changed = removed.length || kept.some((p, i) => p !== list[i])
  if (changed) m = { ...m, parameters: kept.length ? kept : undefined }
  const { manifest: added, added: addedNames } = addParamsFromScan(m, xsFresh)
  return { manifest: added, added: addedNames, removed }
}
