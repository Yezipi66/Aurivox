'use strict'
// 本机测得的超时：存在 state/ 下、不进名片；平台解析名片时 本机测得 > 名片写的 > 平台默认，
// 每项的来源记在 profile.value_sources，本机测得的不算 defaulted。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const L = require('./localTimings')
const { resolveEngineProfile, DEFAULTS } = require('./profile')
const { requireEngine } = require('./registry')

function tmp (prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

// 一个只装着一台引擎的 engines/ 目录，返回 { enginesDir, root }。
function plantEngine (id, manifest) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lt-root-')))
  const dir = path.join(root, 'engines', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, label: id, ...manifest }, null, 2))
  return { root, enginesDir: path.join(root, 'engines') }
}

const RUNTIME = { python: 'engines/x/.venv', entry: '../../lib/engines/host.py', args: [] }

test('写读来回：落在 state/engine-timings/<id>.json，只留两项超时', () => {
  const root = tmp('lt-')
  try {
    const w = L.writeTimings(root, 'demo', { timeout_ms: 70000, 'runtime.ready_timeout_ms': 50000, max_chars: 48 },
      { readings: { readyMs: 12000 } })
    assert.equal(w.ok, true, w.error)
    assert.equal(w.path, path.join(root, 'state', 'engine-timings', 'demo.json'))
    const r = L.readTimings(root, 'demo')
    assert.deepEqual(r.values, { timeout_ms: 70000, 'runtime.ready_timeout_ms': 50000 }, 'max_chars 不按本机定')
    assert.equal(typeof r.measured_at, 'string')
    // 整份覆盖：第二次只给一项，另一项就没了
    L.writeTimings(root, 'demo', { 'runtime.ready_timeout_ms': 40000 })
    assert.deepEqual(L.readTimings(root, 'demo').values, { 'runtime.ready_timeout_ms': 40000 })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('读不出来一律当没测过：没有、坏 JSON、数不合法', () => {
  const root = tmp('lt-')
  try {
    assert.equal(L.readTimings(root, 'none'), null)
    fs.mkdirSync(path.join(root, 'state', 'engine-timings'), { recursive: true })
    fs.writeFileSync(path.join(root, 'state', 'engine-timings', 'bad.json'), '{ half')
    assert.equal(L.readTimings(root, 'bad'), null)
    fs.writeFileSync(path.join(root, 'state', 'engine-timings', 'neg.json'),
      JSON.stringify({ values: { timeout_ms: -1, 'runtime.ready_timeout_ms': 1.5 } }))
    assert.equal(L.readTimings(root, 'neg'), null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('id 不能借路径跑出 state/engine-timings/', () => {
  const root = tmp('lt-')
  try {
    assert.equal(L.writeTimings(root, '../evil', { timeout_ms: 1 }).ok, false)
    assert.equal(L.writeTimings(root, 'a/b', { timeout_ms: 1 }).ok, false)
    assert.equal(L.readTimings(root, '..'), null)
    assert.ok(!fs.existsSync(path.join(root, 'evil.json')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('state/ 被 .gitignore 排除：本机记录不进仓库', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8')
  assert.ok(/^state\/\s*$/m.test(gi), '.gitignore 里要有 state/')
})

test('registry：给了 enginesDir 就先在那里找', () => {
  const { enginesDir, root } = plantEngine('zz-only-here', { runtime: RUNTIME })
  try {
    assert.equal(requireEngine('zz-only-here', { enginesDir }).dir, path.join(enginesDir, 'zz-only-here'))
    assert.throws(() => requireEngine('zz-only-here'), /zz-only-here/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('优先级：本机测得 > 名片写的 > 平台默认；来源逐项记下', () => {
  const { enginesDir, root } = plantEngine('lt-a', {
    timeout_ms: 111000, timeout_ms_source: 'upstream',
    runtime: { ...RUNTIME, ready_timeout_ms: 222000, ready_timeout_ms_source: 'estimated' },
  })
  try {
    // 没测过：名片写的
    const p0 = resolveEngineProfile('lt-a', {}, { enginesDir, localRoot: root })
    assert.equal(p0.timeout_ms, 111000)
    assert.equal(p0.runtime.ready_timeout_ms, 222000)
    assert.deepEqual(p0.value_sources, { timeout_ms: 'manifest', max_chars: 'default', 'runtime.ready_timeout_ms': 'manifest' })
    assert.equal(p0.local_timings, null)

    // 测过：本机值盖过名片
    L.writeTimings(root, 'lt-a', { timeout_ms: 70000, 'runtime.ready_timeout_ms': 50000 })
    const p1 = resolveEngineProfile('lt-a', {}, { enginesDir, localRoot: root })
    assert.equal(p1.timeout_ms, 70000)
    assert.equal(p1.runtime.ready_timeout_ms, 50000)
    assert.equal(p1.value_sources.timeout_ms, 'local')
    assert.equal(p1.value_sources['runtime.ready_timeout_ms'], 'local')
    assert.equal(p1.local_timings.path, path.join(root, 'state', 'engine-timings', 'lt-a.json'))
    assert.deepEqual(p1.defaulted.filter((k) => /timeout/.test(k)), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('名片没写、本机测过 ⇒ 用本机值，且不算 defaulted；没测过的那项仍是平台默认', () => {
  const { enginesDir, root } = plantEngine('lt-b', { runtime: RUNTIME })
  try {
    L.writeTimings(root, 'lt-b', { 'runtime.ready_timeout_ms': 50000 })
    const p = resolveEngineProfile('lt-b', {}, { enginesDir, localRoot: root })
    assert.equal(p.runtime.ready_timeout_ms, 50000)
    assert.ok(!p.defaulted.includes('runtime.ready_timeout_ms'), '本机测得的不算平台默认')
    assert.equal(p.timeout_ms, DEFAULTS.timeout_ms)
    assert.ok(p.defaulted.includes('timeout_ms'))
    assert.equal(p.value_sources.timeout_ms, 'default')
    assert.equal(p.max_chars, DEFAULTS.max_chars)
    assert.equal(p.value_sources.max_chars, 'default')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('本机记录不碰 max_chars：名片写什么就是什么', () => {
  const { enginesDir, root } = plantEngine('lt-c', { max_chars: 30, max_chars_source: 'measured', runtime: RUNTIME })
  try {
    fs.mkdirSync(path.join(root, 'state', 'engine-timings'), { recursive: true })
    fs.writeFileSync(path.join(root, 'state', 'engine-timings', 'lt-c.json'),
      JSON.stringify({ values: { max_chars: 999, timeout_ms: 70000 } }))
    const p = resolveEngineProfile('lt-c', {}, { enginesDir, localRoot: root })
    assert.equal(p.max_chars, 30)
    assert.equal(p.value_sources.max_chars, 'manifest')
    assert.equal(p.timeout_ms, 70000)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('名片里写坏的值照样报错，哪怕本机值会盖过它（名片要能拿去别的机器用）', () => {
  const { enginesDir, root } = plantEngine('lt-d', { timeout_ms: -5, timeout_ms_source: 'estimated', runtime: RUNTIME })
  try {
    assert.throws(() => resolveEngineProfile('lt-d', {}, { enginesDir, localTimings: { timeout_ms: 70000 } }),
      /timeout_ms/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('localTimings 显式给 null ⇒ 当这台机器没测过，不读盘', () => {
  const { enginesDir, root } = plantEngine('lt-e', { runtime: RUNTIME })
  try {
    L.writeTimings(root, 'lt-e', { timeout_ms: 70000 })
    const p = resolveEngineProfile('lt-e', {}, { enginesDir, localRoot: root, localTimings: null })
    assert.equal(p.timeout_ms, DEFAULTS.timeout_ms)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('启动计划拿到的就绪预算是本机值（supervisor 用它等引擎上线）', () => {
  const { buildLaunchPlan } = require('./launchPlan')
  const { enginesDir, root } = plantEngine('lt-f', { runtime: RUNTIME })
  try {
    const p = resolveEngineProfile('lt-f', {}, { enginesDir, localTimings: { 'runtime.ready_timeout_ms': 50000 } })
    const plan = buildLaunchPlan(p, { rootDir: root, port: 9999 })
    assert.equal(plan.ready_timeout_ms, 50000)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
