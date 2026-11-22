'use strict'
// 第 3 步每个文件的四个状态：只有任务事件能改状态，读盘只用于初次恢复。

const { test } = require('node:test')
const assert = require('node:assert')

async function importModule () {
  return await import('../editor/downloadTask.js')
}

test('点下载就进入正在下载，不必等第一个字节', async () => {
  const m = await importModule()
  const t = m.startedTask(null, 'model.safetensors')
  assert.equal(t.state, m.DOWNLOADING)
  assert.equal(t.percent, 0)
  assert.equal(t.label, 'model.safetensors')
})

test('进度事件只更新同一个任务，不换状态也不换容器', async () => {
  const m = await importModule()
  const started = m.startedTask(null, 'a.bin')
  const t = m.progressTask(started, 'a.bin', { percent: 42, downloaded: 42, total: 100 })
  assert.equal(t.state, m.DOWNLOADING)
  assert.equal(t.percent, 42)
  assert.equal(t.label, 'a.bin')
})

test('正常收完就是下载完成，远端有没有给 SHA 都不参与判定', async () => {
  const m = await importModule()
  const started = m.startedTask(null, 'a.bin')
  const withSha = m.finishedTask(started, 'a.bin', { ok: true, sha256: 'abc' })
  const withoutSha = m.finishedTask(started, 'a.bin', { ok: true, sha256: null })
  assert.equal(withSha.state, m.DONE)
  assert.equal(withoutSha.state, m.DONE)
  assert.equal(m.needsDownload(withoutSha.state), false,
    '上游没给 SHA 也是完成，不许因此判成中断')
})

test('异常结束或被取消就是下载中断，并带上原因', async () => {
  const m = await importModule()
  const t = m.finishedTask({ state: m.DOWNLOADING, percent: 31 }, 'a.bin',
    { ok: false, errorZh: '连接中断' })
  assert.equal(t.state, m.INTERRUPTED)
  assert.equal(t.percent, 31)
  assert.equal(t.error, '连接中断')
  assert.equal(m.needsDownload(t.state), true)
})

test('初次加载没有活跃任务时，读盘结果只映射到四态之内', async () => {
  const m = await importModule()
  assert.equal(m.stateFromDisk('ok'), m.DONE)
  assert.equal(m.stateFromDisk('partial'), m.INTERRUPTED)
  assert.equal(m.stateFromDisk('missing'), m.NOT_DOWNLOADED)
  assert.equal(m.stateFromDisk(null), m.NOT_DOWNLOADED)
})

test('只有未下载和已中断需要再下一次', async () => {
  const m = await importModule()
  assert.equal(m.needsDownload(m.NOT_DOWNLOADED), true)
  assert.equal(m.needsDownload(m.INTERRUPTED), true)
  assert.equal(m.needsDownload(m.DOWNLOADING), false)
  assert.equal(m.needsDownload(m.DONE), false)
})

test('一共只有四个状态，不许再加第五个', async () => {
  const m = await importModule()
  const states = [m.NOT_DOWNLOADED, m.DOWNLOADING, m.DONE, m.INTERRUPTED]
  assert.equal(new Set(states).size, 4)
  assert.deepEqual(
    Object.keys(m).filter((k) => /^[A-Z_]+$/.test(k)).sort(),
    ['DONE', 'DOWNLOADING', 'INTERRUPTED', 'NOT_DOWNLOADED'])
})
