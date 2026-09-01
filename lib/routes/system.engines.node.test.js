'use strict'

// ===========================================================================
//  GET /api/health —— 逐台报健康（契约 §12 第 2 步 · 刀 1 第 ⑤ 条）
// ===========================================================================
//
// 这一条要成立的东西：界面上那个「引擎活没活」的点，在装了两台之后还说得清
// 说的是哪一台。今天它只有一个布尔 `engine_online`，含义是「老路径那台」——
// 装第二台的那一刻，这个字段既没变错、也不再够用。
//
// ⛔ Owner 拍板：**只增不改**。`engine_online` 与 `gpt_sovits_url` 两个老字段
//    原样保留（web/src/App.jsx:73,150 正读着，这一轮不碰前端）。
//
// ⭐ 这个文件里最要紧的两条，都不是「新字段有没有」：
//
//   1. **没有第二份探活实现**。engines.js:33 早就把 probeEngineOnline 导出来
//      等着这里复用了，注释写着「两处各写一遍探活，迟早会在超时值或判定条件
//      上分叉」。分叉的后果是同一台引擎在两个接口上死活不一致，而没有任何
//      一处能说清哪个是真的。判据用**读源码**的方式钉死这一点。
//
//   2. **老字段的含义不被新东西污染**。名片写坏了，engine_online 不许跟着变。
//
// 接假 express 的手法与同目录 engines.node.test.js 一致（沙箱没有 node_modules）。

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs')
const path = require('node:path')

// ---- 假 express ------------------------------------------------------------
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

// ---- 可切换的桩 ------------------------------------------------------------
// system.js 在模块顶层就 require 了 registry / profile / engines，所以要在
// **require('./system') 之前**把这三个换成能切换的壳。壳默认转发给真实现 ——
// 这样大多数测试跑的是真名片（engines.node.test.js 的血泪：塞假名片绕过
// profile.js 的那 5 个测试全绿了整整一轮，而被测的键从来没被生产过）。
const realRegistry = require('../engines/registry')
const realProfile = require('../engines/profile')
const realEngines = require('./engines')

const stub = { listEngines: null, resolveEngineProfile: null, probeEngineOnline: null }
function installShell (relFile, key, real) {
  const filename = require.resolve(relFile)
  const exports = Object.assign({}, real)
  exports[key] = (...a) => (stub[key] || real[key])(...a)
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}
installShell('../engines/registry', 'listEngines', realRegistry)
installShell('../engines/profile', 'resolveEngineProfile', realProfile)
installShell('./engines', 'probeEngineOnline', realEngines)

const createRouter = require('./system')

function resetStubs () { stub.listEngines = null; stub.resolveEngineProfile = null; stub.probeEngineOnline = null }

// ---- 假 req / res / fetch --------------------------------------------------
function fakeRes () {
  const res = { statusCode: 200, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  return res
}

const CTX = {
  GPT_SOVITS_BASE_URL: 'http://127.0.0.1:9880',
  checkFfmpeg: () => true,
  detectCuda: () => ({ available: false }),
  normModelVersion: (v) => v,
  checkBaseModelsForVersion: () => ({}),
  http: null,
  noteEngineHealth: null,
}

async function health (ctx = {}) {
  routes.length = 0
  createRouter(Object.assign({}, CTX, ctx))
  const r = routes.find((x) => x.method === 'get' && x.path === '/api/health')
  assert.ok(r, '/api/health 这条路由没被注册')
  const res = fakeRes()
  await r.handlers[r.handlers.length - 1]({ query: {} }, res)
  return res.body
}

// 老字段那次探活走的是 globalThis.fetch，这里给它一个可控的回答。
const origFetch = globalThis.fetch
function withFetch (fn) {
  globalThis.fetch = fn
  return () => { globalThis.fetch = origFetch }
}

test.afterEach(() => { resetStubs(); globalThis.fetch = origFetch })

// ===========================================================================
//  一、老字段已退役但保留（刀 A5）：响应里仍在，但带 deprecated 公告
// ===========================================================================

test('1: engine_online 与 gpt_sovits_url 原样还在（已退役，保留作别名）', async () => {
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  try {
    const b = await health()
    assert.equal(b.ok, true)
    assert.equal(b.engine_online, true, '老字段响应里仍在')
    assert.equal(b.gpt_sovits_url, 'http://127.0.0.1:9880')
    assert.ok('ffmpeg_available' in b && 'cuda' in b && 'version' in b, '别的老字段也不许掉')
  } finally { restore() }
})

test('1b: ⭐ 退役字段必须带 deprecated 公告，点名键名 + 迁移目标', async () => {
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  try {
    const b = await health()
    assert.ok(Array.isArray(b.deprecated) && b.deprecated.length === 2,
      'deprecated 必须是两条的数组')
    const byKey = Object.fromEntries(b.deprecated.map(d => [d.key, d]))
    assert.equal(byKey.engine_online.use, 'engines[].online')
    assert.equal(byKey.gpt_sovits_url.use, 'engines[].base_url')
  } finally { restore() }
})

test('2: 引擎不在线时 engine_online 仍然是 false（不是 null、不是缺失）', async () => {
  const restore = withFetch(async () => { throw new Error('connect ECONNREFUSED') })
  try {
    const b = await health()
    assert.equal(b.engine_online, false)
  } finally { restore() }
})

test('3: ⭐ 名片全坏掉，也不许把 engine_online 带跑偏', async () => {
  // 老字段的含义必须完全不依赖名片体系。否则哪天谁把 manifest.json 的逗号
  // 写错，表现出来就是「webui 说引擎掉线了」—— 一个和真相无关的红点。
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  stub.listEngines = () => { throw new Error('manifest.json 第 3 行语法错误') }
  try {
    const b = await health()
    assert.equal(b.engine_online, true, '引擎明明活着，名片坏了不该让它显示掉线')
    assert.equal(b.ok, true)
  } finally { restore() }
})

test('4: noteEngineHealth 收到的仍然只是老字段那一个值', async () => {
  const seen = []
  const restore = withFetch(async () => ({ ok: false, status: 500 }))
  try {
    await health({ noteEngineHealth: (v) => seen.push(v) })
    assert.deepEqual(seen, [false], '逐台健康不许改变喂给模型缓存的那个信号')
  } finally { restore() }
})

// ===========================================================================
//  二、新增的 engines 列表
// ===========================================================================

test('5: engines 是数组，每台都有 id / label / base_url / online', async () => {
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  try {
    const b = await health()
    assert.ok(Array.isArray(b.engines), 'engines 必须是数组')
    assert.ok(b.engines.length > 0, '真名片目录里至少装着一台')
    for (const e of b.engines) {
      for (const k of ['id', 'label', 'base_url', 'online']) {
        assert.ok(k in e, `${e.id} 少了字段 ${k}`)
      }
      assert.equal(typeof e.id, 'string')
      assert.equal(typeof e.label, 'string')
    }
  } finally { restore() }
})

test('6: 列的就是真名片目录里那几台，不多不少', async () => {
  // ⭐ 跑真名片，不打桩 —— 抓的是「profile 的字段改了名，这条路跟着哑掉」。
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  try {
    const b = await health()
    assert.deepEqual(
      b.engines.map((e) => e.id).sort(),
      realRegistry.listEngineIds().sort())
  } finally { restore() }
})

test('7: ⭐ base_url 是「连」的地址，⛔ 不是 default_base_url 那个「听」的地址', async () => {
  // 这两个地址回答两个不同的问题（profile.js:100-109）。探活探的是
  // 「我现在能不能连上它」，用错就会在「env 把地址顶到别处」时探错机器。
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  stub.resolveEngineProfile = (id) => Object.assign({}, realProfile.resolveEngineProfile(id), {
    base_url: 'http://连:1', default_base_url: 'http://听:2',
  })
  try {
    const b = await health()
    for (const e of b.engines) {
      assert.equal(e.base_url, 'http://连:1', `${e.id} 用错了地址`)
      assert.notEqual(e.base_url, 'http://听:2')
    }
  } finally { restore() }
})

test('8: ⭐ online 是三态 —— 名片没写 ready_endpoint 时是 null，不是 false', async () => {
  // 「不知道」和「确定离线」糊成同一个假值之后，界面上那个灰点就再也说不清
  // 是哪一种了（engines.js:40 原话）。
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  stub.resolveEngineProfile = (id) => Object.assign({}, realProfile.resolveEngineProfile(id), { runtime: null })
  try {
    const b = await health()
    for (const e of b.engines) {
      assert.equal(e.online, null, `${e.id} 把「不知道」说成了「确定离线」`)
      assert.ok(!('online_reason' in e), 'online_reason 已按 Owner 裁决去掉，不许复活')
    }
  } finally { restore() }
})

test('9: 一台在线一台离线 ⇒ 列表里分得开', async () => {
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  let n = 0
  stub.probeEngineOnline = async () => (n++ === 0
    ? { online: true, reason: null }
    : { online: false, reason: '超过 2000ms 没有响应' })
  try {
    const b = await health()
    assert.ok(b.engines.length >= 2, '这条测试要求真名片目录里至少两台')
    assert.equal(b.engines[0].online, true)
    assert.equal(b.engines[1].online, false)
    assert.ok(!('online_reason' in b.engines[1]), 'online_reason 已去掉，不许复活')
  } finally { restore() }
})

// ===========================================================================
//  三、坏掉的时候 —— 健康接口的职责是**保持能答话**
// ===========================================================================

test('10: 一台名片坏掉，不许带塌整个列表', async () => {
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  const ids = realRegistry.listEngineIds()
  const bad = ids[0]
  stub.resolveEngineProfile = (id) => {
    if (id === bad) throw Object.assign(new Error('少了必填键 default_base_url'), { code: 'ENG_MANIFEST_BAD' })
    return realProfile.resolveEngineProfile(id)
  }
  try {
    const b = await health()
    assert.equal(b.engines.length, ids.length - 1, '好的那几台还得在')
    assert.ok(!b.engines.some((e) => e.id === bad))
    // ⛔ 也不能静默跳过 —— 看着正常、实际少了一台，最难查。
    const err = b.engine_errors.find((e) => e.id === bad)
    assert.ok(err, '坏掉的那台必须在 engine_errors 里看得见')
    assert.equal(err.code, 'ENG_MANIFEST_BAD')
    assert.match(err.error, /default_base_url/)
  } finally { restore() }
})

test('11: ⭐ 名片扫不动 ⇒ 仍然 200 且 ok:true（⛔ 不 500）', async () => {
  // 与 /api/engines 的一处**故意的**不一致：那边答不出「装了哪几台」就该 500，
  // 这边的职责是保持能答话。健康接口答不出话，比它报告的任何坏消息都严重。
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  stub.listEngines = () => { throw Object.assign(new Error('engines/ 读不了'), { code: 'ENG_DIR' }) }
  try {
    const b = await health()
    assert.equal(b.ok, true)
    assert.deepEqual(b.engines, [])
    assert.equal(b.engine_errors.length, 1)
    assert.match(b.engine_errors[0].error, /列举引擎失败/)
    assert.equal(b.engine_errors[0].code, 'ENG_DIR')
  } finally { restore() }
})

test('12: 探活自己炸了，也不许把 /api/health 带塌', async () => {
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  stub.probeEngineOnline = () => { throw new Error('探活代码自己有 bug') }
  try {
    const b = await health()
    assert.equal(b.ok, true, '健康接口必须还能答话')
    assert.ok(b.engine_errors.length >= 1)
    assert.match(b.engine_errors[0].error, /逐台健康失败/)
  } finally { restore() }
})

// ===========================================================================
//  四、并行，不串行
// ===========================================================================

test('13: 逐台探活是并行的（串行会让健康接口挂住 N × 超时）', async () => {
  const restore = withFetch(async () => ({ ok: true, status: 200 }))
  const DELAY = 60
  stub.probeEngineOnline = async () => {
    await new Promise((r) => setTimeout(r, DELAY))
    return { online: true, reason: null }
  }
  try {
    const t0 = Date.now()
    const b = await health()
    const dt = Date.now() - t0
    const n = b.engines.length
    assert.ok(n >= 2, '这条测试要求至少两台')
    // 串行会是 n × DELAY。留足余量，只要没到 2 倍就说明没串行。
    assert.ok(dt < DELAY * 2, `耗时 ${dt}ms，${n} 台 × ${DELAY}ms —— 看着像串行`)
  } finally { restore() }
})

// ===========================================================================
//  五、⭐⭐ 源码级：不许有第二份探活
// ===========================================================================

const SYSTEM_SRC = fs.readFileSync(path.join(__dirname, 'system.js'), 'utf8')

test('14: ⭐⭐ system.js 复用 engines.js 的 probeEngineOnline', async () => {
  assert.match(SYSTEM_SRC, /require\(["']\.\/engines["']\)/,
    'system.js 必须从 ./engines 拿探活，⛔ 不许自己再写一份')
  assert.match(SYSTEM_SRC, /probeEngineOnline/)
})

test('15: ⭐⭐ system.js 里没有第二处 AbortController 探活（老字段那一处除外）', async () => {
  // 老字段那次探活是历史实现，原样留着（只增不改）。但**只许有那一处**：
  // 第二处一出现，就是「两处各写一遍探活」那个分叉的开始。
  const n = (SYSTEM_SRC.match(/new AbortController\(\)/g) || []).length
  assert.equal(n, 1, `system.js 里有 ${n} 处自己探活的代码，应当只剩老字段那一处`)
})

test('16: ⛔ 逐台健康没有把「听」的地址当成「连」的地址', async () => {
  // 源码级钉死：新代码里不许出现 default_base_url。
  const afterLegacy = SYSTEM_SRC.slice(SYSTEM_SRC.indexOf('async function listEngineHealth'))
  const body = afterLegacy.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/default_base_url/.test(body),
    '逐台健康的活代码里出现了 default_base_url —— 那是「听」的地址，探活要用「连」的')
})

test('17: ⛔ 老字段的两个键名还在源码里（防止将来手滑改名）', async () => {
  assert.match(SYSTEM_SRC, /engine_online,/)
  assert.match(SYSTEM_SRC, /gpt_sovits_url: ENGINE_URL/)
})
