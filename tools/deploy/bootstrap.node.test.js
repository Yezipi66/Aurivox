// =============================================================================
//  bootstrap.node.test.js — tools/deploy/bootstrap.js 的守卫
//
//  部署脚本的两条血泪教训各对应一条守卫。两条都是**真机上赔过代价**的：
//
//  1. ⛔ **绝不调 npm.cmd**。它先跑 npm-prefix.js 问「npm 在哪」，而那个脚本靠
//     「PATH 上有没有 npm」回答 ⇒ 机器上一旦装过全局 Node（很常见），
//     它就跳到全局那份，版本对不上，报 ERR_REQUIRE_ESM，
//     而**错误里一个字都不提这件事**。
//     ⛔ 升 Node 修不了 —— 新版 Node 自带同一份 npm-prefix.js、同一套推断。
//     ⭐ 解法：直接 `node node_modules/npm/bin/npm-cli.js`。
//     （原实测日志：deploy_20260929_214808.log，整台机器起不来。）
//
//  2. ⛔ 依赖安装失败时**不**退回带解析器重试。那份 requirements 是给
//     --no-deps 用的冻结快照，带解析器重跑只会翻出**纸面**冲突
//     （accelerate 1.14 要 torch>2.2 vs 钉死的 torch==2.2.0+cu121），
//     而它们在冻结环境里毫无影响 —— 那是红鲱鱼，会浪费几个钟头。
//
//  ⭐ 另外两条纪律：venv 不可搬运（所以要健康检查后重建）· 平台根 venv 与
//  引擎 venv 的分工（A16 之后 requirements-gpt-sovits.txt 是**引擎**的依赖）。
// =============================================================================

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const BODY_REL = 'tools/deploy/bootstrap.js'
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** 只取活代码（剥掉注释）—— ⭐ 扫文本之前先问「注释会不会被算进去」。
 *  本项目已经为这件事栽过四次；那条教训写在 lib/inference/configRepair.node.test.js 里。 */
function liveCode (rel) {
  return read(rel).split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
}

function runDryRun (extraArgs = []) {
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'deploy', 'bootstrap.js'), '--dry-run'].concat(extraArgs),
    { encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { NO_COLOR: '1' }) })
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

// ── 1. ⛔ 绝不调 npm.cmd ─────────────────────────────────────────────────────
test('⛔ 绝不调 npm.cmd（它按 PATH 推断 npm，装过全局 Node 的机器上会跳到全局）', () => {
  const code = liveCode(BODY_REL)
  // 主路径必须是 node + npm-cli.js
  assert.match(code, /npm-cli\.js/,
    '没有直调 npm-cli.js —— 那正是绕开前缀推断的写法')
  // ⛔ 活代码里不许把 npm.cmd 当成要执行的东西。
  //   ⭐ 注意要剥掉注释：这个文件头里**故意**写了 npm.cmd 的来历，
  //     那段是文档，删了就没法解释为什么必须绕开它。
  assert.ok(!/npmExe\s*=\s*[^;\n]*npm\.cmd/i.test(code),
    '活代码里把 npm.cmd 当成了 npm 执行入口')
  assert.ok(!/spawnSync\(\s*['"`]npm\.cmd/i.test(code),
    '活代码里直接 spawn 了 npm.cmd')
  // 而「为什么」必须留在文件里
  assert.match(read(BODY_REL), /ERR_REQUIRE_ESM/,
    'npm.cmd 的坑（ERR_REQUIRE_ESM）没有记录在案 —— 后人会重新踩一次')
})

// ── 2. ⛔ --no-deps 失败不退回解析器 ─────────────────────────────────────────
test('⛔ 依赖安装失败时不退回带解析器重试（那只会翻出纸面冲突）', () => {
  const code = liveCode(BODY_REL)
  // 判据：**凡是装那份冻结锁的命令，都必须带 --no-deps**。
  // ⭐ 找的是「提到 REQ 的那些 install 调用」，而不是全文搜 --no-deps ——
  //   后者会因为「pip check」「hf_transfer」这些无关的 install 而失去意义。
  const reqInstalls = code.split('\n')
    .filter(l => /\b(REQ|reqPath)\b/.test(l) && /install/.test(l))
  assert.ok(reqInstalls.length >= 1,
    '找不到装那份冻结锁的命令 —— 判据本身失效了（守卫不能因为没找到而通过）')
  for (const l of reqInstalls) {
    assert.match(l, /--no-deps/,
      `装冻结锁的命令漏了 --no-deps：${l.trim()}\n`
      + '  带解析器会翻出「纸面冲突」（accelerate 1.14 要 torch>2.2 vs 钉死的 '
      + 'torch==2.2.0+cu121）—— 它们在冻结环境里毫无影响，是红鲱鱼。')
  }
  // ⛔ 而明确不许有「失败后再跑一次不带 --no-deps」的分支。
  //   判据是「文件里不许同时出现 install 与 retry 两个词」——
  //   ⭐ 这条故意用粗判据：它拦的是「有人加了一行重试」，而那种改动
  //   本来就该被拦下讨论，不值得为它写一个精确的正则。
  assert.ok(!/retry/i.test(code),
    '出现了 retry —— 依赖安装失败后不许重试：那份快照是给 --no-deps 用的')
})

// ── 3. ⭐ venv 不可搬运 ⇒ 必须健康检查后重建 ────────────────────────────────
test('⭐ venv 要健康检查，坏了才重建（venv 不可搬运）', () => {
  const code = liveCode(BODY_REL)
  // 健康检查 = 真的跑一次解释器
  assert.match(code, /'import sys'/, '没有对现有 venv 做健康检查（只 Test-Path 不算数）')
  // 坏了要重建，且重建要清掉旧的
  assert.match(code, /rmSync\(\s*VENV|rm -rf.*VENV|Remove-Item.*VENV/,
    '坏掉的 venv 没有被清掉重建')
  // 而解释器路径必须按平台推导，不能硬编码 Scripts\python.exe
  assert.ok(!/Scripts\\python\.exe/.test(liveCode(BODY_REL)),
    '活代码里出现了硬编码的 Scripts\\python.exe —— macOS/Linux 的 venv 是 bin/python')
  assert.match(code, /venvPython\(/, '没有走 platformPaths.venvPython 推导 venv 解释器')
})

// ── 4. ⭐ 两份 requirements 的分工（A16 之后）───────────────────────────────
test('⭐ --platform-only 切的是 requirements，而默认不切', () => {
  const code = liveCode(BODY_REL)
  assert.match(code, /requirements-platform\.txt/, '--platform-only 没有切到平台那份')
  assert.match(code, /requirements-gpt-sovits\.txt/,
    '默认那份不在 —— 它现在是**引擎**的依赖（A16 更名）')
  // ⛔ 默认必须装引擎那份（保持原样），只有开关才切
  assert.match(code, /PLATFORM_ONLY\s*\?\s*'requirements-platform\.txt'\s*:\s*'requirements-gpt-sovits\.txt'/,
    '默认与开关的对应关系变了 —— ⭐ 默认必须是「不切」，否则老用户行为突变')
})

// ── 5. ⭐ torch 不可用必须**明写**，且不误报成「装失败」────────────────────
test('⭐ --platform-only 跳过 torch 时不许报成「装失败」', () => {
  const src = read(BODY_REL)
  // 跳过时要说清是「按要求没装」
  assert.match(src, /未安装（--platform-only/,
    '跳过 torch 时没有明写「按要求没装」')
  // 而不是 MISSING / FAILED
  // ⚠️⚠️ 必须**剥掉注释**再查 —— 这条守卫第一版栽在这里：
  //   「按要求跳过」那一支上方的**注释**里就写着
  //   「⛔ 不许报成 MISSING/FAILED」，而那句注释正好在 slice 范围内
  //   ⇒ 守卫读到自己的说明书，然后判自己不合格。
  //   ⭐ 本项目第四次为「文本扫描撞注释」栽倒（前三次见
  //     lib/inference/configRepair.node.test.js 头部那段总结）。
  const summary = liveCode(BODY_REL).slice(
    liveCode(BODY_REL).indexOf('部署结果小结'))
  const skipBlock = summary.slice(0, summary.indexOf('else if (TORCH_OK)'))
  assert.ok(!/MISSING|FAILED/.test(skipBlock),
    '「按要求跳过」那一支的**活代码**里出现了 MISSING/FAILED —— 用户会以为装失败，'
    + '然后去补装那 5-6GB，正好把「平台瘦下来」这件事抵消掉')
})

// ── 6. ⭐ 无终端时绝不读 stdin（否则 CI 上会挂到超时）───────────────────────
test('⭐ 没有终端时不读 stdin（否则 CI 上会挂死等一个不会来的回答）', () => {
  const src = read(BODY_REL)
  const q = src.indexOf("Download models now?")
  assert.ok(q > 0, '找不到交互提问 —— 那么就该断言它被 TTY 门控')
  const before = src.slice(Math.max(0, q - 1200), q)
  assert.match(before, /isTTY/,
    '交互提问没有被 isTTY 门控 —— 在 CI / 管道里它会一直等输入')
})

// ── 7. 薄壳纪律 + ASCII + 旧实现不复存在 ────────────────────────────────────
test('bootstrap 的薄壳都调同一份 Node 主体，且不含逻辑', () => {
  for (const rel of ['tools/deploy/bootstrap.bat', 'tools/deploy/bootstrap.sh']) {
    const src = read(rel)
    assert.match(src, /bootstrap\.js/, `${rel} 没有指向主体`)
    assert.ok(!/venvPython|Scripts|pip.*install|npm-cli/.test(src),
      rel + ' 薄壳里出现了主体逻辑 ⇒ 两边会行为分叉')
  }
})

test('⛔ .bat 必须是纯 ASCII（.sh 不受这条约束）', () => {
  // ⚠️ 第一版把这条也套到了 .sh 上，于是它红了 —— 而 .sh **可以**含中文：
  //   bash 按 UTF-8 读脚本，不存在 cmd.exe 那种 OEM 代码页问题。
  //   ⭐ 这条约束的成因**只有一个**：cmd.exe。把它套到 .sh 上就是
  //   「把判据与它的成因分开」，那样的守卫会逼下一个人去做无意义的改写。
  for (const rel of ['tools/deploy/bootstrap.bat',
    'tools/deploy/install-torch.bat', 'tools/scripts/start.bat',
    'tools/scripts/stop.bat', 'start.bat', 'stop.bat']) {
    const buf = fs.readFileSync(path.join(ROOT, rel))
    const bad = [...buf].filter(b => b > 127).length
    assert.equal(bad, 0, `${rel} 里有 ${bad} 个非 ASCII 字节（cmd.exe 按 GBK 读 .bat）`)
  }
})

test('旧的 bootstrap.ps1 已不存在（两份实现 = 迟早不一致）', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'tools', 'deploy', 'bootstrap.ps1')),
    'tools/deploy/bootstrap.ps1 又出现了。主体在 tools/deploy/bootstrap.js，'
    + '薄壳是 bootstrap.bat / bootstrap.sh。')
})

// ── 8. ⭐ --dry-run 必须真的什么都不做 ──────────────────────────────────────
test('⭐ --dry-run 报告了要动的东西，且没开始安装', () => {
  const { rc, out } = runDryRun()
  assert.equal(rc, 0, '--dry-run 不该失败：\n' + out)
  // 报告里逐项说清
  for (const item of ['解释器', 'venv 解释器', 'requirements', '本地 wheel', 'torch', 'npm']) {
    assert.ok(out.includes(item), `--dry-run 的报告里没有「${item}」这一项`)
  }
  // ⭐ 绝对不能出现的：任何一句「正在装」/「已完成」
  for (const started of ['installing with uv', 'installing with pip', 'venv created',
    'dependencies installed', 'restoring backend node deps']) {
    assert.ok(!out.includes(started),
      `--dry-run 的输出里出现了「${started}」—— 它开始了安装`)
  }
})

test('⭐ --dry-run --platform-only 切到平台那份且跳过 torch', () => {
  const { rc, out } = runDryRun(['--platform-only'])
  assert.equal(rc, 0, out)
  assert.match(out, /requirements-platform\.txt/)
  assert.match(out, /torch\s+跳过（--platform-only）/)
})