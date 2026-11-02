// 扫描结果转成名片建议值的纯函数：不 import react，不必为了跑一个纯函数把组件树拉起来。
//
// 输入是 /wizard/discover 返回的参数表，输出是名片的 call 段建议。

/**
 * 把扫描到的参数转成名片 call 段的建议值。
 *
 * @param params [{source, name, target, kind, style, help, required, group, is_tool, source_file}]
 *   cli 路的 name 是开关去掉横线的部分、target 是开关本身，进 call.args；
 *   python 路的 name 与 target 同名，都是上游方法的参数名，不进 call.args。
 * @param currentCall 现有的 call 段，作基底；用户手填的值不被覆盖。
 * @param bindCandidates 反射器剔掉的 bind 槽位候选 [{name, target, bind_slot}]，
 *   认槽位用（它们不在 parameters[] 里）。
 * @param entry /wizard/discover 判出的推理入口 {file, module}。给了就用它替掉 argv 里的
 *   模块占位符，并把槽位匹配的「同文件」判据锚到这个文件上。
 * @param engineId 引擎 id。入口是模块名时，call.cwd 要落在引擎目录上，
 *   否则 `python -m <module>` 在项目根执行会 import 不到那个模块。
 * @returns {{call, matched, argList, notes}} 或 null（没有参数）；
 *   matched 是 { text, ref_audio, ref_text, output_path }，认不出时为 null。
 *   ref_text 是可选槽位：认不出不算缺，由用户自己拖进去。
 */
export function computeAutoFill (params, currentCall, bindCandidates = [], entry = null, engineId = null) {
  if (!params || !params.length) return null

  const call = { ...(currentCall || {}) }
  const notes = []

  // kind 由名片说了算，只在只有一条来源时才改它。
  //   探测是同时扫两条路、再把结果合并成一张表的：表里混着两种来源，
  //   「有 cli 参数就置 cli」于是对一张混合表恒真，python 名片被改写成 cli 形态之后，
  //   它的参数名不再是带横线的开关，存下去当场被拒。
  const hasCli = params.some((p) => p.source === 'cli')
  const hasPy = params.some((p) => p.source === 'python')
  if (hasCli && hasPy) {
    notes.push({
      en: 'Both command line flags and Python signature parameters were found. The manifest kind was left as it is: confirm whether this engine runs through the command line or through the Python class.',
      zh: '同时发现了命令行开关和 Python 函数签名参数。名片里的 kind 保持原样：请确认这台引擎走命令行还是走 Python 类。',
    })
  } else if (hasCli) {
    call.kind = 'cli'
  } else if (hasPy) {
    call.kind = 'python'
  }

  // args 与 argv 是 cli 形态才有的两段，python 名片里写它，存的时候直接被拒。
  if (call.kind === 'cli') {
    const oldArgv = Array.isArray(call.argv) ? call.argv : []
    const idxModule = oldArgv.indexOf('_MODULE_')
    let argv = idxModule >= 0 ? oldArgv.slice(0, idxModule + 1) : oldArgv.slice(0, 3)
    if (!argv.length) argv = ['{engine_python}', '-m', '_MODULE_']
    // 入口由扫描认出来时替掉占位符。_MODULE_ 留在名片里能过校验，但引擎一启动就是
    // ModuleNotFoundError，而那个报错指向 Python，看不出是名片这一格的事。
    const mod = entry && entry.module
    if (mod && argv.includes('_MODULE_')) argv = argv.map((w) => (w === '_MODULE_' ? mod : w))
    call.argv = argv
    // 模块名要能 import，工作目录必须落在引擎目录上；示例命令默认在仓库根执行。
    if (mod && engineId && !call.cwd) call.cwd = `engines/${engineId}`

    // 只收 cli 来源的参数：python 参数名不是开关，写进去就是一条认不出的开关。
    // 入口认出来之后只收那个文件的开关：argv 跑的就是它，别的脚本的开关
    //   写进 indexed 名单后一旦被发出，argparse 会以 unrecognized arguments 拒绝。
    const argSource = (entry && entry.file)
      ? params.filter((p) => p.source_file === entry.file)
      : params
    call.args = call.args || {}
    for (const p of argSource) {
      if (p.source !== 'cli' || call.args[p.name]) continue
      const arg = { flag: p.target }
      if (p.style) arg.style = p.style
      call.args[p.name] = arg
    }
  }

  // 槽位：候选名对的是 name（不带横线的那个词），写进 bind 的是 target
  // （cli 路是开关，python 路是参数名）。索引必须建在 name 上：建在 target 上时，
  // cli 路的 target 是带横线的开关，而候选名不带横线，两边永远不匹配。
  // 同一个名字可能在多个源文件里各写一遍（推理入口 + 同仓库的辅助脚本），所以按名字收全部候选，
  //   不再「先到先得」：先到先得等于让扫描顺序决定名片语义，而扫描顺序不是名片的一部分。
  const cands = new Map()
  for (const p of params) {
    if (!cands.has(p.name)) cands.set(p.name, [])
    cands.get(p.name).push(p)
  }
  const ambiguous = []
  for (const [name, list] of cands) {
    const targets = new Set(list.map((p) => p.target))
    if (targets.size > 1) ambiguous.push(name)
  }
  // 推理入口所在的文件：扫描判出的入口优先；没有就用「声明了文本开关的那个文件」。
  //   参考音频与输出槽位都应当来自同一个文件：同仓库的辅助脚本常与推理入口同名开关，
  //   只用候选名顺序取会配到辅助脚本那一个，且不报错。
  const entryFile = (entry && entry.file)
    ? entry.file
    : (() => {
        const t = params.find((p) => p.name === 'text' && p.source_file)
        if (t) return t.source_file
        const rq = params.find((p) => p.required === true && p.source_file)
        return rq ? rq.source_file : null
      })()
  // bind 槽位候选：反射器按 BIND_SLOTS 剔掉的那几个名字（text / output_path /
  //   output_dir），它们不在 parameters[] 里，而认槽位靠的就是名字。
  //   少了这一段，output_path 永远认不出来，表现为「名片里那一格始终空着」。
  //   params 里已有的同名参数优先，不覆盖它自己的判断。
  const bindByName = new Map()
  for (const c of (bindCandidates || [])) {
    if (!c || !c.name) continue
    if (!cands.has(c.name)) bindByName.set(c.name, { name: c.name, target: c.target || c.name })
  }
  const findSlot = (...names) => {
    // 把所有候选名展开成一个扁平列表，再统一按「是否与文本开关同文件」筛。
    //   不能只在同名候选里比文件：候选名本身有先后，--output_dir 排在 --save_dir 前面时，
    //   辅助脚本的开关会先命中，同文件的那一个轮不到。
    const hits = []
    for (const n of names) {
      const list = cands.get(n)
      if (list && list.length) { for (const p of list) hits.push(p); continue }
      const bc = bindByName.get(n)
      if (bc) hits.push({ name: n, target: bc.target, source_file: null })
    }
    if (!hits.length) return null
    // 证据优先于名字顺序：同文件的候选赢；没有同文件的再退回名字顺序。
    if (entryFile) {
      const same = hits.find((p) => p.source_file === entryFile)
      if (same) return same.target
    }
    return hits[0].target
  }

  // prompt_text 不进「合成文本」的候选：零样本引擎里它几乎都是参考音频里说的那句话
  //   （参考文本），认成合成文本，念出来的就是参考音频的原话，而且不报错。
  //   它在参考文本的候选里排第一。参考文本只是尽量认：认不出就空着，不当成缺项。
  const matched = {
    text: findSlot('text', 'tts_text', 'gen_text'),
    // prompt_speech_path / prompt_audio 是零样本引擎里最常见的叫法（上游把它当「参考音频里说的那段话的音频」），
    //   排在原有候选之后：已有名字优先，不改变既有名片的判定。
    ref_audio: findSlot('voice', 'ref_audio', 'prompt_wav', 'ref_wav', 'spk', 'speaker', 'reference_audio',
      'prompt_speech_path', 'prompt_audio', 'prompt_wav_path', 'speech_path'),
    ref_text: findSlot('prompt_text', 'ref_text', 'prompt-text', 'reference_text', 'ref-text'),
    // output_dir 与 output_path 指同一个槽位：引擎那边的落点参数叫哪个都认。
    //   save_dir 追加在末尾（upstream 常见写法），不改变原有候选的优先级。
    output_path: findSlot('output', 'output_path', 'out', 'save_path', 'output_dir', 'save_dir', 'out_dir'),
  }

  if (ambiguous.length) {
    notes.push({
      en: `The same name appeared in both sources with different values: ${ambiguous.join(', ')}. The first one was used: confirm each slot by hand.`,
      zh: `同名参数在两种来源里指向的值不一样：${ambiguous.join('、')}。已按先出现的项填，请逐项确认。`,
    })
  }

  // 复制一份再填：浅拷贝出来的 call 里 bind 还是同一个对象，就地写会把名片原稿也改了。
  call.bind = { ...(call.bind || {}) }
  if (!call.bind.text && matched.text) call.bind.text = matched.text
  if (!call.bind.ref_audio && matched.ref_audio) call.bind.ref_audio = matched.ref_audio
  if (!call.bind.ref_text && matched.ref_text) call.bind.ref_text = matched.ref_text
  if (!call.bind.output_path && matched.output_path) call.bind.output_path = matched.output_path

  // 输出形态：落点参数以 _dir 结尾（--save_dir / --output_dir）时，引擎收的是目录、
  //   文件名它自己起 ⇒ returns 用 "dir"；其余维持 "file"。
  //   平台两种都认（host.py），这里只按扫描结果选一个，使用者随时能改。
  //   只在空着的时候填：已经填过的 returns 不覆盖，那是使用者做的决定。
  if (call.returns === undefined && matched.output_path) {
    const outFlag = String(matched.output_path)
    const outName = outFlag.replace(/^-+/, '').replace(/-/g, '_')
    if (/_dir$|^dir$|_directory$/.test(outName)) call.returns = 'dir'
  }

  // 权重格：第 6 项必填（weightsProblem），cli 形态下 argv 里要有一个词带 {checkpoints}。
  //   扫描会把 --model_dir / --model_path 这类参数收进 args，但不会自己接上 argv：
  //   没有这一步，名片的权重格是空的，第 4 步当场报「引擎不知道从哪个参数读权重」。
  //   只在 argv 还没有 {checkpoints} 且不是 call.weights = "self" 时补：
  //   已经写过的（手填或 self 声明）都是使用者的决定，不覆盖。
  if (call.kind === 'cli' && call.weights === undefined &&
      Array.isArray(call.argv) && !call.argv.some((w) => String(w).includes('{checkpoints}'))) {
    const weightFlag = findWeightFlag(params, bindCandidates, entryFile)
    if (weightFlag) call.argv = [...call.argv, weightFlag, '{checkpoints}']
  }

  return { call, matched, argList: params, notes }
}

// 权重参数的开关：名字命中权重词表（model_dir / model_path / ckpt / checkpoints …）
//   才算。认 name 不认 target：target 带横线，词表是不带的。
//   只认与入口同文件的那一条：argv 跑的就是入口那个文件，辅助脚本的开关
//   写进 argv 会被 argparse 以 unrecognized arguments 拒绝。
const WEIGHT_RE = /^(model|ckpt|checkpoint|checkpoints|weight|weights|pretrained|base_model|model_path|model_dir)$|^model_(dir|path|file)s?$|^(ckpt|checkpoint)_(dir|path|file)s?$/
function findWeightFlag (params, bindCandidates, entryFile) {
  const pool = (params || []).filter((p) => p && p.name && WEIGHT_RE.test(String(p.name).toLowerCase()))
  for (const p of pool) {
    if (entryFile && p.source_file && p.source_file !== entryFile) continue
    return p.target || p.name
  }
  for (const c of (bindCandidates || [])) {
    if (c && c.name && WEIGHT_RE.test(String(c.name).toLowerCase())) {
      return c.target || c.name
    }
  }
  return null
}
