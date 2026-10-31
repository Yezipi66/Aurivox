'use strict'

// 换权重走名片声明的端点与参数名，不是任何一台引擎写死的形状。
// 这条经过 createSynthesisInstance → switchModels → 真客户端 → 真 socket，
// 用一台与 GSV 无关的假引擎：把执行器里的 query 或端点写死回 GSV，这里就红。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createSynthesisInstance } = require('../server/synthesisInstance')

test('⭐⭐ 非 GSV 名片：switch 的 endpoint / query 原样打到点名那台', async () => {
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
