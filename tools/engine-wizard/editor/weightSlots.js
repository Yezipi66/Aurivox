// 权重位（名片 weights[]）的写入，连带「这一位怎么真的送到引擎」那几处接线。
//
// 一位 = 位名 + 显示名 + 参数名 + 生效时机。位名直接进磁盘路径，也是合成页那个下拉的名字
// （assets/<音色>/models/<引擎 id>/<位名>/）；参数名是这一份权重从哪个开关进命令行
// （--weight1），引擎按类调用时是那个方法参数名。
//
// 参数名一写，名片里另外三处必须同时成立。少一处的症状全部是「选了不生效」，一处都不报错：
//   param_keys        词汇表。不在表上的键由 lib/engines/profile/maps.js 的 checkSlotParams 拦下
//   payload_keys      允许从合成配置透传（lib/engines/payload.js 第 2 步读它）
//   params.call_time  宿主的调用期白名单（lib/engines/host.py 只认这里的键）
//   call.args         仅命令行形态：参数名 → 开关形状（build_cli_argv 不替名片猜）
// 所以这里把 weights 与那几处一起写、一起删，界面上只编辑 weights。
//
// 写了 parameters[] 的名片，那三处是平台派生的（lib/engines/parameterDeclaration.js），
// 再自己写一份会当场抛，那种名片只往 parameters[] 里加一条。

const trim = (v) => String(v == null ? '' : v).trim()

const APPLIES = Object.freeze(['call', 'launch'])

/** 界面上填的可能是开关（--weight1），名片里存的是键名（weight1）。 */
export function slotParamName (raw) {
  return trim(raw).replace(/^-+/, '')
}

/** 新增一位时的初值。位名不预填：它要变成磁盘目录名，猜一个等于替人建目录。 */
export function emptySlot () {
  return { name: '', label: '', param: '', applies_at: 'call' }
}

/** 名片 weights[] → 界面行。launch 位没有参数名，那种位只由底模目录决定。 */
export function readSlots (manifest) {
  const list = manifest && Array.isArray(manifest.weights) ? manifest.weights : []
  const args = (manifest && manifest.call && manifest.call.args) || {}
  const out = []
  for (const raw of list) {
    let name = ''
    let label = ''
    let param = ''
    let applies = ''
    if (typeof raw === 'string') {
      name = trim(raw)
      label = name
    } else if (raw && typeof raw === 'object') {
      name = trim(raw.name)
      label = trim(raw.label) || name
      param = trim(raw.param)
      applies = trim(raw.applies_at)
    }
    if (!name) continue
    const entry = param ? args[param] : null
    out.push({
      name,
      label,
      param,
      applies_at: APPLIES.includes(applies) ? applies : (param ? 'call' : 'launch'),
      flag: entry && typeof entry.flag === 'string' ? entry.flag : '',
    })
  }
  return out
}

/**
 * 把界面上的几位写回名片：weights 与它需要的接线一起写，一起删。
 * 纯函数，原对象不动。
 *
 * @param {object} manifest 当前名片
 * @param {Array<{name:string,label:string,param:string,applies_at:string}>} rows 界面上的位
 * @returns {object} 新的名片
 */
export function writeSlots (manifest, rows) {
  const m = { ...(manifest || {}) }
  // 上一次声明过哪些位：删位时它们的键要跟着收走，否则名片里留下永远发不出去的键。
  const prev = readSlots(m).map((s) => s.param).filter(Boolean)

  const list = []
  const flags = {}
  const seen = new Set()
  for (const row of (rows || [])) {
    const name = trim(row && row.name)
    // 空名与重名都不写：位名是磁盘目录名，两个同名位会指向同一个目录。
    if (!name || seen.has(name)) continue
    seen.add(name)
    const asked = trim(row && row.applies_at)
    let applies = APPLIES.includes(asked) ? asked : ''
    let param = slotParamName(row && row.param)
    // launch 位不许有 param：那两句话是矛盾的，平台装的时候当场拒收。
    if (applies === 'launch') param = ''
    // 有参数名 = 进程活着时一次调用就能换。
    if (param && !applies) applies = 'call'
    // 生效时机一律写明：界面上那一格永远显示着一个值（默认 call），名片里却什么都不写，
    // 平台会按「没有 param = launch」去推，与界面显示的那一格正好相反。
    const entry = {
      name,
      label: trim(row && row.label) || name,
      applies_at: applies || (param ? 'call' : 'launch'),
    }
    if (param) {
      entry.param = param
      flags[param] = trim(row && row.flag)
    }
    list.push(entry)
  }

  if (list.length) m.weights = list
  else delete m.weights

  const next = list.map((s) => s.param).filter(Boolean)
  const gone = prev.filter((p) => !next.includes(p))
  return wire(m, gone, next, flags)
}

// 三个名单（param_keys / payload_keys / params.call_time）是同一条规矩：
// 先摘掉不再是任何一位的键，再补上新位的键。本来没写这一段、现在也无需写时原样返回，
// 免得把「名片没有这一段」改成「名片写了空的」。
function mergeKeys (cur, add, remove) {
  const base = Array.isArray(cur) ? cur : []
  const out = base.filter((k) => !remove.includes(k))
  for (const k of add) if (!out.includes(k)) out.push(k)
  if (!out.length && !Array.isArray(cur)) return cur
  return out
}

// 这一条 call.args 是我们写的吗：只认「一个键、值就是 --<参数名>」这种默认形状。
// 带 style / role 的条目是人调过的，改开关也不该覆盖它。
function isOurs (entry, param) {
  if (!entry || typeof entry !== 'object') return false
  const keys = Object.keys(entry)
  return keys.length === 1 && keys[0] === 'flag' && entry.flag === '--' + param
}

function wire (m, gone, next, flags) {
  if (Array.isArray(m.parameters)) {
    // 新版名片：四份视图由 parameters[] 派生，只能改这一份。
    const kept = m.parameters.filter((p) => !(p && gone.includes(p.name)))
    const have = new Set(kept.map((p) => p && p.name))
    const added = next
      .filter((p) => !have.has(p))
      .map((p) => ({ name: p, type: 'file', tier: 'advanced' }))
    const merged = [...kept, ...added]
    if (merged.length) m.parameters = merged
    else delete m.parameters
  } else {
    m.param_keys = mergeKeys(m.param_keys, next, gone)
    m.payload_keys = mergeKeys(m.payload_keys, next, gone)
    const params = { ...(m.params || {}) }
    const callTime = mergeKeys(params.call_time, next, gone)
    if (callTime !== undefined) params.call_time = callTime
    else delete params.call_time
    // 由通用宿主托管的引擎，宿主那份名片必须有 load_time（缺了开进程就 FATAL）。
    if (m.call && next.length && params.load_time === undefined) params.load_time = []
    if (Object.keys(params).length) m.params = params
    else delete m.params
  }

  // 命令行形态才需要开关形状：python 形态的参数名就是方法参数名，宿主直接塞 kwargs。
  if (!(m.call && m.call.kind === 'cli')) return m
  const args = { ...(m.call.args || {}) }
  for (const p of gone) if (isOurs(args[p], p)) delete args[p]
  for (const p of next) {
    const want = flags[p] || '--' + p
    if (!args[p]) args[p] = { flag: want }
    else if (isOurs(args[p], p) && args[p].flag !== want) args[p] = { flag: want }
  }
  const call = { ...m.call }
  if (Object.keys(args).length) call.args = args
  else delete call.args
  m.call = call
  return m
}
