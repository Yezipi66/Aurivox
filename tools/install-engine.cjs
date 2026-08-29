#!/usr/bin/env node
'use strict'

// 契约 §12 第 4 步：安装脚本，按 pin 的 commit 拉上游。
//
//   node tools/install-engine.cjs <engine-id>          先看计划，不动盘
//   node tools/install-engine.cjs <engine-id> --yes    真的装
//
// ⭐ 默认只打印计划。装引擎要下几个 GB、要写盘、要联网，
//    「敲错一个字就开始下载」不是一个好的默认值。
//
// ⛔ 这个工具不判断「装好了没有」。那是三道校验的事，装完它会告诉你去跑哪条。

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const { getEngine, listEngineIds } = require(path.join(ROOT, 'lib/engines/registry'))
const { resolveEngineProfile } = require(path.join(ROOT, 'lib/engines/profile'))
const { buildInstallPlan } = require(path.join(ROOT, 'lib/engines/installPlan'))

function die(msg, code = 1) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n')
  process.exit(code)
}

function main(argv) {
  const args = argv.slice(2)
  const yes = args.includes('--yes')
  const id = args.find((a) => !a.startsWith('-'))

  if (!id) {
    const ids = listEngineIds()
    die('用法：node tools/install-engine.cjs <engine-id> [--yes]\n' +
        (ids.length ? `  这个仓库里有名片的引擎：${ids.join('、')}\n` : '') +
        '  不加 --yes 只打印计划，不动磁盘。')
  }

  if (!getEngine(id)) {
    die(`没有 engines/${id}/manifest.json。\n` +
        '  安装是从名片开始的：先建目录、写名片，再用这个工具拉上游。\n' +
        `  已有名片的：${listEngineIds().join('、') || '（一个都没有）'}`)
  }

  const manifest = getEngine(id)

  let plan
  try {
    // 名片解析和计划构建一起接住：对用的人来说这两件事没有区别，
    // 都是「这张 manifest.json 我读不下去」。⛔ 不把栈追踪甩给他。
    plan = buildInstallPlan(resolveEngineProfile(id), manifest)
  } catch (err) {
    // ⭐ 拒绝安装时要把原因说完整：这里最常见的就是「上游版本没钉住」，
    //    而那不是这个工具能替人决定的事。
    die(`⛔ 装不了 ${id}\n\n${err.message}\n`, 2)
  }

  const targetAbs = path.join(ROOT, plan.dir)
  const occupied = fs.existsSync(path.join(targetAbs, '.git')) ||
    (fs.existsSync(targetAbs) &&
      fs.readdirSync(targetAbs).some((n) => n !== 'manifest.json' && !n.startsWith('_') &&
        !['README.md', 'UPSTREAM.md', 'LOCAL-CHANGES.md', 'smoke'].includes(n)))

  process.stdout.write(
    `安装 ${plan.label}（${plan.id}）\n` +
    `  上游   ${plan.url}\n` +
    `  版本   ${plan.commit}\n` +
    (plan.license ? `  许可证 ${plan.license}\n` : '') +
    `  装到   ${plan.dir}/\n\n`)

  plan.steps.forEach((s, i) => {
    const cmd = s.argv ? s.argv.join(' ') : `删除 ${s.remove}`
    process.stdout.write(
      `  ${i + 1}. ${cmd}\n` +
      `     位置：${s.cwd}\n` +
      `     用途：${s.why}\n` +
      (s.needs_network ? '     ⚠ 这一步要联网，可能要下几个 GB\n' : ''))
  })

  if (occupied) {
    process.stdout.write(
      `\n⚠ ${plan.dir}/ 下已经有上游文件了，看起来这台引擎装过了。\n` +
      '  这个工具不做「覆盖安装」：要重装，先自己把目录清干净，\n' +
      '  只留 manifest.json 和我们自己写的说明文件。\n')
    if (yes) die('\n⛔ 已停手，一个字节没动。', 3)
  }

  if (!yes) {
    process.stdout.write(
      '\n以上只是计划，磁盘没动。真的要装：\n' +
      `  node tools/install-engine.cjs ${plan.id} --yes\n`)
    return 0
  }

  for (const [i, s] of plan.steps.entries()) {
    process.stdout.write(`\n[${i + 1}/${plan.steps.length}] ${s.why}\n`)
    const cwd = path.join(ROOT, s.cwd)

    if (s.kind === 'drop-git') {
      fs.rmSync(path.join(ROOT, s.remove), { recursive: true, force: true })
      process.stdout.write(`    删了 ${s.remove}\n`)
      continue
    }

    const [bin, ...rest] = s.argv
    const r = spawnSync(bin, rest, { cwd, stdio: 'inherit', shell: false })
    if (r.error && r.error.code === 'ENOENT') {
      die(`\n⛔ 找不到命令 ${bin} —— 装引擎需要它，先把它装上再来。`, 4)
    }
    if (r.status !== 0) {
      die(`\n⛔ 第 ${i + 1} 步失败（退出码 ${r.status}）：${s.argv.join(' ')}\n` +
          `  ${plan.dir}/ 现在处于装了一半的状态，重来之前先把它清空。`, 5)
    }
  }

  process.stdout.write(
    `\n✅ ${plan.label} 的源码已就位（${plan.commit.slice(0, 12)}…）\n` +
    '  ⛔ 这只说明「源码和环境到位了」，不等于「能出声」。\n' +
    `  接着跑这条才算装上：${plan.verify_hint}\n`)
  return 0
}

if (require.main === module) process.exit(main(process.argv))
module.exports = { main }
