'use strict'
// 失败诊断的口径守卫。
//
// 同一段 stderr 会从三个入口出去：OpenAI 兼容口（9886）、向导第 5 步的 A/B 级、
// 第 5 步的试运行。判断只许有一份（lib/engines/diagnose.js）：
// 三处各判一次，迟早给出三种说法，而使用者只想知道是该改自己还是引擎真坏了。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { diagnose, readableDetail, DETAIL_LIMIT } = require('./diagnose')

// 1) 认得出的根因

test('⭐⭐⭐ 九类根因各有各的说法，且都给「为什么 + 怎么办」', () => {
  const cases = [
    ['RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB', 500, /显存|内存不足/],
    ["ModuleNotFoundError: No module named 'pynini'", 500, /缺少依赖/],
    ['Error(s) in loading state_dict for Model: size mismatch for x', 500, /权重/],
    ['FileNotFoundError: [Errno 2] No such file or directory: a.wav', 500, /不存在/],
    ["TypeError: infer() got an unexpected keyword argument 'spk'", 400, /参数名/],
    ["TypeError: f() missing 1 required positional argument: 'prompt_text'", 500, /缺少引擎要求的输入/],
    ['ReadTimeout: timed out after 180s', 504, /超时/],
    ['401 Unauthorized: invalid token', 401, /凭据/],
    ["Unsupported device 'xpu'. Supported values are 'auto', 'cpu', 'cuda'", 500, /设备取值/],
  ]
  for (const [text, status, want] of cases) {
    const d = diagnose(text, status)
    assert.match(d.cause, want, `没认出：${text}`)
    assert.ok(d.hint && d.hint.length > 10, `缺建议：${text}`)
    assert.notEqual(d.cause, d.hint, '原因与建议不能是同一句')
  }
})

test('权重文件不全不会被说成缺输入', () => {
  const d = diagnose('ERROR: missing required model files: hf_cache/bigvgan/config.json\n'
    + 'Missing resources: hf_cache/w2v-bert-2.0\n'
    + 'Hint: rerun indextts2 download', 500)
  assert.match(d.cause, /权重/)
  assert.doesNotMatch(d.cause, /缺少引擎要求的输入/)
  assert.match(d.hint, /下载|清单/)
})

test('⭐⭐⭐ 缺哪一样要点名：包名与输入名都从原文里取', () => {
  // 「缺依赖」「缺输入」只说了类别。使用者真正要动手的是「装 urllib3」
  //   与「填参考音频」，名字就在原文里，取出来就有了。
  const mod = diagnose("ModuleNotFoundError: No module named 'urllib3'", 500)
  assert.match(mod.cause, /urllib3/, `缺的包没被点名：${mod.cause}`)
  assert.match(mod.cause, /缺少依赖/, '原来认得的类别要留着，别改成另一句话')
  // 建议句点名包，命令块由前端用第 2 步同款命令框拼：缺包名单独带出，
  //   hint 本身是可读的话，不含花括号占位符（9886 会原样显示它）。
  assert.match(mod.hint, /urllib3/, '建议要点名缺的包')
  assert.doesNotMatch(mod.hint, /\{|\}/, 'hint 不能留模板占位符给 9886')
  assert.equal(mod.missingPackage, 'urllib3', '缺包名单独交出，供前端拼命令')

  const input = diagnose("'reference_audio' is required (ZipVoice clones from a reference clip)", 400)
  assert.match(input.cause, /缺少引擎要求的输入/, input.cause)
  assert.match(input.cause, /参考音频/, `缺的输入没被点名：${input.cause}`)
})

test('⭐⭐⭐ 栈里的文件名不是缺的那个名字', () => {
  // traceback 的第一行往往是 File "infer.py"：取全文第一个引号会把它当成缺的参数名，
  //   于是报出「缺少 infer.py」。名字必须从关键词旁边取。
  const tb = 'Traceback (most recent call last):\n'
    + '  File "infer.py", line 3, in <module>\n'
    + "TypeError: f() missing 1 required positional argument: 'prompt_text'"
  const d = diagnose(tb, 500)
  assert.match(d.cause, /参考文本/, d.cause)
  assert.doesNotMatch(d.cause, /infer\.py/, '⛔ 把栈里的文件名当成了缺的那个名字')

  const modTb = 'Traceback (most recent call last):\n'
    + '  File "infer.py", line 76, in <module>\n'
    + "ModuleNotFoundError: No module named 'urllib3'"
  const m = diagnose(modTb, 500)
  assert.match(m.cause, /urllib3/, m.cause)
  assert.doesNotMatch(m.cause, /infer\.py/, '⛔ 缺包那条也照文件名判了')
})

test('⭐⭐⭐ 上游自己声明可回退的缺包，不是这次失败的原因', () => {
  // ZipVoice 的 scaling.py 是 `try: import k2 / except: logging.warning(...fallback...)`：
  //   没装 k2 是它声明过的、可回退的情况。这行 warning 里带着 `No module named 'k2'`，
  //   照关键词判会报「缺依赖：k2」，让人去装一个 Windows 上没有轮子的加速库，
  //   而真正让这次请求失败的原因被这句话盖住。
  const warn = 'WARNING:root:Failed import k2 with error No module named \'k2\'. '
    + 'Swoosh functions will fallback to PyTorch implementation, leading to slower speed.'
  const d = diagnose(warn, 500)
  assert.doesNotMatch(d.cause, /缺少依赖/, `⛔ 把可回退的 warning 当成失败原因：${d.cause}`)
  assert.doesNotMatch(d.hint, /k2/, `⛔ 建议去装一个用不上的包：${d.hint}`)

  // 同一段原文里另有真缺的包时，要点名那个真的，不能因为 k2 在前面就报 k2。
  const both = warn + "\nModuleNotFoundError: No module named 'urllib3'"
  const b = diagnose(both, 500)
  assert.match(b.cause, /urllib3/, `没点名真缺的包：${b.cause}`)
  assert.doesNotMatch(b.cause, /k2/, '⛔ 报的是可回退的那个包')

  // torchcodec 加载不到：既不是缺依赖也不是文件不存在，落进兜底等于什么都没说。
  const tc = warn + '\nOSError: Could not load libtorchcodec.'
  const tcDiag = diagnose(tc, 500)
  assert.match(tcDiag.cause, /torchcodec/, '没认出 torchcodec 这一条')
  // 只写「装 FFmpeg 并放进 PATH」会把人引到静态构建上：平台自带的 ffmpeg.exe 就是静态的，
  //   放进 PATH 也不解决问题。判据要把「共享库」与「静态不够」都说出来。
  assert.match(tcDiag.hint, /共享库/, '提示要说清是共享库')
  assert.match(tcDiag.hint, /静态/, '提示要说清只有 ffmpeg.exe 的静态构建不够')
})

test('⭐⭐⭐ 加载日志里出现 checkpoint 不等于权重不匹配', () => {
  // 引擎的 500 原文里可能全是加载日志（路径里带 checkpoints/），
  //   照目录名判成「权重要重下」，用户照着做一遍，问题还在原处。
  const log = 'loading config from checkpoints/s2-pro/config.json\n'
    + 'Loading sharded safetensors weights\n'
    + 'model dim=2560, fast_n_head=32'
  const d = diagnose(log, 500)
  assert.doesNotMatch(d.cause, /权重/, `⛔ 按目录名误判成权重问题：${d.cause}`)
})

test('⭐⭐⭐ traceback 里的行号不是状态码', () => {
  // traceback 的每一帧都形如 `File "...", line 403, in ...`，
  //   被当成了 403，报出「凭据被拒」。行号在 traceback 里遍地都是。
  const tb = 'File "torch/cuda/__init__.py", line 403, in _lazy_init\n'
    + 'AssertionError: Torch not compiled with CUDA enabled'
  const d = diagnose(tb, 500)
  assert.doesNotMatch(d.cause, /凭据/, `⛔ 行号被判成状态码：${d.cause}`)
  assert.match(d.cause, /torch|设备/, `没认出设备不匹配：${d.cause}`)
})

test('⭐⭐ 装的是 CPU 版 torch 时要说清怎么绕过', () => {
  const d = diagnose('AssertionError: Torch not compiled with CUDA enabled', 500)
  assert.match(d.cause, /torch|设备/)
  assert.match(d.hint, /CPU|设备/, '要给一条能走通的建议')
})

test('⭐⭐⭐ 引擎拒收设备值，不许和「torch 没编进后端」混成一条', () => {
  // 两种情况的修法完全不同：前者引擎自己只认几个名字，重装 torch 没用；
  //   后者是装错了 wheel，换设备值也没用。原文里都能看见证据，就该分开说。
  const rejected = diagnose("Failed to load model (local): Unsupported device 'xpu'. "
    + "Supported values are 'auto', 'cpu', 'mps', 'cuda', or indexed CUDA devices like 'cuda:0'.", 500)
  assert.match(rejected.cause, /设备取值/, rejected.cause)
  assert.doesNotMatch(rejected.cause, /torch 与所选设备不匹配/, '⛔ 被说成了 torch 装错')
  assert.match(rejected.hint, /可选值|CPU/, '要指出去看原文列出的名字')

  const wheel = diagnose('AssertionError: Torch not compiled with XPU enabled', 500)
  assert.match(wheel.cause, /torch 与所选设备不匹配/, wheel.cause)
  assert.notEqual(rejected.cause, wheel.cause, '⛔ 两类设备的失败说法撞在一起了')
})

test('⭐⭐ 设备编号越界不算「名字写错」', () => {
  // Invalid device ordinal 是序号超出卡的块数，与「这个设备名引擎不认」不是一回事。
  const d = diagnose('RuntimeError: Invalid device ordinal: cuda:7', 500)
  assert.doesNotMatch(d.cause, /设备取值/, `⛔ 编号越界被说成名字不对：${d.cause}`)
})

test('⭐⭐ 认不出来就说认不出来，⛔ 不硬凑一个原因', () => {
  const d = diagnose('something odd happened', 500)
  assert.match(d.cause, /抛出异常|没有成功/, d.cause)
  assert.ok(d.hint.includes('最后一行'), '认不出来时要指去看哪里')
  const bare = diagnose('', null)
  assert.match(bare.cause, /没有成功/, bare.cause)
})

test('⭐⭐ 同一条原文，带不带状态码不能说成两件事', () => {
  // 状态码只用来兜底：认得出来的那几类不该因为它换一种说法。
  const text = "ModuleNotFoundError: No module named 'torch'"
  assert.strictEqual(diagnose(text, 500).cause, diagnose(text, null).cause)
  assert.strictEqual(diagnose(text, 400).cause, diagnose(text, null).cause)
})

// 2) 取原文

test('⭐⭐⭐ 原文不做 JSON 转义，换行照原样', () => {
  const body = JSON.stringify({ detail: 'line one\nline two' })
  const text = readableDetail(body)
  assert.ok(text.includes('line one\nline two'),
    `换行被转义成 \\n 了，读的人得自己还原：${JSON.stringify(text)}`)
  assert.ok(!text.includes('\\n'), '不许把转义符留在页面上')
})

test('⭐⭐⭐ 长原文不许截掉最后一行异常', () => {
  // 旧实现切到 1500 字，最后那行异常正好被切走，界面上只剩「宿主返回 500」。
  const long = 'Traceback (most recent call last):\n'
    + '  File "infer.py", line 1\n'.repeat(600)
    + 'RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB'
  const text = readableDetail(JSON.stringify({ detail: long }))
  assert.ok(text.length > 1500, `被截到 ${text.length} 字`)
  assert.ok(text.endsWith('GiB'), '最后一行异常必须还在')
  assert.ok(text.includes('中间省略'), '真超上限时要明说省略了多少')
  assert.ok(text.length <= DETAIL_LIMIT + 100, '上限还是要有的，避免几 MB 的 body 顶穿界面')
})

test('⭐⭐ 取不到原文时给空串，不编一段出来', () => {
  assert.strictEqual(readableDetail(''), '')
  assert.strictEqual(readableDetail(null), '')
  assert.strictEqual(readableDetail('{}'), '')
})

test('⭐⭐ 非 JSON 的正文照原样给（引擎把报错直接打到 stdout 的情况）', () => {
  assert.strictEqual(readableDetail('boom: cannot load model'), 'boom: cannot load model')
})

// 3) 只有一份

test('⭐⭐⭐ 三个入口都读这一份，没有第二套判断', () => {
  const root = path.join(__dirname, '..', '..')

  // 探针只取原文，不判根因
  const probe = fs.readFileSync(path.join(__dirname, 'verify_audio.py'), 'utf8')
  assert.equal(/_diagnose/.test(probe.replace(/#.*$/gm, '')), false,
    '⛔ 探针里又出现了一份根因判断')

  // 向导第 5 步的 A/B 级：补诊断走平台这一份
  const verify = fs.readFileSync(
    path.join(root, 'tools', 'engine-wizard', 'core', 'verify.js'), 'utf8')
  assert.match(verify, /lib\/engines\/diagnose\.js/, '向导没读平台那份判断')

  // 试运行同理
  const measure = fs.readFileSync(
    path.join(root, 'tools', 'engine-wizard', 'core', 'measure.js'), 'utf8')
  assert.match(measure, /lib\/engines\/diagnose\.js/, '试运行没读平台那份判断')

  // 上游失败：错误上挂结构化 detail 与判断，而不是把 JSON 原串拼进一句话
  const upstream = fs.readFileSync(path.join(__dirname, 'upstreamError.js'), 'utf8')
  assert.match(upstream, /upstreamDetail/, '上游失败要带可读原文')
  assert.match(upstream, /diagnosis/, '上游失败要带判断')

  // 合成路由：错误体带 detail / cause / hint，且流式不再切正文
  const routes = fs.readFileSync(
    path.join(root, 'lib', 'routes', 'synthesis.js'), 'utf8')
  assert.match(routes, /detail: err\.upstreamDetail/, '错误体要给原文')
  assert.match(routes, /cause: err\.diagnosis\.cause/, '错误体要给原因')
  assert.equal(/body\.slice\(0, 500\)/.test(routes), false,
    '⛔ 流式失败还在把正文切到 500 字，异常行会丢')
})
