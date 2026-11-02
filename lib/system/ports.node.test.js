// lib/system/ports.js 与 lib/system/portChoice.js 的守卫：把这两处看着多余的判据钉住，
// 让下一个人不能顺手删（只认 LISTENING、记号一台一个、claimed 与 shifted 分开说、
// 目录扫描只比可执行文件路径）。
// 测法：真的起进程、真的占端口，不做 mock：这些判据的价值全在真实环境下的表现，
// mock 掉就等于没测。

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

/**
 * 借一个此刻没人用的端口。不能写死某个高位端口：9886 是后端的真实端口
 * （本机上可能正跑着），端口撞上别的服务会让「杀进程」测试杀掉无关进程。
 * listen(0) 由系统分配端口，但它是异步的，端口号只在 listen 的回调里拿得到：
 * 同步读 address() 得到 null，后面每一条需要「一个真的在听的端口」的测试都会失败。
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

// 造一组「真在听的端口 + 那个会被误命中的查询端口」。
// 不靠 listen(0) 借端口再推导：临时端口是顺序分配的，连借几十次也都在同一个窄带里，
// 推导出来的查询端口可能次次都不合格，而重借又逃不出那个带 ⇒ 「借不到」。
// 直接按位数构造，两个数字都由这里挑：
//   prefix：查询端口 p，真在听的是 p*10+d（p ≤ 6553，再大就超出端口上限 65535）
//   suffix：查询端口 p，真在听的是 d*10000+p（d ≤ 6 且 p ≤ 5535，同理受上限约束）
// 两种构造里 String(p) 都一定出现在 String(真在听的端口) 里，差别只在前面还是后面。
// 两个端口在返回前都必须确认真的没人监听：不确认就会测到一台不相干的监听者身上，
// 而那条红出来的断言会把人引向错误的方向。
async function anchorPair (kind) {
  const maxAsked = kind === 'prefix' ? 6553 : 5535
  for (let i = 0; i < 30; i++) {
    const asked = 1024 + Math.floor(Math.random() * (maxAsked - 1024))
    const listening = kind === 'prefix'
      ? asked * 10 + Math.floor(Math.random() * 10)
      : (1 + Math.floor(Math.random() * 6)) * 10000 + asked
    if (listening > 65535) continue
    if (P.listenersOnPort(asked).length) continue
    if (P.listenersOnPort(listening).length) continue
    return { listening, asked }
  }
  throw new Error(`借不到一组「${kind}」用的端口：一个在听、一个空着且是它的子串`)
}

test('listenersOnPort 认得出真正在听的进程', async () => {
  const port = await freePort()
  await withServer(port, () => {
    const pids = P.listenersOnPort(port)
    assert.ok(pids.length >= 1, `端口 ${port} 上应当有监听者，实际 ${JSON.stringify(pids)}`)
    assert.ok(pids.includes(process.pid), '监听者里应当有本进程')
    assert.equal(P.isPortListening(port), true)
  })
  // 监听者随服务关闭而消失：这一条同时验证了「不留残影」
  await sleep(200)
  assert.deepEqual(P.listenersOnPort(port), [], '端口关掉后仍报有监听者')
})

// 第一条纪律：只认 LISTENING。连接结束后那个端口会进 TIME_WAIT 并挂几十秒；
// 若把它算成「被占」，start 就会以为「上次那个还在跑」而拒绝重启。
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

// 端口号必须完整匹配：9886 不能被 98860（前缀延长）或 19886（子串包含）误命中。
// 两种误命中由两种不同写法漏出来，得分开造，否则只钉住一半：
//   · 漏了尾部锚点（写成 [:.]9886，少了末尾的 \s）：真在听的是 98860，查询 9886 谎报被占。
//     造法：真在听的端口 = 查询端口 * 10 + 一位，查询端口是它的前缀。
//   · 漏了头部锚点（直接 includes(String(port))）：真在听的是 19886，查询 9886 谎报被占。
//     造法：真在听的端口 = 一位数字 * 10^n + 查询端口，查询端口是它的后缀子串。
// 旧写法拿 port + 7 当「邻近端口」：45000 与 45007 互不为子串，两种都造不出来，
// 等于把锚点删掉也测不出来；而临时端口是顺序分配的 5 位数，+7 常撞上并行测试借走的
// 端口，于是这条测试既验不到东西又随机红。
test('端口号是完整匹配：前缀延长不误命中（9886 与 98860 那一类）', async () => {
  const { listening, asked } = await anchorPair('prefix')
  await withServer(listening, () => {
    assert.ok(P.listenersOnPort(listening).length >= 1,
      `端口 ${listening} 上应当有监听者，实际 ${JSON.stringify(P.listenersOnPort(listening))}`)
    assert.deepEqual(P.listenersOnPort(asked), [],
      `在 ${listening} 上有监听，却报 ${asked} 上也有：查询端口是真监听端口的前缀，` +
      '说明正则漏了尾部锚点')
  })
})

test('端口号是完整匹配：子串包含不误命中（9886 与 19886 那一类）', async () => {
  const { listening, asked } = await anchorPair('suffix')
  await withServer(listening, () => {
    assert.ok(P.listenersOnPort(listening).length >= 1,
      `端口 ${listening} 上应当有监听者，实际 ${JSON.stringify(P.listenersOnPort(listening))}`)
    assert.deepEqual(P.listenersOnPort(asked), [],
      `在 ${listening} 上有监听，却报 ${asked} 上也有：查询端口是真监听端口的子串，` +
      '说明判据在做裸子串查找')
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
  // 失败原因必须是一句能读懂的话。taskkill 的原始输出走系统 OEM
  // 代码页（本机 GBK），按 utf8 解出来是乱码，而这一句是要显示给用户的。
  assert.ok(!/[^\x00-\x7F]/.test(second.why) || /不在了|权限/.test(second.why),
    '失败原因不是可读的句子：' + JSON.stringify(second.why))
})

test('procAlive 分得清活着与不存在', () => {
  assert.equal(P.procAlive(process.pid), true)
  assert.equal(P.procAlive(999999), false)
  assert.equal(P.procAlive(0), false)
  assert.equal(P.procAlive(-1), false)
})

// 目录扫描只能比可执行文件路径，不能比命令行：命令行里含仓库路径的东西
// 包括用户在项目目录里执行 stop 时起的 shell，比命令行就会把它杀掉。
test('procsUnderDir 只看可执行文件路径，不看命令行', () => {
  const hits = P.procsUnderDir(ROOT)
  for (const h of hits) {
    assert.ok(h.path && h.path.toLowerCase().includes(ROOT.toLowerCase()),
      '命中的进程，它的**可执行文件路径**必须在仓库里；命令行不算依据：' + h.path)
  }
  // 本进程必然在仓库里，但它必须被排除掉，否则会把自己杀掉
  assert.ok(!hits.some(h => h.pid === process.pid), '本进程出现在结果里')
  // 命令行里含仓库路径的进程，不该因此被命中
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

// 这条测的是「判定用的是什么」，所以必须造一个真像自家进程的东西出来。
// 不能拿测试进程自己当例子：跑测试时 node 可能在仓库外（命令行里是相对路径，
// 仓库路径不在它的可执行文件路径与命令行里），拿它当「自家进程」是错的假设。
// 造「自家进程」必须给两样：在安装根下，且命令行里有 server.js 或某个引擎记号。
// 只满足前一半断言就会失败，而错的是断言：「在仓库里」只是必要条件。
// 引擎那侧靠记号（own_process_mark，一台引擎一个），后端那侧靠字面量 server.js。
async function ownLikeProc ({ asBackend = false, mark = null, exe = process.execPath } = {}) {
  const script = asBackend ? 'server.js' : (mark ? 'infer_' + mark : 'server.js')
  // 记号必须真的出现在命令行里：靠文件名带它。
    const abs = path.join(ROOT, 'logs', script)
    const body = '// selftest temp file: exists only so the command line carries the mark\n'
      + 'setTimeout(() => {}, 20000)\n'
    fs.writeFileSync(abs, body, 'utf8')
    const child = spawn(exe, [abs], { cwd: ROOT, stdio: 'ignore' })
    // 必须清缓存：进程表有 2 秒 TTL，而这个测试在一秒内连着起两个进程，
    // 第二个查第一个时会被缓存挡住。
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
    // 引擎形态：命令行里没有 server.js，但有这一台的记号
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

// 空记号不能参与匹配：`hay.includes('')` 恒为 true，
// 一个空记号会让「什么都算自家进程」，于是谁占着端口都被当成自己人，
// 端口永远不去挪，引擎起不来且不报错。
test('testIsOwnProcess：空记号不会让一切都变成「自家」', () => {
  const yes = PC.testIsOwnProcess(process.pid, ROOT, [''])
  const none = PC.testIsOwnProcess(process.pid, ROOT, [])
  assert.strictEqual(yes, none,
    '传了一个空记号，判定结果就变了 ⇒ 空记号参与了匹配')
})

// 后端的证据可能落在两处，任一处成立都要认得出：自带 node 时证据在可执行文件路径，
// 跑 PATH 上的系统 node 时路径在仓库外，只有脚本的绝对路径能把安装根带进命令行。
// 相对参数那一档两处都不成立，自家后端会被判成陌生人 ⇒ 重复起第二个后端，
// 由下面那条源码守卫钉住。
test('后端：证据落在路径或命令行，都要认得出', async () => {
  const be = await ownLikeProc({ asBackend: true })
  try {
    assert.equal(PC.testIsOwnProcess(be.pid, ROOT), true,
      `自家后端应当被认出来（脚本路径 ${be.__abs}）`)
  } finally { P.killPid(be.pid); try { fs.unlinkSync(be.__abs) } catch (_) {} }
})

// 源码级：后端不许再用相对参数起。相对参数时命令行里没有安装根；若这台机器的 node
// 又不在仓库内，两段判据都不成立 ⇒ 自家后端被判成陌生进程。
// 这条不真起进程：起进程测不出「start.js 里写的是哪一种参数」。
test('后端启动必须用脚本的绝对路径（相对参数会让身份判据失效）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'cli', 'start.js'), 'utf8')
  assert.doesNotMatch(src, /\[\s*'server\.js'\s*\]/,
    '后端还在用相对参数起：命令行里没有安装根，解释器又在仓库外时就认不出自家后端')
  assert.match(src, /spawnDetached\(NODE,\s*\[[^\]]*server\.js['"][^\]]*\]/,
    '找不到后端启动那一行，这条守卫可能已经失效')
})

// 强判据（可执行文件路径在仓库内）认得出的，杀进程那份清单里也必须找得到。
// 两份清单口径不同：认自家信命令行，杀进程只信路径 ⇒ 靠命令行认出来的那一档
// 可能「认得出但杀不掉」。这一条钉住的是强判据那一档没有这个缝。
// 自带 node 在 tools/runtime/ 下，而那个目录不进版本库 ⇒ 不在时如实跳过，不假装测过。
test('强判据认得出的自家进程，杀进程那份清单里也找得到', async (t) => {
  const bundled = path.join(ROOT, 'tools', 'runtime', 'node', 'node.exe')
  if (!fs.existsSync(bundled)) {
    t.skip(`自带 node 不在（${bundled}），这一档测不了`)
    return
  }
  const eng = await ownLikeProc({ mark: 'gpt_sovits_infer.py', exe: bundled })
  try {
    assert.equal(PC.testIsOwnProcess(eng.pid, ROOT, ['gpt_sovits_infer.py']), true,
      '解释器在仓库内 + 命令行带记号 ⇒ 应当被认成自家引擎')
    const killable = P.procsUnderDir(ROOT).map(h => h.pid)
    assert.ok(killable.includes(eng.pid),
      '强判据认得出的进程不在 procsUnderDir 的结果里 ⇒ 认得出但停不掉')
  } finally { P.killPid(eng.pid); try { fs.unlinkSync(eng.__abs) } catch (_) {} }
})

// 记号必须一台一个：问 A 的端口时若把 B 的记号也算上，
// B 恰好占着 A 的端口就会被判成「A 已经在跑」，A 永远起不来且不报错。
test('resolvePort 只用传进来的记号，不替调用方多记几台', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'system', 'portChoice.js'), 'utf8')
  // 判据不是「文本里有没有这句话」，而是签名里就没有「全部记号」这个概念：
  // 函数只接收一个 marks，没有「allMarks」入口。
  assert.match(src, /function resolvePort \(name, desired, baseDir, \{ marks = \[\], exclude = \[\] \}/,
    'resolvePort 的签名变了 —— 它可能开始接收「所有引擎的记号」了，'
    + '而那正是「A 永远起不来且不报错」的成因')
})

test('resolvePort：端口空着就是 free，端口被自家占着就是 own', async () => {
  const port = await freePort()
  // 端口空着：判为 free
  assert.deepEqual(
    (({ name, port: pp, action, ownerPid }) => ({ name, port: pp, action, ownerPid }))(
      PC.resolvePort('test', port, ROOT)),
    { name: 'test', port, action: 'free', ownerPid: null })

  // 起一个「真像自家引擎」的东西：可执行文件在仓库外，
  // 但命令行里带着仓库路径 + 这一台的记号。
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
    // 而别的记号问同一个端口就是陌生进程，端口该往上挪。
    const asStranger = PC.resolvePort('test', port, ROOT, { marks: ['other_engine.py'] })
    assert.equal(asStranger.action, 'shifted',
      '用别的引擎的记号问同一个端口 ⇒ 它是陌生进程，端口该往上挪')
  } finally { P.killPid(child.pid); try { fs.unlinkSync(abs) } catch (_) {} }
})

// claimed 与 shifted 必须分开：前者是「本次启动里别台已经许了这个端口」
// （没有陌生进程，pid 是空的），后者是「有陌生进程占着」。
// 合成一句话会让人以为有个 pid 在那儿，而它不存在。
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
  // 把一整段连续端口都列进 exclude，一个空位都没有
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