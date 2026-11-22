'use strict'

// 第一道校验：「这台引擎装没装」。只验不建：平台不装环境、不装包、不管版本，只回答一个问题：
// 名片说的那个解释器 / 脚本 / 模块 / 类 / 方法在不在。
// 分两层：浅层 shallow 纯查盘（毫秒级）；深层 deep 起引擎自己的解释器去 import（秒级，只在装完
// 引擎、排障、CI 时做，不能挂在每次合成请求上）。
// 两根轴：result.ok 是「装没装」，result.assets 是「权重在不在」，都是三态。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { resolveEnginePython, venvPythonRelPath } = require('./platformPaths')
const { diagnose } = require('./diagnose')
const { cleanPythonEnv } = require('./verifyAudio')
const { spawnSync } = require('node:child_process')

const PROBE = path.join(__dirname, 'env_probe.py')

function makeResult(id, extra) {
  return Object.assign({
    id,
    ok: false,
    level: 'shallow',
    problems: [],
    // 权重是另一根轴，不进 ok。
    assets: { ok: null, problems: [] },
    info: {},
  }, extra)
}

/**
 * 权重轴：和「装没装」分开算。折进 ok 的话，一台引擎会显示成「没装/不全」，而它的环境完好地
 * 躺在盘上，人会去重装一遍已经装好的环境。
 */
function checkAssets(profile, p, exists) {
  const out = { ok: null, problems: [] }
  if (!p || !p.checkpoints) return out   // 没声明 ⇒ 无从判断，不是通过
  if (exists(p.checkpoints)) { out.ok = true; return out }
  out.ok = false
  out.problems.push(
    `权重目录不存在：${p.checkpoints}\n` +
    `  （manifest.json runtime.checkpoints = ${profile.runtime.checkpoints}）\n` +
    '  这不影响"引擎装没装"的结论：环境可以是好的，只是模型还没下。' +
    '按引擎作者的说明把权重放到上面这个目录即可。')
  return out
}

/**
 * 把名片上的相对路径落到本机上。python / cwd / checkpoints / verify.sys_path 相对项目根，
 * entry 相对名片目录：解释器和权重跟着项目根走，入口脚本跟着引擎目录走。
 */
function resolveRuntimePaths(profile, rootDir, platform) {
  const rt = profile.runtime
  if (!rt) return null
  // runtime.python 是虚拟环境目录，可执行文件由平台按当前平台推导（platformPaths.js）。名片
  // 不许写死 `.venv/Scripts/python.exe`：那个形状在 Linux/macOS 上不存在。
  const plat = platform || process.platform
  return {
    python: resolveEnginePython(rootDir, rt.python, plat),
    entry: path.resolve(profile.dir, rt.entry),
    cwd: rt.cwd ? path.resolve(rootDir, rt.cwd) : rootDir,
    checkpoints: rt.checkpoints ? path.resolve(rootDir, rt.checkpoints) : null,
    sys_path: (rt.verify ? rt.verify.sys_path : []).map((p) => path.resolve(rootDir, p)),
  }
}

// 浅层：只查盘，不起进程。opts 可注入 { rootDir, exists }，便于测试。
function checkEngineEnvShallow(profile, opts = {}) {
  const rootDir = opts.rootDir || path.resolve(__dirname, '..', '..')
  const exists = opts.exists || fs.existsSync
  const result = makeResult(profile.id, { level: 'shallow' })

  if (!profile.runtime) {
    // 「名片没写 runtime」不是错误：这台引擎不由平台起，平台也无从校验它。必须与「校验通过」
    // 分开，否则一张什么都没写的名片会显示成「一切正常」。
    result.ok = null
    result.unmanaged = true
    result.problems.push(
      `${profile.id} 的 manifest.json 没有 runtime 段：平台不负责起这台引擎，也就无从校验它装没装。`)
    return result
  }

  const p = resolveRuntimePaths(profile, rootDir)
  result.info.paths = p

  if (!exists(p.python)) {
    // 解释器不存在有两种可能，报错必须都说：目录压根没有（环境没建），或者目录在而里面没有那个
    // 文件（环境建了但不是 venv，比如建成了 conda 环境）。
    const venvDir = path.resolve(rootDir, profile.runtime.python)
    result.problems.push(
      `解释器不存在：${p.python}\n` +
      `  （manifest.json runtime.python = ${profile.runtime.python}，相对项目根 ${rootDir}）\n` +
      `  平台按当前平台（${process.platform}）在那个目录里找 ` +
      `${venvPythonRelPath(process.platform) || '(不认识这个平台)'}。\n` +
      (exists(venvDir)
        ? '  ⓘ 那个目录是有的，缺的是里面那个可执行文件：' +
          '通常不是用 python -m venv 创建的（比如 conda / 系统 python --target）。\n'
        : '') +
      '  平台只验不建：这条不过就是这台引擎没装，请按引擎作者的说明自行装好它的环境。')
  }
  if (!exists(p.entry)) {
    result.problems.push(
      `入口脚本不存在：${p.entry}\n` +
      `  （manifest.json runtime.entry = ${profile.runtime.entry}，相对 manifest.json 所在目录 ${profile.dir}）`)
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

// 入口没填时留下的占位符不是模块名。与向导入口控件的判据是同一个平台约定：
//   两边各在自己的运行时里判（这里是 Node，那里是浏览器），改约定时一并改。
const MODULE_TOKENS = ['_MODULE_', '__MODULE__']

/**
 * 从 call 段推出要 import 哪个模块：cli 形态取 argv 里 -m 的目标，
 * python 形态取 call.module。读不出（直接跑脚本、或仍是占位符）时返回 null。
 *
 * 这是读取时现算的派生值，不写回名片：入口模块已经写在 call 段，
 *   再存一份副本只会在入口改动后分叉。
 */
function entryModuleOf (call) {
  const c = call || {}
  const kind = c.kind || 'python'
  const usable = (v) => typeof v === 'string' && v && !MODULE_TOKENS.includes(v)
  if (kind === 'python') return usable(c.module) ? c.module : null
  if (kind === 'cli' && Array.isArray(c.argv)) {
    const i = c.argv.indexOf('-m')
    if (i >= 0 && i + 1 < c.argv.length) {
      const m = c.argv[i + 1]
      return usable(m) ? m : null
    }
  }
  return null
}

/**
 * 这道检查要 import 什么。
 *
 * 名片里手写的 imports 是静态声明，原样采用；其中若只有占位符（草稿阶段残留），
 *   等于没声明。没有可用的声明时，用 call 段的推理入口现算。
 * 两处都拿不到就返回空数组，调用方按「无法核对」处理：空 spec 会被探针判成 ok，
 *   那样界面上会出现一个什么都没验的绿勾。
 */
function importsFor (profile, call) {
  const v = (profile && profile.runtime && profile.runtime.verify) || {}
  const declared = Array.isArray(v.imports) ? v.imports : []
  const usable = declared.filter((it) => {
    const m = it && it.module
    return typeof m === 'string' && m && !MODULE_TOKENS.includes(m)
  })
  if (usable.length) return usable
  // profile 有意不透出 call（宿主契约），调用方从名片里取一段传进来。
  const entry = entryModuleOf(call || (profile && profile.call))
  return entry ? [{ module: entry }] : []
}

/**
 * 深层：拿引擎自己的解释器去 import 名片点名的模块/类/方法。浅层过了不代表深层会过：包没装齐
 * 要到 import 才现形。浅层不过就不做深层：解释器都不在，起它只会得到一句 ENOENT。
 */
function checkEngineEnvDeep(profile, opts = {}) {
  const rootDir = opts.rootDir || path.resolve(__dirname, '..', '..')
  const shallow = checkEngineEnvShallow(profile, opts)
  if (shallow.ok !== true) return shallow

  const rt = profile.runtime
  if (!rt.verify) {
    // 写了 runtime 却没写 verify：能起进程，但平台无从核对「装没装」，不能报成绿。
    const r = makeResult(profile.id, { level: 'deep', ok: null, unverifiable: true })
    r.info = shallow.info
    r.assets = shallow.assets
    r.problems.push(
      `${profile.id} 的 manifest.json 有 runtime 但没有 runtime.verify：` +
      '平台能起它，却没法在起之前判断它装没装。' +
      '补一段 runtime.verify（给出 sys_path 即可）就有这道校验：' +
      '要 import 什么由 call 段的推理入口现算，也可在 verify.imports 里手写。')
    return r
  }

  // 没有可核对的对象时如实报「无法核对」，不能拿空 spec 去跑：
  //   探针收到空 imports 会返回 ok=true，界面就成了什么都没验的绿勾。
  const imports = importsFor(profile, opts.call)
  if (!imports.length) {
    const r = makeResult(profile.id, { level: 'deep', ok: null, unverifiable: true })
    r.info = shallow.info
    r.assets = shallow.assets
    r.problems.push(
      `${profile.id} 的 manifest.json 没有可核对的导入项：` +
      'verify.imports 没有声明，call 段也读不出推理入口模块。' +
      '把推理入口填成模块名（或手写 verify.imports）就有这道校验。')
    return r
  }

  const p = resolveRuntimePaths(profile, rootDir)
  const spec = { sys_path: p.sys_path, imports }

  // 规格走临时文件而不是命令行参数：模块名里有引号或中文时，命令行在 Windows 上会被二次解析。
  const specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-envcheck-')), 'spec.json')
  fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8')

  const result = makeResult(profile.id, { level: 'deep' })
  result.info = shallow.info
  // 权重轴一路带下来：深层报告不能把浅层已经查明的事情丢掉。
  result.assets = shallow.assets

  let proc
  try {
    proc = spawnSync(p.python, [PROBE, '--spec-file', specFile], {
      cwd: p.cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs || rt.ready_timeout_ms,
      maxBuffer: 8 * 1024 * 1024,
      env: cleanPythonEnv(),
    })
  } finally {
    try { fs.rmSync(path.dirname(specFile), { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  }

  if (proc.error) {
    result.problems.push(`起不动解释器 ${p.python}：${proc.error.message}`)
    return result
  }
  if (proc.status !== 0) {
    // 探针把「没装」编码成 ok=false 并以 0 退出，非零码意味着探针自己出事（解释器坏了、被杀了、
    // 超时）。两类情况必须分开报，否则「环境坏了」会被读成「引擎没装」。
    result.problems.push(
      `探针非零退出（code=${proc.status}）：这是探针本身出事，不是"引擎没装"。\n` +
      `  stderr: ${(proc.stderr || '').trim().slice(-2000)}`)
    return result
  }

  let payload
  try {
    payload = JSON.parse(proc.stdout)
  } catch {
    result.problems.push(
      `探针输出不是 JSON：通常是引擎环境在 import 时往 stdout 打了东西。\n` +
      `  stdout: ${(proc.stdout || '').trim().slice(0, 2000)}`)
    return result
  }

  result.info.python = payload.python
  result.info.checks = payload.checks
  // 同一份结果用两种形状交出去：problems 是平台端一直在读的字符串数组，一字不改；
  //   import_diagnostics 是给界面分层用的结构化副本，把导入结论与操作建议分开摆。
  //   探针的 stdout 是 JSON 协议通道，模块顶层的 print 在导入期被吞掉，
  //   这里没有给人看的原始 stdout：不再造一个 stdout 字段冒充输出原文。
  const importDiagnostics = []
  for (const c of payload.checks || []) {
    if (!c.ok) {
      result.problems.push(
        `${c.module}${c.class ? '.' + c.class : ''}：${c.detail}`)
      // 逐条导入结论由 info.checks 单独带（含通过的项），这里只留诊断与办法。
      const entry = {
        module: c.module,
        class: c.class || null,
      }
      // 缺包这一类再补一句「装什么、装到哪」：这一格是使用者第一次看见缺依赖的地方，
      //   只报 No module named 等于让人自己从 traceback 里找名字。
      //   口径仍只有 diagnose 一份，这里只负责把它的结论接到原文后面。
      if (/no module named|cannot import name|dll load failed/i.test(c.detail || '')) {
        const d = diagnose(c.detail, null)
        // 原因与办法各占一行：挤成一行时，两句话都读不完整。
        result.problems.push(`${d.cause}。`, d.hint)
        // 结论与办法分开存：界面把它们放进不同层，不再混在一段说明文字里。
        entry.cause = d.cause
        entry.causeEn = d.causeEn
        entry.hint = d.hint
        entry.hintEn = d.hintEn
        // 缺的包名单单独带：命令块由前端用第 2 步同款命令框拼，venv 路径前端才拿得到。
        entry.missingPackage = d.missingPackage || null
      }
      importDiagnostics.push(entry)
    }
  }
  result.import_diagnostics = importDiagnostics
  result.ok = result.problems.length === 0 && payload.ok === true
  return result
}

module.exports = {
  checkEngineEnvShallow,
  checkEngineEnvDeep,
  resolveRuntimePaths,
  PROBE,
}
