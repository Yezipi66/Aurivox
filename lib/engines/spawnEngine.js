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
    })
  }

  // 一台一份日志，和启动脚本用的是同一个命名（logs\<id>.log / .err.log）——
  // ⛔ 平台自己起的和脚本起的写进同一个地方，否则「日志在哪」要分情况回答。
  fs.mkdirSync(logs, { recursive: true })
  const out = fs.openSync(path.join(logs, `${plan.id}.log`), 'a')
  const err = fs.openSync(path.join(logs, `${plan.id}.err.log`), 'a')

  const child = spawn(plan.python, [plan.entry].concat(plan.args || []), {
    cwd: plan.cwd || root,
    stdio: ['ignore', out, err],
    // ⭐ 后端退出时要能把它一起带走（stopAll），所以**不** detach。
    //   引擎是平台的下属进程，不是独立服务 —— 留一堆吃着 6G 内存的孤儿
    //   进程比崩掉还糟，因为下次启动会被自己的残骸占住端口。
    detached: false,
    windowsHide: true,
  })
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
