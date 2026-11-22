'use strict'
// 第三道校验的守卫
//
// 这一份只测纯函数那一层（buildSpec）。真发 HTTP 的判别力在
//     tools/dev/probe_verify_audio.py：那要起服务 + spawn python，
//     塞进 npm test 会给 1700 条测试加两条慢的、还依赖 python 在 PATH 上。
// 两半都必须有：纯函数测「规格拼对没有」，起真服务的脚本测「判得准不准」。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { buildSpec, verifyEngine, VERIFIER, findPython, cleanPythonEnv } = require('./verifyAudio.js')

const PROF = {
  id: 'demo', label: 'Demo', base_url: 'http://127.0.0.1:9881/',
  timeout_ms: 180000, runtime: { ready_timeout_ms: 180000 },
}

// 1) 两级的语义

test('⭐⭐⭐ 默认是 B 级 —— ⛔ A 级要模型要显存，不该是随手一敲的默认值', () => {
  const s = buildSpec({ profile: PROF })
  assert.equal(s.level, 'B')
  assert.equal(s.request, undefined, 'B 级不组请求体')
})

test('⭐⭐ A 级必须显式要，且必须给 text —— 拿什么合成？', () => {
  assert.throws(() => buildSpec({ profile: PROF, level: 'A' }),
    (err) => err.code === 'ENGINE_VERIFY_A_NEEDS_TEXT',
    '⛔ A 级没有 text 就该当场拒绝，而不是发一个空请求去问引擎')
  const s = buildSpec({ profile: PROF, level: 'A', request: { text: '你好' } })
  assert.equal(s.level, 'A')
  assert.equal(s.request.text, '你好')
})

test('⭐⭐ level 写别的 ⇒ 当场报错（⛔ 不许悄悄降级成 B）', () => {
  // 降级是最坏的一种失败：用户以为验了 A 级，实际只验了 B 级。
  for (const bad of ['C', '', '  ', 'yes', 0, 1]) {
    assert.throws(() => buildSpec({ profile: PROF, level: bad, request: { text: 'x' } }),
      (err) => err.code === 'ENGINE_VERIFY_LEVEL_INVALID',
      `level="${bad}" 应当被拒`)
  }
})

test('⭐⭐ level 大小写 + 空白都认（a / A / " a " 都行）', () => {
  assert.equal(buildSpec({ profile: PROF, level: 'a', request: { text: 'x' } }).level, 'A')
  assert.equal(buildSpec({ profile: PROF, level: 'A', request: { text: 'x' } }).level, 'A')
  assert.equal(buildSpec({ profile: PROF, level: ' a ', request: { text: 'x' } }).level, 'A')
  assert.equal(buildSpec({ profile: PROF, level: 'B' }).level, 'B')
})

test('⭐⭐⭐ 「没给」用默认 B，但「给了空」当场拒 —— ⛔ 不许静默降级', () => {
  // 变异测试抓出来的洞：`opts.level || 'B'` 会把 '' 和 ' ' 都吞成 B。
  //   那是「--level 后面漏了值」或「读了空环境变量」时的表现。
  // 后果：用户以为跑了一次校验，实际跑的是弱得多的那一档，
  // 而且没有任何提示。静默降级长得像「验过了」。
  for (const empty of ['', '   ']) {
    assert.throws(() => buildSpec({ profile: PROF, level: empty, request: { text: 'x' } }),
      (err) => err.code === 'ENGINE_VERIFY_LEVEL_INVALID',
      `level=${JSON.stringify(empty)} 应当被拒，而不是悄悄变成 B`)
  }
  // 真的没给（undefined / null）才走默认
  assert.equal(buildSpec({ profile: PROF, level: undefined }).level, 'B')
  assert.equal(buildSpec({ profile: PROF, level: null }).level, 'B')
  assert.equal(buildSpec({ profile: PROF }).level, 'B')
})

test('⭐⭐⭐ 没有 base_url 就当场拒 —— ⛔ 不许猜一个「看起来对」的地址', () => {
  // 猜 127.0.0.1:9881 这种地址验过去，验到的是一台不存在的引擎，
  //   或者刚好在跑的别人的引擎：两种都会把「引擎没问题」这个假答案
  //   说得像真的一样。stdio / cli 形态的引擎由上层先拉临时宿主再验。
  for (const bad of [null, undefined, '', '   ', 42, {}]) {
    assert.throws(() => buildSpec({ profile: { ...PROF, base_url: bad } }),
      (err) => err.code === 'ENGINE_VERIFY_NO_BASE_URL',
      `base_url=${JSON.stringify(bad)} 应 当场拒`)
  }
  // 完全没有这个键也一样（名片没写 default_base_url 时 profile 里就是没有）
  assert.throws(() => buildSpec({ profile: { id: 'stdio-engine', timeout_ms: 1000 } }),
    (err) => err.code === 'ENGINE_VERIFY_NO_BASE_URL')
})

// 2) B 级那一发「故意缺 text」的请求体

test('⭐⭐⭐ B 级复用 A 级的请求体去掉 text —— ⛔ 不另编一个', () => {
  // 另编一个就多一处「两份不一样」的可能，而那种不一致不报错。
  const req = { text: '你好', ref_audio_path: 'a.wav', emo_alpha: 0.5 }
  const s = buildSpec({ profile: PROF, level: 'A', request: req })
  assert.equal('text' in s.minimal_request, false, '⛔ text 必须被去掉')
  assert.equal(s.minimal_request.ref_audio_path, 'a.wav', '其余照原样')
  assert.equal(s.minimal_request.emo_alpha, 0.5)
  // 而且不许改动原请求体
  assert.equal(req.text, '你好', '⛔ buildSpec 改了调用方的对象')
})

test('⭐⭐⭐ 两次调用不许互相污染（minimal_request 必须是新对象）', () => {
  const req = { text: 'x' }
  const a = buildSpec({ profile: PROF, level: 'A', request: req })
  const b = buildSpec({ profile: PROF, level: 'A', request: req })
  assert.notEqual(a.minimal_request, b.minimal_request, '⛔ 共用同一个对象 = 改一个影响另一个')
  a.minimal_request.injected = true
  assert.equal('injected' in b.minimal_request, false)
})

// 3) 超时预算

test('⭐⭐ 超时跟着名片的 timeout_ms 走，不写死', () => {
  const s = buildSpec({ profile: { ...PROF, timeout_ms: 300000 } })
  assert.equal(s.ready_timeout, 300, 'IndexTTS2 实测 import 34s，写死 30 会误杀')
  assert.equal(s.synth_timeout, 300)
})

test('⭐⭐ 名片没写 timeout_ms ⇒ 用一个不会误杀的下限', () => {
  const s = buildSpec({ profile: { id: 'x', base_url: 'http://127.0.0.1:1' } })
  assert.ok(s.ready_timeout >= 30, '⛔ 太小的超时会把「慢」误判成「坏」')
  assert.ok(s.synth_timeout >= 60)
})

// 4) 诚实性：这一层不许自己动手

test('⭐⭐⭐ verifyAudio.js 不许 spawn 引擎、不许 import 上游', () => {
  const src = fs.readFileSync(path.join(__dirname, 'verifyAudio.js'), 'utf8')
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  // 它只该 spawn 探针（自己的 python），不该碰引擎的解释器
  for (const forbidden of ['.venv', 'engines/', 'importlib', 'infer_v2', 'IndexTTS']) {
    assert.equal(code.includes(forbidden), false,
      `⛔ verifyAudio 出现了 ${forbidden} —— 探针只做 HTTP+WAV，不 import 引擎的任何东西`)
  }
})

test('⭐⭐⭐ 探针不许 import 名片没点名的东西（与 env_probe 同纪律）', () => {
  const src = fs.readFileSync(VERIFIER, 'utf8')
  const code = src.replace(/#.*$/gm, '').replace(/\u0022{3}[\s\S]*?\u0022{3}/g, '')
  // torch / numpy / 引擎的包：那会把平台的假设塞进本该由名片说了算的地方
  for (const forbidden of ['import torch', 'import numpy', 'import indextts', 'import soundfile']) {
    assert.equal(code.includes(forbidden), false, `⛔ 探针 import 了 ${forbidden}`)
  }
})

test('⭐⭐ 探针只用 stdlib（多一个依赖就多一处「装没装」的变量）', () => {
  const src = fs.readFileSync(VERIFIER, 'utf8')
  const imports = [...src.matchAll(/^\s*(?:from|import)\s+([a-zA-Z_][\w.]*)/gm)].map(m => m[1])
  // 白名单只收 stdlib：防的是 torch / numpy / soundfile 这类「要装才有」的包。
  //   time 是 stdlib，用来量「这一发等了多久」，属于诊断信息，不是依赖。
  const allowed = new Set(['io','json','os','struct','sys','threading','traceback','wave',
    '__future__','urllib','urllib.request','urllib.error','base64','time'])
  for (const i of imports) {
    assert.ok(allowed.has(i), `⛔ 探针 import 了非 stdlib 的 ${i} —— stdlib urllib + wave 够用`)
  }
})

test('⭐⭐⭐ WAV 体检必须看「有没有帧」，⛔ 不能只看长度', () => {
  const src = fs.readFileSync(VERIFIER, 'utf8')
  assert.match(src, /frames <= 0|一帧都没有/,
    '⭐ 44 字节的空 WAV 是最阴的失败：文件合法、能播、0 秒、界面上看不出异常')
  assert.match(src, /sample_rate|采样率/,
    '⭐ 采样率是 0 或荒诞值要抓 —— 那种能播，但拼不上（见 host.py _wav_meta）')
})

test('⭐⭐ 探针永远以 0 退出（「验不过」是答案不是探针出错）', () => {
  const src = fs.readFileSync(VERIFIER, 'utf8')
  assert.match(src, /return 0\s+#?\s*⭐?\*?⭐?.*永远/,
    '⭐ 与 env_probe.py 同纪律：非零码必须只表示「探针自己崩了」')
})

// 6) 失败原文与根因：只回一句「宿主返回 400」等于什么都没说

test('⭐⭐⭐ 失败原文不许截到看不清原因', () => {
  // 宿主把子进程 stderr 的末尾几千字塞在 body.detail 里。旧实现把它
  //   json.dumps 之后切到 1500 字，最后那行异常正好被切掉，
  //   界面上只剩「宿主返回 400」，读的人无从下手。
  const src = fs.readFileSync(VERIFIER, 'utf8')
  const code = src.replace(/#.*$/gm, '')
  assert.match(code, /def _readable_detail/, '要有一处专门把宿主的失败响应读成原文')
  for (const cut of ['[:1500]', '[:600]', '[-1500:]']) {
    assert.equal(code.includes(cut), false,
      `⛔ 探针里还在截断失败原文（${cut}）：根因常常就在被切掉的那一段`)
  }
  // 根因判断只有一份，在 lib/engines/diagnose.js：探针只取原文。
  //   两份判断迟早给出两种说法，而使用者只想知道是该改自己还是引擎真坏了。
  assert.equal(/_diagnose/.test(code), false,
    '⛔ 探针里又出现了一份根因判断：口径应当只在 lib/engines/diagnose.js')
})


// 5) 名片没有 runtime ⇒ 无从谈起（CLI 那一层的判据）

test('⭐⭐ buildSpec 只需要 base_url / timeout —— ⛔ 不该要求 runtime', () => {
  // runtime 那一层的检查在 CLI（因为要说「平台不负责起它」那句话）。
  // 这里再要求一次 = 同一件事判两遍，两遍迟早说法不一样。
  const s = buildSpec({ profile: { id: 'x', base_url: 'http://127.0.0.1:1' } })
  assert.equal(s.base_url, 'http://127.0.0.1:1')
})


// 6) 平台解释器：部署时确定的那一个，没有发现链

test('⭐⭐⭐ 平台脚本只用 tools/runtime/python：PATH、venv、环境变量都不参与', () => {
  const root = path.join(__dirname, '..', '..')
  const isWin = process.platform === 'win32'
  const deployed = isWin
    ? path.join(root, 'tools', 'runtime', 'python', 'python.exe')
    : path.join(root, 'tools', 'runtime', 'python', 'bin', 'python3')
  const saved = {}
  for (const k of ['PATH', 'AURIVOX_PYTHON', 'VIRTUAL_ENV']) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.AURIVOX_PYTHON = 'definitely-not-a-real-python'
  try {
    const py = findPython(root)
    if (!fs.existsSync(deployed)) {
      assert.strictEqual(py, null, '部署时那份解释器不在就报错，不许另找')
      return
    }
    assert.strictEqual(py, deployed, '必须就是部署时确定的那一个路径')
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-no-runtime-'))
    assert.strictEqual(findPython(emptyRoot), null,
      '换一个没有部署产物的根目录，不许借 PATH 上的 python 或平台 venv')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('⭐⭐ 探针的环境剥掉三个污染变量', () => {
  const saved = {}
  for (const k of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV']) {
    saved[k] = process.env[k]
    process.env[k] = 'polluted'
  }
  try {
    const env = cleanPythonEnv()
    for (const k of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV']) {
      assert.ok(!(k in env), k + ' 必须剥掉：它随启动向导的终端漂移')
    }
    assert.ok('PATH' in env, '其余变量保留，系统 DLL 仍要找得到')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('⭐⭐⭐ 中文 spec 在没有 UTF-8 环境变量时仍读得出来（Windows 默认编码是 GBK）', () => {
  // 我的执行环境设了 PYTHONUTF8=1 / PYTHONIOENCODING=utf-8，所以旧写法在我这能跑；
  // 用户终端没设，open() 按 cp936 解 UTF-8 的中文就 UnicodeDecodeError。
  // 这条必须在「剥掉那两个变量」的条件下真跑一次平台解释器，而不是只看源码。
  const { platformPython } = require('../util/pythonResolve.js')
  const py = platformPython(path.join(__dirname, '..', '..'))
  if (!py) return // 平台解释器不在盘上：无从谈起
  const specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-enc-')), 'spec.json')
  fs.writeFileSync(specFile, JSON.stringify({ text: '你好，这是一段示例文本。' }), 'utf8')

  const env = cleanPythonEnv()
  delete env.PYTHONUTF8
  delete env.PYTHONIOENCODING
  // 只输出 ASCII：否则 stdout 按 cp936 编码，Node 侧按 UTF-8 解码会把结论搅乱。
  const { spawnSync } = require('node:child_process')
  const r = spawnSync(py, [
    '-c',
    'import json,sys; s=json.load(open(sys.argv[1], encoding="utf-8"))["text"]; print("OK" if s=="你好，这是一段示例文本。" else "BAD")',
    specFile,
  ], { encoding: 'utf8', env })
  assert.strictEqual(r.status, 0, `读中文 spec 失败：${r.stderr}`)
  assert.strictEqual((r.stdout || '').trim(), 'OK')
})

test('⭐⭐ 规格文件读写的编码在两边成对声明', () => {
  const py = fs.readFileSync(path.join(__dirname, 'verify_audio.py'), 'utf8')
  const js = fs.readFileSync(path.join(__dirname, 'verifyAudio.js'), 'utf8')
  assert.ok(py.includes('json.load(fh)') && py.includes('encoding="utf-8"'),
    '探针读 spec 必须显式 UTF-8，不能依赖启动终端的 locale')
  assert.ok(js.includes("writeFileSync(specFile, JSON.stringify(spec), 'utf8')"),
    'Node 侧写 spec 必须显式 UTF-8')
  const reflect = fs.readFileSync(path.join(__dirname, 'reflect_params.py'), 'utf8')
  assert.ok(reflect.includes('json.load(fh)') && reflect.includes('encoding="utf-8"'),
    '反射探针读同一份 spec，不能留一个漏网的')
})


// 实时输出只转 stderr：stdout 是探针的结果 JSON，转出去就是日志末尾一整行转义文本。
function fakeProbe ({ out = '', err = '' } = {}) {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = () => {}
  setImmediate(() => {
    if (err) proc.stderr.emit('data', Buffer.from(err))
    if (out) proc.stdout.emit('data', Buffer.from(out))
    proc.emit('close', 0)
  })
  return proc
}

test('实时输出：只有 stderr 转给界面，结果 JSON 不进日志', async () => {
  const seen = []
  const r = await verifyEngine({
    profile: PROF, level: 'B', python: 'python',
    onLine: (text, isErr) => seen.push({ text, isErr }),
    spawnFn: () => fakeProbe({ out: '{"ok":true}', err: 'engine warning\n' }),
  })
  assert.equal(r.ok, true)
  assert.ok(seen.some((x) => x.text.includes('engine warning') && x.isErr === true),
    'stderr 要实时转给界面并标成异常')
  assert.ok(!seen.some((x) => x.text.includes('"ok":true')),
    '结果 JSON 是协议通道，转给界面只会多出一整行读不出来的转义文本')
})
