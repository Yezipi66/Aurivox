'use strict'

// hostProfile.js：交给通用宿主 lib/engines/host.py 的那份 JSON。
// 在 resolveEngineProfile() 的结果外面套一层，不改动它：call / params / output_formats
// 这几段只有 host.py 一个消费者，塞进 resolveEngineProfile 等于为 1 个消费者拓宽共用接口，
// 每加一个字段就多一分形状漂移的机会（漂移不报错，只表现为某个 400 静默消失）。

const { resolveEngineProfile } = require('./profile')
const { requireEngine } = require('./registry')

function bad(id, field, why) {
  const err = new Error(
    `引擎 ${id} 的 manifest.json ${field} ${why}：通用宿主靠它才知道怎么调这台引擎，` +
    `请在 engines/${id}/manifest.json 里补上。`)
  err.code = 'ENGINE_HOST_CONTRACT_INVALID'
  err.field = field
  return err
}

// call：怎么调这台引擎的上游入口。`call.bind` 与名片的 `maps` 不是一回事：bind 管「平台的词
// → 上游入口的参数名」，两者在部分引擎上恰好同名只是巧合。
// `call.cwd` 也别跟 `runtime.cwd` 混：那个是启动器从哪儿 spawn，这个是调用时上游要待在哪。
const CALL_KEYS = Object.freeze([
  'kind', 'module', 'class', 'init_args', 'method', 'bind', 'returns', 'seed',
  'cwd', 'argv', 'args', 'weights',
])

// 每种 kind 认得的键是各自一张表，不是一张大表：合成一张表，`kind: "cli"` 的名片里写着
// `module` 就没人吭声，写了不报错也不生效。
const CALL_KEYS_BY_KIND = Object.freeze({
  // generator_sample_rate 只给 python 那一支：cli 形态吐的是 stdout 上的字节流，采样率在
  // WAV 头里。methods / default_method 同理：cli 只有一个 argv 入口，切方法要另一套模板。
  python: Object.freeze(['kind', 'module', 'class', 'init_args', 'method',
    'methods', 'default_method', 'ref_audio_optional_if', 'bind', 'returns', 'generator_sample_rate',
    'seed', 'cwd', 'weights']),
  cli: Object.freeze(['kind', 'argv', 'args', 'bind', 'returns', 'seed', 'cwd', 'weights']),
})

const CALL_KINDS = Object.freeze(Object.keys(CALL_KEYS_BY_KIND))

// bind 槽位。`text` 是唯一无条件必填的（没有文本就没有 TTS），ref_audio / output_path 按条件必填，
// ref_text（参考音频里念的那句话）可选：没绑时宿主收下请求里的参考文本，不交给上游。
// 槽位表两种 kind 共用，槽位里写的东西不同：python 写上游方法的参数名，cli 写命令行开关。
// 与 host.py 的 BIND_SLOTS 同一张表。
const BIND_SLOTS = Object.freeze(['text', 'ref_audio', 'ref_text', 'output_path'])

// cli 形态：一个参数怎么变成命令行上的几个词。这张表是穷举的，没有「其余情况看着办」的分支：
// 看着办等于替名片作者猜，猜错不报错，只是那个参数没生效。
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

// kind="cli"：命令本身。占位符由 host.py 展开，这里只管形状。
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

// kind="cli"：引擎私有参数 → 命令行开关的形状表。不写 = 这台引擎除了 bind
// 那几个槽位之外没有别的开关（合法）。
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
    // join 是 style="join" 专属。写在别的 style 下 = 作者以为它生效了。
    if (entry.join !== undefined) {
      if (style !== 'join') {
        throw bad(id, `${at}.join`, `只在 style="join" 下有意义，这里的 style 是 "${style}"`)
      }
      if (typeof entry.join !== 'string' || !entry.join.length) {
        throw bad(id, `${at}.join`, '得是一个非空字符串（如 ","）')
      }
    }
    // boolean_optional 会自造 `--no-xxx`。开关不是长开关就造不出来，与其运行期拼出
    // 一个上游不认识的词，不如现在喊。
    if (style === 'boolean_optional' && !entry.flag.startsWith('--')) {
      throw bad(id, `${at}.flag`,
        `style="boolean_optional" 要靠 "--no-" 前缀造出否定式，所以开关必须是长开关（-- 开头），现在是 "${entry.flag}"`)
    }
  }
}

// 权重有没有交到引擎手里。
//
// 名片写了 runtime.checkpoints（权重放在哪），不等于引擎会去那里读：
//   python 形态要在 call.init_args 里有一项写成 "{checkpoints}" 或 "{checkpoints}/文件名"，
//   cli 形态要在 call.argv 里有一个词带 {checkpoints}。
// 两处都没有时症状不是报错：进程照起、请求照收，读的是上游自己的默认路径
//   （常常是联网去拉，或者干脆是另一份模型）。所以没写就当场拦。
// 引擎确实自己找权重（写死在源码里、或从工作目录的相对路径读），写 call.weights = "self" 声明一下。
// 名片没写 runtime.checkpoints ⇒ 没有可交的权重，不要求。
//
// 返回 null 表示没问题；否则返回 { field, why }。向导的检查器调同一个函数，不另写一份判据。
const CHECKPOINTS_TOKEN = '{checkpoints}'
function weightsProblem(manifest) {
  const rt = (manifest && manifest.runtime) || {}
  const call = (manifest && manifest.call && typeof manifest.call === 'object') ? manifest.call : null
  if (!call) return null
  if (call.weights !== undefined) {
    if (call.weights === 'self') return null
    return { field: 'call.weights', why: `写的是 ${JSON.stringify(call.weights)}，只能是 "self"（引擎自己找权重）；要把权重传给引擎就别写这一项` }
  }
  if (typeof rt.checkpoints !== 'string' || !rt.checkpoints.trim()) return null
  const has = (v) => typeof v === 'string' && v.includes(CHECKPOINTS_TOKEN)
  const kind = call.kind || 'python'
  if (kind === 'cli') {
    if ((Array.isArray(call.argv) ? call.argv : []).some(has)) return null
    return { field: 'call.argv',
      why: '没有一个词带 {checkpoints}：引擎不知道权重在哪。把权重参数写成 "--某开关", "{checkpoints}"；引擎自己找权重就写 call.weights = "self"' }
  }
  const init = (call.init_args && typeof call.init_args === 'object') ? call.init_args : {}
  if (Object.values(init).some(has)) return null
  return { field: 'call.init_args',
    why: '没有一项是 {checkpoints}：引擎不知道权重在哪。在 init_args 里把权重参数写成 "{checkpoints}"（或 "{checkpoints}/文件名"）；引擎自己找权重就写 call.weights = "self"' }
}

function parseCall(manifest, id) {
  const call = manifest.call
  if (!call || typeof call !== 'object') {
    throw bad(id, 'call', '整段都没有')
  }

  // 键表按 kind 取，所以先定 kind。
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
    // 一个引擎可以有多个推理入口，单数字段 call.method 表达不了。两条路互斥：
    //   call.methods：多方法，须配 call.default_method
    //   call.method：单方法
    const multi = call.methods && typeof call.methods === 'object'
    const names = multi ? Object.keys(call.methods) : []
    if (multi) {
      if (!names.length) {
        throw bad(id, 'call.methods', '写了个空对象：不如不写（不写就是单方法）')
      }
      // 两条都写 = 两个权威 = 名片自己跟自己矛盾。必须报错，不许「挑一个」。
      if (call.method) {
        throw bad(id, 'call.method',
          `和 call.methods 同时写了（${names.join(', ')}）：哪一个是权威？`
          + '留一个：多方法用 call.methods + call.default_method，'
          + '单方法用 call.method')
      }
      const def = call.default_method
      if (!def) {
        throw bad(id, 'call.default_method',
          `call.methods 有 ${names.length} 个方法（${names.join(', ')}）但没写默认走哪个`
          + '：不许「取第一个」：那会随名片编辑顺序而漂移')
      }
      if (!names.includes(def)) {
        throw bad(id, 'call.default_method',
          `= ${JSON.stringify(def)}，不在 call.methods 里（现有：${names.join(', ')}）`)
      }
      for (const n of names) {
        const mc = call.methods[n]
        if (!mc || typeof mc !== 'object') {
          throw bad(id, `call.methods.${n}`, '得是个对象')
        }
        if (mc.method !== undefined &&
            (typeof mc.method !== 'string' || !mc.method.trim())) {
          throw bad(id, `call.methods.${n}.method`, '写了就得是非空字符串')
        }
        if (mc.bind !== undefined) {
          if (typeof mc.bind !== 'object' || mc.bind === null) {
            throw bad(id, `call.methods.${n}.bind`, '得是个对象')
          }
          for (const bk of Object.keys(mc.bind)) {
            if (!BIND_SLOTS.includes(bk)) {
              throw bad(id, `call.methods.${n}.bind.${bk}`,
                `不是认得的槽位（认得的有：${BIND_SLOTS.join(', ')}）`)
            }
          }
        }
        for (const flag of ['requires_text', 'requires_ref_audio']) {
          if (mc[flag] !== undefined && typeof mc[flag] !== 'boolean') {
            throw bad(id, `call.methods.${n}.${flag}`, '写 true / false，别写别的')
          }
        }
        if (mc.call_time !== undefined &&
            !Array.isArray(mc.call_time)) {
          throw bad(id, `call.methods.${n}.call_time`,
            '得是一个参数名字符串数组（这个方法认哪些调用期参数）')
        }
      }
    } else {
      for (const k of ['module', 'class', 'method']) {
        if (!call[k] || typeof call[k] !== 'string') {
          throw bad(id, `call.${k}`, '缺了或者不是字符串')
        }
      }
    }
    for (const k of ['module', 'class']) {
      if (!call[k] || typeof call[k] !== 'string') {
        throw bad(id, `call.${k}`, '缺了或者不是字符串')
      }
    }
  } else {
    parseArgv(call, id)
    parseArgs(call, id)
  }

  // cwd 可以不写（不写＝不 chdir）；写了就得是条非空路径。在这里拦，是为了让「名片写错」
  // 在注册时就喊，而不是等宿主起来 chdir 到一个奇怪的地方再报一个看不出根因的错。
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
    // cli 形态下槽位里写的是命令行开关。不以 - 开头的十有八九是把 python 形态的
    // 参数名抄了过来：那会变成一个孤零零的位置参数。
    if (kind === 'cli' && !bind[k].startsWith('-')) {
      throw bad(id, `call.bind.${k}`,
        `写的是 "${bind[k]}"：kind="cli" 下这里要的是命令行开关（如 "--text"），` +
        '不是上游方法的参数名')
    }
  }
  if (!bind.text) throw bad(id, 'call.bind.text', '缺了：没有文本就没有 TTS')

  const returns = call.returns || 'file'
  // 第三种 "generator"：流式合成的推理方法 yield 一块块音频，不是一次性返回。
  if (returns !== 'file' && returns !== 'bytes' && returns !== 'generator') {
    throw bad(id, 'call.returns',
      `写的是 "${returns}"，只能是 "file" / "bytes" / "generator"`)
  }
  // generator 形态要一个采样率：item 里可能没有，那时它就该响亮地失败，
  // 默默塞 16000 得到的是变调的音频，而且不报任何错。
  if (returns === 'generator' && !Number.isFinite(call.generator_sample_rate)) {
    throw bad(id, 'call.generator_sample_rate',
      '缺了：call.returns = "generator" 时宿主需要它把浮点样本写成 WAV' +
      '（填引擎真实的输出采样率，别猜：猜错会变调）')
  }
  // returns=file ⇒ 宿主要开一个临时文件塞给上游，它必须知道那个参数叫什么。
  if (returns === 'file' && !bind.output_path) {
    throw bad(id, 'call.bind.output_path',
      '缺了：call.returns = "file" 时宿主要把临时文件路径递给上游')
  }

  // 参考音频：名片顶层说了要，bind 里就必须有槽位接它。否则宿主会 400 拦下
  // 「没给参考音频」的请求，然后在给了的时候把它丢掉。
  if (manifest.capabilities && manifest.capabilities.requires_reference_audio &&
      !bind.ref_audio) {
    throw bad(id, 'call.bind.ref_audio',
      '缺了：这台引擎声明了 requires_reference_audio，宿主得知道参考音频传给哪个参数')
  }

  const wp = weightsProblem(manifest)
  if (wp) throw bad(id, wp.field, wp.why)

  // 这里只校验 seed 在场，取值语义交给宿主那份校验：两处各写一遍必然分叉。
  if (call.seed === undefined) {
    throw bad(id, 'call.seed',
      '缺了：契约 §5.2.1 要求每张 manifest.json 显式声明可复现性（"none" 也是一个合法答案）')
  }

  return JSON.parse(JSON.stringify(call))
}

  // params：加载期 / 调用期两套白名单，独立于 `payload_keys`，二者不可互相顶替：那会让
  // 「加载期参数出现在调用里」和「不认识的参数」两道 400 判错。区别是生命周期，不是风格：
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

  // 同一个名字不能既是加载期又是调用期：那样两道 400 会互相打架，
  // 而且没人说得清改了它到底要不要重启。
  const both = out.load_time.filter((k) => out.call_time.includes(k))
  if (both.length) {
    throw bad(id, 'params', `这些名字同时出现在 load_time 和 call_time 里：${both.join(', ')}`)
  }

  if (params.schema !== undefined) out.schema = params.schema
  return out
}

// output_formats：「要 mp3」那条 400 的判据。不写 = 只出 wav：宿主本来就只会把字节
// 原样送回，转码是平台上层的事。
function parseOutputFormats(manifest, id) {
  const raw = manifest.output_formats
  if (raw === undefined || raw === null) return ['wav']
  if (!Array.isArray(raw) || !raw.length) {
    throw bad(id, 'output_formats', '要么别写（默认 ["wav"]），要么写一个非空数组')
  }
  return raw.map((f) => String(f).toLowerCase())
}

/**
 * @param {object} [opts]
 * @param {string} [opts.checkpointsOverride]  这一次要用哪一份模型（绝对路径）。
 *
 * 覆盖必须落在这份 profile_json 的 `runtime.checkpoints` 上：宿主填 `init_args` 里的
 * `{checkpoints}` 时读的是这份文件，不看启动命令行。
 * 写绝对路径：宿主侧 join 到绝对路径会直接采用它，相对路径要多一个「项目根在哪」的假设。
 */
function buildHostProfile(id, env = process.env, opts = {}) {
  // opts.enginesDir / opts.localRoot 原样交给 resolveEngineProfile：引擎在哪个 engines/ 目录、
  //   本机记录在哪个根，由起引擎的那一方说了算（见 spawnEngine.js）。
  const where = { enginesDir: opts && opts.enginesDir, localRoot: opts && opts.localRoot }
  const profile = resolveEngineProfile(id, env, where)
  const manifest = requireEngine(id, { enginesDir: where.enginesDir })
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
    // 不改 profile.runtime 本体：那是解析结果，可能被别人共享着。
    out.runtime = Object.assign({}, out.runtime, { checkpoints: String(over) })
  }
  return out
}

/**
 * 把这份 JSON 写到 spawn 之前它该在的地方。写只有这一处：两边各写一遍，就会有两条启动路径
 * 读到不同的内容。
 *
 * 解析失败要原样抛出去：报错是点名的（哪个引擎、哪个字段、为什么），包一层「写文件失败」
 * 会把唯一有用的那句话盖掉。
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
  weightsProblem, CHECKPOINTS_TOKEN,
  CALL_KEYS, BIND_SLOTS, CALL_KINDS, CALL_KEYS_BY_KIND, ARG_STYLES,
}
