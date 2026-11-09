// 扫描结果转成名片建议值的纯函数：不 import react，不必为了跑一个纯函数把组件树拉起来。

import { vectorShapeFromHelp } from './paramShape.js'
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
function normName (name) {
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
  text: ['text', 'tts_text', 'gen_text'],
  ref_audio: ['ref_audio', 'reference_audio', 'prompt_audio', 'prompt_wav', 'ref_wav', 'prompt_speech_path'],
  ref_text: ['ref_text', 'prompt_text', 'reference_text'],
  output_path: ['output_path', 'output_file', 'save_path', 'out_path'],
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

export function computeAutoFill (params, currentCall, bindCandidates = [], entry = null, engineId = null, hints = null, files = null) {
  if (!params || !params.length) return null

  const call = { ...(currentCall || {}) }
  const notes = []
  // 每个自动填进去的值都带一档置信度：certain 用绿色徽标，guess 用黄色徽标。
  //   只记结论与依据，不改写上面任何一段填值逻辑；界面据此标注，不据此取舍。
  const confidence = { bind: {}, returns: null, weights: null, entry: null }

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
      if (usable.length) {
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
    text: findSlot('text', 'tts_text', 'gen_text'),
    // prompt_speech_path 与 ref_audio 同义：零样本引擎用它指参考音频所在的文件。
    ref_audio: findSlot('voice', 'ref_audio', 'prompt_wav', 'ref_wav', 'spk', 'speaker',
      'reference_audio', 'prompt_speech_path', 'prompt_audio'),
    ref_text: findSlot('prompt_text', 'ref_text', 'prompt-text', 'reference_text', 'ref-text'),
    // output_dir 与 output_path 指同一个槽位：引擎那边的落点参数叫哪个都认。
    //   save_dir / out_dir 是上游常见的另两种写法，追加在末尾，不改变原有候选的优先级。
    output_path: findSlot('output', 'output_path', 'out', 'save_path', 'output_dir', 'save_dir', 'out_dir'),
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
    if (/(_dir|_directory)$|^dir$/.test(outName)) {
      call.returns = 'dir'
      confidence.returns = {
        level: 'guess', value: 'dir',
        reason: {
          en: 'The output form was inferred from the switch name ' + matched.output_path + '. Confirm it in the file / directory selector.',
          zh: '输出形态按开关名 ' + matched.output_path + ' 推断。请在「文件 / 目录」处确认。',
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
