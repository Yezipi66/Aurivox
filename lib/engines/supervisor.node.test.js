'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { EngineSupervisor } = require('./supervisor')

// ---------------------------------------------------------------------------
//  假的世界：假进程、假网络、假时钟
// ---------------------------------------------------------------------------
// ⭐ 这一层最值钱的用例全是「真机上很难复现」的那几种：引擎起来就崩、
//   起来了但 180 秒不上线、腾地方腾掉了正在合成的那一台。
//   ⛔ 靠真引擎去测，这三种一个都测不到。

function makeWorld(over = {}) {
  const w = {
    t: 1000,
    spawned: [],
    killed: [],
    logs: [],
    // 第 n 次探活的结果。默认第一次就上线。
    probeResults: over.probeResults || [true],
    probeCalls: [],
    slept: 0,
  }
  w.deps = {
    now: () => w.t,
    sleep: async (ms) => { w.slept += ms; w.t += ms },
    log: (l) => w.logs.push(l),
    env: over.env || {},
    loadProfile: (id) => w.profiles[id],
    buildPlan: over.buildPlan || ((profile, opts) => ({
      id: profile.id,
      launchable: !!profile.runtime,
      base_url: profile.base_url || 'http://127.0.0.1:9999',
      ready_url: 'http://127.0.0.1:9999/health',
      ready_timeout_ms: (profile.runtime && profile.runtime.ready_timeout_ms) || 5000,
      checkpoints: opts.checkpointsOverride || null,
      _opts: opts,
    })),
    spawn: over.spawn || (async (plan) => {
      const proc = { pid: 100 + w.spawned.length, exitCode: null, kill() { w.killed.push(plan.id) } }
      w.spawned.push({ plan, proc })
      return proc
    }),
    probe: async (url, ms) => {
      w.probeCalls.push(url)
      const r = w.probeResults[Math.min(w.probeCalls.length - 1, w.probeResults.length - 1)]
      return !!r
    },
  }
  w.sup = new EngineSupervisor(w.deps)
  return w
}

function prof(id, slots, over = {}) {
  return Object.assign({
    id,
    label: id,
    base_url: `http://127.0.0.1:${9000 + id.length}`,
    weight_slots: slots,
    runtime: { ready_endpoint: '/health', ready_timeout_ms: 5000, preload: true },
  }, over)
}

const LAUNCH = [{ name: 'model', applies_at: 'launch' }]
const CALL = [{ name: 'a', applies_at: 'call', param: 'pa' }]

// ---------------------------------------------------------------------------
//  起 / 复用 / 重开
// ---------------------------------------------------------------------------

test('第一次用到 ⇒ 起一次，等它上线', async () => {
  const w = makeWorld()
  const r = await w.sup.ensure(prof('e1', LAUNCH), { model: '/a' })
  assert.equal(r.action, 'start')
  assert.equal(w.spawned.length, 1)
  assert.equal(w.probeCalls.length, 1)
})

test('⭐ 第二次用同一份 ⇒ 直接用，不再起（这是常态路径，起一次要一分钟）', async () => {
  const w = makeWorld()
  const p = prof('e1', LAUNCH)
  await w.sup.ensure(p, { model: '/a' })
  const r = await w.sup.ensure(p, { model: '/a' })
  assert.equal(r.action, 'reuse')
  assert.equal(w.spawned.length, 1, '起了第二次 = 用户白等一分钟')
  assert.equal(r.waited_ms, 0)
})

test('⭐⭐⭐ 换一份模型 ⇒ 关掉再带着新的起一次', async () => {
  // 这就是「界面上选了模型不生效、还不报错」的修法。
  const w = makeWorld({ probeResults: [true, true] })
  const p = prof('e1', LAUNCH)
  await w.sup.ensure(p, { model: 'assets/x/models/e1/model/one' })
  const r = await w.sup.ensure(p, { model: 'assets/x/models/e1/model/two' })
  assert.equal(r.action, 'relaunch')
  assert.equal(w.killed.length, 1, '不关掉就再起一个 = 两份内存同时吃着')
  assert.equal(w.spawned.length, 2)
  assert.equal(w.spawned[1].plan._opts.checkpointsOverride,
    'assets/x/models/e1/model/two',
    '⛔ 重开了却没把新选的那一份送进去 = 白重开一次，声音还是旧的')
})

test('⭐ 只有调用时换的位 ⇒ 换来换去都不重开', async () => {
  const w = makeWorld({ probeResults: [true, true] })
  const p = prof('e2', CALL)
  await w.sup.ensure(p, { a: '/one' })
  const r = await w.sup.ensure(p, { a: '/two' })
  assert.equal(r.action, 'reuse')
  assert.equal(w.spawned.length, 1)
})

test('⭐ 起进程时送进去的是**这一次选中**的那一份', async () => {
  const w = makeWorld()
  await w.sup.ensure(prof('e1', LAUNCH), { model: 'assets/a/models/e1/model/mine' })
  assert.equal(w.spawned[0].plan._opts.checkpointsOverride, 'assets/a/models/e1/model/mine')
})

test('没选 ⇒ 不顶替，用名片声明的底模', async () => {
  const w = makeWorld()
  await w.sup.ensure(prof('e1', LAUNCH), {})
  assert.ok(!w.spawned[0].plan._opts.checkpointsOverride)
})

test('⛔ 端口用**启动脚本已经定下来**的那个（那 90 行端口逻辑不搬过来）', async () => {
  const w = makeWorld()
  const p = prof('e1', LAUNCH)
  p.base_url = 'http://127.0.0.1:9903'   // 脚本挪过端口，写进了环境变量
  await w.sup.ensure(p, {})
  assert.equal(w.spawned[0].plan._opts.port, 9903)
})

// ---------------------------------------------------------------------------
//  常驻上限
// ---------------------------------------------------------------------------

test('⭐ 超过常驻上限 ⇒ 关掉最久没用的那一台', async () => {
  const w = makeWorld({ probeResults: [true, true, true] })
  await w.sup.ensure(prof('a', CALL), {}); w.t += 100
  await w.sup.ensure(prof('bb', CALL), {}); w.t += 100
  assert.equal(w.killed.length, 0)
  await w.sup.ensure(prof('ccc', CALL), {})
  assert.deepEqual(w.killed, ['a'])
})

test('上限可以从环境变量调（⛔ 不进名片：契约把排队/上限归给平台）', async () => {
  const w = makeWorld({ env: { AURIVOX_ENGINE_CAP: '1' }, probeResults: [true, true] })
  assert.equal(w.sup.cap, 1)
  await w.sup.ensure(prof('a', CALL), {}); w.t += 100
  await w.sup.ensure(prof('bb', CALL), {})
  assert.deepEqual(w.killed, ['a'])
})

test('环境变量写了垃圾 ⇒ 退回默认值，不崩', () => {
  const w = makeWorld({ env: { AURIVOX_ENGINE_CAP: 'abc', AURIVOX_ENGINE_IDLE_MS: '-5' } })
  assert.equal(w.sup.cap, 2)
  assert.equal(w.sup.idleMs, 600000)
})

test('⛔ 正在合成的那一台不会被腾掉', async () => {
  const w = makeWorld({ env: { AURIVOX_ENGINE_CAP: '1' }, probeResults: [true, true] })
  await w.sup.ensure(prof('a', CALL), {})
  w.sup.markBusy('a', true)
  w.t += 100
  await w.sup.ensure(prof('bb', CALL), {})
  assert.deepEqual(w.killed, [], '把正在出声的那一台关掉 = 用户这一次请求当场失败')
})

// ---------------------------------------------------------------------------
//  空闲释放
// ---------------------------------------------------------------------------

test('⭐⭐ 空闲够久的按需引擎会被放掉（内存该吐就吐）', async () => {
  const w = makeWorld({ env: { AURIVOX_ENGINE_IDLE_MS: '1000' } })
  await w.sup.ensure(prof('e1', LAUNCH), {})
  w.t += 1000
  assert.deepEqual(w.sup.sweep(), ['e1'])
  assert.deepEqual(w.killed, ['e1'])
  assert.deepEqual(w.sup.sweep(), [], '放过一次就不该再放第二次')
})

test('进程只是个壳的那一档，空闲再久也不放（关掉省不下，重开还白等）', async () => {
  const w = makeWorld({ env: { AURIVOX_ENGINE_IDLE_MS: '1000' } })
  await w.sup.ensure(prof('e2', CALL), {})
  w.t += 999999
  assert.deepEqual(w.sup.sweep(), [])
})

test('⛔ 正在合成时不放，哪怕已经"空闲"很久（长文本一跑就是几分钟）', async () => {
  const w = makeWorld({ env: { AURIVOX_ENGINE_IDLE_MS: '1000' } })
  await w.sup.ensure(prof('e1', LAUNCH), {})
  w.sup.markBusy('e1', true)
  w.t += 999999
  assert.deepEqual(w.sup.sweep(), [])
})

test('合成结束后重新计时', async () => {
  const w = makeWorld({ env: { AURIVOX_ENGINE_IDLE_MS: '1000' } })
  await w.sup.ensure(prof('e1', LAUNCH), {})
  w.t += 999999
  w.sup.markBusy('e1', false)     // 刚用完
  assert.deepEqual(w.sup.sweep(), [])
  w.t += 1000
  assert.deepEqual(w.sup.sweep(), ['e1'])
})

// ---------------------------------------------------------------------------
//  起不来 / 上不了线
// ---------------------------------------------------------------------------

test('⭐⭐ 起来就崩 ⇒ 当场说「刚起来就退出了」，⛔ 不要枯等满预算再报超时', async () => {
  // 报超时会把人指向"机器太慢"，而真相是引擎启动时抛异常退出了，日志里写着。
  const w = makeWorld({ probeResults: [false] })
  w.deps.spawn = async (plan) => {
    const proc = { pid: 7, exitCode: 1, kill() { w.killed.push(plan.id) } }
    w.spawned.push({ plan, proc })
    return proc
  }
  const sup = new EngineSupervisor(w.deps)
  await assert.rejects(() => sup.ensure(prof('e1', LAUNCH), {}), (e) => {
    assert.equal(e.code, 'ENGINE_EXITED_EARLY')
    assert.match(e.message, /退出/)
    assert.match(e.message, /log/, '必须指到日志文件，否则用户下一步不知道看哪儿')
    return true
  })
  assert.equal(w.slept, 0, '崩了还睡了一轮 = 白等')
  assert.equal(sup.status().e1, undefined, '起失败的进程不许留在册子里')
})

test('⭐⭐ 探活探不通 ⇒ 到预算就报超时，并且把预算是谁定的说清楚', async () => {
  const w = makeWorld({ probeResults: [false] })
  const p = prof('e1', LAUNCH)
  p.runtime.ready_timeout_ms = 3000
  await assert.rejects(() => w.sup.ensure(p, {}), (e) => {
    assert.equal(e.code, 'ENGINE_READY_TIMEOUT')
    assert.match(e.message, /3 秒/)
    assert.match(e.message, /manifest\.json/, '这个数是名片自己写的，要说出来')
    return true
  })
  assert.deepEqual(w.killed, ['e1'], '等不到就该把它收掉，不能留一个僵尸占着端口')
})

test('⭐ 探活一开始不通、后来通了 ⇒ 正常上线（冷启动就是这样的）', async () => {
  const w = makeWorld({ probeResults: [false, false, true] })
  const r = await w.sup.ensure(prof('e1', LAUNCH), {})
  assert.equal(r.action, 'start')
  assert.equal(w.probeCalls.length, 3)
  assert.ok(r.waited_ms > 0)
})

test('探活自己抛异常（连接被拒）⇒ 当成"还没上线"继续等，不是致命错', async () => {
  const w = makeWorld()
  let n = 0
  w.deps.probe = async () => { n += 1; if (n < 3) throw new Error('ECONNREFUSED'); return true }
  const sup = new EngineSupervisor(w.deps)
  const r = await sup.ensure(prof('e1', LAUNCH), {})
  assert.equal(r.action, 'start')
})

test('spawn 自己就失败 ⇒ 报得出是哪台引擎', async () => {
  const w = makeWorld()
  w.deps.spawn = async () => { throw new Error('python 不在这儿') }
  const sup = new EngineSupervisor(w.deps)
  await assert.rejects(() => sup.ensure(prof('e1', LAUNCH), {}), (e) => {
    assert.equal(e.code, 'ENGINE_SPAWN_FAILED')
    assert.match(e.message, /e1/)
    return true
  })
})

// ---------------------------------------------------------------------------
//  边界
// ---------------------------------------------------------------------------

test('⭐ 名片没写 runtime（作者自己起的引擎）⇒ 放行，⛔ 不假装起了它', async () => {
  const w = makeWorld()
  const p = prof('e9', CALL, { runtime: null })
  const r = await w.sup.ensure(p, {})
  assert.equal(r.action, 'not-ours')
  assert.equal(r.base_url, p.base_url)
  assert.equal(w.spawned.length, 0)
})

test('⭐⭐ 两个「开进程那一步吃进去」的位 ⇒ 当场拒绝，⛔ 不许挑一个送', async () => {
  // 静默丢掉第二个的表现是「选了不生效、不报错、声音不对」——
  // 这个仓库里最难查的一种坏法。
  const w = makeWorld()
  const p = prof('e1', [
    { name: 'aa', applies_at: 'launch' },
    { name: 'bb', applies_at: 'launch' },
  ])
  await assert.rejects(() => w.sup.ensure(p, { aa: '/1', bb: '/2' }), (e) => {
    assert.equal(e.code, 'ENGINE_TOO_MANY_LAUNCH_SLOTS')
    assert.match(e.message, /aa/)
    assert.match(e.message, /bb/, '两个位的名字都要说出来，接引擎的人才知道改哪儿')
    return true
  })
  assert.equal(w.spawned.length, 0)
})

test('没给引擎 ⇒ 报得清楚，不是 undefined 崩在里面', async () => {
  const w = makeWorld()
  await assert.rejects(() => w.sup.ensure(null, {}), (e) => e.code === 'ENGINE_UNKNOWN')
})

test('关一台没在跑的 ⇒ 什么都不做，不抛（幂等）', () => {
  const w = makeWorld()
  assert.equal(w.sup.stop('nobody'), false)
})

test('kill 自己抛异常 ⇒ 咽掉，册子照样清干净', async () => {
  const w = makeWorld()
  w.deps.spawn = async (plan) => {
    const proc = { pid: 1, exitCode: null, kill() { throw new Error('已经没了') } }
    w.spawned.push({ plan, proc })
    return proc
  }
  const sup = new EngineSupervisor(w.deps)
  await sup.ensure(prof('e1', LAUNCH), {})
  assert.equal(sup.stop('e1'), true)
  assert.equal(sup.status().e1, undefined, '关不掉就赖在册子里 = 这台引擎再也起不来了')
})

test('全部关掉', async () => {
  const w = makeWorld({ probeResults: [true, true] })
  await w.sup.ensure(prof('a', CALL), {})
  await w.sup.ensure(prof('bb', CALL), {})
  w.sup.stopAll()
  assert.deepEqual(Object.keys(w.sup.status()), [])
})

// ---------------------------------------------------------------------------
//  给界面看的进度
// ---------------------------------------------------------------------------

test('⭐ 加载途中问一句「在干什么」要答得上来（冷启动要等一分钟，不能一片空白）', async () => {
  const w = makeWorld({ probeResults: [false, true] })
  const seen = []
  w.deps.probe = async () => {
    seen.push(JSON.parse(JSON.stringify(w.sup.status())))
    return seen.length >= 2
  }
  const sup = new EngineSupervisor(w.deps)
  w.sup = sup
  const p = prof('e1', LAUNCH)
  p.runtime.ready_timeout_ms = 180000
  await sup.ensure(p, {})
  assert.equal(seen[0].e1.phase, 'loading')
  assert.match(seen[0].e1.detail, /180 秒/, '要把这台引擎自己写的预算说出来')
  assert.ok(!sup.status().e1.phase, '上线之后就不该再显示"正在加载"')
  assert.equal(sup.status().e1.running, true)
})

test('状态里有 pid / 起来的时间 / 是不是按需档', async () => {
  const w = makeWorld()
  await w.sup.ensure(prof('e1', LAUNCH), {})
  const s = w.sup.status().e1
  assert.equal(s.running, true)
  assert.equal(typeof s.pid, 'number')
  assert.equal(s.on_demand, true)
})

// ---------------------------------------------------------------------------
//  守卫
// ---------------------------------------------------------------------------

test('⛔ 守卫：supervisor.js 的代码里不许出现任何引擎 id / 模型位名', () => {
  const src = fs.readFileSync(path.join(__dirname, 'supervisor.js'), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  for (const banned of ['gpt', 'sovits', 'indextts', 'IndexTTS']) {
    assert.ok(!code.includes(banned),
      `supervisor.js 的代码里出现了 ${banned} —— 装一台谁都没见过的引擎，这个文件必须一个字都不用改`)
  }
})

test('⛔ 守卫：这一层不许自己去解端口冲突（那 90 行留在启动脚本里）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'supervisor.js'), 'utf8')
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  for (const banned of ['netstat', 'Get-NetTCPConnection', 'LISTENING', 'TIME_WAIT']) {
    assert.ok(!code.includes(banned), `端口冲突的判定不在这一层，出现了 ${banned}`)
  }
})
