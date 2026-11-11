const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

// 第 2 步执行期间要把 uv 的源码包构建并发限制为一，执行结束后恢复
//   调用前的取值。多台引擎并发安装时，先结束的那次不能提前恢复。

const ROOT = path.resolve(__dirname, '..', '..', '..')
const P = require(path.join(ROOT, 'tools', 'engine-wizard', 'core', 'uvBuildPolicy.js'))
const KEY = 'UV_CONCURRENT_BUILDS'

test('执行期间把构建并发设为一，结束后恢复原值', () => {
  const before = process.env[KEY]
  try {
    process.env[KEY] = '8'
    P.beginSerialBuilds()
    assert.strictEqual(process.env[KEY], '1')
    assert.strictEqual(P.serialBuildsActive(), true)
    P.endSerialBuilds()
    assert.strictEqual(process.env[KEY], '8')
    assert.strictEqual(P.serialBuildsActive(), false)
  } finally {
    if (before === undefined) delete process.env[KEY]
    else process.env[KEY] = before
    P.endSerialBuilds()
  }
})

test('原本没有设置时，结束后不留下这个变量', () => {
  const before = process.env[KEY]
  try {
    delete process.env[KEY]
    P.beginSerialBuilds()
    assert.strictEqual(process.env[KEY], '1')
    P.endSerialBuilds()
    assert.strictEqual(process.env[KEY], undefined)
  } finally {
    if (before === undefined) delete process.env[KEY]
    else process.env[KEY] = before
    P.endSerialBuilds()
  }
})

test('两次安装重叠时，先结束的那次不提前恢复', () => {
  const before = process.env[KEY]
  try {
    process.env[KEY] = '4'
    P.beginSerialBuilds()
    P.beginSerialBuilds()
    P.endSerialBuilds()
    assert.strictEqual(process.env[KEY], '1')
    assert.strictEqual(P.serialBuildsActive(), true)
    P.endSerialBuilds()
    assert.strictEqual(process.env[KEY], '4')
    assert.strictEqual(P.serialBuildsActive(), false)
  } finally {
    if (before === undefined) delete process.env[KEY]
    else process.env[KEY] = before
    P.endSerialBuilds()
  }
})

test('多结束一次不会把计数减成负数', () => {
  const before = process.env[KEY]
  try {
    P.endSerialBuilds()
    P.beginSerialBuilds()
    P.endSerialBuilds()
    P.endSerialBuilds()
    assert.strictEqual(P.serialBuildsActive(), false)
  } finally {
    if (before === undefined) delete process.env[KEY]
    else process.env[KEY] = before
  }
})

test('env 端点在执行前后成对调用', () => {
  const src = require('node:fs').readFileSync(
    path.join(ROOT, 'tools', 'engine-wizard', 'core', 'wizardbridge.js'), 'utf8')
  assert.ok(src.includes('builds.beginSerialBuilds()'), '执行前没有开启串行构建')
  assert.ok(src.includes('builds.endSerialBuilds()'), '结束后没有恢复取值')
  const at = src.indexOf('builds.beginSerialBuilds()')
  assert.ok(at < src.indexOf('runEnv(input).then('), '必须在执行之前开启')
})
