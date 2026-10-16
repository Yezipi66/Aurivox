'use strict'
// useInstallSession ： 向导持久化收敩后的那一个模块
//
// 守的两条纪律，各有一条能变红的断言：
//   ① 探测结果不落 localStorage（只能进 sessionStorage）
//   ② 键里含 id 与 url ⇒ 换 URL / 换引擎 ⇒ 旧会话自动失效（防串号）
//      + 同一 id + 同一 url（= 刷新）⇒ 恢复

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

function freshStores () {
  global.localStorage = new MockStorage()
  global.sessionStorage = new MockStorage()
}

async function mod () {
  // 每次都重新 import：mock storage 是新建的，模块内的函数每次调
  // pick() 现取 global.localStorage / sessionStorage，所以不必清缓存。
  return await import('../editor/useInstallSession.js')
}

const URL_A = 'https://github.com/acme/alpha'
const URL_B = 'https://github.com/acme/beta'

test('刷新（同一 id + url）⇒ 会话段恢复', async () => {
  freshStores()
  const m = await mod()
  m.saveSession('alpha', URL_A, { probe: { meta: { packageName: 'alpha' } }, depsPlan: { ok: true } })
  // 同一 id + 同一 url 再读 ⇒ 一模一样（这就是「刷新不丢」）
  const back = m.loadSession('alpha', URL_A)
  assert.deepStrictEqual(back.probe, { meta: { packageName: 'alpha' } })
  assert.deepStrictEqual(back.depsPlan, { ok: true })
})

test('换 URL（同 id）⇒ 旧会话段失效（防串号）', async () => {
  freshStores()
  const m = await mod()
  m.saveSession('alpha', URL_A, { probe: { meta: { packageName: 'alpha' } } })
  // 换了一个完全不同的仓库 ⇒ 读回来的必须是「没有会话」，不许是 alpha 的探测结果
  const back = m.loadSession('alpha', URL_B)
  assert.strictEqual(back, null,
    '⛔ 换了 URL 还读到旧仓库的探测结果 —— 这就是串号，用户会看到别的项目的依赖')
  // 并且写进去也不会污染旧的那一段
  m.saveSession('alpha', URL_B, { probe: { meta: { packageName: 'beta' } } })
  assert.deepStrictEqual(m.loadSession('alpha', URL_A).probe,
    { meta: { packageName: 'alpha' } }, '⛔ 写新 URL 把旧 URL 的会话改掉了')
  assert.deepStrictEqual(m.loadSession('alpha', URL_B).probe,
    { meta: { packageName: 'beta' } })
})

test('换引擎（同 URL）⇒ 旧会话段同样失效', async () => {
  freshStores()
  const m = await mod()
  m.saveSession('alpha', URL_A, { probe: { from: 'alpha' } })
  assert.strictEqual(m.loadSession('beta', URL_A), null,
    '⛔ 换了引擎还读到上一个引擎的探测结果')
})

test('探测结果一段都不许落 localStorage（只有 sessionStorage）', async () => {
  freshStores()
  const m = await mod()
  m.saveSession('alpha', URL_A, {
    probe: { secretOfProbe: 1 }, depsPlan: { x: 1 }, depsPreview: { y: 1 },
    manifest: [{ name: 'a.bin' }], probeError: 'boom',
  })
  // localStorage 里一个字节都不许有 ： 探测结果是会话态，不是持久态
  assert.strictEqual(global.localStorage.size, 0,
    `⛔ 探测结果写进 localStorage 了：${[...global.localStorage.data.keys()].join(', ')}`)
  // 而 sessionStorage 里必须有
  assert.ok(global.sessionStorage.size > 0, '⛔ sessionStorage 里没有会话段')
})

test('持久段里也只放用户输入与选择（url/id/cloneUrl/repoUrl + page）', async () => {
  freshStores()
  const m = await mod()
  m.savePersist({ url: 'u', id: 'alpha', repoUrl: URL_A, cloneUrl: 'git@x' })
  m.savePage('env')
  const keys = [...global.localStorage.data.keys()].sort()
  // 只有两个键：持久状态 + 当前展开哪一步，没有第三个
  assert.deepStrictEqual(keys, [m.NS + 'step', m.NS + 'wz'],
    `⛔ 持久段多出了键：${keys.join(', ')}`)
  assert.deepStrictEqual(m.loadPersist(),
    { url: 'u', id: 'alpha', cloneUrl: 'git@x', repoUrl: URL_A })
  assert.strictEqual(m.loadPage(), 'env')
})

test('孤儿键 tf.v1.wizard.repo 被一次性清掉', async () => {
  freshStores()
  const m = await mod()
  // 造出代码里没人读的那个键
  global.localStorage.setItem(m.NS + 'repo', JSON.stringify({ url: 'https://old' }))
  assert.ok(global.localStorage.getItem(m.NS + 'repo') !== null, '夹具没造成')
  m.purgeOrphanKeys()
  assert.strictEqual(global.localStorage.getItem(m.NS + 'repo'), null,
    '⛔ 孤儿键没被清掉')
  // 只清那一个，不动别的键
  global.localStorage.setItem('tf.v1.other.thing', 'keep')
  m.purgeOrphanKeys()
  assert.strictEqual(global.localStorage.getItem('tf.v1.other.thing'), 'keep')
})

test('saveSession 是局部 patch，不整份覆盖', async () => {
  freshStores()
  const m = await mod()
  m.saveSession('alpha', URL_A, { probe: 1, depsPlan: 2 })
  // 只写一个键 ⇒ 另一个还在
  m.saveSession('alpha', URL_A, { depsPlan: 3 })
  const back = m.loadSession('alpha', URL_A)
  assert.strictEqual(back.probe, 1, '⛔ 局部 patch 把别的键抹掉了')
  assert.strictEqual(back.depsPlan, 3)
})

test('storage 不可用时全部静默失败（不许抛）', async () => {
  global.localStorage = null
  global.sessionStorage = null
  const m = await mod()
  m.savePersist({ id: 'x' })
  assert.deepStrictEqual(m.loadPersist(), m.PERSIST_SHAPE)
  m.saveSession('x', URL_A, { probe: 1 })
  assert.strictEqual(m.loadSession('x', URL_A), null)
  m.clearSession('x', URL_A)
  m.purgeOrphanKeys()
  assert.strictEqual(m.loadPage(), 'prepare')
})

test('空 id 不许读写会话段（否则所有引擎共用一把钥匙）', async () => {
  freshStores()
  const m = await mod()
  m.saveSession('', URL_A, { probe: 'x' })
  assert.strictEqual(m.loadSession('', URL_A), null)
})

test('损坏的会话 JSON 被忽略（不抛，按没有会话处理）', async () => {
  freshStores()
  const m = await mod()
  // 直接往 sessionStorage 塞一段坏 JSON
  const k = Object.keys(global.sessionStorage.data).length
  global.sessionStorage.setItem('tf.v1.wizard.sess:alpha:' + String(URL_A.length), 'not json{{{')
  const m2 = await mod()
  assert.strictEqual(m2.loadSession('alpha', URL_A), null)
  assert.ok(global.sessionStorage.data.size >= 1)
})

test('clearSession 只清自己那一段', async () => {
  freshStores()
  const m = await mod()
  m.saveSession('alpha', URL_A, { probe: 1 })
  m.saveSession('alpha', URL_B, { probe: 2 })
  m.clearSession('alpha', URL_A)
  assert.strictEqual(m.loadSession('alpha', URL_A), null)
  assert.ok(m.loadSession('alpha', URL_B), '⛔ 清 A 把 B 也清了')
})
