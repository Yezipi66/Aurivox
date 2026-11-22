// 扫描结果转成名片建议值的纯函数：不 import react，不必为了跑一个纯函数把组件树拉起来。

import { vectorShapeFromHelp } from './paramShape.js'
import { readWeights, TOKEN as CKPT_TOKEN } from './weightsField.js'
//
// 输入是 /wizard/discover 返回的参数表，输出是名片的 call 段建议。

/**
 * 把扫描到的参数转成名片 call 段的建议值。
 *
 * @param params [{source, name, target, kind, style, help, required, group, is_tool}]
 *   cli 路的 name 是开关去掉横线的部分、target 是开关本身，进 call.args；
 *   python 路的 name 与 target 同名，都是上游方法的参数名，不进 call.args。
 * @param currentCall 现有的 call 段，作基底；用户手填的值不被覆盖。
 * @param bindCandidates 反射器剔掉的 bind 槽位候选 [{name, target, bind_slot}]，
 *   认槽位用（它们不在 parameters[] 里）。
 * @param entry 入口嗅探结果（entryPick 的返回）：填模块名与子命令进 argv。
 *   为 null 时 argv 里留着占位符，由使用者自己填。
 * @param engineId 引擎目录名，用来填 call.cwd（-m 找包从当前目录算起）。
 * @param positionals 扫描到的位置参数 [{name, nargs, type, required, help}]。
 *   它们没有开关名，值直接占「第几个词」，所以只能写成 argv 里的占位符；
 *   认得出是哪个槽位的会接在入口骨架后面，认不出的只报一条说明。
 * @returns {{call, matched, argList, notes, callTime, manifestPatch, confidence}} 或 null（没有参数）；
 *   matched 是 { text, ref_audio, ref_text, output_path }，认不出时为 null。
 *   ref_text 是可选槽位：认不出不算缺，由用户自己拖进去。
 *   confidence 给每个自动填的值标 certain / guess 与依据，界面据此用绿 / 黄徽标；
 *   它只描述证据，不参与填值判定。
 */
/**
 * 开关名归一化：上游把同一个参数写成 --model-dir、--model_dir、--modelDir 都常见。
 * 匹配一律在下划线小写写法上做，落盘仍用原名，名片里保留上游的写法。
 * 不归一化时，候选名表里全是下划线，带横线与驼峰的开关一个也匹配不上，而且不报错。
 */
export function normName (name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

// 运行设备的参数名。只认这几个：写成别的（如 --accelerator）平台不猜它是设备，
//   猜错的代价是把一个普通参数当成设备，下发时填进一个引擎不认识的值。
const DEVICE_NAME_RE = /^(device|devices|gpu|run_device)$/

// 槽位规范名：只有这些名字与平台槽位同义，按它们匹配才算「扫描已确定」。
//   其余名字只是相近，名字不承载上游语义：speaker 与 output_dir 在命令行上
//   分别指说话人编号与批量输出目录。这类值照样填，但界面标成推测，
//   不与确切同名的值共用绿色徽标。
const EXACT_SLOT_NAMES = {
  text: ['text', 'input_text', 'tts_text', 'target_text', 'gen_text'],
  ref_audio: ['ref_audio', 'reference_audio', 'prompt_audio', 'prompt_wav', 'ref_wav', 'prompt_speech_path'],
  ref_text: ['ref_text', 'prompt_text', 'reference_text'],
  output_path: ['output_path', 'output_file', 'save_path', 'out_path'],
}

// 位置参数名 → 平台槽位。只收语义不含糊的名字：
//   output / out 在 argparse 里几乎都是落点（文件或目录），与 --output 同义；
//   input / prompt / voice 这类不进来：它们在不同引擎里指文本、指文件、指声线，
//   认错的表现是念参考音频原话或用错声线，而且不报错。
export const POSITIONAL_SLOT = {
  text: 'text', texts: 'text', input_text: 'text', tts_text: 'text', target_text: 'text', gen_text: 'text',
  ref_audio: 'ref_audio', reference_audio: 'ref_audio', prompt_audio: 'ref_audio',
  prompt_wav: 'ref_audio', ref_wav: 'ref_audio', speaker_wav: 'ref_audio',
  prompt_speech_path: 'ref_audio',
  ref_text: 'ref_text', prompt_text: 'ref_text', reference_text: 'ref_text',
  output: 'output_path', out: 'output_path', output_path: 'output_path',
  output_file: 'output_path', save_path: 'output_path', out_path: 'output_path',
}

// nargs 说明位置参数收几个词："?" 与 "*" 可以不出现，其余（"+"、2、"3"…）都要。
//   占位符在命令行上永远只占一个词，所以这两类之外的都要提醒。
// nargs 为 "?" 或 "*" 的位置参数可以不出现。占位符没有「这次不给」这种写法：
//   接上去就意味着每次请求都必须有值，缺一次整条命令就失败（宿主按位置替换，
//   空着会让后面的词错位，所以它宁可整次报错）。这类参数宁可留在扫描说明里，
//   也不默认接进命令。
export function isOptionalNargs (nargs) {
  return nargs === '?' || nargs === '*'
}

export function isMultiValue (nargs) {
  if (nargs === undefined || nargs === null) return false
  if (nargs === '?' || nargs === '*') return false
  if (nargs === 1) return false
  return true
}

// 权重落点的占位符：与 weightsField.js 的 TOKEN 同一个值，第 3 步下载到那里。
const TOKEN = '{checkpoints}'

/**
 * 判一个槽位自动填的值能不能标成确定。降级按顺序取第一条成立的依据，
 * 依据写的是已知事实，不替上游猜语义。
 */
function judgeSlot (slot, ev, params, ambiguous, entryFile) {
  const via = ev.via
  const file = ev.hit.source_file || null
  const guess = (en, zh) => ({ level: 'guess', reason: { en, zh } })
  if (ambiguous.includes(via)) {
    return guess('The same name resolved to different values in two sources; the first match was used.',
      '同名参数在两种来源里指向的值不同，当前取的是先匹配到的一个。')
  }
  if (file && entryFile && file !== entryFile) {
    return guess('This switch was found in ' + file + ', not in the inference entry file.',
      '该开关出现在 ' + file + '，不在推理入口文件内。')
  }
  // 有更贴切的规范名也在扫描结果里时，先报它：能指出该核对哪一个，比只说「名字相近」有用。
  const rival = params.find((p) => normName(p.name) !== via &&
    EXACT_SLOT_NAMES[slot].includes(normName(p.name)) && p.target !== ev.hit.target)
  if (rival) {
    return guess('Another parameter in the scan (' + rival.target + ') also fits this slot; the first match was used.',
      '扫描结果中另有参数（' + rival.target + '）符合这一槽位，当前取的是先匹配到的一个。')
  }
  if (!EXACT_SLOT_NAMES[slot].includes(via)) {
    return guess('Matched by a similar parameter name (' + via + '), not by an exact slot name. Confirm this binding before saving.',
      '按相近参数名（' + via + '）匹配，并非槽位同名。保存前请核对这一格。')
  }
  return {
    level: 'certain',
    reason: {
      en: 'The parameter name matches this slot exactly' + (file ? ' and comes from the inference entry file' : '') + ': ' + via + '.',
      zh: '参数名与平台槽位一致' + (file ? '，且出自推理入口文件' : '') + '：' + via + '。',
    },
  }
}

/**
 * python 形态下，从扫描到的类方法候选里挑一条写进名片。
 *
 * 为什么要有这一步：扫描回的「入口」只有 cli 那份（module + subcommand，写进 argv），
 *   python 形态的 module / class / method 没有写入路径。使用者把调用方式切到
 *   python 之后，argv 已被切形态那一步删掉，扫描又只认 argv，于是名片里一个入口都没有，
 *   保存下来无法启动。
 *
 * 挑法：名片绑了参考音频时优先有参考音频参数的方法；同类里取评分最高的
 *   （候选已按 score 排好，扫码器把「收文本 + 有输出/参考」的方法排在前面）。
 * 只填空格：三格都空才写，写过任何一格都视为使用者的选择。
 *
 * @param {object} call 当前 call 段
 * @param {Array} pythonEntries discover 回的 python_entries
 * @returns {object} 新的 call 段（原对象不动）
 */
export function withPythonEntryFromScan (call, pythonEntries, suggested) {
  const c = { ...(call || {}) }
  if (c.kind !== 'python') return call
  // 三格齐了才算有入口。只写了模块名（或只写了模块名与类名）的名片缺的不是「再造一个
  //   入口」，而是同一入口的另外两段：按已有的模块名在候选里找，把缺的补上。
  if (c.module && c.class && c.method) return call
  const list = Array.isArray(pythonEntries) ? pythonEntries.filter(Boolean) : []
  if (!list.length) return call
  // 扫描器已经把「反射时实际用的那条入口」算出来了（它挑一条去反射拿参数表）。
  //   写进名片时优先用同一条：两处各判一次，迟早出现「参数表来自 A、名片写的是 B」。
  const key = (e) => `${e.module}.${e.className}.${e.method}`
  const suggestedKey = suggested && suggested.module && suggested.class && suggested.method
    ? `${suggested.module}.${suggested.class}.${suggested.method}`
    : ''
  const preset = suggestedKey ? list.find((e) => key(e) === suggestedKey) : null
  const pool = c.module ? list.filter((e) => e.module === c.module) : list
  if (!pool.length && !preset) return call
  const wantsRef = !!(c.bind && c.bind.ref_audio)
  const hasRef = (e) => Array.isArray(e.params && e.params.ref) && e.params.ref.length > 0
  // 名片还绑了参考文本时，优先收参考文本的那个方法：参考文本不是参数分类里的独立一类，
  //   只能从完整参数名里认。同一台引擎上 zero_shot 收 prompt_text、cross_lingual 不收，
  //   其它条件（收文本 + 收参考音频）完全一样，只按分数挑会挑到错的那个。
  const wantsRefText = !!(c.bind && c.bind.ref_text)
  const hasRefText = (e) => Array.isArray(e.names) &&
    e.names.some((n) => /^(?:prompt|ref|reference)[-_]?text$/i.test(String(n)))
  const pick = preset || (wantsRefText && pool.find((e) => hasRef(e) && hasRefText(e))) ||
    (wantsRef && pool.find(hasRef)) ||
    pool[0]
  if (!pick || !pick.module || !pick.className || !pick.method) return call
  c.module = pick.module
  c.class = pick.className
  c.method = pick.method
  // 生成器方法不收输出路径：返回方式只能是 generator，bind 里的输出槽位要摘掉。
  //   不摘的话宿主会把 output_path 当关键字参数传给一个不接受它的方法，
  //   报的是 TypeError，看不出是返回方式选错了。
  const outParams = Array.isArray(pick.params && pick.params.out) ? pick.params.out : []
  if (pick.generator === true && !outParams.length) {
    c.returns = 'generator'
    if (c.bind && typeof c.bind === 'object') {
      const nb = { ...c.bind }
      delete nb.output_path
      c.bind = nb
    }
  }
  return c
}

// 「像模型路径」的构造参数名。只用来给一个默认值，界面照常可改。
const WEIGHT_NAME_RE = /^(model|ckpt|checkpoint)(_?(dir|path|root))?$/i

/** 从「相对 checkpoints 的文件清单」推出模型子目录：各文件目录的最长公共前缀。 */
function commonModelDir (files) {
  const dirs = (Array.isArray(files) ? files : [])
    .map((f) => String(f).replace(/\\/g, '/').split('/').slice(0, -1))
    .filter((segs) => segs.length)
  if (!dirs.length) return ''
  let common = dirs[0]
  for (const d of dirs.slice(1)) {
    let i = 0
    while (i < common.length && i < d.length && common[i] === d[i]) i += 1
    common = common.slice(0, i)
    if (!common.length) break
  }
  return common.join('/')
}

/**
 * python 形态下补上「模型权重」那一格：构造参数名 + 带 {checkpoints} 的值。
 *
 * 为什么能自动：第 3 步的权重落点由平台定（core/checkpointsPath.js），
 *   models.required 又是按盘上真实文件生成的，所以模型子目录可以从文件清单的
 *   最长公共前缀推出来。多数引擎把同一套权重收在一个子目录里
 *   （如 pretrained_models/<模型名>），推出来就是它对 model_dir 的期望值。
 *
 * 参数名从扫描到的参数里挑一个像模型路径的；挑不到就留空，让人自己填。
 * 只填空格：已经声明过带 {checkpoints} 的构造参数、或写了 weights="self"，一律不动。
 *
 * @param {object} call 当前 call 段
 * @param {string[]} files 相对 checkpoints 的文件清单（install-state 的 model_files）
 * @param {Array} params 扫描到的参数
 * @returns {object} 新的 call 段（原对象不动）
 */
export function withPythonWeightsFromScan (call, files, params) {
  const c = { ...(call || {}) }
  if (c.kind !== 'python') return call
  if (c.weights === 'self') return call
  const cur = readWeights(c)
  if (cur.name || cur.self) return call
  const hit = (Array.isArray(params) ? params : [])
    .map((p) => String((p && (p.name || p.target)) || '').replace(/^-+/, '').replace(/-/g, '_'))
    .find((n) => n && WEIGHT_NAME_RE.test(n))
  if (!hit) return call
  const sub = commonModelDir(files)
  const init = { ...((c.init_args && typeof c.init_args === 'object') ? c.init_args : {}) }
  init[hit] = sub ? `${CKPT_TOKEN}/${sub}` : CKPT_TOKEN
  c.init_args = init
  return c
}

// ---- python 形态的填入 ----
//
// 与 cli 的填入是两条路：cli 填命令行开关与 argv 词序，python 填方法参数名与构造参数。
//   共用一个函数时每一段都要按形态分支，分支越多越容易漏（真实的漏：`call.args` 被写进
//   python 名片、`returns` 按输出参数推成 dir）。这里只做 python 该做的事。

const PY_TEXT_NAMES = ['text', 'tts_text', 'input_text', 'gen_text', 'target_text']
const PY_REF_NAMES = ['prompt_wav', 'ref_audio', 'reference_audio', 'ref_wav', 'speaker_wav']
const PY_REF_TEXT_NAMES = ['prompt_text', 'ref_text', 'reference_text']

/**
 * python 形态的自动填：入口（含返回方式）+ 绑定（方法参数名）+ 构造参数（权重）。
 *
 * @param {Array} params 扫描到的参数（后端已按 kind 过滤，只有 python 来源）
 * @param {object} currentCall 当前 call 段
 * @param {Array} pythonEntries 类方法候选
 * @param {object|null} suggested 扫描器实际用来反射的那条入口
 * @param {string[]} files 相对 checkpoints 的文件清单
 * @returns {{call: object, notes: Array, confidence: object}}
 */
export function computePythonFill (params, currentCall, pythonEntries, suggested, files) {
  const list = Array.isArray(params) ? params : []
  const notes = []
  const confidence = { bind: {}, returns: null, weights: null, entry: null }

  // 入口：三格齐了就保留，缺哪格补哪格。
  let next = withPythonEntryFromScan({ ...(currentCall || {}), kind: 'python' },
    pythonEntries, suggested)

  // 返回方式按方法本身定：方法体里有 yield 且不收输出路径 ⇒ generator。
  //   cli 那边按「有没有输出参数」推，这里不能沿用：生成器方法恰恰不收输出路径。
  const candidates = Array.isArray(pythonEntries) ? pythonEntries : []
  const match = candidates.find((e) => e && e.module === next.module &&
    e.className === next.class && e.method === next.method)
  const outParams = Array.isArray(match && match.params && match.params.out) ? match.params.out : []
  if (match && match.generator === true && !outParams.length) {
    next = { ...next, returns: 'generator' }
    if (next.bind && next.bind.output_path) {
      const b = { ...next.bind }
      delete b.output_path
      next = { ...next, bind: b }
    }
  }

  // 绑定：python 参数的 target 与 name 同名，写哪个都是方法参数名。只填空格。
  const bind = { ...(next.bind || {}) }
  const pick = (names) => list.find((p) => names.includes(normName(p.name)))
  const fill = (slot, names) => {
    if (bind[slot]) return
    const hit = pick(names)
    if (hit) bind[slot] = hit.name
  }
  fill('text', PY_TEXT_NAMES)
  fill('ref_audio', PY_REF_NAMES)
  fill('ref_text', PY_REF_TEXT_NAMES)
  if (Object.keys(bind).length) next = { ...next, bind }

  // 构造参数：权重按盘上文件清单推。
  next = withPythonWeightsFromScan(next, files, list)
  return { call: next, notes, confidence }
}

export function computeCliFill (params, currentCall, bindCandidates = [], entry = null, engineId = null, hints = null, files = null, positionals = null) {
  // 只有位置参数的引擎（命令行上一个开关都没有）会被整段丢掉：
  //   扫到的是空参数表，界面只报「没有发现参数」，而真因是它把值写在词序上。
  const posList = Array.isArray(positionals) ? positionals : []
  if ((!params || !params.length) && !posList.length) return null

  const call = { ...(currentCall || {}) }
  const notes = []
  // 由位置参数供值的槽位。bind 填值那一节要跳过它们：同一个槽位只能写一处。
  const positionalSlots = new Set()
  const positionalBySlot = {}
  // 每个自动填进去的值都带一档置信度：certain 用绿色徽标，guess 用黄色徽标。
  //   只记结论与依据，不改写上面任何一段填值逻辑；界面据此标注，不据此取舍。
  const confidence = { bind: {}, returns: null, weights: null, entry: null }

  // kind 由名片说了算：名片已经声明过形态时，扫描一律不改写。
  //   探测是同时扫两条路、再把结果合并成一张表的。从前「只有 cli 来源就置 cli」，
  //   于是一张 python 名片被改写成 cli，而 bind 里仍是方法参数名（tts_text 而非
  //   --tts-text），宿主解析时当场拒绝：kind="cli" 下 call.bind.text 要的是开关。
  //   扫描只提供参数候选，形态是使用者的声明；不一致时给提示，让他自己切。
  const hasCli = params.some((p) => p.source === 'cli')
  const hasPy = params.some((p) => p.source === 'python')
  const declaredKind = call.kind === 'cli' || call.kind === 'python' ? call.kind : null

  // 两种来源混在一张表里时，无论名片写没写形态，都要报出来：
  //   平台没有依据替使用者挑一条路。
  if (hasCli && hasPy) {
    notes.push({
      en: 'Both command line flags and Python signature parameters were found. The manifest kind was left as it is: confirm whether this engine runs through the command line or through the Python class.',
      zh: '同时发现了命令行开关和 Python 函数签名参数。名片里的 kind 保持原样：请确认这台引擎走命令行还是走 Python 类。',
    })
  }

  if (!declaredKind) {
    // 名片还没声明形态：只有一条来源时按它定。
    if (hasCli && !hasPy) call.kind = 'cli'
    else if (hasPy && !hasCli) call.kind = 'python'
    else if (!hasCli && !hasPy && posList.length) {
      // 位置参数只存在于命令行形态：这一条本身就是 cli 的证据。
      call.kind = 'cli'
    }
  } else if (declaredKind === 'cli' && hasPy && !hasCli) {
    // 只提示，不改写：两种形态的绑定名写法不同，改一半就会造出一张自相矛盾的名片。
    notes.push({
      en: 'The scan found Python signature parameters, but the manifest declares the command-line mode. The binding names differ between the two modes; check them or switch the call mode.',
      zh: '扫描到的是 Python 函数签名参数，而名片声明的是命令行形态。两种形态的绑定名写法不同，请核对绑定名或切换调用方式。',
    })
  } else if (declaredKind === 'python' && hasCli && !hasPy) {
    notes.push({
      en: 'The scan found command-line flags, but the manifest declares the Python class mode. The binding names differ between the two modes; check them or switch the call mode.',
      zh: '扫描到的是命令行开关，而名片声明的是 Python 类形态。两种形态的绑定名写法不同，请核对绑定名或切换调用方式。',
    })
  }

  // args 与 argv 是 cli 形态才有的两段，python 名片里写它，存的时候直接被拒。
  if (call.kind === 'cli') {
    const oldArgv = Array.isArray(call.argv) ? call.argv : []
    // 模块占位符有两种写法（__MODULE__ 与 _MODULE__），两种都认，
    //   认不出就当成还没填。占位符留在名片里能过校验，但引擎一启动就是
    //   ModuleNotFoundError，而那个报错指向 Python，看不出是名片这一格的事。
    const MODULE_TOKENS = ['_MODULE_', '__MODULE__']
    const idxModule = oldArgv.findIndex((w) => MODULE_TOKENS.includes(w))
    const mod = entry && entry.module ? String(entry.module) : null
    const sub = entry && entry.subcommand ? String(entry.subcommand) : ''

    // 只替换占位符，不截断。占位符后面可能还写着子命令（python -m pkg.cli infer），
    //   截到模块为止会连子命令一起丢掉，引擎起来后落到没有子命令的用法上，
    //   argparse 直接以「必须指定子命令」退出。
    let argv = oldArgv.slice()
    if (idxModule >= 0 && mod) {
      argv[idxModule] = mod
      // 子命令补在模块之后、且只在后面空着或紧跟开关时补：后面已经有词说明
      //   骨架或使用者自己写过子命令，再插一个就成了两个位置参数。
      const at = idxModule + 1
      const tail = argv.slice(at)
      const bare = tail.length === 0 || String(tail[0]).startsWith('-')
      if (sub && bare) argv = [...argv.slice(0, at), sub, ...tail]
    } else if (!argv.length) {
      argv = ['{engine_python}', '-m', mod || '_MODULE_']
      if (mod && sub) argv.push(sub)
    }
    // 已经写着具体模块名的 argv 不改写：那是使用者的决定，扫描只是给建议。
    // 权重落点：扫描认出的模型目录开关要接上 {checkpoints}，否则名片校验报
    //   「模型权重」缺失，而那个开关明明已经在 args 里。只在名片里还没有
    //   落点时补；使用者写过的那一份一律不覆盖。
    if (call.weights !== 'self' && !argv.some((w) => String(w).includes(TOKEN))) {
      const entryFile = entry && entry.file ? String(entry.file) : null
      const MODEL_RANK = [
        /^model_?dir$/, /^model_?path$/, /^model_?root$/,
        /^(ckpt|checkpoint|checkpoints|weights)_?(dir|path)$/,
        // 单文件权重的引擎（Piper 那类）把开关写成 --model / --model-file / --checkpoint-file。
        //   名字里带 file 的排在目录类之后：两者同时存在时，目录那份更容易被整套权重用上。
        /^(model|ckpt|checkpoint|weights)_?file$/,
        /^(ckpt|checkpoint|checkpoints|weights|pretrained|model)$/,
      ]
      const hits = params
        .filter((p) => p.source === 'cli' && p.target &&
          (!p.style || p.style === 'value') &&
          (!entryFile || !p.source_file || p.source_file === entryFile))
        .map((p) => ({ p, rank: MODEL_RANK.findIndex((re) => re.test(normName(p.name))) }))
        .filter((x) => x.rank >= 0)
        .sort((a, b) => a.rank - b.rank)
      // 没有入口线索且命中不止一个时不替使用者挑：接错开关会让引擎加载错目录。
      const usable = entryFile ? hits : (hits.length === 1 ? hits : [])
      if (hits.length === 0) {
        // 上游命令行里连一个权重开关都没有：引擎自己定位权重（从缓存或默认路径拉）。
        //   这一格留空时校验会报「没有一个词带 {checkpoints}」，而平台也传不进去。
        //   写成 self 并在扫描说明里点明依据，使用者一眼就能取消勾选改回手写。
        call.weights = 'self'
        notes.push({
          en: 'No weights switch was found in the scanned command line. Treated as '
            + '"the engine locates its own weights". Uncheck it and name a switch '
            + 'if this engine does take a weights path.',
          zh: '扫描到的命令行里没有权重开关，已按「引擎自行定位权重」处理。'
            + '若这台引擎要传权重路径，请取消勾选并手写开关。',
        })
      } else if (usable.length) {
        const picked = usable[0].p
        const flag = String(picked.target)
        // 值是目录还是一个具体文件，由两处证据决定：
        //   上游自己怎么说（开关名结尾是 file，或说明里写 file）
        //   盘上到底有几个权重文件（第 3 步下载的结果）
        // 只有两边都指向文件时才写成 {checkpoints}/<文件名>；其余一律给目录。
        //   目录覆盖面更广，而写错文件名会让引擎加载失败且不报错。
        const WEIGHT_RE = /\.(onnx|pth|pt|bin|safetensors|ckpt|gguf|npz)$/i
        const weightFiles = (Array.isArray(files) ? files : [])
          .map((f) => String(f == null ? '' : f).replace(/\\/g, '/'))
          .filter((f) => WEIGHT_RE.test(f))
        const help = String(picked.help || '')
        const wantsFile = /(^|_)file$/.test(normName(picked.name)) ||
          (/file/i.test(help) && !/director/i.test(help))
        const singleFile = weightFiles.length === 1 ? weightFiles[0].split('/').pop() : ''
        // 权重全在一个子目录里（父目录下没有任何权重文件）时，落点要往下走一层：
        //   那种引擎的开关收的是「某个模型目录」，同一父目录下并排放着可选的模型
        //   （一个模型一套权重）。判据只读盘上事实：父目录空着、子目录只有一个。
        //   多个子目录时保持父目录：那是同一套模型的不同部件，引擎自己分派。
        const flatFiles = weightFiles.filter((f) => !f.includes('/'))
        const topDirs = [...new Set(weightFiles
          .filter((f) => f.includes('/'))
          .map((f) => f.split('/')[0])
          .filter(Boolean))]
        const singleDir = flatFiles.length === 0 && topDirs.length === 1 ? topDirs[0] : ''
        const value = (wantsFile && singleFile)
          ? TOKEN + '/' + singleFile
          : (singleDir ? TOKEN + '/' + singleDir : TOKEN)
        argv = [...argv, flag, value]
        const what = value === TOKEN
          ? { en: 'the download folder.', zh: '下载目录。' }
          : (singleDir
            ? { en: '"' + value + '", the only model folder on disk.',
              zh: '「' + value + '」，即盘上唯一的那个模型子目录。' }
            : { en: '"' + value + '", the single weight file found on disk.',
              zh: '「' + value + '」，即盘上唯一的那个权重文件。' })
        notes.push({
          en: 'Weights path: ' + flag + ' is connected to ' + what.en +
            ' Confirm this in the Model weights field.',
          zh: '权重落点：' + flag + ' 已接到' + what.zh + '请在「模型权重」格确认。',
        })
        if (wantsFile && !singleFile && weightFiles.length > 1) {
          notes.push({
            en: 'The switch name or its help mentions a file, but ' + weightFiles.length +
              ' weight files were found on disk. It is connected to the folder for now: name the file by hand if the engine needs one.',
            zh: '开关名或说明指向文件，但盘上有 ' + weightFiles.length +
              ' 个权重文件。当前先接目录：引擎确实要某个文件时，请在这一格手写 {checkpoints}/文件名。',
          })
        }
        confidence.weights = {
          level: 'guess', flag,
          reason: {
            en: 'The weights switch was chosen by a name ranking: ' + flag + '. Confirm that it takes the download folder' +
              (value === TOKEN ? '.' : (singleDir ? ', or the model folder under it.' : ' or the named file.')),
            zh: '权重开关按参数名排序选出：' + flag + '。请确认该开关收的是下载目录' +
              (value === TOKEN ? '。' : (singleDir ? '，还是它下面那一层模型目录。' : '还是那个文件。')),
          },
        }
      }
    }
    // 位置参数：按扫描顺序接在入口骨架之后，写成 {slot} 占位符。
    //   上游把值放在「第几个词」上，命令行上没有开关名可以挂，除了占位符没有别的写法。
    //   positionalSlots 后面要用：这些槽位由位置参数供值，call.bind 里就不能再绑一次
    //   （同一个槽位两处都写，宿主启动前会拒收整张名片）。
    const unmappedPos = []
    // 可以省略的位置参数：接上去会让「这次不给值」的请求整条失败，所以不默认接。
    const optionalPos = []
    for (const pos of posList) {
      const nm = normName(pos && pos.name)
      const slot = POSITIONAL_SLOT[nm]
      if (!slot) { unmappedPos.push(pos); continue }
      if (isOptionalNargs(pos.nargs)) { optionalPos.push(pos); continue }
      const bound = call.bind && call.bind[slot]
      if (bound) {
        // 使用者已经在必填区把这个槽位绑成开关了：那是他的决定，位置参数让位。
        notes.push({
          en: 'The command line also has a positional argument "' + pos.name + '", but this slot is already bound to '
            + bound + '. The switch was kept; clear that field first if this engine takes the value positionally.',
          zh: '命令行上还有一个位置参数「' + pos.name + '」，而这一槽位在必填区已绑到开关 '
            + bound + '。当前保留了开关；若这台引擎是按位置收这个值，请先清掉那一格。',
        })
        continue
      }
      if (argv.some((w) => String(w).includes('{' + slot + '}'))) { positionalSlots.add(slot); continue }
      positionalSlots.add(slot)
      positionalBySlot[slot] = pos
      argv = [...argv, '{' + slot + '}']
    }
    if (positionalSlots.size) {
      notes.push({
        en: 'Positional arguments were found and written as placeholders at the end of the command: '
          + [...positionalSlots].map((x) => '{' + x + '}').join(', ')
          + '. Reorder them in Command words if the engine expects a different order.',
        zh: '扫描到位置参数，已写成占位符接在命令行末尾：'
          + [...positionalSlots].map((x) => '{' + x + '}').join('、')
          + '。引擎要求的次序不同的话，在「命令行词序」里调整前后。',
      })
      const multi = [...positionalSlots]
        .map((x) => positionalBySlot[x])
        .filter((p) => p && isMultiValue(p.nargs))
      if (multi.length) {
        notes.push({
          en: 'These positional arguments take more than one word (nargs): '
            + multi.map((p) => p.name + '=' + String(p.nargs)).join(', ')
            + '. A placeholder fills one value only; confirm whether this engine needs the rest.',
          zh: '这几个位置参数要收多个词（nargs）：'
            + multi.map((p) => p.name + '=' + String(p.nargs)).join('、')
            + '。占位符只会填一个值，请确认这台引擎是否还需要其余的值。',
        })
      }
    }
    if (optionalPos.length) {
      notes.push({
        en: 'These positional arguments may be omitted (nargs ? or *): '
          + optionalPos.map((p) => p.name).join(', ')
          + '. A placeholder always needs a value, so adding one would make every request '
          + 'without it fail. Add it in Command words only if this engine really needs it every time.',
        zh: '这几个位置参数可以不给（nargs 为 ? 或 *）：'
          + optionalPos.map((p) => p.name).join('、')
          + '。占位符每次都要有值，接上去会让不带这个值的请求整条失败。'
          + '这台引擎确实每次都要它时，再到「命令行词序」里自己接。',
      })
    }
    if (unmappedPos.length) {
      notes.push({
        en: 'Positional arguments with no matching slot were left alone: '
          + unmappedPos.map((p) => p.name).join(', ')
          + '. The platform has no value to put there; handle them in Command words by hand.',
        zh: '这些位置参数在平台没有对应的值可填，未做处理：'
          + unmappedPos.map((p) => p.name).join('、')
          + '。需要的话在「命令行词序」里手工处理。',
      })
    }

    call.argv = argv

    // 模块名要能 import，工作目录得落在引擎目录上：示例命令默认在仓库根执行，
    //   而 -m 找包是从当前目录算起的。
    // src 布局时模块名从 src 起算（a.b.c），包也在 src/ 下：cwd 停在引擎根会
    //   ModuleNotFoundError，而那个报错指向 Python，看不出是这一格的事。
    if (mod && engineId && !call.cwd) {
      const root = entry && entry.srcRoot ? '/' + String(entry.srcRoot) : ''
      call.cwd = 'engines/' + engineId + root
    }
    if (mod) {
      notes.push({
        en: 'Entry point: ' + entry.file +
          (entry.source === 'readme' ? ' (from the README)' : ' (from the parameter match)') +
          (entry.ambiguous ? '. Several candidates fit equally well: confirm this one.' : '.'),
        zh: '推理入口：' + entry.file +
          (entry.source === 'readme' ? '（依据：README）' : '（依据：参数匹配）') +
          (entry.ambiguous ? '。有多个候选同样符合，请确认这一个。' : '。'),
      })
    }

    // 只收 cli 来源的参数：python 参数名不是开关，写进去就是一条认不出的开关。
    // 开关只从入口那个文件收：同仓库常有几个脚本各带一套开关（推理入口、webui、
    //   服务端、量化脚本），全收进来 args 会堆满别的脚本的旋钮，而 argv 跑的是
    //   入口那个文件，argparse 以 unrecognized arguments 拒收。没有入口线索时
    //   （扫不出 entry）不设限，保持原有行为。
    const entryFile = entry && entry.file ? String(entry.file) : null
    call.args = call.args || {}
    for (const p of params) {
      if (p.source !== 'cli' || call.args[p.name]) continue
      if (entryFile && p.source_file && p.source_file !== entryFile) continue
      const entry = { flag: p.target }
      if (p.style) entry.style = p.style
      // 上游说明里写了「逗号分隔」时，命令行上只该出现一个词：扫描给的 style 是
      //   argparse 的默认写法 value，照抄会被按 nargs 展开成 N 个词，上游只吃第一个。
      const shape = vectorShapeFromHelp(p.help)
      if (shape) {
        entry.style = shape.style
        entry.join = shape.join
      }
      // 运行设备的参数要打上标记：平台据此在界面上出设备下拉，
      //   并在下发前把选中的那块卡换算成这台引擎认的写法。
      if (DEVICE_NAME_RE.test(normName(p.name))) {
        entry.role = 'device'
        // 格式按参数类型推：number 说明引擎要编号，其余按 torch 设备字符串处理
        entry.device_format = p.kind === 'number' ? 'index' : 'torch'
      } else if (hints && Array.isArray(hints.audio_params) && hints.audio_params.includes(normName(p.name))) {
        // 音频类输入：同一套选择器可喂 --emotion-audio 或 --aux-ref-audio，
        //   平台不解释上游叫什么语义，只声明「这一格由音频选择器填」。
        //   label 留给使用者写，嗅探不替他起名。
        entry.role = 'audio_ref'
      } else if (hints && hints.format_arg && hints.format_arg === normName(p.name)) {
        // 输出格式：只认值域明确的那个开关，界面选的容器名从这里进命令行。
        entry.role = 'output_format'
      }
      call.args[p.name] = entry
    }
  }

  // 槽位：候选名对的是 name（不带横线的那个词），写进 bind 的是 target
  // （cli 路是开关，python 路是参数名）。索引必须建在 name 上：建在 target 上时，
  // cli 路的 target 是带横线的开关，而候选名不带横线，两边永远不匹配。
  // 索引建在归一化后的名字上：候选名表里全是下划线，带横线的开关按原名查永远不中。
  const byName = {}
  const ambiguous = []
  // 入口那个文件里的开关优先。同仓库常有几个脚本各带一套开关（推理入口、webui、
  //   服务端、下载脚本），名字还互相重名。按出现顺序取会绑到别的脚本那一个，
  //   拼出来的命令行拿入口去跑，argparse 以 unrecognized arguments 拒绝。
  const entryFile = entry && entry.file ? String(entry.file) : null
  const inEntryFile = (p) => !entryFile || (p.source_file && p.source_file === entryFile)
  for (const p of params) {
    const k = normName(p.name)
    const cur = byName[k]
    if (cur === undefined) { byName[k] = p; continue }
    if (!inEntryFile(cur) && inEntryFile(p)) { byName[k] = p; continue }
    if (inEntryFile(cur) === inEntryFile(p) && cur.target !== p.target) ambiguous.push(k)
  }
  // bind 槽位候选：反射器按 BIND_SLOTS 剔掉的那几个名字（text / output_path /
  //   output_dir），它们不在 parameters[] 里，而认槽位靠的就是名字。
  //   少了这一段，output_path 永远认不出来，表现为「名片里那一格始终空着」。
  //   params 里已有的同名参数优先，不覆盖它自己的判断。
  for (const c of (bindCandidates || [])) {
    if (!c || !c.name) continue
    const k = normName(c.name)
    if (byName[k] === undefined) {
      byName[k] = { name: c.name, target: c.target || c.name }
    }
  }
  // 候选名有先后，但先后只是名字的常见程度，不是证据。先看它们落在哪个文件：
  //   入口那个文件里的开关才算这次要跑的这条命令行。同仓库的辅助脚本常带重名开关，
  //   只按名字顺序取会绑到别的脚本，argparse 对不认识的开关直接拒绝。
  const findSlot = (...names) => {
    const hits = []
    for (const n of names) {
      const via = normName(n)
      const hit = byName[via]
      if (hit) hits.push({ via, hit })
    }
    if (!hits.length) return null
    const inEntry = hits.find((h) => h.hit.source_file && inEntryFile(h.hit))
    const picked = inEntry || hits[0]
    return { via: picked.via, hit: picked.hit, hits }
  }

  // prompt_text 不进「合成文本」的候选：零样本引擎里它几乎都是参考音频里说的那句话
  //   （参考文本），认成合成文本，念出来的就是参考音频的原话，而且不报错。
  //   它在参考文本的候选里排第一。参考文本只是尽量认：认不出就空着，不当成缺项。
  const evidence = {
    // 要合成的文本，上游写法有 text / input_text / tts_text / target_text / gen_text 五种，
    //   都是同义：合成的输入是文本。顺序按出现频率，排在前面的先匹配。
    text: findSlot('text', 'input_text', 'tts_text', 'target_text', 'gen_text'),
    // prompt_speech_path 与 ref_audio 同义：零样本引擎用它指参考音频所在的文件。
    //   speaker_wav 是同一件事的另一种写法（有人把参考音频叫说话人音频），
    //   它不在同名表里：命中时标成相近名字，由人核对。
    ref_audio: findSlot('voice', 'ref_audio', 'prompt_wav', 'ref_wav', 'spk', 'speaker',
      'reference_audio', 'prompt_speech_path', 'prompt_audio', 'speaker_wav'),
    ref_text: findSlot('prompt_text', 'ref_text', 'prompt-text', 'reference_text', 'ref-text'),
    // output_dir 与 output_path 指同一个槽位：引擎那边的落点参数叫哪个都认。
    //   save_dir / out_dir / output_file 是上游常见的另三种写法，追加在末尾，不改变原有候选的优先级。
    output_path: findSlot('output', 'output_path', 'out', 'save_path', 'output_dir', 'save_dir', 'out_dir', 'output_file'),
  }
  // matched 的形状不变（槽位 → 开关名或 null）：界面与既有测试都按这个读。
  const matched = {
    text: evidence.text ? evidence.text.hit.target : null,
    ref_audio: evidence.ref_audio ? evidence.ref_audio.hit.target : null,
    ref_text: evidence.ref_text ? evidence.ref_text.hit.target : null,
    output_path: evidence.output_path ? evidence.output_path.hit.target : null,
  }
  for (const [slot, ev] of Object.entries(evidence)) {
    confidence.bind[slot] = ev
      ? judgeSlot(slot, ev, params, ambiguous, entryFile)
      : null
  }

  if (ambiguous.length) {
    notes.push({
      en: `The same name appeared in both sources with different values: ${ambiguous.join(', ')}. The first one was used: confirm each slot by hand.`,
      zh: `同名参数在两种来源里指向的值不一样：${ambiguous.join('、')}。已按先出现的项填，请逐项确认。`,
    })
  }

  // 复制一份再填：浅拷贝出来的 call 里 bind 还是同一个对象，就地写会把名片原稿也改了。
  call.bind = { ...(call.bind || {}) }
  // 位置参数已经供值的槽位不再绑开关：同一个槽位两处都写，宿主会拒收整张名片。
  if (!call.bind.text && matched.text && !positionalSlots.has('text')) call.bind.text = matched.text
  if (!call.bind.ref_audio && matched.ref_audio && !positionalSlots.has('ref_audio')) call.bind.ref_audio = matched.ref_audio
  if (!call.bind.ref_text && matched.ref_text && !positionalSlots.has('ref_text')) call.bind.ref_text = matched.ref_text
  if (!call.bind.output_path && matched.output_path && !positionalSlots.has('output_path')) call.bind.output_path = matched.output_path

  // 输出是文件还是目录：落点开关以 _dir / _directory 结尾时，引擎收的是目录、
  //   文件名它自己起。其余按文件处理。
  //   这只按名字推，而名字并不可靠（叫 --output 却收目录的引擎确实存在），
  //   所以它只是第四步那格的默认值，使用者随时能改。
  //   已经写过 returns 的不覆盖，那是使用者的决定。
  const outRef = matched.output_path ||
    (positionalSlots.has('output_path') && positionalBySlot.output_path
      ? positionalBySlot.output_path.name
      : null)
  if (call.returns === undefined && outRef) {
    const outName = normName(String(outRef).replace(/^-+/, ''))
    if (/(_dir|_directory)$|^dir$/.test(outName)) {
      call.returns = 'dir'
      confidence.returns = {
        level: 'guess', value: 'dir',
        reason: {
          en: 'The output form was inferred from the parameter name ' + outRef + '. Confirm it in the file / directory selector.',
          zh: '输出形态按参数名 ' + outRef + ' 推断。请在「文件 / 目录」处确认。',
        },
      }
    }
  }

  // 所有自动收进 call.args 的参数都要进 params.call_time，否则宿主启动前会以
  //   「以下参数未接入命令行」拒收整张名片：一个开关既不写在 argv 里、又不在
  //   load_time / call_time 里、也没被 bind 引用，就永远不会出现在命令行上，
  //   界面却给了它一格。合成参数本来就该按次下发，所以默认全部进 call_time。
  //   bind 引用的那几个不进：它们由槽位单独下发，重复声明会让同一个值走两条路。
  const boundFlags = new Set(Object.values(call.bind || {}).filter(Boolean).map(String))
  const callTime = Object.entries(call.args || {})
    .filter(([, e]) => e && !boundFlags.has(String(e.flag)))
    .map(([name]) => name)

  // 顶层声明的建议（多权重位 / 输出格式）只是建议：调用方按「已有声明不覆盖」落盘。
  const manifestPatch = {}
  if (hints && Array.isArray(hints.weight_slots) && hints.weight_slots.length) {
    manifestPatch.weights = hints.weight_slots
  }
  if (hints && Array.isArray(hints.output_formats) && hints.output_formats.length) {
    manifestPatch.output_formats = hints.output_formats
  }

  // 可复现性：扫到名字就是 seed 的开关，就算证据（同名，不是猜别的语义）。
  //   这一项缺了宿主拒绝启动，所以「没扫到」时也要补一条 "none"，不能留空。
  //   名片里已经写着 "none" 时允许升级：这个值也常常是平台给的缺省，
  //   留着它等于把扫描发现的开关丢掉。已写成 {arg} / {mode:"global"} 的一律不动。
  //   cli 形态要连 call.args 一起补：宿主把种子塞进 params[键]，
  //   再由 build_cli_argv 用 call.args[键].flag 拼命令行，只写 seed 会当场报「没有形状」。
  //   入口文件里有同名开关就优先取它：训练脚本里也有 seed 的引擎不少。
  const wasNone = call.seed === 'none'
  const seedHits = params.filter((p) => p && normName(p.name) === 'seed')
  const seedHit = seedHits.find((p) => inEntryFile(p)) || (seedHits.length === 1 ? seedHits[0] : null)
  const seedUpgradable = call.seed === undefined || call.seed === 'none'
  if (seedHit && seedUpgradable) {
    if ((call.kind || 'python') === 'cli') {
      const key = normName(seedHit.name).replace(/^-+/, '')
      call.args = { ...(call.args || {}),
        [key]: { flag: seedHit.target, style: seedHit.style || 'value' } }
      call.seed = { arg: key }
    } else {
      call.seed = { arg: seedHit.name }
    }
    if (wasNone) {
      notes.push({
        en: `Scan found a seed switch (${seedHit.target}); reproducibility changed from "none" to "the engine takes it". Clear the seed field if that is wrong.`,
        zh: `扫描到种子开关（${seedHit.target}），可复现性已从「不可复现」改为「引擎自己收」。若不符，清空 seed 那一格即可。`,
      })
    }
  } else if (call.seed === undefined) {
    call.seed = 'none'
  }

  // 入口结论分档只看上游给的证据强度：high 且出自声明或文档才算确定，
  //   打分选出来的（medium / low）与并列候选都标推测，界面让人自己点清单。
  if (entry && entry.file) {
    const certain = entry.confidence === 'high' && !entry.ambiguous &&
      (entry.source === 'entry-points' || entry.source === 'readme')
    confidence.entry = {
      level: certain ? 'certain' : 'guess',
      reason: certain
        ? {
          en: 'The packaging declaration or README names this inference entry: ' + entry.file + '.',
          zh: '打包声明或 README 点名了这个推理入口：' + entry.file + '。',
        }
        : {
          en: 'The inference entry was picked by candidate scoring; evidence strength is ' + (entry.confidence || 'not recorded') + '. Confirm the selected entry.',
          zh: '推理入口按候选打分选出，证据强度为 ' + (entry.confidence || '未记录') + '。请确认所选入口。',
        },
    }
  }

  return { call, matched, argList: params, notes, callTime, manifestPatch, confidence }
}
