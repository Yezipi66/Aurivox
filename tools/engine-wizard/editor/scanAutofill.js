// 扫描结果转成名片建议值的纯函数：不 import react，不必为了跑一个纯函数把组件树拉起来。
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
 * @returns {{call, matched, argList, notes}} 或 null（没有参数）；
 *   matched 是 { text, ref_audio, ref_text, output_path }，认不出时为 null。
 *   ref_text 是可选槽位：认不出不算缺，由用户自己拖进去。
 */
/**
 * 开关名归一化：上游把同一个参数写成 --model-dir、--model_dir、--modelDir 都常见。
 * 匹配一律在下划线小写写法上做，落盘仍用原名，名片里保留上游的写法。
 * 不归一化时，候选名表里全是下划线，带横线与驼峰的开关一个也匹配不上，而且不报错。
 */
function normName (name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

// 运行设备的参数名。只认这几个：写成别的（如 --accelerator）平台不猜它是设备，
//   猜错的代价是把一个普通参数当成设备，下发时填进一个引擎不认识的值。
const DEVICE_NAME_RE = /^(device|devices|gpu|run_device)$/

export function computeAutoFill (params, currentCall, bindCandidates = [], entry = null, engineId = null, hints = null) {
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
      const hit = byName[normName(n)]
      if (hit) hits.push(hit)
    }
    if (!hits.length) return null
    const inEntry = hits.find((h) => h.source_file && inEntryFile(h))
    return (inEntry || hits[0]).target
  }

  // prompt_text 不进「合成文本」的候选：零样本引擎里它几乎都是参考音频里说的那句话
  //   （参考文本），认成合成文本，念出来的就是参考音频的原话，而且不报错。
  //   它在参考文本的候选里排第一。参考文本只是尽量认：认不出就空着，不当成缺项。
  const matched = {
    text: findSlot('text', 'tts_text', 'gen_text'),
    // prompt_speech_path 与 ref_audio 同义：零样本引擎用它指参考音频所在的文件。
    ref_audio: findSlot('voice', 'ref_audio', 'prompt_wav', 'ref_wav', 'spk', 'speaker',
      'reference_audio', 'prompt_speech_path', 'prompt_audio'),
    ref_text: findSlot('prompt_text', 'ref_text', 'prompt-text', 'reference_text', 'ref-text'),
    // output_dir 与 output_path 指同一个槽位：引擎那边的落点参数叫哪个都认。
    //   save_dir / out_dir 是上游常见的另两种写法，追加在末尾，不改变原有候选的优先级。
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

  // 输出是文件还是目录：落点开关以 _dir / _directory 结尾时，引擎收的是目录、
  //   文件名它自己起。其余按文件处理。
  //   这只按名字推，而名字并不可靠（叫 --output 却收目录的引擎确实存在），
  //   所以它只是第四步那格的默认值，使用者随时能改。
  //   已经写过 returns 的不覆盖，那是使用者的决定。
  if (call.returns === undefined && matched.output_path) {
    const outName = normName(String(matched.output_path).replace(/^-+/, ''))
    if (/(_dir|_directory)$|^dir$/.test(outName)) call.returns = 'dir'
  }

  // 标了 role 的参数，值来自请求体。host 只把 params.call_time 白名单里的键交给引擎，
  //   不写进去，请求里带了也会被静默丢弃：命令行上看不到，也不报错。
  //   把名字带回给调用方，由它写进名片的 params.call_time。
  const callTime = Object.entries(call.args || {})
    .filter(([, e]) => e && (e.role === 'device' || e.role === 'audio_ref' || e.role === 'output_format'))
    .map(([name]) => name)

  // 顶层声明的建议（多权重位 / 输出格式）只是建议：调用方按「已有声明不覆盖」落盘。
  const manifestPatch = {}
  if (hints && Array.isArray(hints.weight_slots) && hints.weight_slots.length) {
    manifestPatch.weights = hints.weight_slots
  }
  if (hints && Array.isArray(hints.output_formats) && hints.output_formats.length) {
    manifestPatch.output_formats = hints.output_formats
  }

  return { call, matched, argList: params, notes, callTime, manifestPatch }
}
