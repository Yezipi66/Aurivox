'use strict'
// 校验层的必填口径：名片里只有 5 项必须人答，其余平台推断或用保守默认。
//
//   call.bind.text / call.bind.ref_audio / call.bind.output_path（returns 是 file 时）
//   runtime.python / runtime.entry
//   另：启动脚本不是平台通用宿主时，runtime.ready_endpoint 平台答不出，照旧必填。
//
// 其余各项（timeout_ms / max_chars / ready_timeout_ms / requires_reference_audio /
// output_sample_rate / reference_clip_seconds）缺了不报，写了才查值。
// 判据不重写：直接调平台的 required() / positiveInt() / parseClipSeconds()。

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')

const { diagnose, summarize } = require('../core/validate.js')

const REPO = path.resolve(__dirname, '..', '..', '..')

const FIVE = [
  'call.bind.text', 'call.bind.ref_audio', 'call.bind.output_path',
  'runtime.python', 'runtime.entry',
]
const OPTIONAL = [
  'runtime.ready_timeout_ms', 'timeout_ms', 'max_chars',
  'capabilities.requires_reference_audio', 'capabilities.output_sample_rate',
  'capabilities.reference_clip_seconds',
]

// 从一份完整名片里挖掉某个键路径。
function withoutKey (manifest, keyPath) {
  const out = JSON.parse(JSON.stringify(manifest))
  const parts = keyPath.split('.')
  let o = out
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] === undefined) return out
    o = o[parts[i]]
  }
  delete o[parts[parts.length - 1]]
  return out
}

// 往一份完整名片里写某个键路径。
function withKey (manifest, keyPath, value) {
  const out = JSON.parse(JSON.stringify(manifest))
  const parts = keyPath.split('.')
  let o = out
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}
    o = o[parts[i]]
  }
  o[parts[parts.length - 1]] = value
  return out
}

// 一份只写了 5 项必填的名片（启动脚本是通用宿主，就绪端点平台代答）。
function minimalManifest () {
  return {
    id: 'probe-engine',
    label: 'Probe Engine',
    contract_version: 2,
    runtime: {
      python: 'engines/probe-engine/.venv',
      entry: '../../lib/engines/host.py',
    },
    call: {
      kind: 'python', module: 'probe', class: 'Probe', method: 'run',
      bind: { text: 'text', ref_audio: 'prompt_wav', output_path: 'out_path' },
    },
  }
}

// 可选项也写全的名片。
function fullManifest () {
  const m = minimalManifest()
  m.runtime.ready_endpoint = '/health'
  m.runtime.ready_timeout_ms = 60000
  m.runtime.ready_timeout_ms_source = 'estimated'
  m.timeout_ms = 30000
  m.timeout_ms_source = 'estimated'
  m.max_chars = 500
  m.max_chars_source = 'estimated'
  m.capabilities = { requires_reference_audio: true, output_sample_rate: 32000, reference_clip_seconds: [3, 10] }
  return m
}

test('只写 5 项必填 ⇒ 0 条 error（其余平台代答）', () => {
  const diags = diagnose(minimalManifest())
  const errs = diags.filter((d) => d.level === 'error')
  assert.deepStrictEqual(errs.map((d) => d.field), [], '只写了 5 项的名片被判有错：校验层比平台更严')
})

test('5 项必填缺一个就报一条 INCOMPLETE', () => {
  for (const keyPath of FIVE) {
    for (const v of [undefined, '', null]) {
      const m = v === undefined ? withoutKey(minimalManifest(), keyPath) : withKey(minimalManifest(), keyPath, v)
      const hits = diagnose(m).filter((d) => d.level === 'error' && d.field === keyPath)
      assert.ok(hits.length > 0, `「${keyPath}」写成 ${JSON.stringify(v)} 没报错`)
      assert.strictEqual(hits[0].code, 'ENGINE_MANIFEST_INCOMPLETE')
    }
  }
})

test('可选项缺了不报（平台推断或用默认）', () => {
  for (const keyPath of OPTIONAL) {
    const m = withoutKey(fullManifest(), keyPath)
    const hits = diagnose(m).filter((d) => d.level === 'error' && d.field === keyPath)
    assert.deepStrictEqual(hits, [], `删掉可选项「${keyPath}」被报错了`)
  }
})

test('call.returns 不是 file ⇒ 不要求输出槽位', () => {
  for (const r of ['bytes', 'generator']) {
    const m = withoutKey(withKey(minimalManifest(), 'call.returns', r), 'call.bind.output_path')
    const hits = diagnose(m).filter((d) => d.level === 'error' && d.field === 'call.bind.output_path')
    assert.deepStrictEqual(hits, [], `returns=${r} 时不该要输出槽位`)
  }
})

test('启动脚本不是通用宿主 ⇒ 就绪端点必填；是通用宿主 ⇒ 不必填', () => {
  const own = withKey(minimalManifest(), 'runtime.entry', 'serve.py')
  assert.ok(diagnose(own).some((d) => d.level === 'error' && d.field === 'runtime.ready_endpoint'),
    '引擎自带服务脚本时平台不知道就绪端点，校验层要报')
  assert.ok(!diagnose(minimalManifest()).some((d) => d.field === 'runtime.ready_endpoint' && d.level === 'error'))
})

test('无 call 段、自带服务脚本的老引擎：不要求三个槽位', () => {
  const m = withoutKey(withKey(minimalManifest(), 'runtime.entry', 'serve.py'), 'call')
  m.runtime.ready_endpoint = '/'
  const errs = diagnose(m).filter((d) => d.level === 'error')
  assert.deepStrictEqual(errs.map((d) => d.field), [])
})

test('可选项写了就查值：正整数位写 0 / 负数 / 小数报 INVALID_VALUE', () => {
  for (const keyPath of ['runtime.ready_timeout_ms', 'timeout_ms', 'max_chars', 'capabilities.output_sample_rate']) {
    for (const bad of [0, -1, 1.5]) {
      const hits = diagnose(withKey(fullManifest(), keyPath, bad))
        .filter((d) => d.level === 'error' && d.field === keyPath)
      assert.ok(hits.length > 0, `「${keyPath}」写成 ${bad} 没报错`)
      assert.strictEqual(hits[0].code, 'ENGINE_MANIFEST_INVALID_VALUE')
    }
  }
})

test('布尔位写了非布尔值报类型错', () => {
  for (const bad of [null, 0, 1, 'true', '']) {
    const hits = diagnose(withKey(fullManifest(), 'capabilities.requires_reference_audio', bad))
      .filter((d) => d.level === 'error' && d.field === 'capabilities.requires_reference_audio')
    assert.ok(hits.length > 0, `布尔位写成 ${JSON.stringify(bad)} 没报错`)
    assert.strictEqual(hits[0].code, 'ENGINE_MANIFEST_INVALID_VALUE')
  }
})

test('reference_clip_seconds：null 与缺都合法；形状不对报错', () => {
  assert.strictEqual(summarize(diagnose(withKey(fullManifest(), 'capabilities.reference_clip_seconds', null))).errors, 0)
  for (const ok of [[3, 10], [0, 15], [0.5, 2]]) {
    assert.strictEqual(summarize(diagnose(withKey(fullManifest(), 'capabilities.reference_clip_seconds', ok))).errors, 0)
  }
  for (const bad of [5, [3], [10, 3], 'abc', [3, 'x']]) {
    const hits = diagnose(withKey(fullManifest(), 'capabilities.reference_clip_seconds', bad))
      .filter((d) => d.level === 'error' && d.field === 'capabilities.reference_clip_seconds')
    assert.ok(hits.length > 0, `reference_clip_seconds 写成 ${JSON.stringify(bad)} 没报错`)
  }
})

test('校验层对「缺」的判据与平台同源（不重写一遍）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'validate.js'), 'utf8')
  assert.ok(/require\([^)]*profile['"\\/, ]*fields\.js/.test(src), 'validate.js 没有 require 平台的 profile/fields.js')
  assert.ok(/platform\.required\(/.test(src), 'validate.js 没有调平台的 required()')
  assert.ok(/platform\.positiveInt\(/.test(src), 'validate.js 没有调平台的 positiveInt()')
  assert.ok(/platform\.parseClipSeconds\(/.test(src), 'validate.js 没有调平台的 parseClipSeconds()')
})

test('平台 profile.js 里还在 required() 的键，校验层都要求（守卫不许漏项）', () => {
  // 平台只剩 runtime 段的 python / entry / ready_endpoint 走 required()；
  // 其余改成「缺了走默认」。哪天平台又加回一个硬必填，这条会红。
  const src = fs.readFileSync(path.join(REPO, 'lib', 'engines', 'profile.js'), 'utf8')
  const found = new Set()
  const re = /\brequired\(\s*manifest,\s*'([^']+)'/g
  let m
  while ((m = re.exec(src))) found.add(m[1])
  assert.deepStrictEqual([...found].sort(), ['runtime.entry', 'runtime.python', 'runtime.ready_endpoint'],
    '平台的硬必填清单变了：同步本守卫与 validate.js 的 REQUIRED_KEYS')
})

test('向导的平台默认值与平台的 DEFAULTS 一致', async () => {
  const { DEFAULTS } = require(path.join(REPO, 'lib', 'engines', 'profile.js'))
  const src = fs.readFileSync(path.join(__dirname, '..', 'editor', 'optionalKeys.js'), 'utf8')
  for (const [k, v] of Object.entries(DEFAULTS)) {
    assert.ok(new RegExp(`\\b${k}:\\s*${v}\\b`).test(src), `optionalKeys.js 的 ${k} 与平台 DEFAULTS（${v}）不一致`)
  }
})
