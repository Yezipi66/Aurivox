'use strict'

// 第三道校验「出得了声」：Node 侧。前两道是 envCheck.js 的浅层（查盘）
// 与深层（import 名片点名的模块/类/方法），两道都过了仍然完全可能出一堆不能听的声音：
// 权重不在、配置写错、构造成功但推理抛异常、出来了但是空的、采样率是 0。
// 「import 成功」与「出得了声」之间隔着一整层，只有真跑一次才知道。
// 两级：B 级只验宿主拿到合法响应（不起模型、不出声、快、不吃显存）；A 级真跑一次合成、
// 拿到非空 WAV（要模型、要显存、慢）。A 级会先跑 B：宿主没就绪时直接发 /tts 得到 503，
// 那个结果与「引擎出声了但声音不对」长得一样 ⇒ 不能混。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { platformPython } = require('../util/pythonResolve')

const VERIFIER = path.join(__dirname, 'verify_audio.py')


/**
 * @param {object} opts
 * @param {object} opts.profile  resolveEngineProfile 的产物
 * @param {string} [opts.level]  'A' | 'B'（默认 B：A 级要模型要显存，不该是随手跑一下的默认值）
 * @param {object} [opts.request] A 级要发的请求体（引擎方言的键名）
 * @param {object} [opts.checkpointsOverride] 用哪一份底模
 */
function buildSpec(opts) {
  const profile = opts.profile
  if (!profile || !profile.id) throw new Error('spec 要有 profile')
  // 「没给」与「给了空」必须分得开：undefined ⇒ 真的没给 ⇒ 用默认 B；给了个空 ⇒ 当场拒。
  // `opts.level || 'B'` 会把两者都吞成 B，于是「我以为验了 A 级」而实际只验了 B 级。
  const raw = opts.level
  const level = (raw === undefined || raw === null) ? 'B' : String(raw).trim().toUpperCase()
  if (level !== 'A' && level !== 'B') {
    const err = new Error(
      `level 只能是 A 或 B，写的是 ${JSON.stringify(raw)}` +
      '（静默降级成 B 会让人以为验过了：宁可报错）')
    err.code = 'ENGINE_VERIFY_LEVEL_INVALID'
    throw err
  }

  // 没有地址可打：名片没写 default_base_url，也没有 base_url_env 指过来。
  //   verify_audio 只会打 HTTP，猜一个 127.0.0.1:9881 之类的地址上去验，
  //   验到的只会是「那台不存在的引擎」或者「恰好正在运行的别的引擎」。
  //   stdio / cli 形态的引擎要先由调用方起一个临时宿主（向导的试运行拉起器），
  //   把 http://127.0.0.1:<端口> 作为 base_url 传进来。
  if (!profile.base_url || typeof profile.base_url !== 'string'
    || !profile.base_url.trim()) {
    const err = new Error(
      `${profile.id} 没有 base_url：名片没写 default_base_url，也没有 base_url_env 指过来。`
      + 'verify_audio 只会打 HTTP：stdio / cli 形态的引擎要先起一个临时宿主再验。')
    err.code = 'ENGINE_VERIFY_NO_BASE_URL'
    throw err
  }

  const spec = {
    level,
    // 探针要把音频写到 engines/<id>/.wizard-verify-audio/，id 是拼那个路径要用的，不能省。
    id: profile.id,
    base_url: profile.base_url,
    root: opts.root || process.cwd(),
    ready_timeout: Math.max(30, Math.ceil((profile.timeout_ms || 180000) / 1000)),
    synth_timeout: Math.max(60, Math.ceil((profile.timeout_ms || 180000) / 1000)),
  }
  if (level === 'A') {
    if (!opts.request || !opts.request.text) {
      const err = new Error('A 级要求实际合成，spec 必须提供 request.text：未指定合成文本')
      err.code = 'ENGINE_VERIFY_A_NEEDS_TEXT'
      throw err
    }
    spec.request = opts.request
    // B 级那一发「故意缺 text」的请求，用同一份请求体去掉 text 即可：另编一个就多一处
    // 「两份不一样」的可能。
    const minimal = { ...opts.request }
    delete minimal.text
    spec.minimal_request = minimal
  }
  return spec
}


/**
 * @returns {object} 永远是对象。失败时 ok:false + 说得清是哪一档、哪一步。
 * 退出码永远是 0（「验不过」是答案不是探针出错），所以不能靠 status 判断成败。
 */
async function verifyEngine(opts) {
  let spec
  try {
    spec = buildSpec(opts)
  } catch (err) {
    return { ok: false, stage: 'spec', level: opts.level || '?', error: err.message, code: err.code }
  }

  // 用平台的 Python 跑探针，不是引擎的：探针只做 HTTP + WAV 解析，不 import 引擎的
  // 任何东西（同 env_probe 的纪律）。用引擎的 venv 反而多一个「它装没装」的变量。
  const python = opts.python || findPython(opts.root)
  if (!python) {
    return { ok: false, stage: 'spawn', level: spec.level,
      error: '平台解释器不可用：tools/runtime/python 起不来。请重跑平台安装步骤'
        + '（它会用这个解释器重建 venv）。探针本身只要 stdlib urllib + wave' }
  }

  // 规格走临时文件而不是命令行：中文/引号在 Windows 上会被二次解析
  const specFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-verify-')), 'spec.json')
  fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8')

  // 异步起、边读边转：spawnSync 会把整个事件循环按住，
  //   按住期间宿主那一路的 stdout/stderr 回调一行都执行不了，
  //   于是界面上几十秒什么都不动，结束后才一股脑出现。
  //   超时也自己管：异步版没有现成的 timeout 选项。
  const timeoutMs = (spec.level === 'A'
    ? spec.synth_timeout : spec.ready_timeout + 30) * 1000 + 30000
  const onLine = typeof opts.onLine === 'function' ? opts.onLine : null
  // 测试注入：默认就是真的 spawn。测试要验「哪一路被转给了界面」，
  //   起真 Python 太慢，而这一层的行为与探针逻辑无关。
  const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn
  const outChunks = []
  const errChunks = []
  let errLen = 0
  let status = null
  let timedOut = false
  let spawnErr = null
  try {
    const proc = spawnFn(python, [VERIFIER, '--spec-file', specFile], {
      env: cleanPythonEnv(),
      windowsHide: true,
    })
    proc.stdout.on('data', (c) => {
      // stdout 是协议通道：探针只在退出前打一份结果 JSON，供下面 JSON.parse。
      //   把它转给界面的话，日志末尾会多出一整行带 \n 转义的 JSON，读不出任何东西；
      //   同一份结果已经由调用方渲染成结论与原文，不需要再流一遍。
      outChunks.push(c)
    })
    proc.stderr.on('data', (c) => {
      const text = c.toString('utf8')
      errLen += text.length
      errChunks.push(text)
      // 只留末尾 2000 字：非零退出时要说清为什么，前面的进度行没有诊断价值。
      while (errLen > 8000 && errChunks.length > 1) {
        errLen -= errChunks[0].length
        errChunks.shift()
      }
      if (onLine) onLine(text, true)
    })
    const timer = setTimeout(() => {
      timedOut = true
      try { proc.kill() } catch { /* 已经退了 */ }
    }, timeoutMs)
    await new Promise((resolve) => {
      proc.on('error', (e) => { spawnErr = e; resolve() })
      proc.on('close', (code) => { status = code; resolve() })
    })
    clearTimeout(timer)
  } catch (err) {
    spawnErr = err
  } finally {
    try { fs.rmSync(path.dirname(specFile), { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  }

  const out = Buffer.concat(outChunks).toString('utf8')
  const err = errChunks.join('')

  if (spawnErr) {
    return { ok: false, stage: 'spawn', level: spec.level,
      error: `起不动验证器 ${python}：${spawnErr.message}` }
  }
  if (timedOut) {
    return { ok: false, stage: 'probe-crash', level: spec.level,
      error: `验证器超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止：`
        + '这是探针自己未完成，不是「引擎没通过」',
      detail: err.slice(-2000) }
  }
  if (status !== 0) {
    // 非零 = 探针自己出事，与「这台引擎验不过」是两回事。必须分开说，混起来会让人以为
    // 「引擎有问题」，而去查一个根本没坏的引擎。
    return { ok: false, stage: 'probe-crash', level: spec.level,
      error: `验证器非零退出（code=${status}）：这是探针自己出事，不是「引擎没通过」`,
      detail: err.slice(-2000) }
  }

  let payload
  try {
    payload = JSON.parse(out)
  } catch {
    return { ok: false, stage: 'parse', level: spec.level,
      error: '验证器输出不是 JSON：可能是环境在 import 时向 stdout 输出了内容',
      detail: out.slice(0, 2000) }
  }
  // 补上「验的是哪一台」：不然一份报告寄出去时不知道说的是谁
  payload.engine = opts.profile.id
  return payload
}

/**
 * 平台 spawn 的解释器环境：固定一套，所有调用方共用。
 *
 * PYTHONHOME / PYTHONPATH / VIRTUAL_ENV 来自启动向导的那个终端，不由平台控制；
 * 有的环境向 PYTHONPATH 塞 sitecustomize，能在标准库里动手脚。
 * 不指定 I/O 编码时，中文 Windows 的文本 I/O 走 cp936：探针输出的中文
 * 与 Node 侧按 UTF-8 解码不一致，规格文件里的中文还会直接解码失败。
 */
function cleanPythonEnv() {
  const env = { ...process.env }
  delete env.PYTHONHOME
  delete env.PYTHONPATH
  delete env.VIRTUAL_ENV
  env.PYTHONUTF8 = '1'
  env.PYTHONIOENCODING = 'utf-8'
  return env
}

/** 平台脚本用部署时确定的那一个解释器，没有发现链。 */
function findPython(rootDir) {
  return platformPython(rootDir)
}

module.exports = { buildSpec, verifyEngine, VERIFIER, findPython, cleanPythonEnv }
