// =============================================================================
//  start.js — 启动编排器（跨平台主体）
//  取代 tools\scripts\start.ps1（547 行 PowerShell）。
//
//  - 项目根靠**上溯找持有 package.json 的那一层**定位，不数目录层级。
//  - 优先用仓库自带的可移植 Node（tools\runtime\node\node.exe），没有就退回 PATH。
//  - 用部署好的 venv Python（由 lib/engines/platformPaths.js 按平台推导）。
//  - 前端随包发布已构建好（web\dist）；只在 dist 缺失时才兜底构建。
//
//  ⚠️⚠️ 关于「起哪台引擎、拿什么起」：全部问 lib/engines/engine-launch-plan.cjs，
//     这里**不写任何一台具体引擎的知识**。搬家前这个脚本里躺着五个 $ENGINE_*
//     变量，全是 GPT-SoVITS 专有的（解释器、入口、配置文件、监听地址）——
//     那等于一份写在启动脚本里的、谁也改不了的 manifest.json。
//     第三台引擎的作者会发现 manifest.json 写完了引擎还是起不来，因为得改
//     这个文件 —— 而那正是「加一台引擎不碰 lib/」这条标准要挡住的事。
//
//  ⚠️ 而端口那 90 行搬到了 lib/system/portChoice.js，**逐条保留**（那里记着
//     每条判据的来历）。这里只负责把结果接到环境变量与命令行上。
// =============================================================================

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const P = require(path.join(ROOT, 'lib', 'system', 'ports.js'))
const PC = require(path.join(ROOT, 'lib', 'system', 'portChoice.js'))

const IS_WIN = process.platform === 'win32'
const DRY = process.argv.includes('--dry-run')

// ── 输出：既进终端也进 logs\startup.log ─────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const COL = { Cyan: 36, Gray: 90, Yellow: 33, Green: 32, Red: 31, DarkGray: 90 }

const LogDir = path.join(ROOT, 'logs')
const StartupLog = path.join(LogDir, 'startup.log')

function Log (msg, colorName = 'Gray') {
  const ts = new Date().toTimeString().slice(0, 8)
  const line = `[${ts}] ${msg}`
  const code = COL[colorName] || COL.Gray
  console.log(useColor ? `\x1b[${code}m${line}\x1b[0m` : line)
  try {
    fs.mkdirSync(LogDir, { recursive: true })
    fs.appendFileSync(StartupLog, line + '\n', 'utf8')
  } catch (_) { /* 日志写不进去不该拦住启动 */ }
}

function WarnBox (lines, colorName = 'Yellow') {
  Log('', colorName)
  for (const l of lines) Log(l, colorName)
}

// =============================================================================
async function main () {
  //  0. 准备
  // =============================================================================

  // ⚠️ 非 ASCII 安装路径：**警告，不拒绝**。
  //   非英文路径在某些 Windows 配置下经由传统 GBK 控制台起子进程时会被
  //   弄成 `D:\??\`，那会让引擎/后端起不来。
  //   下面给所有子进程强制了 PYTHONUTF8 / UTF-8，而现代 Windows 一般能处理
  //   Unicode 路径 ⇒ 这是非致命警告，由用户自己决定要不要搬到纯英文路径。
  {
    const bad = [...ROOT].filter(c => c.charCodeAt(0) > 127)
    if (bad.length) {
      WarnBox([
        '============================================================',
        '[start][WARN] 安装路径里有非 ASCII 字符。',
        `  path : ${ROOT}`,
        `  bad  : ${bad.join(' ')}`,
        '  非英文路径在部分 Windows 配置下可能让 Python / ffmpeg 起不来。',
        '  若后端或推理引擎起不来，把**整个目录**挪到纯英文路径（例如 D:\\TTS-Broker）再跑。',
        '  继续启动 ...',
        '============================================================',
      ], 'Yellow')
    }
  }

  // 强制所有子进程（后端 server.js、引擎、以及它们再起的）用 UTF-8。
  // 否则中文 Windows 的 GBK 控制台在引擎打出非 GBK 字符（如 U+FFFD）时抛
  // UnicodeEncodeError ⇒ /v1/audio/speech 直接 502。
  process.env.PYTHONUTF8 = '1'
  process.env.PYTHONIOENCODING = 'utf-8'
  process.env.PYTHONUNBUFFERED = '1'

  // ── Node：优先仓库自带 ────────────────────────────────────────────────────
  const BUNDLED_NODE = path.join(ROOT, 'tools', 'runtime', 'node',
    IS_WIN ? 'node.exe' : 'node')
  const BUNDLED_NPM = path.join(ROOT, 'tools', 'runtime', 'node',
    IS_WIN ? 'npm.cmd' : 'npm')
  let NODE = 'node'
  let NPM = 'npm'
  if (fs.existsSync(BUNDLED_NODE)) {
    NODE = BUNDLED_NODE
    NPM = BUNDLED_NPM
    // ⭐ 自带的 node 目录要排在 PATH 最前，否则它起的 npm/node 子进程解析不到。
    const dir = path.dirname(BUNDLED_NODE)
    process.env.PATH = dir + path.delimiter + process.env.PATH
  }

  const BACKEND_PORT = 9886
  const BACKEND_WAIT = 30

  try {
    fs.mkdirSync(LogDir, { recursive: true })
    fs.writeFileSync(StartupLog,
      `==== TTS Broker startup @ ${new Date().toISOString()} ====\n`, 'utf8')
  } catch (_) {}

  Log('==================== TTS Broker Startup ====================', 'Cyan')
  Log(`root : ${ROOT}`, 'DarkGray')
  Log(`node : ${NODE}`, 'DarkGray')

  // =============================================================================
  //  1. 问 manifest.json：起哪几台
  // =============================================================================
  //   $ENGINE_IDS   逗号分隔的 id 列表，例：gpt-sovits,indextts2
  //   $ENGINE_ID    单台（老写法，继续认；两个都设时 ENGINE_IDS 说了算）
  //   两个都不设     = engines\ 下装了的每一台
  //
  // ⭐ 默认起全部，是为了让「加一台引擎 = 克隆上游 + 写一张 manifest.json +
  //   一行代码都不写」这句话真的成立：默认值一旦写死某个 id，第三台引擎的
  //   作者就得改这个文件，那就又是一行代码。
  // ⛔ 不限制同时起几台，也不在这里判断显存够不够 —— 装了几台是用户的决定，
  //   这个脚本没有资格替他删掉一台。
  const CLI = path.join(ROOT, 'lib', 'engines', 'engine-launch-plan.cjs')

  function askPlan (args) {
    const r = spawnSync(NODE, [CLI].concat(args), { encoding: 'utf8', timeout: 60000 })
    if (r.status !== 0) {
      return { ok: false, why: ((r.stdout || '') + (r.stderr || '')).trim() }
    }
    try { return { ok: true, data: JSON.parse((r.stdout || '').trim()) } }
    catch (e) { return { ok: false, why: '不是合法 JSON: ' + (e.message || '') } }
  }

  function allEngineIds () {
    const r = askPlan(['--all'])
    if (!r.ok) { Log(`[engine][ERROR] 列不出装了哪些引擎: ${r.why}`, 'Red'); return [] }
    const ids = []
    for (const e of (r.data.engines || [])) {
      if (e.ok) ids.push(String(e.id))
      else Log(`[engine][WARN] ${e.id} 的 manifest.json 读不出来，跳过：${e.error}`, 'Yellow')
    }
    return ids
  }

  /**
   * 问一次 manifest.json。给了 port 就按它算命令行，不给就用名片声明的默认端口。
   * ⚠️ 纯函数、无副作用 —— 可以放心问两次：第一次拿期望端口去解冲突，
   *   解完带着定下来的端口再问一次要最终命令行。
   */
  function enginePlan (id, port) {
    const args = ['--engine', id]
    if (port > 0) args.push('--port', String(port))
    const r = askPlan(args)
    if (!r.ok) { Log(`[engine][ERROR] 算不出 ${id} 的启动计划: ${r.why}`, 'Red'); return null }
    return r.data
  }

  let engineIds = []
  if (process.env.ENGINE_IDS) {
    engineIds = process.env.ENGINE_IDS.split(',').map(s => s.trim()).filter(Boolean)
  } else if (process.env.ENGINE_ID) {
    engineIds = [process.env.ENGINE_ID.trim()]
  } else {
    engineIds = allEngineIds()
  }
  if (engineIds.length === 0) {
    Log('[engine][ERROR] 一台引擎都没有：engines\\ 下没有读得出来的 manifest.json。', 'Red')
    process.exit(1)
  }
  Log(`[engine] 本次要起 ${engineIds.length} 台：${engineIds.join(', ')}`, 'DarkGray')

  // 每台一份记录：Id / Plan / 端口结论 / 跳不跳过
  const ENGINES = []
  for (const eid of engineIds) {
    const plan0 = enginePlan(eid, 0)
    if (plan0 === null) {
      // ⛔ 这里**不 exit**：一台算不出计划，不该把后端和别的引擎一起拖下水。
      Log(`[engine][ERROR] ${eid}: 拿不到启动计划，跳过这一台。`, 'Red')
      continue
    }
    const rec = {
      Id: eid,
      Label: String(plan0.label || ''),
      Launchable: plan0.launchable === true,
      Mark: String(plan0.own_process_mark || ''),
      BaseUrlEnv: String(plan0.base_url_env || ''),
      EHost: String(plan0.host || '127.0.0.1'),
      DesiredPort: Number(plan0.desired_port) || 0,
      Port: Number(plan0.desired_port) || 0,
      Action: 'free',
      OwnerPid: null,
      Skip: false,
      SkipReason: '',
      // ⭐⭐⭐ 开机到底点不点着它。
      //   以前没有这个概念：engines\ 下装了几台就起几台。而其中一台
      //   **一起进程就吃掉约 6G 内存**（一个字都还没合成）。装到第四台，
      //   开机就是四份内存一起吃 —— 而用户这一开机可能一台都没用上。
      //   现在这个答案由平台从名片**推**出来（见 lib\engines\residency.js）：
      //   那台引擎的模型如果是「开进程那一步吃进去」的，起着就等于占着内存，
      //   放掉真能吐出来 ⇒ 开机不点，第一次真有人要它的时候后端自己去起。
      //   ⛔ 脚本这一侧**不做判断**，只读计划里的这个答案。判据在哪台引擎
      //     身上、怎么推出来的，都不是启动脚本该知道的事（契约 §9）。
      Preload: plan0.preload === true,
      OnDemand: plan0.on_demand === true,
    }
    if (rec.Launchable) {
      // ⚠️ 不能查死一个 venv 路径：第三台引擎完全可能用别的解释器
      //   （自己的 venv、conda、系统 python）。查死一个路径等于规定
      //   所有引擎必须共用一个 venv —— 那条规定从来没人同意过，
      //   只是写在了那一行里。路径由名片给出（plan.python）。
      //   ⛔ 别在这儿再套一层 venvPython()：plan.python **已经是**可执行文件本身
      //     （launch-plan 由 lib/engines/platformPaths.js 推导过），
      //     拿它的 dirname 再套一次会得到一个更短、几乎必然不存在的路径。
      if (!plan0.python || !fs.existsSync(plan0.python)) {
        Log(`[engine][ERROR] ${eid} 的解释器不存在: ${plan0.python}`, 'Red')
        Log('              这台引擎还没部署（跑一次首次部署）。跳过它，其余照常起。', 'Red')
        rec.Skip = true
        rec.SkipReason = '解释器不存在'
      }
    } else {
      // 名片没写 runtime = 这台引擎由作者自己起。不是错误，但要说出来，
      // 否则后面「引擎没上线」会看着像 bug。
      Log(`[engine] ${eid} 不由平台启动（manifest.json 没有 runtime 段），只替它守住端口。`, 'Yellow')
    }
    ENGINES.push(rec)
  }
  if (ENGINES.length === 0) {
    Log('[engine][ERROR] 每一台引擎都拿不到启动计划，无法继续。', 'Red')
    process.exit(1)
  }

  // =============================================================================
  //  2. 前端：随包已构建，只在 dist 缺失时兜底构建
  // =============================================================================
  const webDir = path.join(ROOT, 'web')
  const distIdx = path.join(webDir, 'dist', 'index.html')
  const distAssets = path.join(webDir, 'dist', 'assets')

  if (!fs.existsSync(distIdx) || !fs.existsSync(distAssets)) {
    Log('[build] web\\dist missing -> attempting fallback build (needs bundled node).', 'Yellow')
    if (DRY) {
      Log('        (--dry-run：跳过构建)', 'DarkGray')
    } else {
      const hasNodeModules = fs.existsSync(path.join(webDir, 'node_modules'))
      const args = hasNodeModules ? ['run', 'build'] : ['install'].concat(['run', 'build'])
      const r = spawnSync(NPM, args, {
        cwd: webDir, stdio: 'inherit', shell: IS_WIN, timeout: 15 * 60 * 1000,
      })
      if (fs.existsSync(distAssets)) Log('[build] fallback build finished [OK]', 'Green')
      else Log('[build][WARN] fallback build failed (exit ' + r.status + ').', 'Red')
    }
  } else {
    Log('[build] web\\dist present (shipped pre-built). Skip build.', 'Green')
  }

  // =============================================================================
  //  3. ⭐ 先把所有端口定下来，再启动任何东西
  // =============================================================================
  // 必须排在最前面：后端从这里继承环境变量，spawn 之后再改就晚了。
  // 某个端口被占、挪走之后，整条链上的人要对得上同一个新号码：
  //   * 引擎  : 命令行上收到 -p <port>；后端通过它那个 base_url_env 找到它
  //     ⛔ 变量名不写死成 GPT_SOVITS_BASE_URL —— 每台引擎在自己的名片里写
  //       base_url_env，写死一个名字，第二台引擎起来后端也连不上。
  //   * 后端  : 读 BROKER_PORT；浏览器打开挪之后的那个端口。
  //   * 前端  : 由后端**同源**伺服（web\dist，前端 API_BASE='' 走相对路径），
  //             所以后端端口挪了**不用**往前端注入任何东西。
  //
  // ⭐ 端口保护对**不可启动**的引擎同样生效：作者自己起的引擎照样占着它那个
  //   端口，别的程序就不该占它。所以 host/port 这几样，计划在不可启动时也给。
  for (const e of ENGINES) {
    Log(`[engine] ${e.Id} (${e.Label}) 期望监听 ${e.EHost}:${e.DesiredPort}`, 'DarkGray')
  }

  // 本次已经许出去的端口。⛔ 必须一路带着：两台引擎默认端口撞车时，
  // 光问「现在有没有人在听」是分不出来的（谁都还没开始听）。
  const claimed = []
  const allMarks = ENGINES.filter(e => e.Mark).map(e => e.Mark)

  const portResults = []
  P.clearProcsCache()
  for (const e of ENGINES) {
    // ⭐ 只传这一台自己的记号 —— 理由见 portChoice.js 里 testIsOwnProcess 的那段。
    const r = PC.resolvePort('engine ' + e.Id, e.DesiredPort, ROOT,
      { marks: e.Mark ? [e.Mark] : [], exclude: claimed })
    e.Port = r.port
    e.Action = r.action
    e.OwnerPid = r.ownerPid
    claimed.push(r.port)
    portResults.push(r)
  }
  // backend 这一次**照旧**把所有引擎记号都传进来，与改动前一致。
  const backendRes = PC.resolvePort('backend', BACKEND_PORT, ROOT,
    { marks: allMarks, exclude: claimed })
  portResults.push(backendRes)

  let exhausted = false
  for (const r of portResults) {
    const col = r.action === 'free' ? 'DarkGray'
      : r.action === 'exhausted' ? 'Red' : 'Yellow'
    Log('[port] ' + PC.describe(r), col)
    if (r.action === 'exhausted') exhausted = true
  }
  if (exhausted) process.exit(1)
  const backendPortFinal = backendRes.port

  // 把定下来的端口经环境变量接到整条链上
  process.env.BROKER_PORT = String(backendPortFinal)
  Log(`[port] backend -> ${backendPortFinal}  (BROKER_PORT=${process.env.BROKER_PORT})`, 'DarkGray')
  for (const e of ENGINES) {
    const url = `http://${e.EHost}:${e.Port}`
    if (e.BaseUrlEnv) {
      process.env[e.BaseUrlEnv] = url
      Log(`[port] ${e.Id} -> ${e.Port}  (${e.BaseUrlEnv}=${url})`, 'DarkGray')
    } else {
      Log(`[port] ${e.Id} -> ${e.Port}`, 'DarkGray')
      if (e.Port !== e.DesiredPort) {
        Log(`[port][WARN] ${e.Id} 的 manifest.json 没有 base_url_env，而它的端口从 ${e.DesiredPort} 挪到了 ${e.Port}。`, 'Red')
        Log(`             后端仍然会去连 ${e.DesiredPort}，发给这台引擎的合成会失败。`, 'Red')
        Log(`             修法：在 engines\\${e.Id}\\manifest.json 里加一行 "base_url_env"。`, 'Red')
      }
    }
  }

  if (DRY) {
    Log('========================================', 'Cyan')
    Log('(--dry-run：端口已解完，一个进程都没起)', 'Yellow')
    Log('========================================', 'Cyan')
    process.exit(0)
  }

  // =============================================================================
  //  4. 后端
  // =============================================================================
  Log(`[1/2] Backend server.js on port ${backendPortFinal} ...`, 'Green')
  if (backendRes.action === 'own') {
    Log(`      Port ${backendPortFinal} already held by OUR backend. Treat backend as running.`, 'Yellow')
  } else {
    const r = P.spawnDetached(NODE, ['server.js'], {
      cwd: ROOT,
      outFile: path.join(LogDir, 'backend.log'),
      errFile: path.join(LogDir, 'backend.err.log'),
      env: process.env,
    })
    if (!r.ok) Log('      [ERROR] backend 起不来: ' + r.why, 'Red')
    else Log(`      Backend started in background (pid ${r.pid}). Waiting up to ${BACKEND_WAIT}s ...`, 'Gray')
  }

  const backendUrl = `http://127.0.0.1:${backendPortFinal}/`
  let ready = false
  for (let i = 0; i < BACKEND_WAIT; i++) {
    await P.sleep(1000)
    if (await P.httpReady(backendUrl, 2000)) { ready = true; break }
  }
  if (ready) Log('      Backend ready [OK]. Opening browser.', 'Green')
  else Log(`      [WARN] Backend not ready in ${BACKEND_WAIT}s. Opening browser anyway. See logs\\backend*.log.`, 'Yellow')
  P.openUrl(backendUrl)

  // 引擎自己的活动配置（tts_infer.yaml）由引擎自己自检自修。
  // 这里原先有一个 76 行的 Repair-EngineConfig：逐行读 yaml、挑出路径值、
  // 发现被 GBK 控制台写坏的问号或指向已不存在位置的旧路径就备份重建。
  // 它是 GPT-SoVITS 独有的收拾工作，已搬进 lib/inference/config_repair.py，
  // 由 lib/inference/infer_server.py 启动时调用 —— 谁起这个进程都一样修。
  // ⛔ 别把它搬回来：平台已改成按 manifest.json 起引擎，启动脚本里不该再有引擎特例。

  // =============================================================================
  //  5. 推理引擎 —— 逐台起
  // =============================================================================
  // ⚠ 日志文件名一台一份：logs\<id>.log / logs\<id>.err.log。
  //   起两台之后 logs\inference.log 这个名字答不了「这是哪台的日志」，
  //   两台还会同时往同一个文件里写。
  const total = ENGINES.length
  let idx = 0
  for (const e of ENGINES) {
    idx += 1
    Log(`[2/2] 引擎 ${idx}/${total}: ${e.Id} on port ${e.Port} ...`, 'Green')
    if (e.Skip) { Log(`      跳过这一台：${e.SkipReason}。其余照常。`, 'Red'); continue }
    if (!e.Launchable) { Log('      这台由作者自己起，平台只替它守住端口。', 'Yellow'); continue }

    // ⭐⭐ 按需档：现在不起它，等到第一次真有人要它的时候后端再起。
    //   ⚠ 端口仍然是**这里**定的（上面 resolvePort 已经跑过，结果写进了
    //     这台引擎自己的 base_url_env）。后端起它的时候用的就是这个端口，
    //     两边不会打架。
    //   ⚠ 已经在跑的情况（Action='own'，上次留下的进程还听着）由下面那个分支管，
    //     这里的 continue 不会把它误伤 —— 顺序不能反。
    if (e.Action !== 'own' && !e.Preload) {
      Log('      不预先启动：这台引擎的模型是开进程那一刻吃进内存的，起着就一直占着。', 'Yellow')
      Log('      第一次用到它的时候后端会自己起（首次要等它加载，界面上会显示进度）。', 'DarkGray')
      continue
    }
    if (e.Action === 'own') {
      Log(`      Port ${e.Port} already held by OUR engine. Treat engine as running.`, 'Yellow')
      continue
    }
    // 端口可能被挪过，所以带着定下来的那个再问一次完整计划 ——
    // ⛔ 别用上面那份计划的 args：那里面的 -p 还是名片上的旧端口，
    //   引擎会听在没人连的地方，表现成「引擎永远不上线」。
    const plan = enginePlan(e.Id, e.Port)
    let ok = plan !== null && plan.launchable
    if (ok && !fs.existsSync(plan.python)) {
      Log(`      [ERROR] 引擎解释器不存在: ${plan.python}`, 'Red'); ok = false
    }
    if (ok && !fs.existsSync(plan.entry)) {
      Log(`      [ERROR] 引擎入口不存在: ${plan.entry}`, 'Red'); ok = false
    }
    if (ok) {
      // 入口在最前，其余参数由名片给出（args 里的 {host}/{port} 已展开）
      const engineArgs = [plan.entry].concat(plan.args || [])
      Log(`      cmd : ${plan.python} ${engineArgs.join(' ')}`, 'DarkGray')
      Log(`      cwd : ${plan.cwd}`, 'DarkGray')
      const r = P.spawnDetached(plan.python, engineArgs, {
        cwd: plan.cwd,
        outFile: path.join(LogDir, `${e.Id}.log`),
        errFile: path.join(LogDir, `${e.Id}.err.log`),
        env: process.env,
      })
      if (!r.ok) Log('      [ERROR] 引擎起不来: ' + r.why, 'Red')
      else Log('      Inference service started in background.', 'Gray')
      // ⚠ 启动脚本**不等**引擎加载完 —— 它起完就走。判断这台引擎上没上线的
      //   是后端：/api/engines 与 /api/health 会去请求下面这个地址。
      //   冷启动几十秒很正常，那段时间里它显示成不在线不是故障。
      Log(`      上线检查地址 ${plan.ready_url}；冷启动预算 ${Math.round((plan.ready_timeout_ms || 0) / 1000)} 秒（本脚本不等它，看后端 /api/health）。`, 'DarkGray')
      Log(`      加载进度看 logs\\${e.Id}.log / logs\\${e.Id}.err.log`, 'DarkGray')
    }
  }

  // =============================================================================
  //  6. 收尾
  // =============================================================================
  Log('========================================', 'Cyan')
  Log(`  UI      : http://127.0.0.1:${backendPortFinal}  opened in browser`, 'Yellow')
  Log(`  Backend : http://127.0.0.1:${backendPortFinal}  logs\\backend.log`, 'DarkGray')
  for (const e of ENGINES) {
    if (e.Skip) Log(`  Engine  : ${e.Id.padEnd(14)} 没起（${e.SkipReason}）`, 'Red')
    else if (!e.Launchable) Log(`  Engine  : ${e.Id.padEnd(14)} http://${e.EHost}:${e.Port}  由作者自己起`, 'Yellow')
    else if (!e.Preload && e.Action !== 'own') Log(`  Engine  : ${e.Id.padEnd(14)} http://${e.EHost}:${e.Port}  用到才起（端口已守住）`, 'Yellow')
    else Log(`  Engine  : ${e.Id.padEnd(14)} http://${e.EHost}:${e.Port}  logs\\${e.Id}.log`, 'DarkGray')
  }
  Log('  Launcher will exit. Backend and inference stay running in background.', 'Cyan')
  Log('========================================', 'Cyan')
}

// ⭐ 顶层 await 与 require 不能共存（ERR_AMBIGUOUS_MODULE_SYNTAX），
//   所以整个主体在 main() 里跑。
main().catch(e => {
  console.error('[start][ERROR] ' + (e && e.stack ? e.stack : e))
  process.exit(1)
})
