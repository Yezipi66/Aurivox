'use strict'
// ============================================================================
//  VALIDATE —— 校验一张名片，并把平台的报错翻成人话
//
//  ⛔⛔ 纪律
//  本文件里**不许出现任何具体引擎名**。判据：装一台谁都没见过的引擎，
//  这里一个字都不用改。test/validate.node.test.js 里有一台假引擎守着。
//
//  ⭐ 为什么复用平台的 profile.js，而不是自己写一套
//  平台那边有 60 处抛错，是**已经跑了 1773 条测试**的权威。
//  自己重写一遍 = 第二份会漂移的事实 —— 那是平台 C11 守卫明令禁止的。
//  ⇒ 这里只做两件平台不做的事：
//     1) 把 Error 解析成「哪个字段、错在哪、怎么改」
//     2) 补上平台**管不到**的那一类：静默失效
//
//  ⛔ 不改 profile.js 的任何行为（那 1773 条测试在看）。
// ============================================================================

const path = require('path')
const { SECTIONS_BY_KEY, PARAM_FIELDS_BY_KEY, DANGER } = require('./fieldmeta')

// 平台的派生器（导出的、稳定的）。它是「一份 parameters[] → 5 份视图」那一步的权威。
const { deriveParameterViews } = require(
  path.resolve(__dirname, '..', '..', '..', 'lib', 'engines', 'parameterDeclaration.js')
)

// 平台的解析器。路径从向导自己的位置算回去 —— 向导是独立工具，
// 不假定自己被放在哪（可以被拷走单独用）。
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
let _registry = null
function registry () {
  if (!_registry) {
    _registry = require(path.join(REPO_ROOT, 'lib', 'engines', 'registry.js'))
  }
  return _registry
}

/**
 * 平台抛的错长这样：
 *   Error{ code:'ENGINE_MANIFEST_INVALID_VALUE', key:'runtime.foo', value:... }
 * 它的 message 是**给人看的散文**，但要从里面定位到「第几个数组项」，
 * 需要 key 与我们自己遍历的路径对齐。这一层做对齐。
 */
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

/** 一条人话诊断。level: 'error' | 'warn' */
function diagnose (manifest) {
  const out = []
  const push = (level, code, message, where) => out.push({ level, code, message, ...where })

  // ---- 1. 交给平台的派生链（它抛 = 硬错）----------------------------
  //
  // ⚠ 口径要说清楚：这一层能抓的是**结构错**（重复声明、旧字段并存、
  //   phase 非法、name 撞了text 参数……）。它**不是**平台全部 60 条规则 ——
  //   那些里有一部分只存在于 profile.js 的内部函数（未导出），
  //   要跑它们必须先落盘，再由 registry 判定。
  //   ⇒ 向导 = 落盘**前**的助手；registry = 落盘**后**的权威。
  try {
    resolveFromObject(manifest)
  } catch (e) {
    const at = locate(e.key, manifest)
    push('error', e.code || 'ENGINE_MANIFEST_INVALID',
      e.message, at || {})
    // 派生失败就别往下检了 —— 后面的结论会建立在错的前提上
    return out
  }

  // ---- 2. 平台不拦、但会「设了没效果」的那一类 ------------------------
  //
  //  ⭐ 这一段是这个工具存在的理由之一。平台管的是「装得上、起得来」，
  //  管不了「设了它到底有没有生效」。后者只有用户看得见。

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

  // weights[].applies_at —— 填错不报错，但模型换了声音不变
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

  return out
}

/**
 * 从「一个 manifest 对象」走一遍平台的解析链，得到派生的 profile。
 *
 * ⭐ 为什么不让向导自己解析
 *   平台那条链是：stripComments（剥 _ 开头）→ deriveParameterViews（派生 5 份视图）
 *   → profile.js 的 parseX 系列。每一处都是判定权威（1773 条测试在看）。
 *   向导自己复刻 = 第二份实现 = 必然漂移。
 *   ⇒ 这里**只做**「喂一个内存对象进去」，把结论接出来；
 *     具体解析一行都不重写。
 *
 * ⚠ 为什么不用 registry.getEngine(id)
 *   它按 id 去**磁盘上**找引擎。向导校验的恰恰是还没落盘的名片
 *   （用户正在填），所以这条路走不通 —— 这是第一次实现时踩到的，
 *   记下来免得再踩。
 */
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
  // profile.js 的解析器是**内部函数**，没有导出（只导出 resolveEngineProfile 等 4 个）。
  // ⛔ 这里不 require 内部的 —— 那是随时会变的 API。
  //   改成走 registry 那条链：把对象「落到一个临时目录」不现实（会动用户的盘）。
  //   ⇒ 于是只用 deriveParameterViews 这一段（它是导出的、也是唯一有语义的），
  //     硬校验交给 registry.getEngine 在**落盘之后**跑。
  //     向导的定位：**落盘前**帮人选对字段、给出提示；
  //     **落盘后**由 registry 做权威判定。
  return derived
}

/**
 * 一句话结论 —— CLI 用。
 * ⛔ 「0 个 error」不等于「对」：还有 warn 呢。返回对象不是布尔，
 *   是为了不让人拿它当 if (validate(x)) 用。
 */
function summarize (diagnostics) {
  const errors = diagnostics.filter(d => d.level === 'error')
  const warns = diagnostics.filter(d => d.level === 'warn')
  const infos = diagnostics.filter(d => d.level === 'info')
  return {
    ok: errors.length === 0,
    errors: errors.length,
    warns: warns.length,
    infos: infos.length,
    // ⛔ 措辞诚实：没有 error **不等于**能出声，更不等于映射是对的
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