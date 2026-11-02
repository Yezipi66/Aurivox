// 把 supervisor 需要的两件有副作用的事做掉：真的拉起一个进程、真的探一次活。
// 单独一个文件是为了让 supervisor.js 能用假进程假时钟测穷。

const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFile, execFileSync } = require('node:child_process')
const http = require('node:http')
const { attachStdioTransport } = require('./stdioTransport')

// 按计划拉起一个引擎进程。顺序要紧：先写 profile_json 再 spawn，反过来的话宿主开口就是「无法读取解析结果」。
// 写出的那份必须带上 plan.checkpoints：宿主填 {checkpoints} 时只看这份文件，漏了它，进程照起、声音是底模的、不报错。
// enginesDir / localRoot：写 profile_json 时按哪个 engines/ 目录找名片、按哪个根读本机记录。
// 不给时与平台自己起引擎一致（ENGINES_DIR、APP_DIR）；向导在 worktree 里试运行主仓库的引擎时要给。
function spawnFromPlan(plan, { rootDir, logDir, enginesDir, localRoot } = {}) {
  const root = rootDir || process.cwd()
  const logs = logDir || path.join(root, 'logs')

  if (plan.profile_json_path) {
    const { writeHostProfileTo } = require('./hostProfile')
    writeHostProfileTo(plan.id, plan.profile_json_path, {
      checkpointsOverride: plan.checkpoints || null,
      loadParams: plan.load_params || {},
      enginesDir,
      localRoot,
    })
  }

  // 一台一份日志，命名与启动脚本那份一致。
  fs.mkdirSync(logs, { recursive: true })
  const out = fs.openSync(path.join(logs, `${plan.id}.log`), 'a')
  const err = fs.openSync(path.join(logs, `${plan.id}.err.log`), 'a')

  // stdio 传输：引擎的 stdout 是协议通道，不是日志。接到日志文件上，HTTP 帧会写进日志，而客户端在等
  // stdout，两头都错。
  const useStdio = (plan.transport === 'stdio') || (plan.args || []).includes('--stdio')

  // 引擎必须继承一份干净的 env。删掉 PYTHONPATH / PYTHONHOME / VIRTUAL_ENV：broker 自己跑在别的 venv
  // 里，继承后引擎 import 到的不是引擎 venv 里的包，症状是引擎「加载失败」而环境本身没问题。
  const childEnv = Object.assign({}, process.env)
  delete childEnv.PYTHONPATH
  delete childEnv.PYTHONHOME
  delete childEnv.VIRTUAL_ENV

  // 引擎的第三方包自己拉的权重：落点重定向。有些包会在运行时自己 snapshot_download，默认落到用户家目录
  // 的缓存里，平台看不见。平台只覆盖下面几个 SDK（各认一个自己的环境变量），某个包自己
  // expanduser("~/.cache/xxx") 的管不了它。下面先删掉继承来的值：不删，继承值会盖掉这里指定的位置。
  const P = require('../paths')
  for (const k of ['MODELSCOPE_CACHE', 'HF_HOME', 'HUGGINGFACE_HUB_CACHE', 'TORCH_HOME']) {
    delete childEnv[k]
  }
  childEnv.MODELSCOPE_CACHE = P.MODELSCOPE_CACHE_DIR
  childEnv.HF_HOME = P.HF_HOME_DIR
  childEnv.TORCH_HOME = P.TORCH_HOME_DIR
  try { fs.mkdirSync(P.MODELSCOPE_CACHE_DIR, { recursive: true }) } catch (_) { /* 建不了就让引擎自己报错 */ }


  const child = spawn(plan.python, [plan.entry].concat(plan.args || []), {
    cwd: plan.cwd || root,
    env: childEnv,
    // 默认 ['ignore', out, err]；stdio 模式下改成 ['pipe', out, err]，stdin 也得是 pipe，否则平台写不进请求。
    stdio: useStdio ? ['pipe', 'pipe', err] : ['ignore', out, err],
    // 后端退出时要能把它一起带走（stopAll），所以不 detach。
    detached: false,
    windowsHide: true,
  })
  if (useStdio) {
    child.stdioTransport = attachStdioTransport(child, plan)
  }
  // kill() 必须杀整棵树，不是杀一个 PID：plan.python 指向的是 venv 的壳，真身解释器才占着引擎的内存，而
  // Node 的 child.kill() 在 Windows 上只杀那个 PID，空闲释放和换模型重开都会留下占着内存的孤儿，supervisor 却
  // 显示「已经放掉了」。走 taskkill /T：Windows 自带的、唯一真正会递归的杀法（killTree 异步，killTreeSync 同步）。
  const killTreeSync = () => {
    if (child.exitCode != null || child.pid == null) return
    if (process.platform !== 'win32') {
      // POSIX 上子进程和我们同组，kill(pid) 够了；taskkill 那边没有这个命令。
      try { child.kill() } catch { /* 已经死了 */ }
      return
    }
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 10000, stdio: 'ignore' })
    } catch { /* 杀不掉不是调用方的错，别掀翻退出流程 */ }
  }
  const killTree = () => new Promise((resolve) => {
    if (child.exitCode != null || child.pid == null) return resolve()
    if (process.platform !== 'win32') {
      try { child.kill() } catch { /* 已经死了 */ }
      return resolve()
    }
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 10000 },
      () => resolve())   // 失败也 resolve：杀不掉不是调用方的错，别掀翻它
  })
  child.killTree = killTree
  child.killTreeSync = killTreeSync
  child.on('error', () => { /* spawn 失败由 supervisor 那层报，这里别让它掀翻进程 */ })
  child.on('exit', () => {
    try { fs.closeSync(out) } catch { /* 已经关了 */ }
    try { fs.closeSync(err) } catch { /* 已经关了 */ }
  })
  return child
}

// 探一次活：只回 true/false，连不上不算错（冷启动期间连接被拒是正常的）。失败判据是「预算用完了还没 true」。
const MAX_PROBE_BODY = 64 * 1024

// 一次 /health 的回答怎么读，HTTP 与 stdio 两条路共用这一份。
// 2xx = 上线。其它状态码说明有人在听但还没准备好：也是「还没上线」。
// 不看 body 就扔掉是不行的：/health 把 failed（加载已经失败）和 error（失败原因）放在 body 里。
// 丢掉它们，调用方只能等满预算再报「超时」，把人指向「机器太慢」，而真相是加载抛了异常。
function readyVerdict(statusCode, body) {
  if (statusCode >= 200 && statusCode < 300) return true
  let payload = null
  try { payload = JSON.parse(Buffer.from(body || '').toString('utf8')) } catch (_) { /* 不是 JSON */ }
  if (payload && payload.failed) {
    const err = new Error(payload.error || 'engine failed to load')
    err.engineFailed = true
    err.detail = payload
    return err
  }
  return false
}

function probeOnce(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let req
    try {
      req = http.get(url, (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          if (size >= MAX_PROBE_BODY) return          // 够了就只丢不存
          size += c.length
          chunks.push(c)
        })
        res.on('end', () => finish(readyVerdict(res.statusCode, Buffer.concat(chunks))))
        res.on('error', () => finish(ok))
      })
    } catch {
      return finish(false)
    }
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(false) })
    req.on('error', () => finish(false))
  })
}

// stdio 这条路的探活：经管道问 ready_endpoint。宿主在后台线程加载模型，/health 随时可答，
// 但这一问排在管道队列里：别的请求在前面时要等它回完。超时 = 还没上线（false），不算错。
// 管道已经断了（进程退出）也回 false：进程退没退由调用方看 exitCode，那边有退出码，这里没有。
async function probeStdio(conn, endpoint, timeoutMs = 1000) {
  if (!conn || conn.closed) return false
  try {
    const r = await conn.request({ method: 'GET', path: endpoint || '/health', timeoutMs })
    return readyVerdict(r.statusCode, r.body)
  } catch (_) {
    return false
  }
}

module.exports = { spawnFromPlan, probeOnce, probeStdio, readyVerdict }
