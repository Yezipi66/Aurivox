#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
apply_profile_json_wiring —— 把通用宿主接进正式启动路径（契约 §11 判据 8 的前置）

    python tools\\dev\\apply_profile_json_wiring.py           # 打
    python tools\\dev\\apply_profile_json_wiring.py --check    # 只看，不写

这一刀干什么
────────────────────────────────────────────────────────────────────────
A/B 判据（tools/dev/run_ab.py，5 条 5 过）已经证明 lib/engines/host.py
出的音频和 engines/indextts2/shim.py 逐字节相同。但**平台真正启动的仍是
shim.py** —— `engines/indextts2/manifest.json` 的 runtime.entry 写着它。

改不过去的原因只有一个：host.py 的 `--profile-json` 是必填参数，而
`lib/engines/launchPlan.js` 的占位符表是封闭的 5 个，没有一个能把
「解析好的名片」递给它。

⇒ 这一刀补上第 6 个占位符 `{profile_json}`，然后把 entry 换成 host.py。

⭐ 这不是新设计：`lib/engines/hostProfile.js:25` 的文件头注释里早就写着
  「谁调它：launchPlan.js 算 {profile_json} 占位符时（把结果落成临时文件）」。
  当初就是这么打算的，只是没实现。这一刀是把那行注释兑现。

⛔ 为什么让 host.py 自己读 manifest.json 是错的（契约 §4 第 4 步）：
  「平台不许把猜测当成已确认直接装上 / 没被点过头的绑定 = 没装」。
  宿主自己读到的是没有确认状态的原始名片，等于把「我猜是这个」当
  「人说是这个」用。名片语义只能有一份实现，在 Node 这边。

顺带修掉一个被这一刀炸出来的真 bug
────────────────────────────────────────────────────────────────────────
`launchPlan.js` 的 own_process_mark 原先取「入口的绝对路径」，注释写明
理由是「两台引擎的入口都叫 shim.py 是完全可能的」。可是走通用宿主的
引擎，**入口的绝对路径也是同一个** —— 从「可能同名」变成「必然同路径」。
后果就是那段注释自己写的：A 占着端口时 start.ps1 认为「我的引擎已经在
跑了」，B 永远起不来，且不报任何错。
⇒ 走宿主的引擎改用 cache/engines/<id>.profile.json 当记号（一台一个，
  而且就摆在命令行里）。不走宿主的引擎行为一个字节不变。

为什么是锚点补丁，不是整文件覆盖
────────────────────────────────────────────────────────────────────────
助手的工作树是从快照包解出来的，可能落后真机若干笔。整文件覆盖会**静默
回滚**那几笔 —— 测试照样全绿，git 只报一个 M，谁都看不出少了什么。
⇒ 逐处按锚点替换；锚点命中 != 1 次就**一处都不写**，非零退出并点名。
⇒ 已经打过的会跳过（幂等），重复跑安全。

打完请跑
────────────────────────────────────────────────────────────────────────
    node tools\\run_tests.cjs
    node lib\\engines\\engine-launch-plan.cjs --engine indextts2

第二条应当输出 entry 指向 lib\\engines\\host.py、args 里带
--profile-json，并且 cache\\engines\\indextts2.profile.json 已经落盘。

⛔ 打完**先别删 shim.py**：先从界面真起一次引擎、真出一段声。
  判据过的是「host.py 能替代」，还没验过「启动器按新名片起得来」。
"""

import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 打哪几个文件（顺序＝先纯函数，再有副作用那层，再判据，最后名片）
FILES = [
    "lib/engines/launchPlan.js",
    "lib/engines/engine-launch-plan.cjs",
    "lib/engines/launchPlan.node.test.js",
    "engines/indextts2/manifest.json"
]

# 锚点表：每一处都带前后 3 行上下文，命中必须正好 1 次。
# ⛔ 手改这张表之前先想清楚 —— 它是照着真树 diff 出来的，不是手写的。
#   相邻改动已经合并过：两处离得太近时，前一处会把后一处的上下文吃掉，
#   于是后一处命中 0 次、整个补丁拒绝落地（这个坑是实测踩出来的）。
HUNKS = {
 "lib/engines/launchPlan.js": [
  {
   "old": "// args 里允许出现的占位符。⛔ 和 RUNTIME_KEYS 同一个道理：不认识的占位符\n// **必须抛**，不能原样留着。留着的后果是 python 收到一个字面量 \"{prot}\"\n// 当路径去打开，报一句 FileNotFoundError，而名片看着完全正常。\nconst PLACEHOLDERS = Object.freeze(['host', 'port', 'root', 'engine_dir', 'checkpoints'])\n\n// 展开后需要按本机分隔符规整的那几个 —— 它们的值是路径。\n// 例：名片写 \"{root}/lib/inference/tts_infer.yaml\"，在 Windows 上展开成\n// \"D:\\...\\lib/inference/tts_infer.yaml\"（混着两种分隔符），normalize 之后\n// 才等于 start.ps1 里 Join-Path 拼出来的那个字符串。\nconst PATHISH = Object.freeze(['root', 'engine_dir', 'checkpoints'])\n\nconst PLACEHOLDER_RE = /\\{([a-z_]+)\\}/g\n\nfunction expandArg(profile, raw, values) {\n  let sawPathish = false\n  const out = raw.replace(PLACEHOLDER_RE, (whole, name) => {\n    if (!PLACEHOLDERS.includes(name)) {\n",
   "new": "// args 里允许出现的占位符。⛔ 和 RUNTIME_KEYS 同一个道理：不认识的占位符\n// **必须抛**，不能原样留着。留着的后果是 python 收到一个字面量 \"{prot}\"\n// 当路径去打开，报一句 FileNotFoundError，而名片看着完全正常。\n//\n// ⭐⭐ `{profile_json}` —— 通用宿主 lib/engines/host.py 专用的那一个\n//   它和另外五个**来路不同**：那五个平台自己算得出来（端口、目录），\n//   这一个的值是**一份要先落到盘上的文件**（hostProfile.js 的产物）。\n//   ⇒ 本文件是纯函数，不写盘：这里只负责把路径展开进 args，并在计划里\n//     挂一面旗子 `profile_json_path`，告诉调用方「spawn 之前你得把它写出来」。\n//     真正落盘在 engine-launch-plan.cjs（它本来就是有副作用的那一层）。\n//\n//   ⛔ 为什么不让 host.py 自己去读 manifest.json：契约 §4 第 4 步\n//     「平台不许把猜测当成已确认直接装上 / 没被点过头的绑定 = 没装」。\n//     宿主自己读到的是**没有确认状态**的原始名片，等于把「我猜是这个」\n//     当「人说是这个」用。名片语义只能有一份实现，在 Node 这边。\nconst PLACEHOLDERS = Object.freeze([\n  'host', 'port', 'root', 'engine_dir', 'checkpoints', 'profile_json',\n])\n\n// 展开后需要按本机分隔符规整的那几个 —— 它们的值是路径。\n// 例：名片写 \"{root}/lib/inference/tts_infer.yaml\"，在 Windows 上展开成\n// \"D:\\...\\lib/inference/tts_infer.yaml\"（混着两种分隔符），normalize 之后\n// 才等于 start.ps1 里 Join-Path 拼出来的那个字符串。\n// ⚠ profile_json 必须在这张表里：它是路径。只进 PLACEHOLDERS 不进 PATHISH，\n//   Windows 上会传出 \"D:\\...\\cache/engines/x.profile.json\" 这种混分隔符的串。\nconst PATHISH = Object.freeze(['root', 'engine_dir', 'checkpoints', 'profile_json'])\n\nconst PLACEHOLDER_RE = /\\{([a-z_]+)\\}/g\n\nfunction expandArg(profile, raw, values, used) {\n  let sawPathish = false\n  const out = raw.replace(PLACEHOLDER_RE, (whole, name) => {\n    if (!PLACEHOLDERS.includes(name)) {\n"
  },
  {
   "old": "        { id: profile.id, key: 'runtime.args', placeholder: whole })\n    }\n    if (PATHISH.includes(name)) sawPathish = true\n    return String(v)\n  })\n  return sawPathish ? path.normalize(out) : out\n",
   "new": "        { id: profile.id, key: 'runtime.args', placeholder: whole })\n    }\n    if (PATHISH.includes(name)) sawPathish = true\n    if (used) used.add(name)\n    return String(v)\n  })\n  return sawPathish ? path.normalize(out) : out\n"
  },
  {
   "old": " * @param {object} [opts]\n *   @param {string} [opts.rootDir]  项目根；默认按本文件位置推\n *   @param {number} [opts.port]     实际要用的端口。不传就用名片声明的那个。\n *\n * ⭐ 为什么 port 可以从外面塞进来：端口冲突的判定（我的旧进程 / 别人的进程 /\n *   往上挪一个）留在 start.ps1 里，见本文件顶部。所以调用顺序是\n *   「先问名片要期望端口 → 脚本解决冲突 → 再带着定下来的端口问一次完整计划」。\n",
   "new": " * @param {object} [opts]\n *   @param {string} [opts.rootDir]  项目根；默认按本文件位置推\n *   @param {number} [opts.port]     实际要用的端口。不传就用名片声明的那个。\n *   @param {string} [opts.profileJsonPath]  覆盖名片解析结果的落盘位置。\n *     不传就是 <root>/cache/engines/<id>.profile.json —— 纯算出来的，\n *     所以调用方**没有可忘的东西**。\n *     ⭐ 只有名片 args 里真的用了 {profile_json} 才会被取用；没用到就完全\n *       不影响结果（传了也不会凭空多出一个字段）。\n *     ⇒ 计划里回一个 `profile_json_path`：**它在 = 调用方 spawn 之前必须\n *       把 buildHostProfile(id) 写到那儿**。不在 = 这台引擎不需要。\n *\n\n * ⭐ 为什么 port 可以从外面塞进来：端口冲突的判定（我的旧进程 / 别人的进程 /\n *   往上挪一个）留在 start.ps1 里，见本文件顶部。所以调用顺序是\n *   「先问名片要期望端口 → 脚本解决冲突 → 再带着定下来的端口问一次完整计划」。\n"
  },
  {
   "old": "    root: rootDir,\n    engine_dir: profile.dir,\n    checkpoints: p.checkpoints,      // 名片没写 checkpoints 时是 null ⇒ 用了就抛\n  }\n  // ⛔ 先查形状再 .map()。不查的话，一张写了 runtime 却漏了 args 的名片会\n  //   在这里抛 \"Cannot read properties of undefined (reading 'map')\" ——\n  //   这句话经 CLI 传到 start.ps1、再打到用户的启动窗口里，说的是 JS 的内部\n",
   "new": "    root: rootDir,\n    engine_dir: profile.dir,\n    checkpoints: p.checkpoints,      // 名片没写 checkpoints 时是 null ⇒ 用了就抛\n    // ⭐⭐ 有默认值，而且**算得出来**：<root>/cache/engines/<id>.profile.json。\n    //   第一版是「调用方必须传，不传就抛」，写了一句很漂亮的报错指向调用方 ——\n    //   然后盘上三处真名片的体检当场全红，因为它们只想算个计划，凭什么关心\n    //   一份缓存文件放哪儿。⇒ 与其把报错写好，不如**让这个错不可能发生**：\n    //   路径由 rootDir + id 纯算出来，调用方忘不了，因为没有可忘的东西。\n    //   ⚠ opts.profileJsonPath 保留成覆盖口，给 run_ab.py 这类要指定位置的工具。\n    profile_json: path.resolve(\n      rootDir,\n      opts.profileJsonPath || path.join('cache', 'engines', `${profile.id}.profile.json`)),\n  }\n  // 哪些占位符**真的**被用到了。⛔ 判据只能是「展开时命中过」，不能是\n  //   「调用方传了 profileJsonPath」—— 后者会让一台压根不用宿主的引擎也\n  //   被要求写一份名片文件，白落一个没人读的文件在盘上。\n  const used = new Set()\n  // ⛔ 先查形状再 .map()。不查的话，一张写了 runtime 却漏了 args 的名片会\n  //   在这里抛 \"Cannot read properties of undefined (reading 'map')\" ——\n  //   这句话经 CLI 传到 start.ps1、再打到用户的启动窗口里，说的是 JS 的内部\n"
  },
  {
   "old": "        { id: profile.id, key: 'runtime.args', got: typeof a })\n    }\n  }\n  const args = rawArgs.map((a) => expandArg(profile, a, values))\n\n  // 认自家进程用的记号：调用方拿它去 Contains() 一个进程的命令行。\n  //\n",
   "new": "        { id: profile.id, key: 'runtime.args', got: typeof a })\n    }\n  }\n  const args = rawArgs.map((a) => expandArg(profile, a, values, used))\n\n  // 认自家进程用的记号：调用方拿它去 Contains() 一个进程的命令行。\n  //\n"
  },
  {
   "old": "  //   start.ps1 拼进去的绝对路径（$ENGINE_SCRIPT），Contains 照样命中。\n  //   新写法只会更严，不会更松。\n  // ⚠ 小写：调用方（Test-IsOwnProcess）拿到的命令行已经 ToLowerInvariant 过。\n  const ownProcessMark = p.entry.toLowerCase()\n\n  return {\n    id: profile.id,\n",
   "new": "  //   start.ps1 拼进去的绝对路径（$ENGINE_SCRIPT），Contains 照样命中。\n  //   新写法只会更严，不会更松。\n  // ⚠ 小写：调用方（Test-IsOwnProcess）拿到的命令行已经 ToLowerInvariant 过。\n  //\n  // ⛔⛔ 2026-08-27：通用宿主把上面这段推理的地基抽掉了。\n  //   上面写「文件名会撞，所以用绝对路径」—— 可是走 lib/engines/host.py 的\n  //   引擎，**入口的绝对路径也是同一个**。以前是「两台可能同名」，\n  //   现在是「所有走宿主的引擎必然同路径」，同一个撞车原样复活，而且更狠。\n  //   后果就是上面那段写的：A 占着端口时 start.ps1 认为「我的引擎已经在\n  //   跑了」，B 永远起不来，且不报任何错。\n  //\n  // ⭐ 修法：走宿主的引擎，改用**那份名片解析结果的路径**当记号 ——\n  //   它一台引擎一个（cache/engines/<id>.profile.json），而且就明明白白\n  //   摆在命令行里（--profile-json 后面那个值），Contains() 照样命中。\n  //   ⇒ 不走宿主的引擎（自带入口）行为一个字节不变，仍是入口绝对路径。\n  const ownProcessMark = (used.has('profile_json') ? values.profile_json : p.entry)\n    .toLowerCase()\n\n  // ⭐⭐ 这面旗子是给调用方看的一条**指令**，不是一条信息：\n  //   它在 ⇒ 「spawn 之前先把 buildHostProfile(id) 写到这个路径」。\n  //   它不在 ⇒ 这台引擎不走通用宿主，什么都不用做。\n  //   ⛔ 一台引擎的入口都指到 host.py 了却没有这面旗子，表现是宿主开口就\n  //     FATAL「--profile-json 是必须的」—— 那时候看起来像宿主的毛病，\n  //     其实是名片 args 里漏写了 {profile_json}。\n  const profileJsonPath = used.has('profile_json') ? values.profile_json : null\n\n  return {\n    id: profile.id,\n"
  },
  {
   "old": "    ready_timeout_ms: profile.runtime.ready_timeout_ms,\n    own_process_mark: ownProcessMark,\n    preload: profile.runtime.preload === true,\n  }\n}\n\nmodule.exports = { buildLaunchPlan, PLACEHOLDERS }\n",
   "new": "    ready_timeout_ms: profile.runtime.ready_timeout_ms,\n    own_process_mark: ownProcessMark,\n    preload: profile.runtime.preload === true,\n    profile_json_path: profileJsonPath,\n  }\n}\n\nmodule.exports = { buildLaunchPlan, PLACEHOLDERS, PATHISH }\n"
  }
 ],
 "lib/engines/engine-launch-plan.cjs": [
  {
   "old": "//\n// ⛔ 这个文件里不许出现任何具体引擎的名字。\n\nconst path = require('node:path')\nconst { resolveEngineProfile } = require('./profile')\nconst { buildLaunchPlan } = require('./launchPlan')\n\n// ⛔ 不用 process.argv 的方括号索引写法：给 Owner 粘的命令里方括号会被\n//    渲染成 markdown 链接。这里是文件不是粘贴的命令，但保持同一套写法，\n",
   "new": "//\n// ⛔ 这个文件里不许出现任何具体引擎的名字。\n\nconst fs = require('node:fs')\nconst path = require('node:path')\nconst { resolveEngineProfile } = require('./profile')\nconst { buildLaunchPlan } = require('./launchPlan')\n\n// ---------------------------------------------------------------------------\n//  ⭐⭐ 名片解析结果落盘 —— {profile_json} 这个占位符的另一半\n// ---------------------------------------------------------------------------\n//\n// 通用宿主 lib/engines/host.py 不读 manifest.json（它自己的 FATAL 里写着\n// 理由：「名片语义只有 lib/engines/profile.js 一个实现，写两遍迟早分叉」）。\n// 所以起它之前，平台必须把解析结果落成一个文件，把路径递过去。\n//\n// ⭐ 为什么落在这个文件里，而不是 launchPlan.js：那边是纯函数（名片进、\n//   计划出，不 spawn 不读环境不写盘），正因为纯所以能被测穷。写盘是副作用,\n//   放在这层 CLI 里 —— 它本来就有副作用（读注册表、写 stdout、定退出码）。\n//\n// ⭐ 落在 cache/ 下：这份文件**完全可再生**（删了下次启动自动重算），\n//   正是 docs/ROOT_LAYOUT.md 给 cache/ 的定义。⛔ 不要落进 outputs/ ——\n//   那是给用户看的产物，不是平台的中间件。\nfunction writeHostProfile(id, dest) {\n  const { buildHostProfile } = require('./hostProfile')\n  // ⛔ 解析失败要**原样**抛出去：hostProfile.js 的报错是点名的\n  //   （哪个引擎、哪个字段、为什么）。在这里包一层「写文件失败」会把\n  //   唯一有用的那句话盖掉。\n  const profile = buildHostProfile(id)\n  const text = JSON.stringify(profile, null, 2) + '\\n'\n  fs.mkdirSync(path.dirname(dest), { recursive: true })\n  fs.writeFileSync(dest, text, 'utf8')\n  return Buffer.byteLength(text)\n}\n\n// ⛔ 不用 process.argv 的方括号索引写法：给 Owner 粘的命令里方括号会被\n//    渲染成 markdown 链接。这里是文件不是粘贴的命令，但保持同一套写法，\n"
  },
  {
   "old": "  const port = rawPort === undefined ? undefined : Number(rawPort)\n\n  const profile = resolveEngineProfile(id)\n  const plan = buildLaunchPlan(profile, { rootDir, port })\n  return Object.assign({ ok: true }, plan)\n}\n\n",
   "new": "  const port = rawPort === undefined ? undefined : Number(rawPort)\n\n  const profile = resolveEngineProfile(id)\n\n  // ⭐ 落到哪儿由 buildLaunchPlan 算（<root>/cache/engines/<id>.profile.json）——\n  //   「路径怎么算」是纯计算，归那边；「把它写出来」是副作用，归这里。\n  //   一台引擎一个固定文件名，不带时间戳：带时间戳会在 cache/ 里堆垃圾，\n  //   而且「上次用的是哪份」说不清。固定名 ⇒ 盘上那份永远是最近一次启动\n  //   真正用的那份。\n  const plan = buildLaunchPlan(profile, { rootDir, port })\n\n  // ⭐⭐ 顺序要紧：**先写文件，再把计划交出去**。\n  //   反过来的话，start.ps1 会拿着一份指向「还不存在的文件」的命令行去\n  //   spawn，宿主开口就是「读不了解析结果」—— 而那时候真正的原因\n  //   （平台还没来得及写）已经看不见了。\n  //   ⚠ 这里**不 try**：写不出来就该让整条启动路径带着原因失败。\n  //     写不出来还照常返回计划 = 造一个必然失败且报错指向别处的启动。\n  if (plan.profile_json_path) {\n    const bytes = writeHostProfile(id, plan.profile_json_path)\n    plan.profile_json_bytes = bytes\n  }\n\n  return Object.assign({ ok: true }, plan)\n}\n\n"
  }
 ],
 "lib/engines/launchPlan.node.test.js": [
  {
   "old": "    id: 'b', dir: path.join(ROOT, 'engines', 'b'), runtime: { entry: 'shim.py' },\n  }), { rootDir: ROOT })\n  assert.notEqual(a.own_process_mark, b.own_process_mark)\n})\n\n// ===========================================================================\n",
   "new": "    id: 'b', dir: path.join(ROOT, 'engines', 'b'), runtime: { entry: 'shim.py' },\n  }), { rootDir: ROOT })\n  assert.notEqual(a.own_process_mark, b.own_process_mark)\n})\n\ntest('⛔⛔ launchPlan: 两台引擎都走通用宿主时，记号必须仍然分得开', () => {\n  // ⭐⭐ 上面那条防的是「入口**可能**同名」，靠的是入口绝对路径带上了各自的\n  //   engines/<id>/ 目录。通用宿主把这条保护抽掉了：走 host.py 的引擎，\n  //   入口的**绝对路径也是同一个** —— 从「可能同名」变成「必然同路径」。\n  //   记号一样 ⇒ start.ps1 的 Test-IsOwnProcess 把 B 的进程认成 A 的 ⇒\n  //   A 占着端口时 B 永远起不来，而且不报任何错。\n  // ⛔ 这条用例必须用**同一个 entry**（这正是宿主的形态），\n  //   不能像上面那条那样靠 dir 不同蒙混过关。\n  const host = { entry: '../../lib/engines/host.py', args: ['--profile-json', '{profile_json}'] }\n  const a = buildLaunchPlan(\n    fakeProfile({ id: 'a', dir: path.join(ROOT, 'engines', 'a'), runtime: host }),\n    { rootDir: ROOT, profileJsonPath: path.join(ROOT, 'cache', 'engines', 'a.profile.json') })\n  const b = buildLaunchPlan(\n    fakeProfile({ id: 'b', dir: path.join(ROOT, 'engines', 'b'), runtime: host }),\n    { rootDir: ROOT, profileJsonPath: path.join(ROOT, 'cache', 'engines', 'b.profile.json') })\n\n  assert.equal(a.entry, b.entry, '前提：两台走的确实是同一个宿主入口')\n  assert.notEqual(a.own_process_mark, b.own_process_mark,\n    '两台都走通用宿主时记号撞了 —— 后一台会被当成前一台，静默起不来')\n  // ⭐ 记号必须真的出现在命令行里，否则 Contains() 永远命中不了。\n  assert.ok(a.args.map((x) => x.toLowerCase()).includes(a.own_process_mark),\n    '记号不在 args 里 = Test-IsOwnProcess 认不出自家进程')\n})\n\ntest('⭐ launchPlan: 不走宿主的引擎，记号仍是入口绝对路径（行为不变）', () => {\n  // 上一条的修法只该影响走宿主的那些。GPT-SoVITS 自带入口，一个字节都不该变。\n  const plan = buildLaunchPlan(fakeProfile({ runtime: { entry: 'Run.PY' } }), { rootDir: ROOT })\n  assert.equal(plan.own_process_mark, path.resolve(ROOT, 'engines/fake/Run.PY').toLowerCase())\n  assert.equal(plan.profile_json_path, null,\n    '没用 {profile_json} 的引擎不该被要求写一份没人读的名片文件')\n})\n\n// ===========================================================================\n//  四点二、{profile_json} —— 通用宿主的接线\n// ===========================================================================\n\ntest('⭐⭐ launchPlan: {profile_json} 展开成调用方给的路径，并挂出落盘指令', () => {\n  const dest = path.join(ROOT, 'cache', 'engines', 'fake.profile.json')\n  const plan = buildLaunchPlan(\n    fakeProfile({ runtime: { args: ['--profile-json', '{profile_json}', '--port', '{port}'] } }),\n    { rootDir: ROOT, profileJsonPath: dest })\n  assert.deepEqual(plan.args, ['--profile-json', path.normalize(dest), '--port', '9999'])\n  // ⭐ 这个字段是给调用方的**指令**：它在 = spawn 之前必须把名片写到那儿。\n  assert.equal(plan.profile_json_path, path.normalize(dest))\n})\n\ntest('⭐⭐ launchPlan: 不传 profileJsonPath 也能算出来（调用方没有可忘的东西）', () => {\n  // ⛔ 第一版是「不传就抛」，报错写得很漂亮 —— 然后盘上真名片的三组体检\n  //   当场全红：它们只想算个计划，凭什么关心一份缓存文件放哪儿。\n  //   ⇒ 与其把报错写好，不如让这个错**不可能发生**。这条钉住那个决定。\n  const plan = buildLaunchPlan(\n    fakeProfile({ runtime: { args: ['--profile-json', '{profile_json}'] } }),\n    { rootDir: ROOT })\n  assert.equal(plan.profile_json_path,\n    path.normalize(path.join(ROOT, 'cache', 'engines', 'fake.profile.json')))\n  // ⭐ 落在 cache/ 下：这份文件完全可再生，删了下次启动自动重算。\n  //   ⛔ 不该落进 outputs/ —— 那是给用户看的产物，不是平台的中间件。\n  assert.ok(plan.profile_json_path.includes(`${path.sep}cache${path.sep}`))\n})\n\ntest('⭐ launchPlan: 传了 profileJsonPath 但名片没用它 ⇒ 不落盘、不多字段', () => {\n  // ⛔ 判据只能是「展开时命中过」，不能是「调用方传了路径」——\n  //   后者会让一台压根不走宿主的引擎也白写一份没人读的文件到盘上。\n  const plan = buildLaunchPlan(fakeProfile(), {\n    rootDir: ROOT, profileJsonPath: path.join(ROOT, 'cache', 'engines', 'fake.profile.json'),\n  })\n  assert.equal(plan.profile_json_path, null)\n})\n\ntest('⛔ launchPlan: {profile_json} 是路径，必须按本机分隔符规整', () => {\n  // Windows 上不 normalize 会传出 \"D:\\...\\cache/engines/x.profile.json\"\n  // 这种混着两种分隔符的串。这条钉的是它进了 PATHISH 那张表。\n  const plan = buildLaunchPlan(\n    fakeProfile({ runtime: { args: ['{profile_json}'] } }),\n    { rootDir: ROOT, profileJsonPath: 'cache/engines/fake.profile.json' })\n  assert.equal(plan.args[0], path.normalize(path.resolve(ROOT, 'cache/engines/fake.profile.json')))\n})\n\n// ===========================================================================\n"
  }
 ],
 "engines/indextts2/manifest.json": [
  {
   "old": "    \"venv 没有共同依赖，也不能共用 —— 这是它必须以独立进程 + HTTP 存在\",\n    \"的根本原因，不是为了好看。\",\n    \"python: 引擎 venv 的解释器，相对项目根。\",\n    \"entry : shim 脚本，相对本 manifest 所在目录。\",\n    \"ready_timeout_ms: 冷启动预热预算。实测 import 34.55s + 构造 26.51s\",\n    \"  ≈61s，取 180000 留三倍余量。start.ps1 应轮询 /health 直到 ready，\",\n    \"  并在 failed=true 时立即放弃、把 error 打进日志 —— 别干等满超时。\",\n",
   "new": "    \"venv 没有共同依赖，也不能共用 —— 这是它必须以独立进程 + HTTP 存在\",\n    \"的根本原因，不是为了好看。\",\n    \"python: 引擎 venv 的解释器，相对项目根。\",\n    \"entry : 入口脚本，相对本 manifest 所在目录。\",\n    \"\",\n    \"⭐⭐ 2026-08-27：entry 从自带的 shim.py 换成了平台的通用宿主\",\n    \"  ../../lib/engines/host.py —— 契约 §11 判据 8「shim.py 缩到零」。\",\n    \"  判据不是「看着能跑」：tools/dev/run_ab.py 采四段音频比过梅尔差，\",\n    \"  跨路径 0.00%、天花板 127.25%（5 条判据 5 过）。\",\n    \"  ⚠ 解释器仍是**引擎自己的 venv** —— 换的是脚本不是环境。宿主是通用的，\",\n    \"    torch 那一套还得在引擎的 venv 里，这两件事别混。\",\n    \"\",\n    \"⭐ {profile_json} = 平台把这张名片解析好之后落盘的那个文件。\",\n    \"  宿主**不读 manifest.json**（它自己的 FATAL 里写着理由：名片语义只有\",\n    \"  lib/engines/profile.js 一个实现，写两遍迟早分叉）。路径由\",\n    \"  lib/engines/engine-launch-plan.cjs 算并在 spawn 之前写出来。\",\n    \"  ⛔ 入口指到 host.py 却漏写这个占位符，表现是宿主开口 FATAL\",\n    \"    「--profile-json 是必须的」—— 看着像宿主坏了，其实是这行漏了。\",\n    \"\",\n    \"⛔ --checkpoints 没了，不是漏写：宿主从解析结果里的 runtime.checkpoints\",\n    \"  自己取（host.py 的 _placeholder_values）。所以下面那行 checkpoints\",\n    \"  **仍然必须留着** —— 它从「命令行参数的来源」变成了「名片字段」，\",\n    \"  读它的人换了，字段没退休。\",\n    \"ready_timeout_ms: 冷启动预热预算。实测 import 34.55s + 构造 26.51s\",\n    \"  ≈61s，取 180000 留三倍余量。start.ps1 应轮询 /health 直到 ready，\",\n    \"  并在 failed=true 时立即放弃、把 error 打进日志 —— 别干等满超时。\",\n"
  },
  {
   "old": "    \"它只会在你终于用上它的那天报错。新增字段前先问：谁读它？\",\n    \"\",\n    \"verify: 平台据此判断这台引擎装没装（只验不建 —— 平台不装环境）。\",\n    \"  模块/类/方法名不是编的，是从 shim.py 读出来的：\",\n    \"  shim.py:162 from indextts.infer_v2 import IndexTTS2\",\n    \"  shim.py:169 IndexTTS2(cfg_path=..., model_dir=...)\",\n    \"  shim.py:234 self.tts.infer(spk_audio_prompt=, text=, output_path=)\",\n    \"  ⇒ 改 shim.py 时这里要跟着改，否则校验会漏掉真正的断裂。\",\n    \"\",\n    \"⭐ 2026-08-25（第 2c 步）新增 args / cwd。名字对应 shim.py:87 的 _arg()：\",\n    \"  shim.py:98  --host        （默认 127.0.0.1）\",\n    \"  shim.py:99  --port        （默认 9881）\",\n    \"  shim.py:102 --checkpoints （没有默认值，缺了 shim.py:476 直接 FATAL）\",\n    \"  --config 不写：shim.py:482 会在 checkpoints 目录里找 config.yaml，\",\n    \"  那正是上游放它的地方；写死一个路径反而会在权重换版本时对不上。\",\n    \"\",\n    \"  ⚠ {checkpoints} 展开的是上面那行 runtime.checkpoints 的绝对路径。\",\n    \"  用了这个占位符就必须写那一行 —— 平台会当场抛，不会传一个字面量\",\n    \"  \\\"{checkpoints}\\\" 让 shim 去报「目录不存在」。\",\n    \"\",\n    \"cwd \\\".\\\" = 项目根，只是个起点：shim.py:491 自己会 chdir 到 checkpoints\",\n    \"  的父目录（上游有相对 CWD 的硬编码，见那一段注释）。\",\n    \"  ⛔ 别在名片里替它 chdir —— 进程里已经定了一次，两处定会打架。\"\n  ],\n  \"runtime\": {\n    \"python\": \"engines/indextts2/.venv/Scripts/python.exe\",\n    \"entry\": \"shim.py\",\n    \"args\": [\"--host\", \"{host}\", \"--port\", \"{port}\", \"--checkpoints\", \"{checkpoints}\"],\n    \"cwd\": \".\",\n    \"checkpoints\": \"models/tts/indextts2/checkpoints\",\n    \"ready_endpoint\": \"/health\",\n",
   "new": "    \"它只会在你终于用上它的那天报错。新增字段前先问：谁读它？\",\n    \"\",\n    \"verify: 平台据此判断这台引擎装没装（只验不建 —— 平台不装环境）。\",\n    \"  模块/类/方法名不是编的，它和下面 call 段里那三个名字**同源**：\",\n    \"  call.module / call.class / call.method 是宿主真正要 import 和调用的，\",\n    \"  这里是第一道校验要 import 的。⇒ 两处必须一致，不一致等于「验的和\",\n    \"  跑的不是同一个东西」。\",\n    \"  ⭐ verify.sys_path 还有第二个消费者：host.py 起来时按它加载引擎源码\",\n    \"    目录。用校验块的路径不是笔误 —— 验哪条路径就得跑哪条路径。\",\n    \"\",\n    \"⭐ 2026-08-25（第 2c 步）新增 args / cwd。\",\n    \"  2026-08-27 args 改成宿主的三个参数，见上面那段。\",\n    \"\",\n    \"cwd \\\".\\\" = 项目根，只是个起点。真正的 chdir 由宿主按 call.cwd 做\",\n    \"  （上游有相对 CWD 的硬编码，见 call 段那里的注释）。\",\n    \"  ⛔ runtime.cwd 和 call.cwd 同名不同义，别混：前者是「启动器从哪儿\",\n    \"    spawn」，后者是「调用时上游需要待在哪」。各有各的消费者。\",\n    \"  ⛔ 也别在名片里替它 chdir 两次 —— 进程里只该定一次。\"\n  ],\n  \"runtime\": {\n    \"python\": \"engines/indextts2/.venv/Scripts/python.exe\",\n    \"entry\": \"../../lib/engines/host.py\",\n    \"args\": [\n      \"--profile-json\", \"{profile_json}\",\n      \"--host\", \"{host}\",\n      \"--port\", \"{port}\"\n    ],\n    \"cwd\": \".\",\n    \"checkpoints\": \"models/tts/indextts2/checkpoints\",\n    \"ready_endpoint\": \"/health\",\n"
  }
 ]
}


def read(p):
    with io.open(p, encoding="utf-8", newline="") as f:
        return f.read()


def write(p, s):
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(s)


def main(argv):
    check_only = "--check" in argv[1:]
    unknown = [a for a in argv[1:] if a != "--check"]
    if unknown:
        print("不认识的参数：%s（只有 --check）" % " ".join(unknown))
        return 2

    print("apply_profile_json_wiring —— 把通用宿主接进正式启动路径")
    print("  仓库根 %s" % ROOT)
    print("  模式   %s" % ("只看不写（--check）" if check_only else "真写"))
    print("=" * 74)

    # ── 第一趟：只量不动 ────────────────────────────────────────────
    # ⭐ 全部锚点先验一遍再动手。半边打进去的补丁比没打还难收拾：
    #   文件既不是旧的也不是新的，跑出来的红是哪一半造成的说不清。
    plan = []          # [(相对路径, 新内容, 打了几处, 跳过几处)]
    problems = []

    for rel in FILES:
        path = os.path.join(ROOT, rel.replace("/", os.sep))
        if not os.path.exists(path):
            problems.append("%s —— 文件不在。补丁是对着 2026-08-27 的树写的，"
                            "对不上就别硬打" % rel)
            continue

        src = read(path)
        applied = skipped = 0
        for i, h in enumerate(HUNKS[rel]):
            old, new = h["old"], h["new"]
            if src.count(new) == 1 and src.count(old) == 0:
                skipped += 1          # 这一处已经是新的了 ⇒ 幂等
                continue
            n = src.count(old)
            if n != 1:
                problems.append(
                    "%s 第 %d 处锚点命中 %d 次（要 1 次）。\n"
                    "     锚点头一行：%s"
                    % (rel, i + 1, n, old.strip().splitlines()[0][:70]))
                continue
            src = src.replace(old, new, 1)
            applied += 1
        plan.append((rel, src, applied, skipped))

    if problems:
        print("\n⛔ 对不上，一个字都没写：\n")
        for p in problems:
            print("   - %s" % p)
        print("\n   多半是这棵树和补丁写的时候不是同一版。")
        print("   处置：把这几个文件当前的样子发出来，我按你的版本重出锚点。")
        print("   ⛔ 别用整文件覆盖顶上去 —— 那会把这几笔静默回滚掉。")
        return 1

    # ── 第二趟：写 ────────────────────────────────────────────────
    total_new = total_old = 0
    for rel, src, applied, skipped in plan:
        total_new += applied
        total_old += skipped
        mark = "已经是新的" if applied == 0 else "打了 %d 处" % applied
        extra = "（另有 %d 处早就打过了）" % skipped if applied and skipped else ""
        print("  %-42s %s%s" % (rel, mark, extra))
        if applied and not check_only:
            write(os.path.join(ROOT, rel.replace("/", os.sep)), src)

    print("=" * 74)
    if total_new == 0:
        print("结账：%d 处全都早就打过了 —— 这棵树已经是接好线的状态。" % total_old)
        return 0

    if check_only:
        print("结账：%d 处待打（--check 没写盘）。去掉 --check 再跑一次。" % total_new)
        return 0

    print("结账：写了 %d 处%s" % (
        total_new, "，另有 %d 处本来就是新的" % total_old if total_old else ""))
    print("")
    print("下一步，两条，按顺序：")
    print("    node tools\\run_tests.cjs")
    print("    node lib\\engines\\engine-launch-plan.cjs --engine indextts2")
    print("")
    print("  第一条：tests 总数应当是 839（原 833 + 新判据 6 条），fail 0。")
    print("          ⭐ 先看总数再看 pass/fail —— 总数掉了说明有测试没被跑到，")
    print("            那种情况下的「全绿」是空的。")
    print("  第二条：entry 应当指向 lib\\engines\\host.py，args 里带")
    print("          --profile-json，且 cache\\engines\\indextts2.profile.json")
    print("          已经落盘（约 2722 字节）。")
    print("")
    print("  ⛔ 然后**从界面真起一次引擎、真出一段声**，再考虑删 shim.py。")
    print("     判据过的是「host.py 能替代 shim.py」，还没验过「启动器照新名片")
    print("     起得来」—— 那是两件事。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
