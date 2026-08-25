#!/usr/bin/env node
'use strict'

// ---------------------------------------------------------------------------
//  突变验证：第 2c 步的守卫是不是真能红
// ---------------------------------------------------------------------------
//
// 做法：逐条把产品代码/名片改坏一处，跑测试，要求**变红**。GREEN 就说明那条
// 守卫是摆设 —— 靠 review 是看不出这件事的（见记忆里那五种摆设写法）。
//
// ⛔ 铁律三条，每次都要遵守：
//   1. 先跑基线，基线不绿就别开始（红的东西证明不了任何事）。
//   2. 每条突变的锚点必须先 grep 读实 —— 锚点没命中要当**失败**报，
//      不能当"跳过"，否则代码改了之后突变会静默失效。
//   3. GREEN 的时候先怀疑突变本身写坏了，再怀疑守卫。
//
// 用法：node tools/dev/mutate_launch_plan.cjs

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')

const PLAN = 'lib/engines/launchPlan.js'
const CLI = 'lib/engines/engine-launch-plan.cjs'
const PROFILE = 'lib/engines/profile.js'
const GSV = 'engines/gpt-sovits/manifest.json'
const IDX = 'engines/indextts2/manifest.json'

const TESTS = [
  'lib/engines/launchPlan.node.test.js',
  'lib/engines/realManifests.node.test.js',
  'lib/engines/profile.node.test.js',
  'lib/engines/envCheck.node.test.js',
]

// --- 突变表 ----------------------------------------------------------------
// find 是**读实过的原文**（下面会逐条 grep 校验）；replace 是改坏之后的样子。
const MUTATIONS = [
  // ===== 一、听哪儿 vs 连哪儿 =====
  {
    name: '监听端口改读 base_url（会被 base_url_env 顶掉）',
    file: PLAN,
    find: '  const declared = profile.default_base_url',
    replace: '  const declared = profile.base_url || profile.default_base_url',
    why: '这是本刀最贵的一条：env 指向远程时会在本地起出监听远程端口号的引擎',
  },
  {
    name: 'default_base_url 缺失时不抛，悄悄回落到 9880',
    file: PLAN,
    find: "  if (!declared) {",
    replace: "  if (false) {",
    why: '不抛 ⇒ 名片漏写这一行在测试里没有后果',
  },
  {
    name: 'default_base_url 不带端口也放行',
    file: PLAN,
    find: '  if (!u || !u.port) {',
    replace: '  if (!u) {',
    why: '没端口就没法起进程，放行会让 port 变成 NaN',
  },
  {
    name: 'profile 不再导出 default_base_url',
    file: PROFILE,
    find: '    default_base_url: declared_base_url,',
    replace: '    default_base_url: undefined,',
    why: '字段没接出来 ⇒ 整条「听哪儿」都断了',
  },
  {
    name: 'resolveBaseUrl 把 env 地址也当成 declared',
    file: PROFILE,
    find: '      source: `env:${envKey}`,\n      declared_base_url,',
    replace: '      source: `env:${envKey}`,\n      declared_base_url: String(env[envKey]).replace(/\\/+$/, \'\'),',
    why: '同第一条，只是从 profile 那一侧混淆听/连',
  },

  // ===== 二、占位符 =====
  {
    name: '不认识的占位符原样留着，不抛',
    file: PLAN,
    find: '    if (!PLACEHOLDERS.includes(name)) {',
    replace: '    if (false) {',
    why: '{prot} 原样传下去 ⇒ 表现成「引擎说文件找不到」，查错方向全歪',
  },
  {
    name: '占位符值为 null 时展开成字面量 null',
    file: PLAN,
    find: '    if (v === null || v === undefined) {',
    replace: '    if (false) {',
    why: '{checkpoints} 没声明时会给 shim 传字符串 "null"',
  },
  {
    name: '{port} 展开成名片端口而不是实际端口',
    file: PLAN,
    find: '    port: String(port),',
    replace: '    port: String(listen.port),',
    why: '端口被挪走后引擎听在旧端口上 ⇒ 「引擎永远不上线」',
  },
  {
    name: '{host} 写死 localhost',
    file: PLAN,
    find: '    host: listen.host,\n    port: String(port),',
    replace: '    host: \'localhost\',\n    port: String(port),',
    why: '和 start.ps1 的 127.0.0.1 不是同一个字符串',
  },
  {
    name: '{root} 展开后不做 normalize',
    file: PLAN,
    find: '  return sawPathish ? path.normalize(out) : out',
    replace: '  return out',
    why: 'Windows 上会留下混合分隔符，和 Join-Path 的结果对不上',
  },
  {
    name: '占位符正则只认第一个（多占位符参数只填一半）',
    file: PLAN,
    find: "const PLACEHOLDER_RE = /\\{([a-z_]+)\\}/g",
    replace: "const PLACEHOLDER_RE = /\\{([a-z_]+)\\}/",
    why: '--addr={host}:{port} 只填掉 host',
  },

  // ===== 三、认自家进程 =====
  {
    name: 'own_process_mark 退回只取文件名',
    file: PLAN,
    find: '  const ownProcessMark = p.entry.toLowerCase()',
    replace: '  const ownProcessMark = path.basename(p.entry).toLowerCase()',
    why: '两台引擎入口同名时分不开 ⇒ 一台永远起不来且不报错',
  },
  {
    name: 'own_process_mark 不转小写',
    file: PLAN,
    find: '.toLowerCase()\n\n  return {',
    replace: '\n\n  return {',
    why: '调用方的 $hay 已经小写过，大写记号永远 Contains 不到',
  },

  // ===== 四、端口守卫 =====
  {
    name: '非法端口放行',
    file: PLAN,
    find: '  if (!Number.isInteger(port) || port < 1 || port > 65535) {',
    replace: '  if (false) {',
    why: '"abc" 会变成 NaN 一路传到命令行',
  },
  {
    name: 'desired_port 跟着实际端口走',
    file: PLAN,
    // ⚠ 锚点带上后一行。只写 "desired_port: listen.port," 的话，不可启动那支
    //   返回块里有同样一行 ⇒ 出现 2 次 ⇒ 台架判「锚点坏」并拒跑。
    //   这是 2026-08-25 加"不可启动也给地址"那次改行为顺手弄坏的，
    //   ⭐ 改行为之后必须回头核对所有既有突变的锚点 —— 锚点坏当失败处理。
    // 靠 base_url 那行区分：可启动那支用 ${port}（实际端口），
    // 不可启动那支用 ${listen.port}（名片端口）。
    find: '    desired_port: listen.port,\n    base_url: `http://${listen.host}:${port}`,',
    replace: '    desired_port: port,\n    base_url: `http://${listen.host}:${port}`,',
    why: '调用方就说不出「本来想用 9880，被占了」',
  },

  // ===== 五、不由平台起 =====
  {
    name: 'runtime 为空时照样往下算',
    file: PLAN,
    find: '  if (!profile.runtime) {',
    replace: '  if (false) {',
    why: '会去 spawn 一个 undefined',
  },
  {
    name: 'runtime 为空时返回 launchable:true',
    file: PLAN,
    find: '      launchable: false,',
    replace: '      launchable: true,',
    why: '启动脚本分不出「不由平台起」和「能起」',
  },

  // ===== 六、ready 探活 =====
  {
    name: 'ready_url 写死 /',
    file: PLAN,
    find: '${profile.runtime.ready_endpoint}`,',
    replace: '/`,',
    why: 'IndexTTS2 的 /health 会被打成 / ⇒ 探活探错地方',
  },
  {
    name: 'ready_url 用名片端口而不是实际端口',
    file: PLAN,
    find: '    ready_url: `http://${listen.host}:${port}',
    replace: '    ready_url: `http://${listen.host}:${listen.port}',
    why: '端口挪走后探活探的是旧端口 ⇒ 永远等到超时',
  },

  // ===== 七、名片本身（黄金样本盯的就是这些） =====
  {
    name: 'GSV 名片：-c 指向的配置文件路径写错',
    file: GSV,
    find: '"{root}/lib/inference/tts_infer.yaml"',
    replace: '"{root}/lib/inference/tts_infer.yml"',
    why: '和 start.ps1:50 的 $ENGINE_CFG 不再逐字相同',
  },
  {
    name: 'GSV 名片：args 少一个 -c',
    file: GSV,
    find: '"args": ["-a", "{host}", "-p", "{port}", "-c", "{root}/lib/inference/tts_infer.yaml"],',
    replace: '"args": ["-a", "{host}", "-p", "{port}"],',
    why: '引擎会去读自带默认配置，不是我们修好的那份',
  },
  {
    name: 'GSV 名片：-a 写成 -h',
    file: GSV,
    find: '"args": ["-a", "{host}",',
    replace: '"args": ["-h", "{host}",',
    why: 'infer_server.py 只认 -a；-h 是 argparse 的 help',
  },
  {
    name: 'GSV 名片：cwd 改成引擎目录',
    file: GSV,
    find: '"cwd": ".",\n    "ready_endpoint": "/",',
    replace: '"cwd": "engines/gpt-sovits",\n    "ready_endpoint": "/",',
    why: 'infer_server.py 里有相对 CWD 的路径 ⇒ 起不来',
  },
  {
    name: 'GSV 名片：默认端口改成 9881（和 IndexTTS2 撞）',
    file: GSV,
    find: '"default_base_url": "http://127.0.0.1:9880"',
    replace: '"default_base_url": "http://127.0.0.1:9881"',
    why: '两台引擎抢同一个端口，各自看名片都没问题',
  },
  {
    name: 'IDX 名片：args 用了 {checkpoints} 但把声明删掉',
    file: IDX,
    find: '    "checkpoints": "models/tts/indextts2/checkpoints",',
    replace: '',
    why: '用了占位符却没给值，必须当场抛',
  },
  {
    name: 'IDX 名片：args 里留一个拼错的占位符',
    file: IDX,
    find: '"--checkpoints", "{checkpoints}"]',
    replace: '"--checkpoints", "{checkpoint}"]',
    why: '少个 s，原样传下去 shim 会说目录不存在',
  },
  {
    name: '不可启动的引擎不给地址（端口保护静默失效）',
    file: PLAN,
    find: '      host: listen.host,\n      port: listen.port,\n      desired_port: listen.port,',
    replace: '      host: undefined,\n      port: undefined,\n      desired_port: undefined,',
    why: 'PS 那边 [int]$null = 0 ⇒ Resolve-Port 去问「谁在听 0 号端口」⇒ 保护静默失效',
  },
  {
    name: 'args 漏写时直接 .map()（抛 JS 内部报错）',
    file: PLAN,
    find: '  if (!Array.isArray(rawArgs)) {',
    replace: '  if (false) {',
    why: '接引擎的人拿到的是 "Cannot read properties of undefined"，不知道是哪张名片少了哪个字段',
  },
  {
    name: 'args 里的非字符串项放行',
    file: PLAN,
    find: "    if (typeof a !== 'string') {",
    replace: '    if (false) {',
    why: 'JSON 里 9880 和 "9880" 长得几乎一样，放行后会在 spawn 那一层才炸',
  },
  {
    name: 'args 空数组也当成漏写',
    file: PLAN,
    find: '  if (!Array.isArray(rawArgs)) {',
    replace: '  if (!Array.isArray(rawArgs) || rawArgs.length === 0) {',
    why: '顺手禁掉一种合法名片：靠配置文件、不要任何命令行参数的引擎',
  },
  // ⛔ 这里不放「把 realManifests 的 cwd 断言改成 true」那种突变。
  //   这个台架突变的是**产品代码**，看的是「守卫会不会亮」。改测试自己
  //   必然 GREEN（没有第二层守卫在守守卫），放进来只会把 33/33 稀释成
  //   32/33，让人误以为有一条守卫是摆设。那条断言要验红只能靠临时造一张
  //   cwd 写成 "../.." 的假名片 —— 那是单元测试的活，不是突变台架的活。

  // ===== 八、CLI（tools/scripts/*.ps1 只通过它说话）=====
  {
    name: 'CLI 出错时不打 JSON，只走 stderr',
    file: CLI,
    find: "process.stdout.write(JSON.stringify(payload) + '\\n')",
    replace: "if (exitCode === 0) process.stdout.write(JSON.stringify(payload) + '\\n')",
    why: 'PS 的 ConvertFrom-Json 拿到空串 ⇒ 报「不是合法 JSON」，把人引到错的方向',
  },
  {
    name: 'CLI 出错时退出码仍然是 0',
    file: CLI,
    find: '  if (payload.ok === false) exitCode = 1',
    replace: '  if (false) exitCode = 1',
    why: '启动脚本会拿着一份 ok:false 的东西继续往下走',
  },
  {
    name: 'CLI --all 遇到坏名片就整个失败',
    file: CLI,
    find: '      } catch (err) {\n        engines.push({ id, ok: false, error: err && err.message ? err.message : String(err) })\n      }',
    replace: '      } catch (err) {\n        throw err\n      }',
    why: '一张名片写坏 ⇒ stop.ps1 一台都停不掉 ⇒ 进程锁住文件',
  },
  // ⛔ 这里**不放**「--all 报 plan.port 而不是 plan.desired_port」那条突变。
  //
  // 第一版放了，结果 GREEN。按铁律 3 先查突变本身 —— 查出来它是个**等价突变**：
  // --all 这条路从不传 port，于是 plan.port === listen.port === desired_port，
  // 两种写法在任何输入下都给同一个结果。等价突变的 GREEN 不是"守卫是摆设"，
  // 而是"这条突变什么都没改"，硬要把它变红只能写一条假断言。
  //
  // ⭐ 记在这儿而不是删掉：下次有人看到 --all 里写着 desired_port，会想
  //   "改成 port 也一样啊" —— 今天确实一样，但哪天 --all 支持了 --port，
  //   两者立刻分叉，而那时 stop.ps1 会去停一个引擎并没有在听的端口。
  //   代码里写 desired_port 是在表达意图，不是在表达当前的等价关系。
  {
    name: 'IDX 名片：--port 写死 9881',
    file: IDX,
    find: '"--port", "{port}",',
    replace: '"--port", "9881",',
    why: '端口挪走后 shim 仍听 9881',
  },
]

// --- 跑测试 ----------------------------------------------------------------
function runTests() {
  try {
    execFileSync(process.execPath, ['--test'].concat(TESTS), {
      cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
      env: Object.assign({}, process.env, { TMPDIR: process.env.TMPDIR || '/tmp' }),
    })
    return { green: true, out: '' }
  } catch (e) {
    return { green: false, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

function main() {
  process.stdout.write('=== 突变验证：launch plan（第 2c 步）===\n\n')

  // 铁律 1：先跑基线。
  const base = runTests()
  if (!base.green) {
    process.stdout.write('⛔ 基线就是红的，突变结果没有意义。先修基线。\n')
    process.stdout.write(base.out.slice(-3000) + '\n')
    process.exit(1)
  }
  process.stdout.write('基线 GREEN ✅\n\n')

  // 铁律 2：锚点先读实，没命中当失败。
  const cache = new Map()
  const missing = []
  for (const m of MUTATIONS) {
    if (!cache.has(m.file)) {
      cache.set(m.file, fs.readFileSync(path.join(ROOT, m.file), 'utf8'))
    }
    const src = cache.get(m.file)
    const n = src.split(m.find).length - 1
    if (n !== 1) missing.push(`${m.name} —— 锚点在 ${m.file} 里出现 ${n} 次（要 1 次）`)
  }
  if (missing.length) {
    process.stdout.write('⛔ 锚点对不上，突变会静默失效：\n')
    for (const x of missing) process.stdout.write('   ' + x + '\n')
    process.exit(1)
  }
  process.stdout.write(`锚点 ${MUTATIONS.length}/${MUTATIONS.length} 全部读实 ✅\n\n`)

  let red = 0
  const survivors = []

  for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file)
    const original = fs.readFileSync(abs, 'utf8')
    fs.writeFileSync(abs, original.split(m.find).join(m.replace), 'utf8')
    let r
    try {
      r = runTests()
    } finally {
      fs.writeFileSync(abs, original, 'utf8')   // ⚠ 无论如何都要还原
    }
    if (r.green) {
      survivors.push(m)
      process.stdout.write(`  GREEN ⛔  ${m.name}\n            ${m.why}\n`)
    } else {
      red += 1
      process.stdout.write(`  RED   ✅  ${m.name}\n`)
    }
  }

  process.stdout.write(`\n=== ${red}/${MUTATIONS.length} RED ===\n`)
  if (survivors.length) {
    process.stdout.write('\n活下来的突变（守卫是摆设，或者突变本身写坏了 —— 先查后者）：\n')
    for (const s of survivors) process.stdout.write(`  · ${s.name}\n    ${s.why}\n`)
    process.exit(1)
  }
  process.stdout.write('每一条守卫都真能红。\n')
}

main()
