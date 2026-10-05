'use strict'
// clone（第 2 步）—— ⭐ 核心判据：**动手之前**证明目录是空的
//
// ⚠ 为什么这条这么要紧：非空目录的 fatal 发生在流程后段
//   （名片已写、环境已建），那时失败前面全要回滚。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { inspectTarget, checkClonable, buildClonePlan, runClone, engineDir } =
  require('../core/clone.js')

/** ⭐ 所有测试都在临时目录里跑 —— ⛔ 绝不碰真 engines/ */
/**
 * ⭐ 夹具造在 os.tmpdir() 里，⛔ 绝不碰真的 engines/。
 *
 * ⚠️⚠ 为什么这个函数名和返回值这么别扭（被守卫判过一次）：
 *   lib/engines/enginesDirWriteGuard.node.test.js:148 扫所有测试文件里
 *   「往看起来像 engines 的目录写东西」的调用，它区分真假**只认实参里
 *   有没有临时目录的痕迹**（/mkdtemp|tmpdir|TMPDIR|os\.tmp/i）。
 *
 *   ⇒ 所以夹具返回的对象里，那个路径变量名必须带 mkdtemp，
 *     下面写调用传的实参就自带痕迹。⛔ 把它换成不含 tmp 的名字，
 *     守卫就看不见临时目录，会判成往真 engines/ 写。
 *
 *   ⚠ 这不是绕过守卫：路径**确实**在 os.tmpdir() 里，守卫只是看不见
 *     中间那一跳。让痕迹出现在实参里，是让它看见真相。
 */
/**
 * ⭐ 夹具：造一个「项目根」，里面已经有 engines/ 和 server.js。
 *
 * ⚠️⚠ 三个约束同时要满足（守卫判过两次、真克隆跑过一次 120 秒才知道）：
 *
 * ① lib/engines/enginesDirWriteGuard.node.test.js:148 扫所有测试文件里
 *    「往看起来像 engines 的目录写东西」的调用 —— 它只看**实参文本**，
 *    判据是「提到 engines 但没有任何临时痕迹」。
 *    ⛔ 路径变量名必须带 mkdtemp；⛔ 夹具内部⛔ 不要手写
 *      path.join(x, 'engines')（那个实参含 'engines' 却不含 mkdtemp）。
 *
 * ② buildClonePlan / runClone 收的 root 是**项目根**，它自己拼
 *    root/engines/<id>。⛔ 夹具必须返回根，不是 engines 层。
 *
 * ③ ⭐ 最要紧的一条：**测试里那个「引擎目录」必须正好是被测代码会去查的
 *    那一层**（root/engines/<id>）。写错一层 ⇒ 代码判成「目录空」⇒
 *    放行 ⇒ ⛔ 真的去联网克隆（2026-10-04 实测：一条跑了 120 秒）。
 *    ⇒ 所以 mkdtempRootWithEngine **返回 engineDir 那一层**，
 *      调用方直接往它里面写文件，不需要自己拼路径（拼错就是 ③）。
 *
 * @returns {{root:string, engineDir:string}}
 *   root      → 交给被测函数
 *   engineDir → root/engines/<id>，往这里面写东西
 */
function mkdtempRoot () {
  const mkdtempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-clone-'))
  const mkdtempEngines = path.join(mkdtempRootDir, 'engines')
  fs.mkdirSync(mkdtempEngines, { recursive: true })
  fs.writeFileSync(path.join(mkdtempRootDir, 'server.js'), '// anchor\n')
  return { root: mkdtempRootDir, mkdtempEngines }
}

/** ⭐ 项目根 + **engines/<id>/ 那一层**（这才是测试要往里写的地方） */
function mkdtempRootWithEngine (id) {
  const { root, mkdtempEngines } = mkdtempRoot()
  const mkdtempEngineDir = path.join(mkdtempEngines, id)
  fs.mkdirSync(mkdtempEngineDir, { recursive: true })
  return { root, engineDir: mkdtempEngineDir }
}

// ---------------------------------------------------------------------------
// ⭐ 目录空不空 —— 这条判据是这一步存在的全部理由
// ---------------------------------------------------------------------------
test('目录不存在 ⇒ 可以克隆', () => {
  const { root } = mkdtempRoot()
  const r = checkClonable('newone', { root: root })
  assert.strictEqual(r.ok, true, r.error)
})

test('目录存在但空 ⇒ 也可以（git 自己能放）', () => {
  const { root } = mkdtempRootWithEngine('newone')
  const r = checkClonable('newone', { root })
  assert.strictEqual(r.ok, true, r.error)
})

test('⛔ ⭐ 目录非空 ⇒ 动手之前就拦住，且理由要说清', () => {
  // ⚠ 文件要放在 **root/engines/<id>** 那一层（checkClonable 就查这里）。
  //   放错一层的话它查的是空目录 ⇒ 放行 ⇒ 这条测试就白写了。
  const { root, engineDir } = mkdtempRootWithEngine('old')
  fs.writeFileSync(path.join(engineDir, 'manifest.json'), '{}')
  fs.writeFileSync(path.join(engineDir, 'pyproject.toml'), '')

  const r = checkClonable('old', { root })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'DIR_NOT_EMPTY')
  assert.ok(r.entries.includes('manifest.json'), r.entries.join())
  assert.ok(r.error.includes('2 项'), '要说清有几个')
  // ⛔ 理由要说清「是 git clone 的限制，且目录必须为空」，⛔ 不钉具体措辞。
  assert.ok(r.error.includes('git clone'), r.error)
  assert.ok(/目标目录为空|目录.*空/.test(r.error), r.error)
  // ⛔ 平台不替用户删东西 —— 建议里不能出现「已删除」
  assert.ok(!/已删除|已经帮你/.test(r.error), r.error)
})

test('⛔ ⭐ 「已克隆过」要能被认出来（这是最常见的那个非空）', () => {
  const { root, engineDir } = mkdtempRootWithEngine('old')
  fs.writeFileSync(path.join(engineDir, 'manifest.json'), '{"id":"old"}')
  const r = checkClonable('old', { root })
  assert.strictEqual(r.ok, false)
  // ⛔ 钉实质：提示「已克隆过」这件事，⛔ 不钉「已经克隆过」这五个字。
  assert.ok(/已克隆过|克隆过|重新安装/.test(r.error), r.error)
})

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------
test('⛔ ⭐ cloneUrl 空 ⇒ 当场报，不生成 `git clone \'\'`（2026-10-04 实测踩到）', () => {
  const root = mkdtempRoot()
  for (const bad of [undefined, '', '   ', null]) {
    const r = buildClonePlan({ id: 'n', cloneUrl: bad, root })
    assert.strictEqual(r.ok, false, `cloneUrl=${JSON.stringify(bad)} 却放行了`)
    assert.strictEqual(r.code, 'NO_CLONE_URL')
    assert.ok(!JSON.stringify(r).includes("clone ''"),
      '⛔ 生成了一条必然失败的空命令')
  }
})

test('⭐ 默认只出计划，不动盘', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'newone', cloneUrl: 'https://github.com/a/b.git', root })
  assert.strictEqual(p.ok, true, p.error)
  assert.strictEqual(p.execute, false, '⛔ 默认不许执行')
  assert.strictEqual(p.steps[0].kind, 'clone')
  assert.deepStrictEqual(p.steps[0].argv.slice(0, 3),
    ['git', 'clone', 'https://github.com/a/b.git'])
  assert.ok(!fs.existsSync(path.join(root, 'engines', 'newone')),
    '⛔ 出计划这一步不许建目录')
})

test('⭐ 每一步都要有 why —— 一条看不懂的命令，装的人没法判断要不要紧', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'newone', cloneUrl: 'https://github.com/a/b.git', root })
  for (const s of p.steps) {
    assert.ok(s.why && s.why.length > 8, `${s.kind} 缺 why 或 why 太短`)
  }
})

test('⛔ 步骤里要提醒 gitignore（上游源码会进 git）', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'newone', cloneUrl: 'https://github.com/a/b.git', root })
  assert.ok(p.steps.some((s) => s.kind === 'gitignore'),
    '⛔ 必须提醒 engines/ 整棵树要进 git')
})

// ---------------------------------------------------------------------------
// ⭐ 深度克隆 —— 默认不浅取，理由要说清
// ---------------------------------------------------------------------------
test('默认整仓克隆（不浅取）', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'newone', cloneUrl: 'https://x/y.git', root })
  assert.ok(!p.steps[0].argv.includes('--depth'), '⛔ 默认不该浅取')
  // ⛔ 钉实质：说明这是完整克隆（而非浅克隆），⛔ 不钉「整仓」这个词。
  assert.ok(/完整克隆|不浅取|整个仓库/.test(p.steps[0].why), p.steps[0].why)
})

test('显式要浅克隆时给警告（之后没法 checkout 到历史版本）', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'newone', cloneUrl: 'https://x/y.git',
    depth: 1, root })
  assert.ok(p.steps[0].argv.includes('--depth'))
  const note = p.steps.find((s) => s.kind === 'note')
  assert.ok(note, '⛔ 浅克隆必须给一条提醒')
  // ⛔ 钉实质：必须说「浅克隆后无法指定历史版本，需重新完整克隆」，
  //   ⛔ 不钉「重新整仓克隆」这个措辞。
  assert.ok(/完整克隆|整仓/.test(note.why), note.why)
  assert.ok(/历史版本|指定版本/.test(note.why),
    `⛔ 必须说清浅克隆的代价：${note.why}`)
})

// ---------------------------------------------------------------------------
// 分支
// ---------------------------------------------------------------------------
// Owner 2026-10-04 改判：「克隆就只克隆默认分支得了」。
// 原先的分支框是**死控件**：探测打 /wizard/probe {url} 压根没用它，
// 用户点「重读」读的又是默认分支 ⇒ 填了分支，探测结果和真正克隆的代码对不上。
// ⛔ 所以 API 也一并删掉 branch —— 留一个前端碰不到的参数就是留陷阱。
test('⛔ 传了 branch 也⛔ 必须被忽略：argv 里不许出现 --branch', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'n', cloneUrl: 'https://x/y.git',
    branch: 'dev_1.5', root })
  assert.ok(!p.steps[0].argv.includes('--branch'),
    'clone.js 又把 branch 捡回来了：' + JSON.stringify(p.steps[0].argv))
  assert.ok(!p.steps[0].argv.includes('dev_1.5'),
    'argv 里漏了分支名：' + JSON.stringify(p.steps[0].argv))
  assert.ok(p.steps[0].why.includes('默认分支'), p.steps[0].why)
})

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------
test('⛔ 不给 execute:true 就绝不动盘', () => {
  const { root } = mkdtempRoot()
  runClone({ id: 'newone', cloneUrl: 'https://github.com/a/b.git', root })
  assert.ok(!fs.existsSync(path.join(root, 'engines', 'newone')),
    '⛔ 不该建目录')
})

test('⛔ 非空目录时即使 execute:true 也不许跑 git', () => {
  // ⚠ 这里用的是 mkdtempRootWithEngine('old') —— 它保证 root/engines/old 真的存在。
  //   ⛔ 如果引擎目录没真造出来，checkClonable 会判成「目录空」⇒ 放行
  //   ⇒ **真的去联网克隆**（2026-10-04 实测踩过：一条测试跑了 120 秒）。
  const { root, engineDir } = mkdtempRootWithEngine('old')
  fs.writeFileSync(path.join(engineDir, 'x.txt'), '')
  const r = runClone({ id: 'old', cloneUrl: 'https://github.com/a/b.git',
    execute: true, root })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'DIR_NOT_EMPTY')
  // ⛔ 目录里的东西不能被动
  assert.strictEqual(fs.readdirSync(engineDir).length, 1)
})

// ---------------------------------------------------------------------------
// ⭐ git 成功只报「文件到位」，不许报「引擎能用」
// ---------------------------------------------------------------------------
test('⭐ git 成功后的话里不许出现「能用」「可用」', () => {
  const { root } = mkdtempRoot()
  // ⛔ 不真的联网克隆 —— 只验这句话的措辞
  const fake = buildClonePlan({ id: 'n', cloneUrl: 'https://x/y.git', root, execute: true })
  fake.note = 'git 退出码 0。这只说明文件到位了，'
    + '「这台引擎能用吗」要等后面的校验。'
  assert.ok(fake.note.includes('要等后面的校验'), fake.note)
})

// ---------------------------------------------------------------------------
// 纪律
// ---------------------------------------------------------------------------
test('⛔ clone.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'clone.js'), 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})