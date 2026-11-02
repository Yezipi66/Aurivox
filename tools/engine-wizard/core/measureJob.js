'use strict'
// 第 5 步试运行的后台任务：POST 立即返回，界面轮询进度。
//
// 与克隆、装依赖同一套形状：按引擎 id 记一个正在进行的任务（AbortController 在里面），
//   取消端点按 id 找到它 abort。区别是试运行没有逐行输出，只有阶段，
//   所以走「GET 进度」轮询而不是 SSE 流：前端刷新页面后还能接着看。
//
// 阶段（job.stage）：
//   starting  起进程、等就绪
//   synth     合成中
//   done      完成（本机超时已更新）
//   failed    失败（含取消、整体超时）
//
// 整体超时：服务端自己掐表，不靠前端。到点 abort ⇒ measure.js 停止等待、断开请求、收掉进程，
//   任务当场记 failed（code MEASURE_TIMEOUT）。之后迟到的结果丢掉，不再改任务状态。
//
// 任务只在内存里：向导进程重启 ⇒ 任务没了，界面看到「没有正在进行的试运行」，重跑即可。

const { BUDGET, measureAndPersist } = require('./measure')

// 整体超时 = 等就绪的预算 + 单段合成的预算 + 两分钟收尾（解析名片、起进程、收进程）。
const OVERALL_TIMEOUT_MS = BUDGET.readyMs + BUDGET.synthMs + 2 * 60 * 1000

const jobs = new Map()

function snapshot (job, now) {
  if (!job) return null
  const end = job.finished_at === null ? now() : job.finished_at
  return {
    id: job.id,
    state: job.state,
    stage: job.stage,
    started_at: new Date(job.started_at).toISOString(),
    finished_at: job.finished_at === null ? null : new Date(job.finished_at).toISOString(),
    elapsed_ms: Math.max(0, end - job.started_at),
    timeout_ms: job.timeout_ms,
    code: job.code || null,
    result: job.result,
  }
}

/**
 * 起一个试运行任务。同一台引擎同时只许一个：两个进程抢同一个端口与同一份本机记录。
 * @param {string} id
 * @param {object} request   合成请求体
 * @param {object} [opts]  { run, timeoutMs, now }：run 默认 measureAndPersist，签名 (id, { request, onStage, signal })
 * @returns {{ok:true, job:object}|{ok:false, code:string, error:string, job?:object}}
 */
function startMeasureJob (id, request, opts = {}) {
  const now = opts.now || (() => Date.now())
  const run = opts.run || measureAndPersist
  const key = String(id || '')
  if (!key) return { ok: false, code: 'BAD_ID', error: 'id is required' }
  const cur = jobs.get(key)
  if (cur && cur.state === 'running') {
    return { ok: false, code: 'MEASURE_RUNNING', error: '这台引擎正在试运行，等它结束或先取消', job: snapshot(cur, now) }
  }
  const ac = new AbortController()
  const timeoutMs = opts.timeoutMs || OVERALL_TIMEOUT_MS
  const job = {
    id: key, state: 'running', stage: 'starting', started_at: now(), finished_at: null,
    timeout_ms: timeoutMs, code: null, result: null, ac, timer: null,
  }
  jobs.set(key, job)

  const finish = (stage, result, code) => {
    if (job.state !== 'running') return
    clearTimeout(job.timer)
    job.state = stage === 'done' ? 'done' : 'failed'
    job.stage = stage
    job.code = code || null
    job.result = result
    job.finished_at = now()
  }

  job.timer = setTimeout(() => {
    finish('failed', { ok: false, error: `试运行超过 ${Math.round(timeoutMs / 1000)} 秒，平台已中止并收掉引擎进程` },
      'MEASURE_TIMEOUT')
    ac.abort()
  }, timeoutMs)
  if (typeof job.timer.unref === 'function') job.timer.unref()

  Promise.resolve()
    .then(() => run(key, {
      request,
      signal: ac.signal,
      onStage: (s) => { if (job.state === 'running' && (s === 'starting' || s === 'synth')) job.stage = s },
    }))
    .then((r) => {
      if (r && r.measurement && r.measurement.cancelled) finish('failed', r, 'MEASURE_CANCELLED')
      else finish(r && r.ok ? 'done' : 'failed', r || { ok: false, error: '试运行没有返回结果' })
    })
    .catch((e) => finish('failed', { ok: false, error: (e && e.message) || String(e) }, 'BRIDGE_FAILED'))

  return { ok: true, job: snapshot(job, now) }
}

/** 某台引擎最近一次试运行的进度；从没跑过 ⇒ null。 */
function getMeasureJob (id, opts = {}) {
  return snapshot(jobs.get(String(id || '')), opts.now || (() => Date.now()))
}

/** 取消正在进行的试运行。没有进行中的 ⇒ cancelled:false，不报错。 */
function cancelMeasureJob (id, opts = {}) {
  const now = opts.now || (() => Date.now())
  const job = jobs.get(String(id || ''))
  if (!job || job.state !== 'running') return { ok: true, cancelled: false }
  clearTimeout(job.timer)
  job.state = 'failed'
  job.stage = 'failed'
  job.code = 'MEASURE_CANCELLED'
  job.result = { ok: false, error: '试运行已取消' }
  job.finished_at = now()
  job.ac.abort()
  return { ok: true, cancelled: true, job: snapshot(job, now) }
}

module.exports = {
  OVERALL_TIMEOUT_MS, startMeasureJob, getMeasureJob, cancelMeasureJob,
  __test__: { jobs },
}
