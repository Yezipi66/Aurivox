'use strict'
// ============================================================================
//  反射 → parameters[] 草稿 + 平台词候选（第 1 步的引擎侧接线）
//
//  ⭐ 它把**已经在仓库里、已经被测过**的那一层接进向导第 4 步：
//     tools/scaffold-params.cjs 的 reflectParams / buildDraft / inferType /
//     exclusionReason / EXCLUDE 四件套 —— ⛔ 不另起一套，不复制一份。
//
//  三件事的分工（⛔ 不许混）：
//     reflect_params.py   事实：有哪些参数、默认是什么、类型线索
//     scaffold-params.cjs 判断：哪些该进 parameters[]、写成什么形状
//     本文件              glue：反射结果（可能来自子进程，也可能来自夹具）
//                         → 一个给界面用的 envelope
//                         ⭐ 外加平台词候选（映射那一半）
//
//  ⛔⛔ 本文件不做三件事（违反即返工）：
//     1. 不自动落盘 —— 产物是**草稿**，人点选后才进 manifest.json
//     2. 不新增平台侧校验逻辑 —— 它是传话筒，不是裁判
//     3. 不猜 maps —— 映射候选只给候选，⛔ 不写入，绝不替人决定
// ============================================================================

const path = require('node:path')
const fs = require('node:fs')

// ⚠ require 相对**本文件**解析（与 scaffold-params.cjs:24-26 同一条理由：
//   写成 '../scaffold-params.cjs' 会在 require 失败时被 catch 吞成
//   「读不到名片」，把「我写错路径」说成「你的名片坏了」）。
const SCAFFOLD = require(path.join(__dirname, '..', '..', 'scaffold-params.cjs'))

// ⭐ 复用 scaffold-params.cjs 的那一份排除名单与判定函数。
//   ⛔ 不许在这里重写 —— 那份名单被 lib/engines/scaffold.node.test.js 守着，
//      而且它自己有一段「曾被误排 prompt_path_ratio」的血泪史（该文件
//      57-69 行）。复制一份 = 两份会漂移的名单，漂了不报错。
const { EXCLUDE, exclusionReason } = SCAFFOLD

// ---------------------------------------------------------------------------
//  平台词表（两份，⛔ 用途不同，不许合并）
// ---------------------------------------------------------------------------
// ⭐ PLATFORM_KEYS 逐字等于 lib/engines/payload.js:48-50 的 CORE_KEYS +
//   OPTIONAL_KEYS（CANONICAL_KEYS）。为什么在这里再出现一份：向导是独立
//   工具，⛔ 不 require 产品侧的 lib/。代价是两边会漂 ⇒ 测试里有一条把
//   这两张表逐字比对，漂了当场红。
const PLATFORM_KEYS = Object.freeze([
  'text', 'text_lang', 'reference_audio', 'reference_text', 'reference_lang',
  'aux_reference_audio', 'speed', 'seed', 'media_type', 'streaming',
])

// ---------------------------------------------------------------------------
//  平台核心词在引擎那边的**同名写法** —— 软标记（⛔ 不是排除）
// ---------------------------------------------------------------------------
// ⚠ speed / seed / media_type / streaming_mode / text_lang 这类**是平台的词**，
//   但它们同时**就是某台引擎的参数名** —— 人手写的 maps 里 speed←speed_factor、
//   media_type←media_type、streaming←streaming_mode 全是这种。
//   ⇒ 硬排除它们会**同时干掉映射候选**（那正是验收第 3 条要测的）。
//     所以只做标记：草稿里留着，但挂 `_platform_key` + 一句提醒，
//     删不删由人定。⛔ 平台不替人决定。
const PLATFORM_CANONICAL_VARIANTS = Object.freeze(new Set([
  'speed', 'seed', 'media_type', 'streaming', 'streaming_mode', 'text_lang',
  'text', 'reference_text', 'prompt_text',
]))

// ---------------------------------------------------------------------------
//  引擎参数名 → 平台词的启发式候选
// ---------------------------------------------------------------------------
// ⭐ 为什么纯名字启发式够用（2026-10-09 实测）：拿一台 dict 型引擎人手写好
//   的 10 条 maps 当答案卷，纯名字命中 8/10；另一台签名型引擎人手写的 4 条
//   命中 4/4。
//   ⇒ 映射这一半**不是**真正的战场。没命中的那 2 条真因是「参数没找全」，
//     不是「名字猜不准」。
//
// ⛔ 但它只是候选：本文件**不写入 maps**。人点选之后才落盘。
//
//  打分：一条正则 = 一档分。只留最高档，同档并列（都列出来让人挑）。
const MAP_RULES = [
  // ① 辅助参考音频（多个）—— 必须排在 ② 之前：它的名字同时含有
  //    「audio/path」，不先认就会被 ② 抢走，而 aux_* 的语义完全不同。
  { key: 'aux_reference_audio', score: 110,
    re: /^aux_?(ref_?)?(audio|wav)s?(_paths?)?$/,
    why: '名字像「辅助参考音频」' },
  // ② 参考音频 —— 最强信号：prompt_wav / ref_audio_path / spk_audio_prompt
  { key: 'reference_audio', score: 100,
    re: /^(prompt_)?(ref_?)?(audio|wav|wave|voice)$|(^|_)(ref|reference|prompt|spk|speaker|cloned|clone|voice)_?(audio|wav|wave|voice)?_?(path|file)?$/,
    why: '名字像「参考音频」' },
  // ③ 参考音频对应的文字稿
  { key: 'reference_text', score: 95,
    re: /^(prompt_?)?(ref_?)?(text|transcript)$|_?(prompt|reference|ref)_?text$/,
    why: '名字像「参考音频的文字稿」' },
  // ④ 参考音频的语言 —— 比 ⑤ 更具体，靠更高的分数赢
  { key: 'reference_lang', score: 90,
    re: /^(prompt|ref|reference|src)_?lang(uage)?$/,
    why: '名字像「参考音频的语言」' },
  // ⑤ 语言
  // ⭐ 字面命中必须压过同分的模糊命中：`text_lang` 这个名字**就是**平台词本身，
  //    而 auto_base_lang / lang_overrides 只是名字里含 lang。并列 80 分时
  //    按字母序排会把真正的那个挤到第 3 位 —— 于是「人名都不改、直接同名」
  //    的那一条反而进了不了前 3。⇒ 给字面相同加一档。
  { key: 'text_lang', score: 80, exact: 130,
    re: /^(text_?)?lang(uage)?$|_lang$|^lang_/,
    why: '名字像「语言」' },
  // ⑥ 语速
  { key: 'speed', score: 80,
    re: /^speed$|^speed_?(factor|ratio|scale)$|_speed$/,
    why: '名字像「语速」' },
  // ⑦ 种子
  { key: 'seed', score: 90,
    re: /^seed$/,
    why: '上游的参数名就是 seed' },
  // ⑧ 流式
  { key: 'streaming', score: 70,
    re: /^stream(ing)?(_mode)?$/,
    why: '名字像「流式」' },
  // ⑨ 输出格式
  { key: 'media_type', score: 60,
    re: /^(media_?)?(type|format)$/,
    why: '名字像「输出格式」' },
  // ⑩ 要合成的文本
  { key: 'text', score: 50,
    re: /^(tts_)?text$/,
    why: '名字像「要合成的文本」' },
]

/**
 * 一个引擎参数名 → 平台词候选列表（分数降序）。
 *
 * ⛔ 纯函数：不读盘、不写盘、不联网 —— 测试直接喂名字就能验。
 *
 * ⭐ 字面相同优先（exact 档）：当引擎参数名**就是**平台词本身
 *   （text_lang / speed / seed / media_type 这一类）时，它比任何
 *   「名字里含这个词」的模糊命中都强 —— 人手写 maps 时就是这么选的。
 *
 * @param {string} name 上游参数名（反射结果里逐字照抄的那个）
 */
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

// ⚠ 规则表里 ③ 的分数（90）高于 ⑤（80）⇒ 排序天然生效。
//   这一行是给读代码的人的说明，不是分支。

/**
 * 平台词 → 这台引擎的参数名候选。
 *
 * @param {object[]} params 反射出来的参数条目（phase 任意）
 * @param {object} [existingMaps] 名片上已有的 maps（只打标记，⛔ 不覆盖）
 */
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
      // ⭐ 已经有人手写映射的词：候选照样列，但标出来。
      //    ⛔ 平台不替人决定「要不要盖掉已有的」—— 那是人下的决定。
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

// ---------------------------------------------------------------------------
//  映射候选 —— 平台旋钮不存在独立的「串味名单」
// ---------------------------------------------------------------------------
// ⭐ 曾经这里有一张「平台自己的旋钮」硬排除名单，整块删掉了（2026-10-09）：
//   实测两台签名型引擎的反射结果（一台 25 个参数、一台 13 个），那 14 个词
//   一个都没出现过：反射只读签名，压根不会把平台词混进来。
//   而名单里 9 个词（batch_threshold / split_bucket / pron_overrides / …）
//   在真实名片的 payload_keys 里是**会真发给引擎的引擎参数**。
//   ⇒ 它是死代码，且会误伤真参数 ⇒ 删。

/** 平台核心词在引擎那边的同名写法。只标记，⛔ 不排除（见 PLATFORM_CANONICAL_VARIANTS 头注）。 */
function isPlatformCanonical (name) {
  return PLATFORM_CANONICAL_VARIANTS.has(String(name || '').toLowerCase())
}

// ---------------------------------------------------------------------------
//  组装：反射结果 → 给界面的草稿包
// ---------------------------------------------------------------------------
/**
 * ⭐ 把一份反射结果（reflect_params.py 的 stdout）变成给界面的草稿包。
 *
 * ⛔ 它**不写盘**。返回值只是数据；落盘（manifest.json）是用户在第 4 步
 *    亲手按下「保存」之后 /wizard/save 的事，与本函数无关。
 *
 * @param {object} reflection 反射结果（ok:true 时才有意义）
 * @param {object} [opts] { existing, existingMaps }
 *   existing       名片里已有的参数名（字符串或 {name}，两种都收）
 *   existingMaps   名片里已有的 maps（只打标记，⛔ 不覆盖）
 */
function buildDraftPackage (reflection, opts = {}) {
  if (!reflection || reflection.ok !== true) {
    return {
      ok: false,
      stage: (reflection && reflection.stage) || 'reflect',
      error: (reflection && reflection.error) || '反射没有给出结果',
      detail: (reflection && reflection.detail) || null,
    }
  }

  // ⭐⭐ 直接复用 scaffold-params.cjs 的 buildDraft：那一层已经处理了
  //   REPLACE_ME 纪律、excluded 的理由、_needs_review 标注、partial 传递。
  //   ⛔ 不许在这里再实现一遍。
  const draft = SCAFFOLD.buildDraft(reflection, { existing: opts.existing || [] })
  const parameters = draft.parameters

  // ⭐ 反射报上来的全部具名参数（去掉变长参数），按名字索引。
  //   用途：给「认不出类型」的那批排除条目补上「它是不是必填」。
  //   ⛔ 不改 scaffold-params.cjs：那份排除理由是内部诊断口径
  //     （「类型反射不出（…）」），而界面要看到的是「这个参数**必填**，
  //     但平台看不出它是什么类型，请你定」。
  //   判据来源：反射结果里的 required 字段（reflect_params.py 给的）。
  const requiredByName = new Map()
  for (const phase of ['load', 'call']) {
    for (const e of (reflection[phase] || [])) {
      if (e && e.name) requiredByName.set(e.name, e.required === true)
    }
  }

  // ⭐ 认不出类型 ⇒ 进 excluded（⛔ 不是静默丢掉）。补三件事：
  //   ① 它是不是**必填** —— 必填认不出的要人**优先**填（计划 §2 第 3 步）
  //   ② _needs_review —— 与 parameters 里「类型按名字猜的」同一个信号：
  //     平台看不准，人必须复核。⛔ 不许因为落点在 excluded 就省掉它，
  //     不然「哪几条要人看」这件事只在草稿那一半成立。
  //   ③ 一句能指导人行动的理由（「类型反射不出」是内部诊断，不是用户语言）
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

  // 反射看到的**全部**参数（load + call，含被排除的，去掉变长参数）。
  // ⭐ 映射候选必须在这一份全集上做：「参考音频」这种参数几乎总是被
  //   EXCLUDE.path_like 排除在草稿之外，若只在草稿里找，映射候选会
  //   **永远拿不到** reference_audio —— 而它恰恰是最该映射的一个。
  const allParams = [
    ...(reflection.load || []).map((e) => ({ ...e, phase: 'load' })),
    ...(reflection.call || []).map((e) => ({ ...e, phase: 'call' })),
  ].filter((p) => !p.skipped)

  // ① 平台核心词的同名变体 —— 留着，但标出来让人自己删
  for (const p of parameters) {
    if (isPlatformCanonical(p.name)) {
      p._platform_key = true
      p._why = '这个名字是平台核心词在引擎那边的写法：它多半该走 maps，'
        + '而不是重复出现在 parameters[] 里。删不删由你定。'
    }
  }

  // ② 映射候选 —— 在反射全集上做
  const mapCandidates = mapCandidatesFor(allParams, opts.existingMaps || {})

  return {
    ok: true,
    parameters,
    excluded,
    map_candidates: mapCandidates,
    warnings: draft.warnings || [],
    partial: draft.partial,
    partial_reason: draft.partialReason || null,
    counts: {
      parameters: parameters.length,
      excluded: excluded.length,
      map_candidates: mapCandidates.length,
      reflected: allParams.length,
    },
    caveat: '这是草稿：min / max / choices / 中英文标签反射拿不到，需要人逐条核对。',
  }
}

// ---------------------------------------------------------------------------
//  多方法合并 —— 一台引擎声明了多个推理方法时
// ---------------------------------------------------------------------------
// ⭐ 为什么需要它（2026-10-09 实测）：有一台引擎的 call.methods 里声明了
//   **5 个**推理方法（inference_sft / zero_shot / cross_lingual / instruct2 /
//   vc），每个方法的签名都不一样（4~7 个参数）。平台的契约本身就支持
//   per-method（lib/engines/profile.js:161-201 parseMethods），而那台引擎的
//   名片正是这么写的。
//   ⇒ 「反射这台引擎」= 把它声明的每个方法都反射一遍，再按**参数名**合并。
//
// ⚠ 合并只发生在 Node 这一侧（tools/），⛔ 不改 lib/engines/reflect_params.py ——
//   那个反射器一次只认一个 method，改它就等于给 Python 侧加平台知识。
//
// ⛔ 合并**不猜**任何东西：同名参数取**第一次出现**的那条（各方法的签名
//   一致时这等价于任取一条），warnings / partial 全部并起来。
//   ⚠ 不猜的含义：如果两个方法对同名参数给了**不同的**默认值，我们如实
//     并进 warnings 让人核对，⛔ 不挑一个「更可能的」。
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

/**
 * ⭐ 反射一台引擎（可含多个方法）并直接产出草稿包。
 *
 * spec 与 SCAFFOLD.reflectParams 相同，额外可带 `methods: [...]`：
 * 给了就逐个方法反射再合并；不给就反射单个 `method`。
 *
 * ⛔ 它**不写盘** —— 与 buildDraftPackage 同一条纪律。
 */
function reflectAndBuild (spec, opts = {}) {
  const methods = Array.isArray(opts.methods) && opts.methods.length
    ? opts.methods
    : [spec.method || null]
  const results = methods.map((m) => SCAFFOLD.reflectParams(
    { ...spec, method: m }, { timeoutMs: opts.timeoutMs }))
  const merged = mergeReflections(results)
  if (!merged.ok) return merged
  return buildDraftPackage(merged, opts)
}

// ---------------------------------------------------------------------------
//  端点入参 → 反射 spec
// ---------------------------------------------------------------------------
// ⭐ 为什么单独一层：反射器要的 spec 是 {python, cwd, module, class, method,
//   sys_path, skip}，而前端只知道「这台引擎的 id」和名片里的 call 段。
//   ⇒ 这一层只做**搬运**：从盘上读名片，把事实抄进 spec。
//
// ⛔ 它不做任何判断、不补默认值（平台是传话筒）：
//   · 名片里没有 call.module / call.class ⇒ 如实说「反射需要知道 import 哪个
//     模块的哪个类」，⛔ 不猜
//   · runtime.python 不在 ⇒ 如实说，⛔ 不拿平台自己的 python 顶上
//     （那会让「引擎环境有问题」伪装成「这台引擎没参数」）
const ROOT = path.join(__dirname, '..', '..', '..')

/**
 * 把 POST /wizard/params 的 body 变成反射 spec。
 *
 * @param {object} body { id, module?, class?, method?, methods?, skip? }
 *   id       必填。引擎目录名 = engines/<id>
 *   module/class/method  可选；不给就从名片 call 段读
 *   methods  可选：给了就逐个方法反射再合并（多方法引擎）
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
function buildSpec (body) {
  const b = body || {}
  if (!b.id || typeof b.id !== 'string') {
    return { ok: false, error: 'id is required（反射要知道去读哪个引擎目录）' }
  }
  const dir = path.join(ROOT, 'engines', b.id)
  if (!fs.existsSync(dir)) {
    // ⭐ 兜底（计划 §1.2）：第 4 步发现引擎目录不存在 ⇒ 让用户回第 1 步克隆。
    return {
      ok: false,
      error: `引擎目录 ${b.id} 不存在。反射要在**本机**读源码，`
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
  if (!mod || !cls) {
    return {
      ok: false,
      error: '反射需要知道 import 哪个模块的哪个类（call.module / call.class）。'
        + '名片里还没有这一段。可以先在 call 段写上，或用 module/class 直接给。',
    }
  }
  // ⛔ python 是**引擎自己的**解释器。拿不到就说拿不到，⛔ 不许退回平台那个 ——
  //   平台的 Python 里没有 torch、也没有这台引擎的模块，反射必然失败，
  //   而那个失败会被说成「这台引擎没参数」。
  const py = b.python || rt.python
  if (!py) {
    return { ok: false, error: '名片里没有 runtime.python。反射必须在引擎自己的解释器里跑' }
  }
  // ⚠ runtime.python 写的是**目录**（`engines/<id>/.venv`），不是一个可执行文件。
  //   Windows 上真正能起的是 `.venv/Scripts/python.exe` ⇒ 补这一段。
  //   ⛔ 不补的表现是 spawn ENOENT，报错说的是「起不动解释器」，而真正的原因
  //      是「路径少了一截」—— 那是最难查的一类误导（本步实测踩过）。
  const pyPath = path.resolve(ROOT, py)
  const pyExe = process.platform === 'win32'
    ? path.join(pyPath, 'Scripts', 'python.exe')
    : path.join(pyPath, 'bin', 'python')
  const pyFinal = fs.existsSync(pyExe)
    ? pyExe
    : (/\.[a-z]+$/i.test(pyPath) ? pyPath : null)
  if (!pyFinal) {
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
  PLATFORM_KEYS,
  PLATFORM_CANONICAL_VARIANTS,
  EXCLUDE,
  exclusionReason,
  // ⭐ 转出这两个：端点要拿它们真跑反射
  reflectParams: SCAFFOLD.reflectParams,
  buildDraft: SCAFFOLD.buildDraft,
}
