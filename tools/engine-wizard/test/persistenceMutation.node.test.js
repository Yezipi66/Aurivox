'use strict'
// 变异测试 ： 把「修好的写法」退回「旧写法」，验证守卫断言真的会红
//
// 为什么必须做：新写的测试全绿，不等于这条路径被守住了。判据只有一条：
//    把实现改回旧写法，守卫它的那条断言必须失败。红了 ⇒ 守卫活着；
//    没红 ⇒ 那条断言是个摆设（比没有更坏，它给人安全感）。
//
// 做法：把源文件复制到本进程私有的临时目录、改成旧写法，然后在进程内
//    重新加载那份副本，当场跑守卫断言。
//    不许 spawn 子进程 ： 从 node --test 内部
//      spawnSync('node --test <file>') 拿到的是「status=0 且空输出」，
//      子进程一条测试都没跑 ⇒ 每次变异都假绿。子进程这条路不通。
//    不许就地改写源文件 ： node --test 是多文件并行的，就地改的那几百
//      毫秒里另一个进程正好读到变异版，它自己的用例会假红。
//      复制到私有沙盒目录，真实源文件一个字节都不动。

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
// id 校验（MISSING_ID）与目录名单源（folderName）也要变异
const CLONE = path.join(ROOT, 'tools', 'engine-wizard', 'core', 'clone.js')
const FOLDER_NAME = path.join(ROOT, 'tools', 'engine-wizard', 'editor', 'folderName.js')

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
 * 把源文件复制到本进程私有的临时目录、改成旧写法、重新加载，交给 probe
 * 跑守卫断言。真实源文件一个字节都不动。
 *
 * 为什么必须复制而不是就地改：`node --test` 是多文件并行的。
 *    就地改写 useInstallSession.js 的那几百毫秒里，另一个进程里的
 *    useInstallSession.node.test.js 刚好读到变异版 ⇒ 它自己的用例会假红。
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
  // 变异没生效就别跑：那种「没红」是文件没被改，不是守卫抓到
  assert.notStrictEqual(mutated, original,
    '⛔ 变异补丁没改到任何东西 —— 正则没匹配上，结论无效')
  bump += 1
  // 私有临时目录 + 原名：相对 import（./useInstallSession.js）才不会断
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-mut-'))
  const copy = path.join(sandbox, path.basename(src))
  try {
    fs.writeFileSync(copy, mutated, 'utf8')
    // 它 import 的兄弟模块也要复制过去（相对 import 按副本所在目录解析）
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
      // ESM：查询串绕开模块缓存（不能删 require.cache）
      //   Windows 上绝对路径必须先转 file:// URL，否则报
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

/** 断言这段守卫报了（守卫活着） */
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

test('变异⑤：reset 改删整个文件 ⇒ 只清自己那段守卫必须报', async () => {
  await mutateAndProbe(ISTATE, (s) => s.replace(
    /    fs\.writeFileSync\(f, JSON\.stringify\(clear\(sec\), null, 2\), 'utf8'\)/,
    '    fs.rmSync(f, { force: true }) // 变异：删整个文件'
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

test('变异⑥：downloadState 不把 url 传进会话模块 ⇒ 防串号守卫必须报', async () => {
  await mutateAndProbe(DLSTATE, (s) => s
    .replace(/const s = loadSession\(id, url\)/,
      "const s = loadSession(id, '') // 变异：拿到 url 却不往下传")
    .replace(/saveSession\(id, url, \{/,
      "saveSession(id, '', { // 变异：写也不带 url")
  , async (m) => {
    global.localStorage = new MockStorage()
    global.sessionStorage = new MockStorage()
    // 用变了异的门面自己存一份（写的是不带 url 的键）
    m.saveDownloadState('alpha', URL_A,
      { manifest: [{ name: 'a.bin' }], probeError: null, dedup: true })
    await assertGuardFires(() => {
      assert.strictEqual(m.loadDownloadState('alpha', URL_B), null,
        '换了 URL 还读到上一个仓库的下载清单 —— 这就是真机踩过的串号')
    }, 'downloadState 不传 url')
  })
})

test('变异⑦：删掉 clone.js 的 id 校验 ⇒ 空 id 守卫必须报', async () => {
  await mutateAndProbe(CLONE, (s) => s.replace(
    /  if \(typeof id !== 'string' \|\| !id\.trim\(\)\) \{\n    return \{ ok: false, code: 'MISSING_ID',\n      error: 'No directory name given\.\\n',\n      errorZh: '还没有填目录名。\\n'\n        \+ '请先填写目录名：它会成为 engines\/ 下的文件夹名，并作为 id 写入名片。\\n'\n        \+ '粘贴链接并解析成功后，目录名会自动填好。' \}\n  \}\n/,
    "  // 变异：删掉 id 校验，回到 2026-10-13 之前的写法\n"
  ), async (C) => {
    const root = mkdtempRoot()
    try {
      await assertGuardFires(() => {
        let threw = false
        let r = null
        try {
          r = C.buildClonePlan({ id: undefined, cloneUrl: 'https://x/y.git', root })
        } catch (e) {
          // 变异版命中真身：Node 的 path 参数报错
          threw = /must be of type string/.test(e.message)
        }
        const bad = threw || !r || r.ok !== false || r.code !== 'MISSING_ID'
        assert.ok(bad, '空 id 竟然没被拦下 —— 守卫没抓到')
      }, '删掉 clone.js 的 id 校验')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

test('变异⑧：目录名退化到持久段旧 id ⇒ 单源守卫必须报', async () => {
  await mutateAndProbe(FOLDER_NAME, (s) => s
    .replace(/export function folderName \(\{ typed, suggested \} = \{\}\) \{/,
      'export function folderName ({ typed, suggested, persistedId } = {}) {')
    .replace(/  if \(a\) return a\n/,
      "  if (a) return a\n  if (persistedId) return String(persistedId).trim() // 变异：旧 id 兜底\n")
  , async (m) => {
    await assertGuardFires(() => {
      assert.strictEqual(m.folderName({ typed: '', suggested: 'repo', persistedId: 'old' }),
        'repo', '输入框空时用了持久段的旧 id —— 这就是真机那个双目录名')
    }, '目录名退化到持久段旧 id')
  })
})

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
    // 判产物必须用另一个空目录 e2：e1 里已经有 .wizard-install.json，
    //   那本身就是「目录非空」⇒ 拿它判 cloned 会自己污染自己。
    fs.mkdirSync(path.join(root, 'engines', 'e2'), { recursive: true })
    const s = IS.installState(root, 'e2', { spawnProbe: () => true })
    assert.strictEqual(s.steps_done.prepare, false, '空目录不算克隆')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }

  // 新增的两条：未变异时必须安静
  // 这两个临时根都要显式清掉：⑧ 号用例在数 os.tmpdir() 里的
  //   `wizard-mut-*` 残留，漏一个就是那条用例假红。
  const C = require(CLONE)
  const mutRootA = mkdtempRoot()
  try {
    const cleanPlan = C.buildClonePlan({
      id: undefined, cloneUrl: 'https://x/y.git', root: mutRootA,
    })
    assert.strictEqual(cleanPlan.ok, false, '空 id 本就要被拦')
    assert.strictEqual(cleanPlan.code, 'MISSING_ID', '未变异时 code 就是 MISSING_ID')
  } finally { fs.rmSync(mutRootA, { recursive: true, force: true }) }
  const mutRootB = mkdtempRoot()
  try {
    const okPlan = C.buildClonePlan({
      id: 'good', cloneUrl: 'https://x/y.git', root: mutRootB,
    })
    assert.strictEqual(okPlan.ok, true, '⛔ 正常 id 被新校验挡住了')
  } finally { fs.rmSync(mutRootB, { recursive: true, force: true }) }

  const FN = require(FOLDER_NAME)
  assert.strictEqual(FN.folderName({ typed: '', suggested: 'repo', persistedId: 'old' }),
    'repo', '⛔ 未变异的 folderName 根本不该认 persistedId 这一位')
})

test('⛔ 变异用的临时目录必须清干净（mkdtemp + finally rmSync）', () => {
  const mine = fs.readdirSync(os.tmpdir())
    .filter((n) => /^wizard-mut-/.test(n))
  assert.deepStrictEqual(mine, [],
    '⛔ os.tmpdir() 里残留了变异沙盒目录：' + mine.join(', '))
})

test('⛔ 真实源文件不许被变异碰到（并行跑的其它测试文件还在读它）', () => {
  for (const f of [SESS, ISTATE, DLSTATE, CLONE, FOLDER_NAME]) {
    const s = fs.readFileSync(f, 'utf8')
    assert.ok(!/\/\/ 变异/.test(s),
      '⛔ ' + path.basename(f) + ' 里留着「变异」标记 —— 就地变异会污染并行测试')
  }
})
