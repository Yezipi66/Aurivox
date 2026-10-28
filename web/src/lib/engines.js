// 引擎列表、参数面板和状态徽章的前端数据层，界面内容全由 manifest.json 决定。
// 不写具体引擎名或参数名（有守卫测试）。纯函数，便于 `node --test` 在无 DOM 环境下测试。

// 必须带 .js 后缀：`node --test` 不能解析无后缀导入。
import { api } from './api.js'

export const TIERS = ['common', 'advanced']

// 获取引擎列表。默认 probe=0，不逐台探活：探活要走网络，一台超时会拖住整个列表。
export function fetchEngines({ probe = false } = {}) {
  return api(`/api/engines?probe=${probe ? 1 : 0}`).then(r => {
    if (!r.ok) {
      return { ok: false, engines: [], errors: [], error: (r.data && r.data.error) || `HTTP ${r.status}` }
    }
    const d = r.data || {}
    return {
      ok: true,
      engines: Array.isArray(d.engines) ? d.engines : [],
      // 名片解析失败的引擎在 errors 里，界面必须显示，不能让它从列表中消失。
      errors: Array.isArray(d.errors) ? d.errors : [],
      notice: d.notice || null,
      error: null,
    }
  })
}

// 选择当前引擎：上次选的（仍存在时）→ 列表第一台 → null。不写死默认引擎 id。
export function pickEngine(engines, savedId) {
  const list = Array.isArray(engines) ? engines : []
  if (savedId) {
    const found = list.find(e => e && e.id === savedId)
    if (found) return found
  }
  return list.length ? list[0] : null
}

// 训练页仅在 supports_finetune === true 时显示，未加载时也隐藏。
export function showsTrainingTab(engine) {
  return !!(engine && engine.supports_finetune === true)
}

// 启动 / 停止只发请求并原样返回，不做可行性判断，也不吞掉错误。
export function startEngine (id, { weights, confirmed } = {}) {
  const body = {}
  if (weights) body.weights = weights
  // 后端用「有没有 confirmed 键」区分未表态和拒绝，所以只在显式传入时才带。
  if (confirmed !== undefined) body.confirmed = !!confirmed
  return api(`/api/engines/${encodeURIComponent(id)}/start`, { method: 'POST', body })
}

export function stopEngine (id) {
  return api(`/api/engines/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} })
}

// 名片 maps 是否映射了某个平台参数（文本、参考音频、语种等；引擎自有参数看 param_schema）。
// mapped_keys 缺失时返回 true：多显示一个控件无害，漏显示不易察觉。
export function hasMappedKey(engine, key) {
  if (!engine) return true
  const keys = engine.mapped_keys
  if (!Array.isArray(keys)) return true
  return keys.includes(key)
}

export function fieldsForTier(engine, tier) {
  const schema = (engine && Array.isArray(engine.param_schema)) ? engine.param_schema : []
  // 未写 tier 归入 advanced，与后端 profile.js 一致；缓存数据可能未经后端规整。
  return schema.filter(f => f && (f.tier === 'common' ? 'common' : 'advanced') === tier)
}

// param_schema 为空但 param_keys 非空时提示补写 schema，避免空面板被误解为没有参数。
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
      `engines/${engine.id}/manifest.json 未声明 params.schema，` +
      `因此此处无法显示参数配置项。该引擎实际接受 ${keys.length} 个参数` +
      `（manifest.json 的 param_keys 中有列出）；补充 params.schema 后即可在此处显示。`,
  }
}

// 面板初值，取各字段的 default。注意它不同于名片的 defaults.<键>。
export function initialParamValues(engine) {
  const out = {}
  for (const f of (engine && Array.isArray(engine.param_schema) ? engine.param_schema : [])) {
    if (f && f.name !== undefined && f.default !== undefined) out[f.name] = f.default
  }
  return out
}

// 五种参数样式，须与后端保持一致，否则后端接受的字段前端无法渲染。
export const PARAM_TYPES = ['text', 'number', 'select', 'boolean', 'file']

// 旧类型名（integer、enum、path 等）归一为五种之一，兼容旧 schema 和第三方名片。
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

export function repeatOf(field) {
  const n = field && field.repeat
  return Number.isInteger(n) && n > 1 ? n : 1
}

export function wantsArray(field) {
  return repeatOf(field) > 1 || (field && field.multi === true)
}

// 把界面输入转为字段类型。失败时返回 default，不返回 0，以免清空输入框被当成设为 0。
export function coerceParamValue(field, raw) {
  if (!field) return raw
  const fallback = field.default

  // 数组字段逐项转换；任一项失败或长度不符，整体退回 default。
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
      // 整数字段用 parseInt，避免把 7.5 发给只接受整数的引擎。
      const n = (field.int === true || field.type === 'integer' || field.type === 'int')
        ? parseInt(raw, 10)
        : parseFloat(raw)
      return Number.isFinite(n) ? n : fallback
    }
    case 'boolean':
      return raw === true || raw === 'true'
    case 'select': {
      // 选项来自运行时扫盘（source）或允许自定义（allow_custom）时不校验候选。
      if (field.source || field.allow_custom === true) {
        return raw === null || raw === undefined ? fallback : raw
      }
      const choices = Array.isArray(field.choices) ? field.choices : []
      return choices.some(c => (c && typeof c === 'object' ? c.value : c) === raw) ? raw : fallback
    }
    case 'file': {
      // 空值表示用户清空，不退回 default；paramsToSend 会跳过空路径。
      if (raw === '' || raw === null || raw === undefined) return ''
      // 字符串路径和配方中的 { base, path } 对象都原样保留，由 pathResolver 解析。
      if (typeof raw === 'string' || typeof raw === 'object') return raw
      return String(raw)
    }
    case 'text':
      return raw === null || raw === undefined ? fallback : String(raw)
    default:
      return raw
  }
}

// 是否为文件路径字段。从平台库中选择是 select + source，不是 file。
export function isPathField(field) {
  return !!(field && canonicalType(field.type) === 'file')
}

export function selectSourceOf(field) {
  if (!field || canonicalType(field.type) !== 'select') return null
  return typeof field.source === 'string' && field.source ? field.source : null
}

// only_when 引用的键不存在时照常显示，以免名片拼错键名导致字段消失。
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

export function pathFields(engine) {
  const schema = (engine && Array.isArray(engine.param_schema)) ? engine.param_schema : []
  return schema.filter(isPathField)
}

// 请求体 engine_params：只含 schema 中存在、当前可见、用户改过的字段，默认值由后端或引擎补。
// 空路径不发，否则引擎会尝试打开空路径。
export function paramsToSend(engine, values, touched) {
  const schema = (engine && Array.isArray(engine.param_schema)) ? engine.param_schema : []
  const seen = touched instanceof Set ? touched : new Set(Array.isArray(touched) ? touched : [])
  const out = {}
  for (const f of schema) {
    if (!f || f.name === undefined) continue
    const has = values && Object.prototype.hasOwnProperty.call(values, f.name)
    if (!has) continue
    // 隐藏字段的值保留在界面中，但不发送。
    if (!isFieldVisible(f, values)) continue
    if (isPathField(f) && (values[f.name] === '' || values[f.name] == null)) continue
    if (seen.has(f.name)) out[f.name] = values[f.name]
  }
  return out
}

// 按字段 phase 把 paramsToSend 的结果分成调用参数（call）和启动参数（load）。
export function paramsByPhase(engine, values, touched) {
  const explicit = paramsToSend(engine, values, touched)
  const schema = (engine && Array.isArray(engine.param_schema)) ? engine.param_schema : []
  const byName = new Map(schema.filter(Boolean).map(field => [field.name, field]))
  const call = {}
  const load = {}
  for (const [name, value] of Object.entries(explicit)) {
    const target = byName.get(name)?.phase === 'load' ? load : call
    target[name] = value
  }
  return { call, load }
}

export function textOf(node, lang, fallback = '') {
  if (node == null) return fallback
  if (typeof node === 'string') return node
  return node[lang] || node.en || fallback
}

export function fieldLabel(field, lang) {
  return textOf(field && field.label, lang, (field && field.name) || '')
}

export function fieldHelp(field, lang) {
  return textOf(field && field.help, lang, '')
}

// 底模徽章：判断在后端 checkpoints.js 完成，这里只转成文字。无 checkpoints 段时返回 null。
export function checkpointBadge(engine, lang = 'zh') {
  const c = engine && engine.checkpoints
  if (!c) return null

  const zh = lang !== 'en'
  const lines = []

  if (!c.declared) {
    // 名片未声明底模目录时显示「?」，不能显示成缺失。
    return {
      tone: 'unknown',
      label: zh ? '底模 ?' : 'weights ?',
      title: c.reason || (zh ? '该引擎的清单未声明底模目录' : 'manifest does not declare a checkpoints dir'),
    }
  }

  lines.push((zh ? '底模目录：' : 'Checkpoints: ') + c.abs_path)
  if (c.path_source && c.path_source !== 'manifest') {
    lines.push((zh ? '（来自环境变量 ' : '(from env ') + c.path_source.replace(/^env:/, '') + '）')
  }
  if (c.reason) lines.push(c.reason)
  if (c.ready !== true && c.hint) lines.push('', c.hint)
  if (c.ready !== true && c.source) {
    if (c.source.license_gate) {
      lines.push('', zh
        ? '⚠ 需先在模型主页接受许可才能下载（否则会返回 401/403，表现为网络故障）'
        : '⚠ You must accept the license on the model page first (otherwise 401/403)')
    }
    if (c.source.url) lines.push((zh ? '模型主页：' : 'Model page: ') + c.source.url)
    if (Array.isArray(c.source.command)) {
      lines.push(zh
        ? `取回命令（在 ${c.source.cwd} 下执行）：`
        : `Fetch (run in ${c.source.cwd}):`)
      lines.push(c.source.command.join(' '))
    }
  }

  if (c.ready === true) {
    return { tone: 'ok', label: zh ? '底模就绪' : 'weights ok', title: lines.join('\n') }
  }
  if (c.ready === false) {
    const n = Array.isArray(c.missing) ? c.missing.length : 0
    // 灯面回答的是「能不能用」，所以只写「缺底模」。
    // 缺几项、缺哪几个说的是严重程度和去哪儿补，不改变答案，也不改变动作，进悬停。
    if (n > 0) {
      lines.push('', (zh ? `缺 ${n} 项：` : `Missing ${n}: `)
        + c.missing.join(zh ? '、' : ', '))
    }
    return {
      tone: 'bad',
      label: zh ? '缺底模' : 'no weights',
      title: lines.join('\n'),
    }
  }
  return { tone: 'unknown', label: zh ? '底模 ?' : 'weights ?', title: lines.join('\n') }
}

// 进程徽章。三种「未运行」分开显示：process 为 null（不管理，不显示）、
// running 为 false（正常待命，灰色）、online 但非本平台启动（外部进程）。
// 启动中要明确提示，载入模型可能需要几十秒到几分钟。
export function processBadge (engine, lang = 'zh') {
  if (!engine) return null
  const p = engine.process
  // null / undefined 表示不管理，不是未运行。
  if (p === null || p === undefined) return null

  const zh = lang !== 'en'
  const lines = []

  if (p.running !== true) {
    if (engine.online === true) {
      return {
        tone: 'unknown',
        label: zh ? '外部进程' : 'external',
        launchKey: null,
        title: zh
          ? '该引擎正在运行，但并非由本平台启动（通常是作者在另一个窗口中手动启动）。\n' +
            '⇒ 不会去停它，更换模型时也不会重新启动它。'
          : 'Engine is up but was not started by this app; it will not be stopped or relaunched here.',
      }
    }
    return {
      tone: 'idle',
      label: zh ? '待命' : 'idle',
      launchKey: null,
      title: zh
        ? '当前未在运行：这是正常状态。\n' +
          '⇒ 下次使用时会自动启动；启动时需要等待模型载入内存。'
        : 'Not running — this is normal. It will start automatically on first use.',
    }
  }

  if (p.pid) lines.push((zh ? '进程号：' : 'PID: ') + p.pid)
  if (p.launch_key) {
    // 显示进程当前载入的模型，便于核对选择是否生效。
    lines.push((zh ? '现在装的是：' : 'Loaded: ') + p.launch_key)
  }

  if (p.phase && p.phase !== 'ready') {
    lines.push('', zh
      ? '正在将模型载入内存，此过程可能需要数十秒至数分钟。\n不要重复点击：重复点击只会排队等待，速度更慢。'
      : 'Loading the model into memory; this can take a while. No need to click again.')
    return {
      tone: 'busy',
      label: zh ? '启动中…' : 'starting…',
      title: lines.join('\n'),
      // 单独返回 launchKey，供 engineBadge 显示。
      launchKey: p.launch_key || null,
    }
  }

  if (p.busy === true) {
    lines.push('', zh ? '正在合成。' : 'Synthesising.')
    return {
      tone: 'busy', label: zh ? '合成中' : 'busy', title: lines.join('\n'),
      launchKey: p.launch_key || null,
    }
  }

  return {
    tone: 'ok', label: zh ? '运行中' : 'running', title: lines.join('\n'),
    launchKey: p.launch_key || null,
  }
}

// 把轮询到的 process 合并进现有列表。无变化时返回原数组和原元素，避免 useEffect 每轮重跑；
// 名片和参数不随轮询更新，以免覆盖正在编辑的面板。
export function mergeProcessState (engines, fresh) {
  if (!Array.isArray(engines) || !Array.isArray(fresh)) return engines
  const byId = new Map()
  for (const f of fresh) if (f && f.id) byId.set(f.id, f)

  let changed = false
  const next = engines.map((e) => {
    if (!e || !e.id || !byId.has(e.id)) return e
    const p = byId.get(e.id).process
    // 按内容比较：服务端每次返回新对象，引用比较永远不等。
    if (JSON.stringify(p ?? null) === JSON.stringify(e.process ?? null)) return e
    changed = true
    return Object.assign({}, e, { process: p ?? null })
  })
  return changed ? next : engines
}

// 顶栏引擎徽章，只显示最需要处理的一项：底模缺失（红，唯一的红色）> 启动中 > 合成中
// > 运行中 > 待命（灰，按需启动下未运行是正常的）。悬停里放底模那一段与正在载入的模型。
//
// 灯面上只写状态，不写引擎名。名字在多台引擎时已经在下拉选择器里，
// 拼成「名字 · 状态」之后这枚灯变成一句话：名字来自名片，可能长到三十几个字，
// 一拼就把顶栏撑爆，而读起来还像两个并列的结论。名字进悬停第一行，任何状态下都查得到。
export function engineBadge (engine, health, lang = 'zh') {
  if (!engine) return null

  const zh = lang !== 'en'
  const name = engine.label || engine.id || (zh ? '引擎' : 'engine')
  const ck = checkpointBadge(engine, lang)
  const pr = processBadge(engine, lang)

  // 底模那一段整段收进悬停，不再只挑出目录那一行：
  // 缺几项、缺哪几个、名片写的取回命令都在里面，灯面省下的字一个都不能丢在这儿。
  const ckText = ck && ck.title ? String(ck.title).trim() : ''
  const launching = pr && pr.launchKey
  const body = (() => {
    const head = ckText || (zh ? '这台引擎的名片没写底模在哪' : 'manifest does not declare a checkpoints dir')
    return launching
      ? [head, '', (zh ? `正在装：${pr.launchKey}` : `Loading: ${pr.launchKey}`)].join('\n')
      : head
  })()
  // 名字单独占第一行：灯面越短，这个位置越需要能一眼确认「说的是哪台」。
  const title = `${name}\n${body}`

  if (ck && ck.tone === 'bad') {
    return { tone: 'bad', label: ck.label, title }
  }

  if (pr) {
    return { tone: pr.tone, label: pr.label, title }
  }

  // 本机不管理进程时，平台不知道引擎状态，显示中性灰色，不显示离线或红灯。
  // 灯面上仍要有字，但只能写我们知道的那件事：这台的进程不归平台管。
  return {
    tone: 'idle',
    label: zh ? '不管理进程' : 'unmanaged',
    title,
  }
}


// 内存占用徽章：数据由后端 occupancy.js 计算，这里只负责显示。
// 占用值是历史峰值；null 表示从未测量，不能显示成 0（0 意味着不占内存）。

// 格式化 MB 数；未知或非正数显示「?」。
export function fmtMemMb (mb) {
  if (mb === null || mb === undefined || !Number.isFinite(Number(mb))) return '?'
  const n = Number(mb)
  if (n <= 0) return '?'
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`
  return `${Math.round(n)} MB`
}

// 整机占用徽章。occ 为 { engines, summary, headline }，缺失或结构不符时返回 null。
export function occupancyBadge (occ, lang = 'zh') {
  if (!occ || typeof occ !== 'object') return null
  const zh = lang !== 'en'

  // 后端读取失败时显示「无法读取」，不能显示成没有占用。
  if (typeof occ.error === 'string' && occ.error) {
    return {
      tone: 'unknown',
      label: zh ? '占用：无法读取' : 'usage: unknown',
      detail: [occ.error],
      title: (zh ? '无法读取占用情况' : 'cannot read usage') + '\n\n' + occ.error,
    }
  }

  // 键名须与后端 occupancyReport() 一致（summary.free_mb 等）。
  const sum = occ.summary
  if (!Array.isArray(occ.engines) || !sum || typeof sum !== 'object') return null

  const detail = []
  detail.push(zh
    ? `装了 ${sum.installed} 台引擎`
    : `${sum.installed} engine(s) installed`)
  detail.push(zh
    ? (sum.running ? `${sum.running} 台运行中` : '当前无引擎在运行（按需启动）')
    : (sum.running ? `${sum.running} running` : 'none running (start on demand)'))
  if (sum.resident_peak_mb > 0) {
    detail.push(zh
      ? `运行中引擎的峰值合计约 ${fmtMemMb(sum.resident_peak_mb)}`
      : `running peak ~${fmtMemMb(sum.resident_peak_mb)}`)
  }
  // 未测量的引擎风险最高，排在剩余内存之前。
  if (sum.unknown_count > 0) {
    detail.push(zh
      ? `⚠ ${sum.unknown_count} 台从未测量过占用`
      : `⚠ ${sum.unknown_count} never measured`)
  }
  if (Number.isFinite(sum.free_mb) && Number.isFinite(sum.total_mb)) {
    detail.push(zh
      ? `系统剩余 ${fmtMemMb(sum.free_mb)} / 共 ${fmtMemMb(sum.total_mb)}`
      : `free ${fmtMemMb(sum.free_mb)} / ${fmtMemMb(sum.total_mb)}`)
  }

  const label = zh
    ? `占用：${sum.running} 台运行中`
    : `usage: ${sum.running} running`

  // 优先使用后端生成的 headline，避免前后端措辞不一致。
  const title = (occ.headline || (zh ? '平台此刻占用了什么' : 'what the platform is using'))
    + '\n\n' + detail.join('\n')

  return {
    // 未测量的提示只放 detail，不升级 tone。
    tone: sum.running ? 'ok' : 'idle',
    label,
    detail,
    title,
  }
}

// 单台引擎占用徽章，优先级：上次启动失败 > 运行中 > 未运行但有峰值 > 未测量。
export function engineUsageBadge (eng, occ, lang = 'zh') {
  if (!eng || !occ || typeof occ !== 'object') return null
  const zh = lang !== 'en'
  const list = Array.isArray(occ.engines) ? occ.engines : []
  const row = list.find((e) => e && e.id === eng.id)
  if (!row) return null
  const name = eng.label || eng.id || (zh ? '引擎' : 'engine')

  if (row.last_attempt_unfinished) {
    return {
      tone: 'bad',
      label: zh ? `${name} · 上次启动失败` : `${name} · last attempt failed`,
      title: (zh
        ? '上一次启动该引擎未成功（通常是内存不足被系统终止）。\n重新启动前，请先停止其他若干台引擎。'
        : 'last start of this engine did not survive (likely OOM).\nstop a few others before retrying.'),
    }
  }

  if (row.running && row.peak_mb !== null && row.peak_mb !== undefined) {
    return {
      tone: 'busy',
      label: zh ? `${name} · 峰值 ${fmtMemMb(row.peak_mb)}` : `${name} · peak ${fmtMemMb(row.peak_mb)}`,
      title: (zh
        ? `运行中。历史峰值为 ${fmtMemMb(row.peak_mb)}。`
        : `running. peaked at ${fmtMemMb(row.peak_mb)}.`),
    }
  }
  if (row.running) {
    return {
      tone: 'busy',
      label: zh ? `${name} · 运行中（未测量占用）` : `${name} · running (usage unmeasured)`,
      title: zh
        ? '运行中，但其内存占用量尚未测量：该数值只能通过实际启动测得。'
        : 'running, but its memory use has never been measured.',
    }
  }
  if (row.peak_mb !== null && row.peak_mb !== undefined) {
    return {
      tone: 'idle',
      label: zh ? `${name} · 峰值 ${fmtMemMb(row.peak_mb)}` : `${name} · peak ${fmtMemMb(row.peak_mb)}`,
      title: zh
        ? `未在运行。启动后预计占用约 ${fmtMemMb(row.peak_mb)}（上次测量的峰值）。`
        : `not running. last measured peak ${fmtMemMb(row.peak_mb)}.`,
    }
  }
  return {
    tone: 'unknown',
    label: zh ? `${name} · 占用未测量` : `${name} · usage unmeasured`,
    title: zh
      ? '该引擎的内存占用量尚未测量：该数值只能通过实际启动测得。\n（若显示为 0 会被误读为「不占用内存」，这是不准确的。）'
      : 'never measured. A 0 here would falsely mean "uses no memory".',
  }
}
