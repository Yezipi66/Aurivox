'use strict'
// 第 5 步试跑写回：量到的值按余量写回名片，出处改 measured；人写的值不覆盖。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const M = require('../core/measure')

test('canOverwrite：没写 / estimated / 写了却没出处 ⇒ 能写；measured / upstream ⇒ 不能', () => {
  assert.equal(M.canOverwrite({}, 'timeout_ms', 'timeout_ms_source'), true)
  assert.equal(M.canOverwrite({ timeout_ms: 1, timeout_ms_source: 'estimated' }, 'timeout_ms', 'timeout_ms_source'), true)
  assert.equal(M.canOverwrite({ timeout_ms: 1 }, 'timeout_ms', 'timeout_ms_source'), true)
  assert.equal(M.canOverwrite({ timeout_ms: 1, timeout_ms_source: 'measured' }, 'timeout_ms', 'timeout_ms_source'), false)
  assert.equal(M.canOverwrite({ timeout_ms: 1, timeout_ms_source: 'upstream' }, 'timeout_ms', 'timeout_ms_source'), false)
  assert.equal(M.canOverwrite({ runtime: { ready_timeout_ms: 5, ready_timeout_ms_source: 'upstream' } },
    'runtime.ready_timeout_ms', 'runtime.ready_timeout_ms_source'), false)
})

test('deriveValues：就绪 2 倍且至少 +30s，单段 3 倍且至少 +60s，都向上取整到 10s', () => {
  assert.deepEqual(M.deriveValues({ readyMs: 12000, synthMs: 8000, synthOk: true, chars: 48 }), {
    'runtime.ready_timeout_ms': 50000, // max(24000, 42000) → 50000
    timeout_ms: 70000, // max(24000, 68000) → 70000
    max_chars: 48,
  })
  assert.deepEqual(M.deriveValues({ readyMs: 100000, synthMs: 100000, synthOk: true, chars: 50 }), {
    'runtime.ready_timeout_ms': 200000, timeout_ms: 300000, max_chars: 50,
  })
})

test('deriveValues：合成没成功 ⇒ 只给就绪那一项（没量到的不编）', () => {
  assert.deepEqual(M.deriveValues({ readyMs: 12000, synthMs: 5, synthOk: false, chars: 50 }),
    { 'runtime.ready_timeout_ms': 50000 })
  assert.deepEqual(M.deriveValues({}), {})
})

test('applyMeasurements：缺的与 estimated 写回并改出处 measured，人写的原样保留', () => {
  const before = {
    id: 'x',
    max_chars: 80, max_chars_source: 'upstream',
    timeout_ms: 300000, timeout_ms_source: 'estimated',
    runtime: { python: 'engines/x/.venv', entry: '../../lib/engines/host.py' },
  }
  const r = M.applyMeasurements(before, { 'runtime.ready_timeout_ms': 50000, timeout_ms: 70000, max_chars: 48 })
  assert.equal(r.manifest.timeout_ms, 70000)
  assert.equal(r.manifest.timeout_ms_source, 'measured')
  assert.equal(r.manifest.runtime.ready_timeout_ms, 50000)
  assert.equal(r.manifest.runtime.ready_timeout_ms_source, 'measured')
  assert.equal(r.manifest.runtime.python, 'engines/x/.venv', '同段其它键不能丢')
  assert.equal(r.manifest.max_chars, 80, '出处 upstream 的人写值不许覆盖')
  assert.equal(r.manifest.max_chars_source, 'upstream')
  assert.deepEqual(r.written.map((w) => w.key).sort(), ['runtime.ready_timeout_ms', 'timeout_ms'])
  assert.deepEqual(r.kept.map((k) => k.key), ['max_chars'])
  assert.equal(before.timeout_ms, 300000, '原对象不动')
})

test('写回后的名片过得了平台的出处守卫（checkMeasuredSources）', () => {
  const { checkMeasuredSources } = require('../../../lib/engines/profile/topkeys.js')
  const r = M.applyMeasurements({ id: 'x', runtime: {} },
    { 'runtime.ready_timeout_ms': 50000, timeout_ms: 70000, max_chars: 48 })
  assert.doesNotThrow(() => checkMeasuredSources(r.manifest))
})

test('textOfLength：短了重复、长了在词边界截，不超过 n', () => {
  const t = M.textOfLength('Hello there, friend.', 50)
  assert.ok(t.length <= 50 && t.length >= 30, `${t.length}: ${t}`)
  assert.ok(t.startsWith('Hello there, friend. Hello'))
  assert.equal(M.textOfLength('abc', 2), 'ab')
  const zh = M.textOfLength('今天天气很好，我们去公园散步。', 20)
  assert.ok(zh.length <= 20, zh)
})

// 假引擎：注入启动/探活/请求，验证测的是「起进程 → 就绪」与「发一段 /tts」两段时间。
function fakeDeps ({ readyAfterMs = 3000, synthMs = 2000, status = 200, failLoad = false } = {}) {
  let clock = 0
  const killed = { n: 0 }
  const posted = []
  return {
    killed, posted,
    deps: {
      now: () => clock,
      resolveProfile: (id) => ({ id, max_chars: 50, runtime: { ready_endpoint: '/health' } }),
      buildLaunchPlan: () => ({ launchable: true, base_url: 'http://127.0.0.1:1', ready_url: 'http://127.0.0.1:1/health' }),
      spawnFromPlan: () => ({ on () {}, killTree: async () => { killed.n++ } }),
      probeOnce: async () => {
        if (failLoad) { const e = new Error('boom'); e.engineFailed = true; e.detail = { error: 'x' }; return e }
        clock += 1000
        return clock >= readyAfterMs
      },
      post: async (url, body) => {
        posted.push({ url, body })
        clock += synthMs
        return { status, headers: { 'x-sample-rate': '24000' }, body: Buffer.alloc(status === 200 ? 100 : 0) }
      },
    },
  }
}

test('measureEngine：量出就绪与单段耗时，文本凑到 max_chars，结束时把进程收掉', async () => {
  const f = fakeDeps({ readyAfterMs: 3000, synthMs: 2000 })
  const r = await M.measureEngine('x', { request: { text: 'Hello there.', ref_audio_path: '/a.wav' },
    deps: f.deps, pollMs: 0 })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.readyMs, 3000)
  assert.equal(r.synthMs, 2000)
  assert.equal(r.sampleRate, 24000)
  assert.equal(f.posted[0].url, 'http://127.0.0.1:1/tts')
  assert.equal(f.posted[0].body.ref_audio_path, '/a.wav', '请求体其余字段原样带上')
  assert.ok(f.posted[0].body.text.length <= 50 && f.posted[0].body.text.length > 30)
  assert.equal(r.chars, f.posted[0].body.text.length)
  assert.equal(f.killed.n, 1)
})

test('measureEngine：加载失败如实报，不发合成请求，也收掉进程', async () => {
  const f = fakeDeps({ failLoad: true })
  const r = await M.measureEngine('x', { request: { text: 'hi' }, deps: f.deps, pollMs: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'ready')
  assert.equal(f.posted.length, 0)
  assert.equal(f.killed.n, 1)
})

test('measureEngine：没有文本不起进程', async () => {
  const f = fakeDeps()
  const r = await M.measureEngine('x', { request: {}, deps: f.deps })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'spec')
  assert.equal(f.killed.n, 0)
})

test('measureAndPersist：写回落盘（写根由 WIZARD_PROJECT_ROOT 指定），人写的项不动', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-measure-')))
  fs.writeFileSync(path.join(root, 'server.js'), '')
  fs.mkdirSync(path.join(root, 'engines', 'demo'), { recursive: true })
  const file = path.join(root, 'engines', 'demo', 'manifest.json')
  fs.writeFileSync(file, JSON.stringify({
    id: 'demo', label: 'Demo', max_chars: 30, max_chars_source: 'measured',
    runtime: { python: 'engines/demo/.venv', entry: '../../lib/engines/host.py' },
  }, null, 2))
  const old = process.env.WIZARD_PROJECT_ROOT
  process.env.WIZARD_PROJECT_ROOT = root
  try {
    const r = await M.measureAndPersist('demo', {
      measure: async () => ({ ok: true, readyMs: 12000, synthMs: 8000, synthOk: true, chars: 50 }),
    })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.path, file)
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(after.runtime.ready_timeout_ms, 50000)
    assert.equal(after.runtime.ready_timeout_ms_source, 'measured')
    assert.equal(after.timeout_ms, 70000)
    assert.equal(after.timeout_ms_source, 'measured')
    assert.equal(after.max_chars, 30, 'measured 的旧值不覆盖')
    assert.deepEqual(r.kept.map((k) => k.key), ['max_chars'])
  } finally {
    if (old === undefined) delete process.env.WIZARD_PROJECT_ROOT
    else process.env.WIZARD_PROJECT_ROOT = old
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
  M.toEngineWords({ maps: { reference_text: 'ref_text' } }, req)
  assert.deepEqual(req, { text: 'hi', ref_audio_path: '/a.wav', ref_text: 'hello' })
  const req2 = { text: 'hi', reference_text: 'x' }
  M.toEngineWords({ maps: {} }, req2)
  assert.deepEqual(req2, { text: 'hi' }, '名片没映射参考文本 ⇒ 不发')
})
