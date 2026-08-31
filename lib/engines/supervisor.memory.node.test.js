'use strict'

// ---------------------------------------------------------------------------
//  内存判据的**接线**
// ---------------------------------------------------------------------------
//
// ⭐ 这里全部用**假的** mem / ledger。真的那两个在 memprobe / memledger 自己的
//   测试里量真进程、写真文件；这一层只验一件事：
//   **在对的时刻、对着对的 pid、把对的数交给对方。**
//
// ⛔ 单独一个文件，⛔ 不并进 supervisor.node.test.js：那 34 条是「起停复用」
//   的账，这 21 条是「内存」的账。混在一起的话，将来内存这套要是被推翻，
//   得从 55 条里一条条挑。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { EngineSupervisor } = require('./supervisor')

const LAUNCH = [{ name: 'model', applies_at: 'launch' }]

function prof(id, over = {}) {
  return Object.assign({
    id,
    label: id,
    base_url: `http://127.0.0.1:${9000 + id.length}`,
    weight_slots: LAUNCH,
    runtime: { ready_endpoint: '/health', ready_timeout_ms: 5000, preload: true },
  }, over)
}

function memWorld(over = {}) {
  const w = {
    t: 1000,
    spawned: [],
    killed: [],
    logs: [],
    order: [],
    recorded: [],
    attempted: [],
    sampled: [],
    reaped: over.reaped || [],
    free: over.free === undefined ? 8000 : over.free,
    need: over.need === undefined ? null : over.need,
    peak: over.peak === undefined ? 3547 : over.peak,
  }

  const mem = {
    freeMb: () => {
      if (over.freeThrows) throw new Error('读不到内存')
      return w.free
    },
    sampleTree: (pid) => {
      w.sampled.push(pid)
      if (over.sampleThrows) throw new Error('量不了')
      if (w.peak == null) return { ok: false, reason: 'gone' }
      return { ok: true, rootPid: pid, count: 3, rssMb: 500, peakMb: w.peak, peakExact: true }
    },
  }

  const ledger = {
    needMb: () => {
      if (over.needThrows) throw new Error('账本坏了')
      return w.need
    },
    record: (id, mb) => {
      if (over.recordThrows) throw new Error('写不进去')
      w.recorded.push([id, mb])
    },
    markAttempting: (id) => {
      w.order.push('attempt')
      if (over.attemptThrows) throw new Error('写不进去')
      w.attempted.push(id)
    },
    reapAttempts: () => w.reaped,
  }

  const deps = {
    now: () => w.t,
    sleep: async (ms) => { w.slept = (w.slept || 0) + ms; w.t += ms },
    log: (l) => w.logs.push(l),
    env: {},
    mem,
    ledger,
    buildPlan: (profile, opts) => ({
      id: profile.id,
      launchable: !!profile.runtime,
      base_url: profile.base_url,
      ready_url: `${profile.base_url}/health`,
      ready_timeout_ms: 5000,
      checkpoints: opts.checkpointsOverride || null,
    }),
    spawn: async (plan) => {
      w.order.push('spawn')
      const proc = {
        pid: 100 + w.spawned.length,
        exitCode: null,
        kill() { w.killed.push(plan.id) },
      }
      w.spawned.push({ plan, proc })
      return proc
    },
    probe: async () => true,
  }
  if (over.assumeConfirmed !== undefined) deps.assumeConfirmed = over.assumeConfirmed
  if (over.noMem) { delete deps.mem; delete deps.ledger }

  w.sup = new EngineSupervisor(deps)
  return w
}

// ---------------------------------------------------------------------------
//  那两个数真的送到了
// ---------------------------------------------------------------------------

test('⭐ 量过、够 ⇒ 照起', async () => {
  const w = memWorld({ free: 8000, need: 3547 })
  const r = await w.sup.ensure(prof('e1'), { model: '/a' })
  assert.equal(r.action, 'start')
  assert.equal(w.spawned.length, 1)
})

test('⭐⭐ 量过、不够 ⇒ 拒绝，⛔ 而且一个进程都没起', async () => {
  const w = memWorld({ free: 900, need: 3547 })
  await assert.rejects(
    () => w.sup.ensure(prof('e1'), { model: '/a' }),
    (err) => {
      assert.equal(err.code, 'ENGINE_NO_MEMORY')
      // 三个数都得说出来，⛔ 不许只丢一句「内存不够」
      assert.ok(err.message.includes('3547'), '要说它历史上吃过多少')
      assert.ok(err.message.includes('900'), '要说现在还剩多少')
      assert.ok(/408\d/.test(err.message), '要说加了余量之后需要多少')
      return true
    })
  assert.equal(w.spawned.length, 0, '⛔ 拒绝了就不该起进程')
})

test('⛔⛔ 拒绝的时候不为这次请求腾地方（跟 busy 同一条规则）', async () => {
  const w = memWorld({ free: 8000, need: 3547 })
  await w.sup.ensure(prof('a'), { model: '/x' })
  w.killed.length = 0
  w.t += 10
  w.free = 900                       // 现在内存被别的程序吃掉了
  await assert.rejects(() => w.sup.ensure(prof('bb'), { model: '/y' }))
  assert.deepEqual(w.killed, [], '⛔ 一次注定失败的请求不该顺手关掉别人')
  assert.ok(w.sup.residents.has('a'), 'a 还得在跑')
})

// ---------------------------------------------------------------------------
//  「没量过」那一格 —— 暂定 A
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 没量过 + 调用方没说 ⇒ 放行（暂定 A：那条路上没有人可问）', async () => {
  const w = memWorld({ free: 8000, need: null })
  const r = await w.sup.ensure(prof('e1'), { model: '/a' })
  assert.equal(r.action, 'start')
})

test('⭐⭐⭐ 把那个暂定值翻成 false ⇒ 行为必须真的跟着变（⛔ 不许是个骗人的死开关）', async () => {
  const w = memWorld({ free: 8000, need: null, assumeConfirmed: false })
  await assert.rejects(
    () => w.sup.ensure(prof('e1'), { model: '/a' }),
    (err) => {
      assert.equal(err.code, 'ENGINE_NEEDS_CONFIRM')
      return true
    })
  assert.equal(w.spawned.length, 0)
})

test('⭐ 调用方显式说「用户还没确认」⇒ needs_confirm，跟那个暂定值无关', async () => {
  const w = memWorld({ free: 8000, need: null })   // assumeConfirmed 仍是 true
  await assert.rejects(
    () => w.sup.ensure(prof('e1'), { model: '/a' }, { confirmed: false }),
    (err) => {
      assert.equal(err.code, 'ENGINE_NEEDS_CONFIRM')
      return true
    })
})

test('⭐ 用户点了「继续启动」⇒ 同一个请求带 confirmed:true 就放行', async () => {
  const w = memWorld({ free: 8000, need: null })
  const r = await w.sup.ensure(prof('e1'), { model: '/a' }, { confirmed: true })
  assert.equal(r.action, 'start')
})

test('⛔ needs_confirm 那句话里不许编一个"预计需要多少"出来', async () => {
  const w = memWorld({ free: 6031, need: null, assumeConfirmed: false })
  await assert.rejects(
    () => w.sup.ensure(prof('e1'), { model: '/a' }),
    (err) => {
      assert.ok(err.message.includes('6031'), '当前可用要说')
      assert.ok(err.message.includes('未保存的工作会丢失'),
        '⭐ 必须说后果，⛔ 不是说"有个东西不确定"')
      assert.ok(!/预计|大约|约 \d/.test(err.message),
        '⛔ 走到这一支的全部原因就是我们不知道；编的数被信了之后错会算在平台头上')
      assert.equal(err.mem.freeMb, 6031)
      assert.equal(err.mem.needMb, null, '⭐ 得是 null，⛔ 不是 0')
      return true
    })
})

// ---------------------------------------------------------------------------
//  记账的三个时刻
// ---------------------------------------------------------------------------

test('⭐⭐ 起之前先落一笔「正在试」—— ⛔ 必须在 spawn 之前', async () => {
  const w = memWorld()
  await w.sup.ensure(prof('e1'), { model: '/a' })
  assert.deepEqual(w.order, ['attempt', 'spawn'],
    '⛔ spawn 之后才记的话，起一半就被系统杀掉的那次一点痕迹都不会留下')
  assert.deepEqual(w.attempted, ['e1'])
})

test('⭐ 上线那一刻就记一笔（顺手销掉「正在试」，免得被误记成崩过）', async () => {
  const w = memWorld({ peak: 1200 })
  await w.sup.ensure(prof('e1'), { model: '/a' })
  assert.deepEqual(w.recorded, [['e1', 1200]])
})

test('⭐⭐⭐ 合成跑完（markBusy false）⇒ 对着 spawn 给的那个 pid 读峰值', async () => {
  const w = memWorld({ peak: 3547 })
  await w.sup.ensure(prof('e1'), { model: '/a' })
  const pid = w.spawned[0].proc.pid
  w.recorded.length = 0
  w.sampled.length = 0
  w.sup.markBusy('e1', true)
  assert.deepEqual(w.recorded, [], '开始合成的时候不用量')
  w.sup.markBusy('e1', false)
  assert.deepEqual(w.recorded, [['e1', 3547]])
  assert.deepEqual(w.sampled, [pid],
    '⭐ 量的是 spawn 当场给我们的那个 pid，⛔ 不是靠 exe 路径猜出来的')
})

test('⛔ markBusy(false) 重复调 ⇒ 只量一次（每量一次都要问一次操作系统）', async () => {
  const w = memWorld()
  await w.sup.ensure(prof('e1'), { model: '/a' })
  w.sup.markBusy('e1', true)
  w.recorded.length = 0
  w.sup.markBusy('e1', false)
  w.sup.markBusy('e1', false)
  w.sup.markBusy('e1', false)
  assert.equal(w.recorded.length, 1)
})

test('⭐ 关掉之前是最后一次机会 —— kill 之前量，⛔ 不是之后', async () => {
  const w = memWorld({ peak: 2000 })
  await w.sup.ensure(prof('e1'), { model: '/a' })
  w.recorded.length = 0
  w.sup.stop('e1', '空闲太久')
  assert.deepEqual(w.recorded, [['e1', 2000]],
    'kill 之后再读只会拿到 ok:false，那一整段的教训就白丢了')
})

test('⛔⛔ 进程已经没了（ok:false）⇒ 整笔丢掉，绝不写 0', async () => {
  const w = memWorld()
  await w.sup.ensure(prof('e1'), { model: '/a' })
  w.recorded.length = 0
  w.peak = null                      // sampleTree 现在返回 ok:false
  w.sup.markBusy('e1', true)
  w.sup.markBusy('e1', false)
  assert.deepEqual(w.recorded, [],
    '写 0 等于声称这台引擎不吃内存 —— 账本里最危险的一条记录')
})

// ---------------------------------------------------------------------------
//  坏掉的时候：记不住账是遗憾，起不了引擎是故障
// ---------------------------------------------------------------------------

test('⛔ 读不到剩余内存 ⇒ 整个不做内存判断，照起（⛔ 不许留半份判据）', async () => {
  const w = memWorld({ free: 900, need: 3547, freeThrows: true })
  const r = await w.sup.ensure(prof('e1'), { model: '/a' })
  assert.equal(r.action, 'start')
})

test('⛔ 账本坏了（needMb 抛）⇒ 当成没量过，⛔ 不抛出去', async () => {
  const w = memWorld({ free: 8000, needThrows: true })
  assert.equal((await w.sup.ensure(prof('e1'), { model: '/a' })).action, 'start')
})

test('⛔ 写不进去 / 量的时候抛 / 记不下「正在试」⇒ 引擎照样起得来', async () => {
  const a = memWorld({ recordThrows: true })
  assert.equal((await a.sup.ensure(prof('e1'), { model: '/a' })).action, 'start')
  const b = memWorld({ sampleThrows: true })
  assert.equal((await b.sup.ensure(prof('e1'), { model: '/a' })).action, 'start')
  const c = memWorld({ attemptThrows: true })
  assert.equal((await c.sup.ensure(prof('e1'), { model: '/a' })).action, 'start')
})

test('⛔ 一个都不注入 ⇒ 判据整个不生效，老行为一个字不变', async () => {
  const w = memWorld({ noMem: true, free: 1, need: 99999 })
  const r = await w.sup.ensure(prof('e1'), { model: '/a' })
  assert.equal(r.action, 'start')
  assert.deepEqual(w.sup.reapCrashes(), [])
  assert.deepEqual(w.recorded, [])
})

// ---------------------------------------------------------------------------
//  哪几支**不**做内存判断
// ---------------------------------------------------------------------------

test('⭐⭐ relaunch ⛔ 不做内存判断（先关自己再起，净增为零）', async () => {
  const w = memWorld({ free: 8000, need: 3547 })
  await w.sup.ensure(prof('e1'), { model: '/a' })
  w.t += 10
  w.free = 100                       // 现在内存少得可怜
  const r = await w.sup.ensure(prof('e1'), { model: '/b' })
  assert.equal(r.action, 'relaunch',
    '这里要是拦了，用户会在一台完全正常的机器上永远换不了模型')
})

test('⭐ reuse 也不做内存判断（它压根没多吃一个字节）', async () => {
  const w = memWorld({ free: 8000, need: 3547 })
  await w.sup.ensure(prof('e1'), { model: '/a' })
  w.t += 10
  w.free = 100
  const r = await w.sup.ensure(prof('e1'), { model: '/a' })
  assert.equal(r.action, 'reuse')
})

// ---------------------------------------------------------------------------
//  开机结账 + 守卫
// ---------------------------------------------------------------------------

test('⭐⭐ 开机结账：上次挂着「正在试」的报出来，而且说得像句人话', () => {
  const w = memWorld({ reaped: ['e1', 'e2'] })
  assert.deepEqual(w.sup.reapCrashes(), ['e1', 'e2'])
  const said = w.logs.join('\n')
  assert.ok(said.includes('e1') && said.includes('没活着回来'))
  assert.ok(said.includes('内存不够'),
    '⭐ 得让人知道该去关点别的程序，⛔ 不是丢一个 id 出来')
})

test('⛔ 守卫：那个暂定常量必须长得像暂定的', () => {
  const src = fs.readFileSync(path.join(__dirname, 'supervisor.js'), 'utf8')
  assert.ok(src.includes('ASSUME_CONFIRMED_WHEN_NOBODY_TO_ASK'),
    '暂定的东西必须有个说得出口的名字')
  assert.ok(src.includes('暂定'),
    '⛔ 注释里必须写明它是暂定的，不是想清楚了才这么定的')
  assert.ok(!/AURIVOX_ASSUME|ASSUME_CONFIRMED[A-Z_]*'\]|env, 'ASSUME/.test(src),
    '⛔ 不许做成环境变量 —— 变量意味着"这是给用户调的"，而这是我们自己还没想明白')
})

test('⛔ 守卫：这个文件里不许出现任何引擎 id', () => {
  const src = fs.readFileSync(path.join(__dirname, 'supervisor.js'), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  for (const banned of ['gpt', 'sovits', 'indextts', 'IndexTTS']) {
    assert.ok(!code.includes(banned),
      `接了内存判据之后 supervisor.js 里出现了 ${banned} —— ` +
      '⭐ 量的是**进程**不是引擎，对任何一台 TTS 都必须逐字一样')
  }
})
