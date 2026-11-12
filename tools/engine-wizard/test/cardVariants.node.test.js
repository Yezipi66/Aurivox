'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')

// 一次接入多个形态：派生名片只换身份与命令行入口，环境与权重全部继承。
// 这一组守卫盯住两件事：共享字段不能被复制成新路径，整批校验失败时一张都不写。

const ROOT = path.resolve(__dirname, '..', '..', '..')
const C = require(path.join(ROOT, 'tools', 'engine-wizard', 'core', 'cardVariants.js'))
const { handleCards } = require(path.join(ROOT, 'tools', 'engine-wizard', 'core', 'savebridge.js'))

function baseCard () {
  return {
    id: 'demo', label: 'Demo',
    runtime: { python: 'engines/demo/.venv', checkpoints: 'engines/demo/checkpoints',
      entry: '../../lib/engines/host.py' },
    models: { required: ['a.bin', 'b.bin'], source: { url: 'https://example.invalid/repo' } },
    capabilities: { requires_reference_audio: false, output_sample_rate: 48000 },
    call: {
      kind: 'cli', argv: ['{engine_python}', '-m', 'demo', '--model-path', '{checkpoints}'],
      cwd: 'engines/demo', bind: { text: '--text', output_path: '--output' },
      args: { speed: { flag: '--speed', style: 'value' } },
    },
    parameters: [{ name: 'speed', type: 'number' }],
  }
}

function variant (id, sub) {
  return { id, label: id,
    argv: ['{engine_python}', '-m', 'demo', sub, '--model-path', '{checkpoints}'],
    requires_reference_audio: true }
}

test('派生名片继承环境、权重、参数与绑定，只换身份和命令行', () => {
  const base = baseCard()
  const r = C.deriveVariantManifest(base, variant('demo-clone', 'clone'))
  assert.strictEqual(r.ok, true)
  const m = r.manifest
  assert.strictEqual(m.id, 'demo-clone')
  assert.strictEqual(m.call.argv[3], 'clone')
  assert.strictEqual(m.runtime.python, 'engines/demo/.venv')
  assert.strictEqual(m.runtime.checkpoints, 'engines/demo/checkpoints')
  assert.strictEqual(m.call.cwd, 'engines/demo')
  assert.deepStrictEqual(m.models.required, ['a.bin', 'b.bin'])
  assert.deepStrictEqual(m.parameters, base.parameters)
  assert.deepStrictEqual(m.call.bind, base.call.bind)
  assert.deepStrictEqual(m.call.args, base.call.args)
  assert.strictEqual(m.capabilities.requires_reference_audio, true)
  assert.strictEqual(m.capabilities.output_sample_rate, 48000)
})

test('派生不改动基础名片', () => {
  const base = baseCard()
  const before = JSON.stringify(base)
  C.deriveVariantManifest(base, variant('demo-clone', 'clone'))
  assert.strictEqual(JSON.stringify(base), before)
})

test('id 为空、非法字符或与基础名片相同时拒绝', () => {
  const base = baseCard()
  assert.strictEqual(C.deriveVariantManifest(base, variant('', 'clone')).code, 'BAD_ID')
  assert.strictEqual(C.deriveVariantManifest(base, variant('a/b', 'clone')).code, 'BAD_ID')
  assert.strictEqual(C.deriveVariantManifest(base, variant('demo', 'clone')).code, 'SAME_ID')
})

test('argv 缺失、为空或含空白词时拒绝', () => {
  const base = baseCard()
  const v = variant('demo-clone', 'clone')
  assert.strictEqual(C.deriveVariantManifest(base, { ...v, argv: null }).code, 'BAD_ARGV')
  assert.strictEqual(C.deriveVariantManifest(base, { ...v, argv: [] }).code, 'BAD_ARGV')
  assert.strictEqual(C.deriveVariantManifest(base, { ...v, argv: ['ok', '  '] }).code, 'BAD_ARGV')
})

test('能力声明不是布尔值时拒绝', () => {
  const base = baseCard()
  const v = variant('demo-clone', 'clone')
  assert.strictEqual(C.deriveVariantManifest(base,
    { ...v, requires_reference_audio: 'yes' }).code, 'BAD_CAPABILITY')
})

test('整批派生：重复 id 与任一候选不合法都整批拒绝', () => {
  const base = baseCard()
  assert.strictEqual(C.buildVariantCards(base, []).code, 'NO_VARIANTS')
  const dup = C.buildVariantCards(base, [variant('demo-x', 'design'), variant('demo-x', 'clone')])
  assert.strictEqual(dup.code, 'DUP_ID')
  assert.strictEqual(dup.cards, undefined)
  const bad = C.buildVariantCards(base, [variant('demo-x', 'design'), variant('a/b', 'clone')])
  assert.strictEqual(bad.code, 'BAD_ID')
  assert.strictEqual(bad.at, 1)
  assert.strictEqual(bad.cards, undefined)
})

test('一次生成两张，sharedAssets 报出共用位置', () => {
  const base = baseCard()
  const r = C.buildVariantCards(base,
    [variant('demo-design', 'design'), variant('demo-clone', 'clone')])
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.cards.map((c) => c.id), ['demo-design', 'demo-clone'])
  const shared = C.sharedAssets(base)
  assert.strictEqual(shared.python, 'engines/demo/.venv')
  assert.strictEqual(shared.checkpoints, 'engines/demo/checkpoints')
  assert.strictEqual(shared.cwd, 'engines/demo')
})

function postCards (payload) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/wizard/cards'
    let status = null
    const res = {
      writeHead (code) { status = code },
      end (text) { resolve({ status, body: JSON.parse(text) }) },
    }
    try {
      const handled = handleCards(req, res)
      assert.strictEqual(handled, true)
      req.emit('data', JSON.stringify(payload))
      req.emit('end')
    } catch (e) { reject(e) }
  })
}

test('批量端点 dryRun 一次返回两张且不落盘', async () => {
  const base = baseCard()
  const r = await postCards({ base,
    variants: [variant('demo-design', 'design'), variant('demo-clone', 'clone')],
    dryRun: true })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.ok, true)
  assert.strictEqual(r.body.count, 2)
  assert.strictEqual(r.body.shared.python, 'engines/demo/.venv')
  assert.deepStrictEqual(r.body.results.map((x) => x.id), ['demo-design', 'demo-clone'])
  assert.ok(r.body.results.every((x) => x.dryRun === true))
})

test('批量端点候选非法时整批返回 400，不写任何文件', async () => {
  const base = baseCard()
  const r = await postCards({ base,
    variants: [variant('demo-design', 'design'), variant('a/b', 'clone')] })
  assert.strictEqual(r.status, 400)
  assert.strictEqual(r.body.ok, false)
  assert.strictEqual(r.body.code, 'BAD_ID')
  assert.strictEqual(r.body.results, undefined)
})

test('批量端点不认其它 URL，也不认 GET', () => {
  const res = { writeHead () {}, end () {} }
  assert.strictEqual(handleCards({ method: 'POST', url: '/wizard/save' }, res), false)
  assert.strictEqual(handleCards({ method: 'GET', url: '/wizard/cards' }, res), false)
})
