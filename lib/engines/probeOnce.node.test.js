'use strict'
/**
 * 加载失败必须**当场**报，不能等预算耗尽（2026-09-29）
 *
 * 起因：接 CosyVoice2 时连撞三次 900 秒超时。真相是 host.py 早就知道加载
 * 失败了 —— 它的 /health 里带着 failed:true 和完整 error（"No module named
 * 'matcha'"），⛔ 但 probeOnce 把 body 一行不看就 res.resume() 扔了，
 * supervisor 只拿到一个 false，于是干等到预算用完，再报「N 秒没有上线」。
 *
 * 那句报错把用户指向「机器慢 / 预算不够」，而真相是加载抛了异常 —— 方向
 * 完全错了。这一组测试钉的就是「错误的方向不许再出现」。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { probeOnce } = require('./spawnEngine')

/** 起一个假的 /health，按 body 说话。 */
function fakeHealth(body, status = 200) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
    srv.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${srv.address().port}/health`
      resolve({ url, close: () => new Promise((r) => srv.close(r)) })
    })
  })
}

test('加载失败（failed:true）⇒ probe 抛出带 engineFailed 的 Error，⛔ 不是 false', async () => {
  // ⚠ 503 不是随手写的：host.py 的 /health 在 not ready 时返 503
  //   （`self._send(200 if eng.ready else 503, …)`）。200 + failed:true
  //   在真实宿主里不存在 —— 那是「上线了却说自己失败」，自相矛盾。
  const h = await fakeHealth({
    ready: false,
    failed: true,
    error: "pydoc.ErrorDuringImport: problem in cosyvoice.flow.flow_matching\n"
      + "  ModuleNotFoundError: No module named 'matcha'",
    load_seconds: 42.1,
  }, 503)
  try {
    const r = await probeOnce(h.url, 2000)
    // ⛔ 旧行为：这里是 false —— 于是 supervisor 只能等满预算再报「超时」
    assert.ok(r instanceof Error, `期望抛 Error，实际拿到 ${JSON.stringify(r)}`)
    assert.equal(r.engineFailed, true, '必须带 engineFailed —— supervisor 靠它分辨「失败」和「还在加载」')
    assert.match(r.message, /No module named 'matcha'/,
      '失败原因必须原样带出来：用户要靠它知道缺的是 submodule')
  } finally {
    await h.close()
  }
})

test('还在加载（failed:false / 503）⇒ 仍然是 false，绝不当成失败', async () => {
  const h = await fakeHealth({ ready: false, failed: false, load_seconds: 3 }, 503)
  try {
    const r = await probeOnce(h.url, 2000)
    assert.equal(r, false, '「还在加载」和「加载失败」必须分开 —— 前者等一等会好')
  } finally {
    await h.close()
  }
})

test('ready（200）⇒ true', async () => {
  const h = await fakeHealth({ ready: true, failed: false })
  try {
    assert.equal(await probeOnce(h.url, 2000), true)
  } finally {
    await h.close()
  }
})

test('body 不是 JSON ⇒ 按「还没上线」处理，⛔ 不抛（宁可少报不可误报）', async () => {
  const h = await fakeHealth('<html>502 Bad Gateway</html>', 502)
  try {
    assert.equal(await probeOnce(h.url, 2000), false)
  } finally {
    await h.close()
  }
})

test('连不上 ⇒ false（跟以前一样，不抛）', async () => {
  // 找一个没人听的端口
  const s = http.createServer(() => {})
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const port = s.address().port
  await new Promise((r) => s.close(r))
  assert.equal(await probeOnce(`http://127.0.0.1:${port}/health`, 500), false)
})
