'use strict'

// 换权重执行器：判据、去重、失败回退全部来自名片 weight_slots，不认任何一台引擎的名字。
// 这里刻意不用真名片做执行用例：执行器只该看见「位名 + param + switch」这三样。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { WeightSwitch } = require('./weightSwitch')
const { gsvGet } = require('../gsv/client')

const OK = { statusCode: 200, body: Buffer.from('ok') }

function recordingGet(reply = () => OK) {
  const calls = []
  const fn = async (pathStr, params, opts) => {
    calls.push({ pathStr, params, opts })
    return reply(pathStr, calls.length)
  }
  return { fn, calls }
}

function engine(over = {}) {
  return {
    id: 'engine-a',
    base_url: 'http://127.0.0.1:1111',
    timeout_ms: 111000,
    weight_slots: [
      { name: 'gpt', param: 'gpt_model', applies_at: 'call',
        switch: { endpoint: '/set_gpt_weights', query: 'weights_path' } },
      { name: 'sovits', param: 'sovits_model', applies_at: 'call',
        switch: { endpoint: '/set_sovits_weights', query: 'weights_path' } },
    ],
    ...over,
  }
}

const CFG = { gpt_model: 'g1.ckpt', sovits_model: 's1.pth' }

test('constructor rejects a non-function httpGet', () => {
  assert.throws(() => new WeightSwitch(null), TypeError)
  assert.throws(() => new WeightSwitch({}), /requires a httpGet/)
})

test('ensure 没有名片 ⇒ 当场抛（⛔ 不猜一台）', async () => {
  const sw = new WeightSwitch(recordingGet().fn)
  await assert.rejects(() => sw.ensure(CFG), /engine is required/)
})

test('第一次 ensure 按名片顺序换两个位，地址与超时都跟着名片走', async () => {
  const { fn, calls } = recordingGet()
  const sw = new WeightSwitch(fn)
  const r = await sw.ensure(CFG, engine())
  assert.deepEqual(r, { switched: ['gpt', 'sovits'], skipped: [] })
  assert.deepEqual(calls.map((c) => c.pathStr), ['/set_gpt_weights', '/set_sovits_weights'])
  assert.deepEqual(calls[0].params, { weights_path: 'g1.ckpt' })
  assert.deepEqual(calls[1].params, { weights_path: 's1.pth' })
  for (const c of calls) {
    assert.equal(c.opts.baseUrl, 'http://127.0.0.1:1111')
    assert.equal(c.opts.reqTimeout, 111000)
  }
  assert.deepEqual(sw.loadedFor(engine()), { gpt: 'g1.ckpt', sovits: 's1.pth' })
})

test('同一份连着来两次 ⇒ 第二次一个请求都不发', async () => {
  const { fn, calls } = recordingGet()
  const sw = new WeightSwitch(fn)
  await sw.ensure(CFG, engine())
  const r = await sw.ensure(CFG, engine())
  assert.deepEqual(r, { switched: [], skipped: ['gpt', 'sovits'] })
  assert.equal(calls.length, 2)
})

test('只换了一个位 ⇒ 另一位跳过，不重复发', async () => {
  const { fn, calls } = recordingGet()
  const sw = new WeightSwitch(fn)
  await sw.ensure(CFG, engine())
  const r = await sw.ensure({ gpt_model: 'g2.ckpt', sovits_model: 's1.pth' }, engine())
  assert.deepEqual(r, { switched: ['gpt'], skipped: ['sovits'] })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2], {
    pathStr: '/set_gpt_weights',
    params: { weights_path: 'g2.ckpt' },
    opts: { baseUrl: 'http://127.0.0.1:1111', reqTimeout: 111000 },
  })
})

test('这个位没选中任何一份（假值）⇒ 不发请求，已驻留的不动', async () => {
  const { fn, calls } = recordingGet()
  const sw = new WeightSwitch(fn)
  await sw.ensure(CFG, engine())
  calls.length = 0
  const r = await sw.ensure({ gpt_model: '', sovits_model: null }, engine())
  assert.deepEqual(r, { switched: [], skipped: [] })
  assert.equal(calls.length, 0)
  assert.deepEqual(sw.loadedFor(engine()), { gpt: 'g1.ckpt', sovits: 's1.pth' })
})

test('没有 switch 的 call 位 ⇒ 平台一次额外请求都不发（值随请求体送）', async () => {
  const { fn, calls } = recordingGet()
  const sw = new WeightSwitch(fn)
  const e = engine({
    weight_slots: [
      { name: 'voice', param: 'voice_model', applies_at: 'call' },
      { name: 'gpt', param: 'gpt_model', applies_at: 'call',
        switch: { endpoint: '/set_gpt_weights', query: 'weights_path' } },
    ],
  })
  const r = await sw.ensure({ voice_model: 'v1.bin', gpt_model: 'g1.ckpt' }, e)
  assert.deepEqual(r, { switched: ['gpt'], skipped: [] })
  assert.deepEqual(calls.map((c) => c.pathStr), ['/set_gpt_weights'])
})

test('launch 位不归执行器管：即使带了 switch 也不发', async () => {
  const { fn, calls } = recordingGet()
  const sw = new WeightSwitch(fn)
  const e = engine({
    weight_slots: [
      { name: 'base', param: 'base_model', applies_at: 'launch',
        switch: { endpoint: '/set_base', query: 'path' } },
    ],
  })
  const r = await sw.ensure({ base_model: 'b.bin' }, e)
  assert.deepEqual(r, { switched: [], skipped: [] })
  assert.equal(calls.length, 0)
})

test('切换失败 ⇒ 清掉这一位、抛错、下一次必换（⛔ 不假装成功）', async () => {
  let fail = true
  const { fn, calls } = recordingGet((pathStr) =>
    pathStr === '/set_gpt_weights' && fail ? { statusCode: 500, body: Buffer.from('boom') } : OK)
  const sw = new WeightSwitch(fn)
  await assert.rejects(() => sw.ensure(CFG, engine()), /\/set_gpt_weights failed \(500\): boom/)
  assert.equal(sw.loadedFor(engine()).gpt, null)
  fail = false
  calls.length = 0
  const r = await sw.ensure(CFG, engine())
  assert.deepEqual(r, { switched: ['gpt', 'sovits'], skipped: [] })
  assert.deepEqual(sw.loadedFor(engine()), { gpt: 'g1.ckpt', sovits: 's1.pth' })
})

test('第二位失败 ⇒ 第一位的驻留不受连坐，恢复时只补第二位', async () => {
  let fail = true
  const { fn, calls } = recordingGet((pathStr) =>
    pathStr === '/set_sovits_weights' && fail ? { statusCode: 503, body: Buffer.from('nope') } : OK)
  const sw = new WeightSwitch(fn)
  await assert.rejects(() => sw.ensure(CFG, engine()), /\/set_sovits_weights failed \(503\): nope/)
  assert.deepEqual(sw.loadedFor(engine()), { gpt: 'g1.ckpt', sovits: null })
  fail = false
  calls.length = 0
  const r = await sw.ensure(CFG, engine())
  assert.deepEqual(r, { switched: ['sovits'], skipped: ['gpt'] })
  assert.deepEqual(calls.map((c) => c.pathStr), ['/set_sovits_weights'])
})

test('传输层抛错 ⇒ 原样抛，驻留不前进', async () => {
  const { fn } = recordingGet()
  const sw = new WeightSwitch(fn)
  await sw.ensure(CFG, engine())
  sw._get = async () => { throw new Error('ECONNREFUSED') }
  await assert.rejects(() => sw.ensure({ gpt_model: 'new.ckpt', sovits_model: 's1.pth' }, engine()),
    /ECONNREFUSED/)
  assert.notEqual(sw.loadedFor(engine()).gpt, 'new.ckpt')
})

test('状态边界：399 算成功，400 算失败', async () => {
  const ok = new WeightSwitch(recordingGet(() => ({ statusCode: 399, body: Buffer.from('ok-ish') })).fn)
  assert.deepEqual(await ok.ensure({ gpt_model: 'g' }, engine()), { switched: ['gpt'], skipped: [] })
  const bad = new WeightSwitch(recordingGet(() => ({ statusCode: 400, body: Buffer.from('bad') })).fn)
  await assert.rejects(() => bad.ensure({ gpt_model: 'g' }, engine()), /\/set_gpt_weights failed \(400\)/)
  assert.equal(bad.loadedFor(engine()).gpt, null)
})

test('reset() 清所有格 ⇒ 下一次重新换', async () => {
  const { fn, calls } = recordingGet()
  const sw = new WeightSwitch(fn)
  await sw.ensure(CFG, engine())
  sw.reset()
  assert.deepEqual(sw.loadedFor(engine()), {})
  calls.length = 0
  assert.deepEqual(await sw.ensure(CFG, engine()), { switched: ['gpt', 'sovits'], skipped: [] })
  assert.equal(calls.length, 2)
})

test('noteEngineHealth：离线→上线翻转才清（引擎重启），持续在线不清', async () => {
  const { fn, calls } = recordingGet()
  const sw = new WeightSwitch(fn)
  await sw.ensure(CFG, engine())
  assert.equal(sw.noteEngineHealth(true), false)
  assert.equal(sw.noteEngineHealth(true), false)
  assert.equal(sw.noteEngineHealth(false), false)
  assert.equal(sw.noteEngineHealth(true), true)
  assert.deepEqual(sw.loadedFor(engine()), {})
  calls.length = 0
  assert.deepEqual(await sw.ensure(CFG, engine()), { switched: ['gpt', 'sovits'], skipped: [] })
})

test('⛔ 两台引擎不共用驻留：A 上装过，不许让 B 跳过', async () => {
  const { fn, calls } = recordingGet()
  const sw = new WeightSwitch(fn)
  await sw.ensure(CFG, engine({ id: 'a', base_url: 'http://127.0.0.1:1111' }))
  const r = await sw.ensure(CFG, engine({ id: 'b', base_url: 'http://127.0.0.1:2222' }))
  assert.deepEqual(r, { switched: ['gpt', 'sovits'], skipped: [] })
  assert.equal(calls.length, 4)
  assert.equal(calls[2].opts.baseUrl, 'http://127.0.0.1:2222')
})

test('⛔ 两张 stdio 名片（base_url 都是 null）也不共用驻留', async () => {
  const { fn, calls } = recordingGet()
  const sw = new WeightSwitch(fn)
  const a = engine({ id: 'stdio-a', base_url: null })
  const b = engine({ id: 'stdio-b', base_url: null })
  await sw.ensure(CFG, a)
  const r = await sw.ensure(CFG, b)
  assert.deepEqual(r, { switched: ['gpt', 'sovits'], skipped: [] })
  assert.equal(calls.length, 4)
  assert.equal(calls[2].opts.baseUrl, null)
})

test('地址就是身份：同一个 id 换了地址 ⇒ 当另一台处理', async () => {
  const { fn } = recordingGet()
  const sw = new WeightSwitch(fn)
  await sw.ensure(CFG, engine({ id: 'a', base_url: 'http://127.0.0.1:1111' }))
  const r = await sw.ensure(CFG, engine({ id: 'a', base_url: 'http://127.0.0.1:9999' }))
  assert.deepEqual(r, { switched: ['gpt', 'sovits'], skipped: [] })
})

// GSV 名片：两个位的请求序列固定为 /set_gpt_weights、/set_sovits_weights。

test('⭐⭐ GSV 名片：两个位都走原端点，请求序列与旧切换器相同', async () => {
  const { resolveEngineProfile } = require('./profile')
  const profile = resolveEngineProfile('gpt-sovits', {})
  assert.deepEqual(profile.weight_slots.map((s) => [s.name, s.switch.endpoint, s.switch.query]), [
    ['gpt', '/set_gpt_weights', 'weights_path'],
    ['sovits', '/set_sovits_weights', 'weights_path'],
  ])
  const { fn, calls } = recordingGet()
  const sw = new WeightSwitch(fn)
  await sw.ensure(CFG, profile)
  assert.deepEqual(calls.map((c) => c.pathStr), ['/set_gpt_weights', '/set_sovits_weights'])
  assert.deepEqual(calls[0].params, { weights_path: 'g1.ckpt' })
  assert.deepEqual(calls[1].params, { weights_path: 's1.pth' })
  assert.equal(calls[0].opts.baseUrl, profile.base_url)
  assert.equal(calls[0].opts.reqTimeout, profile.timeout_ms)
})

// 真 socket：切换请求确实落在名片写的那个端口上。

test('⭐⭐⭐ 接真客户端：切换打到点名那台的端口，另一台一个请求都没收到', async () => {
  const hits = { a: [], b: [] }
  const mk = (bucket) => http.createServer((req, res) => {
    bucket.push(req.url)
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })
  const srvA = mk(hits.a)
  const srvB = mk(hits.b)
  await new Promise((r) => srvA.listen(0, '127.0.0.1', r))
  await new Promise((r) => srvB.listen(0, '127.0.0.1', r))
  const engA = engine({ id: 'a', base_url: `http://127.0.0.1:${srvA.address().port}`, timeout_ms: 5000 })
  const engB = engine({ id: 'b', base_url: `http://127.0.0.1:${srvB.address().port}`, timeout_ms: 5000 })
  try {
    const sw = new WeightSwitch(gsvGet)
    await sw.ensure(CFG, engB)
    assert.deepEqual(hits.a, [])
    assert.equal(hits.b.length, 2)
    assert.match(hits.b[0], /^\/set_gpt_weights\?weights_path=g1\.ckpt$/)
    assert.match(hits.b[1], /^\/set_sovits_weights\?weights_path=s1\.pth$/)
  } finally {
    await new Promise((r) => srvA.close(r))
    await new Promise((r) => srvB.close(r))
  }
})

test('⭐⭐⭐ 接真客户端：地址没给 ⇒ 当场 ENGINE_BASE_URL_MISSING', async () => {
  const sw = new WeightSwitch(gsvGet)
  const e = engine({ base_url: null })
  await assert.rejects(() => sw.ensure(CFG, e), (err) => err.code === 'ENGINE_BASE_URL_MISSING')
})
