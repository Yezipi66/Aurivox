'use strict'

// ---------------------------------------------------------------------------
//  hostProfile.js —— 交给通用宿主 lib/engines/host.py 的那份 JSON
// ---------------------------------------------------------------------------
//
// 为什么这是**单独一个文件**，而不是往 profile.js 上加四个字段：
//
//   量过：`resolveEngineProfile()` 今天有 9 个 JS 消费方（synthesisService /
//   payload / paramTable / envCheck / voices / flowgraph / gsv client /
//   routes/synthesis / server.js）。它们碰 `call` / `params.load_time` /
//   `output_formats` 的次数是 **0**。
//
//   ⇒ 这四段只有 host.py 一个消费者。把它们塞进 resolveEngineProfile，
//     等于为 1 个消费者拓宽 9 个消费者共用的接口，而且每加一个字段，
//     那 9 处的形状假设就多一分漂移的机会 —— 我们刚被形状漂移咬过一次
//     （`requires_reference_audio` 那两道 400 静默消失）。
//
//   ⇒ 所以：**加法，不改动**。profile.js 一个字节不动，这里在它外面套一层。
//     `buildHostProfile()` 的输出 = resolveEngineProfile 的全部 + 这四段。
//
// ⛔ 这个文件里不许出现任何具体引擎的名字。
//
// 谁调它：
//   - launchPlan.js 算 `{profile_json}` 占位符时（把结果落成临时文件）
//   - tools/dev/probe_profile_contract.py 验收时

const { resolveEngineProfile } = require('./profile')
const { requireEngine } = require('./registry')

function bad(id, field, why) {
  const err = new Error(
    `引擎 ${id} 的 manifest.json ${field} ${why} —— 通用宿主靠它才知道怎么调这台引擎，` +
    `请在 engines/${id}/manifest.json 里补上。`)
  err.code = 'ENGINE_HOST_CONTRACT_INVALID'
  err.field = field
  return err
}

// ---------------------------------------------------------------------------
//  call —— 「怎么调这台引擎的 Python 类」
// ---------------------------------------------------------------------------
//
// ⭐⭐ 注意 `call.bind` 和顶层 `maps` 不是一回事，别合并：
//
//     平台 --HTTP(maps / payload_keys)--> host.py --python(call.bind)--> 上游类
//
//   `maps`      管第一段：平台的词 → HTTP JSON 的键名。payload.js 在用。
//   `call.bind` 管第二段：平台的词 → 上游**方法参数**的名字。
//
//   在某些引擎上两者恰好长得一样，那是巧合。
//   ✅ 2026-08-27 shim.py 已删，两段**果然都还在** —— 那不是它带来的。
// ⭐ `cwd` 是契约 §5.3 就有的键（那边的例子是 `"cwd": "{engine_dir}"`），
//   只是 §5.2 的 python 形态例子里漏了它 —— 键不是新发明的，是补齐。
//   ⛔ 别跟 `runtime.cwd` 混：那个是「启动器从哪儿 spawn」（§9），
//     这个是「调用时上游需要待在哪」。同名不同义，各有各的消费者。
const CALL_KEYS = Object.freeze([
  'kind', 'module', 'class', 'init_args', 'method', 'bind', 'returns', 'seed',
  'cwd', 'argv', 'args',
])

// ⭐ 每种 kind 认得的键是**各自一张表**，不是一张大表。
//   合成一张的那天，就是 `kind: "cli"` 的名片里写着 `module` 却没人吭声那天 ——
//   写了不报错、也不生效，正是 §1 点名的那类静默。
const CALL_KEYS_BY_KIND = Object.freeze({
  python: Object.freeze(['kind', 'module', 'class', 'init_args', 'method',
    'bind', 'returns', 'seed', 'cwd']),
  cli: Object.freeze(['kind', 'argv', 'args', 'bind', 'returns', 'seed', 'cwd']),
})

const CALL_KINDS = Object.freeze(Object.keys(CALL_KEYS_BY_KIND))

// host.py 认得的 bind 槽位。`text` 是唯一无条件必填的
// （没有文本就没有 TTS）；另外两个按条件必填，见下。
//
// ⭐ 槽位表两种 kind 共用，但**槽位里写的东西不同**：
//     python ⇒ 上游方法的参数名（"spk_audio_prompt"）
//     cli    ⇒ 命令行开关（"--voice"）
//   同一个槽位、两种词汇 —— 这正是「运输/形状是数据」的意思。
const BIND_SLOTS = Object.freeze(['text', 'ref_audio', 'output_path'])

// ---------------------------------------------------------------------------
//  cli 形态：一个参数怎么变成命令行上的几个词
// ---------------------------------------------------------------------------
//
// ⛔ 这张表必须是**穷举**的，不许有「其余情况自己看着办」的分支：
//   看着办 = 宿主替名片作者猜，猜错了不报错，只是那个参数没生效。
//
//   value             --flag <值>                     （不写 style 时的默认）
//   boolean           值为真才出现 `--flag`，假就整个不出现
//   boolean_optional  真 ⇒ `--flag`；假 ⇒ `--no-flag`  （argparse 的
//                     BooleanOptionalAction，"不传" 和 "传 false" 是两件事）
//   join              数组用 `join` 串成一个词：`--flag 0,0,1`
//   repeat            数组变成多次：`--flag a --flag b`
const ARG_STYLES = Object.freeze([
  'value', 'boolean', 'boolean_optional', 'join', 'repeat',
])
const ARG_ENTRY_KEYS = Object.freeze(['flag', 'style', 'join'])

// kind="cli"：命令本身。占位符由 host.py 展开（{engine_python} / {engine_dir}
// / {checkpoints} / {root}），这里只管形状。
function parseArgv(call, id) {
  const argv = call.argv
  if (!Array.isArray(argv) || !argv.length) {
    throw bad(id, 'call.argv', 'kind="cli" 要一个非空数组，形如 ["{engine_python}", "-m", "xxx.cli", "synth"]')
  }
  for (const w of argv) {
    if (typeof w !== 'string' || !w.length) {
      throw bad(id, 'call.argv', '里面有不是非空字符串的项')
    }
  }
}

// kind="cli"：引擎私有参数 → 命令行开关的形状表。
// 不写 = 这台引擎除了 bind 那几个槽位之外没有别的开关（合法）。
function parseArgs(call, id) {
  const args = call.args
  if (args === undefined) return
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw bad(id, 'call.args', '写了就得是一个对象：参数名 → { flag, style, join }')
  }
  for (const [name, entry] of Object.entries(args)) {
    const at = `call.args.${name}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw bad(id, at, '得是一个对象，形如 { "flag": "--speed" }')
    }
    for (const k of Object.keys(entry)) {
      if (!ARG_ENTRY_KEYS.includes(k)) {
        throw bad(id, `${at}.${k}`, `不是认得的键（认得的有：${ARG_ENTRY_KEYS.join(', ')}）`)
      }
    }
    if (typeof entry.flag !== 'string' || !entry.flag.startsWith('-')) {
      throw bad(id, `${at}.flag`, '缺了或者不是一个命令行开关（要以 - 开头）')
    }
    const style = entry.style === undefined ? 'value' : entry.style
    if (!ARG_STYLES.includes(style)) {
      throw bad(id, `${at}.style`,
        `写的是 ${JSON.stringify(entry.style)}，只能是：${ARG_STYLES.join(' / ')}`)
    }
    // ⛔ join 是 style="join" 专属。写在别的 style 下 = 作者以为它生效了。
    if (entry.join !== undefined) {
      if (style !== 'join') {
        throw bad(id, `${at}.join`, `只在 style="join" 下有意义，这里的 style 是 "${style}"`)
      }
      if (typeof entry.join !== 'string' || !entry.join.length) {
        throw bad(id, `${at}.join`, '得是一个非空字符串（如 ","）')
      }
    }
    // ⭐ boolean_optional 会自造 `--no-xxx`。开关不是长开关就造不出来，
    //   与其运行期拼出一个上游不认识的词，不如现在喊。
    if (style === 'boolean_optional' && !entry.flag.startsWith('--')) {
      throw bad(id, `${at}.flag`,
        `style="boolean_optional" 要靠 "--no-" 前缀造出否定式，所以开关必须是长开关（-- 开头），现在是 "${entry.flag}"`)
    }
  }
}

function parseCall(manifest, id) {
  const call = manifest.call
  if (!call || typeof call !== 'object') {
    throw bad(id, 'call', '整段都没有')
  }

  // ⭐ kind 先定，键表后查 —— 反过来（先用大表查键、再看 kind）会让
  //   `kind: "cli"` 的名片里写 `module` 一路绿灯到运行期。
  const kind = call.kind || 'python'
  if (!CALL_KINDS.includes(kind)) {
    throw bad(id, 'call.kind',
      `写的是 "${kind}"，通用宿主认得的是：${CALL_KINDS.map((k) => `"${k}"`).join(' / ')}`)
  }
  const allowed = CALL_KEYS_BY_KIND[kind]
  for (const k of Object.keys(call)) {
    if (!allowed.includes(k)) {
      throw bad(id, `call.${k}`,
        `在 kind="${kind}" 下不是认得的键（这种形态认得的有：${allowed.join(', ')}）`)
    }
  }

  if (kind === 'python') {
    for (const k of ['module', 'class', 'method']) {
      if (!call[k] || typeof call[k] !== 'string') {
        throw bad(id, `call.${k}`, '缺了或者不是字符串')
      }
    }
  } else {
    parseArgv(call, id)
    parseArgs(call, id)
  }

  // cwd 可以不写（不写＝不 chdir）；写了就得是条非空路径。
  // ⛔ 在这里拦，是为了让「名片写错」在注册时就喊，而不是等宿主起来
  //   chdir 到一个奇怪的地方再报一个看不出根因的错。
  if (call.cwd !== undefined &&
      (typeof call.cwd !== 'string' || !call.cwd.trim())) {
    throw bad(id, 'call.cwd', '写了就得是一条非空路径（不写＝宿主不 chdir）')
  }

  const bind = call.bind
  if (!bind || typeof bind !== 'object') throw bad(id, 'call.bind', '整段都没有')
  for (const k of Object.keys(bind)) {
    if (!BIND_SLOTS.includes(k)) {
      throw bad(id, `call.bind.${k}`, `不是认得的槽位（认得的有：${BIND_SLOTS.join(', ')}）`)
    }
    if (typeof bind[k] !== 'string' || !bind[k].trim()) {
      throw bad(id, `call.bind.${k}`, '得是一个非空字符串')
    }
    // ⭐ cli 形态下槽位里写的是命令行开关。不以 - 开头的十有八九是把
    //   python 形态的参数名抄了过来 —— 那会变成一个孤零零的位置参数。
    if (kind === 'cli' && !bind[k].startsWith('-')) {
      throw bad(id, `call.bind.${k}`,
        `写的是 "${bind[k]}" —— kind="cli" 下这里要的是命令行开关（如 "--text"），` +
        '不是上游方法的参数名')
    }
  }
  if (!bind.text) throw bad(id, 'call.bind.text', '缺了 —— 没有文本就没有 TTS')

  const returns = call.returns || 'file'
  if (returns !== 'file' && returns !== 'bytes') {
    throw bad(id, 'call.returns', `写的是 "${returns}"，只能是 "file" 或 "bytes"`)
  }
  // ⭐ returns=file ⇒ 宿主要开一个临时文件塞给上游，它必须知道那个参数叫什么。
  if (returns === 'file' && !bind.output_path) {
    throw bad(id, 'call.bind.output_path',
      '缺了 —— call.returns = "file" 时宿主要把临时文件路径递给上游')
  }

  // ⭐ 参考音频：名片顶层说了要，bind 里就必须有槽位接它。
  //   否则宿主会 400 拦下"没给参考音频"的请求，然后在给了的时候把它丢掉。
  if (manifest.capabilities && manifest.capabilities.requires_reference_audio &&
      !bind.ref_audio) {
    throw bad(id, 'call.bind.ref_audio',
      '缺了 —— 这台引擎声明了 requires_reference_audio，宿主得知道参考音频传给哪个参数')
  }

  // seed 由 host.py 的 SeedPlan 做完整校验（契约 §5.2.1 的三态）。
  // ⛔ 这里**不重复**那套判断 —— 两处各写一遍必然分叉，宿主那份才是唯一权威。
  //   这里只确认它在场：不在场是名片没写完，不是宿主的问题。
  if (call.seed === undefined) {
    throw bad(id, 'call.seed',
      '缺了 —— 契约 §5.2.1 要求每张 manifest.json 显式声明可复现性（"none" 也是一个合法答案）')
  }

  return JSON.parse(JSON.stringify(call))
}

// ---------------------------------------------------------------------------
//  params —— 加载期 / 调用期两张白名单
// ---------------------------------------------------------------------------
//
// ⭐⭐ 为什么不复用已有的 `payload_keys`：量过两台真引擎，用法不一致 ——
//   一台的 payload_keys 是干净的「引擎私有参数」，另一台却把 text /
//   ref_audio_path / seed 这些核心键也列了进去。拿它当调用期白名单，
//   后者上「加载期参数出现在调用里」和「不认识的参数」两道 400 都会判错。
//   ⇒ 必须是独立的两张表。
//
// 两类的区别是**生命周期**，不是风格：
//   load_time  构造引擎对象时用，改它要重启进程
//   call_time  每次推理都可以不一样
function parseParams(manifest, id) {
  const params = manifest.params || {}
  if (typeof params !== 'object') throw bad(id, 'params', '不是一个对象')

  const out = {}
  for (const slot of ['load_time', 'call_time']) {
    const v = params[slot]
    if (v === undefined) throw bad(id, `params.${slot}`, '缺了（没有就写空数组 []）')
    if (!Array.isArray(v)) throw bad(id, `params.${slot}`, '不是数组')
    for (const k of v) {
      if (typeof k !== 'string' || !k) {
        throw bad(id, `params.${slot}`, '里面有不是字符串的项')
      }
    }
    out[slot] = v.slice()
  }

  // ⛔ 同一个名字不能既是加载期又是调用期 —— 那样两道 400 会互相打架，
  //   而且没人说得清改了它到底要不要重启。
  const both = out.load_time.filter((k) => out.call_time.includes(k))
  if (both.length) {
    throw bad(id, 'params', `这些名字同时出现在 load_time 和 call_time 里：${both.join(', ')}`)
  }

  if (params.schema !== undefined) out.schema = params.schema
  return out
}

// ---------------------------------------------------------------------------
//  output_formats —— 「要 mp3」那条 400 的判据
// ---------------------------------------------------------------------------
// 不写 = 只出 wav。这是安全的默认：宿主本来就只会把字节原样送回，
// 转码是平台上层的事。
function parseOutputFormats(manifest, id) {
  const raw = manifest.output_formats
  if (raw === undefined || raw === null) return ['wav']
  if (!Array.isArray(raw) || !raw.length) {
    throw bad(id, 'output_formats', '要么别写（默认 ["wav"]），要么写一个非空数组')
  }
  return raw.map((f) => String(f).toLowerCase())
}

// ---------------------------------------------------------------------------
//  装配
// ---------------------------------------------------------------------------
/**
 * @param {object} [opts]
 * @param {string} [opts.checkpointsOverride]  这一次要用哪一份模型（绝对路径）。
 *
 * ⭐⭐⭐ 为什么这个口子非开不可，而且非开在**这里**不可：
 *   宿主填 `init_args` 里的 `{checkpoints}` 时，**不看启动命令行**，它是从
 *   这份写出去的 profile_json 的 `runtime.checkpoints` 自己取的
 *   （host.py 的 _placeholder_values）。
 *   ⇒ 只在启动计划的占位符表里顶替是**不够的**：IndexTTS2 的
 *     `runtime.args` 里压根没有 `{checkpoints}`（只有 profile_json/host/port），
 *     那条顶替一个字都不会被用到。
 *   ⛔ 这个洞不会报错。进程照起、请求照收、声音是底模的 —— 也就是这一刀
 *     本来要修的那个 bug，换个地方原样复发。
 *   ⚠ 自检句：改「送什么给引擎」之前，先问这份数据**是谁读进去的**。
 *
 * ⚠ 写绝对路径是有意的：宿主那边是 `join(root, ckpt)`，join 到绝对路径会
 *   直接采用它，两边都对；而相对路径要求两边对项目根的理解一致，多一个假设。
 */
function buildHostProfile(id, env = process.env, opts = {}) {
  const profile = resolveEngineProfile(id, env)
  const manifest = requireEngine(id)
  const parsedParams = parseParams(manifest, id)
  const call = parseCall(manifest, id)
  const requestedLoad = opts && opts.loadParams
  if (requestedLoad !== undefined && (!requestedLoad || typeof requestedLoad !== 'object' || Array.isArray(requestedLoad))) {
    throw bad(id, 'load_params', '必须是对象')
  }
  const loadParams = requestedLoad || {}
  const unknownLoad = Object.keys(loadParams).filter((name) => !parsedParams.load_time.includes(name))
  if (unknownLoad.length) {
    throw bad(id, 'load_params', `包含未声明为 load_time 的参数：${unknownLoad.join(', ')}`)
  }
  if (Object.keys(loadParams).length) {
    call.init_args = Object.assign({}, call.init_args || {}, loadParams)
  }
  const out = Object.assign({}, profile, {
    call,
    params: parsedParams,
    output_formats: parseOutputFormats(manifest, id),
  })
  const over = opts && opts.checkpointsOverride
  if (over) {
    // ⛔ 不改 profile.runtime 本体 —— 那是解析结果，可能被别人共享着。
    out.runtime = Object.assign({}, out.runtime, { checkpoints: String(over) })
  }
  return out
}

/**
 * 把这份 JSON 写到 spawn 之前它该在的地方。
 *
 * ⭐ 抽到这里、而不是留在 engine-launch-plan.cjs 里，是因为它现在有**两个**
 *   调用方：那条 CLI（启动脚本用）和平台自己的进程看管人（用到才起时用）。
 *   两边各写一遍的那天，就是「平台起的引擎和脚本起的引擎读到不同东西」那天。
 *   ⛔ 而且那条 CLI 结尾会 process.exit，require 不得。
 *
 * ⛔ 解析失败要**原样**抛出去：hostProfile 的报错是点名的（哪个引擎、哪个
 *   字段、为什么）。包一层「写文件失败」会把唯一有用的那句话盖掉。
 */
function writeHostProfileTo(id, dest, opts) {
  const fs = require('node:fs')
  const path = require('node:path')
  const profile = buildHostProfile(id, process.env, opts || {})
  const text = JSON.stringify(profile, null, 2) + '\n'
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, text, 'utf8')
  return Buffer.byteLength(text)
}

module.exports = {
  buildHostProfile, writeHostProfileTo,
  CALL_KEYS, BIND_SLOTS, CALL_KINDS, CALL_KEYS_BY_KIND, ARG_STYLES,
}
