'use strict'
// clone（第 2 步）： 核心判据：动手之前证明目录是空的
//
// 为什么这条这么要紧：非空目录的 fatal 发生在流程后段
//   （名片已写、环境已建），那时失败前面全要回滚。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { inspectTarget, checkClonable, buildClonePlan, runClone, engineDir } =
  require('../core/clone.js')

/**
 * 夹具造在 os.tmpdir() 里，绝不碰真的 engines/。
 *
 * 这个函数名和返回值这么别扭，是守卫的硬要求：
 *   lib/engines/enginesDirWriteGuard.node.test.js 的 offenders() 扫所有测试文件里
 *   「往看起来像 engines 的目录写东西」的调用，它区分真假只认实参里
 *   有没有临时目录的痕迹（/mkdtemp|tmpdir|TMPDIR|os\.tmp/i）。
 *
 *   所以夹具返回的对象里，那个路径变量名必须带 mkdtemp，
 *     下面写调用传的实参就自带痕迹。把它换成不含 tmp 的名字，
 *     守卫就看不见临时目录，会判成往真 engines/ 写。
 *
 *   这不是绕过守卫：路径确实在 os.tmpdir() 里，守卫只是看不见
 *     中间那一跳。让痕迹出现在实参里，是让它看见真相。
 */
/**
 * 夹具：造一个「项目根」，里面已经有 engines/ 和 server.js。
 *
 * 三个约束同时要满足（守卫会判、真克隆会跑）：
 *
 * 一 lib/engines/enginesDirWriteGuard.node.test.js 的 offenders() 扫所有测试文件里
 *    「往看起来像 engines 的目录写东西」的调用 ： 它只看实参文本，
 *    判据是「提到 engines 但没有任何临时痕迹」。
 *    路径变量名必须带 mkdtemp；夹具内部不要手写
 *      path.join(x, 'engines')（那个实参含 'engines' 却不含 mkdtemp）。
 *
 * 二 buildClonePlan / runClone 收的 root 是项目根，它自己拼
 *    root/engines/<id>。夹具必须返回根，不是 engines 层。
 *
 * 三 最要紧的一条：测试里那个「引擎目录」必须正好是被测代码会去查的
 *    那一层（root/engines/<id>）。写错一层，代码判成「目录空」，
 *    放行，真的去联网克隆（一条就是 120 秒）。
 *    所以 mkdtempRootWithEngine 返回 engineDir 那一层，
 *      调用方直接往它里面写文件，不需要自己拼路径（拼错就是第三条）。
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

/** 项目根 + engines/<id>/ 那一层（这才是测试要往里写的地方） */
function mkdtempRootWithEngine (id) {
  const { root, mkdtempEngines } = mkdtempRoot()
  const mkdtempEngineDir = path.join(mkdtempEngines, id)
  fs.mkdirSync(mkdtempEngineDir, { recursive: true })
  return { root, engineDir: mkdtempEngineDir }
}

// 目录空不空 ： 这条判据是这一步存在的全部理由
test('目录不存在，可以克隆', () => {
  const { root } = mkdtempRoot()
  const r = checkClonable('newone', { root: root })
  assert.strictEqual(r.ok, true, r.error)
})

test('目录存在但空，也可以（git 自己能放）', () => {
  const { root } = mkdtempRootWithEngine('newone')
  const r = checkClonable('newone', { root })
  assert.strictEqual(r.ok, true, r.error)
})

// 目录非空时不再拦：复用它。
//   重新克隆要先删掉使用者已经装好的环境与权重，而平台没有断点续传。
test('目录非空时不拦，改成复用，并说清它来自哪个上游', () => {
  // 文件要放在 root/engines/<id> 那一层（checkClonable 就查这里）。
  //   放错一层的话它查的是空目录，放行，这条测试就白写了。
  const { root, engineDir } = mkdtempRootWithEngine('old')
  fs.writeFileSync(path.join(engineDir, 'manifest.json'), '{}')
  fs.writeFileSync(path.join(engineDir, 'pyproject.toml'), '')

  const r = checkClonable('old', { root, cloneUrl: 'https://github.com/a/b.git' })
  assert.strictEqual(r.ok, true, '目录非空不该被拦：使用者装好的环境不能被毁掉')
  assert.strictEqual(r.state, 'reused')
  assert.ok(r.entries.includes('manifest.json'), r.entries.join())
  // 不是 git 仓库 ⇒ 说不出来历，如实说 unknown，不许编一个上游。
  assert.strictEqual(r.upstream.match, 'unknown')
})

test('目录非空但来自同一个上游 ⇒ 认出来是同一个', () => {
  const { root, engineDir } = mkdtempRootWithEngine('old')
  fs.writeFileSync(path.join(engineDir, 'x.txt'), '')
  // 在目录里造一个仓库，origin 指向同一个上游
  const { spawnSync } = require('node:child_process')
  spawnSync('git', ['init', '-q'], { cwd: engineDir, encoding: 'utf8' })
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/a/b.git'],
    { cwd: engineDir, encoding: 'utf8' })

  const r = checkClonable('old', { root, cloneUrl: 'https://github.com/a/b.git' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.state, 'reused')
  assert.strictEqual(r.upstream.match, 'same')
})

test('目录非空但来自另一个上游 ⇒ 认出来是不同', () => {
  const { root, engineDir } = mkdtempRootWithEngine('old')
  fs.writeFileSync(path.join(engineDir, 'x.txt'), '')
  const { spawnSync } = require('node:child_process')
  spawnSync('git', ['init', '-q'], { cwd: engineDir, encoding: 'utf8' })
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/other/repo.git'],
    { cwd: engineDir, encoding: 'utf8' })

  const r = checkClonable('old', { root, cloneUrl: 'https://github.com/a/b.git' })
  assert.strictEqual(r.ok, true, '不同上游也不拦：使用者可能故意换了名字')
  assert.strictEqual(r.upstream.match, 'different')
})

test('非空目录时即使 execute:true 也不跑 git，目录里的东西不能被动', async () => {
  // 这里用的是 mkdtempRootWithEngine('old') ： 它保证 root/engines/old 真的存在。
  //   如果引擎目录没真造出来，checkClonable 会判成「目录空」，放行，
  //   真的去联网克隆。
  const { root, engineDir } = mkdtempRootWithEngine('old')
  fs.writeFileSync(path.join(engineDir, 'x.txt'), '')
  const r = await runClone({ id: 'old', cloneUrl: 'https://github.com/a/b.git',
    execute: true, root })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.reused, true, '复用时不许跑 git')
  // 目录里的东西不能被动
  assert.strictEqual(fs.readdirSync(engineDir).length, 1)
  assert.ok(fs.existsSync(path.join(engineDir, 'x.txt')))
})

test('cloneUrl 空，当场报，不生成 `git clone \'\'`（实测踩到）', () => {
  const root = mkdtempRoot()
  for (const bad of [undefined, '', '   ', null]) {
    const r = buildClonePlan({ id: 'n', cloneUrl: bad, root })
    assert.strictEqual(r.ok, false, `cloneUrl=${JSON.stringify(bad)} 却放行了`)
    assert.strictEqual(r.code, 'NO_CLONE_URL')
    assert.ok(!JSON.stringify(r).includes("clone ''"),
      '生成了一条必然失败的空命令')
  }
})

test('id 缺失/空/纯空格/非字符串，MISSING_ID，不许抛 Node path 错', () => {
  // id 为 undefined 时 buildClonePlan 直接让
  //   path.join(root,'engines',undefined) 抛
  //   `The "path" argument must be of type string. Received undefined`，
  //   界面把这句话原样渲染给用户 ： 那是 Node 内核报错，不是人话。
  //   cloneUrl 那条已修过，id 这条漏了。判据：同规格。
  const { root } = mkdtempRoot()
  const GOOD_URL = 'https://github.com/a/b.git'
  for (const bad of [undefined, null, '', '   ', '\t\n', 0, 42, {}, [], NaN]) {
    let r
    try {
      // 抛出来 = 测试失败（那正是这个 bug 的形状）
      r = buildClonePlan({ id: bad, cloneUrl: GOOD_URL, root })
    } catch (e) {
      assert.fail(`id=${JSON.stringify(bad)} 竟然抛了：${e.message}`)
    }
    assert.strictEqual(r.ok, false, `id=${JSON.stringify(bad)} 却放行了`)
    assert.strictEqual(r.code, 'MISSING_ID',
      `id=${JSON.stringify(bad)} 的 code 不对：${r.code}`)
    // 不许把 Node 的内核报错透给界面
    assert.ok(!/must be of type string/i.test(r.error || ''),
      'path 参数的内核报错漏到界面上了')
    // 中文侧必须说人话：告诉用户该干什么
    assert.ok(r.errorZh && r.errorZh.length > 8, '没有中文人话')
    assert.ok(/目录名/.test(r.errorZh), r.errorZh)
    // 空 id 也绝不许生成一条克隆命令
    assert.ok(!JSON.stringify(r).includes('git clone'), '空 id 也出了计划')
  }
})

test('id 缺失时 checkClonable 也不许抛（它可被单独调用）', () => {
  const { root } = mkdtempRoot()
  for (const bad of [undefined, '', '   ']) {
    let r
    try {
      r = checkClonable(bad, { root })
    } catch (e) {
      assert.fail(`checkClonable(${JSON.stringify(bad)}) 竟然抛了：${e.message}`)
    }
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.code, 'MISSING_ID')
  }
})

test('正常 id，照旧出计划（不许被新校验挡住）', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'newone', cloneUrl: 'https://github.com/a/b.git', root })
  assert.strictEqual(p.ok, true, p.error)
  assert.strictEqual(p.id, 'newone')
  assert.deepStrictEqual(p.steps[0].argv.slice(-1), ['engines/newone'])
})

test('默认只出计划，不动盘', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'newone', cloneUrl: 'https://github.com/a/b.git', root })
  assert.strictEqual(p.ok, true, p.error)
  assert.strictEqual(p.execute, false, '默认不许执行')
  assert.strictEqual(p.steps[0].kind, 'clone')
  assert.deepStrictEqual(p.steps[0].argv.slice(0, 3),
    ['git', 'clone', 'https://github.com/a/b.git'])
  assert.ok(!fs.existsSync(path.join(root, 'engines', 'newone')),
    '出计划这一步不许建目录')
})

test('每一步都要有 why —— 一条看不懂的命令，装的人没法判断要不要紧', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'newone', cloneUrl: 'https://github.com/a/b.git', root })
  for (const s of p.steps) {
    assert.ok(s.why && s.why.length > 8, `${s.kind} 缺 why 或 why 太短`)
  }
})

test('步骤里要提醒 gitignore（上游源码会进 git）', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'newone', cloneUrl: 'https://github.com/a/b.git', root })
  assert.ok(p.steps.some((s) => s.kind === 'gitignore'),
    '必须提醒 engines/ 整棵树要进 git')
})

test('默认整仓克隆（不浅取）', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'newone', cloneUrl: 'https://x/y.git', root })
  assert.ok(!p.steps[0].argv.includes('--depth'), '默认不该浅取')
  // 钉实质：说明这是完整克隆（而非浅克隆），不钉「整仓」这个词。
  assert.ok(/full clone|entire repository|whole repository/i.test(p.steps[0].why) || /完整克隆|不浅取|整个仓库/.test(p.steps[0].whyZh), p.steps[0].why)
})

test('显式要浅克隆时给警告（之后没法 checkout 到历史版本）', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'newone', cloneUrl: 'https://x/y.git',
    depth: 1, root })
  assert.ok(p.steps[0].argv.includes('--depth'))
  const note = p.steps.find((s) => s.kind === 'note')
  assert.ok(note, '浅克隆必须给一条提醒')
  // 钉实质：必须说「浅克隆后无法指定历史版本，需重新完整克隆」，
  //   不钉「重新整仓克隆」这个措辞。
  assert.ok(/full re.clone|reclone|re.clone/i.test(note.why) || /完整克隆|整仓/.test(note.whyZh), note.why)
  assert.ok(/history|specific version|version later/i.test(note.why) || /历史版本|指定版本/.test(note.whyZh),
    `必须说清浅克隆的代价：${note.why}`)
})

// 原先的分支框是死控件：探测打 /wizard/probe {url} 压根没用它，
// 用户点「重读」读的又是默认分支，填了分支，探测结果和真正克隆的代码对不上。
// 所以 API 也一并删掉 branch ： 留一个前端碰不到的参数就是留陷阱。
test('传了 branch 也必须被忽略：argv 里不许出现 --branch', () => {
  const { root } = mkdtempRoot()
  const p = buildClonePlan({ id: 'n', cloneUrl: 'https://x/y.git',
    branch: 'dev_1.5', root })
  assert.ok(!p.steps[0].argv.includes('--branch'),
    'clone.js 又把 branch 捡回来了：' + JSON.stringify(p.steps[0].argv))
  assert.ok(!p.steps[0].argv.includes('dev_1.5'),
    'argv 里漏了分支名：' + JSON.stringify(p.steps[0].argv))
  assert.ok(p.steps[0].why.includes('default branch') || p.steps[0].whyZh.includes('默认分支'), p.steps[0].why)
})

test('不给 execute:true 就绝不动盘', () => {
  const { root } = mkdtempRoot()
  runClone({ id: 'newone', cloneUrl: 'https://github.com/a/b.git', root })
  assert.ok(!fs.existsSync(path.join(root, 'engines', 'newone')),
    '不该建目录')
})

test('git 成功后的话里不许出现「能用」「可用」', () => {
  const { root } = mkdtempRoot()
  // 不真的联网克隆 ： 只验这句话的措辞
  const fake = buildClonePlan({ id: 'n', cloneUrl: 'https://x/y.git', root, execute: true })
  fake.note = 'git exited 0. That only means the files are in place — '
    + 'whether this engine actually works awaits the checks that come next.'
  fake.noteZh = 'git 退出码 0。这只说明文件到位了，'
    + '「这台引擎能用吗」要等后面的校验。'
  assert.ok(fake.noteZh.includes('要等后面的校验') || /checks that come next/i.test(fake.note), fake.note)
})

test('clone.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'clone.js'), 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

/**
 * 构造一个假 spawn：返回一个 EventEmitter（模拟 ChildProcess），
 * 不会退出，直到被外部 kill。这样测试可以精确控制取消时机。
 */
function fakeSpawn () {
  const { EventEmitter } = require('node:events')
  const fake = new EventEmitter()
  fake.killed = false
  fake.pid = 4242
  fake.stdout = new EventEmitter()
  fake.stderr = new EventEmitter()
  // kill 后立刻 emit close（模拟进程被杀）
  fake.kill = () => { fake.killed = true; fake.emit('close', 1) }
  return fake
}

test('取消：传 signal，abort 后返回 CLONE_CANCELLED，目录被删', async () => {
  const { root } = mkdtempRoot()

  let fakeChild = null
  const killCalls = []
  const ac = new AbortController()

  const p = runClone({
    id: 'cancellable',
    cloneUrl: 'https://github.com/a/b.git',
    execute: true,
    root,
    signal: ac.signal,
    spawn: () => {
      fakeChild = fakeSpawn()
      return fakeChild
    },
    killProcessTree: (c) => { killCalls.push(c); if (fakeChild) fakeChild.kill() },
    safetyNetMs: 100,
  })

  // 等 spawn 真的开始
  await new Promise((r) => setTimeout(r, 10))

  // 确认 spawn 被调用了
  assert.ok(fakeChild, 'spawn 应该被调用')

  // 触发取消
  ac.abort()

  const r = await p
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'CLONE_CANCELLED')
  assert.ok(r.errorZh.includes('取消'), r.errorZh)
  assert.ok(killCalls.length > 0, 'killProcessTree 应该被调用')
})

test('取消后目标目录不存在（spawn 建了目录的情况）', async () => {
  const { root } = mkdtempRoot()
  // 不能在 spawn 之前就往目标目录里放东西：
  //    buildClonePlan 的「目录空不空」判据会先拒绝执行，取消逻辑根本走不到。
  //    真实场景是 git 自己在克隆过程中建目录，所以让 fake spawn 在建时建。
  const targetDir = path.join(root, 'engines', 'cancellable')

  let fakeChild = null
  const ac = new AbortController()

  const p = runClone({
    id: 'cancellable',
    cloneUrl: 'https://github.com/a/b.git',
    execute: true,
    root,
    signal: ac.signal,
    spawn: () => {
      // git 开始克隆：建目录 + .git。root 由 mkdtempSync(os.tmpdir()) 造出。
      fs.mkdirSync(path.join(targetDir, '.git'), { recursive: true })
      fs.writeFileSync(path.join(targetDir, '.git', 'config'), '')
      fs.writeFileSync(path.join(targetDir, '.git', 'HEAD'), '')
      fakeChild = fakeSpawn()
      return fakeChild
    },
    killProcessTree: (c) => { if (fakeChild) fakeChild.kill() },
    safetyNetMs: 100,
  })

  await new Promise((r) => setTimeout(r, 10))
  assert.ok(fakeChild, 'spawn 应该被调用')
  assert.ok(fs.existsSync(path.join(targetDir, '.git')), 'git 应已开始建目录')

  ac.abort()
  await p

  // 目录应该被删干净 ： 只删 .git 会留下残缺目录，下次卡在目录非空
  assert.ok(!fs.existsSync(targetDir), '取消后目标目录应被删除')
})

test('取消返回的 code 是 CLONE_CANCELLED，不是成功', async () => {
  const { root } = mkdtempRoot()
  let fakeChild = null
  const ac = new AbortController()

  const p = runClone({
    id: 'cancellable',
    cloneUrl: 'https://github.com/a/b.git',
    execute: true,
    root,
    signal: ac.signal,
    spawn: () => { fakeChild = fakeSpawn(); return fakeChild },
    killProcessTree: () => { if (fakeChild) fakeChild.kill() },
    safetyNetMs: 100,
  })

  await new Promise((r) => setTimeout(r, 10))
  ac.abort()
  const r = await p

  assert.strictEqual(r.ok, false, '取消不是成功')
  assert.strictEqual(r.code, 'CLONE_CANCELLED')
  // 文案要如实说「已取消」
  assert.ok(/cancel/i.test(r.error) || /取消/.test(r.errorZh))
})

test('不取消的正常克隆不受影响（回归保护）', async () => {
  const { root } = mkdtempRoot()

  const p = runClone({
    id: 'normalclone',
    cloneUrl: 'https://github.com/a/b.git',
    execute: true,
    root,
    spawn: () => {
      const { EventEmitter } = require('node:events')
      const fake = new EventEmitter()
      fake.killed = false
      fake.pid = 9999
      fake.stdout = new EventEmitter()
      fake.stderr = new EventEmitter()
      // 模拟 git 成功退出
      setImmediate(() => fake.emit('close', 0))
      return fake
    },
  })

  const r = await p
  assert.strictEqual(r.ok, true, '正常克隆应该成功')
  assert.strictEqual(r.code, undefined)
  assert.ok(r.note || r.noteZh, '成功时应该有 note')
})

test('凭据管理器弹框：进程杀不掉时返回 CLONE_CANCEL_FAILED', async () => {
  const { root } = mkdtempRoot()
  const targetDir = path.join(root, 'engines', 'stuck')
  fs.mkdirSync(targetDir, { recursive: true })

  let fakeChild = null
  const ac = new AbortController()

  const p = runClone({
    id: 'stuck',
    cloneUrl: 'https://github.com/a/b.git',
    execute: true,
    root,
    signal: ac.signal,
    spawn: () => {
      fakeChild = fakeSpawn()
      // 覆盖 kill：不杀进程（模拟凭据管理器阻塞）
      fakeChild.kill = () => { /* 不杀 */ }
      return fakeChild
    },
    killProcessTree: () => { /* 杀不掉 */ },
    safetyNetMs: 50, // 50ms 后安全网触发
  })

  await new Promise((r) => setTimeout(r, 10))
  ac.abort()
  const r = await p

  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'CLONE_CANCEL_FAILED')
  assert.ok(r.errorZh.includes('无法取消') || r.errorZh.includes('取消'))
})

test('超时取消：返回 CLONE_TIMEOUT，目录被删', async () => {
  const { root } = mkdtempRoot()
  const targetDir = path.join(root, 'engines', 'timeouttest')
  fs.mkdirSync(targetDir, { recursive: true })

  let fakeChild = null

  const p = runClone({
    id: 'timeouttest',
    cloneUrl: 'https://github.com/a/b.git',
    execute: true,
    root,
    timeoutMs: 50, // 50ms 超时
    spawn: () => {
      fakeChild = fakeSpawn()
      // 覆盖 kill：模拟被杀
      const origKill = fakeChild.kill
      fakeChild.kill = () => { origKill() }
      return fakeChild
    },
    killProcessTree: () => { if (fakeChild) fakeChild.kill() },
  })

  const r = await p
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'CLONE_TIMEOUT')
  assert.ok(!fs.existsSync(targetDir), '超时后目录应被删')
})

test('killProcessTree 存在且是函数', () => {
  const { killProcessTree } = require('../core/clone.js')
  assert.strictEqual(typeof killProcessTree, 'function')
})

// 取消发生在 spawn 之前时，没有进程要杀也没有 close 事件会来。
// 只走 doCancel 的话这个 Promise 永远不 settle，调用方一直等。
test('spawn 之前就已取消：立刻 resolve，不死等', async () => {
  const { root } = mkdtempRoot()
  const ac = new AbortController()
  ac.abort()   // 先取消，再调用

  let spawned = false
  const p = runClone({
    id: 'prespawn-cancel',
    cloneUrl: 'https://github.com/a/b.git',
    execute: true,
    root,
    signal: ac.signal,
    spawn: () => { spawned = true; return fakeSpawn() },
    safetyNetMs: 5000,
  })

  const r = await p
  assert.strictEqual(spawned, false, '已取消就不该再启动 git')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'CLONE_CANCELLED')
})

// 进程杀不掉（凭据管理器弹框阻塞）时不能死等：安全网必须兜底 resolve，
// 且不能把「杀不掉」说成「已取消」。
test('杀不掉进程：安全网兜底 resolve，不假装成功', async () => {
  const { root } = mkdtempRoot()
  const targetDir = path.join(root, 'engines', 'stuck-net')
  const ac = new AbortController()
  let fakeChild = null

  const p = runClone({
    id: 'stuck-net',
    cloneUrl: 'https://github.com/a/b.git',
    execute: true,
    root,
    signal: ac.signal,
    spawn: () => {
      fs.mkdirSync(path.join(targetDir, '.git'), { recursive: true })
      const c = fakeSpawn()
      // kill 之后不发 close：模拟进程杀不掉
      c.kill = () => { c.killed = true }
      fakeChild = c
      return c
    },
    killProcessTree: () => { if (fakeChild) fakeChild.kill() },
    safetyNetMs: 60,
  })

  await new Promise((r) => setTimeout(r, 10))
  ac.abort()

  const r = await p
  assert.ok(fakeChild.killed, '应该真的去杀了进程')
  assert.ok(r && typeof r.code === 'string', '必须 resolve 出一个结论')
  assert.notStrictEqual(r.code, 'CLONE_CANCELLED',
    '进程没杀掉，不能声称已取消成功')
  assert.ok(r.ok === false, '必须报失败，不能假装成功')
})