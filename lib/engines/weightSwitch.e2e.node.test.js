'use strict'

// 切换权重使用名片声明的端点与参数名，不是任何一台引擎写死的形状。
// 本用例经过 createSynthesisInstance → switchModels → 真客户端 → 真 socket，
// 使用一台与 GSV 无关的假引擎：执行器中的 query 或端点若写死回 GSV，这里就红。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createSynthesisInstance } = require('../server/synthesisInstance')

test('⭐⭐ 非 GSV 名片：switch 的 endpoint / query 原样发送到指定引擎', async () => {
  const hits = []
  const srv = http.createServer((req, res) => { hits.push(req.url); res.end('ok') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const engine = {
    id: 'fake-voice',
    base_url: `http://127.0.0.1:${srv.address().port}`,
    timeout_ms: 5000,
    transport: 'http',
    weight_slots: [
      { name: 'acoustic', label: 'A', param: 'acoustic_ckpt', applies_at: 'call',
        switch: { endpoint: '/load_acoustic', query: 'ckpt' } },
      { name: 'vocoder', label: 'V', param: 'vocoder_ckpt', applies_at: 'call',
        switch: { endpoint: '/load_vocoder', query: 'file' } },
    ],
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-ws-e2e-'))
  const { synthesis } = createSynthesisInstance(
    { env: { AURIVOX_CACHE: '0' } },
    { CACHE: { segments: dir } },
  )
  try {
    await synthesis.switchModels({ acoustic_ckpt: 'a.pt', vocoder_ckpt: 'v.pt' }, engine)
    await synthesis.switchModels({ acoustic_ckpt: 'a.pt', vocoder_ckpt: 'v2.pt' }, engine)
    assert.deepEqual(hits, [
      '/load_acoustic?ckpt=a.pt',
      '/load_vocoder?file=v.pt',
      '/load_vocoder?file=v2.pt',
    ])
  } finally {
    await new Promise((r) => srv.close(r))
  }
})

test('⭐⭐ 装配：supervisor 关闭一台 ⇒ 执行器清除该格记录，同一份权重重新发送一次', async () => {
  const hits = []
  const srv = http.createServer((req, res) => { hits.push(req.url); res.end('ok') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const engine = {
    id: 'fake-stop',
    base_url: `http://127.0.0.1:${srv.address().port}`,
    timeout_ms: 5000,
    transport: 'http',
    weight_slots: [
      { name: 'acoustic', label: 'A', param: 'acoustic_ckpt', applies_at: 'call',
        switch: { endpoint: '/load_acoustic', query: 'ckpt' } },
    ],
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-ws-wiring-'))
  // 假 supervisor：装配代码需要在 supervisor 实例上注册作废回调，这里只负责在合适时机调用该回调。
  const supervisor = { onStopped: null }
  const { synthesis } = createSynthesisInstance(
    { env: { AURIVOX_CACHE: '0' } },
    { CACHE: { segments: dir } },
    { engineSupervisor: supervisor },
  )
  try {
    await synthesis.switchModels({ acoustic_ckpt: 'a.pt' }, engine)
    assert.deepEqual(hits, ['/load_acoustic?ckpt=a.pt'])

    supervisor.onStopped(engine.id)
    await synthesis.switchModels({ acoustic_ckpt: 'a.pt' }, engine)
    // 不作废 ⇒ 第二次不发送任何请求，而新进程载入的是默认权重：用错误的权重合成且不报错。
    assert.deepEqual(hits, ['/load_acoustic?ckpt=a.pt', '/load_acoustic?ckpt=a.pt'])
  } finally {
    await new Promise((r) => srv.close(r))
  }
})
