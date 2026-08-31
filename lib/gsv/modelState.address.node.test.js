'use strict'

// ===========================================================================
//  换权重发给哪一台（2026-08-31 那个 500 的钉子）
// ===========================================================================
// 病历：界面上选好音色一按生成 → "Error: Internal server error"，一声不出。
// 链条：名片两个模型位都是 applies_at:"call"（engines/gpt-sovits/manifest.json）
//   ⇒ 每次合成先 switchModels ⇒ ModelSwitcher.ensure 调 gsvGet 时**不带地址**
//   ⇒ lib/gsv/client.js 的 requireBaseUrl 当场抛 ENGINE_BASE_URL_MISSING
//   ⇒ 落到通用兜底，前端只看得到 500。
//
// ⚠ 这个 bug 躲过了 1334 条测试：老测试的假 gsvGet 只收 (path, params)，
//   第三个参数传没传它都一样绿。所以这个文件里有一半用例是**看第三个参数**的。
//
// ⭐ 最后一条起一个真的 http 服务当假引擎，验证请求真的落在**那台的端口**上
//   —— 假的 gsvGet 证明不了「地址是通的」，只有真 socket 能。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { ModelSwitcher } = require('./modelState')
const { gsvGet } = require('./client')

const CFG = { gpt_model: 'g1.ckpt', sovits_model: 's1.pth' }
const OK = { statusCode: 200, body: Buffer.from('ok') }

// 两张形状够用的名片（值是这个文件自己造的）。
const A = { id: 'engine-a', base_url: 'http://127.0.0.1:1111', timeout_ms: 111000 }
const B = { id: 'engine-b', base_url: 'http://127.0.0.1:2222', timeout_ms: 222000 }

function recorder (reply = () => OK) {
  const calls = []
  const fn = async (pathStr, params, opts) => {
    calls.push({ pathStr, params, opts })
    return reply(pathStr, calls.length)
  }
  return { fn, calls }
}

// --------------------------------------------------------------------------
//  地址跟着名片走
// --------------------------------------------------------------------------

test('⭐⭐⭐ ensure 带名片 ⇒ 每一句换权重都把 baseUrl / reqTimeout 交给客户端', async () => {
  const { fn, calls } = recorder()
  const sw = new ModelSwitcher(fn)
  await sw.ensure(CFG, A)
  assert.deepEqual(calls.map((c) => c.pathStr), ['/set_gpt_weights', '/set_sovits_weights'])
  for (const c of calls) {
    assert.ok(c.opts, '⛔ 第三个参数不能是 undefined —— 那正是 ENGINE_BASE_URL_MISSING 的原样')
    assert.equal(c.opts.baseUrl, 'http://127.0.0.1:1111')
    // 超时也要用这台自己的：一台 CPU 慢引擎套着另一台的超时会变成假的"引擎挂了"。
    assert.equal(c.opts.reqTimeout, 111000)
  }
})

test('ensure 不带名片 ⇒ 第三个参数是 undefined（老调用方行为逐字不变）', async () => {
  const { fn, calls } = recorder()
  const sw = new ModelSwitcher(fn)
  await sw.ensure(CFG)
  assert.equal(calls.length, 2)
  for (const c of calls) assert.equal(c.opts, undefined)
  // ⚠ 这里不是"兜底一台"：不给地址就让客户端照旧抛，理由与刀 2 相同。
  assert.deepEqual(sw.loaded, { gpt: 'g1.ckpt', sovits: 's1.pth' })
})

// --------------------------------------------------------------------------
//  一台引擎一格
// --------------------------------------------------------------------------

test('⭐⭐ 两台引擎不共用缓存：A 上装过，⛔ 不许让 B 跳过换权重', async () => {
  // 全局一份缓存的症状最难查：不报错、参数都对、**只是声音不对**。
  const { fn, calls } = recorder()
  const sw = new ModelSwitcher(fn)
  const r1 = await sw.ensure(CFG, A)
  assert.equal(r1.switchedGpt, true)
  const r2 = await sw.ensure(CFG, B)
  assert.equal(r2.switchedGpt, true, 'B 的显存里没有这份权重，必须真的换')
  assert.equal(r2.skippedGpt, false)
  assert.equal(calls.length, 4)
  assert.equal(calls[2].opts.baseUrl, 'http://127.0.0.1:2222')
  // 各自记各自的
  assert.deepEqual(sw.loadedFor(A), { gpt: 'g1.ckpt', sovits: 's1.pth' })
  assert.deepEqual(sw.loadedFor(B), { gpt: 'g1.ckpt', sovits: 's1.pth' })
})

test('同一台连着来两次 ⇒ 照旧跳过（省下的那次重载没丢）', async () => {
  const { fn, calls } = recorder()
  const sw = new ModelSwitcher(fn)
  await sw.ensure(CFG, A)
  const r = await sw.ensure(CFG, A)
  assert.equal(r.skippedGpt, true)
  assert.equal(r.skippedSovits, true)
  assert.equal(calls.length, 2, '第二次一个请求都不该发')
})

test('地址就是身份：同一个 id 换了地址 ⇒ 当另一台处理', async () => {
  // 换机器 / 换端口重启后显存是空的，认 id 会让下一次静默跳过。
  const { fn } = recorder()
  const sw = new ModelSwitcher(fn)
  await sw.ensure(CFG, A)
  const moved = { ...A, base_url: 'http://127.0.0.1:9999' }
  const r = await sw.ensure(CFG, moved)
  assert.equal(r.switchedGpt, true)
  assert.equal(r.skippedGpt, false)
})

test('某台换失败 ⇒ 只清那一台的格子，别人的记录不受牵连', async () => {
  const { fn } = recorder((pathStr, n) => (n === 3 ? { statusCode: 500, body: Buffer.from('boom') } : OK))
  const sw = new ModelSwitcher(fn)
  await sw.ensure(CFG, A)                        // 1,2 成功
  await assert.rejects(() => sw.ensure(CFG, B),  // 3 失败
    (e) => /set_gpt_weights failed \(500\): boom/.test(e.message))
  assert.deepEqual(sw.loadedFor(B), { gpt: null, sovits: null }, 'B 的显存现在是未知的')
  assert.deepEqual(sw.loadedFor(A), { gpt: 'g1.ckpt', sovits: 's1.pth' }, '⛔ A 没出事，不该被连坐')
})

test('reset() 清所有格（健康探测说不出是哪台重启的 ⇒ 往多了清）', async () => {
  const { fn } = recorder()
  const sw = new ModelSwitcher(fn)
  await sw.ensure(CFG, A)
  await sw.ensure(CFG, B)
  sw.reset()
  assert.deepEqual(sw.loadedFor(A), { gpt: null, sovits: null })
  assert.deepEqual(sw.loadedFor(B), { gpt: null, sovits: null })
})

// --------------------------------------------------------------------------
//  真 socket：换权重确实落在那台的端口上
// --------------------------------------------------------------------------

test('⭐⭐⭐ 接真客户端：换权重打到被选中那台的端口，另一台一个请求都没收到', async () => {
  const hits = { a: [], b: [] }
  const mk = (bucket) => http.createServer((req, res) => {
    bucket.push(req.url)
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })
  const srvA = mk(hits.a); const srvB = mk(hits.b)
  await new Promise((r) => srvA.listen(0, '127.0.0.1', r))
  await new Promise((r) => srvB.listen(0, '127.0.0.1', r))
  const engA = { id: 'a', base_url: `http://127.0.0.1:${srvA.address().port}`, timeout_ms: 5000 }
  const engB = { id: 'b', base_url: `http://127.0.0.1:${srvB.address().port}`, timeout_ms: 5000 }
  try {
    const sw = new ModelSwitcher(gsvGet)          // ⭐ 真客户端，不是假的
    await sw.ensure(CFG, engB)
    assert.deepEqual(hits.a, [], '⛔ 没被选中的那台不该收到任何东西')
    assert.equal(hits.b.length, 2)
    assert.match(hits.b[0], /^\/set_gpt_weights\?weights_path=g1\.ckpt$/)
    assert.match(hits.b[1], /^\/set_sovits_weights\?weights_path=s1\.pth$/)
  } finally {
    await new Promise((r) => srvA.close(r))
    await new Promise((r) => srvB.close(r))
  }
})

test('⭐⭐⭐ 接真客户端：不带名片 ⇒ 当场 ENGINE_BASE_URL_MISSING（这就是那个 500）', async () => {
  const sw = new ModelSwitcher(gsvGet)
  await assert.rejects(() => sw.ensure(CFG), (e) => e.code === 'ENGINE_BASE_URL_MISSING')
  // ⚠ 这条不是"应该修的行为"，是**病灶的原样**：客户端拒绝替调用方挑一台，
  //   所以漏传地址的调用点必须自己修（server.js 的 switchModels 已经传了）。
})
