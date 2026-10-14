'use strict'
// downloadState — 第 3 步下载状态的门面（内部走 useInstallSession 会话段）
//
// 「统一重构持久化」后，这个文件不再自己读写
//   localStorage，而是转调 editor/useInstallSession.js 的会话段。
//   本测试守三件事：
//     ① 三个导出名还在（StepsExtra.jsx 在用）
//     ② 键里含 id 与 url（换 URL ⇒ 读不到旧仓库的清单）
//     ③ 一段都不许落 localStorage（探测结果不是持久态）

const { test } = require('node:test')
const assert = require('node:assert')

class MockStorage {
  constructor () { this.data = new Map() }
  getItem (k) { return this.data.has(k) ? this.data.get(k) : null }
  setItem (k, v) { this.data.set(k, String(v)) }
  removeItem (k) { this.data.delete(k) }
  clear () { this.data.clear() }
  get size () { return this.data.size }
}

const URL_A = 'https://github.com/acme/alpha'
const URL_B = 'https://github.com/acme/beta'

async function importModule () {
  return await import('../editor/downloadState.js')
}

test('downloadState — save + load 往返', async () => {
  global.localStorage = new MockStorage()
  global.sessionStorage = new MockStorage()
  const { saveDownloadState, loadDownloadState } = await importModule()

  const state = {
    manifest: [{ name: 'config.yaml', size: 2860, sha256: 'abc123', status: 'missing' }],
    probeError: null,
    dedup: false,
  }
  saveDownloadState('test-engine', URL_A, state)
  const loaded = loadDownloadState('test-engine', URL_A)
  assert.deepStrictEqual(loaded, state)
})

test('downloadState — 换 URL ⇒ 读不到旧仓库的下载清单（防串号）', async () => {
  global.localStorage = new MockStorage()
  global.sessionStorage = new MockStorage()
  const { saveDownloadState, loadDownloadState } = await importModule()

  saveDownloadState('alpha', URL_A, { manifest: [{ name: 'a.bin' }], probeError: null, dedup: true })
  // 换了 URL 还显示旧仓库的文件清单就是串号
  assert.strictEqual(loadDownloadState('alpha', URL_B), null,
    '⛔ 换了 URL 还读到上一个仓库的下载清单')
  assert.ok(loadDownloadState('alpha', URL_A), '同一 id + url 应该读得到')
})

test('downloadState — 不同引擎状态隔离', async () => {
  global.localStorage = new MockStorage()
  global.sessionStorage = new MockStorage()
  const { saveDownloadState, loadDownloadState } = await importModule()

  saveDownloadState('engine-a', URL_A, { manifest: [{ name: 'a.bin' }], probeError: null, dedup: true })
  saveDownloadState('engine-b', URL_A, { manifest: [{ name: 'b.bin' }], probeError: null, dedup: false })

  const a = loadDownloadState('engine-a', URL_A)
  const b = loadDownloadState('engine-b', URL_A)
  assert.strictEqual(a.manifest[0].name, 'a.bin')
  assert.strictEqual(b.manifest[0].name, 'b.bin')
  assert.strictEqual(a.dedup, true)
  assert.strictEqual(b.dedup, false)
})

test('downloadState — clearDownloadState 只清指定引擎的那一段', async () => {
  global.localStorage = new MockStorage()
  global.sessionStorage = new MockStorage()
  const { saveDownloadState, loadDownloadState, clearDownloadState } = await importModule()

  saveDownloadState('engine-a', URL_A, { manifest: [{ name: 'a.bin' }], probeError: null, dedup: true })
  saveDownloadState('engine-b', URL_A, { manifest: [{ name: 'b.bin' }], probeError: null, dedup: true })

  clearDownloadState('engine-a', URL_A)
  assert.strictEqual(loadDownloadState('engine-a', URL_A), null)
  assert.ok(loadDownloadState('engine-b', URL_A))
})

test('downloadState — 一段都不落 localStorage（探测结果不是持久态）', async () => {
  global.localStorage = new MockStorage()
  global.sessionStorage = new MockStorage()
  const { saveDownloadState } = await importModule()

  saveDownloadState('alpha', URL_A, { manifest: [{ name: 'a.bin' }], probeError: null, dedup: true })
  assert.strictEqual(global.localStorage.size, 0,
    '⛔ 写进 localStorage 了：' + [...global.localStorage.data.keys()].join(', '))
  assert.ok(global.sessionStorage.size > 0, '⛔ sessionStorage 里没有会话段')
})

test('downloadState — storage 不可用时静默失败', async () => {
  global.localStorage = null
  global.sessionStorage = null
  const { saveDownloadState, loadDownloadState, clearDownloadState } = await importModule()

  assert.strictEqual(loadDownloadState('test', URL_A), null)
  saveDownloadState('test', URL_A, { manifest: null, probeError: null, dedup: true })
  clearDownloadState('test', URL_A)
})

test('downloadState — 空 id 返回 null', async () => {
  global.localStorage = new MockStorage()
  global.sessionStorage = new MockStorage()
  const { loadDownloadState, saveDownloadState, clearDownloadState } = await importModule()

  assert.strictEqual(loadDownloadState('', URL_A), null)
  assert.strictEqual(loadDownloadState(null, URL_A), null)
  assert.strictEqual(loadDownloadState(undefined, URL_A), null)
  saveDownloadState('', URL_A, { manifest: null, probeError: null, dedup: true })
  clearDownloadState('', URL_A)
})
