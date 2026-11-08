'use strict'
// 试运行拉起器：给「不是常驻 HTTP 形态」的引擎临时起一台本地宿主，
// 为第 4 道「语音合成可用性」校验提供可请求的本地地址。
//
// 为什么要拉：verify_audio 只会打 HTTP，而 stdio / cli 形态的引擎没有
// 常驻地址。host.py 的 Handler 与正式跑是同一份代码，只是这里让它走
// 临时端口的 HTTP 模式：请求格式、响应格式、错误形状一个字没变，
// 所以验这台临时宿主 = 验这台引擎的真实响应。
//
// 流程：挑空闲端口 → 引擎自己的 venv python 起 host.py → 轮询 /health
//   → ready 了把 http://127.0.0.1:<端口> 交给调用方 → 结束后（不管成败）杀进程树。
// 临时文件（名片解析结果）也一并清掉：它是这次拉起才有的东西。

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..', '..', '..')
const HOST_PY = path.join(ROOT, 'lib', 'engines', 'host.py')

/** 统一从平台要件，不在向导里重写解析逻辑（写两遍迟早分叉） */
function platform (rel) {
  return require(path.join(ROOT, rel))
}

const { killProcessTree } = require('./clone')
const { childEnvFor } = require('./envInstall')

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

/** 挑一个空闲端口：绑 0 让操作系统给，给了就还。 */
function pickFreePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => { resolve(port) })
    })
  })
}

/** 打一次 /health。不抛：一切失败都归到 {err}。 */
function probeHealth (baseUrl, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let req
    try {
      req = http.get(baseUrl + '/health', { timeout: timeoutMs }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }) }
          catch { resolve({ status: res.statusCode, body: null, raw: body.slice(0, 500) }) }
        })
      })
    } catch (e) { resolve({ err: String(e.message) }); return }
    req.on('error', (e) => { resolve({ err: String(e.message) }) })
    req.on('timeout', () => { req.destroy(); resolve({ err: 'health 探活超时' }) })
  })
}

/**
 * 一次 /health 的结果归到三态（+ 错误带回来）。
 *   ready   可以验了
 *   failed  宿主自己说加载失败：等下去也不会好，与「还在加载」是两件事
 *   loading 还在加载，继续问
 *   unreachable 连不上：进程还在就是还没绑端口，退了就是崩了（由调用方分）
 */
function classifyHealth (probe) {
  if (!probe || probe.err) {
    return { state: 'unreachable', error: probe ? probe.err : 'no probe' }
  }
  if (probe.status === 200 && probe.body && probe.body.ready === true) {
    return { state: 'ready' }
  }
  if (probe.status === 503 && probe.body && probe.body.failed) {
    return { state: 'failed', error: probe.body.error || '宿主报加载失败，等下去也不会好' }
  }
  return { state: 'loading' }
}

/**
 * 临时起一台本地宿主，结束后即杀。
 *
 * @param {object} opts
 * @param {string} opts.id 引擎 id
 * @param {object} opts.profile resolveEngineProfile 的产物（读 runtime.python 拿 venv）
 * @param {string} [opts.root] 项目根（runtime.python 相对它）
 * @param {number} [opts.readyTimeoutSec] /health 轮询上限秒数（默认跟 profile.timeout_ms）
 * @param {Function} opts.run async (baseUrl) => 任意结果；它抛错也照杀照清
 * @param {Function} [opts.spawn] 测试注入：替真 spawn
 * @param {Function} [opts.killProcessTree] 测试注入：替真杀进程树
 * @param {Function} [opts.pickFreePort] 测试注入：替真挑端口
 * @param {Function} [opts.probeHealth] 测试注入：替真探活
 * @returns {Promise<object>} { ok, base_url?, result?, stage?, error?, stderr? }
 *   ok:false 时 stage 说明挂在哪一步：args / python / profile / port /
 *   host-spawn / host-exit / health / run。
 */
async function withTempHost (opts = {}) {
  const { id, profile, run } = opts
  const root = opts.root || ROOT
  if (!id || !profile || typeof run !== 'function') {
    return { ok: false, stage: 'args', error: 'withTempHost 要 id、profile 与 run' }
  }
  // 用引擎自己的解释器：宿主要 import 引擎的模块，平台的 python 里没有。
  //   runtime.python 没写 = 名片不完整，平台不知道用哪个解释器。
  if (!profile.runtime || !profile.runtime.python) {
    return { ok: false, stage: 'python',
      error: `${id} 的名片没有 runtime.python，平台不知道用哪个解释器起宿主` }
  }
  const python = opts.python
    || platform('lib/engines/platformPaths.js')
      .resolveEnginePython(root, profile.runtime.python, process.platform)
  if (!fs.existsSync(python)) {
    return { ok: false, stage: 'python',
      error: `引擎的解释器不存在：${python}`
        + `（名片 runtime.python = ${profile.runtime.python}，相对 ${root}）` }
  }

  // 注入点与 clone.js 同一套写法：测试不真起宿主（要引擎 venv + 模型，太重）
  const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : spawn
  const killFn = typeof opts.killProcessTree === 'function'
    ? opts.killProcessTree : killProcessTree
  const pickPort = typeof opts.pickFreePort === 'function' ? opts.pickFreePort : pickFreePort
  const probe = typeof opts.probeHealth === 'function' ? opts.probeHealth : probeHealth
  // 名片解析结果也可以注入：真写要一台 manifest 完整的引擎，
  //   那是 dev 探针的事（与 verify_audio 「不 spawn python」同一纪律）。
  const writeProfile = typeof opts.writeHostProfile === 'function'
    ? opts.writeHostProfile
    : (id, dest) => platform('lib/engines/hostProfile.js').writeHostProfileTo(id, dest)

  // 名片解析结果：host.py 不读 manifest，只认这一份（hostProfile 自己的话）。
  //   解析失败让它原样报上来：它点名的「哪个引擎、哪个字段、为什么」是唯一有用的信息。
  let specFile = null
  try {
    specFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-host-')), 'profile.json')
    writeProfile(id, specFile)
  } catch (e) {
    try { if (specFile) fs.rmSync(path.dirname(specFile), { recursive: true, force: true }) }
    catch { /* 清不掉就算了 */ }
    return { ok: false, stage: 'profile', error: `解析名片失败：${e.message}` }
  }

  let port
  try { port = await pickPort() } catch (e) {
    try { fs.rmSync(path.dirname(specFile), { recursive: true, force: true }) } catch { /* */ }
    return { ok: false, stage: 'port', error: `挑不到空闲端口：${e.message}` }
  }
  const base = `http://127.0.0.1:${port}`

  // 起宿主。环境剥 PYTHONPATH / VIRTUAL_ENV：沙箱 shim 会劫持 rmtree，
  //   而 VIRTUAL_ENV 指着别的 venv 会与引擎自己的解释器打架（同 envInstall 的口径）。
  let child
  try {
    child = spawnFn(python,
      [HOST_PY, '--profile-json', specFile, '--port', String(port)],
      { cwd: root, env: childEnvFor(root), windowsHide: true })
  } catch (e) {
    try { fs.rmSync(path.dirname(specFile), { recursive: true, force: true }) } catch { /* */ }
    return { ok: false, stage: 'host-spawn', error: `起不动宿主：${e.message}` }
  }

  // stderr 尾部收着：成功用不上，失败时它是唯一说清为什么的。
  let stderrTail = ''
  const feed = (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-4000) }
  if (child.stdout) child.stdout.on('data', feed)
  if (child.stderr) child.stderr.on('data', feed)
  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })

  try {
    const readyTimeoutMs = (opts.readyTimeoutSec
      || Math.max(30, Math.ceil((profile.timeout_ms || 180000) / 1000))) * 1000
    const deadline = Date.now() + readyTimeoutMs
    let klass = { state: 'loading' }
    while (Date.now() < deadline) {
      if (exited !== null) break
      klass = classifyHealth(await probe(base))
      if (klass.state === 'ready' || klass.state === 'failed') break
      await sleep(500)
    }

    if (exited !== null) {
      return { ok: false, stage: 'host-exit', base_url: base,
        error: `宿主进程提前退出（code=${exited.code} signal=${exited.signal}）：`
          + '这是起不来，不是「验不过」',
        stderr: stderrTail }
    }
    if (klass.state === 'failed') {
      return { ok: false, stage: 'health', base_url: base,
        error: klass.error, stderr: stderrTail }
    }
    if (klass.state !== 'ready') {
      return { ok: false, stage: 'health', base_url: base,
        error: `宿主在 ${Math.round(readyTimeoutMs / 1000)} 秒内没有就绪：`
          + '可能是模型加载太慢，或者 /health 一直连不上',
        stderr: stderrTail }
    }

    const result = await run(base)
    return { ok: true, base_url: base, result }
  } catch (e) {
    return { ok: false, stage: 'run', base_url: base,
      error: String((e && e.message) || e), stderr: stderrTail }
  } finally {
    // 成败都杀：宿主只服务本次试运行，留着不会有第二次连接。
    try { killFn(child) } catch { /* 已经退了 */ }
    try { fs.rmSync(path.dirname(specFile), { recursive: true, force: true }) }
    catch { /* 清不掉就算了 */ }
  }
}

module.exports = { withTempHost, pickFreePort, probeHealth, classifyHealth, HOST_PY }
