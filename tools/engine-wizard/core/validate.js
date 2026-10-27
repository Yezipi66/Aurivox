'use strict'
const path = require('path')
const { SECTIONS_BY_KEY, PARAM_FIELDS_BY_KEY, DANGER } = require('./fieldmeta')

// 平台的派生器（导出的、稳定的）。它是「一份 parameters[] → 5 份视图」那一步的权威。
const { deriveParameterViews } = require(
  path.resolve(__dirname, '..', '..', '..', 'lib', 'engines', 'parameterDeclaration.js')
)

// 平台的字段判据原语：required / requiredBool / positiveInt / parseClipSeconds。
// 「这个键缺了算不算缺」不重写在这里，直接问平台自己：
// 三个函数判「缺」的方式各不相同（空串算不算缺、null 算不算缺），
// 抄一遍就会漂。
const platform = require(
  path.resolve(__dirname, '..', '..', '..', 'lib', 'engines', 'profile', 'fields.js')
)

// 平台的解析器。路径从向导自己的位置算回去：向导是独立工具，
// 不假定自己被放在哪（可以被拷走单独用）。
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
let _profile = null
function platformProfile () {
  if (!_profile) _profile = require(path.join(REPO_ROOT, 'lib', 'engines', 'profile.js'))
  return _profile
}
let _registry = null
function registry () {
  if (!_registry) {
    _registry = require(path.join(REPO_ROOT, 'lib', 'engines', 'registry.js'))
  }
  return _registry
}

function locate (keyPath, manifest) {
  // key 形如 'parameters[3].phase' / 'runtime.python' / 'manifest.json 里…'
  if (typeof keyPath !== 'string') return null
  const m = keyPath.match(/^(\w+)(?:\[(\d+)\])?\.?(\w+)?$/)
  if (!m) return { section: null, field: keyPath }
  const [, section, index, field] = m
  const meta = SECTIONS_BY_KEY[section]
  return {
    section,
    field: field || section,
    index: index === undefined ? null : Number(index),
    sectionMeta: meta || null,
    danger: meta ? meta.danger : DANGER.BLOCK,
  }
}

function diagnose (manifest) {
  const out = []
  const push = (level, code, message, where) => out.push({ level, code, message, ...where })

  // ---- 1. 交给平台的派生链（它抛 = 硬错）----------------------------
  try {
    resolveFromObject(manifest)
  } catch (e) {
    const at = locate(e.key, manifest)
    push('error', e.code || 'ENGINE_MANIFEST_INVALID',
      e.message, at || {})
    // 派生失败就别往下检了：后面的结论会建立在错的前提上
    return out
  }

  // ---- 2. 平台不拦、但会「设了没效果」的那一类 ------------------------

  const ps = Array.isArray(manifest.parameters) ? manifest.parameters : []
  ps.forEach((p, i) => {
    if (!p || typeof p !== 'object') return
    const meta = PARAM_FIELDS_BY_KEY[p.name] ? PARAM_FIELDS_BY_KEY[p.name] : null
    const where = { section: 'parameters', field: p.name, index: i,
      sectionMeta: meta || null, danger: DANGER.SILENT }

    if (p.phase === undefined) {
      push('info', 'PHASE_DEFAULTED',
        `参数「${p.name}」没写 phase，默认按 call（每次调用）处理。`, where)
    }
    if (p.tier === undefined) {
      push('info', 'TIER_DEFAULTED',
        `参数「${p.name}」未声明 tier，默认归入 advanced（进阶档），常用档仅显示常用项。`, where)
    }
    if (p.label === undefined) {
      push('warn', 'LABEL_MISSING',
        `参数「${p.name}」没有 label，界面上会显示英文参数名。`, where)
    }
  })

  // weights[].applies_at：填错不报错，但模型换了声音不变
  const ws = Array.isArray(manifest.weights) ? manifest.weights : []
  ws.forEach((w, i) => {
    if (!w || typeof w !== 'object') return
    const where = { section: 'weights', field: w.id || `第${i + 1}个`,
      index: i, sectionMeta: SECTIONS_BY_KEY.weights, danger: DANGER.SILENT }
    if (w.applies_at === undefined) {
      push('warn', 'WEIGHT_APPLIES_AT_MISSING',
        `模型位「${w.id || i + 1}」没写 applies_at，运行中换不了权重（下拉照列，但选择不会发出去）。`, where)
    }
  })

  // ---- 3. 顶层必填（平台会抛，这里只是提前说）----------------------
  for (const key of ['id', 'label', 'runtime']) {
    if (manifest[key] === undefined) {
      push('error', 'ENGINE_MANIFEST_INCOMPLETE',
        `少了顶层必填项「${key}」。`, {
        section: key, field: key, sectionMeta: SECTIONS_BY_KEY[key] || null,
        danger: DANGER.BLOCK,
      })
    }
  }

  // ---- 3b. 必填 5 项（缺一个就接不上平台）---------------------------
  //
  // 平台只要求人答这 5 项（lib/engines/profile.js 的 DEFAULTS 上方）：
  //   call.bind 的 text / ref_audio / output_path（output_path 只在 call.returns 是 file 时要）
  //   runtime.python / runtime.entry
  // 其余各项缺了平台推断或用保守默认，这里不报缺；写了值才校验值本身。
  //
  // 判据不重写：缺不缺、值成不成立，直接调平台自己的 required / positiveInt / parseClipSeconds。
  const rt = manifest.runtime || {}
  const callObj = (manifest.call && typeof manifest.call === 'object') ? manifest.call : {}
  const bindObj = callObj.bind || {}
  const returns = callObj.returns || 'file'
  const isSharedHost = platformProfile().isSharedHost
  // 三个输入槽位是通用宿主读的（lib/engines/hostProfile.js）。引擎自带服务脚本、
  // 又没写 call 段的（老引擎自己起 HTTP），平台不经宿主调它，槽位无处可去，不要求。
  const needsBind = !!manifest.call || (!!rt.entry && isSharedHost(rt.entry))
  const REQUIRED_KEYS = [
    { path: 'call.bind.text', v: bindObj.text, section: 'call', when: needsBind },
    { path: 'call.bind.ref_audio', v: bindObj.ref_audio, section: 'call', when: needsBind },
    { path: 'call.bind.output_path', v: bindObj.output_path, section: 'call', when: needsBind && returns === 'file' },
    { path: 'runtime.python', v: rt.python, section: 'runtime' },
    { path: 'runtime.entry', v: rt.entry, section: 'runtime' },
    // 启动脚本不是平台通用宿主 ⇒ 平台不知道就绪端点，照旧必填。
    { path: 'runtime.ready_endpoint', v: rt.ready_endpoint, section: 'runtime',
      when: !!rt.entry && !isSharedHost(rt.entry) },
  ]
  for (const req of REQUIRED_KEYS) {
    if (req.when === false) continue
    try {
      platform.required({ id: manifest.id }, req.path, req.v, '')
    } catch (e) {
      push('error', e.code || 'ENGINE_MANIFEST_INCOMPLETE',
        `少了必填项「${req.path}」。`, {
          section: req.section, field: req.path, sectionMeta: SECTIONS_BY_KEY[req.section] || null,
          danger: DANGER.BLOCK,
        })
    }
  }

  // 可选的数：写了才查值（正整数）。
  const caps = manifest.capabilities || {}
  const OPTIONAL_INTS = [
    ['runtime.ready_timeout_ms', rt.ready_timeout_ms, 'runtime'],
    ['timeout_ms', manifest.timeout_ms, 'timeout_ms'],
    ['max_chars', manifest.max_chars, 'max_chars'],
    ['capabilities.output_sample_rate', caps.output_sample_rate, 'capabilities'],
  ]
  for (const [keyPath, v, section] of OPTIONAL_INTS) {
    if (v === undefined || v === null) continue
    try {
      platform.positiveInt({ id: manifest.id }, keyPath, v)
    } catch (e) {
      push('error', e.code || 'ENGINE_MANIFEST_INVALID_VALUE',
        `「${keyPath}」的值不成立：${e.message}`, {
          section, field: keyPath, sectionMeta: SECTIONS_BY_KEY[section] || null, danger: DANGER.BLOCK,
        })
    }
  }
  if (caps.requires_reference_audio !== undefined && typeof caps.requires_reference_audio !== 'boolean') {
    push('error', 'ENGINE_MANIFEST_INVALID_VALUE',
      `「capabilities.requires_reference_audio」必须是 true 或 false，现在写的是 ${JSON.stringify(caps.requires_reference_audio)}。`, {
        section: 'capabilities', field: 'capabilities.requires_reference_audio',
        sectionMeta: SECTIONS_BY_KEY.capabilities || null, danger: DANGER.BLOCK,
      })
  }

  // reference_clip_seconds：缺 = 不限制（平台按 null 处理）；写了才查形状。
  if (caps.reference_clip_seconds !== undefined && caps.reference_clip_seconds !== null) {
    // 平台只收 null 或 [最短秒, 最长秒]（profile/fields.js 的 parseClipSeconds）。
    try {
      platform.parseClipSeconds({ id: manifest.id }, caps.reference_clip_seconds)
    } catch (e) {
      push('error', e.code || 'ENGINE_MANIFEST_INVALID_VALUE',
        `「capabilities.reference_clip_seconds」的值不成立：${e.message}`, {
        section: 'capabilities', field: 'capabilities.reference_clip_seconds',
        sectionMeta: SECTIONS_BY_KEY.capabilities || null, danger: DANGER.BLOCK,
      })
    }
  }

  // ---- 4. _source 硬规则（profile.js checkMeasuredSources，落盘前提前报）--
  const MEASURED_SOURCES = Object.freeze(['measured', 'upstream', 'estimated'])
  // [数据键, _source 键, 所在段, 段名]。前两个在顶层，第三个在 runtime 段内。
  const MEASURED_PAIRS = Object.freeze([
    ['max_chars', 'max_chars_source', manifest, 'manifest.json 顶层'],
    ['timeout_ms', 'timeout_ms_source', manifest, 'manifest.json 顶层'],
    ['ready_timeout_ms', 'ready_timeout_ms_source', manifest.runtime, 'runtime 段'],
  ])
  for (const [key, srcKey, obj, segment] of MEASURED_PAIRS) {
    // 这类数可以不写（留空合法），不校验；写了就必须同时写明出处
    if (!obj || !(key in obj)) continue
    const srcMeta = SECTIONS_BY_KEY[srcKey] || null
    const where = {
      section: srcKey, field: srcKey, sectionMeta: srcMeta, danger: DANGER.BLOCK,
    }
    if (!(srcKey in obj)) {
      push('error', 'ENGINE_MANIFEST_MISSING_SOURCE',
        `${segment}写了 ${key} 但没有 ${srcKey}：${key} 是跑过才知道的数，` +
        `写了就必须说明它怎么来的（${MEASURED_SOURCES.join(' / ')}），` +
        '否则半年后没人分得清这是量出来的还是拍出来的。' +
        '（如果还未测量，把这一行删掉即可，平台会用保守值。）', where)
    } else if (!MEASURED_SOURCES.includes(obj[srcKey])) {
      // 值非法也是硬错：不认识的出处值会被平台拒绝（不能默默当成量出来的数）
      push('error', 'ENGINE_MANIFEST_INVALID_VALUE',
        `${segment}的 ${srcKey} 写的是 ${JSON.stringify(obj[srcKey])}：` +
        `必须是 ${MEASURED_SOURCES.join(' / ')} 之一` +
        '（measured=本项目实测，upstream=上游文档写的，estimated=推算/经验拍）。' +
        '不认识的出处值不能默默当实测用：一个 estimated 被当成 measured 去信，' +
        '平台会提前放弃一个还在正常加载的引擎。', where)
    }
  }

  return out
}

function resolveFromObject (manifest) {
  const strip = (obj) => {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue
      out[k] = v
    }
    return out
  }
  const stripped = strip(manifest)
  const derived = deriveParameterViews(stripped)
  return derived
}

function summarize (diagnostics) {
  const errors = diagnostics.filter(d => d.level === 'error')
  const warns = diagnostics.filter(d => d.level === 'warn')
  const infos = diagnostics.filter(d => d.level === 'info')
  return {
    ok: errors.length === 0,
    errors: errors.length,
    warns: warns.length,
    infos: infos.length,
    headline: errors.length
      ? `${errors.length} 个错误，填不进去`
      : warns.length
        ? `平台校验过了，但有 ${warns.length} 处「填了可能没效果」`
        : infos.length
          ? `平台校验过了（${infos.length} 条提示）`
          : '平台校验通过（注意：这不代表能出声，也不代表映射是对的）',
  }
}

module.exports = { diagnose, summarize, locate, REPO_ROOT }