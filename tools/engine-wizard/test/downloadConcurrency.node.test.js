'use strict'
// 第 3 步并发下载的测试。
//
// 守三件事：
//   ① 真的并发：同时下多个文件，而不是依次下。
//      判据是「同时在途的请求数」，不是「总耗时」——总耗时会因网络抖动而不可靠。
//   ② 进度按文件分开：每个文件的进度报给各自的槽位，不互相覆盖。
//   ③ 停止后能收口：取消时没派出去的任务也要有结果，调用方不会一直等下去。
//
// 这份测的是纯逻辑（downloadQueue.js / downloadRunner.js），
// fetch 被替换成假的，所以不碰网络也不碰磁盘。

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')

/** 加载 editor/ 下的纯 ESM 模块。 */
async function loadEsm (name) {
  return await import(pathToFileURL(path.join(EDITOR_DIR, name)).href)
}

// ---------------------------------------------------------------------------
// ① 调度器：并发数、顺序、暂停、停止
// ---------------------------------------------------------------------------

test('默认并发数是 6', async () => {
  const { DEFAULT_CONCURRENCY } = await loadEsm('downloadQueue.js')
  assert.strictEqual(DEFAULT_CONCURRENCY, 6)
})

test('调度器：同时在途的数不超过上限', async () => {
  const { createDownloadQueue } = await loadEsm('downloadQueue.js')
  const q = createDownloadQueue([1, 2, 3, 4, 5, 6, 7, 8], 3)
  const got = []
  for (;;) {
    const item = q.next()
    if (!item) break
    got.push(item)
  }
  assert.strictEqual(got.length, 3, '一次只能派 3 个')
  assert.strictEqual(q.running(), 3)
  q.finish(got[0])
  assert.strictEqual(q.next(), 4, '完成一个才能再派一个')
  assert.strictEqual(q.running(), 3)
})

test('调度器：finish 传错的键不会影响别的任务', async () => {
  const { createDownloadQueue } = await loadEsm('downloadQueue.js')
  const q = createDownloadQueue([1, 2], 2)
  q.next()
  q.next()
  assert.strictEqual(q.finish('not-a-key'), false)
  assert.strictEqual(q.running(), 2, '传错的键不该把在途的清掉')
})

test('调度器：暂停后不再派新任务，恢复后继续派', async () => {
  const { createDownloadQueue } = await loadEsm('downloadQueue.js')
  const q = createDownloadQueue([1, 2, 3], 1)
  assert.strictEqual(q.next(), 1)
  q.pause()
  assert.strictEqual(q.next(), null, '暂停时不该派新任务')
  q.resume()
  // 并发上限是 1，第一个任务还在途 ⇒ 恢复后也派不了下一个。
  //   恢复的作用是「不再暂停」，不是「无视并发上限」。
  assert.strictEqual(q.next(), null, '在途的没结束前仍受并发上限约束')
  q.finish(1)
  assert.strictEqual(q.next(), 2, '在途的结束且恢复后，继续派')
})

test('调度器：停止后不再派新任务，drain 取走未派出的', async () => {
  const { createDownloadQueue } = await loadEsm('downloadQueue.js')
  const q = createDownloadQueue([1, 2, 3], 1)
  q.next()
  q.stop()
  assert.strictEqual(q.next(), null)
  const rest = q.drain()
  assert.deepStrictEqual(rest, [2, 3], 'drain 应取走还没派出的')
  assert.strictEqual(q.isDone(), false, '在途的还没结束')
  q.finish(1)
  assert.strictEqual(q.isDone(), true, '在途的结束且队列空了 ⇒ 全部结束')
})

// ---------------------------------------------------------------------------
// ② 并发执行器：真并发、进度分槽、停止能收口
// ---------------------------------------------------------------------------

/** 造一个只含 SSE 事件的假响应体。 */
function sseBody (events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  const bytes = new TextEncoder().encode(text)
  let sent = false
  return {
    getReader () {
      return {
        read () {
          if (sent) return Promise.resolve({ done: true, value: undefined })
          sent = true
          return Promise.resolve({ done: false, value: bytes })
        },
      }
    },
  }
}

/**
 * 造一个假的 fetch：每个请求挂住，由测试自己放行。
 * 放行用 releaseAll：把在途请求的等待解开。
 */
function installFakeFetch () {
  const state = {
    inFlight: 0,
    maxInFlight: 0,
    started: [],
    waiters: new Map(),
  }
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const name = body.file.name
    state.started.push(name)
    state.inFlight += 1
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    await new Promise((resolve) => {
      state.waiters.set(name, resolve)
    })
    state.inFlight -= 1
    // 与真后端一致：先推 progress，再推 done。
    //   只推 done 的话 onProgress 永远不触发，测的就不是「进度分槽」这条了。
    return {
      ok: true,
      body: sseBody([
        { file: name, percent: 50, downloaded: 5, total: 10 },
        { ok: true, size: body.file.size },
      ]),
    }
  }
  /** 放行全部在途的请求。 */
  state.releaseAll = () => {
    for (const [name, r] of [...state.waiters.entries()]) {
      state.waiters.delete(name)
      r()
    }
  }
  return state
}

/** 放行所有请求，直到没有在途的为止。 */
async function drainFakeFetch (state, maxRounds = 50) {
  for (let i = 0; i < maxRounds; i++) {
    if (state.waiters.size === 0) {
      await new Promise((r) => setTimeout(r, 5))
      if (state.waiters.size === 0) return
    }
    state.releaseAll()
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('并发执行器：同时下多个文件（判据是在途请求数，不是总耗时）', async () => {
  const state = installFakeFetch()
  const { downloadFiles } = await loadEsm('downloadRunner.js')
  const files = [
    { name: 'a.bin', size: 1 },
    { name: 'b.bin', size: 1 },
    { name: 'c.bin', size: 1 },
    { name: 'd.bin', size: 1 },
    { name: 'e.bin', size: 1 },
    { name: 'f.bin', size: 1 },
    { name: 'g.bin', size: 1 },
  ]
  const p = downloadFiles({ id: 'demo', root: '/tmp', files, concurrency: 3 })

  // 等三个请求都发起
  await new Promise((r) => setTimeout(r, 30))
  assert.strictEqual(state.inFlight, 3, `应当同时有 3 个在途，实际 ${state.inFlight}`)
  assert.strictEqual(state.maxInFlight, 3)

  await drainFakeFetch(state)
  const r = await p
  assert.strictEqual(r.total, 7)
  assert.strictEqual(r.succeeded, 7, '七个文件都该成功')
  assert.ok(state.maxInFlight >= 2, '应当有并发，不是一个接一个')
  assert.ok(state.maxInFlight <= 3, `并发不应超过上限，实际 ${state.maxInFlight}`)
})

test('并发执行器：默认并发是 6', async () => {
  const state = installFakeFetch()
  const { downloadFiles } = await loadEsm('downloadRunner.js')
  const files = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.bin`, size: 1 }))
  const p = downloadFiles({ id: 'demo', root: '/tmp', files })
  await new Promise((r) => setTimeout(r, 30))
  assert.strictEqual(state.inFlight, 6, `默认应当同时有 6 个在途，实际 ${state.inFlight}`)
  await drainFakeFetch(state)
  const r = await p
  assert.strictEqual(r.succeeded, 10)
})

test('并发执行器：进度按文件分开报，不互相覆盖', async () => {
  const state = installFakeFetch()
  const { downloadFiles } = await loadEsm('downloadRunner.js')
  const progress = {}
  const p = downloadFiles({
    id: 'demo',
    root: '/tmp',
    files: [{ name: 'x.bin', size: 10 }, { name: 'y.bin', size: 20 }],
    concurrency: 2,
    onProgress: (name, ev) => {
      progress[name] = ev
    },
  })
  await new Promise((r) => setTimeout(r, 30))
  await drainFakeFetch(state)
  await p
  // 进度回调按文件名分槽，调用方据此渲染，不会互相覆盖
  assert.deepStrictEqual(Object.keys(progress).sort(), ['x.bin', 'y.bin'],
    '每个文件的进度都要报给各自的槽位')
})

test('并发执行器：停止后能收口，没派出的任务也有结果', async () => {
  const state = installFakeFetch()
  const { downloadFiles } = await loadEsm('downloadRunner.js')
  let stop = false
  const p = downloadFiles({
    id: 'demo',
    root: '/tmp',
    files: [
      { name: 'a.bin', size: 1 },
      { name: 'b.bin', size: 1 },
      { name: 'c.bin', size: 1 },
      { name: 'd.bin', size: 1 },
    ],
    concurrency: 1,
    shouldStop: () => stop,
  })
  await new Promise((r) => setTimeout(r, 30))
  stop = true
  await drainFakeFetch(state)
  const r = await p
  assert.strictEqual(r.total, 4, '总数应含没派出的那些')
  assert.ok(r.failed >= 1, '没派出的任务应算失败')
  assert.strictEqual(r.results.length, 4, '每个文件都要有结果，否则界面不知道发生了什么')
})
