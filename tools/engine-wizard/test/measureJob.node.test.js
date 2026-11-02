'use strict'
// 第 5 步试跑的后台任务：POST 立即返回，阶段可轮询，服务端整体超时兜底，同一台引擎不许并发。

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const J = require('../core/measureJob')
const wb = require('../core/wizardbridge.js')

const tick = () => new Promise((r) => setImmediate(r))

// 一个能从外面一步步推进的假试跑：记下 onStage / signal，等测试 resolve。
function controllableRun () {
  const ctl = {}
  ctl.run = (id, o) => new Promise((resolve) => {
    ctl.id = id; ctl.opts = o; ctl.resolve = resolve
  })
  return ctl
}

let seq = 0
const freshId = () => `job${++seq}-${Date.now()}`

test('起任务立即返回 running/starting；阶段随 onStage 走；完成后带结果', async () => {
  const ctl = controllableRun()
  let clock = 1000
  const now = () => clock
  const id = freshId()
  const r = J.startMeasureJob(id, { text: 'hi' }, { run: ctl.run, now })
  assert.equal(r.ok, true)
  assert.equal(r.job.state, 'running')
  assert.equal(r.job.stage, 'starting')
  await tick()
  assert.deepEqual(ctl.opts.request, { text: 'hi' })
  assert.ok(ctl.opts.signal, '要把中止信号交给试跑')

  ctl.opts.onStage('synth')
  clock = 6000
  const mid = J.getMeasureJob(id, { now })
  assert.equal(mid.stage, 'synth')
  assert.equal(mid.elapsed_ms, 5000, '已用时间从任务开始算')

  ctl.resolve({ ok: true, values: { timeout_ms: 70000 } })
  await tick(); await tick()
  clock = 9000
  const done = J.getMeasureJob(id, { now })
  assert.equal(done.state, 'done')
  assert.equal(done.stage, 'done')
  assert.equal(done.elapsed_ms, 5000, '结束后已用时间不再涨')
  assert.equal(done.result.values.timeout_ms, 70000)
})

test('试跑失败 ⇒ stage failed，结果原样带出', async () => {
  const id = freshId()
  J.startMeasureJob(id, { text: 'hi' }, { run: async () => ({ ok: false, error: '起不来' }) })
  await tick(); await tick()
  const j = J.getMeasureJob(id)
  assert.equal(j.state, 'failed')
  assert.equal(j.stage, 'failed')
  assert.equal(j.result.error, '起不来')
})

test('同一台引擎在跑时再起 ⇒ MEASURE_RUNNING，不起第二个', async () => {
  const ctl = controllableRun()
  const id = freshId()
  J.startMeasureJob(id, { text: 'hi' }, { run: ctl.run })
  let n = 0
  const r = J.startMeasureJob(id, { text: 'hi' }, { run: async () => { n++; return { ok: true } } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'MEASURE_RUNNING')
  await tick()
  assert.equal(n, 0)
  ctl.resolve({ ok: true })
})

test('整体超时：到点 abort 并记 MEASURE_TIMEOUT；迟到的结果不改任务', async () => {
  const ctl = controllableRun()
  const id = freshId()
  J.startMeasureJob(id, { text: 'hi' }, { run: ctl.run, timeoutMs: 20 })
  await tick()
  await new Promise((r) => setTimeout(r, 40))
  const j = J.getMeasureJob(id)
  assert.equal(j.state, 'failed')
  assert.equal(j.code, 'MEASURE_TIMEOUT')
  assert.equal(ctl.opts.signal.aborted, true, '超时要真的中止试跑（收掉引擎进程）')
  ctl.resolve({ ok: true })
  await tick(); await tick()
  assert.equal(J.getMeasureJob(id).code, 'MEASURE_TIMEOUT')
})

test('默认整体超时不短于等就绪 + 单段合成两段预算之和', () => {
  const { BUDGET } = require('../core/measure')
  assert.ok(J.OVERALL_TIMEOUT_MS > BUDGET.readyMs + BUDGET.synthMs)
})

test('取消：abort 并记 MEASURE_CANCELLED；没有在跑的 ⇒ cancelled:false', async () => {
  const ctl = controllableRun()
  const id = freshId()
  J.startMeasureJob(id, { text: 'hi' }, { run: ctl.run })
  await tick()
  const c = J.cancelMeasureJob(id)
  assert.equal(c.cancelled, true)
  assert.equal(ctl.opts.signal.aborted, true)
  assert.equal(J.getMeasureJob(id).code, 'MEASURE_CANCELLED')
  assert.equal(J.cancelMeasureJob(id).cancelled, false)
  assert.equal(J.cancelMeasureJob('never-ran').cancelled, false)
  ctl.resolve({ ok: true })
})

// ---- HTTP 层：路由互不吞，POST 立即回 202，进度可读 ----

function fakeReq (method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json' }
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function fakeRes () {
  const res = { statusCode: null, body: null }
  res.done = new Promise((resolve) => {
    res.writeHead = (code) => { res.statusCode = code; return res }
    res.setHeader = () => {}
    res.end = (text) => { if (res.statusCode === null) res.statusCode = 200; res.body = text ? JSON.parse(text) : null; resolve(res) }
  })
  return res
}

test('路由：measure / progress / cancel 各认各的，/wizard/verify 不吃它们', () => {
  const H = [wb.handleVerifyMeasure, wb.handleVerifyMeasureProgress, wb.handleVerifyMeasureCancel]
  const probe = (h, method, url) => {
    // 只看认不认这个 URL；认了的会去读 body，这里给个空的 req 让它挂着不影响断言。
    const req = new EventEmitter(); req.method = method; req.url = url; req.headers = {}
    return h(req, fakeRes())
  }
  assert.equal(probe(H[0], 'POST', '/wizard/verify/measure/progress'), false)
  assert.equal(probe(H[0], 'POST', '/wizard/verify/measure/cancel'), false)
  assert.equal(probe(H[1], 'GET', '/wizard/verify/measure'), false)
  assert.equal(probe(H[2], 'POST', '/wizard/verify/measure'), false)
  assert.equal(wb.handleVerify({ method: 'POST', url: '/wizard/verify/measure/cancel' }, {}), false)
})

test('HTTP：POST 立即 202 带任务快照；progress 读得到；从没跑过 ⇒ job:null', async () => {
  const id = `http-${freshId()}`
  // 引擎不存在 ⇒ 后台试跑很快以失败收尾，但 POST 本身不等它。
  const res = fakeRes()
  wb.handleVerifyMeasure(fakeReq('POST', '/wizard/verify/measure', { id, request: { text: 'hi' } }), res)
  await res.done
  assert.equal(res.statusCode, 202)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.job.id, id)
  assert.ok(['running', 'failed'].includes(res.body.job.state))

  for (let i = 0; i < 50 && J.getMeasureJob(id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 10))
  const pres = fakeRes()
  assert.equal(wb.handleVerifyMeasureProgress(fakeReq('GET', `/wizard/verify/measure/progress?id=${id}`), pres), true)
  await pres.done
  assert.equal(pres.body.ok, true)
  assert.equal(pres.body.job.state, 'failed')
  assert.equal(typeof pres.body.job.elapsed_ms, 'number')

  const none = fakeRes()
  wb.handleVerifyMeasureProgress(fakeReq('GET', '/wizard/verify/measure/progress?id=nobody-here'), none)
  await none.done
  assert.deepEqual(none.body, { ok: true, job: null })
})

test('HTTP：没有文本 ⇒ 400，不起任务', async () => {
  const id = freshId()
  const res = fakeRes()
  wb.handleVerifyMeasure(fakeReq('POST', '/wizard/verify/measure', { id, request: {} }), res)
  await res.done
  assert.equal(res.statusCode, 400)
  assert.equal(J.getMeasureJob(id), null)
})

test('界面：试跑走后台任务 + 轮询，显示阶段与已用时间，不再同步等到底', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'editor', 'StepVerify.jsx'), 'utf8')
  assert.ok(src.includes('/wizard/verify/measure/progress'), '要轮询进度')
  assert.ok(src.includes('/wizard/verify/measure/cancel'), '要能取消')
  assert.ok(/measureStageLabel\(/.test(src) && /formatElapsed\(/.test(src), '要显示阶段与已用时间')
  assert.ok(!src.includes('已写回'), '试跑不再写回名片，文案也不许这么说')
})
