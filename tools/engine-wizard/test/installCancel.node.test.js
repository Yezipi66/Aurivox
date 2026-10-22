'use strict'
// 装依赖的取消路径：取消要如实报出来，断点续传不能撒谎。
// 本文件守五件事，各有一条能变红的断言：
//   ① 取消时进程树被杀，且不新起进程
//   ② 取消的返回码是 INSTALL_CANCELLED，不是成功也不是 ENV_FAILED
//   ③ 杀不掉进程时如实报 INSTALL_CANCEL_FAILED（不假装取消成功）
//   ④ 取消后未完成的那一步不写 done：断点续传只记真成功的步骤
//   ⑤ 不取消的正常流程不受影响（回归保护）
// 另外两条验的是真实路径：真进程被杀、真 HTTP 端点能停掉在跑的安装。
// 本文件不真装包：每一步都用可注入的 runStep 换掉。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const envMod = require('../core/env.js')
const IS = require('../core/installState.js')

// 守卫（enginesDirWriteGuard.node.test.js 的 offenders）要求路径上带临时目录痕迹，
// 否则并行跑会污染真的 engines/。变量名必须带 mkdtemp。
function mkdtempRoot () {
  const mkdtempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-instcancel-'))
  fs.mkdirSync(path.join(mkdtempRootDir, 'engines'), { recursive: true })
  fs.writeFileSync(path.join(mkdtempRootDir, 'server.js'), '// anchor\n')
  return mkdtempRootDir
}

/** 造「项目根 + engines/<id>/ + pyproject.toml」 */
function mkdtempEngine (id) {
  const root = mkdtempRoot()
  const dir = path.join(root, 'engines', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pyproject.toml'),
    '[project]\nname = "demo"\nversion = "0.1.0"\n')
  return { root, dir }
}

/**
 * 假 child：一个不会自己退出的 EventEmitter，直到被 kill。
 * 这样测试能精确控制取消时机，也断言「不新起进程」。
 */
function fakeChild () {
  const fake = new EventEmitter()
  fake.killed = false
  fake.pid = 4242
  fake.stdout = new EventEmitter()
  fake.stderr = new EventEmitter()
  fake.marks = []
  fake.kill = () => {
    if (fake.killed) return
    fake.killed = true
    fake.marks.push('kill')
    // 进程真死 ⇒ emit close（取消成功以进程死亡为准）
    fake.emit('close', 1)
  }
  return fake
}

// 取消：进程树被杀，且如实返回 INSTALL_CANCELLED
test('取消：杀进程树，返回 INSTALL_CANCELLED（如实报，不伪装成功）', async () => {
  const { root } = mkdtempEngine('c1')
  const spawnCalls = []
  const killCalls = []
  const ac = new AbortController()
  let fake = null

  const p = envMod.runOne(
    { argv: ['node', '-e', 'while(1);'], cwd: root }, root, 0,
    ['node', '-e', 'while(1);'], null, null,
    {
      signal: ac.signal,
      spawn: (...a) => { spawnCalls.push(a); fake = fakeChild(); return fake },
      killProcessTree: (c) => { killCalls.push(c); if (fake) fake.kill() },
    })

  // 等 spawn 真的起来
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(fake, 'spawn 应该被调用')
  assert.strictEqual(spawnCalls.length, 1, '只应起一个进程')

  ac.abort()
  const r = await p

  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'INSTALL_CANCELLED',
    `取消必须返回 INSTALL_CANCELLED，实际 ${r.code}`)
  assert.strictEqual(r.cancelled, true, '结果要标 cancelled，界面才能区别「取消」与「失败」')
  assert.ok(/cancel/i.test(r.error) || /取消/.test(r.errorZh),
    '文案要如实说「已取消」')
  assert.ok(killCalls.length >= 1, 'killProcessTree 应该被调用（杀进程树）')
  // 不新起进程：取消之后 spawn 不再被调用
  assert.strictEqual(spawnCalls.length, 1, '取消后不许多起进程')

  fs.rmSync(root, { recursive: true, force: true })
})

test('取消的退出码不冒充安装结论（进程被杀 ≠ 装失败）', async () => {
  const { root } = mkdtempEngine('c2')
  const ac = new AbortController()
  let fake = null

  const p = envMod.runOne({ argv: ['x'], cwd: root }, root, 0, ['x'], null, null, {
    signal: ac.signal,
    spawn: () => { fake = fakeChild(); return fake },
    killProcessTree: (c) => { if (fake) fake.kill() },
    safetyNetMs: 50,
  })
  await new Promise((r) => setTimeout(r, 10))
  ac.abort()
  const r = await p

  assert.strictEqual(r.code, 'INSTALL_CANCELLED',
    '进程被我们杀掉，其退出码不能当成 ENV_FAILED')
  assert.notStrictEqual(r.code, 'ENV_FAILED')

  fs.rmSync(root, { recursive: true, force: true })
})

// 进程杀不掉：如实报杀不掉，不假装取消成功
test('进程杀不掉 ⇒ 如实报 INSTALL_CANCEL_FAILED，不假装取消成功', async () => {
  const { root } = mkdtempEngine('c3')
  const ac = new AbortController()
  let fake = null

  const p = envMod.runOne({ argv: ['x'], cwd: root }, root, 0, ['x'], null, null, {
    signal: ac.signal,
    // 假的 kill：什么都不做（模拟杀不掉）
    spawn: () => { fake = fakeChild(); fake.kill = () => {}; return fake },
    safetyNetMs: 60,
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(fake, 'spawn 应该被调用')
  ac.abort()
  const r = await p

  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'INSTALL_CANCEL_FAILED',
    `进程杀不掉时必须如实报 INSTALL_CANCEL_FAILED，实际 ${r.code}`)
  assert.ok(/cannot cancel|杀不掉|无法取消/i.test(r.error + ' ' + r.errorZh))

  fs.rmSync(root, { recursive: true, force: true })
})

// runEnv：取消时留下的 done 只含真成功的步骤
test('runEnv 取消：未完成的那一步不写 done（断点续传不撒谎）', async () => {
  const { root } = mkdtempEngine('c4')
  const ac = new AbortController()

  // 第一步成功、第二步开始前取消 ⇒ 第二步绝不进 done
  let n = 0
  const r = await envMod.runEnv({
    id: 'c4', root, execute: true, manifest: {},
    signal: ac.signal,
    runStep: async (step, root2, timeout, argv) => {
      n++
      if (n === 1) return { ok: true, code: 'OK', status: 0, stdout: '', stderr: '' }
      ac.abort()
      return { ok: false, code: 'INSTALL_CANCELLED', status: 1, stdout: '', stderr: '' }
    },
    probeImport: () => ({ ok: true, mod: 'x', code: 'OK', detail: '' }),
  })

  assert.strictEqual(r.ok, false, '取消不是成功')
  assert.strictEqual(r.code, 'INSTALL_CANCELLED', r.code)

  const done = [...IS.readProgress(root, 'c4', 'env')]
  const cancelled = (r.stepsRun || []).filter((s) => s.code === 'INSTALL_CANCELLED')
  assert.ok(cancelled.length >= 1, '取消的那一步要出现在 stepsRun 里')
  for (const s of cancelled) {
    assert.ok(!done.includes(s.argvKey),
      `⛔ 取消的步骤被写进 done 了：${s.argvKey}\n`
      + '下次重跑会跳过一条根本没跑完的命令，而界面显示「已完成」')
  }
  // 真正成功的那一步照旧在 done 里（断点续传没有废）
  const okSteps = (r.stepsRun || []).filter((s) => s.ok === true)
  for (const s of okSteps) {
    assert.ok(done.includes(s.argvKey), `成功的步骤丢了：${s.argvKey}`)
  }

  fs.rmSync(root, { recursive: true, force: true })
})

test('步骤之间点了取消 ⇒ 不新起进程，如实报已取消', async () => {
  const { root } = mkdtempEngine('c5')
  const ac = new AbortController()
  const ac2 = new AbortController()
  void ac

  // 两步都注入假的；第一步结束就 abort，第二步不被起
  let n = 0
  const r = await envMod.runEnv({
    id: 'c5', root, execute: true, manifest: {},
    signal: ac2.signal,
    runStep: async () => {
      n++
      ac2.abort()
      return { ok: false, code: 'INSTALL_CANCELLED', status: 1, stdout: '', stderr: '' }
    },
    probeImport: () => ({ ok: true, mod: 'x', code: 'OK', detail: '' }),
  })

  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'INSTALL_CANCELLED', r.code)
  assert.strictEqual(n, 1, '第一步之后点了取消，第二步不许再起进程')

  fs.rmSync(root, { recursive: true, force: true })
})

// 半截环境：取消后留标记，重跑先删 .venv
test('取消后 .venv 有「不完整」标记，重跑先删半截环境', async () => {
  const { root } = mkdtempEngine('c6')
  // 造一个半截 .venv（装到一半取消的真实形状：目录在、site-packages 一半）
  const venvDir = path.join(root, 'engines', 'c6', '.venv')
  fs.mkdirSync(path.join(venvDir, 'Lib', 'site-packages'), { recursive: true })
  fs.writeFileSync(path.join(venvDir, 'Lib', 'site-packages', 'half.txt'), 'x')

  let n = 0
  const r = await envMod.runEnv({
    id: 'c6', root, execute: true, manifest: {},
    runStep: async () => {
      n++
      if (n === 1) return { ok: true, code: 'OK', status: 0, stdout: '', stderr: '' }
      return { ok: false, code: 'INSTALL_CANCELLED', status: 1, stdout: '', stderr: '' }
    },
    probeImport: () => ({ ok: true, mod: 'x', code: 'OK', detail: '' }),
  })
  assert.strictEqual(r.ok, false)
  assert.ok(envMod.hasPartialVenvMark(root, 'c6'),
    '取消/失败后必须留下「环境不完整」的标记')

  // 半截 .venv 此刻还在（取消不删它：源码与已下载的包都是资产）
  assert.ok(fs.existsSync(path.join(venvDir, 'Lib', 'site-packages', 'half.txt')),
    '取消不删 .venv —— 已下载的 wheel 是资产，删了要重下')

  // 重跑：先删掉整个 .venv 再装。这里用假的 runStep 断言「跑之前目录已不在」
  let sawVenvGone = false
  const r2 = await envMod.runEnv({
    id: 'c6', root, execute: true, manifest: {},
    runStep: async () => {
      sawVenvGone = !fs.existsSync(venvDir)
      return { ok: true, code: 'OK', status: 0, stdout: '', stderr: '' }
    },
    probeImport: () => ({ ok: true, mod: 'x', code: 'OK', detail: '' }),
  })
  assert.strictEqual(r2.ok, true, r2.error)
  assert.ok(sawVenvGone,
    '⛔ 重跑时没有先删掉半截 .venv —— 半个环境会被 uv 当成好环境')
  assert.ok(!envMod.hasPartialVenvMark(root, 'c6'),
    '装完后要抹掉「环境不完整」的标记，否则下次白删一次 .venv')

  fs.rmSync(root, { recursive: true, force: true })
})

test('装成功 ⇒ 不留「环境不完整」标记', async () => {
  const { root } = mkdtempEngine('c7')
  // 先手写一个标记（上一次失败留下的）
  envMod.markPartialVenv(root, 'c7', '上一次失败')
  assert.ok(envMod.hasPartialVenvMark(root, 'c7'))

  const r = await envMod.runEnv({
    id: 'c7', root, execute: true, manifest: {},
    runStep: async () => ({ ok: true, code: 'OK', status: 0, stdout: '', stderr: '' }),
    probeImport: () => ({ ok: true, mod: 'x', code: 'OK', detail: '' }),
  })
  assert.strictEqual(r.ok, true, r.error)
  assert.ok(!envMod.hasPartialVenvMark(root, 'c7'),
    '装完还留着标记 ⇒ 下次重跑会白删一次 .venv')

  fs.rmSync(root, { recursive: true, force: true })
})

test('装依赖失败 ⇒ 未完成的步骤不写 done，已成功的仍在（断点续传不撒谎）', async () => {
  // 与取消同源的另一面：失败同样不写 done。
  //   这一步失败 ⇒ 该步 key 不在 done 里 ⇒ 下次重跑会重跑它。
  //   若写进去，下次重跑跳过一条根本没跑完的命令，而界面显示「已完成」。
  const { root } = mkdtempEngine('c11')
  let n = 0
  const r = await envMod.runEnv({
    id: 'c11', root, execute: true, manifest: {},
    runStep: async () => {
      n++
      if (n === 1) return { ok: true, code: 'OK', status: 0, stdout: '', stderr: '' }
      return { ok: false, code: 'ENV_FAILED', status: 1,
        stdout: '', stderr: 'boom' }
    },
    probeImport: () => ({ ok: true, mod: 'x', code: 'OK', detail: '' }),
  })
  assert.strictEqual(r.ok, false, '失败不是成功')
  assert.strictEqual(r.code, 'ENV_FAILED', r.code)

  const done = [...IS.readProgress(root, 'c11', 'env')]
  const failed = (r.stepsRun || []).filter((s) => s.ok !== true)
  assert.ok(failed.length >= 1, '失败的那一步要出现在 stepsRun 里')
  for (const s of failed) {
    assert.ok(!done.includes(s.argvKey),
      `⛔ 失败的步骤被写进 done 了：${s.argvKey}`)
  }
  const okSteps = (r.stepsRun || []).filter((s) => s.ok === true)
  for (const s of okSteps) {
    assert.ok(done.includes(s.argvKey),
      `⛔ 成功的步骤没写进 done：${s.argvKey} —— 断点续传废了`)
  }

  fs.rmSync(root, { recursive: true, force: true })
})

// 回归保护：不取消的正常流程不受影响
test('不取消的正常流程不受影响（回归保护）', async () => {
  const { root } = mkdtempEngine('c8')
  const ac = new AbortController()
  const ran = []
  const r = await envMod.runEnv({
    id: 'c8', root, execute: true, manifest: {},
    signal: ac.signal,
    runStep: async (step, root2, timeout, argv) => {
      ran.push(argv.join(' '))
      return { ok: true, code: 'OK', status: 0, stdout: '', stderr: '' }
    },
    probeImport: () => ({ ok: true, mod: 'x', code: 'OK', detail: '' }),
  })
  assert.strictEqual(r.ok, true, r.error)
  assert.ok(ran.length >= 1, '步骤要真的跑')
  // 全部成功 ⇒ 每一步都写进 done
  const done = [...IS.readProgress(root, 'c8', 'env')]
  for (const s of r.stepsRun) {
    assert.ok(done.includes(s.argvKey), `成功的步骤没写 done：${s.argvKey}`)
  }

  fs.rmSync(root, { recursive: true, force: true })
})

test('没有 signal 的调用行为不变（不给取消通道时一切照旧）', async () => {
  const { root } = mkdtempEngine('c9')
  const p = envMod.runOne({ argv: ['node', '--version'], cwd: root }, root, 0,
    ['node', '--version'], null, null)
  const r = await p
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.code, 'OK')

  fs.rmSync(root, { recursive: true, force: true })
})

test('给了 cancel 对象但没注入 spawn ⇒ 仍然走真实 spawn（缺省不许是假的）', async () => {
  // 这条守注入点的用法：测试注入 spawn 是为了不真起进程，
  //   生产路径上少给一个键就必须回落到真实 spawn，
  //   否则取消逻辑测的是个假的，而线上进程还在跑。
  const { root } = mkdtempEngine('c10')
  const r = await envMod.runOne({ argv: ['node', '--version'], cwd: root }, root, 0,
    ['node', '--version'], null, null, {})
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.code, 'OK')

  fs.rmSync(root, { recursive: true, force: true })
})

// 真进程：取消真的杀掉了进程树（taskkill /T 那条路）
test('真进程：取消后那个进程真死了，不新起进程', async () => {
  const { root } = mkdtempEngine('c12')
  const ac = new AbortController()
  let child = null
  const p = envMod.runOne(
    { argv: ['node', '-e', 'while(1);'], cwd: root }, root, 0,
    ['node', '-e', 'while(1);'], null, null,
    {
      signal: ac.signal,
      spawn: (cmd, args, opts) => {
        // 真的起进程（不是假的）：这条验的正是杀进程树那条生产路径
        child = require('node:child_process').spawn(cmd, args, opts)
        return child
      },
    })
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(child && child.pid, '真进程应该起来了')
  const pid = child.pid

  ac.abort()
  const r = await p

  assert.strictEqual(r.code, 'INSTALL_CANCELLED', r.code)
  // 进程真死：taskkill 找不到那个 pid 时退非 0（Windows 上 child.kill()
  //   杀不掉 node，靠的是 taskkill /T /F）。
  //   不匹配 taskkill 的文案：它在非 UTF-8 locale 下输出的是 GBK 字节，
  //   正则匹配中文会静默失配，所以用退出码判，不用文案判。
  const alive = (() => {
    try {
      const chk = require('node:child_process').spawnSync('taskkill',
        ['/PID', String(pid)], { encoding: 'latin1' })
      return chk.status === 0
    } catch (e) { return false }
  })()
  if (process.platform === 'win32') {
    assert.ok(!alive, `取消后 pid ${pid} 还活着 —— 进程树没被杀掉`)
  }

  fs.rmSync(root, { recursive: true, force: true })
})

// HTTP 层：取消端点真的能停掉正在跑的安装（不只是断前端流）
test('HTTP 层：/wizard/env/cancel 能停掉正在跑的安装并如实回 INSTALL_CANCELLED', async () => {
  const http = require('node:http')
  const wb = require('../core/wizardbridge.js')
  const { root } = mkdtempEngine('c13')

  // 中间件的顺序照 web/wizard.vite.config.mjs：长前缀在前
  const srv = http.createServer((req, res) => {
    for (const h of [wb.handleEnvCancel, wb.handleEnv]) {
      if (h(req, res) === true) return
    }
    res.statusCode = 404; res.end('no handler')
  })
  await new Promise((r) => srv.listen(0, r))
  const port = srv.address().port
  // 测试结束必须关掉这个服务，否则 node --test 挂住不退出
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/wizard/env`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        root, id: 'c13',
        manifest: { install: { env_command: ['node', '-e', 'while(1);'] } },
        execute: true,
      }),
    })
    const events = []
    const reader = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const readLoop = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) { events.push(buf.slice(0, i)); buf = buf.slice(i + 2) }
      }
    })()
    // 等安装真的开始（进程起来了）
    await new Promise((r) => setTimeout(r, 1500))
    assert.ok(events.length > 0, '安装应该已经开始（至少有一个 step 事件）')

    const cancelRes = await new Promise((ok) => {
      const req = http.request({ port, path: '/wizard/env/cancel', method: 'POST' }, (res) => {
        let d = ''; res.on('data', (c) => { d += c }); res.on('end', () => ok(d))
      })
      req.end(JSON.stringify({ id: 'c13' }))
    })
    assert.ok(/cancelled":true/.test(cancelRes),
      `取消端点必须说 cancelled:true —— ${cancelRes}`)

    await Promise.race([
      readLoop,
      new Promise((_, rej) => setTimeout(() => rej(new Error('流没结束')), 30000)),
    ])
    const got = events.join('\n')
    // 只看 done 事件自己的结论：stepsRun 里成功步骤带 "ok":true 是正常的
    const doneEvent = events.find((e) => e.startsWith('event: done')) || ''
    const doneData = doneEvent.slice(doneEvent.indexOf('data: ') + 6)
    let doneJson = null
    try { doneJson = JSON.parse(doneData) } catch (e) { /* 下面断言会报 */ }
    assert.ok(doneJson, `done 事件不是合法 JSON：${doneData.slice(0, 200)}`)
    assert.ok(/INSTALL_CANCELLED/.test(got),
      `取消后必须如实回 INSTALL_CANCELLED，实际事件：${got.slice(0, 400)}`)
    assert.strictEqual(doneJson.code, 'INSTALL_CANCELLED', doneJson.code)
    assert.strictEqual(doneJson.ok, false, '⛔ 取消被报成了成功')
    assert.strictEqual(doneJson.cancelled, true, '结果要标 cancelled')
    // 文案要说「已取消」，不能写成「第 N 步失败」（那是失败的解释，不是取消）
    assert.ok(/取消/.test(doneJson.errorZh), doneJson.errorZh)
    assert.ok(!/失败/.test(doneJson.errorZh),
      `⛔ 取消的文案说成了失败：${doneJson.errorZh}`)
    // 半截环境标记要留下（下次重跑先删 .venv）
    assert.ok(envMod.hasPartialVenvMark(root, 'c13'),
      '取消后必须留下「环境不完整」的标记')
  } finally {
    srv.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
