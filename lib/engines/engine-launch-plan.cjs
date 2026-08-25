#!/usr/bin/env node
'use strict'

// ---------------------------------------------------------------------------
//  engine-launch-plan.cjs —— 把「怎么起这台引擎」算成一行 JSON 给启动脚本
// ---------------------------------------------------------------------------
//
// tools/scripts/start.ps1 调它，不是人调它。存在的理由是：启动脚本里不该
// 再有任何一台具体引擎的知识（契约 §9）。
//
// 用法：
//   node lib/engines/engine-launch-plan.cjs --engine gpt-sovits
//   node lib/engines/engine-launch-plan.cjs --engine gpt-sovits --port 9881
//   node lib/engines/engine-launch-plan.cjs --all      ← 停止脚本用：所有引擎
//
// 输出：一行 JSON（stdout）。出错时 stdout 也是一行 JSON（带 error），
// 同时退出码非 0 —— ⭐ 这样 PowerShell 那边 ConvertFrom-Json 永远不会
// 拿到半截东西，错误信息也能被打进 startup.log 而不是消失在 stderr 里。
//
// 退出码：
//   0  算出计划了（launchable 可能是 false —— 那也是一个有效答案：
//      「这台引擎不由平台起」，不是错误）
//   1  算不出来（名片有错、引擎不存在、端口非法……）
//
// ⛔ 这个文件里不许出现任何具体引擎的名字。

const path = require('node:path')
const { resolveEngineProfile } = require('./profile')
const { buildLaunchPlan } = require('./launchPlan')

// ⛔ 不用 process.argv 的方括号索引写法：给 Owner 粘的命令里方括号会被
//    渲染成 markdown 链接。这里是文件不是粘贴的命令，但保持同一套写法，
//    免得哪天被抄进一行 node -e 里。
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

  // --all：把每台引擎的默认监听地址列出来，给 tools/scripts/stop.ps1 用。
  // ⭐ 停止脚本要的是「名片声明的那个端口」（desired_port），不是某次实际
  //   用的端口 —— 它不知道上次有没有挪过。挪走过的那台由 stop.ps1 的第二遍
  //   （按项目目录扫进程）兜底，那一遍本来就比按端口停更强。
  //
  // ⛔ 这里**不抛**：一张名片写坏了不该让整个停止流程停摆。坏的那台
  //   单独标记 ok:false 带着原因返回，好的照常停。停止脚本的可靠性
  //   优先于报错的严谨性 —— 停不掉的进程会锁住文件，比错误信息难看得多。
  if (hasFlag('all')) {
    const { listEngineIds } = require('./registry')
    const engines = []
    for (const id of listEngineIds()) {
      try {
        const plan = buildLaunchPlan(resolveEngineProfile(id), { rootDir })
        if (!plan.launchable) {
          engines.push({ id, ok: true, launchable: false })
          continue
        }
        engines.push({
          id,
          ok: true,
          launchable: true,
          label: plan.label,
          host: plan.host,
          port: plan.desired_port,
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
  const plan = buildLaunchPlan(profile, { rootDir, port })
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
