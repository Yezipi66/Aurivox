'use strict'
// 反射 → parameters[] 草稿 + 平台词候选。复用 scaffold-params.cjs 的排除名单与判定函数。
const path = require('node:path')
const fs = require('node:fs')

// require 相对本文件解析（与 scaffold-params.cjs:24-26 同一条理由：
//   写成 '../scaffold-params.cjs' 会在 require 失败时被 catch 吞成
//   「读不到名片」，把「我写错路径」说成「你的名片坏了」）。
const SCAFFOLD = require(path.join(__dirname, '..', '..', 'scaffold-params.cjs'))

const { EXCLUDE, exclusionReason } = SCAFFOLD

// PLATFORM_KEYS 与 lib/engines/payload.js 的 CORE_KEYS + OPTIONAL_KEYS 逐字相同（测试比对）。
const PLATFORM_KEYS = Object.freeze([
  'text', 'text_lang', 'reference_audio', 'reference_text', 'reference_lang',
  'aux_reference_audio', 'speed', 'seed', 'media_type', 'streaming',
])

// 平台核心词在引擎那边的同名写法：软标记不排除，但挂 _platform_key 标记。
// 硬排除会同时干掉映射候选。
const PLATFORM_CANONICAL_VARIANTS = Object.freeze(new Set([
  'speed', 'seed', 'media_type', 'streaming', 'streaming_mode', 'text_lang',
  'text', 'reference_text', 'prompt_text',
]))

// 引擎参数名 → 平台词的启发式候选。一条正则 = 一档分，只留最高档。
const MAP_RULES = [
  { key: 'aux_reference_audio', score: 110,
    re: /^aux_?(ref_?)?(audio|wav)s?(_paths?)?$/,
    why: '名字像「辅助参考音频」' },
  { key: 'reference_audio', score: 100,
    re: /^(prompt_)?(ref_?)?(audio|wav|wave|voice)$|(^|_)(ref|reference|prompt|spk|speaker|cloned|clone|voice)_?(audio|wav|wave|voice)?_?(path|file)?$/,
    why: '名字像「参考音频」' },
  { key: 'reference_text', score: 95,
    re: /^(prompt_?)?(ref_?)?(text|transcript)$|_?(prompt|reference|ref)_?text$/,
    why: '名字像「参考音频的文字稿」' },
  { key: 'reference_lang', score: 90,
    re: /^(prompt|ref|reference|src)_?lang(uage)?$/,
    why: '名字像「参考音频的语言」' },
  { key: 'text_lang', score: 80, exact: 130,
    re: /^(text_?)?lang(uage)?$|_lang$|^lang_/,
    why: '名字像「语言」' },
  { key: 'speed', score: 80,
    re: /^speed$|^speed_?(factor|ratio|scale)$|_speed$/,
    why: '名字像「语速」' },
  { key: 'seed', score: 90,
    re: /^seed$/,
    why: '上游的参数名就是 seed' },
  { key: 'streaming', score: 70,
    re: /^stream(ing)?(_mode)?$/,
    why: '名字像「流式」' },
  { key: 'media_type', score: 60,
    re: /^(media_?)?(type|format)$/,
    why: '名字像「输出格式」' },
  { key: 'text', score: 50,
    re: /^(tts_)?text$/,
    why: '名字像「要合成的文本」' },
]

/** 引擎参数名 → 平台词候选列表（分数降序）。字面相同优先（exact 档）。 */
function candidatesFor (name) {
  const low = String(name || '').toLowerCase()
  const out = []
  for (const r of MAP_RULES) {
    if (!r.re.test(low)) continue
    const exact = r.exact && (low === r.key || low === r.key.replace(/_/g, ''))
    out.push({ platform_key: r.key, score: exact ? r.exact : r.score, why: r.why })
  }
  return out.sort((a, b) => b.score - a.score)
}

// 规则表里 reference_audio 那一档的分数（100）高于 text_lang 那一档（80），排序天然生效。
//   这一行是给读代码的人的说明，不是分支。

/** 平台词 → 这台引擎的参数名候选。 */
function mapCandidatesFor (params, existingMaps = {}) {
  const per = new Map()
  for (const p of params || []) {
    for (const c of candidatesFor(p.name)) {
      if (!per.has(c.platform_key)) per.set(c.platform_key, [])
      per.get(c.platform_key).push({ engine_param: p.name, phase: p.phase, ...c })
    }
  }
  const out = []
  for (const [platformKey, list] of per) {
    const sorted = list.sort((a, b) => b.score - a.score
      || a.engine_param.localeCompare(b.engine_param))
    const row = {
      platform_key: platformKey,
      already_mapped: Object.prototype.hasOwnProperty.call(existingMaps, platformKey),
      candidates: sorted.slice(0, 3).map(({ engine_param, phase, score, why }) => ({
        engine_param, phase, score, why,
      })),
    }
    if (row.already_mapped) row.current = existingMaps[platformKey]
    out.push(row)
  }
  return out.sort((a, b) => PLATFORM_KEYS.indexOf(a.platform_key)
    - PLATFORM_KEYS.indexOf(b.platform_key))
}

/** 平台核心词在引擎那边的同名写法。只标记，不排除。 */
function isPlatformCanonical (name) {
  return PLATFORM_CANONICAL_VARIANTS.has(String(name || '').toLowerCase())
}

// 交叉校验：名片 call.module 与上游 CLI 实际 import 的模块是否一致。
// 只读盘、不跑 import、不跑引擎代码。返回提醒，不拦截。

// 只取引擎自己的 CLI 文件名当入口（cliHelp.js 的 CLI_CANDIDATES）。
const CLI_ENTRY_NAMES = Object.freeze(new Set(
  require(path.join(__dirname, 'cliHelp.js')).CLI_CANDIDATES))

// 正则只认行首的 import（可有缩进），不解析 AST。
const IMPORT_FROM_RE = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(.+?)(?:#.*)?$/
const IMPORT_PLAIN_RE = /^\s*import\s+([A-Za-z_][\w.]*)\s*$/

/** 从一行 import 里把被导入的名字逐个拆出来。 */
function importedNames (clause) {
  return clause.replace(/[()\\]/g, ' ').split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean)
}

/** 从引擎目录里的 CLI 文件里，找出「import 了某个类」的语句。空数组 = 没有交叉证据。 */
function findClassImports (dir, cls) {
  const out = []
  if (!dir || !cls) return out
  let files = []
  try {
    files = require(path.join(__dirname, 'cliHelp.js')).findCliFiles(dir)
  } catch { return out }
  for (const rel of files) {
    if (!CLI_ENTRY_NAMES.has(path.basename(rel))) continue
    let text
    try { text = fs.readFileSync(path.join(dir, rel), 'utf8') } catch { continue }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const from = line.match(IMPORT_FROM_RE)
      if (from) {
        if (importedNames(from[2]).includes(cls)) {
          out.push({ file: rel.split(path.sep).join('/'), line: i + 1, module: from[1] })
        }
        continue
      }
      const plain = line.match(IMPORT_PLAIN_RE)
      if (plain && plain[1].split('.').pop() === cls) {
        out.push({ file: rel.split(path.sep).join('/'), line: i + 1, module: plain[1] })
      }
    }
  }
  return out
}

/** 交叉校验：名片 call.module 与上游 CLI 实际 import 的模块是否一致。返回提醒或 null。 */
function checkModuleMatchesCli ({ dir, module, cls }) {
  if (!dir || !module || !cls) return null
  if (!fs.existsSync(dir)) return null

  let files = []
  try {
    files = require(path.join(__dirname, 'cliHelp.js')).findCliFiles(dir)
  } catch { return null }
  const entries = files.filter((f) => CLI_ENTRY_NAMES.has(path.basename(f)))
  if (!entries.length) {
    return null
  }

  const hits = findClassImports(dir, cls)
  if (!hits.length) {
    return null
  }

  const same = hits.filter((h) => h.module === module)
  if (same.length) return null // CLI 里确实 import 了名片写的那个模块，一致

  const where = hits.map((h) => `${h.file}:${h.line}`).join('、')
  const mods = [...new Set(hits.map((h) => h.module))].join('、')
  return `交叉校验提醒：名片 call.module 写的是「${module}」，但上游 CLI `
    + `（${where}）import ${cls} 用的是「${mods}」。\n`
    + '  两者不是同一个模块 ⇒ 反射出的是那个模块的参数，可能与用户会敲的 '
    + 'CLI 不是同一套（多出的参数在真实 CLI 上根本不存在，缺的参数则完全看不见）。\n'
    + '  平台不改你的名片：哪一个模块是这台引擎该用的，取决于你的意图'
    + '（上游一份仓库里可以同时存在多个推理版本）。请自己核对后决定。'
}

/** 把反射结果变成给界面的草稿包。不写盘。 */
function buildDraftPackage (reflection, opts = {}) {
  if (!reflection || reflection.ok !== true) {
    return {
      ok: false,
      stage: (reflection && reflection.stage) || 'reflect',
      error: (reflection && reflection.error) || '反射没有给出结果',
      detail: (reflection && reflection.detail) || null,
    }
  }

  const draft = SCAFFOLD.buildDraft(reflection, { existing: opts.existing || [] })
  const parameters = draft.parameters

  const requiredByName = new Map()
  for (const phase of ['load', 'call']) {
    for (const e of (reflection[phase] || [])) {
      if (e && e.name) requiredByName.set(e.name, e.required === true)
    }
  }

  const excluded = draft.excluded.map((e) => {
    if (e.needs_human !== true) return e
    const required = requiredByName.get(e.name) === true
    return {
      ...e,
      _needs_review: true,
      ...(required ? { required: true } : {}),
      reason: required
        ? `必填参数，但平台看不出它是什么类型（${e.reason}）。这个必须由你来定：`
          + '它决定界面长出哪种控件，填错会把一个真实存在的旋钮永远藏起来。'
        : `平台看不出它是什么类型（${e.reason}）。这是可选项，确认类型后才能进界面。`,
    }
  })

  const allParams = [
    ...(reflection.load || []).map((e) => ({ ...e, phase: 'load' })),
    ...(reflection.call || []).map((e) => ({ ...e, phase: 'call' })),
  ].filter((p) => !p.skipped)

  for (const p of parameters) {
    if (requiredByName.get(p.name) === true) p.required = true
    if (isPlatformCanonical(p.name)) {
      p._platform_key = true
      p._why = '这个名字是平台核心词在引擎那边的写法：它多半该走 maps，'
        + '而不是重复出现在 parameters[] 里。删不删由你定。'
    }
  }

  const mapCandidates = mapCandidatesFor(allParams, opts.existingMaps || {})

  // call.bind 的槽位：反射器看不见的真实必填。读 manifest.call.bind 补进参数清单。
  const bindParams = []
  const bind = (opts.manifest && opts.manifest.call && opts.manifest.call.bind) || null
  if (bind && typeof bind === 'object') {
    for (const [slot, engineParam] of Object.entries(bind)) {
      if (typeof engineParam !== 'string' || !engineParam.trim()) continue
      const name = engineParam.trim()
      const hit = parameters.find((p) => p.name === name)
      const wasExcluded = excluded.some((e) => e.name === name)
      if (hit) {
        hit._bind_slot = slot
        hit._bind_slot_note = `名片 call.bind.${slot} 指向这个参数`
        if (hit.required !== true) hit.required = true
        continue
      }
      bindParams.push({
        name,
        type: 'REPLACE_ME',
        phase: 'call',
        tier: 'common',
        group: 'generate',
        order: 0,
        label: { en: name, zh: 'REPLACE_ME' },
        help: { en: 'REPLACE_ME (from call.bind)', zh: 'REPLACE_ME' },
        required: true,
        source: 'call.bind',
        _bind_slot: slot,
        _already_reflected: wasExcluded,
        _already_excluded: wasExcluded,
        _why: `来自名片 call.bind 的 ${slot} 槽位（→ ${name}）。`
          + '反射器不读 call.bind（BIND_SLOTS 里的名字在反射器里被整条跳过），'
          + '而它既然是 bind 槽位指向的真实引擎参数，就是这台引擎的真实入参。',
      })
    }
  }

  const allParameters = [...parameters, ...bindParams]

  return {
    ok: true,
    parameters: allParameters,
    excluded,
    map_candidates: mapCandidates,
    warnings: draft.warnings || [],
    partial: draft.partial,
    partial_reason: draft.partialReason || null,
    counts: {
      parameters: allParameters.length,
      excluded: excluded.length,
      map_candidates: mapCandidates.length,
      reflected: allParams.length,
      from_bind: bindParams.length,
    },
    caveat: '这是草稿：min / max / choices / 中英文标签反射拿不到，需要人逐条核对。',
  }
}

// 多方法合并：一台引擎声明了多个推理方法时，逐个反射再按参数名合并。
function mergeReflections (list) {
  const oks = (list || []).filter((r) => r && r.ok === true)
  if (!oks.length) {
    const first = (list || [])[0] || {}
    return { ok: false, stage: first.stage || 'reflect', error: first.error || '没有可用的反射结果' }
  }
  const head = oks[0]
  const out = {
    ok: true,
    python: head.python,
    class: head.class,
    method: head.method,
    partial: oks.some((r) => r.partial === true),
    partial_reason: oks.map((r) => r.partial_reason).filter(Boolean).join('；') || null,
    load: [],
    call: [],
    warnings: [],
    methods: oks.map((r) => r.method).filter(Boolean),
  }
  const seenLoad = new Set()
  const seenCall = new Set()
  for (const r of oks) {
    for (const w of (r.warnings || [])) out.warnings.push(w)
    for (const phase of ['load', 'call']) {
      for (const entry of (r[phase] || [])) {
        const seen = phase === 'load' ? seenLoad : seenCall
        if (seen.has(entry.name)) continue
        seen.add(entry.name)
        out[phase].push(entry)
      }
    }
  }
  return out
}

/** 反射一台引擎（可含多个方法）并直接产出草稿包。不写盘。 */
function reflectAndBuild (spec, opts = {}) {
  const methods = Array.isArray(opts.methods) && opts.methods.length
    ? opts.methods
    : [spec.method || null]
  const results = methods.map((m) => SCAFFOLD.reflectParams(
    { ...spec, method: m }, { timeoutMs: opts.timeoutMs }))
  const merged = mergeReflections(results)
  if (!merged.ok) return merged
  const pkg = buildDraftPackage(merged, opts)
  if (!pkg.ok) return pkg

  let cross = null
  try {
    cross = checkModuleMatchesCli({
      dir: Array.isArray(spec.sys_path) && spec.sys_path.length ? spec.sys_path[0] : null,
      module: spec.module,
      cls: spec.class,
    })
  } catch { cross = null }   // 读盘出错不许把整条反射拖下水：只少一句提醒

  if (cross) pkg.warnings = [...(pkg.warnings || []), cross]
  pkg.counts = { ...pkg.counts, cross_warnings: cross ? 1 : 0 }
  return pkg
}

// 端点入参 → 反射 spec。只做搬运：从盘上读名片，把事实抄进 spec。
const ROOT = path.join(__dirname, '..', '..', '..')

/** 把 POST /wizard/params 的 body 变成反射 spec。 */
function buildSpec (body, opts) {
  const b = body || {}
  const forCli = opts && opts.forCli  // cli 路线：只定位目录+python，不要 call.module/class
  if (!b.id || typeof b.id !== 'string') {
    return { ok: false, error: 'id is required（反射要知道去读哪个引擎目录）' }
  }
  const dir = path.join(ROOT, 'engines', b.id)
  if (!fs.existsSync(dir)) {
    return {
      ok: false,
      error: `引擎目录 ${b.id} 不存在。反射要在本机读源码，`
        + '请先回到第 1 步把源码克隆到 engines/' + b.id + '/',
    }
  }

  let manifest = {}
  const mf = path.join(dir, 'manifest.json')
  if (fs.existsSync(mf)) {
    try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')) } catch { manifest = {} }
  }
  const call = manifest.call || {}
  const rt = manifest.runtime || {}

  const mod = b.module || call.module
  const cls = b.class || call.class
  if (!forCli && (!mod || !cls)) {
    return {
      ok: false,
      error: '反射需要知道 import 哪个模块的哪个类（call.module / call.class）。'
        + '名片里还没有这一段。可以先在 call 段写上，或用 module/class 直接给。',
    }
  }
  const py = b.python || rt.python
  if (!forCli && !py) {
    return { ok: false, error: '名片里没有 runtime.python。反射必须在引擎自己的解释器里跑' }
  }
  const pyPath = py ? path.resolve(ROOT, py) : null
  const pyExe = pyPath
    ? (process.platform === 'win32'
        ? path.join(pyPath, 'Scripts', 'python.exe')
        : path.join(pyPath, 'bin', 'python'))
    : null
  const pyFinal = pyExe && fs.existsSync(pyExe)
    ? pyExe
    : (pyPath && /\.[a-z]+$/i.test(pyPath) && fs.existsSync(pyPath) && fs.statSync(pyPath).isFile() ? pyPath : null)
  if (!forCli && !pyFinal) {
    return {
      ok: false,
      error: `找不到 ${py} 里的解释器（期望 ${path.relative(ROOT, pyExe)}）。`
        + '请确认第 2 步已经给这台引擎建好环境。',
    }
  }

  return {
    ok: true,
    value: {
      python: pyFinal,
      cwd: rt.cwd ? path.resolve(ROOT, rt.cwd) : ROOT,
      module: mod,
      class: cls,
      method: b.method !== undefined ? b.method : (call.method || null),
      sys_path: ((rt.verify && rt.verify.sys_path) || [path.join('engines', b.id)])
        .map((p) => path.resolve(ROOT, p)),
      skip: Array.isArray(b.skip) ? b.skip : [],
    },
    manifest,
    engineDir: ((rt.verify && rt.verify.sys_path) || [path.join('engines', b.id)])
      .map((p) => path.resolve(ROOT, p))[0],
  }
}

module.exports = {
  buildDraftPackage,
  mergeReflections,
  reflectAndBuild,
  buildSpec,
  candidatesFor,
  mapCandidatesFor,
  isPlatformCanonical,
  checkModuleMatchesCli,
  PLATFORM_KEYS,
  PLATFORM_CANONICAL_VARIANTS,
  EXCLUDE,
  exclusionReason,
  reflectParams: SCAFFOLD.reflectParams,
  buildDraft: SCAFFOLD.buildDraft,
}
