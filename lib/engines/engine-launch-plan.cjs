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

const fs = require('node:fs')
const path = require('node:path')
const { resolveEngineProfile } = require('./profile')
const { buildLaunchPlan } = require('./launchPlan')

// ---------------------------------------------------------------------------
//  ⭐⭐ 名片解析结果落盘 —— {profile_json} 这个占位符的另一半
// ---------------------------------------------------------------------------
//
// 通用宿主 lib/engines/host.py 不读 manifest.json（它自己的 FATAL 里写着
// 理由：「名片语义只有 lib/engines/profile.js 一个实现，写两遍迟早分叉」）。
// 所以起它之前，平台必须把解析结果落成一个文件，把路径递过去。
//
// ⭐ 为什么落在这个文件里，而不是 launchPlan.js：那边是纯函数（名片进、
//   计划出，不 spawn 不读环境不写盘），正因为纯所以能被测穷。写盘是副作用,
//   放在这层 CLI 里 —— 它本来就有副作用（读注册表、写 stdout、定退出码）。
//
// ⭐ 落在 cache/ 下：这份文件**完全可再生**（删了下次启动自动重算），
//   正是 docs/ROOT_LAYOUT.md 给 cache/ 的定义。⛔ 不要落进 outputs/ ——
//   那是给用户看的产物，不是平台的中间件。
function writeHostProfile(id, dest) {
  const { buildHostProfile } = require('./hostProfile')
  // ⛔ 解析失败要**原样**抛出去：hostProfile.js 的报错是点名的
  //   （哪个引擎、哪个字段、为什么）。在这里包一层「写文件失败」会把
  //   唯一有用的那句话盖掉。
  const profile = buildHostProfile(id)
  const text = JSON.stringify(profile, null, 2) + '\n'
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, text, 'utf8')
  return Buffer.byteLength(text)
}

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
        // ⭐ 不可启动的那些**也要带上地址**：start.ps1 要靠它做端口保护
        //   （作者自己起的引擎照样占着它那个端口，别的程序不该抢）。
        //   ⛔ 只回 {id, launchable:false} 的老写法会让 PowerShell 那边拿到
        //     $null，[int]$null = 0，于是拿 0 号端口去问「有人在听吗」——
        //     永远没有，端口保护对这台**静默失效**。
        //   ⚠ stop.ps1 只挑 launchable 的停，多出来的字段它不看，行为不变。
        engines.push({
          id,
          ok: true,
          launchable: plan.launchable === true,
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

  // ⭐ 落到哪儿由 buildLaunchPlan 算（<root>/cache/engines/<id>.profile.json）——
  //   「路径怎么算」是纯计算，归那边；「把它写出来」是副作用，归这里。
  //   一台引擎一个固定文件名，不带时间戳：带时间戳会在 cache/ 里堆垃圾，
  //   而且「上次用的是哪份」说不清。固定名 ⇒ 盘上那份永远是最近一次启动
  //   真正用的那份。
  const plan = buildLaunchPlan(profile, { rootDir, port })

  // ⭐⭐ 顺序要紧：**先写文件，再把计划交出去**。
  //   反过来的话，start.ps1 会拿着一份指向「还不存在的文件」的命令行去
  //   spawn，宿主开口就是「读不了解析结果」—— 而那时候真正的原因
  //   （平台还没来得及写）已经看不见了。
  //   ⚠ 这里**不 try**：写不出来就该让整条启动路径带着原因失败。
  //     写不出来还照常返回计划 = 造一个必然失败且报错指向别处的启动。
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
