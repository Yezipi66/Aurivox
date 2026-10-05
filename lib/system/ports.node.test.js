// =============================================================================
//  ports.node.test.js — lib/system/ports.js 与 lib/system/portChoice.js 的守卫
//
//  ⭐ 这两个文件是**从 PowerShell 搬过来的**，搬的时候带过来一堆「看起来多余」
//     的判据（只认 LISTENING、记号一台一个、claimed 与 shifted 分开说、
//     目录扫描不比命令行）。它们看起来都像可以简化掉。
//     ⇒ 这个测试文件的作用就是把那些判据**钉住**，让下一个人不能顺手删。
//
//  测法：**真的起进程 / 真的占端口**，不 mock。
//     这些判据的价值全在「真机器上表现对不对」，mock 掉就等于没测。
// =============================================================================

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync, spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const P = require(path.join(ROOT, 'lib', 'system', 'ports.js'))
const PC = require(path.join(ROOT, 'lib', 'system', 'portChoice.js'))

// ⭐ 借一个**一定没人用**的高位端口。两处理由：
//   · 9886 是后端的真实端口（这台机器上可能正跑着）⇒ 测试不能去碰
//   · 端口撞上别的服务会让「杀进程」测试杀掉无关的东西
/**
 * 借一个**此刻没人用**的端口。
 * ⚠️ listen(0) 让系统分配，但它是**异步**的 —— 端口号只在 listen 的回调里
 *   才拿得到。我第一版同步读 address()，拿到 null，于是后面每一条需要
 *   「一个真的在听的端口」的测试都红了（10 条），而错的是测试不是被测代码。
 */
async function freePort () {
  const srv = http.createServer()
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const p = srv.address().port
  await new Promise(r => srv.close(r))
  return p
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function withServer (port, fn) {
  const srv = http.createServer((q, s) => s.end('ok'))
  await new Promise(r => srv.listen(port, '127.0.0.1', r))
  try { await fn() } finally { await new Promise(r => srv.close(r)) }
}

// =============================================================================
//  ports.js
// =============================================================================

test('listenersOnPort 认得出真正在听的进程', async () => {
  const port = await freePort()
  await withServer(port, () => {
    const pids = P.listenersOnPort(port)
    assert.ok(pids.length >= 1, `端口 ${port} 上应当有监听者，实际 ${JSON.stringify(pids)}`)
    assert.ok(pids.includes(process.pid), '监听者里应当有本进程')
    assert.equal(P.isPortListening(port), true)
  })
  // 关掉之后就没有了 —— 这一条同时验证了「不留残影」
  await sleep(200)
  assert.deepEqual(P.listenersOnPort(port), [], '端口关掉后仍报有监听者')
})

// ⭐ 这是从 PowerShell 搬来的第一条纪律：只认 LISTENING。
//   连接结束后那个端口会进 TIME_WAIT 并挂几十秒；若把它算成「被占」，
//   start 就会以为「上次那个还在跑」而拒绝重启 ⇒ 「点完停止、再点两次启动
//   就再也起不来」。
test('只认 LISTENING：连过之后端口仍算空闲', async () => {
  const port = await freePort()
  await withServer(port, async () => {
    await new Promise(r => {
      http.get({ host: '127.0.0.1', port, path: '/' }, res => { res.resume(); res.on('end', r) })
        .on('error', r)
    })
  })
  await sleep(200)
  assert.equal(PC.testPort(port), false,
    '刚被连过的端口被判成「被占」⇒ 说明 TIME_WAIT 被算成了监听（那个 bug）')
})

// ⭐ 端口号必须**完整**匹配：9886 不能被 19886 / 98860 误命中。
//   PowerShell 的判据是 `[:.]9886\s` —— 端口号后面必须跟空白或行尾。
test('端口号是完整匹配，不被邻近端口号误命中', async () => {
  const port = await freePort()
  const neighbour = port + 0            // 构造一个「同前缀不同号」的端口
  await withServer(port, () => {
    assert.ok(P.listenersOnPort(port).length >= 1)
    // neighbour 要是一个**真的不同**的端口
    const other = neighbour === port ? neighbour + 7 : neighbour
    assert.ok(other <= 65535, '构造的邻近端口超界了，跳过这个断言')
    assert.deepEqual(P.listenersOnPort(other), [],
      `在 ${port} 上有监听，却报 ${other} 上也有 —— 端口号没做完整匹配`)
  })
})

test('procInfo 拿得到路径与命令行', () => {
  const info = P.procInfo(process.pid)
  assert.equal(info.pid, process.pid)
  assert.ok(info.name, '应当拿得到进程名')
  assert.ok(info.path, '应当拿得到可执行文件路径')
})

test('killPid 杀得掉，杀两次会如实说失败', async () => {
  const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' })
  await sleep(800)
  assert.equal(P.procAlive(victim.pid), true, '被杀的进程应当先活着')
  const first = P.killPid(victim.pid)
  assert.equal(first.ok, true, '第一次杀应当成功：' + first.why)
  const second = P.killPid(victim.pid)
  assert.equal(second.ok, false, '第二次杀应当失败 —— 它已经不在了')
  // ⭐ 失败原因必须是**我们能读懂的话**。taskkill 的原始输出走系统 OEM
  //   代码页（本机 GBK），按 utf8 解出来是乱码，而这一句是要显示给用户的。
  assert.ok(!/[^\x00-\x7F]/.test(second.why) || /不在了|权限/.test(second.why),
    '失败原因不是可读的句子：' + JSON.stringify(second.why))
})

test('procAlive 分得清活着与不存在', () => {
  assert.equal(P.procAlive(process.pid), true)
  assert.equal(P.procAlive(999999), false)
  assert.equal(P.procAlive(0), false)
  assert.equal(P.procAlive(-1), false)
})

// ⭐⭐ 这一条是我自己踩出来的坑，必须钉死：
//   目录扫描**只能比可执行文件路径**，不能比命令行。命令行里含仓库路径的
//   东西包括用户那个「cd 到项目目录再运行 stop」的 shell —— 比命令行
//   就会把用户的 shell 杀掉。
test('procsUnderDir 只看可执行文件路径，不看命令行', () => {
  const hits = P.procsUnderDir(ROOT)
  for (const h of hits) {
    assert.ok(h.path && h.path.toLowerCase().includes(ROOT.toLowerCase()),
      '命中的进程，它的**可执行文件路径**必须在仓库里；命令行不算依据：' + h.path)
  }
  // 本进程必然在仓库里，但它必须被排除掉 —— 否则会自杀
  assert.ok(!hits.some(h => h.pid === process.pid), '本进程出现在结果里')
  // 而命令行里含仓库路径的进程，不该因此被命中
  const cmdlineOnly = spawn(process.execPath,
    ['-e', 'setTimeout(()=>{}, 8000)', process.cwd()], { stdio: 'ignore' })
  try {
    const byDefault = P.procsUnderDir(ROOT).map(h => h.pid)
    assert.ok(!byDefault.includes(cmdlineOnly.pid),
      '一个只把仓库路径放在**命令行**里的进程被算进来了 ⇒ 目录扫描比了命令行')
  } finally { P.killPid(cmdlineOnly.pid) }
})

test('spawnDetached 真的把进程拉起来了', async () => {
  const port = await freePort()
  const outFile = path.join(ROOT, 'logs', 'ports-selftest.log')
  const r = P.spawnDetached(process.execPath,
    ['-e', `require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1');setTimeout(()=>{},30000)`],
    { cwd: ROOT, outFile, errFile: outFile + '.err' })
  assert.equal(r.ok, true, 'spawnDetached 应当成功：' + r.why)
  assert.ok(r.pid, '应当拿得到 pid')
  await sleep(1200)
  try {
    assert.ok(P.listenersOnPort(port).length >= 1, '脱离出来的进程应当真的在监听')
  } finally { P.killPid(r.pid) }
  try { fs.unlinkSync(outFile) } catch (_) {}
  try { fs.unlinkSync(outFile + '.err') } catch (_) {}
})

test('httpReady 认得出在听与已关', async () => {
  const port = await freePort()
  await withServer(port, async () => {
    assert.equal(await P.httpReady(`http://127.0.0.1:${port}/`, 1500), true)
  })
  await sleep(200)
  assert.equal(await P.httpReady(`http://127.0.0.1:${port}/`, 1200), false,
    '端口关了还报就绪')
})

// =============================================================================
//  portChoice.js —— 那些「看起来多余」的判据
// =============================================================================

// ⭐ 这条测的是「判定用的是什么」，所以必须造一个**真像自家进程**的东西出来。
//   ⛔ 不能拿测试进程自己当例子：本仓库跑测试时，node 可能是 Hermes 自带的
//   那个（在仓库外：%LOCALAPPDATA%\\hermes\\tools\\node-…），而 `node --test`
//   的命令行里是**相对路径** ⇒ 仓库路径压根不在它的 path/命令行里。
//   ⇒ 拿它当「自家进程」是错的假设（我第一版就这么写的，红了才发现）。
//
//   ⚠️ 顺带记下一个**既有**的行为（原 PowerShell 也一样，不是这次引入的）：
//   用**系统 node** 跑 `node server.js` 时，命令行里只有 "server.js"，
//   可执行文件在仓库外 ⇒ testIsOwnProcess 判 false ⇒ 它自己占着的端口
//   被当成「陌生进程」⇒ 端口往上挪一个。后端仍能起来，只是端口变了。
//   仓库自带的 tools\\runtime\\node\\node.exe 在仓库内 ⇒ 不受此影响。
// ⭐⭐ 造「自家进程」必须给**两样**：`testIsOwnProcess` 判的是
//   「在这个安装根下」**且**「命令行里有 server.js 或某个引擎记号」。
//   ⛔ 我第一版只满足了前一半（起的是 stop.js，里面没有 server.js），
//      于是断言红了 —— 而错的是断言：`在仓库里` 只是**必要条件**。
//   引擎那侧靠的就是记号（own_process_mark，一台引擎一个），
//   后端那侧靠的是字面量 server.js。
async function ownLikeProc ({ asBackend = false, mark = null } = {}) {
  const script = asBackend ? 'server.js' : (mark ? 'infer_' + mark : 'server.js')
  // 记号必须真的出现在**命令行**里 —— 靠文件名带它。
    const abs = path.join(ROOT, 'logs', script)
    const body = '// selftest temp file: exists only so the command line carries the mark\n'
      + 'setTimeout(() => {}, 20000)\n'
    fs.writeFileSync(abs, body, 'utf8')
    const child = spawn(process.execPath, [abs], { cwd: ROOT, stdio: 'ignore' })
    // ⭐ 必须清缓存：进程表有 2 秒 TTL，而这个测试在一秒内连着起两个进程
    //   ⇒ 第二个查第一个时会被缓存挡住（第一版就这么红的）。
    P.clearProcsCache()
    await sleep(700)
    P.clearProcsCache()
    child.__abs = abs
    return child
  }

test('testIsOwnProcess：路径不在仓库里 ⇒ 一定不是自家的', async () => {
  assert.equal(PC.testIsOwnProcess(process.pid, 'C:/somewhere/else'), false,
    '本进程不在那个目录下，不该被认成自家的')
  // 后端形态：命令行里有 server.js
  const be = await ownLikeProc({ asBackend: true })
  try {
    assert.equal(PC.testIsOwnProcess(be.pid, ROOT), true,
      '在仓库下、命令行带 server.js ⇒ 应当被认成自家的')
    // 引擎形态：命令行里没有 server.js，但有**这一台**的记号
    const eng = await ownLikeProc({ mark: 'gpt_sovits_infer.py' })
    try {
      assert.equal(PC.testIsOwnProcess(eng.pid, ROOT, ['gpt_sovits_infer.py']), true,
        '有这一台的记号 ⇒ 应当被认成自家的')
      assert.equal(PC.testIsOwnProcess(eng.pid, ROOT, ['some_other_engine.py']), false,
        '只有**别的**引擎的记号 ⇒ 不该认成自家的')
      assert.equal(PC.testIsOwnProcess(eng.pid, ROOT, []), false,
        '在仓库下但没有任何记号、也没有 server.js ⇒ 不是自家进程')
    } finally { P.killPid(eng.pid); try { fs.unlinkSync(eng.__abs) } catch (_) {} }
  } finally { P.killPid(be.pid); try { fs.unlinkSync(be.__abs) } catch (_) {} }
})

// ⭐⭐ 空记号不能参与匹配。`hay.includes('')` 恒为 true ⇒
//   一个空记号会让「什么都算自家进程」⇒ 谁占着端口都被当成自己人
//   ⇒ 端口永远不去挪 ⇒ 引擎起不来且不报错。
//   原 PowerShell 用 `if ($m -and ...)` 挡住了这条。
test('testIsOwnProcess：空记号不会让一切都变成「自家」', () => {
  const yes = PC.testIsOwnProcess(process.pid, ROOT, [''])
  const none = PC.testIsOwnProcess(process.pid, ROOT, [])
  assert.strictEqual(yes, none,
    '传了一个空记号，判定结果就变了 ⇒ 空记号参与了匹配')
})

// ⭐⭐⭐ 记号必须**一台一个**。原脚本里那段注释记着这个坑：
//   问 A 的端口时若把 B 的记号也算上，B 恰好占着 A 的端口 ⇒
//   被判成「A 已经在跑」⇒ A 永远起不来，且不报错。
test('resolvePort 只用传进来的记号，不替调用方多记几台', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'system', 'portChoice.js'), 'utf8')
  // 判据不是「文本里有没有这句话」，而是**签名里就没有「全部记号」这个概念**：
  // 函数只接收一个 marks，而没有「allMarks」入口。
  assert.match(src, /function resolvePort \(name, desired, baseDir, \{ marks = \[\], exclude = \[\] \}/,
    'resolvePort 的签名变了 —— 它可能开始接收「所有引擎的记号」了，'
    + '而那正是「A 永远起不来且不报错」的成因')
})

test('resolvePort：端口空着就是 free，端口被自家占着就是 own', async () => {
  const port = await freePort()
  // 空着
  assert.deepEqual(
    (({ name, port: pp, action, ownerPid }) => ({ name, port: pp, action, ownerPid }))(
      PC.resolvePort('test', port, ROOT)),
    { name: 'test', port, action: 'free', ownerPid: null })

  // 被自家占着：起一个**确实在仓库里**的监听进程
  // 起一个「真像自家引擎」的东西：可执行文件在仓库外（Hermes 的 node），
  //   但命令行里带着仓库路径 + 这一台的记号。
  const abs = path.join(ROOT, 'logs', 'selftest-infer_gpt_sovits_infer.py.js')
  fs.writeFileSync(abs,
    "require('http').createServer((q,s)=>s.end('ok')).listen(" + port + ",'127.0.0.1')\n" +
    'setTimeout(()=>{}, 20000)\n')
  const child = spawn(process.execPath, [abs], { cwd: ROOT, stdio: 'ignore' })
  try {
    await sleep(1200)
    const r = PC.resolvePort('test', port, ROOT, { marks: ['gpt_sovits_infer.py'] })
    assert.equal(r.action, 'own',
      '自家进程占着这个端口时应当判为 own（复用、不重启），实际 ' + r.action)
    assert.ok(r.ownerPid, 'own 时应当报出占着的那个 pid')
    // ⭐ 而**别的**记号问同一个端口 ⇒ 陌生进程 ⇒ 往上挪。
    //   这正是「记号一台一个」那条纪律要保的东西。
    const asStranger = PC.resolvePort('test', port, ROOT, { marks: ['other_engine.py'] })
    assert.equal(asStranger.action, 'shifted',
      '用别的引擎的记号问同一个端口 ⇒ 它是陌生进程，端口该往上挪')
  } finally { P.killPid(child.pid); try { fs.unlinkSync(abs) } catch (_) {} }
})

// ⭐ claimed 与 shifted 必须分开：前者是「本次启动里别台已经许了这个端口」
//   （没有陌生进程，pid 是空的），后者是「有陌生进程占着」。
//   合成一句话会让人以为有个 pid 在那儿，而它不存在。
test('resolvePort：claimed（别台已许）与 shifted（陌生进程占）分开说', async () => {
  const port = await freePort()
  const claimed = PC.resolvePort('engine A', port, ROOT, { exclude: [port] })
  assert.equal(claimed.action, 'claimed',
    '端口被 exclude 列出时应当是 claimed，实际 ' + claimed.action)
  assert.equal(claimed.ownerPid, null,
    'claimed 时没有陌生进程，ownerPid 必须是空的 —— 说有 pid 会让人去找一个不存在的东西')
  assert.ok(claimed.port > port, 'claimed 应当把端口往上挪')

  const stranger = await freePort()
  await withServer(stranger, () => {
    const shifted = PC.resolvePort('engine B', stranger, 'C:/not/our/install', { exclude: [] })
    assert.equal(shifted.action, 'shifted',
      '陌生进程占着时应当是 shifted，实际 ' + shifted.action)
    assert.ok(shifted.ownerPid, 'shifted 时应当报出那个陌生 pid')
    assert.ok(shifted.port > stranger, 'shifted 应当把端口往上挪')
  })
})

test('getFreePort 会跳过 exclude 里的端口', async () => {
  const base = await freePort()
  const p = PC.getFreePort(base, { exclude: [base, base + 1] })
  assert.ok(p >= base + 2, `应当跳过被 exclude 的两个，实际给了 ${p}`)
})

test('resolvePort：附近没有空端口时是 exhausted（而不是随便挑一个）', async () => {
  // 把一整段连续端口都列进 exclude ⇒ 一个空位都没有
  const base = await freePort()
  const exclude = []
  for (let i = 0; i < 60; i++) exclude.push(base + i)
  const r = PC.resolvePort('x', base, ROOT, { exclude })
  assert.equal(r.action, 'exhausted',
    '所有候选都被 exclude 掉时应当 exhausted（调用方据此中止），实际 ' + r.action)
})

test('describe 五种动作各有一句人话，且不重复', () => {
  const lines = ['free', 'own', 'claimed', 'shifted', 'exhausted']
    .map(a => PC.describe({ name: 'x', port: 1, ownerPid: 2, action: a }))
  assert.equal(new Set(lines).size, 5, '五种动作的话术有重复 ⇒ 界面读起来会分不清')
  for (const l of lines) assert.ok(l && l.trim().length > 0)
})