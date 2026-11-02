'use strict'
// 试运行拉起器的守卫：health 三态分类、空闲端口、以及 withTempHost 的整条链。
//   注入假 spawn / 假探活 / 假杀进程 / 假名片写盘：真起宿首要引擎 venv 与模型，
//   那是 dev 探针的事（与 verify_audio 「node 测试不 spawn python」同一纪律）。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const {
  withTempHost, classifyHealth, pickFreePort, HOST_PY,
} = require('../core/hostRunner')

const PROF = { id: 'demo', timeout_ms: 1000, runtime: { python: '.venv' } }

/** 假子进程：stdout/stderr/exit 都能手动 emit，kill 只是记账 */
function fakeChild () {
  const c = new EventEmitter()
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.killed = false
  c.kill = () => { c.killed = true }
  return c
}

/** 一套注入：log 记下每一步，默认走向「成功」。
 *  exitOnProbe：第一次探活时同步 emit exit（模拟「探活还没回来，宿主已经退了」：
 *    真环境里退出事件是 libuv 回调，会在探活让出事件循环时插进来；
 *    注入的探活是同步 resolved promise，链式 microtask 不给 nextTick 机会，
 *    所以在探活内部同步 emit 才能重现那个时序窗口）。
 *  probeResult：每次 /health 的返回。 */
function mkHarness (overrides = {}) {
  const { exitOnProbe, probeResult, ...rest } = overrides
  const log = { kills: 0, spawned: [], probed: [], wrote: [] }
  const child = fakeChild()
  const harness = {
    log,
    child,
    spawn (...args) { log.spawned.push(args); return child },
    killProcessTree (c) { log.kills++; log.killedChild = c },
    async pickFreePort () { return 59999 },
    async probeHealth (base) {
      log.probed.push(base)
      if (exitOnProbe !== undefined && log.probed.length === 1) {
        child.emit('exit', exitOnProbe, null)
      }
      return probeResult || { status: 200, body: { ready: true } }
    },
    writeHostProfile (id, dest) { log.wrote.push([id, dest]) },
  }
  return Object.assign(harness, rest)
}

const runVia = (harness, opts = {}) => withTempHost({
  id: 'demo', profile: PROF,
  python: process.execPath, // 随便给一个存在的可执行文件：单测不起真宿主
  spawn: harness.spawn,
  killProcessTree: harness.killProcessTree,
  pickFreePort: harness.pickFreePort,
  probeHealth: harness.probeHealth,
  writeHostProfile: harness.writeHostProfile,
  readyTimeoutSec: 1,
  ...opts,
})

test('classifyHealth：ready / failed / loading / unreachable 四态分得开', () => {
  assert.strictEqual(classifyHealth({ status: 200, body: { ready: true } }).state, 'ready')
  const failed = classifyHealth({ status: 503, body: { failed: true, error: '权重不在' } })
  assert.strictEqual(failed.state, 'failed')
  assert.ok(failed.error.includes('权重不在'), 'failed 要把宿主的原因带回来')
  assert.strictEqual(classifyHealth({ status: 503, body: {} }).state, 'loading')
  assert.strictEqual(classifyHealth({ status: 200, body: { ready: false } }).state, 'loading')
  const un = classifyHealth({ err: 'ECONNREFUSED' })
  assert.strictEqual(un.state, 'unreachable')
  assert.ok(un.error)
})

test('classifyHealth：探针为空 / 503 且 failed 要与 503 未完成分开', () => {
  assert.strictEqual(classifyHealth(null).state, 'unreachable')
  // 503 但没说 failed = 还在加载，不能当成「失败」
  assert.strictEqual(
    classifyHealth({ status: 503, body: { ready: false } }).state, 'loading')
})

test('pickFreePort：返回能再用的端口（真绑一次，不靠 mock）', async () => {
  const port = await pickFreePort()
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536,
    `端口不像端口：${port}`)
  const port2 = await pickFreePort()
  assert.ok(Number.isInteger(port2), '第二次也要给端口')
})

test('成功路径：宿主就绪后 run 拿到本地地址，验完整条链', async () => {
  const h = mkHarness()
  const r = await runVia(h, { run: async (base) => ({ got: base }) })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.base_url, 'http://127.0.0.1:59999')
  assert.strictEqual(r.result.got, 'http://127.0.0.1:59999')

  // spawn 的命令行是 host.py + 解析结果 + 端口
  const argv = h.log.spawned[0][1]
  assert.strictEqual(argv[0], HOST_PY, '要起的是平台自己的 host.py')
  assert.ok(argv.includes('--profile-json'), '解析结果走文件不走命令行')
  assert.ok(argv.includes('--port'), 'HTTP 模式要给端口')
  assert.strictEqual(h.log.wrote.length, 1)
  // 验完照杀
  assert.strictEqual(h.log.kills, 1, '用完必须杀：宿主是这次试运行才起的')
  assert.strictEqual(h.log.killedChild, h.child)
})

test('宿主崩了：stage=host-exit，不与「验不过」混为一谈', async () => {
  const h = mkHarness({ exitOnProbe: 2 })
  const r = await runVia(h, { run: () => { throw new Error('不该跑到这里') } })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.stage, 'host-exit')
  assert.ok(/提前退出/.test(r.error), '要说清是宿主退了，不是引擎验不过')
  assert.strictEqual(h.log.kills, 1, '退了也要走杀（清残余）')
})

test('宿主报加载失败：stage=health，原因从 /health 带回来', async () => {
  const h = mkHarness({
    probeResult: { status: 503, body: { failed: true, error: 'No module named demo' } },
  })
  const r = await runVia(h, { run: () => { throw new Error('不该跑到这里') } })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.stage, 'health')
  assert.ok(/No module named demo/.test(r.error), '失败原因要带回来')
  assert.strictEqual(h.log.kills, 1)
})

test('一直不就绪：超时要说清是加载慢，不是 Crash', async () => {
  const h = mkHarness({ probeResult: { status: 503, body: { ready: false } } })
  const r = await runVia(h, { run: () => { throw new Error('不该跑到这里') } })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.stage, 'health')
  assert.ok(/没有就绪/.test(r.error))
  assert.strictEqual(h.log.kills, 1)
})

test('run 自己抛错：照杀照清，stage=run', async () => {
  const h = mkHarness()
  const r = await runVia(h, {
    run: async () => { throw new Error('探针炸了') },
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.stage, 'run')
  assert.ok(/探针炸了/.test(r.error))
  assert.strictEqual(h.log.kills, 1, '验的人炸了，宿主也得杀')
})

test('参数不全（缺 run / 缺 profile）：stage=args，不 spawn', async () => {
  const h = mkHarness()
  const a = await withTempHost({ id: 'demo', profile: PROF, ...h })
  assert.strictEqual(a.ok, false)
  assert.strictEqual(a.stage, 'args')
  assert.strictEqual(h.log.spawned.length, 0)
  const b = await withTempHost({ id: 'demo', run: () => {}, ...h })
  assert.strictEqual(b.stage, 'args')
  assert.strictEqual(h.log.spawned.length, 0)
})

test('名片没写 runtime.python：stage=python，不 spawn', async () => {
  const h = mkHarness()
  const r = await withTempHost({
    id: 'demo', profile: { id: 'demo' }, run: () => {},
    spawn: h.spawn, killProcessTree: h.killProcessTree,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.stage, 'python')
  assert.ok(/runtime\.python/.test(r.error), '要点名缺哪个字段')
  assert.strictEqual(h.log.spawned.length, 0)
})

test('解释器不存在：stage=python，且报出推导出的路径', async () => {
  const h = mkHarness()
  const r = await runVia(h, {
    python: path.join(__dirname, 'no-such-python.exe'),
    run: () => { throw new Error('不该跑到这里') },
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.stage, 'python')
  assert.ok(/解释器不存在/.test(r.error))
  assert.strictEqual(h.log.spawned.length, 0)
})

test('名片解析失败：stage=profile，不 spawn', async () => {
  const h = mkHarness({
    writeHostProfile () { throw new Error('call.kind=cli 要一个非空数组') },
  })
  const r = await runVia(h, { run: () => { throw new Error('不该跑到这里') } })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.stage, 'profile')
  assert.ok(/call\.kind/.test(r.error), '解析器的原话要带回来，不许包一层')
  assert.strictEqual(h.log.spawned.length, 0)
})
