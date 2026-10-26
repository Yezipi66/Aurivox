'use strict'
// 校验层要能查出平台当场就会抛的那几个必填键。
//
// 这条守卫来自一次真实漏报：向导第 4 步的 diagnose() 对平台的 9 个硬必填键
// 一律报 0 条诊断（逐个删掉跑一遍，diagnose() 全是 0 条），而平台自己
// (lib/engines/profile.js) 缺任何一个都直接抛 ENGINE_MANIFEST_INCOMPLETE。
// 后果是向导能存出一张平台装不上的名片，第 5 步的校验会放行。
//
// 判据不看「照着已装引擎总结出来的清单」（那份漏过一项），
// 而看平台的 required() / requiredBool() / positiveInt() 调用点本身。
// 平台的判据写在哪里，本守卫就从哪里取，不维护第二份。

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')

const { diagnose, summarize } = require('../core/validate.js')

const REPO = path.resolve(__dirname, '..', '..', '..')

// 平台 profile.js 里那些「缺了就抛」的键，逐个写出来。
// 每一项记着平台的判据形状：
//   missing  缺键就抛
//   nullable 缺键就抛，但写 null 是合法的（平台要区分「忘了写」与「不限制」）
//   positive 缺键就抛，写了还要是正整数
const PLATFORM_REQUIRED = [
  { path: 'runtime.python', shape: 'missing' },
  { path: 'runtime.entry', shape: 'missing' },
  { path: 'runtime.ready_endpoint', shape: 'missing' },
  { path: 'runtime.ready_timeout_ms', shape: 'positive' },
  { path: 'timeout_ms', shape: 'positive' },
  { path: 'max_chars', shape: 'positive' },
  { path: 'capabilities.requires_reference_audio', shape: 'missing' },
  { path: 'capabilities.output_sample_rate', shape: 'positive' },
  { path: 'capabilities.reference_clip_seconds', shape: 'nullable' },
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

// 一份完整的名片：平台那 9 个键齐全，其余不管。
function completeManifest () {
  const m = {
    id: 'probe-engine',
    label: 'Probe Engine',
    contract_version: 2,
    runtime: {
      python: 'engines/probe-engine/.venv',
      entry: 'infer.py',
      ready_endpoint: '/health',
      ready_timeout_ms: 60000,
      ready_timeout_ms_source: 'estimated',
    },
    timeout_ms: 30000,
    max_chars: 500,
    max_chars_source: 'estimated',
    timeout_ms_source: 'estimated',
    capabilities: {
      requires_reference_audio: true,
      output_sample_rate: 32000,
      reference_clip_seconds: [3, 10],
    },
  }
  return m
}

test('平台那 9 个必填键，缺一个校验层就要报一条 error', () => {
  for (const req of PLATFORM_REQUIRED) {
    const m = withoutKey(completeManifest(), req.path)
    const diags = diagnose(m)
    const hits = diags.filter((d) => d.level === 'error' && d.field === req.path)
    assert.ok(hits.length > 0,
      `删掉「${req.path}」后校验层一条 error 都没报。`
      + '平台缺这一项直接抛 ENGINE_MANIFEST_INCOMPLETE（lib/engines/profile.js），'
      + '校验层必须提前说。')
    assert.strictEqual(hits[0].code, 'ENGINE_MANIFEST_INCOMPLETE',
      `「${req.path}」缺失报的码是 ${hits[0].code}，应当是 ENGINE_MANIFEST_INCOMPLETE`)
  }
})

test('键齐全时不报错（校验层不能比平台更严）', () => {
  const sum = summarize(diagnose(completeManifest()))
  assert.strictEqual(sum.errors, 0,
    '一份键齐全的名片被判有错：校验层比平台更严')
})

test('reference_clip_seconds 写 null 是合法的（不限制）', () => {
  // 平台要能区分「忘了写」与「不限制」，所以 null 合法、缺键不合法。
  const m = withKey(completeManifest(), 'capabilities.reference_clip_seconds', null)
  const sum = summarize(diagnose(m))
  assert.strictEqual(sum.errors, 0,
    'reference_clip_seconds 写 null 被判有错：null 是「不限制」，平台收这个值')
})

test('reference_clip_seconds 的形状不成立时报错', () => {
  // 平台只收 null 或 [最短秒, 最长秒]（lib/engines/profile/fields.js 的 parseClipSeconds）。
  for (const bad of [5, [3], [10, 3], 'abc', [3, 'x']]) {
    const m = withKey(completeManifest(), 'capabilities.reference_clip_seconds', bad)
    const diags = diagnose(m)
    const hits = diags.filter((d) => d.level === 'error' &&
      d.field === 'capabilities.reference_clip_seconds')
    assert.ok(hits.length > 0,
      `reference_clip_seconds 写成 ${JSON.stringify(bad)} 没报错：`
      + '平台会抛 ENGINE_MANIFEST_INVALID_VALUE')
  }
})

test('reference_clip_seconds 写成合法区间时不报错', () => {
  for (const ok of [[3, 10], [0, 15], [0.5, 2]]) {
    const m = withKey(completeManifest(), 'capabilities.reference_clip_seconds', ok)
    const sum = summarize(diagnose(m))
    assert.strictEqual(sum.errors, 0,
      `reference_clip_seconds 写成 ${JSON.stringify(ok)} 被判有错`)
  }
})

test('空串算缺（平台 required() 把空串当没写）', () => {
  // 平台 required() 的判据是 undefined / null / '' 三样都算缺
  // （lib/engines/profile/fields.js:20）。只查 undefined || null 会放过空串，
  // 而空串在名片里就是「这一格没填」。
  for (const path of ['runtime.python', 'runtime.entry', 'runtime.ready_endpoint',
    'runtime.ready_timeout_ms', 'timeout_ms', 'max_chars',
    'capabilities.output_sample_rate']) {
    const m = withKey(completeManifest(), path, '')
    const diags = diagnose(m)
    const hits = diags.filter((d) => d.level === 'error' && d.field === path)
    assert.ok(hits.length > 0,
      `「${path}」写成空串没报错：平台把它当没写，装不上`)
  }
})

test('null 按平台那一类的判据算（必填的算缺，布尔位算类型错）', () => {
  // 平台 required() 把 null 当缺；requiredBool() 把 null 当「写了但不是布尔」。
  // 两种都是 error，只是码不同（前者 INCOMPLETE，后者 INVALID_VALUE）。
  // 校验层若把 requiredBool 的 null 当缺，码就报错了。
  for (const path of ['runtime.python', 'runtime.entry', 'runtime.ready_endpoint',
    'runtime.ready_timeout_ms', 'timeout_ms', 'max_chars',
    'capabilities.output_sample_rate']) {
    const m = withKey(completeManifest(), path, null)
    const diags = diagnose(m)
    const hits = diags.filter((d) => d.level === 'error' && d.field === path)
    assert.ok(hits.length > 0, `「${path}」写成 null 没报错`)
    assert.strictEqual(hits[0].code, 'ENGINE_MANIFEST_INCOMPLETE',
      `「${path}」写成 null 的码是 ${hits[0].code}，`
      + '平台 required() 对 null 抛的是 ENGINE_MANIFEST_INCOMPLETE')
  }

  const boolM = withKey(completeManifest(), 'capabilities.requires_reference_audio', null)
  const boolHits = diagnose(boolM)
    .filter((d) => d.level === 'error' && d.field === 'capabilities.requires_reference_audio')
  assert.ok(boolHits.length > 0, '布尔位写成 null 没报错')
  assert.strictEqual(boolHits[0].code, 'ENGINE_MANIFEST_INVALID_VALUE',
    `布尔位写成 null 的码是 ${boolHits[0].code}，`
    + '平台 requiredBool() 对 null 抛的是 ENGINE_MANIFEST_INVALID_VALUE（是「写了但类型错」，不是「缺」）')
})

test('布尔位写成非布尔值时报类型错（不是「缺」）', () => {
  for (const bad of [0, 1, 'true', 'false', '']) {
    const m = withKey(completeManifest(), 'capabilities.requires_reference_audio', bad)
    const hits = diagnose(m)
      .filter((d) => d.level === 'error' && d.field === 'capabilities.requires_reference_audio')
    assert.ok(hits.length > 0, `布尔位写成 ${JSON.stringify(bad)} 没报错`)
    assert.strictEqual(hits[0].code, 'ENGINE_MANIFEST_INVALID_VALUE',
      `布尔位写成 ${JSON.stringify(bad)} 的码是 ${hits[0].code}，应当是 ENGINE_MANIFEST_INVALID_VALUE`)
  }
})

test('正整数位写成 0 或负数时报错', () => {
  for (const path of ['runtime.ready_timeout_ms', 'timeout_ms', 'max_chars',
    'capabilities.output_sample_rate']) {
    for (const bad of [0, -1, 1.5]) {
      const m = withKey(completeManifest(), path, bad)
      const hits = diagnose(m).filter((d) => d.level === 'error' && d.field === path)
      assert.ok(hits.length > 0, `「${path}」写成 ${bad} 没报错`)
      assert.strictEqual(hits[0].code, 'ENGINE_MANIFEST_INVALID_VALUE',
        `「${path}」写成 ${bad} 的码是 ${hits[0].code}，应当是 ENGINE_MANIFEST_INVALID_VALUE`)
    }
  }
})

test('校验层对「缺」的判据与平台同源（不重写一遍）', () => {
  // 这条守卫守的是「别自己抄一份平台的判据」：
  // 三个函数判「缺」的方式各不相同（空串算不算缺、null 算不算缺），
  // 抄一遍就会漂（漂过一次：空串被放过、布尔位的 null 报错了码）。
  // 判据：validate.js 里不许出现自己写的「缺 = undefined || null」那种判断，
  // 而是要 require 平台的 fields.js 并调它。
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'validate.js'), 'utf8')
  assert.ok(/require\([^)]*profile['"\\/, ]*fields\.js/.test(src),
    'validate.js 没有 require 平台的 profile/fields.js：'
    + '「缺了算不算缺」被重写了一遍，判据会与平台漂')
  assert.ok(/platform\.required\(/.test(src),
    'validate.js 没有调平台的 required()')
  assert.ok(/platform\.parseClipSeconds\(/.test(src),
    'validate.js 没有调平台的 parseClipSeconds()')
})

test('平台的必填键清单与本守卫一致（守卫不许漏项）', () => {
  // 从平台源码里把 required() / requiredBool() / positiveInt() 的调用点挖出来，
  // 跟本守卫手写的清单逐条对。
  // 平台自己写的是 keyPath 字符串（'runtime.python' 这种），
  // 这里从第二个参数取。
  const src = fs.readFileSync(path.join(REPO, 'lib', 'engines', 'profile.js'), 'utf8')
  const found = new Set()
  const re = /\b(?:required|requiredBool|positiveInt)\(\s*manifest,\s*'([^']+)'/g
  let m
  while ((m = re.exec(src))) found.add(m[1])

  // parseClipSeconds 的那一条是单独判的（`'reference_clip_seconds' in caps`），
  // 不走 required()，所以源码里挖不到，手工补上。
  found.add('capabilities.reference_clip_seconds')

  const mine = new Set(PLATFORM_REQUIRED.map((r) => r.path))
  const missing = [...found].filter((k) => !mine.has(k))
  const extra = [...mine].filter((k) => !found.has(k))

  assert.deepStrictEqual(missing, [],
    `平台的必填键清单比本守卫多：${missing.join('、')} —— `
    + '本守卫漏了这些键，向导会对它们不报（平台却要）')
  assert.deepStrictEqual(extra, [],
    `本守卫多算了这些键：${extra.join('、')} —— `
    + '它们不是平台的必填键，守卫对它们报错就是比平台更严')
})
