'use strict'
// acceptance：第 5 步验收记录的字段契约与时效现算。
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const {
  buildAcceptance, contractHash, freshness, requestDigest, weightsOf, canonical,
} = require('../lib/engines/acceptance.js')

const manifest = {
  contract_version: 3,
  registration: {
    id: 'demo', label: 'Demo',
    environment: { cwd: 'engines/demo', python: 'engines/demo/.venv' },
  },
  invocation: {
    kind: 'python',
    python: { module: 'm', class: 'C', method: 'infer', parameters: [] },
  },
}

test('contract 哈希排除 acceptance 自身，不会自指', () => {
  const h1 = contractHash(manifest)
  const withAcc = { ...manifest, acceptance: { status: 'pass', at: 'x' } }
  const h2 = contractHash(withAcc)
  assert.strictEqual(h1, h2, '加不加 acceptance 都不该改变契约指纹')
})

test('契约任一注册/调用字段一改，哈希就变', () => {
  const base = contractHash(manifest)
  const changed = contractHash({
    ...manifest,
    invocation: { ...manifest.invocation, python: { ...manifest.invocation.python, method: 'other' } },
  })
  assert.notStrictEqual(base, changed)
})

test('canonical 与键顺序无关', () => {
  assert.strictEqual(
    JSON.stringify(canonical({ b: 1, a: { d: 2, c: 3 } })),
    JSON.stringify(canonical({ a: { c: 3, d: 2 }, b: 1 })),
  )
})

test('request 摘要不存原文与绝对路径', () => {
  const d = requestDigest({ text: '这是一段秘密文本', reference_audio: 'D:/secret/ref.wav' })
  const s = JSON.stringify(d)
  assert.ok(!s.includes('这是一段秘密文本'), '原文不能落盘')
  assert.ok(!s.includes('D:/secret'), '绝对路径不能落盘')
  assert.deepStrictEqual(d.keys, ['reference_audio', 'text'])
})

test('weights 记相对引擎环境的相对路径', () => {
  const summary = [
    { name: 'gpt', path: 'assets/models/demo/gpt/v2' },
    { name: 'sovits', path: 'engines/demo/models/s1' },
    { name: 'ext', path: 'D:/other/model' },
  ]
  const w = weightsOf(summary, 'engines/demo')
  assert.strictEqual(w.gpt, 'assets/models/demo/gpt/v2')
  assert.strictEqual(w.sovits, 'models/s1')
  assert.deepStrictEqual(w.ext, { external: true, value: 'model' })
})

test('buildAcceptance 扁平标量，无 schema，无绝对路径', () => {
  const rec = buildAcceptance({
    manifestV011: manifest,
    profile: { weight_slots: [] },
    request: { text: '你好' },
    result: { ok: true, level: 'A', duration_sec: 2.5, audio_path: 'D:/out/verify.wav' },
    engineCwd: 'engines/demo',
    root: path.resolve(__dirname, '..'),
  })
  assert.strictEqual(rec.status, 'pass')
  assert.strictEqual(rec.duration_sec, 2.5)
  assert.ok(rec.verifier, 'verifier 应有真实文件哈希')
  assert.strictEqual(rec.contract, contractHash(manifest))
  assert.ok(!('schema' in rec), '不设独立 schema')
  assert.ok(!JSON.stringify(rec).includes('D:/out/verify.wav'), '音频绝对路径不落盘')
  assert.ok(!JSON.stringify(rec).includes('你好'), '文本原文不落盘')
})

test('失败记录带 error，duration 为空', () => {
  const rec = buildAcceptance({
    manifestV011: manifest,
    profile: { weight_slots: [] },
    request: { text: '你好' },
    result: { ok: false, level: 'A', stage: 'synth', error: 'boom' },
    engineCwd: 'engines/demo',
  })
  assert.strictEqual(rec.status, 'fail')
  assert.strictEqual(rec.duration_sec, null)
  assert.strictEqual(rec.error, 'synth')
})

test('freshness 现算：无记录 / 契约改变 / pass', () => {
  assert.strictEqual(freshness(manifest), 'unverified')
  const rec = buildAcceptance({
    manifestV011: manifest, profile: { weight_slots: [] },
    request: {}, result: { ok: true, duration_sec: 1 }, engineCwd: 'engines/demo',
  })
  assert.strictEqual(freshness({ ...manifest, acceptance: rec }), 'pass')
  const drifted = {
    ...manifest,
    invocation: { ...manifest.invocation, python: { ...manifest.invocation.python, method: 'changed' } },
    acceptance: rec,
  }
  assert.strictEqual(freshness(drifted), 'stale', '契约一改，旧记录当场过时')
})
