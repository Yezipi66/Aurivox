'use strict'

// ===========================================================================
//  契约 §12 第 2 步：合成路径上「去哪台引擎」必须有人说了算
// ===========================================================================
//
// 这一刀改了 /v1/audio/speech 的两条分支：
//   · 整音色路径（voice="alice"）—— 过去静默回落到老路径引擎，现在 engine_id 必填
//   · 配方路径（voice="alice/calm"）—— 配方自带引擎；请求再指一台**不同的**就 400
//
// ⚠⚠ 这个文件为什么必须存在（别删，也别指望集成测试替它干活）：
//
//   覆盖这两条分支的现成测试全在 coreWorkflow.test.js / flow.integration.node.test.js
//   里，而那些测试要 startBroker() 起一个真进程。沙箱没有 node_modules ⇒ 它们
//   **整批 t.skip**（沙箱 32 skip，真机 1 skip）。也就是说：这一刀改的代码，在
//   沙箱里跑 `node tools/run_tests.cjs` 得到的 "0 fail" **一个字都不能信** ——
//   唯一能证伪它的测试恰好是这里跑不了的那批。
//
//   我第一次跑出 856/824/0 fail 时差点就把它当验收了。真相是我预测会红的 7 条
//   一条都没执行。所以这里照 synthesis.recipeEngine.node.test.js 的办法办：
//   不绕过被测代码，只**替掉 express 本身**，把**真实的** createRouter 加载进来，
//   拿**真实的** handler 去调。这样判据在沙箱和真机上都真跑。
//
// ⛔ 不要把这里的断言改成「调不通就算了」。这一刀的全部价值就是**拦住**过去那个
//   静默回落 —— 判据一旦学会放过它，这一刀就等于没做。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

// ---- 假 express：只做 handler 登记 ----------------------------------------
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

const createRouter = require('./synthesis')

// --------------------------------------------------------------------------
//  盘上的料
// --------------------------------------------------------------------------
// ⛔ 用 mkdtemp 拿一个本进程独占的目录，不碰仓库里的共享路径 —— 判据不许建在
//   别的测试也能写的盘上状态之上，否则并发下的红/绿跟被测代码无关。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-engreq-'))
const realWav = path.join(tmp, 'ref.wav')
fs.writeFileSync(realWav, Buffer.alloc(64))

// 整音色路径要读 <ASSETS_DIR>/<voice>/segments.json
fs.mkdirSync(path.join(tmp, 'alice'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'alice', 'segments.json'), JSON.stringify({
  segments: [{ matched: true, audio: realWav, text: '参考文本' }],
}))

// 装了的引擎：两台，地址不同 —— 「地址跟着选择走」这件事才验得出来。
const INSTALLED = {
  'engine-a': 'http://127.0.0.1:9880',
  'engine-b': 'http://127.0.0.1:9881',
}

const profile = (id, over = {}) => Object.assign({
  id,
  label: id,
  base_url: INSTALLED[id],
  timeout_ms: 120000,
  max_chars: 45,
  requires_reference_audio: true,
  reference_clip_seconds: { min: 3, max: 10 },
  hot_swap_models: true,
  param_keys: [],
}, over)

function makeCtx (over = {}) {
  // seen.baseUrl 记的是**运输层实际打到哪个地址** —— 不是「我们选了谁」这个
  // 自述。回落删干净没有，只有这个读数说了算。
  // ⭐ 刀 A1（2026-08-31）：legacyAsked 这个探针留着，但它盯的东西变了 ——
  //   过去盯「整音色路径有没有偷偷回落」，现在盯「ctx 上还有没有人递这个函数」。
  //   路由已经不从 ctx 取它了；谁要是把注入加回来，这里就会被喂到。
  const seen = { baseUrl: [], engineId: [], legacyAsked: 0 }
  const ctx = {
    APP_DIR: tmp, ASSETS_DIR: tmp, ASSETS_ROOT: tmp,
    AUDIO_FORMATS: { wav: 'audio/wav' },
    baseVoiceReg: () => null,
    buildTtsPayload: (t, cfg, prof) => { seen.engineId.push(prof && prof.id); return { text: t } },
    checkFfmpeg: () => true,
    clientError: (e, f) => String((e && e.message) || f),
    computeSegmentBounds: () => [],
    concatWavFiles: async () => Buffer.alloc(64),
    fs,
    genAssetDir: (g) => path.join(tmp, g),
    genBaseName: (p) => String(p || '').split(/[\\/]/).pop(),
    generateOneSegment: async () => Buffer.alloc(64),
    gsvPost: async (_p, _body, opts) => {
      seen.baseUrl.push(opts && opts.baseUrl)
      return { statusCode: 200, status: 200, body: Buffer.alloc(64) }
    },
    gsvStream: async () => { throw new Error('not used') },
    isBaseVoice: (v) => v === '__base__',
    loadAdvancedParams: () => ({}),
    loadVoices: () => ({ alice: { language: 'ja' } }),
    newGenId: () => 'GENID',
    normSource: (s) => (s ? String(s) : 'speech'),
    path,
    pathResolver: { resolveManagedRef: (v) => ({ ok: true, path: typeof v === 'string' ? v : '' }) },
    pickBestCkpt: () => ({}),
    recipeStore: { get: () => null, resolveVoice: () => null },
    requireApiKey: (req, res, next) => next(),
    resolveRefPath: (p) => p,
    resolveSeed: () => 123456,
    splitJapaneseText: (t) => [t],
    switchModels: async () => {},
    toPcm16Wav: (b) => b,
    transcodeAudio: (b) => b,
    wavDurationSec: () => 5,
    withGenerationLock: (fn) => fn(),
    writeGenMeta: () => {},
    resolveEngineProfile: (id) => {
      if (!INSTALLED[id]) throw new Error(`这台服务器上没有装引擎 ${id}；已装的是：engine-a、engine-b`)
      return profile(id)
    },
    // ⭐ 这个桩是一支探针：这一刀之后，整音色路径**一次都不该**问「老路径引擎
    //   是谁」。谁要是把回落偷偷加回来，这个计数就会从 0 变成非 0。
    findLegacyDefaultId: () => { seen.legacyAsked++; return 'engine-a' },
  }
  return { ctx: Object.assign(ctx, over), seen }
}

function speechHandler (ctx) {
  routes.length = 0
  createRouter(ctx)
  const r = routes.find((x) => x.method === 'post' && String(x.path).includes('/v1/audio/speech'))
  assert.ok(r, '没有登记 /v1/audio/speech —— 假 express 的接法失效了')
  return r.handlers[r.handlers.length - 1]
}

// asyncHandler 把错误交给 next(err)，而它自己的 promise 照样 resolve —— 两边会
// 抢跑。所以先把 next 收到的错误存下来，等 handler 整个跑完再抛。
async function call (ctx, body) {
  const h = speechHandler(ctx)
  let nextErr = null
  const out = {}
  const res = {
    set: () => res, setHeader: () => res, status: (s) => { out.status = s; return res },
    json: (b) => { out.json = b; return res },
    send: (b) => { out.body = b; return res },
    end: (b) => { out.body = b; return res },
    write: () => true, on: () => res, headersSent: false,
  }
  const req = { body, headers: {}, on: () => {}, get: () => undefined }
  await Promise.resolve(h(req, res, (err) => { if (err) nextErr = err }))
  // 让 asyncHandler 的 .catch(next) 有机会跑完
  await new Promise((r) => setImmediate(r))
  if (nextErr) throw nextErr
  // ⚠ asyncHandler 的翻译契约：HttpError -> res.status(s).json({ error })，它
  //   **不走 next()**，所以错误落在**响应体**里而不是异常里。少了这一段翻译，
  //   每条 assert.rejects 都会报「Missing expected rejection」——「没报错」和
  //   「报了但我没接住」在读数上长得一模一样，这是这套桩最容易踩空的地方。
  if (out.status && out.status >= 400) {
    const e = new Error(typeof (out.json && out.json.error) === 'string' ? out.json.error : JSON.stringify(out.json))
    e.status = out.status
    // ⭐ 刀 A1（2026-08-31）：HttpError 的第三个参数被 asyncHandler **摊进响应体**
    //   （http.js:73 `{ error: body, ...err.extra }`），⛔ 不是挂在异常上。
    //   这个桩过去只搬 message + status ⇒ `{ code: 'RECIPE_NO_ENGINE' }` 这类
    //   机器可读的分类在半路被丢掉了，测试想断言 code 就只能去 match 中文句子。
    //   ⭐ 报错的**分类**必须能被机器读到 —— 靠 match 人话，那句话一改就全红。
    e.body = out.json || {}
    if (out.json && out.json.code) e.code = out.json.code
    throw e
  }
  return out
}

const recipe = (over = {}) => Object.assign({
  schema_version: 3,
  id: 'alice/calm',
  role: 'alice',
  name: 'calm',
  reference_audio: realWav,
  reference_text: '参考文本',
  language: 'all_ja',
  params: { speed: 1.2, seed: 42 },
}, over)

// ===========================================================================
//  A. 整音色路径：engine_id 必填
// ===========================================================================

test('⭐⭐ 裸音色名不带 engine_id ⇒ 400，且话里指得出去哪儿查', async () => {
  // 这是整刀的核心。过去这里静默回落到老路径引擎 —— 在只有一台引擎的年代是对的，
  // 多引擎之后它变成「替调用方做了一个他不知道的选择」。
  const { ctx, seen } = makeCtx()
  await assert.rejects(
    () => call(ctx, { voice: 'alice', input: '你好' }),
    (e) => e.status === 400 &&
      /engine_id/.test(e.message) &&
      // ⛔ 报错必须自带出路。只说「缺 engine_id」而不说去哪儿取合法值，
      //   调用方只能来问人 —— 那这个 400 就只完成了一半。
      /\/api\/engines/.test(e.message),
  )
  assert.equal(seen.baseUrl.length, 0, '拦住了却还是把请求发出去了')
})

test('⭐⭐ 回落真的删干净了：缺 engine_id 时一次都没去问「老路径引擎是谁」', async () => {
  // 上一条只证明了「报了 400」。它挡不住这种写法：先回落算出一台引擎、再在别处
  // 报错。这条盯的是**行为**不是**结论**。
  const { ctx, seen } = makeCtx()
  await assert.rejects(() => call(ctx, { voice: 'alice', input: '你好' }), (e) => e.status === 400)
  assert.equal(seen.legacyAsked, 0,
    '整音色路径还在问 findLegacyDefaultId —— 回落没删干净')
})

test('裸音色名带上 engine_id ⇒ 放行，且请求真的打到那台的地址', async () => {
  const { ctx, seen } = makeCtx()
  const out = await call(ctx, { voice: 'alice', input: '你好', engine_id: 'engine-a' })
  assert.ok(out, '本该放行却抛了')
  assert.deepEqual(seen.baseUrl, ['http://127.0.0.1:9880'])
  assert.deepEqual(seen.engineId, ['engine-a'])
})

test('⭐ 换一个 engine_id ⇒ 地址跟着换（证明不是把 a 写死了）', async () => {
  // 上一条单独看是会被「写死 engine-a」骗过去的。两条合起来才排除得掉。
  const { ctx, seen } = makeCtx()
  await call(ctx, { voice: 'alice', input: '你好', engine_id: 'engine-b' })
  assert.deepEqual(seen.baseUrl, ['http://127.0.0.1:9881'])
  assert.deepEqual(seen.engineId, ['engine-b'])
})

test('engine_id 指向没装的引擎 ⇒ 400，且说清是引擎的问题，不回落', async () => {
  const { ctx, seen } = makeCtx()
  await assert.rejects(
    () => call(ctx, { voice: 'alice', input: '你好', engine_id: 'not-installed' }),
    (e) => e.status === 400 && /not-installed/.test(e.message) && /unavailable/i.test(e.message),
  )
  assert.equal(seen.baseUrl.length, 0, '解析不了却还是发了请求 —— 回落了')
})

test('engine_id 是空串/空白 ⇒ 当作没给（400），不是当作一个合法 id', async () => {
  // 表单和某些客户端很爱发空串。当成合法值会一路走到 resolveEngineProfile 报
  // 一句「没装引擎 ''」，指错方向。
  for (const blank of ['', '   ']) {
    const { ctx } = makeCtx()
    await assert.rejects(
      () => call(ctx, { voice: 'alice', input: '你好', engine_id: blank }),
      (e) => e.status === 400 && /Missing 'engine_id'/.test(e.message),
      `engine_id=${JSON.stringify(blank)} 没有被当成「没给」`,
    )
  }
})

test('engine_id 两边带空格 ⇒ 照样认得出来（trim 过了）', async () => {
  const { ctx, seen } = makeCtx()
  await call(ctx, { voice: 'alice', input: '你好', engine_id: '  engine-b  ' })
  assert.deepEqual(seen.baseUrl, ['http://127.0.0.1:9881'])
})

// ===========================================================================
//  B. 错误分类不许串味
// ===========================================================================

test('⭐⭐ 拼错的音色名 + 没给 engine_id ⇒ 仍然 404，不是 400', async () => {
  // 这一条是那个「400 故意放在 404 之后」的决定的判据。顺序一反，一个拼错的
  // 音色名就会被报成「你没说引擎」，把人指向完全无关的方向 —— 而且他补上
  // engine_id 之后还是不通，第二次才发现是名字错了。
  const { ctx } = makeCtx()
  await assert.rejects(
    () => call(ctx, { voice: 'alicce', input: '你好' }),
    (e) => e.status === 404 && /Unknown voice/.test(e.message),
  )
})

test('拼错的音色名 + 给了合法 engine_id ⇒ 也还是 404', async () => {
  const { ctx } = makeCtx()
  await assert.rejects(
    () => call(ctx, { voice: 'alicce', input: '你好', engine_id: 'engine-a' }),
    (e) => e.status === 404,
  )
})

// ⭐⭐ 下面三条是这一刀的**爆炸半径证明**。
//
// 全仓库有约 20 处集成测试打裸音色名，其中 3 处期待的是「缺 input」「input 过长」
// 「缺 voice」这些**别的** 400。我读代码认为它们在 :87-89、排在音色解析**之前**，
// 所以不受这一刀影响 —— 于是我不打算改它们。
//
// ⛔ 但「我读出来的」不等于「测出来的」。这三条测试把那个判断钉死：它们绿着，
//   我才有资格说那些集成测试不用动；哪天有人把 engine_id 检查往前挪，这里先红，
//   而不是等真机上一堆报错文案集体变味。

test('缺 input ⇒ 仍报「Missing input」，不被 engine_id 抢先', async () => {
  const { ctx } = makeCtx()
  await assert.rejects(
    () => call(ctx, { voice: 'alice' }),
    (e) => e.status === 400 && /Missing 'input'/.test(e.message),
  )
})

test('input 过长 ⇒ 仍报「too long」，不被 engine_id 抢先', async () => {
  const { ctx } = makeCtx()
  await assert.rejects(
    () => call(ctx, { voice: 'alice', input: 'x'.repeat(5001) }),
    (e) => e.status === 400 && /too long/i.test(e.message),
  )
})

test('缺 voice ⇒ 仍报「Missing model/voice」，不被 engine_id 抢先', async () => {
  const { ctx } = makeCtx()
  await assert.rejects(
    () => call(ctx, { input: '你好' }),
    (e) => e.status === 400 && /Missing 'model'/.test(e.message),
  )
})

// ===========================================================================
//  C. 配方路径：配方自带引擎
// ===========================================================================

// ⭐⭐⭐ 刀 A1（2026-08-31，Owner 12:22 裁决③「直接删」）：**这一条翻面了**。
//
//   它过去断言「配方不带 engine_id ⇒ 照旧放行」，靠的是 findLegacyDefaultId()
//   替这条配方认领一台引擎。那个认领没了。
//
//   ⚠ 这是这一刀**唯一一处对上游可见的行为变化**，⛔ 不许假装它不存在：
//   存量 v3 配方（`schema_version < 4` 且没写 engine_id）在**重新选一次引擎
//   并保存之前**打不通，报的是下面这个可操作的 400。
//
//   ⭐ 为什么仍然要这么做：v3 时代「只有一台」是**事实**，不是**约定**。
//   把事实当约定写进代码，第二台引擎装上的那天，这条配方会安静地打到错的
//   那台去 —— 那比 400 难查一万倍。
test('⭐⭐⭐ 刀 A1: 配方不带 engine_id ⇒ 400 RECIPE_NO_ENGINE，⛔ 不替它认领', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { get: () => null, resolveVoice: () => recipe() },
  })
  await assert.rejects(
    () => call(ctx, { voice: 'alice/calm', input: '你好' }),
    (e) => e.status === 400 &&
      // ⚠ HttpError 的第三参走 `.extra` → asyncHandler 摊进响应体（http.js:73）。
      //   上面那个桩负责把它搬回 e.code / e.body 上。
      e.code === 'RECIPE_NO_ENGINE' &&
      e.body.code === 'RECIPE_NO_ENGINE' &&
      // ⛔ 报错必须点名是**哪条配方**，否则用户有 50 条配方时无从下手。
      /alice\/calm/.test(e.message),
  )
  assert.equal(seen.baseUrl.length, 0, '拦住了却还是把请求发出去了')
  assert.equal(seen.legacyAsked, 0, '拦之前先去问了「老路径引擎是谁」—— 回落没删干净')
})

test('配方带 engine_id ⇒ 照旧放行，请求打到它自己点名的那台', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { get: () => null, resolveVoice: () => recipe({ engine_id: 'engine-a' }) },
  })
  const out = await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.ok(out)
  assert.deepEqual(seen.baseUrl, ['http://127.0.0.1:9880'])
})

test('⭐⭐ 配方 + 一个**不同的** engine_id ⇒ 400，且两个 id 都点名', async () => {
  // Owner 2026-08-28 拍板报 400（⛔ 不静默按配方走，⛔ 也不让请求赢）。
  // 报错里必须同时出现两个 id —— 只说「冲突」的话，调用方还得自己去翻配方
  // 才知道另一边是谁。
  const { ctx, seen } = makeCtx({
    recipeStore: { get: () => null, resolveVoice: () => recipe({ schema_version: 4, engine_id: 'engine-a' }) },
  })
  await assert.rejects(
    () => call(ctx, { voice: 'alice/calm', input: '你好', engine_id: 'engine-b' }),
    (e) => e.status === 400 && /engine-a/.test(e.message) && /engine-b/.test(e.message),
  )
  assert.equal(seen.baseUrl.length, 0, '冲突却还是把请求发出去了')
})

test('配方 + **同一台** engine_id ⇒ 放行（不是见到 engine_id 就无脑 400）', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { get: () => null, resolveVoice: () => recipe({ schema_version: 4, engine_id: 'engine-b' }) },
  })
  const out = await call(ctx, { voice: 'alice/calm', input: '你好', engine_id: 'engine-b' })
  assert.ok(out, '同一台却被拦了 —— 这个 400 拦过头了')
  assert.deepEqual(seen.baseUrl, ['http://127.0.0.1:9881'])
})

test('配方 + 空串 engine_id ⇒ 当作没给，放行（不是冲突）', async () => {
  const { ctx } = makeCtx({
    recipeStore: { get: () => null, resolveVoice: () => recipe({ schema_version: 4, engine_id: 'engine-a' }) },
  })
  const out = await call(ctx, { voice: 'alice/calm', input: '你好', engine_id: '   ' })
  assert.ok(out, '空白 engine_id 被当成了一台真引擎')
})

test('⭐ 配方指向 engine-b ⇒ 请求真的打到 b 的地址（配方选的引擎没在运输层丢掉）', async () => {
  const { ctx, seen } = makeCtx({
    recipeStore: { get: () => null, resolveVoice: () => recipe({ schema_version: 4, engine_id: 'engine-b' }) },
  })
  await call(ctx, { voice: 'alice/calm', input: '你好' })
  assert.deepEqual(seen.baseUrl, ['http://127.0.0.1:9881'])
  assert.deepEqual(seen.engineId, ['engine-b'])
})

// ===========================================================================
//  D. 钉住现状：model 是死字段
// ===========================================================================

test('⭐ 给了 voice 时 model 是**死字段** —— 拿它指定引擎不管用（钉住现状）', async () => {
  // synthesis.js:75 是 `const voice = voiceSel || model` ⇒ voice 给了，model 就被
  // 整个忽略。这条不是在说这个设计好，是在**钉住它**：`model:"engine-b"` 看起来
  // 像在指定引擎，实际上一点作用都没有。将来谁要改这个语义，会先在这里绊一跤，
  // 而不是让上游在生产里听出声音不对。
  // ⛔ 本刀不动这个字段（Owner B 条：不顺手改别的）。
  const { ctx, seen } = makeCtx()
  await assert.rejects(
    () => call(ctx, { voice: 'alice', model: 'engine-b', input: '你好' }),
    (e) => e.status === 400 && /Missing 'engine_id'/.test(e.message),
    'model 居然被当成引擎用了 —— 语义变了，这条测试要重写而不是删掉',
  )
  assert.equal(seen.baseUrl.length, 0)

  // 而且给了 engine_id 之后，model 说什么都不影响去哪台。
  const { ctx: ctx2, seen: seen2 } = makeCtx()
  await call(ctx2, { voice: 'alice', model: 'engine-b', input: '你好', engine_id: 'engine-a' })
  assert.deepEqual(seen2.baseUrl, ['http://127.0.0.1:9880'], 'model 把 engine_id 顶掉了')
})

// ===========================================================================
//  E. 源码守卫：回落不许长回来
// ===========================================================================

test('⭐ 源码里不再有 `callEngine || resolveEngineProfile(findLegacyDefaultId())` 这种回落', async () => {
  // 行为测试盯的是「今天这几条路径」。这条盯的是**将来**：合成主体里原本有三处
  // 一模一样的回落写法，删了一处漏两处的话，行为测试未必覆盖得到那一支。
  const src = fs.readFileSync(path.join(__dirname, 'synthesis.js'), 'utf-8')
  // ⛔ 注释行要排掉：删掉的旧写法**故意**在注释里留了一份（「这里原本是什么、
  //   为什么不能是那样」）。守卫盯的是活代码，把文档也当违规会逼着后人删注释。
  const hits = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /callEngine\s*\|\|/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
  assert.deepEqual(hits, [], `合成主体里还留着 callEngine 回落：${JSON.stringify(hits)}`)
})

// ⭐⭐⭐ 刀 A1（2026-08-31）：这一条过去允许剩 1 处（老配方 v<4 认领）。
//   Owner 12:22 裁决③「直接删」⇒ 现在的数是 **0**，而且整个模块已经不存在。
test('⭐⭐⭐ 刀 A1: findLegacyDefaultId 在这个文件里一处都不剩', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'synthesis.js'), 'utf-8')
  const calls = src.split('\n').filter((l) => /findLegacyDefaultId\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l))
  assert.equal(calls.length, 0,
    `findLegacyDefaultId 的活用点应当为 0，实际 ${calls.length} 处：\n${calls.join('\n')}`)
})

// ⭐⭐ 归零守卫：整个 legacyDefault 机制在 lib/ 与 server.js 里一个活引用都不许有。
//   ⛔ 这一条比上面那条重要 —— 上面只盯一个文件，这一条盯全仓库。
//   注释里可以提它（我们特意留了「这里过去有什么、为什么删」），代码里不许。
test('⭐⭐ 刀 A1 归零: 全仓库 lib/ + server.js 没有一行活代码提 legacyDefault / legacy_default', async () => {
  const root = path.join(__dirname, '..', '..')
  const hits = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.js$/.test(e.name) || /\.test\.js$/.test(e.name)) continue
      const lines = fs.readFileSync(p, 'utf-8').split('\n')
      lines.forEach((l, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(l)) return           // 整行注释不算
        if (/legacyDefault|legacy_default/.test(l)) hits.push(`${p}:${i + 1}: ${l.trim()}`)
      })
    }
  }
  walk(path.join(root, 'lib'))
  const serverLines = fs.readFileSync(path.join(root, 'server.js'), 'utf-8').split('\n')
  serverLines.forEach((l, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
    if (/legacyDefault|legacy_default/.test(l)) hits.push(`server.js:${i + 1}: ${l.trim()}`)
  })
  assert.deepEqual(hits, [],
    `legacyDefault 从后门爬回来了：\n${hits.join('\n')}`)
})

test('⭐ 刀 A1: lib/engines/legacyDefault.js 这个文件不存在了', async () => {
  const p = path.join(__dirname, '..', 'engines', 'legacyDefault.js')
  assert.equal(fs.existsSync(p), false,
    'legacyDefault.js 又回来了 —— 一有默认引擎，第 N+1 台引擎的作者就永远要回答「我算不算默认」')
})
