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

test('⭐⭐⭐ 八类根因各有各的说法，且都给「为什么 + 怎么办」', () => {
  const cases = [
    ['RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB', 500, /显存|内存不足/],
    ["ModuleNotFoundError: No module named 'pynini'", 500, /缺少依赖/],
    ['Error(s) in loading state_dict for Model: size mismatch for x', 500, /权重/],
    ['FileNotFoundError: [Errno 2] No such file or directory: a.wav', 500, /不存在/],
    ["TypeError: infer() got an unexpected keyword argument 'spk'", 400, /参数名/],
    ["TypeError: f() missing 1 required positional argument: 'prompt_text'", 500, /缺少引擎要求的输入/],
    ['ReadTimeout: timed out after 180s', 504, /超时/],
    ['401 Unauthorized: invalid token', 401, /凭据/],
  ]
  for (const [text, status, want] of cases) {
    const d = diagnose(text, status)
    assert.match(d.cause, want, `没认出：${text}`)
    assert.ok(d.hint && d.hint.length > 10, `缺建议：${text}`)
    assert.notEqual(d.cause, d.hint, '原因与建议不能是同一句')
  }
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
