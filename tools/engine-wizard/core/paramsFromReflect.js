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
//  交叉校验：名片 call.module 与上游 CLI 实际 import 的模块是否一致
// ---------------------------------------------------------------------------
// ⭐⭐ 为什么要有它（2026-10-10 实测踩过的一台 TTS 引擎）：
//   名片 call.module 写 `A`，而上游 CLI 的 import 是
//   `from B import 同一个类`（某 cli_v2.py 的延迟 import 里，[实测] 已核）。
//   Wizard 照 call.module 反射 ⇒ 反射出 A **独有**的那几个参数，
//   其中一个还是**必填**（A 的签名里无默认值）⇒ 被顶进「必须你填」，
//   而真实 CLI 根本没有它。
//   全程零提醒：反射器只在盘上读签名，看不到 CLI 那一侧的事实。
//
// ⛔⛔ 这是**提醒**，不是拦截，更不是自动改：
//   · 平台不猜哪个 module 对（上游一份仓库里同时存在多个推理版本，
//     webui.py 按 --v25 开关二选一 import；哪个是「对的」取决于人的意图）
//   · 只如实把「CLI 里 import 的模块」与「名片写的模块」摆在一起，附上
//     文件:行号，人自己判断要不要改名片
//
// ⭐ 三个判据，全部只读盘、⛔ 不跑 import、不跑引擎代码：
//   ① 找不到 CLI 文件          → 一条说明性提示（不是警告）
//   ② CLI 里没有 import 过这个类 → 找不到任何交叉证据，不说话
//   ③ CLI 里 import 了这个类，
//      但模块名与名片写的不一致 → ⚠️ 警告，带 文件:行号 证据
//
// ⛔ 纪律：本函数里不许出现任何具体引擎名（测守卫着）。
// ---------------------------------------------------------------------------

// ⚠ 只取「引擎自己的 CLI 文件名」当入口。findCliFiles 会**递归兜底**找出
//   整个引擎目录里所有含 add_argument 的脚本（TensorRT 构建脚本、webui、
//   demo…），而那些脚本几乎都 import 同一个类 —— 把它们的 import 全算进来，
//   判据 ③ 就永远不成立（任何版本都会被某个脚本 import 过）。
//   ⚠ 取的是 cliHelp.js 的 CLI_CANDIDATES，⛔ 不在这里复制一份名单。
// ⚠ 匹配的是**文件名**（path.basename）而不是整条相对路径 ——
//   `<pkg>/cli_v2.py` 的 basename 是 `cli_v2.py`，在名单里。
//     ⚠ 也因此 `backends/trt/infer.py`（basename `infer.py`，在名单里）
//       会算作入口 —— 那是它**自己**的名字撞上了通用 CLI 名，
//       ⛔ 不是平台的判定，如实算进来。
const CLI_ENTRY_NAMES = Object.freeze(new Set(
  require(path.join(__dirname, 'cliHelp.js')).CLI_CANDIDATES))

// ⚠ 正则只认**行首**的 import（可有任意缩进，覆盖函数体内的延迟 import ——
//   cli_v2.py 里某函数体的 `from ... import ...` 就是缩进的延迟 import）。
//   ⛔ 不解析 AST：判据是「这个文件里有没有出现过这个 import」，不是
//      「这个 import 是否真会执行到」。缩进的延迟 import 正是最常见的形态，
//      按行首（可缩进）匹配才不会漏。
const IMPORT_FROM_RE = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(.+?)(?:#.*)?$/
const IMPORT_PLAIN_RE = /^\s*import\s+([A-Za-z_][\w.]*)\s*$/

/** 从一行 import 里把被导入的名字逐个拆出来（去括号、去 `as` 别名） */
function importedNames (clause) {
  return clause.replace(/[()\\]/g, ' ').split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean)
}

/**
 * 从引擎目录里的 CLI 文件里，找出「import 了某个类」的语句。
 *
 * @param {string} dir 引擎源码目录
 * @param {string} cls 要找的类名
 * @returns {Array<{file: string, line: number, module: string}>}
 *   file  相对 dir 的路径（用 / 分隔，跨平台显示一致）
 *   line  1 起的行号
 *   module 该 import 语句写的模块名
 *   ⚠ 空数组 = 没有交叉证据（判据 ②），⛔ 不是「对不上」
 */
function findClassImports (dir, cls) {
  const out = []
  if (!dir || !cls) return out
  let files = []
  try {
    files = require(path.join(__dirname, 'cliHelp.js')).findCliFiles(dir)
  } catch { return out }
  for (const rel of files) {
    // ⭐ 只认「CLI 入口文件名」。递归兜底找出来的每个脚本都 import 同一个类，
    //   算进来会让判据 ③ 永远不成立（任何模块版本都会被某个脚本 import 过）。
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

/**
 * 交叉校验：名片 call.module 与上游 CLI 实际 import 的模块是否一致。
 *
 * ⛔ 只读盘、不跑代码、不写盘。⛔ 不改任何输入。
 * ⛔ 不自动改名片、不阻塞：返回的是**一句提醒**，人决定改不改。
 *
 * @param {object} opts
 *   dir       引擎源码目录（= sys_path[0]，与 CLI 扫描同一个目录）
 *   module    名片 call.module
 *   cls       名片 call.class
 * @returns {string|null} 要提醒的那句话；没有任何事要提醒时返回 null
 */
function checkModuleMatchesCli ({ dir, module, cls }) {
  if (!dir || !module || !cls) return null
  if (!fs.existsSync(dir)) return null

  let files = []
  try {
    files = require(path.join(__dirname, 'cliHelp.js')).findCliFiles(dir)
  } catch { return null }
  const entries = files.filter((f) => CLI_ENTRY_NAMES.has(path.basename(f)))
  if (!entries.length) {
    // 判据 ①：这台引擎没有 CLI 入口文件。⛔ 不是警告 ——
    //   「没有 CLI」是一个事实，不是「名片可能写错了」。静默返回，
    //   ⛔ 不往里加噪音。
    return null
  }

  const hits = findClassImports(dir, cls)
  if (!hits.length) {
    // 判据 ②：CLI 里没有 import 过这个类。⛔ 不猜 ——
    //   有的引擎靠 Python API / webui / SDK 用，CLI 是给人敲的，
    //   两者 import 不同的东西完全正常。没有证据就不说话。
    return null
  }

  const same = hits.filter((h) => h.module === module)
  if (same.length) return null // CLI 里确实 import 了名片写的那个模块 ⇒ 一致

  // 判据 ③：CLI import 了这个类，但来自**另一个**模块。
  const where = hits.map((h) => `${h.file}:${h.line}`).join('、')
  const mods = [...new Set(hits.map((h) => h.module))].join('、')
  return `交叉校验提醒：名片 call.module 写的是「${module}」，但上游 CLI `
    + `（${where}）import ${cls} 用的是「${mods}」。\n`
    + '  两者不是同一个模块 ⇒ 反射出的是**那个模块**的参数，可能与用户会敲的 '
    + 'CLI 不是同一套（多出的参数在真实 CLI 上根本不存在，缺的参数则完全看不见）。\n'
    + '  ⚠️ 平台不改你的名片：哪一个模块是这台引擎该用的，取决于你的意图'
    + '（上游一份仓库里可以同时存在多个推理版本）。请自己核对后决定。'
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
  //   ⭐ 同时把反射报上来的 `required` 抄到草稿上（第 2 步要靠它分区）。
  //     ⛔ 为什么在这里补而不改 scaffold-params.cjs：那份是第 1 步的产物，
  //       被 lib/engines/scaffold.node.test.js 守着形状；而「界面按必填排序」
  //       是第 2 步的需求。⇒ 只加一个字段，⛔ 不改任何已有字段。
  //     ⚠ 判据来源：反射结果里的 required（reflect_params.py 给的）。
  //       ⛔ 平台不自己判断「这个参数必填」，只如实传。
  for (const p of parameters) {
    if (requiredByName.get(p.name) === true) p.required = true
    if (isPlatformCanonical(p.name)) {
      p._platform_key = true
      p._why = '这个名字是平台核心词在引擎那边的写法：它多半该走 maps，'
        + '而不是重复出现在 parameters[] 里。删不删由你定。'
    }
  }

  // ② 映射候选 —— 在反射全集上做
  const mapCandidates = mapCandidatesFor(allParams, opts.existingMaps || {})

  // ③ ⭐⭐ 卡点 3：call.bind 的槽位 —— 反射器看不见的**真实必填**
  //
  //   ⚠⚠ 为什么必须在这里补（2026-10-10 实测踩过的一台 TTS 引擎）：
  //     reflect_params.py 的 BIND_SLOTS = ('self','text','ref_audio','output_path')
  //     会把这几个名字**整条跳过**（`if name in BIND_SLOTS: continue`）——
  //     而这是**对的**：它们是平台自己的槽位，归宿是 call.bind，
  //     不是 parameters[]（混进去 = 同一个概念声明两次）。
  //     但真实 infer() 的必填三件套是 spk_audio_prompt / text / output_path，
  //     反射器**一条都不报**（text / output_path 在 BIND_SLOTS 里被跳过，
  //     spk_audio_prompt 能出现只是因为它恰好同时在签名里、且不在名单里）。
  //     ⇒ 这两个必填参数对 Wizard 完全隐形，界面上一格都没有，
  //       ⛔ 且不报错（「漏掉」在这条链上永远没有信号）。
  //
  //   ⭐ 补法：读名片 manifest.call.bind，把它的**值**（引擎侧真实参数名）
  //     并进参数清单，标 source='call.bind' + required=true。
  //   ⛔ 为什么是「值」而不是「键」：bind 是 {平台槽位 → 引擎参数名}，
  //     `{text: 'text', ref_audio: 'spk_audio_prompt'}` ——
  //     引擎那边真实存在的参数名是 spk_audio_prompt（键 ref_audio 是平台的词）。
  //   ⛔ 不在这里改反射器（reflect_params.py 不动）：那份是第 1 步的产物，
  //     被 lib/engines/scaffold.node.test.js 守着形状；「界面要看得见 bind」
  //     是第 2 步的需求 ⇒ 只在这里补，⛔ 不改任何已有条目。
  //
  //   ⚠⚠ 不去重删重 —— 但也不造重复条目（2026-10-10 实测踩过）：
  //     · 反射**已经报过**这个参数（如 spk_audio_prompt，它不在 BIND_SLOTS）
  //       ⇒ ⛔ **不新增第二条**，只在原条目上补 _bind_slot / _bind_slot_note
  //         —— 实测第一版在这里无条件新增，结果 must 块里出现**两条
  //         spk_audio_prompt**、界面渲染出两张同名卡片（React key 还重复），
  //         「界面少一格」的修法自己造出了「界面多一格」。
  //     · 反射**没报过**（text / output_path，它们就是 BIND_SLOTS 里的名字）
  //       ⇒ 新增一条，source='call.bind' —— 这正是本判据要修的那个洞。
  //   ⭐ 无论哪种，都保证「每个 bind 槽位指向的参数在清单里恰好出现一次」。
  const bindParams = []
  const bind = (opts.manifest && opts.manifest.call && opts.manifest.call.bind) || null
  if (bind && typeof bind === 'object') {
    for (const [slot, engineParam] of Object.entries(bind)) {
      if (typeof engineParam !== 'string' || !engineParam.trim()) continue
      const name = engineParam.trim()
      // ⚠ 只看**草稿**（parameters）里有没有它，⛔ 不看 allParams。
      //   实测踩过（第一版）：写成 `parameters.find(...) || allParams.find(...)`
      //   ⇒ 一个被 excluded 的 bind 参数（output_path 会命中 path_like）
      //     会在 allParams 里「命中」，标记打在**副本**上然后 continue ——
      //   结果它既没进草稿、excluded 里那条也没被动过 ⇒ **凭空消失**。
      //   ⭐ 判据：进了草稿 = 打标记；没进草稿（含被排除）= 新增一条，
      //     带 _already_excluded 让人看见「它也曾在排除清单里」。
      const hit = parameters.find((p) => p.name === name)
      const wasExcluded = excluded.some((e) => e.name === name)
      if (hit) {
        // ⭐ 反射已经看得见它 ⇒ 只补标记，⛔ 不新增条目（见上面的实测）。
        //   _bind_slot 让界面能标出「这个槽位归 call.bind 的 <slot>」。
        //   required 一律补上：bind 槽位是宿主每次调用都要递进去的真实入参
        //   （text 没有就没有 TTS，output_path 是 returns=file 的落点）——
        //   ⛔ 这是名片**自己声明**的事实，不是平台的推断。
        hit._bind_slot = slot
        hit._bind_slot_note = `名片 call.bind.${slot} 指向这个参数`
        if (hit.required !== true) hit.required = true
        continue
      }
      bindParams.push({
        name,
        // ⚠ type 用占位符而不是猜：bind 只给名字，给不出类型。
        //   ⛔ 不许按名字猜一个 type 塞进去 —— 那是平台替人定控件形状，
        //     而猜错的表现是「一个真实必填参数被做成错的控件」。
        //   ⚠ label/help 同样是 REPLACE_ME（与 scaffold-params.cjs 的草稿纪律一致）。
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
        // ⚠ 这两枚标记说的是「平台在别处也见过这个名字」—— 如实标，
        //   ⛔ 不是「这条重复了」。重复已在上面被拦掉，不会走到这里。
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
 * ⭐ `opts.manifest`：这张名片的原文。**卡点 3** 要用它的 call.bind
 *   （反射器读不到 bind，而 bind 指向的是真实必填入参）。
 *   ⚠ 不给就只产出反射看得见的那一半 —— 那是「少一格且不报错」，
 *     ⛔ 所以端点必须把名片传进来（见 wizardbridge.js 的 handleParams）。
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
  const pkg = buildDraftPackage(merged, opts)
  if (!pkg.ok) return pkg

  // ⭐⭐ 卡点 2：交叉校验（call.module 与上游 CLI import 是否一致）。
  //   ⚠ 放在这里而不是 buildDraftPackage 里：判据需要**引擎目录**（去读
  //     CLI 源码），而那属于端点/上层的事，buildDraftPackage 只收反射结果。
  //   ⚠ 目录取 spec.sys_path[0] —— 与 CLI 官方原话扫描**同一个**目录
  //     （卡点 5 修好之后它就是引擎自己的目录），两份证据同源，不会打架。
  //   ⛔ 只加一句提醒，⛔ 不改 parameters[]、不改 map_candidates、不拦截。
  let cross = null
  try {
    cross = checkModuleMatchesCli({
      dir: Array.isArray(spec.sys_path) && spec.sys_path.length ? spec.sys_path[0] : null,
      module: spec.module,
      cls: spec.class,
    })
  } catch { cross = null }   // ⛔ 读盘出错不许把整条反射拖下水 —— 只少一句提醒

  if (cross) pkg.warnings = [...(pkg.warnings || []), cross]
  pkg.counts = { ...pkg.counts, cross_warnings: cross ? 1 : 0 }
  return pkg
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
function buildSpec (body, opts) {
  const b = body || {}
  const forCli = opts && opts.forCli  // ⭐ cli 路线：只定位目录+python，⛔ 不要 call.module/class
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
  // ⭐ forCli：cli 路线是扫源码文本（argparse --flag），⛔ 不 import 类 ⇒
  //   根本不需要 call.module/class。⛔ 新建名片默认没有这一段，卡在这里
  //   等于把 cli 扫描堵死（新建名片实测直接 BAD_SPEC）——跳过。
  if (!forCli && (!mod || !cls)) {
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
  if (!forCli && !py) {
    return { ok: false, error: '名片里没有 runtime.python。反射必须在引擎自己的解释器里跑' }
  }
  // ⚠ runtime.python 写的是**目录**（`engines/<id>/.venv`），不是一个可执行文件。
  //   Windows 上真正能起的是 `.venv/Scripts/python.exe` ⇒ 补这一段。
  //   ⛔ 不补的表现是 spawn ENOENT，报错说的是「起不动解释器」，而真正的原因
  //      是「路径少了一截」—— 那是最难查的一类误导（本步实测踩过）。
  // ⭐ forCli：cli 扫描是文本扫描（读 .py 源码），不 spawn python ⇒ 没 runtime.python
  //   也不拦。pyFinal 给 null，下游 collectCliHelp 不依赖它。
  const pyPath = py ? path.resolve(ROOT, py) : null
  const pyExe = pyPath
    ? (process.platform === 'win32'
        ? path.join(pyPath, 'Scripts', 'python.exe')
        : path.join(pyPath, 'bin', 'python'))
    : null
  const pyFinal = pyExe && fs.existsSync(pyExe)
    ? pyExe
    : (pyPath && /\.[a-z]+$/i.test(pyPath) ? pyPath : null)
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
    // ⭐⭐ 名片的原文（卡点 3 要用的就是它）。
    //   ⚠ 为什么必须往外带：反射器只读签名，**读不到 call.bind**；而 bind
    //     指向的是这台引擎的**真实入参**（text / output_path 这类必填）。
    //     反射产物里看不见它们 ⇒ 界面上一个格子都没有，且不报错。
    //   ⛔ 只是原样带出，⛔ 不在这里做任何判断、不改任何字段。
    manifest,
    // ⭐ 引擎源码目录（= sys_path[0]）。两个下游都从这一个值取：
    //   卡点 5 的 CLI 官方原话扫描 + 卡点 2 的交叉校验 ⇒ 两份证据同源。
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
  // ⭐ 卡点 2 的交叉校验。导出它是为了让测试能直接喂目录验判据，
  //   ⛔ 不是为了让调用方绕过 reflectAndBuild 自己拼。
  checkModuleMatchesCli,
  PLATFORM_KEYS,
  PLATFORM_CANONICAL_VARIANTS,
  EXCLUDE,
  exclusionReason,
  // ⭐ 转出这两个：端点要拿它们真跑反射
  reflectParams: SCAFFOLD.reflectParams,
  buildDraft: SCAFFOLD.buildDraft,
}
