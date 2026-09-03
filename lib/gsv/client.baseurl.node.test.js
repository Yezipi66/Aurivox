'use strict'

// ---------------------------------------------------------------------------
//  lib/gsv/client.js —— 「连哪台、等多久」由调用方逐次给出
// ---------------------------------------------------------------------------
// 契约 v2 第 1 步的验收测试。这里起真的 HTTP 服务端来收请求，因为要验的
// 恰恰是「请求最后落到了哪个端口」—— 用 mock 掉 http 模块就把要测的东西
// 一起 mock 掉了。
//
// ⭐⭐⭐ 刀 A1（2026-08-31，Owner 12:22 裁决③）改写了整个文件。
//
//   改之前，本文件的每一条都先 `plant('alpha', { legacy_default: true })`
//   造一台「老路径引擎」，再 `client._resetProfileCache()` 抖掉缓存。
//   这两样东西都没了：
//     - lib/engines/legacyDefault.js         → 整个文件删除
//     - client.legacyProfile / defaultBaseUrl / defaultTimeout / _resetProfileCache
//                                            → 全删（client.js 不再认识任何一台引擎）
//     - client.GPT_SOVITS_BASE_URL (getter)  → 删（server.js:67 有它自己那一份；
//                                              这个 getter 只有测试在读）
//
//   ⭐ 删掉之后，client.js 变成了一个**纯运输层**：它只认「地址 + 超时」，
//     一台引擎的名字都不认识。这正是这一刀想要的形状 ——
//     **端口是运输，不是管理**（retired engine-integration specification §5.9）。
//
//   ⚠ 本文件不再需要 ENGINES_DIR，也不再造任何名片：
//     「名片怎么解析、base_url_env 怎么顶、名片写错什么时候抛」
//     全部归 lib/engines/profile.js 及其测试管，⛔ 不在运输层重复守一遍。

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')

const client = require('./client')

// 起一个只会回声的服务端，记录收到的请求。
function startEcho () {
  return new Promise((resolve) => {
    const seen = []
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, port: server.address().port }))
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

test('⭐⭐⭐ 刀 2/A1: 不传 baseUrl ⇒ 当场抛，⛔ 一个请求都不发出去', async (t) => {
  // 这条过去断言的是反面：「不传 baseUrl ⇒ 连 legacy_default 那台」。
  // 那个默认值是**看不见的改道** —— 调用方以为自己没指定地址，实际上指定了，
  // 而且指定的是别人。用户侧的症状：界面上选的是 A，报错却是 B 说的话。
  const echo = await startEcho()
  t.after(() => echo.server.close())

  await assert.rejects(() => client.gsvPost('/tts', { text: 'hi' }),
    (e) => e.code === 'ENGINE_BASE_URL_MISSING' && /baseUrl/.test(e.message))
  assert.deepStrictEqual(echo.seen, [], '⛔ 一个请求都不该发出去')
})

test('⭐⭐ 刀 A1: GET / 流式 也一样，缺地址就抛，⛔ 没有任何一条路留着回落', async () => {
  // ⭐ 三个入口必须**各自**验一遍。只验 POST 的话，
  //   某天有人只给 gsvGet 加了一句「没给地址就用上次那个」，这里不会红。
  await assert.rejects(() => client.gsvGet('/set_gpt_weights', { weights_path: 'x.ckpt' }),
    (e) => e.code === 'ENGINE_BASE_URL_MISSING')
  await assert.rejects(() => client.gsvStream('/tts', { text: 'x' }, 0),
    (e) => e.code === 'ENGINE_BASE_URL_MISSING')
})

test('⭐ 按次指定 baseUrl ⇒ 同一个进程里能对话第二台引擎', async (t) => {
  const a = await startEcho()
  const b = await startEcho()
  t.after(() => { a.server.close(); b.server.close() })

  await client.gsvPost('/tts', { text: '第一台' }, { baseUrl: a.url })
  await client.gsvPost('/tts', { text: '第二台', x: 1 }, { baseUrl: b.url })

  assert.equal(a.seen.length, 1, '第一次落在 a')
  assert.equal(b.seen.length, 1, '第二次落在 b —— 这是老代码做不到的事')
})

test('GET 也认 baseUrl（换权重那两个接口走的就是 GET）', async (t) => {
  const a = await startEcho()
  const b = await startEcho()
  t.after(() => { a.server.close(); b.server.close() })

  await client.gsvGet('/set_gpt_weights', { weights_path: 'x.ckpt' }, { baseUrl: b.url })
  assert.equal(a.seen.length, 0)
  assert.equal(b.seen[0].url, '/set_gpt_weights?weights_path=x.ckpt')
})

test('流式请求也认 baseUrl', async (t) => {
  const a = await startEcho()
  const b = await startEcho()
  t.after(() => { a.server.close(); b.server.close() })

  const up = await client.gsvStream('/tts', { text: 'x' }, 0, { baseUrl: b.url })
  up.stream.resume()
  assert.equal(b.seen.length, 1)
  assert.equal(a.seen.length, 0)
})

// ---------------------------------------------------------------------------
//  ⭐⭐⭐ 刀 A1 归零守卫：运输层不许认识任何一台引擎
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 刀 A1: client.js 的导出面只剩四个运输动词', () => {
  assert.deepEqual(Object.keys(client).sort(),
    ['gsvGet', 'gsvPost', 'gsvRequest', 'gsvStream'],
    '运输层多出了导出 —— 检查是不是又把「默认连哪台」塞回来了')
})

test('⭐⭐ 刀 A1: 老的 GPT_SOVITS_BASE_URL 导出已删（⛔ 不许有第二个真相来源）', () => {
  // ⚠ 它过去是个 getter，读的是 legacy_default 那台名片的地址。
  //   server.js:67 另有一个**同名**常量（读环境变量），routes/system.js:74
  //   拿的是 server.js 那一份 ⇒ 这个 getter 全仓库只有测试在读。
  //   两个同名不同值的东西同时存在，就是「健康页说 A、合成打到 B」的原材料。
  assert.equal('GPT_SOVITS_BASE_URL' in client, false)
  assert.equal(client.GPT_SOVITS_BASE_URL, undefined)
})

test('⭐⭐ 刀 A1: client.js 源码里不出现任何引擎名字 / 写死端口', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))   // 整行注释放行：我们特意写了「这里过去有什么」
    .join('\n')
  for (const name of ['legacyDefault', 'legacy_default', 'gpt-sovits', 'gpt_sovits', 'indextts2', '9880']) {
    assert.equal(code.includes(name), false,
      `client.js 的活代码里出现了 ${name} —— 运输层开始认识具体引擎了`)
  }
})

test('⭐ 刀 A1: 兜底超时是具名常量，⛔ 不是环境变量', () => {
  // TRANSPORT_FALLBACK_TIMEOUT_MS = 120000，socket 层保险丝。
  // ⛔ 不做成环境变量 —— 变量意味着「这是给用户调的」，而它不是：
  //   所有真实调用点（synthesis.js:549/702、server.js:1052、pron.js:72、
  //   modelState.js:123）都从 profile 一起传 { baseUrl, timeout_ms }，
  //   这条兜底路正常永远走不到。
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf-8')
  assert.match(src, /const TRANSPORT_FALLBACK_TIMEOUT_MS = 120000/)
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.equal(/process\.env\.\w*TIMEOUT/.test(code), false,
    '超时变成环境变量了 —— 那等于对用户宣称「这个值你该调」')
})
