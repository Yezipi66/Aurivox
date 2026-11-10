'use strict'
// 一张清单里两种来源：仓库文件走 /wizard/download/file，文件直链走
// /wizard/download/url。端点与请求体在这里分流，界面与队列都不必知道。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { esbuild } = require('../../../lib/testDeps.js')
const FILE = path.join(__dirname, '..', 'editor', 'downloadRunner.js')

function load (stubQueue) {
  const code = esbuild().transformSync(fs.readFileSync(FILE, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, (id) => {
    if (id.endsWith('downloadQueue.js')) return stubQueue
    throw new Error('downloadRunner 的依赖不该被求值：' + id)
  }, mod)
  return mod.exports
}

const queueStub = {
  DEFAULT_CONCURRENCY: 2,
  createDownloadQueue: () => ({ isDone: () => true, next: () => null, drain: () => [], stop: () => {}, finish: () => {} }),
}

function fakeResponse () {
  return {
    ok: true,
    body: { getReader: () => ({ read: async () => ({ done: true, value: new Uint8Array() }) }) },
    json: async () => ({}),
  }
}

async function run (file) {
  const calls = []
  const original = global.fetch
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return fakeResponse()
  }
  try {
    const { downloadOneFile } = load(queueStub)
    await downloadOneFile({ id: 'demo', root: '', file, onDone: () => {} })
  } finally {
    global.fetch = original
  }
  return calls
}

test('文件直链条目走 url 端点，下载位置拆成 subdir 与 name', async () => {
  const calls = await run({
    kind: 'url', url: 'https://example.org/weights/model.safetensors',
    name: 'model.safetensors', subdir: 'sub', size: 10, tool: 'url',
  })
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].url, '/wizard/download/url')
  assert.strictEqual(calls[0].body.url, 'https://example.org/weights/model.safetensors')
  assert.strictEqual(calls[0].body.name, 'model.safetensors')
  assert.strictEqual(calls[0].body.subdir, 'sub')
  assert.strictEqual(calls[0].body.size, 10)
  assert.strictEqual(calls[0].body.overwrite, false, '首次下载不覆盖')
})

test('直链重新下载时明确带上覆盖标记', async () => {
  const calls = await run({
    kind: 'url', url: 'https://example.org/weights/model.safetensors',
    name: 'model.safetensors', subdir: '', size: 10, tool: 'url', overwrite: true,
  })
  assert.strictEqual(calls[0].url, '/wizard/download/url')
  assert.strictEqual(calls[0].body.overwrite, true)
})

test('仓库文件仍走 file 端点，仓库与来源照旧带在请求里', async () => {
  const calls = await run({
    name: 'config.yaml', size: 7, sha256: 'abc',
    repo: 'org/model', tool: 'hf', subdir: 'ck',
  })
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].url, '/wizard/download/file')
  assert.strictEqual(calls[0].body.repo, 'org/model')
  assert.strictEqual(calls[0].body.subdir, 'ck')
  assert.strictEqual(calls[0].body.file.tool, 'hf')
})

test('只标了 kind 却没有网址时按仓库文件处理，不会发空请求', async () => {
  const calls = await run({ kind: 'url', name: 'a.bin', repo: 'org/model', tool: 'hf' })
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].url, '/wizard/download/file')
})
