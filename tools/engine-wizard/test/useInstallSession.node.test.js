'use strict'
// useInstallSession 的持久化语义守卫：会话段与持久段各自存什么、什么时候失效。
// 要盯住的两点：探测结果只进 sessionStorage；会话键只含引擎 id，
// 换 URL 仍是同一台、会话保留（切引擎才换键），同一 id 刷新则恢复。

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
  // 每次重新 import：mock storage 是新建的，模块里的函数每次调用
  // 都现取 global.localStorage / sessionStorage，所以不必清缓存。
  return await import('../editor/useInstallSession.js')
}

const URL_A = 'https://github.com/acme/alpha'
const URL_B = 'https://github.com/acme/beta'

test('刷新（同一 id + url）⇒ 会话段恢复', async () => {
  freshStores()
  const m = await mod()
  m.saveSession('alpha', URL_A, { probe: { meta: { packageName: 'alpha' } }, depsPlan: { ok: true } })
  // 同一 id + 同一 url 再读 ⇒ 一模一样（这就是刷新不丢）
  const back = m.loadSession('alpha', URL_A)
  assert.deepStrictEqual(back.probe, { meta: { packageName: 'alpha' } })
  assert.deepStrictEqual(back.depsPlan, { ok: true })
})

test('换 URL（同 id）⇒ 仍是同一台引擎的会话（不失效）', async () => {
  freshStores()
  const m = await mod()
  m.saveSession('alpha', URL_A, { probe: { meta: { packageName: 'alpha' } } })
  // 一台引擎一份会话，url 是它的固有属性而非每次可变的输入：
  //   切引擎只换 id，url 留在当前向导那一份，若按 id+url 找键就读不到自己的进度。
  assert.deepStrictEqual(m.loadSession('alpha', URL_B).probe,
    { meta: { packageName: 'alpha' } },
    '⛔ 换了 URL 就读不到这台引擎的会话 —— 切引擎后进度会像丢了一样')
  // 同一台写进去就更新同一份，不按 URL 分成两段
  m.saveSession('alpha', URL_B, { probe: { meta: { packageName: 'beta' } } })
  assert.deepStrictEqual(m.loadSession('alpha', URL_A).probe,
    { meta: { packageName: 'beta' } },
    '⛔ 同一台引擎按不同 URL 存成了两份会话')
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
  // localStorage 里一个字节都不许有：探测结果是会话态，不是持久态
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
  global.sessionStorage.setItem('tf.v1.wizard.sess:alpha', 'not json{{{')
  const m2 = await mod()
  assert.strictEqual(m2.loadSession('alpha', URL_A), null)
  assert.ok(global.sessionStorage.data.size >= 1)
})

test('clearSession 只清自己那一台，不动别的引擎', async () => {
  freshStores()
  const m = await mod()
  m.saveSession('alpha', URL_A, { probe: 1 })
  m.saveSession('beta', URL_B, { probe: 2 })
  m.clearSession('alpha', URL_A)
  assert.strictEqual(m.loadSession('alpha', URL_A), null)
  assert.ok(m.loadSession('beta', URL_B), '⛔ 清 alpha 把 beta 也清了')
})
