#!/usr/bin/env node
'use strict'

// ---------------------------------------------------------------------------
//  check-engine-env —— 「这台引擎装没装」，人可以自己问一遍
// ---------------------------------------------------------------------------
//   node tools/dev/check-engine-env.cjs            浅层：只查盘，几毫秒
//   node tools/dev/check-engine-env.cjs --deep     深层：起引擎的解释器去 import
//   node tools/dev/check-engine-env.cjs --deep --engine gpt-sovits
//   node tools/dev/check-engine-env.cjs --json     给脚本吃的
//
// ⭐ 平台只验不建。这个工具**不会**装任何东西、不会改任何文件、不会写盘
//    （深层会在系统临时目录写一个规格 JSON 并当场删掉）。它只回答问题。
//    答案是"没装"的时候，请按引擎作者的说明自己把环境装好 ——
//    Owner 2026-08-24 定案：平台只维护 GPT-SoVITS 那一套环境。
//
// ⚠ 深层很慢（实测某引擎 import 34 秒），因为它真的把引擎的解释器起起来
//   了。别把它接进任何请求路径。

const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const { listEngines } = require(path.join(ROOT, 'lib', 'engines', 'registry'))
const { resolveEngineProfile } = require(path.join(ROOT, 'lib', 'engines', 'profile'))
const { checkEngineEnvShallow, checkEngineEnvDeep } = require(path.join(ROOT, 'lib', 'engines', 'envCheck'))

function parseArgs(argv) {
  const out = { deep: false, json: false, engine: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--deep') out.deep = true
    else if (a === '--json') out.json = true
    else if (a === '--engine') { i += 1; out.engine = argv[i] }
    else if (a === '--help' || a === '-h') out.help = true
    else {
      process.stderr.write(`不认识的参数：${a}\n`)
      out.help = true
    }
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write([
      '用法: node tools/dev/check-engine-env.cjs [--deep] [--engine <id>] [--json]',
      '  --deep    起引擎自己的解释器去 import 名片点名的模块（慢，几十秒）',
      '  --engine  只查这一台',
      '  --json    输出 JSON',
      '',
      '平台只验不建：这个工具不装任何东西，只回答「装没装」。',
      '',
    ].join('\n'))
    return 0
  }

  let manifests
  try {
    manifests = listEngines()
  } catch (err) {
    process.stderr.write(`读引擎目录失败：${err.message}\n`)
    return 2
  }
  if (args.engine) manifests = manifests.filter((m) => m.id === args.engine)
  if (!manifests.length) {
    process.stderr.write(args.engine ? `没有叫 ${args.engine} 的引擎\n` : '一台引擎都没有\n')
    return 2
  }

  const results = []
  for (const m of manifests) {
    let profile
    try {
      profile = resolveEngineProfile(m.id, process.env)
    } catch (err) {
      // 名片本身就读不出来 —— 这比"环境没装"更靠前，要单独报，
      // 否则会被读成"环境有问题"，人就去查环境了。
      results.push({
        id: m.id, ok: false, level: 'manifest', problems: [err.message],
        assets: { ok: null, problems: [] }, info: {},
      })
      continue
    }
    results.push(args.deep
      ? checkEngineEnvDeep(profile, { rootDir: ROOT })
      : checkEngineEnvShallow(profile, { rootDir: ROOT }))
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ root: ROOT, deep: args.deep, results }, null, 2) + '\n')
  } else {
    process.stdout.write(`引擎环境核对（${args.deep ? '深层' : '浅层'}）  项目根: ${ROOT}\n\n`)
    for (const r of results) {
      // ok 有三个值，不是两个：true 装了 / false 没装 / null 无从判断。
      // ⛔ 别把 null 折成 false —— "名片没写 runtime" 和 "环境坏了" 是两回事。
      const mark = r.ok === true ? '  装了  ' : r.ok === null ? ' 无从判断 ' : ' 没装/不全 '
      process.stdout.write(`[${mark}] ${r.id}  (${r.level})\n`)
      if (r.info && r.info.python) {
        process.stdout.write(`           python ${r.info.python.version}  ${r.info.python.executable}\n`)
      }
      for (const p of r.problems) {
        process.stdout.write('           ' + String(p).split('\n').join('\n           ') + '\n')
      }
      // ⭐⭐ 权重单独一行，和「装没装」分开印。
      //   压进上面那个结论会有两个后果，真机上都撞过：人去重装一遍已经
      //   装好的环境；深层校验被浅层挡下，环境到底好不好根本没被问过。
      const a = r.assets || { ok: null, problems: [] }
      if (a.ok === true) {
        process.stdout.write('           权重: 在\n')
      } else if (a.ok === false) {
        process.stdout.write('           权重: 缺（不影响上面那个结论）\n')
        for (const p of a.problems) {
          process.stdout.write('             ' + String(p).split('\n').join('\n             ') + '\n')
        }
      }
      process.stdout.write('\n')
    }
    if (!args.deep) {
      process.stdout.write('浅层只查了文件在不在。要核对模块/类/方法，加 --deep（慢）。\n')
    }
  }

  // 退出码：只有"确定没装"才算失败。无从判断（null）不算 ——
  // 它是一个待补的名片，不是一个坏掉的环境。
  // ⭐ 权重缺**不**进退出码：这个工具回答的是"装没装"，而"环境装好了、
  //   模型还没下"是正常中间状态。要按权重卡 CI，请另读 --json 的 assets。
  return results.some((r) => r.ok === false) ? 1 : 0
}

process.exitCode = main()
