'use strict'

// ---------------------------------------------------------------------------
//  lib/gsv/client.js —— 「连哪台、等多久」不再是模块级常量
// ---------------------------------------------------------------------------
// 契约 v2 第 1 步的验收测试。这里起真的 HTTP 服务端来收请求，因为要验的
// 恰恰是「请求最后落到了哪个端口」—— 用 mock 掉 http 模块就把要测的东西
// 一起 mock 掉了。
//
// ⚠ ENGINES_DIR 必须在 require 之前设好（lib/paths.js 在加载时定死它）。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const FAKE_ENGINES = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-client-'))
process.env.ENGINES_DIR = FAKE_ENGINES

// 造两台引擎：alpha 认领老路径身份并声明可被环境变量覆盖，beta 只是陪衬。
function plant(id, over = {}) {
  const dir = path.join(FAKE_ENGINES, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({
    id,
    contract_version: 2,
    default_base_url: 'http://127.0.0.1:1',   // 故意写个连不上的，确保「用到了它」时会显形
    timeout_ms: 300000,
    max_chars: 30,
    capabilities: {
      hot_swap_models: false,
      requires_reference_audio: true,
      reference_clip_seconds: null,
      streaming: false,
      output_sample_rate: 22050,
    },
  }, over), null, 2))
}

const client = require('./client')

// 起一个只会回声的服务端，记录收到的请求。
function startEcho() {
  return new Promise((resolve) => {
    const seen = []
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, port: server.address().port }))
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

test('不传 baseUrl 时，连的是名片上写 legacy_default:true 的那台', async (t) => {
  const echo = await startEcho()
  t.after(() => echo.server.close())

  plant('alpha', { legacy_default: true, default_base_url: echo.url })
  plant('beta')
  client._resetProfileCache()

  const res = await client.gsvPost('/tts', { text: 'hi' })
  assert.equal(res.statusCode, 200)
  assert.deepStrictEqual(echo.seen, [{ method: 'POST', url: '/tts' }])
})

test('名片声明的环境变量能顶掉名片里的地址（GPT_SOVITS_BASE_URL 这类历史变量照旧生效）', async (t) => {
  const echo = await startEcho()
  t.after(() => {
    echo.server.close()
    delete process.env.LEGACY_ENGINE_URL
  })

  // 名片里写的是连不上的 127.0.0.1:1；只有真的读了环境变量才会连到 echo。
  plant('alpha', { legacy_default: true, base_url_env: 'LEGACY_ENGINE_URL' })
  process.env.LEGACY_ENGINE_URL = echo.url
  client._resetProfileCache()

  const res = await client.gsvPost('/tts', { text: 'hi' })
  assert.equal(res.statusCode, 200, '请求应当落到环境变量指的那台')
})

test('⭐ 按次指定 baseUrl ⇒ 同一个进程里能对话第二台引擎', async (t) => {
  const a = await startEcho()
  const b = await startEcho()
  t.after(() => { a.server.close(); b.server.close() })

  plant('alpha', { legacy_default: true, default_base_url: a.url })
  plant('beta', { default_base_url: b.url })
  client._resetProfileCache()

  await client.gsvPost('/tts', { text: '默认' })
  await client.gsvPost('/tts', { text: '指定', x: 1 }, { baseUrl: b.url })

  assert.equal(a.seen.length, 1, '默认那次落在 alpha')
  assert.equal(b.seen.length, 1, '指定那次落在 beta —— 这是老代码做不到的事')
})

test('GET 也认 baseUrl（换权重那两个接口走的就是 GET）', async (t) => {
  const a = await startEcho()
  const b = await startEcho()
  t.after(() => { a.server.close(); b.server.close() })

  plant('alpha', { legacy_default: true, default_base_url: a.url })
  client._resetProfileCache()

  await client.gsvGet('/set_gpt_weights', { weights_path: 'x.ckpt' }, { baseUrl: b.url })
  assert.equal(a.seen.length, 0)
  assert.equal(b.seen[0].url, '/set_gpt_weights?weights_path=x.ckpt')
})

test('流式请求也认 baseUrl', async (t) => {
  const a = await startEcho()
  const b = await startEcho()
  t.after(() => { a.server.close(); b.server.close() })

  plant('alpha', { legacy_default: true, default_base_url: a.url })
  client._resetProfileCache()

  const up = await client.gsvStream('/tts', { text: 'x' }, 0, { baseUrl: b.url })
  up.stream.resume()
  assert.equal(b.seen.length, 1)
  assert.equal(a.seen.length, 0)
})

test('老的导出 GPT_SOVITS_BASE_URL 还在，但取的是名片里的值（健康页和合成不会各看各的）', async (t) => {
  const echo = await startEcho()
  t.after(() => echo.server.close())

  plant('alpha', { legacy_default: true, default_base_url: echo.url })
  client._resetProfileCache()

  assert.equal(client.GPT_SOVITS_BASE_URL, echo.url)
})

test('名片有问题时，报错发生在「第一次发请求」而不是「require 的时候」', async () => {
  // 这台引擎缺 timeout_ms。
  plant('alpha', { legacy_default: true })
  const dir = path.join(FAKE_ENGINES, 'alpha')
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  delete m.timeout_ms
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m))
  client._resetProfileCache()

  // require 早就完成了（文件顶部），进程还活着 —— 这正是要的：名片写错不该
  // 表现为「服务起不来且栈里全是 require」。
  await assert.rejects(() => client.gsvPost('/tts', { text: 'x' }),
    (e) => e.code === 'ENGINE_MANIFEST_INCOMPLETE' && /timeout_ms/.test(e.message))
})
