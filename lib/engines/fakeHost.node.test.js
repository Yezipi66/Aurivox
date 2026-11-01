'use strict'

// 假宿主：在本机启动一个 HTTP 服务，接收请求体并按 host.py 的形状返回响应。
// 本文件覆盖 Node 侧的两件事：method 是否随 /tts 一起发出，以及宿主返回的 4xx
// 到客户端时是什么样子。host.py 自己的三条规则在 hostMethod.node.test.js 里真跑 Python，
// 本文件不需要 python。
// 服务层把任何上游失败转成 HttpError 502（synthesisService.js 的两个 catch），
// 状态码由 synthesisService.errorDetail.node.test.js 覆盖；本文件覆盖错误正文的内容。
// 宿主页收 method 的名片是单方法（methods: null）：多方法引擎的表外值在服务层就 400 了
// （synthesisService.params.node.test.js 那条），请求根本发不出去，也就测不到宿主的回答。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const { createSynthesisModule } = require('../server/synthesis')
const { createSegmentCache } = require('../cache/segmentCache')
const { synthesisFailureDetail } = require('../services/failureDetail')
const createSynthesisService = require('../services/synthesisService')
const { makeWav, createSynthesisHarness } = require('../testSynthesis')

// 一张形状完整的名片：字段由本文件构造，与 engines/ 下的真名片无关。
// methods 默认是多方法（host.py 那一类宿主）；传 { methods: null } 得到单方法引擎。
function profileOf (baseUrl, over = {}) {
  return {
    id: 'engine-x',
    label: 'Engine X',
    dir: '/nowhere/engine-x',
    transport: 'http',
    base_url: baseUrl,
    timeout_ms: 5000,
    max_chars: 45,
    requires_reference_audio: false,
    maps: { text: 'input_text' },
    payload_keys: ['input_text'],
    param_keys: [],
    param_schema: [],
    defaults: {},
    weight_slots: [],
    methods: ['zero_shot', 'vc'],
    default_method: 'zero_shot',
    ...over,
  }
}

function startFakeHost (reply) {
  const received = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      received.push({ url: req.url, body: raw ? JSON.parse(raw) : {} })
      res.writeHead(reply.status, { 'Content-Type': 'application/json' })
      res.end(reply.kind === 'audio' ? reply.body : JSON.stringify(reply.json))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, baseUrl: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

function closeServer (server) {
  return new Promise((resolve) => server.close(resolve))
}

function cfgOf (over = {}) {
  return {
    id: 'v1', voiceId: 'v1', text_lang: 'zh', prompt_lang: 'zh',
    reference_audio: '', reference_text: '', aux_ref_audio_paths: [],
    seed: 7, ...over,
  }
}

function moduleFor (dir) {
  const cacheDir = path.join(dir, 'cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  return createSynthesisModule({
    _modelSwitcher: { ensure: async () => [] },
    segmentCache: createSegmentCache({ dir: cacheDir }),
  })
}

test('⭐ 假宿主记录请求体：method 原样随 /tts 发出，不出现在其他键上', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-fakehost-'))
  const host = await startFakeHost({ status: 200, kind: 'audio', body: makeWav(0) })
  try {
    const mod = moduleFor(root)
    const engine = profileOf(host.baseUrl)
    const audio = await mod.generateOneSegment('你好', cfgOf({ method: 'vc' }), engine)
    assert.ok(Buffer.isBuffer(audio) && audio.length > 0, '宿主返回的字节要原样交给调用方')
    assert.equal(host.received.length, 1)
    assert.equal(host.received[0].url, '/tts')
    assert.deepEqual(host.received[0].body, { input_text: '你好', method: 'vc' })
  } finally {
    await closeServer(host.server)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('⭐ 宿主返回 400 时，客户端看到的就是宿主自己给出的消息', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-fakehost-'))
  // 单入口宿主收到异值时的回答，形状取自 host.py 的 validate_request：
  // resolve_method 对 call.method 不匹配的请求返回 None，报错点名那唯一的入口。
  const hostJson = {
    detail: "'method'='nope' is not available on engine-x. Available: vc",
    available_methods: ['vc'],
  }
  const host = await startFakeHost({ status: 400, json: hostJson })
  try {
    const mod = moduleFor(root)
    const engine = profileOf(host.baseUrl, { methods: null, default_method: null })
    const err = await mod.generateOneSegment('你好', cfgOf({ method: 'nope' }), engine).then(
      () => null, (e) => e)
    assert.ok(err, '宿主返回 400 时必须抛出，不能当成一次成功的合成')
    // 结构化字段：状态与正文都保留，调用方据此区分「引擎拒绝了本次请求」与「引擎不可用」。
    assert.equal(err.upstreamStatus, 400)
    assert.equal(err.engineId, 'engine-x')
    assert.deepEqual(JSON.parse(err.upstreamBody), hostJson)
    // 返回给客户端的消息：去掉外层包装，保留宿主给出的可用方法列表。
    assert.equal(synthesisFailureDetail(err), hostJson.detail)
    assert.equal(host.received.length, 1)
    assert.equal(host.received[0].body.method, 'nope')
  } finally {
    await closeServer(host.server)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('⭐ 从 generateService 起跑的同一趟：请求出得去，宿主的原话带着 502 回来', async () => {
  const hostJson = { detail: "'method'='nope' is not available on engine-x. Available: vc", available_methods: ['vc'] }
  const host = await startFakeHost({ status: 400, json: hostJson })
  const engine = profileOf(host.baseUrl, { methods: null, default_method: null })
  const h = createSynthesisHarness({ prefix: 'aurivox-fakehost-svc-', engines: { 'engine-x': engine } })
  try {
    const mod = moduleFor(h.root)
    Object.assign(h.ctx, {
      generateOneSegment: (text, cfg, eng, out) => mod.generateOneSegment(text, cfg, eng, out),
    })
    const { generateService } = createSynthesisService(h.ctx)
    const err = await generateService({
      body: { voice: 'v1', text: '你好', engine_id: 'engine-x', method: 'nope' },
    }).then(() => null, (e) => e)
    assert.equal(err.status, 502, '宿主拒绝这次请求是「上游失败」，不是平台内部错误')
    assert.equal(err.message, hostJson.detail, '正文用宿主自己的话，平台不另写一句')
    assert.equal(host.received.length, 1, '单方法引擎：服务层不拦，请求确实发出去了')
    assert.equal(host.received[0].body.method, 'nope')
  } finally {
    await closeServer(host.server)
    fs.rmSync(h.root, { recursive: true, force: true })
  }
})

test('⭐ 宿主 500 与 400 走同一扇门：都是带 upstreamStatus 的失败，不是本地异常', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-fakehost-'))
  const host = await startFakeHost({ status: 500, json: { error: 'boom' } })
  try {
    const mod = moduleFor(root)
    const err = await mod.generateOneSegment('你好', cfgOf(), profileOf(host.baseUrl)).then(
      () => null, (e) => e)
    assert.equal(err.upstreamStatus, 500)
    assert.equal(err.transport, undefined, '连上了并被拒 ≠ 连不上：那条是 transportFailure')
    assert.equal(synthesisFailureDetail(err), 'boom')
  } finally {
    await closeServer(host.server)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
