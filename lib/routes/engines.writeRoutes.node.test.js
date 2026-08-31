'use strict'

// ===========================================================================
//  刀 F1 的守卫：引擎的**写路**（POST 起 / 停）
// ===========================================================================
//
// 这一刀之前，lib/routes/engines.js 只有 1 个路由，且是 GET。
// supervisor.ensure() 唯一的活调用点在合成里（services/synthesisService.js:375），
// supervisor.stop(id) 活代码里 0 个调用点。
// ⇒ 界面能"看"引擎，⛔ 不能"动"引擎；想起一台引擎唯一的办法是点一次合成。
//
// ⭐⭐⭐ 这个文件守的是**接线**，不是编排。判"能不能起"全是 residency.js +
//   supervisor 的活（那两个文件已经被 supervisor*.node.test.js 测穷）。
//   这里只问四件事：
//     1. 口在不在（POST 注册了没有）
//     2. 有没有走那把全局合成锁
//     3. 错误码有没有被翻成能区分的 HTTP 状态码
//     4. "没说 confirmed" 有没有被写成 "说了不同意"
//
// ⛔ 不许把这些改成"文本守卫"（grep 源码里有没有那个词）。文本守卫在
//   E1 那一刀已经吃过一次亏：build 绿、守卫绿、界面静默坏掉。
//   这里全部是**真的把 handler 调起来**看它干了什么。

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

// ---- 假 express（手法与同目录 engines.node.test.js 一致；沙箱没有 node_modules）
const routes = []
function fakeRouter () {
  const r = {}
  for (const m of ['get', 'post', 'put', 'delete', 'use', 'all']) {
    r[m] = (p, ...handlers) => { routes.push({ method: m, path: p, handlers }); return r }
  }
  return r
}
const fakeExpress = () => fakeRouter()
fakeExpress.Router = fakeRouter
fakeExpress.json = () => (req, res, next) => next()
fakeExpress.static = () => (req, res, next) => next()

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'express') return 'express'
  return origResolve.call(this, request, ...rest)
}
require.cache.express = { id: 'express', filename: 'express', loaded: true, exports: fakeExpress }

const createRouter = require('./engines')
const { listEngineIds } = require('../engines/registry')

// 拿一台**真**引擎的 id。⛔ 不许在这里写死引擎名字（本目录的规矩，
//   registry.js 那边有守卫盯着"路由文件里不许出现具体引擎名"）。
const REAL_ID = listEngineIds()[0]

function fakeRes () {
  const res = { statusCode: 200, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  return res
}

function findRoute (path, ctx) {
  routes.length = 0
  createRouter(ctx)
  const r = routes.find((x) => x.method === 'post' && x.path === path)
  return r
}

async function post (path, { id, body = {}, ctx = {} } = {}) {
  const r = findRoute(path, ctx)
  assert.ok(r, `${path} 这条路由没被注册`)
  const res = fakeRes()
  await r.handlers[r.handlers.length - 1]({ params: { id }, body, query: {} }, res)
  return res
}

// 一个够用的假看管人。⛔ 不 require 真 supervisor —— 那会把这条测试变成
//   "supervisor 还工作吗"，而它自己那两个文件已经在问这个了。
function fakeSup (over = {}) {
  const calls = []
  const sup = {
    calls,
    status: () => over.status || {},
    ensure: async (profile, selection, opts) => {
      calls.push({ fn: 'ensure', id: profile && profile.id, selection, opts })
      if (over.ensureThrows) throw over.ensureThrows
      return { action: 'start', base_url: 'http://x', waited_ms: 1 }
    },
    stop: (id, why) => {
      calls.push({ fn: 'stop', id, why })
      return over.stopReturns === undefined ? true : over.stopReturns
    },
  }
  return sup
}

// 记账版的锁：谁进来过、被包住的那段有没有真的在里面跑。
function fakeLock () {
  const state = { entered: 0, insideAtCall: false }
  const withLock = async (fn) => {
    state.entered++
    state.inside = true
    try { return await fn() } finally { state.inside = false }
  }
  return { state, withLock }
}

// ===========================================================================
//  1. 口在不在
// ===========================================================================

test('⭐⭐⭐ 刀 F1：engines.js 必须有起 / 停两个 POST —— 今天之前这个文件一个写路都没有', () => {
  routes.length = 0
  createRouter({})
  const posts = routes.filter((r) => r.method === 'post').map((r) => r.path)
  assert.ok(
    posts.includes('/api/engines/:id/start'),
    '没有启动引擎的口 —— 那就还是"只有点合成才能起引擎"，F1 没做完'
  )
  assert.ok(
    posts.includes('/api/engines/:id/stop'),
    '没有关闭引擎的口 —— supervisor.stop(id) 又回到 0 个活调用点'
  )
})

// ===========================================================================
//  2. 那把锁
// ===========================================================================

test('⭐⭐⭐ 起引擎必须在全局合成锁里调 ensure()', async () => {
  const sup = fakeSup()
  const lock = fakeLock()
  let insideWhenEnsured = null
  const wrapped = Object.assign({}, sup, {
    ensure: async (...a) => { insideWhenEnsured = lock.state.inside; return sup.ensure(...a) },
  })
  const res = await post('/api/engines/:id/start', {
    id: REAL_ID,
    ctx: { engineSupervisor: wrapped, withGenerationLock: lock.withLock },
  })
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(lock.state.entered, 1, '起引擎没有进那把锁')
  assert.equal(
    insideWhenEnsured, true,
    'ensure() 是在锁外面被调的 —— 表现不是报错，是"一边正在合成、另一边把进程重开了"，用户拿到半截音频'
  )
})

test('⭐⭐ 停引擎也必须在锁里', async () => {
  const sup = fakeSup()
  const lock = fakeLock()
  const res = await post('/api/engines/:id/stop', {
    id: REAL_ID,
    ctx: { engineSupervisor: sup, withGenerationLock: lock.withLock },
  })
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(lock.state.entered, 1, '停引擎没有进那把锁')
})

test('⭐⭐⭐ 拿不到锁时必须拒绝，⛔ 不许退化成不加锁直接调', async () => {
  const sup = fakeSup()
  const res = await post('/api/engines/:id/start', {
    id: REAL_ID,
    ctx: { engineSupervisor: sup }, // 没有 withGenerationLock
  })
  assert.equal(res.statusCode, 501, '没有锁却把请求放行了 —— 那是"能跑但会偶尔坏"，比起不来更贵')
  assert.equal(res.body.code, 'ENGINE_LOCK_MISSING')
  assert.equal(sup.calls.length, 0, 'ensure() 在没有锁的情况下被调了')
})

test('没装看管人的部署：明说，⛔ 不假装起了', async () => {
  const res = await post('/api/engines/:id/start', { id: REAL_ID, ctx: {} })
  assert.equal(res.statusCode, 501)
  assert.equal(res.body.code, 'ENGINE_SUPERVISOR_MISSING')
})

// ===========================================================================
//  2b. 鉴权那道门
// ===========================================================================

test('⭐⭐⭐ 起 / 停两条路都必须挂 requireApiKey —— ⛔ 不许比 /api/fs/mkdir 更容易从外网够到', () => {
  const seen = []
  const guard = (req, res, next) => { seen.push(1); next() }
  routes.length = 0
  createRouter({ requireApiKey: guard })
  for (const p of ['/api/engines/:id/start', '/api/engines/:id/stop']) {
    const r = routes.find((x) => x.method === 'post' && x.path === p)
    assert.ok(r, `${p} 没注册`)
    assert.ok(
      r.handlers.length >= 2,
      `${p} 只有一个 handler —— 那道门没挂上。起一台引擎会吃掉几个 G 内存、关一台会杀掉一个进程`
    )
  }
})

test('⭐⭐ ctx 里没有 requireApiKey 时必须拒绝，⛔ 不许默默放行', async () => {
  routes.length = 0
  createRouter({ engineSupervisor: fakeSup(), withGenerationLock: fakeLock().withLock })
  const r = routes.find((x) => x.method === 'post' && x.path === '/api/engines/:id/stop')
  const res = fakeRes()
  let reached = false
  // 第一个 handler 就是那道门；它必须自己把请求挡下来，⛔ 不许 next()
  await r.handlers[0]({ params: { id: REAL_ID }, body: {}, query: {} }, res, () => { reached = true })
  assert.equal(reached, false, '接线漏了却 next() 放行 —— 这种漏法不会有任何症状')
  assert.equal(res.statusCode, 501)
  assert.equal(res.body.code, 'ENGINE_AUTH_MISSING')
})

// ===========================================================================
//  3. 错误码 → HTTP 状态码
// ===========================================================================

test('⭐⭐⭐ supervisor 的拒绝理由必须翻成能区分的状态码，⛔ 不许全压成 500', async () => {
  const cases = [
    ['ENGINE_NO_MEMORY', 409],
    ['ENGINE_BUSY_OTHER_WEIGHT', 409],
    ['ENGINE_NEEDS_CONFIRM', 409],
    ['ENGINE_TOO_MANY_LAUNCH_SLOTS', 400],
  ]
  for (const [code, want] of cases) {
    const err = new Error('nope')
    err.code = code
    err.mem = { freeMb: 100, needMb: 200, wantMb: 300 }
    const lock = fakeLock()
    const res = await post('/api/engines/:id/start', {
      id: REAL_ID,
      ctx: { engineSupervisor: fakeSup({ ensureThrows: err }), withGenerationLock: lock.withLock },
    })
    assert.equal(res.statusCode, want, `${code} 应该是 ${want}，实际 ${res.statusCode}`)
    assert.equal(res.body.code, code, 'code 必须原样透给界面')
  }
})

test('⭐⭐ ENGINE_NEEDS_CONFIRM 必须把 mem 带出去 —— 界面要靠它排版那个弹框', async () => {
  const err = new Error('还没量过')
  err.code = 'ENGINE_NEEDS_CONFIRM'
  err.mem = { freeMb: 6030, needMb: null, wantMb: null }
  const lock = fakeLock()
  const res = await post('/api/engines/:id/start', {
    id: REAL_ID,
    ctx: { engineSupervisor: fakeSup({ ensureThrows: err }), withGenerationLock: lock.withLock },
  })
  assert.equal(res.body.mem.freeMb, 6030,
    'mem 被吞了 —— 那句文案里**故意没有**"预计要多少"（supervisor.js:372），界面除了 mem 没有别的来源')
})

test('不存在的引擎是 404，⛔ 不是 500', async () => {
  const lock = fakeLock()
  const res = await post('/api/engines/:id/start', {
    id: 'no-such-engine-' + Date.now(),
    ctx: { engineSupervisor: fakeSup(), withGenerationLock: lock.withLock },
  })
  assert.equal(res.statusCode, 404, JSON.stringify(res.body))
})

// ===========================================================================
//  4. "没说" ≠ "说了不同意"
// ===========================================================================

test('⭐⭐⭐ 请求里没写 confirmed 时，⛔ 不许把它变成 confirmed:false', async () => {
  const sup = fakeSup()
  const lock = fakeLock()
  await post('/api/engines/:id/start', {
    id: REAL_ID,
    body: {},
    ctx: { engineSupervisor: sup, withGenerationLock: lock.withLock },
  })
  const call = sup.calls.find((c) => c.fn === 'ensure')
  assert.equal(
    Object.prototype.hasOwnProperty.call(call.opts, 'confirmed'), false,
    'supervisor.js:337 靠 undefined 区分"没说"和"说了不同意"；写成 !!body.confirmed 会让每次手动启动都被拒'
  )
})

test('显式 confirmed:false 必须原样传下去', async () => {
  const sup = fakeSup()
  const lock = fakeLock()
  await post('/api/engines/:id/start', {
    id: REAL_ID,
    body: { confirmed: false },
    ctx: { engineSupervisor: sup, withGenerationLock: lock.withLock },
  })
  assert.equal(sup.calls.find((c) => c.fn === 'ensure').opts.confirmed, false)
})

test('weights 原样交给 ensure()（平台级的模型位选择，⛔ 不进引擎请求体）', async () => {
  const sup = fakeSup()
  const lock = fakeLock()
  await post('/api/engines/:id/start', {
    id: REAL_ID,
    body: { weights: { model: '/a/b.ckpt' } },
    ctx: { engineSupervisor: sup, withGenerationLock: lock.withLock },
  })
  assert.deepEqual(sup.calls.find((c) => c.fn === 'ensure').selection, { model: '/a/b.ckpt' })
})

// ===========================================================================
//  5. 停的两条规矩
// ===========================================================================

test('⭐⭐⭐ 正在合成的引擎不许关 —— 关掉的表现是半截音频，⛔ 不是一句报错', async () => {
  const sup = fakeSup({ status: { [REAL_ID]: { running: true, busy: true } } })
  const lock = fakeLock()
  const res = await post('/api/engines/:id/stop', {
    id: REAL_ID,
    ctx: { engineSupervisor: sup, withGenerationLock: lock.withLock },
  })
  assert.equal(res.statusCode, 409, JSON.stringify(res.body))
  assert.equal(res.body.code, 'ENGINE_BUSY')
  assert.equal(sup.calls.filter((c) => c.fn === 'stop').length, 0, 'busy 的引擎被真的关掉了')
})

test('⭐ 关一台本来就没开的引擎必须成功（幂等）—— 界面才敢无脑重试', async () => {
  const sup = fakeSup({ stopReturns: false })
  const lock = fakeLock()
  const res = await post('/api/engines/:id/stop', {
    id: REAL_ID,
    ctx: { engineSupervisor: sup, withGenerationLock: lock.withLock },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.stopped, false, '"本来就没开"和"刚给你关了"要能分开')
})

// ===========================================================================
//  6. 起的结果不许被压平
// ===========================================================================

test('⭐⭐ action 必须原样透出去：reuse / start / not-ours 对用户不是一回事', async () => {
  for (const action of ['start', 'reuse', 'relaunch', 'not-ours']) {
    const sup = fakeSup()
    sup.ensure = async () => ({ action, base_url: 'http://x', waited_ms: 0 })
    const lock = fakeLock()
    const res = await post('/api/engines/:id/start', {
      id: REAL_ID,
      ctx: { engineSupervisor: sup, withGenerationLock: lock.withLock },
    })
    assert.equal(res.body.action, action,
      '压成 { ok:true } 之后，"本来就在跑"和"刚起起来"就分不开了；而 not-ours（名片没写 runtime）是合法状态')
  }
})
