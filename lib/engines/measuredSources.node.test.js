'use strict'

// ---------------------------------------------------------------------------
//  刀 #13 / C13.2 —— 实测得来的数，填了就必须带 `_source`
// ---------------------------------------------------------------------------
// 名片里有三个「跑过才知道」的数：`max_chars` / `timeout_ms` /
// `runtime.ready_timeout_ms`。C13.2 的规矩：这些数**可以不写**（C13.1），
// 但**写了就必须说明出处**——同级必须有对应 `_source`，取值只能是
// `measured` / `upstream` / `estimated` 之一。
//
// ⚠ 这里用的是临时目录里造的假名片，不碰仓库里真的 engines/。
//   真名片的 `_source` 回填由 realManifests.node.test.js 那一侧盯着。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const FAKE_ENGINES = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-measured-'))
process.env.ENGINES_DIR = FAKE_ENGINES

const { resolveEngineProfile } = require('./profile')

function completeManifest(over = {}) {
  return Object.assign({
    label: 'Demo Engine',
    contract_version: 2,
    default_base_url: 'http://127.0.0.1:9999',
    timeout_ms: 300000,
    timeout_ms_source: 'measured',
    max_chars: 30,
    max_chars_source: 'measured',
    param_keys: [],
    capabilities: {
      requires_reference_audio: true,
      reference_clip_seconds: null,
      streaming: false,
      output_sample_rate: 22050,
      supports_finetune: false,
    },
  }, over)
}

let seq = 0
function plant(manifest) {
  const id = `demo${++seq}`
  const dir = path.join(FAKE_ENGINES, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'),
    JSON.stringify(Object.assign({}, manifest, { id }), null, 2))
  return id
}

function grab(fn) {
  try { fn(); return null } catch (err) { return err }
}

// ---------------------------------------------------------------------------
//  C13.1：留空时，出处守卫**不**拦（它只守"写了就得有出处"）
//  ⚠ 今天 max_chars / timeout_ms 仍是 required()，留空会被 required 拦下——
//    那是 C13.1「留空合法+保守默认值」那半的事（本轮暂缓）。本测试只验证：
//    即便 required 拦了，拦住它的是「缺字段」，⛔ 而不是「缺 _source」。
// ---------------------------------------------------------------------------

test('C13: 留空时出处守卫不拦（拦你的是 required，不是 _source 规则）', () => {
  const id = plant(Object.assign({}, completeManifest(), {
    timeout_ms: undefined,
    timeout_ms_source: undefined,
    max_chars: undefined,
    max_chars_source: undefined,
  }))
  const err = grab(() => resolveEngineProfile(id, {}))
  // 要么全通过（将来 C13.1 默认值到位后），要么被 required 拦 = ENGINE_MANIFEST_INCOMPLETE
  // 关键是：⛔ 绝不应该是 ENGINE_MANIFEST_INVALID_VALUE 那种"缺 _source"
  if (err) {
    assert.equal(err.code, 'ENGINE_MANIFEST_INCOMPLETE',
      `留空时被"缺出处"拦了 = C13.1 在守卫侧没放行：${err.message}`)
  }
})

// ---------------------------------------------------------------------------
//  C13.2：写了值，但没有 _source ⇒ 必须抛，且点名是哪个键
// ---------------------------------------------------------------------------

test('C13: 写了 max_chars 却没有 max_chars_source ⇒ 抛错并点名', () => {
  const id = plant(Object.assign({}, completeManifest(), { max_chars_source: undefined }))
  delete require.cache[require.resolve('./profile')]
  const { resolveEngineProfile: r2 } = require('./profile')
  const err = grab(() => r2(id, {}))
  assert.ok(err, '写了 max_chars 没带出处却静默通过 —— 守不住')
  assert.equal(err.code, 'ENGINE_MANIFEST_INVALID_VALUE')
  assert.ok(/max_chars_source/.test(err.message), `报错要指出是缺了出处：${err.message}`)
})

test('C13: 写了 timeout_ms 却没有 timeout_ms_source ⇒ 抛错', () => {
  const id = plant(Object.assign({}, completeManifest(), { timeout_ms_source: undefined }))
  const err = grab(() => resolveEngineProfile(id, {}))
  assert.ok(err)
  assert.ok(/timeout_ms_source/.test(err.message), err.message)
})

test('C13: runtime 写了 ready_timeout_ms 却没有 ready_timeout_ms_source ⇒ 抛错', () => {
  const id = plant(Object.assign({}, completeManifest(), {
    runtime: { python: 'venv/bin/python', entry: 'shim.py', ready_endpoint: '/health',
      ready_timeout_ms: 180000 }
  }))
  const err = grab(() => resolveEngineProfile(id, {}))
  assert.ok(err, 'runtime 段的 ready_timeout_ms 缺出处也该拦')
  assert.ok(/ready_timeout_ms_source/.test(err.message), err.message)
})

// ---------------------------------------------------------------------------
//  _source 取非法值 ⇒ 抛
// ---------------------------------------------------------------------------

test('C13: _source 写成非法词（如 "guessed"）⇒ 抛，且报错给出合法值清单', () => {
  const id = plant(Object.assign({}, completeManifest(), { max_chars_source: 'guessed' }))
  const err = grab(() => resolveEngineProfile(id, {}))
  assert.ok(err)
  assert.ok(/measured/.test(err.message) && /upstream/.test(err.message) && /estimated/.test(err.message),
    `报错要列出合法的出处值：${err.message}`)
})

// ---------------------------------------------------------------------------
//  三种合法出处都放行
// ---------------------------------------------------------------------------

for (const src of ['measured', 'upstream', 'estimated']) {
  test(`C13: max_chars_source 取合法值 "${src}" ⇒ 通过`, () => {
    const id = plant(Object.assign({}, completeManifest(), { max_chars_source: src }))
    const p = resolveEngineProfile(id, {})
    assert.ok(p, `${src} 应被放行`)
  })
}

test('C13: runtime.ready_timeout_ms_source 取合法值 ⇒ 通过', () => {
  const id = plant(Object.assign({}, completeManifest(), {
    runtime: { python: 'venv/bin/python', entry: 'shim.py', ready_endpoint: '/health',
      ready_timeout_ms: 180000, ready_timeout_ms_source: 'upstream' }
  }))
  const p = resolveEngineProfile(id, {})
  assert.equal(p.runtime.ready_timeout_ms, 180000)
})

// ⛔ 出处守卫本身不许带任何一台引擎的 id
test('C13: 出处校验逻辑里不许出现任何一台引擎的 id', () => {
  const src = fs.readFileSync(path.join(__dirname, 'profile.js'), 'utf8')
  // 抽出 MEASURED_PAIRS 到 checkMeasuredSources 那一段
  const seg = src.match(/const MEASURED_SOURCES[\s\S]*?function relPath/)
  assert.ok(seg, '定位出处校验段失败')
  assert.ok(!/gpt-sovits|indextts/gi.test(seg[0]),
    '出处规则是所有引擎通用的，校验函数里不该出现具体引擎 id')
})