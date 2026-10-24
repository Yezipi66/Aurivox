'use strict'
// editor/postJson.js 的测试：请求失败要变成可读的结论，不许把异常抛出去。
//
// 判据的理由：这段逻辑失守时，界面会停在「正在读…」而且不显示任何原因，
//   使用者看不出出了什么事。所以两类失败各判一次，而且都判「不抛」。

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// editor/ 下的 .js 是 ESM（编辑器打包成浏览器模块），要用 ESM 加载器读。
const MOD_PATH = path.join(__dirname, '..', 'editor', 'postJson.js')
let postJson
test('加载 postJson.js', async () => {
  const mod = await import(pathToFileURL(MOD_PATH).href)
  postJson = mod.postJson
  assert.strictEqual(typeof postJson, 'function', 'postJson 要导出成函数')
})

// 网络层失败：fetch 自己抛（连接被拒、DNS 失败、超时）
test('网络层失败：返回可读的失败结论，不抛异常', async () => {
  const j = await postJson('/wizard/resolve', { url: 'x' }, async () => {
    throw new Error('connect ECONNREFUSED')
  })
  assert.strictEqual(j.ok, false)
  assert.strictEqual(j.code, 'REQUEST_FAILED')
  assert.strictEqual(j.path, '/wizard/resolve')
  assert.ok(j.errorZh && j.errorZh.length > 0, '中文说明不能为空')
  assert.ok(j.errorZh.includes('/wizard/resolve'), '中文说明要说明是哪个接口')
})

// 响应不是 JSON：服务端返回 HTML 错误页或网关返回纯文本
test('响应不是 JSON：返回可读的失败结论，不抛异常', async () => {
  const j = await postJson('/wizard/probe', { url: 'x' }, async () => ({
    status: 502,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
  }))
  assert.strictEqual(j.ok, false)
  assert.strictEqual(j.code, 'BAD_RESPONSE')
  assert.strictEqual(j.status, 502)
  assert.ok(j.errorZh.includes('502'), '中文说明要带上 HTTP 状态码')
})

// 成功路径：后端返回什么就原样交给调用方
test('成功路径：后端的 JSON 原样返回', async () => {
  const payload = { ok: true, id: 'spark-tts', url: 'https://github.com/x/y' }
  const j = await postJson('/wizard/resolve', { url: 'x' }, async () => ({
    status: 200,
    json: async () => payload,
  }))
  assert.deepStrictEqual(j, payload)
})

// 后端自己返回失败（ok:false）时，postJson 不许改写它
test('后端自己报失败时，原样返回后端的结论', async () => {
  const payload = { ok: false, code: 'NOT_GITHUB', params: { host: 'gitlab.com' } }
  const j = await postJson('/wizard/resolve', { url: 'x' }, async () => ({
    status: 200,
    json: async () => payload,
  }))
  assert.deepStrictEqual(j, payload)
  assert.strictEqual(j.code, 'NOT_GITHUB', '后端的 code 不能被请求层的 code 覆盖')
})

// 没有 fetch 的环境（极旧浏览器、测试环境未注入）：也要给出结论，不能抛
test('没有可用的请求接口时：返回失败结论，不抛异常', async () => {
  const saved = globalThis.fetch
  try {
    globalThis.fetch = undefined
    const j = await postJson('/wizard/resolve', { url: 'x' })
    assert.strictEqual(j.ok, false)
    assert.strictEqual(j.code, 'REQUEST_FAILED')
  } finally {
    globalThis.fetch = saved
  }
})
