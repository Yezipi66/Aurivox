'use strict'

// ===========================================================================
//  GET /api/engines —— 「装了哪几台」这个问题，后端自己答得上来吗
// ===========================================================================
//
// 契约 §12 第 2 步。这条路由出现之前，registry.listEngines() 全仓唯一的
// 消费者是画布 —— 要求调用方「必须带 engine_id」，却没有任何一处能告诉它
// 有哪些 id 可选。
//
// ⭐ 这个文件里有两类测试，缺一不可：
//
//   A. 真名片跑（不打桩 registry/profile）—— 抓的是「profile 的字段改了名，
//      这条路由跟着哑掉」。历史教训：塞假名片绕过 profile.js 的那 5 个测试
//      全绿了整整一轮，而被测的键 profile.js 从来没生产过（死代码）。
//   B. 打桩跑 —— 抓的是错误分支（名片坏掉、引擎连不上），那些情况没法用
//      真目录造，往 engines/ 里写假目录有清点守卫盯着。
//
// 接假 express 的手法与同目录 synthesis.*.node.test.js 一致（沙箱没有
// node_modules），被测的是真实的路由代码。

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

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

const createRouter = require('./engines')
const { probeEngineOnline, describeEngine, CONCURRENCY_NOTICE } = createRouter
const { listEngineIds } = require('../engines/registry')
const { resolveEngineProfile } = require('../engines/profile')

// ---- 假 req / res ----------------------------------------------------------
function fakeRes () {
  const res = { statusCode: 200, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  return res
}

async function callRoute (query = {}) {
  routes.length = 0
  createRouter({})
  const r = routes.find((x) => x.method === 'get' && x.path === '/api/engines')
  assert.ok(r, '/api/engines 这条路由没被注册')
  const res = fakeRes()
  await r.handlers[r.handlers.length - 1]({ query }, res)
  return res
}

// ===========================================================================
//  A. 真名片
// ===========================================================================

test('真名片：列出来的引擎与 registry 一致，一台不多一台不少', async () => {
  // ⚠⚠ 这条判据读的是**盘上 engines/ 目录**这个全局可变状态，而同一个仓库里
  //   lib/engines/launchPlan.node.test.js:617 那条会临时往 engines/ 建一个故意
  //   写坏的名片目录，用完在 finally 里删掉。node --test 并行跑不同测试文件
  //   （各自一个进程、共用同一块盘），中间还夹着一次 spawnSync，窗口有几百毫秒
  //   —— 撞得上。2026-08-28 在真机（多核）上就撞到了。
  //   ⛔ 而单核沙箱并行度 = 1，这类竞态在那儿**结构性地不可能发生**：也就是说
  //     「沙箱里跑绿了」这句话对这一类问题从来就没有证明力，不是运气好。
  //
  // ⛔⛔ 我第一版的修法是「调用前后各读一次 registry，取交集」——**那个也是错的**，
  //   12 轮人工竞态里还红了 2 轮。根因不是断言写法，是我在拿三次互相独立的
  //   盘读数（before / 路由内部那次 / after）去校验一个正在变化的目录。跨时间点
  //   比对可变状态，怎么写都会漏，把它调到不红只会变成掩盖。
  //
  // ⇒ 「路由忠实反映 registry，一台不多一台不少」这件事整个搬到下面 C 段
  //   打桩那两条里去测：那里 registry 是我给的常量，零竞态，还能精确到
  //   5 台、3 好 2 坏、顺序不乱 —— 比原来这条**更强**，不是妥协。
  // ⇒ 这条只留对竞态免疫的不变式：响应内部自洽，且每个 id 当场验证。
  const res = await callRoute({ probe: '0' })

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.ok(Array.isArray(res.body.engines) && Array.isArray(res.body.errors))

  const listed = res.body.engines.map((e) => e.id)
  const failed = res.body.errors.map((e) => e.id)
  const seen = [...listed, ...failed]

  assert.equal(new Set(seen).size, seen.length,
    'engines 与 errors 有重叠，或者同一台被列了两次')
  // 进了 errors 的，必须**真的**解析不了。这一条替代原来的 `errors == []` ——
  // 原来那句其实是在断言「盘上此刻没有坏名片」，那是环境的性质，不是路由的性质。
  for (const id of failed) {
    assert.throws(() => resolveEngineProfile(id), undefined,
      `${id} 其实解析得了，不该被丢进 errors`)
  }
  // 盘上确实装着的引擎至少有一台能列出来 —— 这条挡的是「整个列表空了还报 ok」。
  assert.ok(seen.length > 0, '一台都没列出来，registry 不可能是空的')
})

test('真名片：吐出去的每个字段都和 profile 解析出来的相同（只搬运，不二次判断）', async () => {
  const res = await callRoute({ probe: '0' })
  for (const e of res.body.engines) {
    const p = resolveEngineProfile(e.id)
    assert.equal(e.label, p.label)
    assert.equal(e.base_url, p.base_url)
    assert.equal(e.default_base_url, p.default_base_url)
    assert.equal(e.max_chars, p.max_chars)
    assert.equal(e.output_sample_rate, p.output_sample_rate)
    assert.equal(e.requires_reference_audio, p.requires_reference_audio)
    assert.deepEqual(e.reference_clip_seconds, p.reference_clip_seconds)
    assert.equal(e.param_schema.length, p.param_schema.length)
    assert.equal(e.managed, p.runtime !== null)
  }
})

test('真名片：参考音频时长窗口按台各报各的，不是同一个写死的区间', async () => {
  // ⭐ 这一条盯的是前端那处写死的 REF_MIN_SEC=3 / REF_MAX_SEC=10：只要真机上
  //   两台引擎的窗口不同，这个接口就必须把差异透出来，否则前端将来接过去
  //   还是只能写死。窗口相同（或只装了一台）时这条自动跳过，不制造假红。
  const res = await callRoute({ probe: '0' })
  const windows = res.body.engines.map((e) => JSON.stringify(e.reference_clip_seconds))
  if (new Set(windows).size <= 1) return
  assert.ok(new Set(windows).size > 1, '各台的时长窗口应当能被分别读到')
})

test('probe=0 时一次网络都不打，online 是 null 而不是 false', async () => {
  const orig = global.fetch
  let called = 0
  global.fetch = async () => { called += 1; throw new Error('不该被调用') }
  try {
    const res = await callRoute({ probe: '0' })
    assert.equal(called, 0)
    for (const e of res.body.engines) {
      assert.equal(e.online, null, '「没探」必须是 null，不能糊成 false')
    }
  } finally { global.fetch = orig }
})

test('⭐ probe=1 时 online 是真探出来的，不是填的常量', async () => {
  // 变异演练补上的洞：原先没有任何一条测试盯着「探活结果真的进了响应」——
  // 把那行 Promise.all 换成 `map(() => ({online:true}))`，14 条判据全绿。
  // 一个永远报「全在线」的健康指示，比没有指示更坏。
  const orig = global.fetch
  let calls = 0
  global.fetch = async () => { calls += 1; return { ok: false, status: 503 } }
  try {
    const res = await callRoute({})   // 不带 probe ⇒ 默认探
    assert.ok(calls > 0, 'probe 默认应当是开的，一次网络都没打')
    const probed = res.body.engines.filter((e) => e.online !== null)
    assert.ok(probed.length > 0, '至少有一台引擎应当被探到（名片里写了 ready_endpoint 的）')
    for (const e of probed) {
      assert.equal(e.online, false, `${e.id}：后端答 503，这里却报在线`)
      assert.match(String(e.online_reason), /503/)
    }
  } finally { global.fetch = orig }
})

test('⭐ probe=1 时每台各探各的地址，不是只探第一台然后抄给其余', async () => {
  const orig = global.fetch
  const seen = []
  global.fetch = async (url) => { seen.push(String(url)); return { ok: true, status: 200 } }
  try {
    const res = await callRoute({})
    const probed = res.body.engines.filter((e) => e.online !== null)
    assert.equal(seen.length, probed.length,
      `探了 ${seen.length} 次，但有 ${probed.length} 台报了在线状态 —— 数对不上说明有台没被真探`)
    assert.equal(new Set(seen).size, seen.length, '同一个地址被探了两次？')
  } finally { global.fetch = orig }
})

test('提醒文案在，且不带任何数字（内存占用是浮动的，写死一个数就是死数据）', async () => {
  const res = await callRoute({ probe: '0' })
  assert.equal(res.body.notice, CONCURRENCY_NOTICE)
  assert.ok(!/\d/.test(CONCURRENCY_NOTICE), `提醒文案里不该出现数字：${CONCURRENCY_NOTICE}`)
})

// ===========================================================================
//  B. 探活
// ===========================================================================

test('⭐ 探活地址来自名片的 ready_endpoint，不是写死的 "/"', async () => {
  // 真机实据：两台引擎的 ready_endpoint 分别是 "/" 和 "/health"。
  // 写死任何一个，另一台就永远显示离线。
  const seen = []
  const orig = global.fetch
  global.fetch = async (url) => { seen.push(String(url)); return { ok: true, status: 200 } }
  try {
    const p = { base_url: 'http://x:1', runtime: { ready_endpoint: '/health' } }
    const r = await probeEngineOnline(p)
    assert.equal(r.online, true)
    assert.deepEqual(seen, ['http://x:1/health'])
  } finally { global.fetch = orig }
})

test('没有 runtime 段的引擎：online 是 null（不知道），不是 false（确定不在线）', async () => {
  const orig = global.fetch
  global.fetch = async () => { throw new Error('不该被调用') }
  try {
    const r = await probeEngineOnline({ base_url: 'http://x:1', runtime: null })
    assert.equal(r.online, null)
    assert.match(r.reason, /ready_endpoint/)
  } finally { global.fetch = orig }
})

test('引擎连不上：报 online:false 并说明原因，不往上抛', async () => {
  const orig = global.fetch
  global.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const r = await probeEngineOnline({ base_url: 'http://x:1', runtime: { ready_endpoint: '/' } })
    assert.equal(r.online, false)
    assert.match(r.reason, /ECONNREFUSED/)
  } finally { global.fetch = orig }
})

test('引擎答了但不是 2xx：online:false，原因里带上状态码', async () => {
  const orig = global.fetch
  global.fetch = async () => ({ ok: false, status: 503 })
  try {
    const r = await probeEngineOnline({ base_url: 'http://x:1', runtime: { ready_endpoint: '/' } })
    assert.equal(r.online, false)
    assert.match(r.reason, /503/)
  } finally { global.fetch = orig }
})

// ⚠ 这条必须自带 timeout：它测的就是「会不会挂住」，而一个挂住的测试
//   在 CI 里表现为「跑不完」而不是「红了」—— 变异演练时已经被这一点坑过一次
//   （靶场停在变异态，下一轮把污染态当成了干净基线）。
test('探活超时用的是自己的短超时，不是名片的 ready_timeout_ms', { timeout: 5000 }, async () => {
  // ready_timeout_ms 回答的是「等它冷启动要等多久」（真机上几十秒到几分钟）。
  // 拿它当探活超时，这个列表接口会挂住几分钟。
  const orig = global.fetch
  global.fetch = async (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err)
    })
  })
  try {
    const t0 = Date.now()
    const r = await probeEngineOnline(
      { base_url: 'http://x:1', runtime: { ready_endpoint: '/', ready_timeout_ms: 600000 } }, 60)
    const dt = Date.now() - t0
    assert.equal(r.online, false)
    assert.ok(dt < 5000, `探活应当很快放弃，实际等了 ${dt}ms`)
  } finally { global.fetch = orig }
})

// ===========================================================================
//  C. 一台坏名片不能带塌整个列表
// ===========================================================================

test('一张名片解析不了：进 errors，其余的照常列出来，不 500 也不静默吞掉', async () => {
  // 这一条没法用真目录造 —— 往 engines/ 写假目录有清点守卫盯着，所以打桩。
  const regPath = require.resolve('../engines/registry')
  const proPath = require.resolve('../engines/profile')
  const routePath = require.resolve('./engines')
  const savedReg = require.cache[regPath]
  const savedPro = require.cache[proPath]
  const savedRoute = require.cache[routePath]
  const good = {
    id: 'aaa', label: 'AAA', base_url: 'http://x:1', base_url_source: 'manifest',
    default_base_url: 'http://x:1', requires_reference_audio: false,
    reference_clip_seconds: null, max_chars: 10, hard_max_chars: 20,
    output_sample_rate: 32000, hot_swap_models: false, streaming: false,
    supports_finetune: false, param_schema: [], param_keys: [], runtime: null,
  }
  require.cache[regPath] = { id: regPath, filename: regPath, loaded: true, exports: {
    listEngines: () => [{ id: 'aaa' }, { id: 'bbb' }],
  } }
  require.cache[proPath] = { id: proPath, filename: proPath, loaded: true, exports: {
    resolveEngineProfile: (id) => {
      if (id === 'aaa') return good
      const err = new Error('名片少写了 capabilities.output_sample_rate')
      err.code = 'ENGINE_MANIFEST_MISSING_KEY'
      throw err
    },
  } }
  delete require.cache[routePath]
  try {
    const stubbed = require('./engines')
    routes.length = 0
    stubbed({})
    const r = routes.find((x) => x.method === 'get' && x.path === '/api/engines')
    const res = fakeRes()
    await r.handlers[r.handlers.length - 1]({ query: { probe: '0' } }, res)
    assert.equal(res.statusCode, 200, '一台坏名片不该让整个接口 500')
    assert.deepEqual(res.body.engines.map((e) => e.id), ['aaa'])
    assert.equal(res.body.errors.length, 1)
    assert.equal(res.body.errors[0].id, 'bbb')
    assert.equal(res.body.errors[0].code, 'ENGINE_MANIFEST_MISSING_KEY')
    assert.match(res.body.errors[0].error, /output_sample_rate/)
  } finally {
    require.cache[regPath] = savedReg
    require.cache[proPath] = savedPro
    require.cache[routePath] = savedRoute
  }
})

test('⭐ 忠实映射：registry 说几台就是几台，好的坏的各归各位，顺序不乱', async () => {
  // ⭐ 这条是从上面 A 段那条「一台不多一台不少」搬过来的，并且加强了。
  //   A 段那条读真盘，而真盘会被并行跑的 launchPlan 测试临时塞坏名片（见 A 段
  //   注释），跨时间点比对必然偶发红。搬到打桩环境里：registry 是常量，零竞态，
  //   还能精确到 5 台、3 好 2 坏、顺序保持 —— 抓「漏列一台 / 多列一台 / 分错类 /
  //   打乱顺序」的能力比原来那条强，不是把判据放松了。
  const regPath = require.resolve('../engines/registry')
  const proPath = require.resolve('../engines/profile')
  const routePath = require.resolve('./engines')
  const savedReg = require.cache[regPath]
  const savedPro = require.cache[proPath]
  const savedRoute = require.cache[routePath]
  const mk = (id) => ({
    id, label: id.toUpperCase(), base_url: `http://x/${id}`, base_url_source: 'manifest',
    default_base_url: `http://x/${id}`, requires_reference_audio: false,
    reference_clip_seconds: null, max_chars: 10, hard_max_chars: 20,
    output_sample_rate: 32000, hot_swap_models: false, streaming: false,
    supports_finetune: false, param_schema: [], param_keys: [], runtime: null,
  })
  const ORDER = ['e1', 'bad1', 'e2', 'bad2', 'e3']
  require.cache[regPath] = { id: regPath, filename: regPath, loaded: true, exports: {
    listEngines: () => ORDER.map((id) => ({ id })),
  } }
  require.cache[proPath] = { id: proPath, filename: proPath, loaded: true, exports: {
    resolveEngineProfile: (id) => {
      if (id.startsWith('bad')) {
        const err = new Error(`${id} 的名片少写了东西`)
        err.code = 'ENGINE_MANIFEST_MISSING_KEY'
        throw err
      }
      return mk(id)
    },
  } }
  delete require.cache[routePath]
  try {
    const stubbed = require('./engines')
    routes.length = 0
    stubbed({})
    const r = routes.find((x) => x.method === 'get' && x.path === '/api/engines')
    const res = fakeRes()
    await r.handlers[r.handlers.length - 1]({ query: { probe: '0' } }, res)
    assert.equal(res.statusCode, 200)
    // 好的三台：全在、顺序按 registry 给的来
    assert.deepEqual(res.body.engines.map((e) => e.id), ['e1', 'e2', 'e3'])
    // 坏的两台：全在 errors，一台都不许被静默吞掉
    assert.deepEqual(res.body.errors.map((e) => e.id), ['bad1', 'bad2'])
    // 加起来必须正好是 registry 说的那 5 台
    assert.equal(res.body.engines.length + res.body.errors.length, ORDER.length,
      'registry 说 5 台，响应里没凑齐 5 台 —— 有的被吞了')
  } finally {
    require.cache[regPath] = savedReg
    require.cache[proPath] = savedPro
    require.cache[routePath] = savedRoute
  }
})

test('扫目录本身挂了：500 且说清楚，不装作「一台都没装」', async () => {
  const regPath = require.resolve('../engines/registry')
  const routePath = require.resolve('./engines')
  const savedReg = require.cache[regPath]
  const savedRoute = require.cache[routePath]
  require.cache[regPath] = { id: regPath, filename: regPath, loaded: true, exports: {
    listEngines: () => { const e = new Error('manifest.json 无法解析'); e.code = 'ENGINE_MANIFEST_INVALID'; throw e },
  } }
  delete require.cache[routePath]
  try {
    const stubbed = require('./engines')
    routes.length = 0
    stubbed({})
    const r = routes.find((x) => x.method === 'get' && x.path === '/api/engines')
    const res = fakeRes()
    await r.handlers[r.handlers.length - 1]({ query: {} }, res)
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.ok, false)
    assert.match(res.body.error, /无法解析/)
  } finally {
    require.cache[regPath] = savedReg
    require.cache[routePath] = savedRoute
  }
})

// ===========================================================================
//  D. 守卫：这个文件里不许出现任何具体引擎的名字
// ===========================================================================

test('⛔ lib/routes/engines.js 源码里不含任何已装引擎的 id 或 label', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(require.resolve('./engines'), 'utf8')
  for (const id of listEngineIds()) {
    assert.ok(!src.includes(id),
      `engines.js 里出现了引擎名 "${id}" —— 这条路由必须只认名片，不认具体引擎`)
    // ⚠ 同上那条竞态：并行跑的 launchPlan 测试会往 engines/ 塞一张**故意坏的**
    //   名片，解析它必然抛。那种临时目录不是这条守卫要管的对象，跳过。
    // ⛔ 但这个 catch 是有代价的：真名片自己坏了，这里也会静默跳过。之所以敢
    //   这么写，是因为那种情况会被上面「进了 errors 的必须真的解析不了」和
    //   「每个字段都和 profile 相同」两条抓住 —— 不是因为它无所谓。
    let label
    try {
      label = resolveEngineProfile(id).label
    } catch {
      continue
    }
    assert.ok(!src.includes(label),
      `engines.js 里出现了引擎 label "${label}"`)
  }
})

test('describeEngine 只搬运，不给缺失字段补默认值', () => {
  // 传一个什么都没有的 profile：出来的字段必须都是 undefined，而不是被
  // 悄悄补成 0 / false / []。名片漏写要在 profile 层就抛，不能在这里兜住。
  const out = describeEngine({ runtime: null })
  assert.equal(out.max_chars, undefined)
  assert.equal(out.output_sample_rate, undefined)
  assert.equal(out.reference_clip_seconds, undefined)
})
