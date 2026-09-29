// lib/engines/spawnEngine.js
//
// 把 supervisor 需要的两件**有副作用**的事做掉：真的拉起一个进程、真的探一次活。
//
// ⭐ 为什么单独一个文件：supervisor.js 是逻辑（什么时候起、什么时候放、等多久），
//   它的全部依赖都是注入的，所以能用假进程假时钟测穷。这里是真 spawn 真 socket，
//   测不动也不该测 —— 两边混在一个文件里，那些测试就得开真进程。
//
// ⛔ 这里不做任何决策。它只是把计划照着执行。

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const http = require('node:http')
// ⭐ stdio 传输的客户端（协议帧走子进程 stdin/stdout）
const { attachStdioTransport } = require('./stdioTransport')

/**
 * 按计划拉起一个引擎进程。
 *
 * ⭐⭐⭐ 顺序要紧：**先写 profile_json，再 spawn**。
 *   反过来的话，宿主开口就是「读不了解析结果」—— 而那时候真正的原因
 *   （平台还没来得及写）已经看不见了。
 *   这一条不是新规矩，engine-launch-plan.cjs 里逐字写着同一句。
 *
 * ⭐⭐ 而且写出去的那份**必须带上这一次选中的模型**（plan.checkpoints）：
 *   宿主填 init_args 里的 {checkpoints} 时不看命令行，只看这份文件。
 *   漏了这一步 ⇒ 进程照起、声音是底模的、不报错。
 */
function spawnFromPlan(plan, { rootDir, logDir } = {}) {
  const root = rootDir || process.cwd()
  const logs = logDir || path.join(root, 'logs')

  if (plan.profile_json_path) {
    const { writeHostProfileTo } = require('./hostProfile')
    writeHostProfileTo(plan.id, plan.profile_json_path, {
      checkpointsOverride: plan.checkpoints || null,
      loadParams: plan.load_params || {},
    })
  }

  // 一台一份日志，和启动脚本用的是同一个命名（logs\<id>.log / .err.log）——
  // ⛔ 平台自己起的和脚本起的写进同一个地方，否则「日志在哪」要分情况回答。
  fs.mkdirSync(logs, { recursive: true })
  const out = fs.openSync(path.join(logs, `${plan.id}.log`), 'a')
  const err = fs.openSync(path.join(logs, `${plan.id}.err.log`), 'a')

  // ⭐⭐ stdio 传输：引擎的 **stdout 是协议通道**，不是日志。
  //   ⛔ 绝不能把它接到日志文件上 —— 那样 HTTP 帧会写进 logs\<id>.log，
  //     而客户端在等 stdout ⇒ 两头都错，而且日志看起来「有内容」，
  //     排查会先怀疑日志格式而不是传输方式。
  //   ⭐ stderr 仍然是日志（协议与日志分离，见 stdio_transport.py 顶部的说明）。
  const useStdio = (plan.transport === 'stdio') || (plan.args || []).includes('--stdio')

  // ⭐⭐⭐ 引擎必须继承一份**干净**的 env。
  //
  //   实测（stdio 那轮，2026-09-29）：broker 自己的 PYTHONPATH 会被子进程继承，
  //   而 broker 跑在 Hermes 的 venv 里 —— 于是引擎 import numpy 时拿到的是
  //   **Hermes 的 numpy 2.4.3**，不是引擎 venv 里那个能用的版本：
  //       No module named 'numpy._core._multiarray_umath'
  //   ⭐ 症状极具欺骗性：引擎「加载失败」，而平台、venv、依赖都没问题
  //     ⇒ 排查会去跑 pip install / 重建 venv，全是白费。
  //
  //   ⛔ 为什么 host.py 里的 _scrub_sys_path() 救不了：它只看 **sys.path**，
  //     而 PYTHONPATH 的内容在**解释器启动时**就已经进 sys.path 了 ——
  //     洗得掉「之后再插进来的」，洗不掉「启动时就带着的」。
  //   ⭐ 唯一的正确位置是**启动之前**：这里。
  //
  //   ⭐ stdio 模式要保留 PYTHONPATH 吗？不要 —— lib/engines 会被
  //     host.py 自己按 __file__ 找到（stdio_transport 就在它旁边）。
  const childEnv = Object.assign({}, process.env)
  delete childEnv.PYTHONPATH
  delete childEnv.PYTHONHOME
  // ⭐ 这两个也别继承：它们会让「这台引擎用哪个环境」变成一个继承来的意外。
  delete childEnv.VIRTUAL_ENV

  const child = spawn(plan.python, [plan.entry].concat(plan.args || []), {
    cwd: plan.cwd || root,
    env: childEnv,
    // ⭐ 默认 ['ignore', out, err]；stdio 模式下改成 ['pipe', out, err] ——
    //   stdin 也得是 pipe，否则平台**写不进**请求（'ignore' = 关掉）。
    stdio: useStdio ? ['pipe', 'pipe', err] : ['ignore', out, err],
    // ⭐ 后端退出时要能把它一起带走（stopAll），所以**不** detach。
    //   引擎是平台的下属进程，不是独立服务 —— 留一堆吃着 6G 内存的孤儿
    //   进程比崩掉还糟，因为下次启动会被自己的残骸占住端口。
    detached: false,
    windowsHide: true,
  })
  // ⭐ stdio 模式：给这台引擎挂一个长连接客户端（HTTP/1.1 走 stdin/stdout）。
  if (useStdio) {
    child.stdioTransport = attachStdioTransport(child, plan, { logs })
  }
  child.on('error', () => { /* spawn 失败由 supervisor 那层报，这里别让它掀翻进程 */ })
  child.on('exit', () => {
    try { fs.closeSync(out) } catch { /* 已经关了 */ }
    try { fs.closeSync(err) } catch { /* 已经关了 */ }
  })
  return child
}

/**
 * 探一次活。
 *
 * ⭐ 只回 true/false，**连不上不算错**：引擎冷启动几十秒里连接被拒是正常的，
 *   把它当致命错会让每一次启动都在第一秒失败。
 *   真正的失败判据是「预算用完了还没 true」，那句话由 supervisor 说。
 */
function probeOnce(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let req
    try {
      req = http.get(url, (res) => {
        // 2xx = 上线。其它状态码说明有人在听但还没准备好 —— 也是「还没上线」。
        const ok = res.statusCode >= 200 && res.statusCode < 300
        res.resume()
        finish(ok)
      })
    } catch {
      return finish(false)
    }
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(false) })
    req.on('error', () => finish(false))
  })
}

module.exports = { spawnFromPlan, probeOnce }
