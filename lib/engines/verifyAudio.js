'use strict'

// ============================================================================
//  第三道校验「出得了声」—— Node 侧【C1】
//
//  ⭐ 与前两道的关系：
//     第一道  装没装   envCheck.js 浅层（纯查盘）
//     第二道  起得来   envCheck.js 深层（import 名片点名的模块/类/方法）
//     第三道  出得了声  这一刀（**真跑一次**）
//
//  ⭐⭐ 前两道都过了，仍然完全可能出一堆不能听的声音：权重不在、配置写错、
//  构造成功但 infer 抛异常、出来了但是空的、采样率是 0。
//  「import 成功」与「出得了声」之间隔着一整层，只有真跑一次才知道。
//
//  ── 两级【Owner 2026-09-29 裁决】──────────────────────────────
//    B 级  宿主拿到**合法响应**。不起模型、不出声、快、不吃显存。
//         ⛔ 但它验不到「声音对不对」—— 只验到「宿主与引擎谈得拢」。
//    A 级  真跑一次合成，拿到**非空 WAV**。要模型、要显存、慢。
//         A 级会**先跑 B**：宿主没就绪时直接发 /tts 得到 503，
//         那个结果与「引擎出声了但声音不对」长得一样 ⇒ 不能混。
// ============================================================================

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const VERIFIER = path.join(__dirname, 'verify_audio.py')

// ---------------------------------------------------------------------------
//  规格组装
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.profile  resolveEngineProfile 的产物
 * @param {string} [opts.level]  'A' | 'B'（默认 B —— ⭐ A 级要模型要显存，
 *                                不该是随手跑一下的默认值）
 * @param {object} [opts.request] A 级要发的请求体（引擎方言的键名）
 * @param {object} [opts.checkpointsOverride] 用哪一份底模
 */
function buildSpec(opts) {
  const profile = opts.profile
  if (!profile || !profile.id) throw new Error('spec 要有 profile')
  // ⭐⭐ 「没给」与「给了空」必须分得开。
  //
  //   opts.level === undefined ⇒ 真的没给 ⇒ 用默认 B
  //   opts.level === ''        ⇒ 给了个空（--level 后面漏了值，或读了空环境变量）
  //                             ⇒ 当场拒。`opts.level || 'B'` 会把两者都吞成 B，
  //                             于是「我以为验了 A 级」而实际只验了 B 级，
  //                             **而且没有任何提示**。
  //   ⭐ 静默降级是这个项目最贵的失败模式：它长得像「验过了」。
  const raw = opts.level
  const level = (raw === undefined || raw === null) ? 'B' : String(raw).trim().toUpperCase()
  if (level !== 'A' && level !== 'B') {
    const err = new Error(
      `level 只能是 A 或 B，写的是 ${JSON.stringify(raw)}` +
      '（⛔ 静默降级成 B 会让人以为验过了 —— 宁可报错）')
    err.code = 'ENGINE_VERIFY_LEVEL_INVALID'
    throw err
  }

  const spec = {
    level,
    base_url: profile.base_url,
    root: opts.root || process.cwd(),
    ready_timeout: Math.max(30, Math.ceil((profile.timeout_ms || 180000) / 1000)),
    synth_timeout: Math.max(60, Math.ceil((profile.timeout_ms || 180000) / 1000)),
  }
  if (level === 'A') {
    if (!opts.request || !opts.request.text) {
      const err = new Error('A 级要真的合成，spec 必须给 request.text —— 拿什么合成？')
      err.code = 'ENGINE_VERIFY_A_NEEDS_TEXT'
      throw err
    }
    spec.request = opts.request
    // B 级那一发「故意缺 text」的请求，用同一份请求体去掉 text 即可 ——
    // ⭐ 不另编一个：编一个就多一处「两份不一样」的可能。
    const minimal = { ...opts.request }
    delete minimal.text
    spec.minimal_request = minimal
  }
  return spec
}

// ---------------------------------------------------------------------------
//  跑验证器
// ---------------------------------------------------------------------------

/**
 * @returns {object} 永远是对象。失败时 ok:false + 说得清是哪一档、哪一步。
 *   ⭐ 退出码永远是 0（「验不过」是答案不是探针出错），所以**不能**靠
 *   status 判断成败 —— 那是这个项目反复付学费的同一种误判。
 */
function verifyEngine(opts) {
  let spec
  try {
    spec = buildSpec(opts)
  } catch (err) {
    return { ok: false, stage: 'spec', level: opts.level || '?', error: err.message, code: err.code }
  }

  // ⚠ 用**平台**的 Python 跑探针，不是引擎的：
  //   探针只做 HTTP + WAV 解析，⛔ 不 import 引擎的任何东西
  //   （同 env_probe 的纪律）。用引擎的 venv 反而多一个「它装没装」的变量。
  const python = opts.python || process.env.AURIVOX_PYTHON || findPython()
  if (!python) {
    return { ok: false, stage: 'spawn', level: spec.level,
      error: '找不到可用的 Python 来跑验证器 —— 探针本身要 stdlib urllib + wave' }
  }

  // 规格走临时文件而不是命令行：中文/引号在 Windows 上会被二次解析
  const specFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-verify-')), 'spec.json')
  fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8')

  let proc
  try {
    proc = spawnSync(python, [VERIFIER, '--spec-file', specFile], {
      encoding: 'utf8',
      timeout: (spec.level === 'A' ? spec.synth_timeout : spec.ready_timeout + 30) * 1000
        + 30000,
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (err) {
    return { ok: false, stage: 'spawn', level: spec.level,
      error: `起不动验证器 ${python}：${err.message}` }
  } finally {
    try { fs.rmSync(path.dirname(specFile), { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  }

  if (proc.error) {
    return { ok: false, stage: 'spawn', level: spec.level,
      error: `起不动验证器 ${python}：${proc.error.message}` }
  }
  if (proc.status !== 0) {
    // ⭐ 非零 = 探针自己出事，与「这台引擎验不过」是两回事。必须分开说 ——
    //   混起来会让人以为「引擎有问题」，而去查一个根本没坏的引擎。
    return { ok: false, stage: 'probe-crash', level: spec.level,
      error: `验证器非零退出（code=${proc.status}）—— 这是探针自己出事，不是「引擎没通过」`,
      detail: (proc.stderr || '').slice(-2000) }
  }

  let payload
  try {
    payload = JSON.parse(proc.stdout)
  } catch {
    return { ok: false, stage: 'parse', level: spec.level,
      error: '验证器输出不是 JSON —— 多半是环境在 import 时往 stdout 打了东西',
      detail: (proc.stdout || '').slice(0, 2000) }
  }
  // ⭐ 补上「验的是哪一台」—— 不然一份报告寄出去时不知道说的是谁
  payload.engine = opts.profile.id
  return payload
}

/** ⭐ 找平台自己的 Python。⛔ 刻意**不**搜引擎各自�� .venv —— 那是引擎的环境。 */
function findPython() {
  for (const c of [process.env.AURIVOX_PYTHON, 'python', 'python3']) {
    if (!c) continue
    try {
      const r = spawnSync(c, ['-c', 'import sys; sys.exit(0)'],
        { encoding: 'utf8', timeout: 15000, windowsHide: true })
      if (r.status === 0) return c
    } catch { /* 试下一个 */ }
  }
  return null
}

module.exports = { buildSpec, verifyEngine, VERIFIER, findPython }
