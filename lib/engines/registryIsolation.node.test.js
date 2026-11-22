'use strict'

// 一台坏名片不许拖垮整个引擎列表。
//
// 这条守的是一个真实事故：某台引擎改了目录名、名片里的 id 没跟着改，
// 于是 readManifest 抛错，而 listEngines 没有单台隔离，整条列表跟着抛。
// 结果是这台机器上所有引擎都读不出来，连没被动过的那几台也报同一个错，
// 报的还是别人的目录名。
//
// 判据两条：坏的那台要能被点名；其它台必须照常可读。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 附加目录是模块加载时读的环境变量，所以先把夹具摆好，再 require 注册表。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-reg-'))

function put (dir, manifest) {
  fs.mkdirSync(path.join(TMP, dir), { recursive: true })
  fs.writeFileSync(path.join(TMP, dir, 'manifest.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8')
}

put('ok-one', { id: 'ok-one' })
// 目录叫 bad-one，名片里却写着 another-id：这就是那次事故的形状。
put('bad-one', { id: 'another-id' })
// 坏 JSON 也要单独点名，不能被当成「这台没装」。
put('bad-json', '{ 这不是 JSON')

process.env.AURIVOX_EXTRA_ENGINES_DIR = TMP
const registry = require('./registry')

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
})

test('坏名片只登记它自己，列表继续扫', () => {
  const { engines, broken } = registry.scanEngines()
  const ids = engines.map((m) => m.id)
  assert.ok(ids.includes('ok-one'), '好的那台必须读得出来')
  assert.deepStrictEqual(broken.map((b) => b.id).sort(), ['bad-json', 'bad-one'],
    '两张坏名片都要被点名')
  const mismatch = broken.find((b) => b.id === 'bad-one')
  assert.strictEqual(mismatch.code, 'ENGINE_MANIFEST_ID_MISMATCH')
  assert.match(mismatch.message, /another-id/, '原因要写清名片里写的是什么')
})

test('listEngines / listEngineIds 不再因为一台坏名片而抛', () => {
  const ids = registry.listEngineIds()
  assert.ok(ids.includes('ok-one'))
  assert.ok(!ids.includes('bad-one'), '坏的那台不进可用列表')
})

test('要的是好的那台，照常拿到', () => {
  const m = registry.requireEngine('ok-one')
  assert.strictEqual(m.id, 'ok-one')
  assert.strictEqual(registry.getEngine('ok-one').id, 'ok-one')
})

test('要的正是坏的那台，报它自己的原因，而不是「没装」', () => {
  assert.throws(() => registry.requireEngine('bad-one'), (err) => {
    assert.strictEqual(err.code, 'ENGINE_MANIFEST_BROKEN')
    assert.match(err.message, /another-id/, '必须带上名片里写的那个 id')
    assert.strictEqual(err.dir, path.join(TMP, 'bad-one'))
    return true
  })
  assert.throws(() => registry.requireEngine('bad-json'),
    (err) => err.code === 'ENGINE_MANIFEST_BROKEN')
})

test('真正没有的引擎仍然是「没装」，并列出可用的', () => {
  assert.throws(() => registry.requireEngine('no-such-engine'), (err) => {
    assert.strictEqual(err.code, 'FG_ENGINE_UNSUPPORTED')
    assert.ok(Array.isArray(err.available) && err.available.includes('ok-one'))
    return true
  })
})
