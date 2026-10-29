'use strict'
// 第 5 步试跑：量到的两项超时按余量存进本机记录（state/ 下），名片一个字都不动；
//   max_chars 不由试跑定；采样率从返回的 wav 头读。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const M = require('../core/measure')
const { generateSilenceWav } = require('../../../lib/audio/wav.js')
const { readTimings } = require('../../../lib/engines/localTimings.js')

test('deriveValues：就绪 2 倍且至少 +30s，单段 3 倍且至少 +60s，都向上取整到 10s', () => {
  assert.deepEqual(M.deriveValues({ readyMs: 12000, synthMs: 8000, synthOk: true, chars: 48 }), {
    'runtime.ready_timeout_ms': 50000, // max(24000, 42000) → 50000
    timeout_ms: 70000, // max(24000, 68000) → 70000
  })
  assert.deepEqual(M.deriveValues({ readyMs: 100000, synthMs: 100000, synthOk: true, chars: 50 }), {
    'runtime.ready_timeout_ms': 200000, timeout_ms: 300000,
  })
})

test('deriveValues：不给 max_chars（引擎自身的属性，试跑量不出上限）', () => {
  const v = M.deriveValues({ readyMs: 1, synthMs: 1, synthOk: true, chars: 50 })
  assert.ok(!('max_chars' in v), JSON.stringify(v))
})

test('deriveValues：合成没成功 ⇒ 只给就绪那一项（没量到的不编）', () => {
  assert.deepEqual(M.deriveValues({ readyMs: 12000, synthMs: 5, synthOk: false, chars: 50 }),
    { 'runtime.ready_timeout_ms': 50000 })
  assert.deepEqual(M.deriveValues({}), {})
})

test('measure.js 不再有写回名片的出口', () => {
  for (const k of ['applyMeasurements', 'canOverwrite', 'MEASURED_FIELDS']) {
    assert.ok(!(k in M), `${k} 还在导出`)
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'measure.js'), 'utf8')
  assert.ok(!/saveManifest/.test(src), '试跑不许写名片')
  assert.ok(!/x-sample-rate/.test(src), '采样率不读响应头')
  assert.ok(!/__dirname,\s*'\.\.',\s*'\.\.',\s*'\.\.'/.test(src), '根不许写死成 __dirname 上三级')
})

test('textOfLength：短了重复、长了在词边界截，不超过 n', () => {
  const t = M.textOfLength('Hello there, friend.', 50)
  assert.ok(t.length <= 50 && t.length >= 30, `${t.length}: ${t}`)
  assert.ok(t.startsWith('Hello there, friend. Hello'))
  assert.equal(M.textOfLength('abc', 2), 'ab')
  const zh = M.textOfLength('今天天气很好，我们去公园散步。', 20)
  assert.ok(zh.length <= 20, zh)
})

// 一段真 wav（24000 Hz），合成请求就回它。
function wavOf (rate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-wav-'))
  const f = path.join(dir, 's.wav')
  generateSilenceWav(50, rate, f)
  const buf = fs.readFileSync(f)
  fs.rmSync(dir, { recursive: true, force: true })
  return buf
}

// 假引擎：注入启动/探活/请求，验证测的是「起进程 → 就绪」与「发一段 /tts」两段时间。
function fakeDeps ({ readyAfterMs = 3000, synthMs = 2000, status = 200, failLoad = false,
  body = wavOf(24000), headers = { 'x-sample-rate': '16000' }, onPost } = {}) {
  let clock = 0
  const killed = { n: 0 }
  const posted = []
  const calls = {}
  return {
    killed, posted, calls,
    deps: {
      now: () => clock,
      resolveProfile: (id) => ({ id, max_chars: 50, runtime: { ready_endpoint: '/health' } }),
      buildLaunchPlan: (profile, o) => { calls.plan = o; return { launchable: true, base_url: 'http://127.0.0.1:1', ready_url: 'http://127.0.0.1:1/health' } },
      spawnFromPlan: (plan, o) => { calls.spawn = o; return { on () {}, killTree: async () => { killed.n++ } } },
      probeOnce: async () => {
        if (failLoad) { const e = new Error('boom'); e.engineFailed = true; e.detail = { error: 'x' }; return e }
        clock += 1000
        return clock >= readyAfterMs
      },
      post: async (url, b, budget, signal) => {
        posted.push({ url, body: b, signal })
        if (onPost) await onPost()
        clock += synthMs
        return { status, headers, body: status === 200 ? body : Buffer.alloc(0) }
      },
    },
  }
}

test('measureEngine：量出就绪与单段耗时，文本凑到 max_chars，结束时把进程收掉', async () => {
  const f = fakeDeps({ readyAfterMs: 3000, synthMs: 2000 })
  const stages = []
  const r = await M.measureEngine('x', { request: { text: 'Hello there.', ref_audio_path: '/a.wav' },
    deps: f.deps, pollMs: 0, rootDir: '/eng', writeRoot: '/w', onStage: (s) => stages.push(s) })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.readyMs, 3000)
  assert.equal(r.synthMs, 2000)
  assert.equal(f.posted[0].url, 'http://127.0.0.1:1/tts', '合成路由与平台正式合成一致，写死 /tts')
  assert.equal(f.posted[0].body.ref_audio_path, '/a.wav', '请求体其余字段原样带上')
  assert.ok(f.posted[0].body.text.length <= 50 && f.posted[0].body.text.length > 30)
  assert.equal(r.chars, f.posted[0].body.text.length)
  assert.equal(f.killed.n, 1)
  assert.deepEqual(stages, ['starting', 'synth'])
})

test('measureEngine：stdio 的引擎不要端口，探活与 /tts 都经子进程的管道发，与正式合成同一条路', async () => {
  let clock = 0
  const seen = { probes: [], posts: [] }
  const pipe = { id: 'pipe' }
  const wav = wavOf(24000)
  const deps = {
    now: () => clock,
    resolveProfile: (id) => ({ id, max_chars: 50, transport: 'stdio', runtime: { ready_endpoint: '/health' } }),
    buildLaunchPlan: (profile, o) => {
      seen.port = o.port
      return { launchable: true, transport: 'stdio', base_url: null, ready_url: null, ready_endpoint: '/health' }
    },
    spawnFromPlan: () => ({ stdioTransport: pipe, on () {}, killTree: async () => {} }),
    probeOnce: async () => assert.fail('stdio 的引擎不许按地址探活'),
    post: async () => assert.fail('stdio 的引擎不许按地址发请求'),
    probeStdio: async (conn, endpoint) => { seen.probes.push({ conn, endpoint }); clock += 1000; return true },
    postStdio: async (conn, payload) => { seen.posts.push({ conn, payload }); clock += 2000; return { status: 200, body: wav } },
  }
  const r = await M.measureEngine('x', { request: { text: 'Hello there.' }, deps, pollMs: 0, rootDir: '/eng', writeRoot: '/w' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.transport, 'stdio')
  assert.equal(r.base_url, null)
  assert.equal(seen.port, undefined, '不给 stdio 的引擎找空闲端口')
  assert.equal(seen.probes[0].conn, pipe)
  assert.equal(seen.probes[0].endpoint, '/health')
  assert.equal(seen.posts[0].conn, pipe)
  assert.equal(r.sampleRate, 24000)
})

test('measureEngine：采样率从 wav 头读，不信 x-sample-rate 响应头', async () => {
  const f = fakeDeps({ body: wavOf(24000), headers: { 'x-sample-rate': '16000' } })
  const r = await M.measureEngine('x', { request: { text: 'hi' }, deps: f.deps, pollMs: 0, rootDir: '/eng', writeRoot: '/w' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.sampleRate, 24000)
  const g = fakeDeps({ body: Buffer.from('not a wav at all, just bytes'), headers: { 'x-sample-rate': '16000' } })
  const r2 = await M.measureEngine('x', { request: { text: 'hi' }, deps: g.deps, pollMs: 0, rootDir: '/eng', writeRoot: '/w' })
  assert.equal(r2.sampleRate, null, '读不出 wav 头就是 null，不拿响应头顶替')
})

test('measureEngine：启动计划与 spawn 用引擎所在的根；profile_json 与日志落写根', async () => {
  const f = fakeDeps()
  const eng = path.join(os.tmpdir(), 'eng-root')
  const w = path.join(os.tmpdir(), 'write-root')
  await M.measureEngine('x', { request: { text: 'hi' }, deps: f.deps, pollMs: 0, rootDir: eng, writeRoot: w })
  assert.equal(f.calls.plan.rootDir, eng)
  assert.equal(f.calls.plan.profileJsonPath, path.join(w, 'cache', 'engines', 'x.profile.json'))
  assert.equal(f.calls.spawn.rootDir, eng)
  assert.equal(f.calls.spawn.logDir, path.join(w, 'logs'))
  assert.equal(f.calls.spawn.enginesDir, path.join(eng, 'engines'))
  assert.equal(f.calls.spawn.localRoot, w)
})

test('measureEngine：中止信号 ⇒ 不再等、断开请求、收掉进程，如实报已中止', async () => {
  const ac = new AbortController()
  const f = fakeDeps({ onPost: async () => { ac.abort() } })
  const r = await M.measureEngine('x', { request: { text: 'hi' }, deps: f.deps, pollMs: 0,
    rootDir: '/eng', writeRoot: '/w', signal: ac.signal })
  assert.equal(r.ok, false)
  assert.equal(r.cancelled, true)
  assert.equal(r.stage, 'synth')
  assert.equal(f.posted[0].signal, ac.signal, '信号要交给合成请求，才断得开')
  assert.equal(f.killed.n, 1)
})

test('measureEngine：加载失败如实报，不发合成请求，也收掉进程', async () => {
  const f = fakeDeps({ failLoad: true })
  const r = await M.measureEngine('x', { request: { text: 'hi' }, deps: f.deps, pollMs: 0, rootDir: '/eng', writeRoot: '/w' })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'ready')
  assert.equal(f.posted.length, 0)
  assert.equal(f.killed.n, 1)
})

test('measureEngine：没有文本不起进程', async () => {
  const f = fakeDeps()
  const r = await M.measureEngine('x', { request: {}, deps: f.deps, rootDir: '/eng', writeRoot: '/w' })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'spec')
  assert.equal(f.killed.n, 0)
})

function tempRoot (manifest) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-measure-')))
  fs.writeFileSync(path.join(root, 'server.js'), '')
  fs.mkdirSync(path.join(root, 'engines', 'demo'), { recursive: true })
  const file = path.join(root, 'engines', 'demo', 'manifest.json')
  const text = JSON.stringify(manifest, null, 2)
  fs.writeFileSync(file, text)
  return { root, file, text }
}

test('measureAndPersist：两项超时写进写根的本机记录，名片一个字都不动', async () => {
  const { root, file, text } = tempRoot({
    id: 'demo', label: 'Demo', max_chars: 30, max_chars_source: 'measured',
    timeout_ms: 1000, timeout_ms_source: 'estimated',
    runtime: { python: 'engines/demo/.venv', entry: '../../lib/engines/host.py' },
  })
  const rootOpts = { from: root, env: { WIZARD_PROJECT_ROOT: root } }
  try {
    const r = await M.measureAndPersist('demo', { rootOpts,
      measure: async () => ({ ok: true, readyMs: 12000, synthMs: 8000, synthOk: true, chars: 30 }),
    })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.path, path.join(root, 'state', 'engine-timings', 'demo.json'))
    assert.equal(fs.readFileSync(file, 'utf8'), text, '名片不许被改')
    const t = readTimings(root, 'demo')
    assert.deepEqual(t.values, { 'runtime.ready_timeout_ms': 50000, timeout_ms: 70000 })
    assert.deepEqual(r.values, { 'runtime.ready_timeout_ms': 50000, timeout_ms: 70000 })

    // 再跑一次：整份覆盖。这次合成失败 ⇒ 只剩就绪那一项，单段退回名片或平台默认。
    const r2 = await M.measureAndPersist('demo', { rootOpts,
      measure: async () => ({ ok: false, readyMs: 2000, synthOk: false, error: 'x' }),
    })
    assert.equal(r2.ok, false)
    assert.deepEqual(readTimings(root, 'demo').values, { 'runtime.ready_timeout_ms': 40000 })

    // 一项都没量到 ⇒ 不碰旧记录。
    const r3 = await M.measureAndPersist('demo', { rootOpts,
      measure: async () => ({ ok: false, stage: 'ready', error: '起不来' }),
    })
    assert.equal(r3.ok, false)
    assert.deepEqual(readTimings(root, 'demo').values, { 'runtime.ready_timeout_ms': 40000 })
    assert.equal(fs.readFileSync(file, 'utf8'), text)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('平台读名片时本机记录优先：试跑之后 profile 的超时取本机值，来源记 local', async () => {
  const { root } = tempRoot({
    id: 'demo', label: 'Demo', timeout_ms: 1000, timeout_ms_source: 'estimated',
    runtime: { python: 'engines/demo/.venv', entry: '../../lib/engines/host.py', args: [] },
  })
  const rootOpts = { from: root, env: { WIZARD_PROJECT_ROOT: root } }
  try {
    await M.measureAndPersist('demo', { rootOpts,
      measure: async () => ({ ok: true, readyMs: 12000, synthMs: 8000, synthOk: true, chars: 30 }),
    })
    const { resolveEngineProfile } = require('../../../lib/engines/profile.js')
    const p = resolveEngineProfile('demo', {}, { enginesDir: path.join(root, 'engines'), localRoot: root })
    assert.equal(p.timeout_ms, 70000)
    assert.equal(p.runtime.ready_timeout_ms, 50000)
    assert.equal(p.value_sources.timeout_ms, 'local')
    assert.equal(p.value_sources['runtime.ready_timeout_ms'], 'local')
    assert.ok(!p.defaulted.includes('runtime.ready_timeout_ms'), '本机测得的不算平台默认')
    assert.ok(p.defaulted.includes('max_chars'), 'max_chars 名片没写 ⇒ 仍是平台默认')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('/wizard/verify/measure 不被 /wizard/verify 吃掉', () => {
  const wb = require('../core/wizardbridge.js')
  const req = { method: 'POST', url: '/wizard/verify/measure' }
  assert.equal(wb.handleVerify(req, {}), false)
  assert.equal(typeof wb.handleVerifyMeasure, 'function')
})

test('toEngineWords：平台的词换成宿主与引擎的词（照名片 maps），空值不发', () => {
  const req = { text: 'hi', reference_audio: '/a.wav', reference_text: 'hello', seed: '' }
  M.toEngineWords({ maps: { reference_audio: 'ref_wav', reference_text: 'ref_words' } }, req)
  assert.deepEqual(req, { text: 'hi', ref_wav: '/a.wav', ref_words: 'hello' })
  const shared = { text: 'hi', reference_audio: '/a.wav', reference_text: 'hello' }
  M.toEngineWords({ maps: { text: 'text', reference_audio: 'reference_audio', reference_text: 'reference_text' } }, shared)
  assert.deepEqual(shared, { text: 'hi', reference_audio: '/a.wav', reference_text: 'hello' },
    '通用宿主的 maps 是恒等映射：平台的词原样发')
  const req2 = { text: 'hi', reference_text: 'x' }
  M.toEngineWords({ maps: {} }, req2)
  assert.deepEqual(req2, { text: 'hi' }, '名片没映射参考文本 ⇒ 不发')
})
