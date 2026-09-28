'use strict'

// ============================================================================
//  参数草稿生成器 —— Node 侧
//
//  反射（Python 侧 lib/engines/reflect_params.py）回答「有哪些参数、叫什么、
//  默认是什么」。**这一层回答「哪些该进 parameters[]、写成什么形状」**。
//
//  ⭐⭐ 它生成的是**草稿**，不是成品：
//     生成完请逐条核对 —— 尤其是 min/max/choices/label/help 这些
//     反射拿不到的东西。草稿里那些 REPLACE_ME 是提醒你「这里要人来填」。
//
//  ⛔ 平台不替名片作者猜：猜错的表现是「参数在界面上有、点下去没反应」，
//     或者更糟 —— 静默用了一个错的值。所以每一处「我不知道」都显式写成
//     REPLACE_ME，而不是填一个看着合理的默认。
// ============================================================================

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
// ⚠ require 相对**本文件**解析（不是 cwd）。写在 main() 里用 '../lib/...' 也对，
//   但那样一旦解析失败，报错会被下面那个 catch 吞成「读不到名片」——
//   把「我写错了路径」说成「你的名片坏了」，是最难查的一类误导。
const { resolveEngineProfile } = require('../lib/engines/profile')
const { requireEngine } = require('../lib/engines/registry')

const REFLECTOR = path.join(ROOT, 'lib', 'engines', 'reflect_params.py')

// ---------------------------------------------------------------------------
//  ⭐⭐ 排除名单 —— 生成器最核心的判断
// ---------------------------------------------------------------------------
//
//  反射会看到**全部**参数，包括那些**根本不该做成界面格子**的。举例
//  （下面是真数据，从 engines/indextts2 反射出来的）：
//
//    cfg_path   默认 'checkpoints/config.yaml'  ← 路径，由 init_args 固定
//    model_dir  默认 'checkpoints'              ← 路径，由 {checkpoints} 顶替
//    device     默认 None                       ← 设备选择，平台自己探测过
//
//  这三个如果做成滑块/输入框，用户改了会怎样？
//    cfg_path 改错 ⇒ 引擎起不来，报错指向一个跟根因无关的地方
//    model_dir 改错 ⇒ 加载的不是那份底模，声音是**别人的**，且不报错
//    device     改错 ⇒ 可能 CPU 推理，慢 50 倍，没有任何提示
//
//  而 IndexTTS2 的真名片**正确地把这三个排除了**（它们在 call.init_args
//  里作为固定值）。⇒ 生成器必须做同样的判断，否则它的产出比没有更糟：
//  它会「热情地」建议用户把最不该暴露的三个参数做成旋钮。
//
//  ⛔ 为什么这里用**显式名单**而不是自动推断：
//     判据「这个参数名像不像个路径」是猜的，而猜错不报错。
//     一份可以逐条审阅、逐条加进去的名单，是能被检查的；一个启发式不是。
//     ⚠ 加进这份名单之前先问：改它，出的是「报错」还是「声音不对」？
//       后者一律不许做成界面格子。
const EXCLUDE = Object.freeze({
  // 路径类 —— 归 call.init_args / {checkpoints} 占位符管
  // ⚠⚠ 这条正则被测试逼着收窄过一次。
  //   原版把 `prompt_path_ratio` 也排了 —— 而它是一个**正常的数值旋钮**
  //   （prompt 音频的占比）。误排的代价与漏排一样重：界面上少一个真实
  //   存在的旋钮，而且**没有任何报错**。
  //   ⇒ 收紧成「**整个参数名就是那个路径**」才算 path：
  //     cfg_path / model_dir / vocoder_file —— 排
  //     prompt_path_ratio / dirichlet / directory_depth —— 不排
  //   判据：路径参数一般是「名词 + _path/_dir」，而含 path 的**比率/开关**
  //   后面跟的是别的语义词。
  //   第二段覆盖「路径的复数/列表」：aux_paths / model_files / data_dirs
  path_like: /^(cfg|config|model|vocoder|ckpt|weight|output|input|ref|save|load|cache|tmp|temp|index|meta|aux|extra|add|secondary|speaker|spk|ref|refer|tokenizer|vocab)(_(path|dir|dirs|file|files|folder|paths|yaml|json|bin|pth|ckpt))?$|^_?(path|dir|dirs|file|files|folder|paths)$/i,
  // 平台自己已经管的事 —— 重复暴露会出现两个真相
  platform_owned: /^(device|devices|use_cuda|cuda|gpu|world_size|local_rank|master_port|dist_url)$/i,
  // 宿主要用的内部槽位（与 host.py 的 BIND_SLOTS 同源）
  bind_slots: /^(text|ref_audio|output_path|output_dir)$/,
})

// ---------------------------------------------------------------------------
//  类型推断：把「反射给的线索」翻译成「平台的五种 type」
// ---------------------------------------------------------------------------
//  ⚠ 每条都带一个 confidence，**界面必须显示它** ——
//     「这是从默认值猜的」和「这是上游自己声明的」不是一回事。
function inferType(entry) {
  const up = entry.upstream_choices
  if (up && up.length) {
    // ⭐ 上游自己写了 Literal['a','b'] —— 这是**它说的**，不是我们猜的
    return { type: 'select', confidence: 'strong', why: '上游签名的 Literal[...] 里列了这些值', choices: up }
  }
  const k = entry.kind || {}
  switch (k.kind) {
    case 'boolean':
      return { type: 'boolean', confidence: k.confidence, why: k.why }
    case 'integer':
      // ⭐ 保留 integer 这个写法：paramTypes.js 认它，且降级成 number 之后
      //   仍单独记住「要整数」—— 7.5 悄悄发给只吃整数的引擎是最难查的
      return { type: 'integer', confidence: k.confidence, why: k.why }
    case 'number':
      return { type: 'number', confidence: k.confidence, why: k.why }
    case 'text':
      return { type: 'text', confidence: k.confidence, why: k.why }
    case 'list':
      return { type: 'number', confidence: k.confidence, why: k.why + `（长度 ${k.len}）`, repeat: k.len || 1 }
    case 'dict':
      return { type: 'text', confidence: 'weak', why: k.why + ' —— 界面能编辑文本，但结构要你自己核对' }
    case 'object':
      return { type: 'text', confidence: 'weak', why: k.why }
    default: {
      // ⭐ 默认值给不出类型时，**用参数名给一个建议** —— 但标成 needs_review。
      //
      // 为什么不是「猜不动就丢掉」：实测 IndexTTS2 的 14 个真参数里 4 个
      // 默认值是 None（use_cuda_kernel / emo_audio_prompt / emo_vector /
      // emo_text），人是按**参数名的语义**定的类型。丢掉它们的实际后果是
      // 「界面上少了一个真实存在的旋钮」，而且**没有任何报错** ——
      // 那是这个项目最贵的一类失败。
      //
      // ⛔ 但它必须 needs_review：名字是弱证据。`use_fast` 可能是开关，
      // 也可能是「用快速模式的那个路径」。所以建议给出，**决定由人下**。
      const h = entry.name_hint
      if (!h) return { type: null, confidence: 'none', why: k.why || '反射不出类型，名字也没线索' }
      const guess = { boolean: 'boolean', number: 'number', 'number[]': 'number', text: 'text', audio: 'text' }[h.kind]
      // ⭐ 名字线索是「路径」时**不给类型**，而 needs_human=true ——
      //   它确实需要人定（这个路径该不该暴露？归不归 init_args？），
      //   但它不属于「类型反射不出」那一类：名字已经说了它是路径。
      if (!guess) {
        return {
          type: null, confidence: 'none', needs_human: true,
          why: h.kind === 'path?'
            ? `${h.why} —— 它是路径：先确认该不该做成界面格子（多半归 call.init_args）`
            : `${k.why}；名字线索「${h.kind}」没有对应类型`,
        }
      }
      return {
        type: guess, confidence: 'weak', needs_review: true,
        why: `${k.why}；按名字猜的（${h.why}）—— ⛔ 请人工确认`,
        from_name: h.kind,
        repeat: h.kind === 'number[]' ? 1 : undefined,
        path_suspect: h.kind === 'path?' || undefined,
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  排除判定
// ---------------------------------------------------------------------------
function exclusionReason(name) {
  if (EXCLUDE.bind_slots.test(name)) return '宿主 bind 槽位（归 call.bind，不是引擎参数）'
  if (EXCLUDE.path_like.test(name)) return '路径类 —— 归 call.init_args / {checkpoints}，做成格子改了会「声音不对且不报错」'
  if (EXCLUDE.platform_owned.test(name)) return '平台自己已经管的事（设备探测等）—— 暴露会出现两个真相'
  return null
}

// ---------------------------------------------------------------------------
//  跑反射
// ---------------------------------------------------------------------------
/**
 * @param {object} spec { python, module, class, method, sys_path, skip }
 * @param {object} [opts] { timeoutMs }
 * @returns {object} 反射结果（永远是对象；失败时 ok:false）
 */
function reflectParams(spec, opts = {}) {
  // ⚠ 规格走临时文件而不是命令行参数：模块名里出现引号/中文时，
  //   命令行在 Windows 上会被二次解析（与 envCheck.js 同一条理由）。
  const specFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-reflect-')), 'spec.json')
  fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8')

  let proc
  try {
    proc = spawnSync(spec.python, [REFLECTOR, '--spec-file', specFile], {
      encoding: 'utf8',
      timeout: opts.timeoutMs || 120000,
      maxBuffer: 16 * 1024 * 1024,
      // ⚠ cwd 用引擎自己声明的那个（如果有）—— 有些包按相对路径找资源
      cwd: spec.cwd || process.cwd(),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
  } catch (err) {
    return { ok: false, stage: 'spawn', error: `起不动解释器 ${spec.python}：${err.message}` }
  } finally {
    try { fs.rmSync(path.dirname(specFile), { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  }

  if (proc.error) {
    return { ok: false, stage: 'spawn', error: `起不动解释器 ${spec.python}：${proc.error.message}` }
  }
  if (proc.status !== 0) {
    // ⭐ 反射器永远以 0 退出（ok=false 是一个答案）。非零 = 它自己出事了，
    //   与「这台引擎反射不出来」是两回事，必须分开说。
    return {
      ok: false, stage: 'crash',
      error: `反射器非零退出（code=${proc.status}）—— 这是反射器自己出事，不是「这台引擎没参数」`,
      detail: (proc.stderr || '').slice(-2000),
    }
  }
  let payload
  try {
    payload = JSON.parse(proc.stdout)
  } catch {
    return {
      ok: false, stage: 'parse',
      error: '反射器输出不是 JSON —— 多半是引擎环境在 import 时往 stdout 打了东西',
      detail: (proc.stdout || '').slice(0, 2000),
    }
  }
  return payload
}

// ---------------------------------------------------------------------------
//  组装 parameters[] 草稿
// ---------------------------------------------------------------------------
const TITLE = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/**
 * 把反射结果变成 parameters[] 草稿。
 * @returns {{parameters: object[], excluded: object[], warnings: string[]}}
 */
function buildDraft(reflection, opts = {}) {
  const parameters = []
  const excluded = []
  const warnings = [...(reflection.warnings || [])]
  // ⚠ opts.existing 是**名字数组**（['emo_alpha']），不是对象数组。
  //   写成 .map(e => e.name) 时，对字符串取 .name 得到 undefined ⇒ 集合永远是空
  //   ⇒ _already_in_manifest 永远不设 ⇒ 「不覆盖别人已有的参数」这条形同虚设。
  //   ⛔ 两种都收：字符串或 {name} 都行，但**不许**只收其中一种 ——
  //     静默失效的那一种最难查。
  const existing = new Set((opts.existing || []).map((e) =>
    (typeof e === 'string' ? e : (e && e.name))))

  for (const phase of ['load', 'call']) {
    const rows = reflection[phase] || []
    // order：同一 phase 内按出现顺序 10,20,30…（界面排序用）
    let n = 0
    for (const entry of rows) {
      n += 1
      if (entry.skipped) {
        excluded.push({ name: entry.name, phase, reason: entry.why })
        continue
      }
      const why = exclusionReason(entry.name)
      if (why) {
        excluded.push({ name: entry.name, phase, reason: why })
        continue
      }
      const t = inferType(entry)
      if (!t.type) {
        // ⚔ 类型猜不出来的**也要列出来**，但标成「需要人来定」。
        //   悄悄丢掉的话，用户会以为这个参数不存在 —— 而它确实存在，
        //   只是平台不知道怎么在界面上表示它。
        excluded.push({
          name: entry.name, phase, reason: `类型反射不出（${t.why}）—— 需要人工指定 type`,
          needs_human: true,
        })
        continue
      }

      const draft = {
        name: entry.name,
        type: t.type,
        phase: phase === 'load' ? 'load' : 'call',
        tier: phase === 'load' ? 'advanced' : 'common',
        group: phase === 'load' ? 'runtime' : 'generate',
        order: n * 10,
        label: { en: TITLE(entry.name), zh: 'REPLACE_ME' },
        help: {
          en: `REPLACE_ME (inferred: ${t.why})`,
          zh: 'REPLACE_ME',
        },
        _confidence: t.confidence,
        _why: t.why,
      }
      // ⭐ 按名字猜出来的条目：留在草稿里，但**逐条标出来**。
      //   删掉它 = 界面上少一个真实存在的旋钮（且不报错）；
      //   不标出来 = 人会以为那是反射得来的事实。
      if (t.needs_review) {
        draft._needs_review = true
        draft._why = `${t.why}`
      }
      if (t.path_suspect) {
        draft._path_suspect = true
      }
      // ⭐ default 只在「反射拿得到且拿得准」时才填：
      //   None / guess 出来的类型不填 —— 填了就是「平台替你决定默认值」，
      //   而那正是 C11 要杀的那类「设了没效果」。
      // ⚠ 只在「类型是反射得来的」时填默认值。
      //   名字猜出来的类型配一个默认值 = 平台替人定了两件事，
      //   而这两件都可能错，且错了不报错。
      if (entry.default !== null && entry.default !== undefined
          && t.confidence !== 'weak' && !t.needs_review) {
        draft.default = entry.default
      }
      if (t.choices) {
        draft.choices = t.choices.map((v) => ({ value: v, label: { en: String(v), zh: 'REPLACE_ME' } }))
      }
      if (t.repeat && t.repeat > 1) {
        draft.repeat = t.repeat
      }
      // ⭐ 名片里已经有的参数：标出来，**不静默覆盖**。
      //   生成器的产物是要人核对的草稿；直接盖掉别人写好的那一条，
      //   而草稿里那条的 help/label 是 REPLACE_ME —— 那是「把已完成的
      //   工作退回占位符」。宁可两条都在，让人自己决定删哪条。
      if (existing.has(entry.name)) {
        draft._already_in_manifest = true
      }
      parameters.push(draft)
    }
  }
  return { parameters, excluded, warnings }
}

// ---------------------------------------------------------------------------
//  CLI
// ---------------------------------------------------------------------------
//  ⭐ 默认**只打印**。写盘要 --write —— 覆盖别人的 manifest.json 不是一个
//    好的默认值。
function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
  const flag = (k) => argv.includes(k)

  const engineId = arg('--engine')
  const moduleName = arg('--module')
  const className = arg('--class')
  const methodName = arg('--method')
  const write = flag('--write')

  // ⚠ 只要求 --engine。module/class 名片里有，让它自己读 ——
  //   要求命令行也传一遍 = 逼用户把名片里的内容重打一次，
  //   而打错的那份不会被任何东西验证。
  if (!engineId) {
    process.stdout.write(
      '参数草稿生成器 —— 反射出上游有哪些参数，生成 parameters[] 草稿\n\n' +
      '用法：\n' +
      '  node tools/scaffold-params.cjs --engine <id> [--method <name>] [--write]\n' +
      '  node tools/scaffold-params.cjs --engine <id> --module <m> --class <c> [--method <n>]\n\n' +
      '只给 --engine 就够：module/class/runtime 从名片读。\n' +
      '名片里没有 call 段时，用 --module <m> --class <c> [--method <n>] 手工给。\n' +
      '不带 --write 只打印，不动盘。\n\n' +
      '⚠ 生成的是**草稿**：min/max/choices/中英文标签反射拿不到，需要人核对。\n')
    return 1
  }

  // ⚠ 这两件事失败的原因**完全不同**，必须分开说：
  //    requireEngine 失败 = 名片有问题（它会告诉你是哪个键）
  //    resolveEngineProfile 失败 = 名片能读但内容不合法
  //    合成一句话报出去 = 用户会去改名片，而真正的问题在别处。
  let manifest
  try {
    manifest = requireEngine(engineId)
  } catch (err) {
    process.stderr.write(`读不到引擎 ${engineId} 的名片：${(err && err.message) || err}\n`)
    process.stderr.write('名片还没写好？那就先手写一份最小的（至少 id/runtime/call），再来生成参数。\n')
    return 1
  }
  let profile
  try {
    profile = resolveEngineProfile(engineId, process.env)
  } catch (err) {
    process.stderr.write(`名片能读，但解析没过（${(err && err.code) || '?'}）：${(err && err.message) || err}\n`)
    return 1
  }

  const call = manifest.call || {}
  const mod = moduleName || call.module
  const cls = className || call.class
  const mth = methodName !== null ? methodName : (call.method || null)
  const rt = profile.runtime || {}

  if (!mod || !cls) {
    process.stderr.write(
      `名片里没有 call 段（call.module / call.class）—— 反射需要知道 import 哪个模块的哪个类。\n` +
      '两种走法：\n' +
      '  1) 先手写 call 段（module/class/method），再来生成 parameters[]\n' +
      '  2) 直接命令行给：--module <m> --class <c> [--method <n>]\n')
    return 1
  }

  const sysPath = (rt.verify && rt.verify.sys_path) || [path.join('engines', engineId)]
  const spec = {
    python: rt.python,
    cwd: rt.cwd || '.',
    module: mod,
    class: cls,
    method: mth,
    sys_path: sysPath.map((p) => path.resolve(ROOT, p)),
    skip: [],
  }

  process.stdout.write(`反射 ${cls}（模块 ${mod}${mth ? `，方法 ${mth}` : ''}）\n`)
  process.stdout.write(`解释器 ${rt.python}\n\n`)

  const reflection = reflectParams(spec)
  if (!reflection.ok) {
    process.stderr.write(`反射失败（${reflection.stage}）：${reflection.error}\n`)
    if (reflection.detail) process.stderr.write(`\n${reflection.detail}\n`)
    return 1
  }
  process.stdout.write(`  用的源码 ${reflection.python.module_file}\n`)

  const existing = (manifest.parameters || []).map((p) => p.name)
  const { parameters, excluded, warnings } = buildDraft(reflection, { existing })

  for (const w of warnings) process.stdout.write(`  ⚠ ${w}\n`)

  process.stdout.write(`\nparameters[] 草稿（${parameters.length} 条）\n`)
  process.stdout.write('─'.repeat(72) + '\n')
  process.stdout.write(JSON.stringify(parameters, null, 2) + '\n')

  if (excluded.length) {
    process.stdout.write(`\n排除的（${excluded.length} 条）—— 每条都说了为什么\n`)
    process.stdout.write('─'.repeat(72) + '\n')
    for (const e of excluded) {
      const flag2 = e.needs_human ? '⚠ 需要人定' : '  '
      process.stdout.write(`${flag2} ${e.phase.padEnd(4)} ${e.name.padEnd(30)} ${e.reason}\n`)
    }
  }

  if (existing.length) {
    const dup = parameters.filter((p) => p._already_in_manifest).map((p) => p.name)
    if (dup.length) {
      process.stdout.write(`\n⚠ 名片里已经有这些参数了，生成器不会覆盖它们：${dup.join(', ')}\n`)
    }
  }

  const out = path.join(ROOT, 'engines', engineId, 'parameters.draft.json')
  if (write) {
    fs.writeFileSync(out, JSON.stringify(parameters, null, 2) + '\n', 'utf8')
    process.stdout.write(`\n已写到 ${out}\n`)
    process.stdout.write('⛔ 这是**草稿**，不是成品：先逐条核对，再手工并进 manifest.json 的 parameters[]。\n')
    process.stdout.write('   （并进去之后记得删掉每个条目上的 _confidence / _why 两个下划线键。）\n')
  } else {
    process.stdout.write(`\n（只打印，没动盘。加 --write 写到 ${out}）\n`)
  }
  return 0
}

module.exports = { reflectParams, buildDraft, inferType, exclusionReason, EXCLUDE, REFLECTOR }

if (require.main === module) {
  process.exit(main(process.argv.slice(2)))
}
