'use strict'
// 失败诊断：把引擎的报错原文整理成「为什么」与「怎么办」。
//
// 为什么单独一份：同一段 stderr 会从三个入口出去：OpenAI 兼容口（9886）、
//   向导第 5 步的 A/B 级、第 5 步的试运行。三处各判一次，迟早给出三种说法，
//   而使用者只想知道「是我填错了，还是引擎坏了」。
//   这里只负责判断；「从响应里把原文取出来」是机械转换，Python 探针与 Node
//   各有一份（语言不同，没法共用），判断口径必须只有这一处。

// 失败原文的上限。宿主会把子进程 stderr 的末尾几千字塞进 detail，
//   上限要有（一次 traceback 可以几千行），但不能小到把最后那行异常切走。
const DETAIL_LIMIT = 12000

// body 里可能是「原文」的字段，按可读性排序。
const DETAIL_KEYS = ['detail', 'error', 'message', 'traceback', 'stderr', 'stdout']

/** 超长时保留开头与结尾：开头常有引擎的第一句抱怨，结尾是异常类型。 */
function clip (text, limit = DETAIL_LIMIT) {
  const s = String(text == null ? '' : text)
  if (s.length <= limit) return s
  const head = Math.floor(limit / 3)
  const tail = limit - head
  const omitted = s.length - limit
  return `${s.slice(0, head)}\n……（中间省略 ${omitted} 字）……\n${s.slice(-tail)}`
}

/**
 * 从失败响应里取出可读原文。
 * @param {string|object|Buffer} body 上游响应体，或已经是对象
 * @returns {string} 不含 JSON 转义的原文；取不到时返回空串
 */
function readableDetail (body, limit = DETAIL_LIMIT) {
  let value = body
  if (Buffer.isBuffer(value)) value = value.toString('utf8')
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return ''
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') value = parsed
      else return clip(text, limit)
    } catch {
      // 不是 JSON 就照原文给：那可能是引擎直接打到 stdout 的报错
      return clip(text, limit)
    }
  }
  if (value && typeof value === 'object') {
    const parts = []
    for (const key of DETAIL_KEYS) {
      const v = value[key]
      if (typeof v === 'string' && v.trim()) parts.push(v.trim())
    }
    const rest = {}
    for (const [k, v] of Object.entries(value)) {
      if (!DETAIL_KEYS.includes(k)) rest[k] = v
    }
    if (parts.length) {
      const text = parts.join('\n')
      return clip(Object.keys(rest).length
        ? `${text}\n--- 响应的其余字段 ---\n${JSON.stringify(rest)}`
        : text, limit)
    }
    // 一个字段都没有：这不是「原文」，别把 {} 当成引擎说的话显示出去。
    if (!Object.keys(value).length) return ''
    return clip(JSON.stringify(value), limit)
  }
  return ''
}

/**
 * 从某个关键词往后找第一个带引号的名字。取不到返回空串。
 *
 * 为什么按关键词锚定而不是取全文第一个：traceback 的第一行往往是
 *   `File "infer.py", line 76, in <module>`，取全文第一个得到的是文件名，
 *   于是「缺输入」会被说成缺 `infer.py`。
 * 只认 ASCII 标识符：`'text'` / `'urllib3'` / `'prompt-wav'` 都认，
 *   `'the file on disk'` 这种整句不要：那不是参数名。
 * 用 lastIndexOf：同一句可能在栈里出现多次，最后那次才是真正的异常。
 */
function quotedAfter (text, needles) {
  const s = String(text == null ? '' : text)
  const lower = s.toLowerCase()
  for (const n of needles) {
    const i = lower.lastIndexOf(n)
    if (i < 0) continue
    // 名字可能写在关键词后面（`No module named 'urllib3'`、
    //   `argument: 'prompt_text'`），也可能写在前面（`'text' is required`）。
    const after = s.slice(i + n.length).match(/['"`]([A-Za-z0-9_.\-]{1,64})['"`]/)
    if (after) return after[1]
    const before = s.slice(Math.max(0, i - 80), i).match(/['"`]([A-Za-z0-9_.\-]{1,64})['"`]\s*$/)
    if (before) return before[1]
  }
  return ''
}

// 上游把「可选依赖没装」写成 warning 的句式：装不上就回退到别的实现，进程照跑。
//   `Failed import k2 with error No module named 'k2'. Swoosh functions will fallback
//    to PyTorch implementation`（ZipVoice 的 scaling.py）是这一类。
// 这类行必须整行剔掉再判：它同时带着 `No module named` 与 fallback 字样，
//   照着关键词判会把「上游自己声明可回退」说成「缺依赖导致这次失败」，
//   而它出现的那次请求往往另有真正的异常在栈末。剔掉之后若没有别的证据，
//   宁可说认不出来，也不替引擎编一个装不上的包。
const FALLBACK_HINTS = ['fallback', 'fall back', 'optional', 'will be used instead',
  'leading to slower']

function stripFallbackWarnings (text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  const kept = lines.filter((line) => {
    const low = line.toLowerCase()
    if (!low.includes('no module named') && !low.includes('cannot import name')) return true
    return !FALLBACK_HINTS.some((h) => low.includes(h))
  })
  return kept.join('\n')
}

// 请求层的槽位名 → 界面上的那一栏。只翻这四个槽位：
//   它们由平台自己发出去，改法也在平台的界面上。
//   其余名字（上游签名里的参数）照原名给，平台不替引擎起中文名。
const REQUEST_WORDS = {
  text: '合成文本',
  reference_audio: '参考音频',
  ref_audio: '参考音频',
  prompt_wav: '参考音频',
  reference_text: '参考文本',
  ref_text: '参考文本',
  prompt_text: '参考文本',
  spk_id: '说话人',
  speaker: '说话人',
}

// 上面那些名字的英文说法：英文句子必须整句英文，不能嵌中文词。
const REQUEST_WORDS_EN = {
  text: 'synthesis text',
  reference_audio: 'reference audio',
  ref_audio: 'reference audio',
  prompt_wav: 'reference audio',
  reference_text: 'reference text',
  ref_text: 'reference text',
  prompt_text: 'reference text',
  spk_id: 'speaker',
  speaker: 'speaker',
}

/**
 * 从原文里认出常见根因，给一句「为什么」和一句「怎么办」。
 * 只认能在原文里看见证据的那几类；认不出来就明说认不出来，
 * 不替引擎编一个原因（编错的诊断比没有诊断更费时间）。
 *
 * @param {string} text 引擎/宿主的原文
 * @param {number} [status] HTTP 状态码（有就用来兜底分类）
 * @returns {{cause: string, hint: string}}
 */
function diagnose (text, status) {
  // 先剔掉「上游自己声明可回退」的 warning 行：它们带着 `No module named`，
  //   留着就会被下面的缺包分支当成失败原因。
  const cleaned = stripFallbackWarnings(text)
  const low = cleaned.toLowerCase()
  const has = (...needles) => needles.some((n) => low.includes(n))
  if (has('out of memory', 'outofmemoryerror', 'cuda error', '内存不足',
    'not enough memory', 'memoryerror')) {
    return {
      cause: '显存或内存不足，模型没有加载到推理设备上',
      causeEn: 'Out of GPU or system memory: the model did not get loaded onto the inference device',
      hint: '改用更小的权重或更短的文本；确认同一张设备上没有其他任务占用；'
        + '把运行设备改为 CPU 可以绕过显存限制，代价是速度下降。',
      hintEn: 'Use a smaller model or shorter text; check that nothing else is using the same device; '
        + 'switching the device to CPU works around the memory limit at the cost of speed.',
    }
  }
  // 设备与 torch 不匹配：装的是 CPU 版 torch，或者这张卡不被这一版 torch 支持。
  //   必须先于「缺依赖」判：这种报错的栈里常带 torch 的 import 行。
  // 只写 "torch not compiled with" 不写死 cuda：同一句模板换后端名（xpu / mps）
  //   也会出现，写死 cuda 会把 xpu 那条漏到兜底。
  if (has('torch not compiled with', 'no kernel image is available',
    'torch.cuda.is_available() is false', 'cuda driver version is insufficient',
    'found no nvidia driver', 'xpu is not available', 'device type xpu is not supported')) {
    return {
      cause: '这台引擎的 torch 与所选设备不匹配（常见原因是装成了 CPU 版，或这一版不支持这张卡）',
      causeEn: 'This engine\'s torch does not match the selected device: usually a CPU-only build '
        + 'was installed, or this build does not support this card',
      hint: '按名片声明的安装方式重装对应版本的 torch，或者把运行设备改为 CPU；'
        + '改设备只影响速度，不影响能不能出声。',
      hintEn: 'Reinstall torch for this device following the manifest install method, or switch the '
        + 'runtime device to CPU; switching only affects speed, not whether it can speak.',
    }
  }
  // 设备取值被引擎自己挡下：torch 认这张卡，是引擎的参数解析只接受固定几个名字。
  //   与上一条的分界在原文：上一条说 torch 没编进这个后端，
  //   这一条说 torch 认、引擎不认这个写法。判据避开了裸的 invalid device，
  //   那串会撞上 Invalid device ordinal（编号越界，属于另一件事）。
  if (has('unsupported device', 'unknown device', 'unrecognized device',
    'not a valid device', 'device must be one of')) {
    return {
      cause: '引擎的参数解析不接受这个设备取值',
      causeEn: 'The engine\'s argument parser does not accept this device value',
      hint: '按原文列出的可选值换一个名字；这类取值由引擎自己限定，不是显卡或 torch 的问题。'
        + '换成 CPU 通常能跑，代价是速度下降。',
      hintEn: 'Pick a name from the values listed in the raw output; these values are fixed by the '
        + 'engine, not by the GPU or torch. CPU usually works, at the cost of speed.',
    }
  }
  // torchaudio 2.9 起读写音频都经 torchcodec，它要 FFmpeg 的共享库。
  //   Windows 上没有 FFmpeg 时得到的是 `Could not load libtorchcodec`，
  //   而这句话里既没有「文件不存在」也没有「缺依赖」，落进兜底会被说成
  //   「推理过程中抛出异常」，等于什么都没说。
  if (has('libtorchcodec', 'torchcodec')) {
    return {
      cause: '引擎读写音频时经 torchaudio，而本机没有 torchcodec 需要的 FFmpeg 共享库',
      causeEn: 'The engine reads and writes audio through torchaudio, and the FFmpeg shared '
        + 'libraries torchcodec needs are missing',
      hint: 'torchaudio 2.9 起 load() / save() 默认走 torchcodec，它要 FFmpeg 的共享库（avcodec 等 DLL）；'
        + '装一份 shared 构建并把 bin 目录放进 PATH，只有 ffmpeg.exe 的静态构建不够；'
        + '或者让引擎改用 soundfile 读写音频。',
      hintEn: 'Since torchaudio 2.9, load() / save() go through torchcodec, which needs the FFmpeg '
        + 'shared libraries (the avcodec DLLs); install a shared build and put its bin directory on '
        + 'PATH, a static build with only ffmpeg.exe is not enough. Or make the engine use soundfile.',
    }
  }
  if (has('modulenotfounderror', 'no module named', 'importerror',
    'cannot import name', 'dll load failed')) {
    // 点名那个包：装它一条命令就够，不说名字的话得自己从 traceback 里抠。
    //   hint 是可读的建议句，被 9886 原样显示，不在这里放命令块或占位符；
    //   missingPackage 单独交出，让向导用第 2 步同款命令框拼出可照抄的命令。
    const mod = quotedAfter(cleaned, ['no module named', 'cannot import name'])
    return {
      cause: mod
        ? `引擎的运行环境缺少依赖：${mod} 没有装上`
        : '引擎的运行环境缺少依赖，或者依赖版本不匹配',
      causeEn: mod
        ? `The engine environment is missing a dependency: ${mod} is not installed`
        : 'The engine environment is missing a dependency, or the version does not match',
      hint: mod
        ? `使用uv在该引擎的虚拟环境安装${mod}`
        : '回到第 2 步重装本步依赖；原文里 No module named 之后的那个名字就是缺的包。',
      hintEn: mod
        ? `Install ${mod} into the engine's virtual environment with uv`
        : 'Reinstall this step\'s dependencies in step 2; the name after "No module named" in the raw '
          + 'output is the missing package.',
      missingPackage: mod || null,
    }
  }
  // 权重不匹配只认明确的那几种报错。裸的 "checkpoint" 太宽：模型加载日志里
  //   处处是这个词（路径、目录名），照它判会把「加载到一半崩了」说成「权重要重下」，
  //   用户照着做一遍，问题还在原处。
  if (has('error(s) in loading state_dict', 'size mismatch', 'missing key(s)',
    'unexpected key(s)', 'state_dict', 'no such checkpoint', 'checkpoint not found',
    'cannot find checkpoint', 'checkpoint does not exist')) {
    return {
      cause: '权重与这一版代码不匹配，加载时键名或形状不一致',
      causeEn: 'The weights do not match this version of the code: key names or shapes differ on load',
      hint: '按名片声明的仓库重新下载权重；确认权重目录里是这一版代码要求的文件。',
      hintEn: 'Download the weights again from the repo the manifest declares; make sure the folder '
        + 'holds the files this version expects.',
    }
  }
  if (has('filenotfounderror', 'no such file or directory', 'file not found',
    'cannot find the file', 'does not exist', '找不到文件')) {
    return {
      cause: '原文点名的文件或目录在盘上不存在',
      causeEn: 'A file or directory named in the raw output is not on disk',
      hint: '按原文里的路径核对权重目录、参考音频与配置文件的位置；相对路径以引擎目录为准。',
      hintEn: 'Check the paths in the raw output against the weights folder, the reference audio and '
        + 'the config files; relative paths are resolved against the engine directory.',
    }
  }
  if (has('unexpected keyword argument', 'unknown parameter', 'unrecognized arguments',
    'invalid choice', 'unexpected argument', 'got an unexpected', 'no such option')) {
    return {
      cause: '引擎不接受请求里的某个参数名',
      causeEn: 'The engine does not accept one of the parameter names in the request',
      hint: '到合成参数里核对这一项的键名；名片 call.bind 的槽位名与引擎签名'
        + '不一致时也会出现这一条。',
      hintEn: 'Check the key name in the synthesis parameters; this also happens when the manifest '
        + 'call.bind slot name does not match the engine signature.',
    }
  }
  // 「missing required model files」也含 missing required，必须排在缺输入之前：
  //   它说的是权重没下全，不是请求少传了参数。照缺输入回，用户会去填参考音频。
  if (has('missing required model files', 'missing model files', 'missing resources')) {
    return {
      cause: '权重文件不全：引擎点名了盘上缺少的模型文件',
      causeEn: 'The weights are incomplete: the engine named model files that are missing from disk',
      hint: '按原文列出的路径补齐。这类辅助模型常不在上游主仓库的文件清单里，'
        + '用引擎自带的下载入口补齐，或把对应的仓库与文件加进第 3 步的清单再下。',
      hintEn: 'Fetch what the raw output lists. These auxiliary models are often not in the main '
        + 'repo file list; use the engine\'s own download entry, or add the repo and file to the '
        + 'step 3 list and download again.',
    }
  }
  if (has('is required', 'requires ', 'missing required', 'required argument',
    'required positional', 'missing 1 required', '必须', '缺少')) {
    // 点名缺哪一个输入：宿主与上游都把名字写在引号里，
    //   「请求缺少引擎要求的输入」这句话本身不告诉人该填哪一栏。
    const raw = quotedAfter(text, ['is required', 'required positional argument',
      'missing required', 'required argument'])
    const word = raw ? (REQUEST_WORDS[raw] || raw) : ''
    const wordEn = raw ? (REQUEST_WORDS_EN[raw] || raw) : ''
    return {
      cause: word
        ? `请求缺少引擎要求的输入：${word}`
        : '请求缺少引擎要求的输入',
      causeEn: wordEn
        ? `The request is missing an input the engine requires: ${wordEn}`
        : 'The request is missing an input the engine requires',
      hint: word
        ? `在第 5 步的请求里补上${word}（原文写作 ${raw}）再重试。`
        : '原文点名的那个输入补上再重试；需要参考音频的引擎还要填参考音频路径，'
          + '需要参考文本的引擎两者都要。',
      hintEn: wordEn
        ? `Add ${wordEn} to the request in step 5 (the raw output calls it ${raw}) and retry.`
        : 'Add the input named in the raw output and retry; engines that need reference audio also '
          + 'need its path, and those that need reference text need both.',
    }
  }
  if (has('timed out', 'timeout', 'time out', '超时')) {
    return {
      cause: '合成耗时超过名片声明的超时上限',
      causeEn: 'The synthesis exceeded the timeout declared in the manifest',
      hint: '在本机跑过一次之后把实测耗时填进名片的 timeout_ms，或者缩短合成文本。',
      hintEn: 'After one local run, put the measured time into the manifest timeout_ms, or shorten '
        + 'the text.',
    }
  }
  if (has('exit code 137', 'killed', 'terminated by signal', '被终止')) {
    return {
      cause: '子进程被系统终止，常见原因是内存耗尽',
      causeEn: 'The child process was killed by the system, usually because memory ran out',
      hint: '缩短文本或换更小的权重；确认可用内存之后再重试。',
      hintEn: 'Shorten the text or switch to smaller weights; check free memory before retrying.',
    }
  }
  // 凭据类只认文字，不认裸数字：401 / 403 在 traceback 里通常是行号
  //   （`line 403, in _lazy_init`），照数字判会把设备问题说成令牌问题。
  if (has('unauthorized', 'forbidden', 'api key', 'invalid token',
    'authentication failed', 'authenticate failed', '401 unauthorized', '403 forbidden')) {
    return {
      cause: '引擎或上游服务拒绝了这次请求的凭据',
      causeEn: 'The engine or an upstream service rejected the credentials for this request',
      hint: '核对访问令牌与相关环境变量是否已经配置；需要授权才能下载的仓库与模型'
        + '要先完成授权。',
      hintEn: 'Check that the access token and the related environment variables are set; repos and '
        + 'models behind a gate must be authorised first.',
    }
  }
  if (has('connection refused', 'actively refused', 'econnrefused', 'connect timeout')) {
    return {
      cause: '请求的端口没有服务在监听',
      causeEn: 'Nothing is listening on the requested port',
      hint: '确认这台引擎的宿主进程是否还在运行；常驻形态下宿主没有启动时，'
        + '启动阶段自己的报错才是真正的原因。',
      hintEn: 'Check whether the host process for this engine is still running; in resident form, if '
        + 'the host never started, the startup error is the real cause.',
    }
  }
  if (status === 400) {
    return {
      cause: '宿主在请求层拒绝了这次合成，参数或输入不合法',
      causeEn: 'The host rejected this synthesis at the request layer: a parameter or input is not valid',
      hint: '先看原文第一行：它通常点名了是哪个参数或哪个文件；'
        + '再对照名片 call.bind 与合成参数里的取值。',
      hintEn: 'Read the first line of the raw output: it usually names the parameter or file; then '
        + 'compare it with the manifest call.bind and the values in the synthesis parameters.',
    }
  }
  if (status != null) {
    return {
      cause: '引擎在推理过程中抛出异常',
      causeEn: 'The engine raised an exception during inference',
      hint: '先看原文最后一行，那里通常是真正的异常类型与消息；'
        + '据它判断是缺依赖、缺权重还是参数问题。',
      hintEn: 'Read the last line of the raw output: it is usually the real exception type and '
        + 'message; use it to tell a missing dependency from missing weights or a parameter problem.',
    }
  }
  return {
    cause: '这次合成没有成功',
    causeEn: 'This synthesis did not succeed',
    hint: '先看原文最后一行异常，再往上找第一处与这台引擎相关的报错。',
    hintEn: 'Read the last exception line, then look upwards for the first error related to this engine.',
  }
}

module.exports = { diagnose, readableDetail, clip, DETAIL_LIMIT }
