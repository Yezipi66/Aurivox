'use strict'
// ============================================================================
//  变异测试 —— 把「修好的写法」退回「旧写法」，验证守卫断言**真的会红**
//
//  ⭐ 为什么必须做：新写的测试全绿，不等于这条路径被守住了。判据只有一条：
//    把实现改回旧写法，守卫它的那条断言必须失败。红了 ⇒ 守卫活着；
//    没红 ⇒ 那条断言是个摆设（比没有更坏，它给人安全感）。
//
//  ⚠ 做法：把源文件复制到**本进程私有的临时目录**、改成旧写法，然后在进程内
//    **重新加载那份副本**，当场跑守卫断言。
//    ⛔ 不许 spawn 子进程 —— 实测 2026-10-12：从 node --test 内部
//      spawnSync('node --test <file>') 拿到的是「status=0 且空输出」，
//      子进程一条测试都没跑 ⇒ 每次变异都假绿。子进程这条路不通。
//    ⛔⛔ 不许就地改写源文件 —— node --test 是多文件并行的，就地改的那几百
//      毫秒里另一个进程正好读到变异版，它自己的用例会假红（实测过）。
//      复制到私有沙盒目录，真实源文件一个字节都不动。
// ============================================================================

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SESS = path.join(ROOT, 'tools', 'engine-wizard', 'editor', 'useInstallSession.js')
const ISTATE = path.join(ROOT, 'tools', 'engine-wizard', 'core', 'installState.js')
const DLSTATE = path.join(ROOT, 'tools', 'engine-wizard', 'editor', 'downloadState.js')

class MockStorage {
  constructor () { this.data = new Map() }
  getItem (k) { return this.data.has(k) ? this.data.get(k) : null }
  setItem (k, v) { this.data.set(k, String(v)) }
  removeItem (k) { this.data.delete(k) }
  clear () { this.data.clear() }
  get size () { return this.data.size }
}

const URL_A = 'https://github.com/acme/alpha'
const URL_B = 'https://github.com/acme/beta'

let bump = 0

/**
 * 把源文件复制到**本进程私有的临时目录**、改成旧写法、重新加载，交给 probe
 * 跑守卫断言。真实源文件一个字节都不动。
 *
 * ⛔⛔ 为什么必须复制而不是就地改：`node --test` 是**多文件并行**的。
 *    就地改写 useInstallSession.js 的那几百毫秒里，另一个进程里的
 *    useInstallSession.node.test.js 刚好读到变异版 ⇒ 它自己的用例会
 *    假红（实测：并行跑时那两条防串号测试红灯，单独跑全绿）。
 *    那是把「变异测试」自己变成污染源，比没有变异更坏。
 *
 * @param {string} src 源文件
 * @param {(s:string)=>string} patchFn 变异：原文 ⇒ 旧写法
 * @param {(m:object)=>Promise<void>|void} probe 重新加载后的模块
 */
async function mutateAndProbe (src, patchFn, probe) {
  const original = fs.readFileSync(src, 'utf8')
  const mutated = patchFn(original)
  const isEsm = /^\s*(?:import|export)\s/m.test(original)
  // ⛔ 变异没生效就别跑：那种「没红」是文件没被改，不是守卫抓到
  assert.notStrictEqual(mutated, original,
    '⛔ 变异补丁没改到任何东西 —— 正则没匹配上，结论无效')
  bump += 1
  // ⭐ 私有临时目录 + 原名：相对 import（./useInstallSession.js）才不会断
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-mut-'))
  const copy = path.join(sandbox, path.basename(src))
  try {
    fs.writeFileSync(copy, mutated, 'utf8')
    // ⭐ 它 import 的兄弟模块也要复制过去（相对 import 按副本所在目录解析）
    for (const rel of [/from '\.\/([\w.-]+\.js)'/g]) {
      let mm
      while ((mm = rel.exec(mutated)) !== null) {
        const dep = path.join(path.dirname(src), mm[1])
        if (fs.existsSync(dep)) {
          fs.copyFileSync(dep, path.join(sandbox, mm[1]))
        }
      }
    }
    let m
    if (isEsm) {
      // ⭐ ESM：查询串绕开模块缓存（⛔ 不能删 require.cache）
      //   ⚠ Windows 上绝对路径必须先转 file:// URL，否则报
      //     ERR_UNSUPPORTED_ESM_URL_SCHEME（'d:' 不是协议）。
      m = await import(pathToFileURL(copy).href + '?mut=' + bump)
    } else {
      m = require(copy)
    }
    await probe(m)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

/** 断言这段守卫**报了**（守卫活着） */
async function assertGuardFires (fn, what) {
  let threw = false
  try { await fn() } catch (e) { threw = true }
  assert.ok(threw,
    '⛔ ' + what + '：变异后守卫竟然没报 ⇒ 那条断言是个摆设，守不住这条路径')
}

/** 造一个临时项目根（守卫 enginesDirWriteGuard 要求路径带临时痕迹） */
function mkdtempRoot () {
  const mkdtempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-mut-'))
  fs.mkdirSync(path.join(mkdtempRootDir, 'engines'), { recursive: true })
  fs.writeFileSync(path.join(mkdtempRootDir, 'server.js'), '// anchor\n')
  return mkdtempRootDir
}

// ---------------------------------------------------------------------------
//  ① 会话键里去掉 url ⇒ 「换 URL ⇒ 旧会话失效」必须报
// ---------------------------------------------------------------------------
test('变异①：会话键不含 url ⇒ 防串号守卫必须报', async () => {
  await mutateAndProbe(SESS, (s) => s.replace(
    /return NS \+ 'sess:' \+ String\(id \|\| ''\) \+ ':' \+ hashUrl\(url\)/,
    "return NS + 'sess:' + String(id || '') // 变异：只按 id 分键，回到串号那个写法"
  ), async (m) => {
    global.localStorage = new MockStorage()
    global.sessionStorage = new MockStorage()
    m.saveSession('alpha', URL_A, { probe: 1 })
    await assertGuardFires(() => {
      assert.strictEqual(m.loadSession('alpha', URL_B), null,
        '换了 URL 还读到旧仓库的探测结果')
    }, '会话键去掉 url')
  })
})

// ---------------------------------------------------------------------------
//  ② 会话段写盘改落 localStorage ⇒ 「探测结果不落 localStorage」必须报
//     ⚠ 变异点必须是 **saveSession 真正走到的那一行**（write('sessionStorage',…)），
//       ⛔ 不是那个没人调的 session() 辅助函数 —— 改它一条字节都不动，
//       守卫自然不会报，而那是「变异打空」不是「测试摆设」。
// ---------------------------------------------------------------------------
test('变异②：会话段改落 localStorage ⇒ 持久化纪律守卫必须报', async () => {
  await mutateAndProbe(SESS, (s) => s.replace(
    /write\('sessionStorage', key, next\)/,
    "write('localStorage', key, next) // 变异：会话段改落 localStorage"
  ), async (m) => {
    global.localStorage = new MockStorage()
    global.sessionStorage = new MockStorage()
    m.saveSession('alpha', URL_A, { probe: 1, depsPlan: 2 })
    await assertGuardFires(() => {
      assert.strictEqual(global.localStorage.size, 0, '探测结果写进 localStorage 了')
    }, '会话段落 localStorage')
  })
})

// ---------------------------------------------------------------------------
//  ③ writeProgress 整份重写 ⇒ 「两段互不干扰」必须报
// ---------------------------------------------------------------------------
test('变异③：进度写成整份覆盖 ⇒ 两段互不干扰守卫必须报', async () => {
  await mutateAndProbe(ISTATE, (s) => s.replace(
    /data\[sec\] = \{ done: \[\.\.\.doneKeys\]\.map\(\(key\) => \(\{ key, at \}\)\) \}/,
    "data = { engine: id, updatedAt: at, env: { done: [] }, models: { done: [] } } // 变异：整份重写"
  ), async (IS) => {
    const root = mkdtempRoot()
    try {
      fs.mkdirSync(path.join(root, 'engines', 'e1'), { recursive: true })
      IS.writeProgress(root, 'e1', 'env', new Set(['a']))
      IS.writeProgress(root, 'e1', 'models', new Set(['b']))
      IS.writeProgress(root, 'e1', 'env', new Set(['c']))
      await assertGuardFires(() => {
        assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'models')], ['b'],
          '写 env 段把 models 段抹掉了')
      }, 'writeProgress 整份重写')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

// ---------------------------------------------------------------------------
//  ④ installState 把「目录在」就当克隆完成 ⇒ 「空目录不算克隆」必须报
// ---------------------------------------------------------------------------
test('变异④：目录在就算克隆完成 ⇒ 空目录守卫必须报', async () => {
  await mutateAndProbe(ISTATE, (s) => s.replace(
    /const hasClone = dirHasContent\(dir\)/,
    'const hasClone = fs.existsSync(dir) // 变异：目录在就算克隆了'
  ), async (IS) => {
    const root = mkdtempRoot()
    try {
      fs.mkdirSync(path.join(root, 'engines', 'e1'), { recursive: true })
      const s = IS.installState(root, 'e1', { spawnProbe: () => true })
      await assertGuardFires(() => {
        assert.strictEqual(s.steps_done.prepare, false, '空目录被当成克隆完成')
      }, '目录在就算克隆')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

// ---------------------------------------------------------------------------
//  ⑤ resetProgress 改成删整个文件 ⇒ 「只清自己那一段」必须报
// ---------------------------------------------------------------------------
test('变异⑤：reset 改删整个文件 ⇒ 只清自己那段守卫必须报', async () => {
  await mutateAndProbe(ISTATE, (s) => s.replace(
    /try \{\n    fs\.writeFileSync\(f, JSON\.stringify\(clear\(sec\), null, 2\), 'utf8'\)/,
    'try {\n    fs.rmSync(f, { force: true }) // 变异：删整个文件'
  ), async (IS) => {
    const root = mkdtempRoot()
    try {
      fs.mkdirSync(path.join(root, 'engines', 'e1'), { recursive: true })
      IS.writeProgress(root, 'e1', 'env', new Set(['a']))
      IS.writeProgress(root, 'e1', 'models', new Set(['b']))
      IS.resetProgress(root, 'e1', 'env')
      await assertGuardFires(() => {
        assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'models')], ['b'],
          'reset env 段把 models 段也清了')
      }, 'reset 删整个文件')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

// ---------------------------------------------------------------------------
//  ⑥ downloadState 的调用退化成「不传 url」⇒ 换 URL 串号守卫必须报
//     ⚠ ⑥ 与 ① 的区别：① 打的是会话模块内部的键，⑥ 打的是**门面自己**
//       —— 门面拿到 url 却不往下传，会话模块再对也白搭（真机那个串号
//       就是这么来的：键对了，调用方没给）。
// ---------------------------------------------------------------------------
test('变异⑥：downloadState 不把 url 传进会话模块 ⇒ 防串号守卫必须报', async () => {
  await mutateAndProbe(DLSTATE, (s) => s
    .replace(/const s = loadSession\(id, url\)/,
      "const s = loadSession(id, '') // 变异：拿到 url 却不往下传")
    .replace(/saveSession\(id, url, \{/,
      "saveSession(id, '', { // 变异：写也不带 url")
  , async (m) => {
    global.localStorage = new MockStorage()
    global.sessionStorage = new MockStorage()
    // 用**变了异的门面自己**存一份（写的是不带 url 的键）
    m.saveDownloadState('alpha', URL_A,
      { manifest: [{ name: 'a.bin' }], probeError: null, dedup: true })
    await assertGuardFires(() => {
      assert.strictEqual(m.loadDownloadState('alpha', URL_B), null,
        '换了 URL 还读到上一个仓库的下载清单 —— 这就是真机踩过的串号')
    }, 'downloadState 不传 url')
  })
})

// ---------------------------------------------------------------------------
//  ⑦ 反向验证：**不改任何东西**时这些守卫必须安静
//     （否则上面那些「报了」是假象 —— 本来就在报）
// ---------------------------------------------------------------------------
test('反证：未变异时同类守卫全部安静（上面的红不是假象）', async () => {
  const m = await import(pathToFileURL(SESS).href + '?clean=' + (bump + 1))
  bump += 1
  global.localStorage = new MockStorage()
  global.sessionStorage = new MockStorage()
  m.saveSession('alpha', URL_A, { probe: 1 })
  assert.strictEqual(m.loadSession('alpha', URL_B), null, '换 URL 应失效')
  assert.ok(m.loadSession('alpha', URL_A), '同 id + url 应恢复')
  assert.strictEqual(global.localStorage.size, 0, '探测结果不落 localStorage')

  const IS = require(ISTATE)
  const root = mkdtempRoot()
  try {
    fs.mkdirSync(path.join(root, 'engines', 'e1'), { recursive: true })
    IS.writeProgress(root, 'e1', 'env', new Set(['a']))
    IS.writeProgress(root, 'e1', 'models', new Set(['b']))
    IS.writeProgress(root, 'e1', 'env', new Set(['c']))
    assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'models')], ['b'])
    IS.resetProgress(root, 'e1', 'env')
    assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'env')], [])
    assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'models')], ['b'])
    // ⚠ 判产物必须用**另一个**空目录 e2：e1 里已经有 .wizard-install.json，
    //   那本身就是「目录非空」⇒ 拿它判 cloned 会自己污染自己。
    fs.mkdirSync(path.join(root, 'engines', 'e2'), { recursive: true })
    const s = IS.installState(root, 'e2', { spawnProbe: () => true })
    assert.strictEqual(s.steps_done.prepare, false, '空目录不算克隆')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
//  ⑧ 副产物验证：变异用的临时目录必须清干净
//     （⛔ 在 os.tmpdir() 里留下一堆 .mut-* 是看不见的垃圾堆积）
// ---------------------------------------------------------------------------
test('⛔ 变异用的临时目录必须清干净（mkdtemp + finally rmSync）', () => {
  const mine = fs.readdirSync(os.tmpdir())
    .filter((n) => /^wizard-mut-/.test(n))
  assert.deepStrictEqual(mine, [],
    '⛔ os.tmpdir() 里残留了变异沙盒目录：' + mine.join(', '))
})

// ---------------------------------------------------------------------------
//  ⑨ 反向验证：真实源文件一个字节都没被改过
//     （⛔ 就地变异会污染并行跑的其它测试文件，见 mutateAndProbe 的头注）
// ---------------------------------------------------------------------------
test('⛔ 真实源文件不许被变异碰到（并行跑的其它测试文件还在读它）', () => {
  for (const f of [SESS, ISTATE, DLSTATE]) {
    const s = fs.readFileSync(f, 'utf8')
    assert.ok(!/\/\/ 变异/.test(s),
      '⛔ ' + path.basename(f) + ' 里留着「变异」标记 —— 就地变异会污染并行测试')
  }
})
