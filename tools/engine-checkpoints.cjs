#!/usr/bin/env node
'use strict'

// ============================================================================
//  底模核对 —— 「这台引擎的权重齐不齐、该去哪儿下」
//
//    node tools/engine-checkpoints.cjs                    全部在册引擎
//    node tools/engine-checkpoints.cjs <engine-id>        只看一台
//    node tools/engine-checkpoints.cjs --json             给脚本吃
//
// ============================================================================
//  ⭐ 为什么这个工具还在，而它的前身 install-engine.cjs 没了
//
//  2026-10-04 Owner 裁决：`lib/engines/installPlan.js` **整体退役**。
//  理由不是「顺序排错了」，是它的**前提被证伪** ——
//
//    「安装的前提是『名片已经写好了』，也就是 manifest.json
//      已经躺在目标目录里 —— 而 git clone 拒绝拉进一个非空目录。」
//
//  那个前提要求**先有名片再克隆**。而项目自己的工具证明它反了：
//  · `tools/scaffold-params.cjs` 要在**引擎自己的解释器里**反射 __init__，
//    源码和环境都还没到手 ⇒ 手册第 2 步需要第 3 步的产物；
//  · `upstream.commit` 在「先有名片」的顺序里**不可得**（要先知道 sha，
//    而 sha 在上游仓库里）—— 实证：gpt-sovits 至今 `commit: null`，
//    于是在旧流程下**它今天装不了**；
//  · 而 `init` + `remote add` + `fetch` 这三步存在的**唯一理由**
//    就是绕开「clone 不进非空目录」。克隆先做 ⇒ 理由消失 ⇒ 三步全是死代码。
//
//  ⇒ 前身 `tools/install-engine.cjs` 劈成两半：
//     · 安装那半（依赖 buildInstallPlan）—— 随 installPlan.js 一起退役。
//       ⛔ 拉源码现在由 `tools/engine-wizard/core/clone.js` 负责（顺序在前、
//         目录必须空），建环境由 `core/env.js` 负责。
//     · **底模这一半 —— 就是本文件** —— 与安装计划无关，逻辑独立，
//         依赖 `lib/engines/checkpoints.js`（那个模块仍然活着）。保留。
//
// ⛔ 本工具**不下模型**。它只把名片说的话搬出来：该放哪、缺什么、
//   名片给的取回命令长什么样。不下的理由不是懒：下模型要联网、要几个 GB、
//   有的还要先去网站点同意，把它塞进「装源码」那一步，失败之后
//   没人说得清是哪一半没成。
// ============================================================================

const path = require('path')
const { getEngine, listEngineIds } = require(path.join(__dirname, '..', 'lib/engines/registry'))
const { resolveEngineProfile } = require(path.join(__dirname, '..', 'lib/engines/profile'))
const { checkpointStatus } = require(path.join(__dirname, '..', 'lib/engines/checkpoints'))

function die (msg, code = 1) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n')
  process.exit(code)
}

/**
 * 打印一台引擎的底模状态。
 *
 * ⚠ 三态是真的三态：**不在** / **齐** / **说不出来**（`null`）。
 * 「说不出来」≠「缺」—— 那是「名片没写 runtime.checkpoints 或 models.required，
 * 平台无从判断」，两件事的处置完全不同，压成一个词就会误导人。
 */
function reportOne (profile, out = process.stdout) {
  let st
  try {
    st = checkpointStatus(profile)
  } catch (err) {
    out.write(`\n⚠ 底模状态查不了：${(err && err.message) || err}\n`)
    return null
  }

  out.write(`\n底模（权重）· ${st.id}\n`)

  if (!st.declared) {
    // ⛔ 不写 ≠ 不需要。这里只能说「我不知道」，并且把该补的那一行指出来。
    out.write(
      `  ？ ${st.reason}\n` +
      `     要让平台替你查，在 engines/${st.id}/manifest.json 里补一行\n` +
      '     runtime.checkpoints（相对项目根的目录），再写一段 models.required。\n')
    return st
  }

  const mark = st.ready === true ? '✅' : st.ready === null ? '？' : '⛔'
  out.write(
    `  ${mark} 位置 ${st.abs_path}\n` +
    `     来源 ${st.path_source === 'manifest' ? 'manifest.json 的 runtime.checkpoints' : st.path_source}\n`)
  if (st.reason) out.write(`     ${st.reason}\n`)

  if (st.ready === true) {
    out.write('     ⛔ 齐了不等于「能出声」—— 那要跑三道校验里的第三道：\n' +
      `        node tools/verify-engine.cjs --engine ${st.id} --level A --request req.json\n`)
    return st
  }

  if (st.hint) out.write(`\n  名片给的说明：${st.hint}\n`)
  if (st.source && st.source.license_gate) {
    out.write(
      '\n  ⚠ 这个模型要**先去网站上点同意**才能下。\n' +
      '     不点就下，会得到 401/403 —— 那看着像网络故障，其实不是。\n')
  }
  if (st.source && st.source.url) out.write(`  模型主页：${st.source.url}\n`)
  if (st.source && st.source.command) {
    out.write('\n  名片写的取回命令（⛔ 本工具不替你跑，请自己在引擎环境里执行）：\n')
    out.write(`     位置：${st.source.cwd}\n`)
    out.write(`     ${st.source.command.join(' ')}\n`)
  } else {
    out.write('\n  这张名片没写取回命令 —— 按上面的说明手动放，放完再回来跑一次这个工具就能复核。\n')
  }
  return st
}

function main (argv) {
  const args = argv.slice(2)
  const asJson = args.includes('--json')
  const ids = args.filter((a) => !a.startsWith('-'))

  const known = listEngineIds()
  let targets = known
  if (ids.length) {
    targets = ids
    for (const id of ids) {
      if (!getEngine(id)) {
        die(`没有 engines/${id}/manifest.json。\n` +
            `  已有名片的：${known.join('、') || '（一个都没有）'}`)
      }
    }
  }

  const rows = []
  for (const id of targets) {
    // ⛔ 名片解析失败要单独报：这比「权重没下」靠前得多，
    //   压成同一句话会让人去查错的东西（下面这条就是从 install-engine.cjs 继承的）
    let profile
    try {
      profile = resolveEngineProfile(id)
    } catch (err) {
      if (asJson) { rows.push({ id, error: String((err && err.message) || err) }); continue }
      process.stdout.write(`\n⛔ ${id} 的 manifest.json 读不下去：${(err && err.message) || err}\n`)
      continue
    }
    if (asJson) rows.push(reportOne(profile, { write () {} }) || null)
    else reportOne(profile)
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ root: path.resolve(__dirname, '..'), results: rows }, null, 2) + '\n')
  }

  if (!targets.length) {
    die('这个仓库里一台引擎都没有（engines/ 下没有 manifest.json）。')
  }
  return 0
}

if (require.main === module) process.exit(main(process.argv))
module.exports = { main, reportOne }
