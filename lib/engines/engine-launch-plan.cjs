#!/usr/bin/env node
'use strict'

// engine-launch-plan.cjs：把「怎么起这台引擎」算成一行 JSON 给启动脚本。
// tools/scripts/start.ps1 调它，不是人调它。存在的理由是：启动脚本里不该再有任何一台
// 具体引擎的知识。
// 用法：node lib/engines/engine-launch-plan.cjs --engine <id> [--port <端口>]
//       node lib/engines/engine-launch-plan.cjs --all      ← 停止脚本用：所有引擎
// 输出：一行 JSON（stdout）。出错时 stdout 也是一行 JSON（带 error），同时退出码非 0：
// 这样 PowerShell 那边 ConvertFrom-Json 永远不会拿到不完整的东西，错误信息也能被打进
// startup.log 而不是消失在 stderr 里。
// 退出码：0 = 算出计划了；1 = 算不出来（名片有错、引擎不存在、端口非法）。
// 这个文件里不许出现任何具体引擎的名字。

const fs = require('node:fs')
const path = require('node:path')
const { resolveEngineProfile } = require('./profile')
const { buildLaunchPlan } = require('./launchPlan')

// 名片解析结果落盘：{profile_json} 这个占位符的另一半。
// 通用宿主 lib/engines/host.py 不读 manifest.json，所以起它之前，平台必须把解析结果
// 落成一个文件，把路径递过去。
// 落盘放在这层 CLI 而不在 launchPlan.js：那边是纯函数，正因为纯所以能被测穷；这层
// 本来就有副作用。落在 cache/ 下：这份文件完全可再生。
function writeHostProfile(id, dest, opts) {
  const { writeHostProfileTo } = require('./hostProfile')
  return writeHostProfileTo(id, dest, opts)
}

// 不用 process.argv 的方括号索引写法：那一套命令被贴进 Markdown 时方括号会被渲染
// 成链接。
function readFlag(name) {
  const argv = process.argv.slice(2)
  const pref = `--${name}=`
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith(pref)) return a.slice(pref.length)
    if (a === `--${name}`) return argv[i + 1]
  }
  return undefined
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`)
}

function main() {
  const rootDir = path.resolve(__dirname, '..', '..')

  // --all：把每台引擎的默认监听地址列出来，给 tools/cli/stop.js 用。停止脚本要的是
  // 「名片声明的那个端口」（desired_port），不是某次实际用的端口：它不知道上次有没有
  // 挪过。挪走过的那台由 stop.js 的第二遍（按项目目录扫进程）兜底。
  if (hasFlag('all')) {
    const { listEngineIds } = require('./registry')
    const engines = []
    for (const id of listEngineIds()) {
      try {
        const plan = buildLaunchPlan(resolveEngineProfile(id), { rootDir })
        // 不可启动的那些也要带上地址：start.ps1 要靠它做端口保护（作者自己起的
        //   引擎照样占着它那个端口）。只回 {id, launchable:false} 的老写法会让
        //   PowerShell 那边拿到 $null，[int]$null = 0，于是拿 0 号端口去问「有人在
        //   听吗」，端口保护对这台静默失效。
        engines.push({
          id,
          ok: true,
          launchable: plan.launchable === true,
          label: plan.label,
          host: plan.host,
          port: plan.desired_port,
          // stdio 的引擎 host / port 都是 null：不监听，没有端口要守。
          transport: plan.transport || 'http',
        })
      } catch (err) {
        engines.push({ id, ok: false, error: err && err.message ? err.message : String(err) })
      }
    }
    return { ok: true, engines }
  }

  const id = readFlag('engine')
  if (!id) {
    return { ok: false, error: '要起哪台引擎？用 --engine <id>。', code: 'ENGINE_ID_MISSING' }
  }

  const rawPort = readFlag('port')
  const port = rawPort === undefined ? undefined : Number(rawPort)

  const profile = resolveEngineProfile(id)

  // 落到哪儿由 buildLaunchPlan 算：「路径怎么算」是纯计算，归那边；「把它写出来」是
  // 副作用，归这里。
  const plan = buildLaunchPlan(profile, { rootDir, port })

  // 顺序要紧：先写文件，再把计划交出去。反过来的话，start.ps1 会拿着一份指向
  // 「还不存在的文件」的命令行去 spawn，宿主开口就是「无法读取解析结果」，而那时
  // 候真正的原因（平台还没来得及写）已经看不见了。
  if (plan.profile_json_path) {
    const bytes = writeHostProfile(id, plan.profile_json_path)
    plan.profile_json_bytes = bytes
  }

  return Object.assign({ ok: true }, plan)
}

let payload
let exitCode = 0
try {
  payload = main()
  if (payload.ok === false) exitCode = 1
} catch (err) {
  payload = {
    ok: false,
    code: err && err.code ? err.code : 'ENGINE_LAUNCH_PLAN_FAILED',
    error: err && err.message ? err.message : String(err),
  }
  exitCode = 1
}

process.stdout.write(JSON.stringify(payload) + '\n')
process.exit(exitCode)
