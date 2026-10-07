'use strict'
// downloadState — localStorage 持久化测试
//
//  ⭐ 测试策略：
//    · 用 Node 的 global.localStorage mock 浏览器 localStorage
//    · 测试 loadDownloadState/saveDownloadState/clearDownloadState
//    · 测试不同引擎状态隔离
//    · 测试 localStorage 不可用时的错误处理

const { test } = require('node:test')
const assert = require('node:assert')

// ⭐ 在 Node 环境里 mock localStorage
class MockStorage {
  constructor () { this.data = new Map() }
  getItem (k) { return this.data.has(k) ? this.data.get(k) : null }
  setItem (k, v) { this.data.set(k, String(v)) }
  removeItem (k) { this.data.delete(k) }
  clear () { this.data.clear() }
}

// ⭐ 动态 import ESM 模块
async function importModule () {
  return await import('../editor/downloadState.js')
}

test('downloadState — saveDownloadState + loadDownloadState 往返', async () => {
  const storage = new MockStorage()
  global.localStorage = storage
  const { saveDownloadState, loadDownloadState } = await importModule()

  const state = {
    manifest: [{ name: 'config.yaml', size: 2860, sha256: 'abc123', status: 'missing' }],
    probeError: null,
    dedup: false,
  }
  saveDownloadState('test-engine', state)
  const loaded = loadDownloadState('test-engine')
  assert.deepStrictEqual(loaded, state)
})

test('downloadState — 不同引擎状态隔离', async () => {
  const storage = new MockStorage()
  global.localStorage = storage
  const { saveDownloadState, loadDownloadState } = await importModule()

  saveDownloadState('engine-a', { manifest: [{ name: 'a.bin' }], probeError: null, dedup: true })
  saveDownloadState('engine-b', { manifest: [{ name: 'b.bin' }], probeError: null, dedup: false })

  const a = loadDownloadState('engine-a')
  const b = loadDownloadState('engine-b')
  assert.strictEqual(a.manifest[0].name, 'a.bin')
  assert.strictEqual(b.manifest[0].name, 'b.bin')
  assert.strictEqual(a.dedup, true)
  assert.strictEqual(b.dedup, false)
})

test('downloadState — clearDownloadState 清除指定引擎', async () => {
  const storage = new MockStorage()
  global.localStorage = storage
  const { saveDownloadState, loadDownloadState, clearDownloadState } = await importModule()

  saveDownloadState('engine-a', { manifest: [{ name: 'a.bin' }], probeError: null, dedup: true })
  saveDownloadState('engine-b', { manifest: [{ name: 'b.bin' }], probeError: null, dedup: true })

  clearDownloadState('engine-a')
  assert.strictEqual(loadDownloadState('engine-a'), null)
  assert.ok(loadDownloadState('engine-b'))
})

test('downloadState — localStorage 不可用时静默失败', async () => {
  global.localStorage = null
  const { saveDownloadState, loadDownloadState, clearDownloadState } = await importModule()

  // 不应该抛异常
  saveDownloadState('test', { manifest: null, probeError: null, dedup: true })
  assert.strictEqual(loadDownloadState('test'), null)
  clearDownloadState('test')
})

test('downloadState — 损坏的 JSON 被忽略', async () => {
  const storage = new MockStorage()
  global.localStorage = storage
  const { loadDownloadState } = await importModule()

  storage.setItem('wizard:download:broken', 'not valid json{{{')
  assert.strictEqual(loadDownloadState('broken'), null)
})

test('downloadState — 空 id 返回 null', async () => {
  const storage = new MockStorage()
  global.localStorage = storage
  const { loadDownloadState, saveDownloadState, clearDownloadState } = await importModule()

  assert.strictEqual(loadDownloadState(''), null)
  assert.strictEqual(loadDownloadState(null), null)
  assert.strictEqual(loadDownloadState(undefined), null)
  saveDownloadState('', { manifest: null, probeError: null, dedup: true })
  clearDownloadState('')
})
