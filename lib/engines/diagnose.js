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
 * 从原文里认出常见根因，给一句「为什么」和一句「怎么办」。
 * 只认能在原文里看见证据的那几类；认不出来就明说认不出来，
 * 不替引擎编一个原因（编错的诊断比没有诊断更费时间）。
 *
 * @param {string} text 引擎/宿主的原文
 * @param {number} [status] HTTP 状态码（有就用来兜底分类）
 * @returns {{cause: string, hint: string}}
 */
function diagnose (text, status) {
  const low = String(text == null ? '' : text).toLowerCase()
  const has = (...needles) => needles.some((n) => low.includes(n))

  if (has('out of memory', 'outofmemoryerror', 'cuda error', '内存不足',
    'not enough memory', 'memoryerror')) {
    return {
      cause: '显存或内存不足，模型没有加载到推理设备上',
      hint: '改用更小的权重或更短的文本；确认同一张设备上没有其他任务占用；'
        + '把运行设备改为 CPU 可以绕过显存限制，代价是速度下降。',
    }
  }
  // 设备与 torch 不匹配：装的是 CPU 版 torch，或者这张卡不被这一版 torch 支持。
  //   必须先于「缺依赖」判：这种报错的栈里常带 torch 的 import 行。
  if (has('torch not compiled with cuda', 'no kernel image is available',
    'torch.cuda.is_available() is false', 'cuda driver version is insufficient',
    'found no nvidia driver', 'xpu is not available', 'device type xpu is not supported')) {
    return {
      cause: '这台引擎的 torch 与所选设备不匹配（常见原因是装成了 CPU 版，或这一版不支持这张卡）',
      hint: '按名片声明的安装方式重装对应版本的 torch，或者把运行设备改为 CPU；'
        + '改设备只影响速度，不影响能不能出声。',
    }
  }
  if (has('modulenotfounderror', 'no module named', 'importerror',
    'cannot import name', 'dll load failed')) {
    return {
      cause: '引擎的运行环境缺少依赖，或者依赖版本不匹配',
      hint: '回到第 2 步重装本步依赖；原文里 No module named 之后的那个名字就是缺的包。',
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
      hint: '按名片声明的仓库重新下载权重；确认权重目录里是这一版代码要求的文件。',
    }
  }
  if (has('filenotfounderror', 'no such file or directory', 'file not found',
    'cannot find the file', 'does not exist', '找不到文件')) {
    return {
      cause: '原文点名的文件或目录在盘上不存在',
      hint: '按原文里的路径核对权重目录、参考音频与配置文件的位置；相对路径以引擎目录为准。',
    }
  }
  if (has('unexpected keyword argument', 'unknown parameter', 'unrecognized arguments',
    'invalid choice', 'unexpected argument', 'got an unexpected', 'no such option')) {
    return {
      cause: '引擎不接受请求里的某个参数名',
      hint: '到合成参数里核对这一项的键名；名片 call.bind 的槽位名与引擎签名'
        + '不一致时也会出现这一条。',
    }
  }
  if (has('is required', 'requires ', 'missing required', 'required argument',
    'required positional', 'missing 1 required', '必须', '缺少')) {
    return {
      cause: '请求缺少引擎要求的输入',
      hint: '原文点名的那个输入补上再重试；需要参考音频的引擎还要填参考音频路径，'
        + '需要参考文本的引擎两者都要。',
    }
  }
  if (has('timed out', 'timeout', 'time out', '超时')) {
    return {
      cause: '合成耗时超过名片声明的超时上限',
      hint: '在本机跑过一次之后把实测耗时填进名片的 timeout_ms，或者缩短合成文本。',
    }
  }
  if (has('exit code 137', 'killed', 'terminated by signal', '被终止')) {
    return {
      cause: '子进程被系统终止，常见原因是内存耗尽',
      hint: '缩短文本或换更小的权重；确认可用内存之后再重试。',
    }
  }
  // 凭据类只认文字，不认裸数字：401 / 403 在 traceback 里通常是行号
  //   （`line 403, in _lazy_init`），照数字判会把设备问题说成令牌问题。
  if (has('unauthorized', 'forbidden', 'api key', 'invalid token',
    'authentication failed', 'authenticate failed', '401 unauthorized', '403 forbidden')) {
    return {
      cause: '引擎或上游服务拒绝了这次请求的凭据',
      hint: '核对访问令牌与相关环境变量是否已经配置；需要授权才能下载的仓库与模型'
        + '要先完成授权。',
    }
  }
  if (has('connection refused', 'actively refused', 'econnrefused', 'connect timeout')) {
    return {
      cause: '请求的端口没有服务在监听',
      hint: '确认这台引擎的宿主进程是否还在运行；常驻形态下宿主没有启动时，'
        + '启动阶段自己的报错才是真正的原因。',
    }
  }
  if (status === 400) {
    return {
      cause: '宿主在请求层拒绝了这次合成，参数或输入不合法',
      hint: '先看原文第一行：它通常点名了是哪个参数或哪个文件；'
        + '再对照名片 call.bind 与合成参数里的取值。',
    }
  }
  if (status != null) {
    return {
      cause: '引擎在推理过程中抛出异常',
      hint: '先看原文最后一行，那里通常是真正的异常类型与消息；'
        + '据它判断是缺依赖、缺权重还是参数问题。',
    }
  }
  return {
    cause: '这次合成没有成功',
    hint: '先看原文最后一行异常，再往上找第一处与这台引擎相关的报错。',
  }
}

module.exports = { diagnose, readableDetail, clip, DETAIL_LIMIT }
