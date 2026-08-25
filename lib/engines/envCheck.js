'use strict'

// ---------------------------------------------------------------------------
//  第一道校验 —— 「这台引擎装没装」
// ---------------------------------------------------------------------------
// 契约 v2 §6 写了三道校验，今天一道都没有。这是第一道。
//
// ⭐ 平台的立场是**只验不建**（Owner 2026-08-24 拍板：「我只维护
//    GPT-SoVITS 兼容这一套，其他一概不负责」）。所以这个文件里没有任何
//    "装环境""装包""建 venv"的代码，将来也不该有。它只回答一个问题：
//    名片说的那个解释器 / 脚本 / 模块 / 类 / 方法，在不在。
//    不在 = 这台引擎没装。平台不代劳，也不背书。
//
// 分两层，因为两层的代价差三个数量级：
//
//   浅层 shallow —— 纯查盘，几毫秒。解释器在不在、入口脚本在不在。
//                   ⭐ 这一层就抓住了 indextts2 名片里那个 `venv` 少一个点
//                     的错误（真的是 `.venv`），它写错了很久没人发现，
//                     因为在这个文件出现之前**没有任何人读 runtime**。
//
//   深层 deep    —— 起一次引擎自己的解释器去 import，几十秒（IndexTTS2 实测
//                   import 34s）。只在按需时做：装完引擎、排障、CI。
//                   ⛔ 绝不能挂在每次合成请求上。
//
// ⚠ 浅层过了不代表深层会过（包没装齐、版本不对都要到 import 才现形）；
//   深层过了也不代表引擎一定能起来（显存不够、端口被占都在这之后）。
//   这个文件只做它名字说的那件事，别把它当"引擎健康检查"用。
//
// ⭐⭐ 两根轴，不是一根：
//     result.ok      —— 「装没装」：解释器 / 入口 / 模块 / 类 / 方法
//     result.assets  —— 「权重在不在」：名片声明的 checkpoints 目录
//   两者都是三态（true / false / null）。⛔ 别把 assets 折进 ok ——
//   "环境装好了、模型还没下"是完全正常的中间状态，压成一句"没装"会让
//   人去重装一遍已经装好的环境，还会让深层校验被浅层拦下而根本不跑。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const PROBE = path.join(__dirname, 'env_probe.py')

function makeResult(id, extra) {
  return Object.assign({
    id,
    ok: false,
    level: 'shallow',
    problems: [],
    // ⭐⭐ 权重是**另一根轴**，不进 ok。见下面 checkAssets 的长注释。
    assets: { ok: null, problems: [] },
    info: {},
  }, extra)
}

/**
 * 权重轴 —— 和「装没装」分开算。
 *
 * ⛔⛔ 这里曾经是个设计错误：权重目录不在，被算进了 `ok`，于是
 *   indextts2 在真机上显示成「没装/不全」，而它的 `.venv` 其实好端端地
 *   躺在盘上。两个后果都很实在：
 *     1. 人会去重装一遍已经装好的 7.8 GB 环境；
 *     2. 更糟 —— 深层校验有一条「浅层不过就不起进程」，于是
 *        「IndexTTS2 的 Python 环境到底好不好」这个问题**根本没被问过**。
 *
 * ⭐ 判据：**装没装**是「这台机器有没有能跑它的东西」（解释器 / 入口 /
 *   模块 / 类 / 方法），是一次性的安装行为；**权重在不在**是「有没有下
 *   模型」，是随时会变的内容状态 —— 用户换个模型、清一次盘就变了，
 *   而环境一动不动。把随时会变的东西折进一次性的结论里，那个结论就不
 *   再有意义。
 *
 * 「环境装好了、权重还没下」是一个**完全正常的中间状态**，它必须能被
 * 表达出来，而不是被压成一句"没装"。
 */
function checkAssets(profile, p, exists) {
  const out = { ok: null, problems: [] }
  if (!p || !p.checkpoints) return out   // 没声明 ⇒ 无从判断，不是通过
  if (exists(p.checkpoints)) { out.ok = true; return out }
  out.ok = false
  out.problems.push(
    `权重目录不存在：${p.checkpoints}\n` +
    `  （名片 runtime.checkpoints = ${profile.runtime.checkpoints}）\n` +
    '  这不影响"引擎装没装"的结论 —— 环境可以是好的，只是模型还没下。' +
    '按引擎作者的说明把权重放到上面这个目录即可。')
  return out
}

/**
 * 把名片上的相对路径落到这台机器上。
 *   python / cwd / checkpoints / verify.sys_path —— 相对**项目根**
 *   entry                                        —— 相对**名片所在目录**
 *
 * 两个基准不一样是有理由的：解释器和权重是整个安装的一部分（跟着项目根
 * 走），而入口脚本是这台引擎自己的东西（跟着引擎目录走）。
 * ⛔ 别为了"统一"把 entry 也改成相对项目根 —— 那会逼着每张名片都写一遍
 *   自己的目录名，而目录名恰恰是 registry 已经知道的东西。
 */
function resolveRuntimePaths(profile, rootDir) {
  const rt = profile.runtime
  if (!rt) return null
  return {
    python: path.resolve(rootDir, rt.python),
    entry: path.resolve(profile.dir, rt.entry),
    cwd: rt.cwd ? path.resolve(rootDir, rt.cwd) : rootDir,
    checkpoints: rt.checkpoints ? path.resolve(rootDir, rt.checkpoints) : null,
    sys_path: (rt.verify ? rt.verify.sys_path : []).map((p) => path.resolve(rootDir, p)),
  }
}

/**
 * 浅层：只查盘，不起进程。
 *
 * @param {object} profile  resolveEngineProfile() 的产物
 * @param {object} [opts]   { rootDir, exists }  exists 可注入，便于测试
 */
function checkEngineEnvShallow(profile, opts = {}) {
  const rootDir = opts.rootDir || path.resolve(__dirname, '..', '..')
  const exists = opts.exists || fs.existsSync
  const result = makeResult(profile.id, { level: 'shallow' })

  if (!profile.runtime) {
    // 「名片没写 runtime」不是错误，是一个事实：这台引擎不由平台起，
    // 因此平台也没法校验它。⭐ 必须和"校验通过"区分开，否则一张什么都
    // 没写的名片会显示成"一切正常"。
    result.ok = null
    result.unmanaged = true
    result.problems.push(
      `${profile.id} 的名片没有 runtime 段 —— 平台不负责起这台引擎，也就无从校验它装没装。`)
    return result
  }

  const p = resolveRuntimePaths(profile, rootDir)
  result.info.paths = p

  if (!exists(p.python)) {
    result.problems.push(
      `解释器不存在：${p.python}\n` +
      `  （名片 runtime.python = ${profile.runtime.python}，相对项目根 ${rootDir}）\n` +
      '  平台只验不建：这条不过就是这台引擎没装，请按引擎作者的说明自行装好它的环境。')
  }
  if (!exists(p.entry)) {
    result.problems.push(
      `入口脚本不存在：${p.entry}\n` +
      `  （名片 runtime.entry = ${profile.runtime.entry}，相对名片所在目录 ${profile.dir}）`)
  }
  result.assets = checkAssets(profile, p, exists)
  for (const sp of p.sys_path) {
    if (!exists(sp)) {
      result.problems.push(`runtime.verify.sys_path 里的目录不存在：${sp}`)
    }
  }

  result.ok = result.problems.length === 0
  return result
}

/**
 * 深层：拿引擎**自己的**解释器去 import 名片点名的模块/类/方法。
 *
 * 浅层不过就不做深层 —— 解释器都不在，起它只会得到一句 ENOENT，
 * 而那句话远不如浅层给出的"名片写的是哪一行、落到哪个路径"有用。
 */
function checkEngineEnvDeep(profile, opts = {}) {
  const rootDir = opts.rootDir || path.resolve(__dirname, '..', '..')
  const shallow = checkEngineEnvShallow(profile, opts)
  if (shallow.ok !== true) return shallow

  const rt = profile.runtime
  if (!rt.verify) {
    // 写了 runtime 却没写 verify：能起进程，但平台无从核对"装没装"。
    // 同样不能报成绿 —— 它和"核对通过"是两件事。
    const r = makeResult(profile.id, { level: 'deep', ok: null, unverifiable: true })
    r.info = shallow.info
    r.assets = shallow.assets
    r.problems.push(
      `${profile.id} 的名片有 runtime 但没有 runtime.verify —— ` +
      '平台能起它，却没法在起之前判断它装没装。' +
      '补一段 verify.imports（点名一个模块 + 类 + 方法）就有这道校验。')
    return r
  }

  const p = resolveRuntimePaths(profile, rootDir)
  const spec = { sys_path: p.sys_path, imports: rt.verify.imports }

  // ⭐ 规格走临时文件而不是命令行参数：模块名里出现引号/中文时，命令行
  //   在 Windows 上会被二次解析（PowerShell 把参数交给原生 exe 时还会吞掉
  //   字符串里的双引号）。文件没有这个问题。
  const specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-envcheck-')), 'spec.json')
  fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8')

  const result = makeResult(profile.id, { level: 'deep' })
  result.info = shallow.info
  // ⭐ 权重轴要一路带下来：深层报告不能把浅层已经查明的事情丢掉，
  //   否则"深层通过"会看起来像"权重也没问题"。
  result.assets = shallow.assets

  let proc
  try {
    proc = spawnSync(p.python, [PROBE, '--spec-file', specFile], {
      cwd: p.cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs || rt.ready_timeout_ms,
      maxBuffer: 8 * 1024 * 1024,
    })
  } finally {
    try { fs.rmSync(path.dirname(specFile), { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  }

  if (proc.error) {
    result.problems.push(`起不动解释器 ${p.python}：${proc.error.message}`)
    return result
  }
  if (proc.status !== 0) {
    // 探针把"没装"编码成 ok=false 并以 0 退出，所以非零码意味着**探针自己
    // 出事了**（解释器坏了、被杀了、超时）。这两种情况必须分开报，否则
    // "环境坏了"会被读成"引擎没装"，人就会去装一遍已经装好的东西。
    result.problems.push(
      `探针非零退出（code=${proc.status}）—— 这是探针本身出事，不是"引擎没装"。\n` +
      `  stderr: ${(proc.stderr || '').trim().slice(-2000)}`)
    return result
  }

  let payload
  try {
    payload = JSON.parse(proc.stdout)
  } catch {
    result.problems.push(
      `探针输出不是 JSON —— 多半是引擎环境在 import 时往 stdout 打了东西。\n` +
      `  stdout: ${(proc.stdout || '').trim().slice(0, 2000)}`)
    return result
  }

  result.info.python = payload.python
  result.info.checks = payload.checks
  for (const c of payload.checks || []) {
    if (!c.ok) {
      result.problems.push(
        `${c.module}${c.class ? '.' + c.class : ''} —— ${c.detail}`)
    }
  }
  result.ok = result.problems.length === 0 && payload.ok === true
  return result
}

module.exports = {
  checkEngineEnvShallow,
  checkEngineEnvDeep,
  resolveRuntimePaths,
  PROBE,
}
