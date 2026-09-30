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
const { spawn, execFile, execFileSync } = require('node:child_process')
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

  // ⭐⭐⭐ 引擎的第三方包自己拉的权重 —— 落点重定向（2026-09-29）
  //
  //   起因：某些 TTS 的第三方包会在 import/运行时自己 snapshot_download，
  //   默认落到**用户家目录**的缓存里 —— 平台看不见，用户也不知道自己盘上
  //   少了几百 MB。[实测] 开发机上那份缓存里已有 848 MB 不是平台下的东西。
  //
  //   ⛔ 平台**只覆盖下面这几个 SDK**：它们各认一个自己的环境变量。
  //     某个包自己 expanduser("~/.cache/xxx") 的，平台**管不了**，它照样往
  //     用户家目录写。⇒ 所以子目录按 SDK 命名，一个子目录对应一个确实
  //     覆盖了的 —— 不给「所有引擎拉的都在这儿」打包票。
  //     发现新 SDK 就在这里加一行：加一个环境变量 + 一个子目录。
  //
  //   ⭐ 为什么不是 cache/：那是暂存（04_pack_release.py 写得很清楚
  //     「Nothing here is read at runtime」），⛔ 下次打包它就没了 ——
  //     而这类权重是运行必需的。
  //   ⛔ 为什么不是 vendor/：那是第三方**成品**（ffmpeg / node），判据不同。
  //
  //   ⚠️ 变量名都是上游 SDK 自己的，⛔ 不是我们发明的机制 ⇒ 任何引擎都受益。
  const P = require('../paths')
  // ⚠️ 显式清掉继承来的：用户环境里若有这些变量，不清就会盖掉我们指的位置。
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
    // ⭐ 默认 ['ignore', out, err]；stdio 模式下改成 ['pipe', out, err] ——
    //   stdin 也得是 pipe，否则平台**写不进**请求（'ignore' = 关掉）。
    stdio: useStdio ? ['pipe', 'pipe', err] : ['ignore', out, err],
    // ⭐ 后端退出时要能把它一起带走（stopAll），所以**不** detach。
    //   引擎是平台的下属进程，不是独立服务 —— 留一堆吃着 6G 内存的孤儿
    //   进程比崩掉还糟，因为下次启动会被自己的残骸占住端口。
    detached: false,
    windowsHide: true,
  })
  // ⭐ stdio 传输：给这台引擎挂一个长连接客户端（HTTP/1.1 走 stdin/stdout）。
  if (useStdio) {
    child.stdioTransport = attachStdioTransport(child, plan, { logs })
  }
  // ⭐⭐⭐ kill() 必须**杀整棵树**，不是杀一个 PID。
  //
  // 起因（真机 2026-09-29 抓到的）：supervisor.stop() 调 child.kill() 之后，
  // 9881 上还挂着一个占满 8011 MiB 显存的孤儿进程，PID 与记录在案的那个不同。
  //
  // 原因链条：plan.python 指向 .venv\Scripts\python.exe，那是 venv 的**壳**；
  // 它再派生一个 uv 管的真身解释器，100% 的引擎内存都在真身里。
  // memprobe.js 开头那段注释早就记过这件事（19320 的 4.6MB 壳 vs 10260 的
  // 3547MB 真身）—— 记账认得这条链，所以**量得准**；但 Node 的
  // child.kill() 在 Windows 上只对那个 PID 调 TerminateProcess，**不杀子孙**。
  //
  // ⇒ 症状：空闲释放和换模型重开都留下一个吃着 8G 显存的孤儿，下次启动
  //   撞 EADDRINUSE 或显存不足，而 supervisor 那边显示"已经放掉了"。
  //
  // ⛔ 为什么不用 detached: true + process.kill(-pid)：那是 POSIX 的进程组，
  //   Windows 上 Node 根本没有这个语义，detached 在 Win32 上反而让子进程
  //   脱离控制、断联后更没人收。
  // ⭐ 走 taskkill /T —— 它是 Windows 自带的、唯一真正会递归的杀法，
  //   而且 lib/training/pipeline.js:669 早就在用同一句，两处保持一致。
  // ⚠ /T 会连自己一起杀吗？不会：/T 杀的是 pid 的子孙，不含 pid 本身。
  //
  // ⭐⭐ 两个版本，**不是**重复：
  //   killTree()      异步，给运行期用（空闲释放 / 换模型 / 手动关闭）。
  //   killTreeSync()  同步，给**进程退出**用 —— server.js 的 process.on('exit')
  //     里只有同步代码能跑，异步的 taskkill 会在它完成前就被退出流程掐掉，
  //     于是「后端退出时带走引擎」这条一直是空的。同步那版让退出路径真的有效。
  const killTreeSync = () => {
    if (child.exitCode != null || child.pid == null) return
    if (process.platform !== 'win32') {
      // ⭐ POSIX 上 spawn 的子进程和我们在同一个进程组，kill(pid) 够了；
      //   套 taskkill 反而是错的那个（那边没有这个命令）。
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
      () => resolve())   // ⛔ 失败也 resolve：杀不掉不是调用方的错，别掀翻它
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
