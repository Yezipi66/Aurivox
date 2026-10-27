'use strict'
// 第 5 步「试运行」：真起一次引擎，量出冷启动到就绪、合成一段的耗时，按余量定本机上的超时。
//
// 量到的值存哪：本机记录（lib/engines/localTimings.js，<写根>/state/engine-timings/<id>.json），
//   每次试运行整份覆盖。不写名片：名片描述的是引擎本身，要能分享给别人；
//   「在本机上多快」只对本机成立。平台解析名片时本机记录优先于名片里写的值
//   （lib/engines/profile.js）。
//
// 定哪两项：
//   runtime.ready_timeout_ms   冷启动到就绪
//   timeout_ms                 合成一段（max_chars 那么长）的单请求耗时
//   max_chars 不在其中：它是引擎自身的属性（一次能合成多长），试运行一次量不出上限。
//   试运行仍按 max_chars 凑文本，量的是「最长的一段」要多久。
//
// 根：读和写分开（wizardRoot.js）。
//   引擎在哪份 checkout（本 checkout 优先、主仓库兜底），名片、解释器、相对路径就按那份解析，
//   启动计划与 spawn 的 rootDir 也是它。
//   写的东西（本机记录、宿主 profile_json、日志）一律落写根，worktree 里跑不会写脏主仓库。
//
// 引擎怎么起：照平台自己的启动计划（lib/engines/launchPlan.js + spawnEngine.js），
//   与合成服务按需起引擎走同一条路，量出来的才是平台上真实的冷启动。
//   合成走 /tts，与平台正式合成写死的路由一致。采样率从返回的 wav 头读，不信响应头。
//   副作用（起进程、探活、发请求）都可注入，纯函数部分不起进程就能测。

const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const wizardRoot = require('./wizardRoot')

// 平台代码从本 checkout 加载：向导跑的是哪份代码，就用哪份平台库。
function platform (rel) { return require(path.join(wizardRoot.checkoutRoot(), rel)) }

// 余量：CPU 机器上一次和下一次能差出一截（缓存冷热、别的进程抢核），按倍数 + 下限留。
//   就绪：2 倍，且至少多 30 秒；单段：3 倍，且至少多 60 秒。都向上取整到 10 秒。
const MARGIN = Object.freeze({
  ready: { factor: 2, minExtraMs: 30000 },
  synth: { factor: 3, minExtraMs: 60000 },
  roundMs: 10000,
})

// 默认预算：等就绪、等一段合成各最多多久。量的是真实冷启动，不能被名片里的估计值卡住。
const BUDGET = Object.freeze({ readyMs: 15 * 60 * 1000, synthMs: 15 * 60 * 1000 })

function roundUp (ms, step) {
  return Math.ceil(ms / step) * step
}

function withMargin (ms, m) {
  return roundUp(Math.max(ms * m.factor, ms + m.minExtraMs), MARGIN.roundMs)
}

/**
 * 量到的读数 → 本机超时。读数缺哪项就不给哪项（未量到的不编）。
 * @param {{readyMs?:number, synthMs?:number, synthOk?:boolean}} m
 */
function deriveValues (m) {
  const out = {}
  if (Number.isFinite(m.readyMs) && m.readyMs >= 0) {
    out['runtime.ready_timeout_ms'] = withMargin(m.readyMs, MARGIN.ready)
  }
  if (m.synthOk && Number.isFinite(m.synthMs) && m.synthMs >= 0) {
    out.timeout_ms = withMargin(m.synthMs, MARGIN.synth)
  }
  return out
}

/**
 * 试运行用的文本：照用户给的文本凑到 n 个字符（不够就重复，超了就截），
 *   这样量到的是「最长的一段」要多久，而不是一句短话。
 *   截断落在空白或标点上，免得半个词。
 */
function textOfLength (text, n) {
  const base = String(text || '').trim()
  if (!base || !(n > 0)) return base
  let s = base
  while (s.length < n) s = s + ' ' + base
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  const m = /[\s,.;:!?，。；：！？、][^\s,.;:!?，。；：！？、]*$/.exec(cut)
  const trimmed = (m && m.index > n * 0.6 ? cut.slice(0, m.index + 1) : cut).trim()
  return trimmed
}

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

// signal 中止 ⇒ 请求当场断开，按失败返回（不抛）。
function postJson (url, body, timeoutMs, signal) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(url, { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks) }))
      res.on('error', (e) => resolve({ status: null, error: e.message }))
    })
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`请求超过 ${timeoutMs}ms`)) })
    req.on('error', (e) => resolve({ status: null, error: e.message }))
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('已取消')); return }
      signal.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true })
    }
    req.end(data)
  })
}

// 界面给的是平台的词（reference_audio / reference_text），宿主收的是 ref_audio_path
//   和引擎自己的参数名（名片 maps 说它叫什么，与合成服务 payload.js 同一张表）。
//   已经是引擎方言的键原样留着。就地改 request。
function toEngineWords (profile, request) {
  const maps = (profile && profile.maps) || {}
  if (request.reference_audio !== undefined) {
    if (request.ref_audio_path === undefined) request.ref_audio_path = request.reference_audio
    delete request.reference_audio
  }
  if (request.reference_text !== undefined) {
    const k = maps.reference_text
    if (k && request[k] === undefined) request[k] = request.reference_text
    delete request.reference_text
  }
  for (const k of Object.keys(request)) {
    if (request[k] === '' || request[k] === null) delete request[k]
  }
  return request
}

// 采样率从 wav 头读（lib/audio/wav.js）。不是 wav 就是 null，不拿响应头顶替。
function sampleRateOf (body, readFormat) {
  const fmt = readFormat(body)
  return fmt && Number.isInteger(fmt.sampleRate) && fmt.sampleRate > 0 ? fmt.sampleRate : null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 这次试运行用哪几个根。
 *   engine：引擎所在 checkout 的根（读，wizardRoot.engineRoot）
 *   write：写根（本机记录、profile_json、日志）
 * opts.rootDir 显式给了就当引擎根（测试与旧调用方用）。
 */
function rootsFor (id, opts = {}) {
  const rootOpts = opts.rootOpts || {}
  const engine = opts.rootDir || wizardRoot.engineRoot(id, rootOpts)
  const write = opts.writeRoot || wizardRoot.writeRoot(rootOpts) || engine
  return { engine, write, enginesDir: path.join(engine, 'engines') }
}

/**
 * 真起一次引擎并量。返回读数，不落盘（落盘是 measureAndPersist 的事）。
 *
 * @param {string} id
 * @param {object} opts
 * @param {object} opts.request   合成请求体（平台的词或引擎方言：text、reference_audio、call_time 参数）
 * @param {number} [opts.readyBudgetMs]  最长等多久就绪
 * @param {number} [opts.synthBudgetMs]  单段最长等多久
 * @param {(stage:string)=>void} [opts.onStage]  进到哪一段：'starting'（起进程、等就绪）/ 'synth'（合成中）
 * @param {AbortSignal} [opts.signal]  中止：停止等待、断开请求、收掉进程
 * @param {object} [opts.rootOpts]  交给 wizardRoot 的 { from, env }
 * @param {object} [opts.deps]  注入：{ resolveProfile, buildLaunchPlan, spawnFromPlan, probeOnce, post, now, readWavFormat }
 */
async function measureEngine (id, opts = {}) {
  const deps = opts.deps || {}
  const now = deps.now || (() => Date.now())
  const roots = rootsFor(id, opts)
  const resolveProfile = deps.resolveProfile
    || ((i) => platform('lib/engines/profile.js').resolveEngineProfile(i, process.env,
      { enginesDir: roots.enginesDir, localRoot: roots.write }))
  const buildLaunchPlan = deps.buildLaunchPlan || platform('lib/engines/launchPlan.js').buildLaunchPlan
  const spawnFromPlan = deps.spawnFromPlan || platform('lib/engines/spawnEngine.js').spawnFromPlan
  const probeOnce = deps.probeOnce || platform('lib/engines/spawnEngine.js').probeOnce
  const post = deps.post || postJson
  const readWavFormat = deps.readWavFormat || platform('lib/audio/wav.js').readWavFormatFromBuffer
  const onStage = typeof opts.onStage === 'function' ? opts.onStage : () => {}
  const signal = opts.signal || null
  const aborted = () => !!(signal && signal.aborted)

  const request = { ...(opts.request || {}) }
  if (!request.text || !String(request.text).trim()) {
    return { ok: false, stage: 'spec', error: '试运行要一段文本（request.text）' }
  }

  let profile
  try { profile = resolveProfile(id) } catch (e) {
    return { ok: false, stage: 'profile', error: `平台解析不出 ${id} 的名片：${e.message}` }
  }
  if (!profile.runtime) {
    return { ok: false, stage: 'profile', error: '名片没有 runtime 段，平台不负责起它，量不了冷启动' }
  }
  toEngineWords(profile, request)

  const logDir = path.join(roots.write, 'logs')
  let plan
  try {
    const port = profile.default_base_url ? undefined : (opts.port || await freePort())
    plan = buildLaunchPlan(profile, {
      rootDir: roots.engine,
      port,
      // 宿主要读的那份解析结果写在写根下：rootDir 是引擎所在的根，可能是主仓库。
      profileJsonPath: path.join(roots.write, 'cache', 'engines', `${id}.profile.json`),
    })
  } catch (e) {
    return { ok: false, stage: 'plan', error: e.message, code: e.code }
  }
  if (!plan.launchable) return { ok: false, stage: 'plan', error: plan.reason }

  const readyBudgetMs = opts.readyBudgetMs || BUDGET.readyMs
  const synthBudgetMs = opts.synthBudgetMs || BUDGET.synthMs
  const text = textOfLength(request.text, profile.max_chars)

  const out = { ok: false, id, base_url: plan.base_url, chars: text.length, text,
    engine_root: roots.engine }
  const cancelled = (stage) => ({ ...out, stage, cancelled: true, error: '试运行已中止' })
  let child = null
  const t0 = now()
  try {
    onStage('starting')
    child = spawnFromPlan(plan, { rootDir: roots.engine, logDir,
      enginesDir: roots.enginesDir, localRoot: roots.write })
    let exited = null
    if (child && typeof child.on === 'function') child.on('exit', (code) => { exited = code })

    // ---- 1. 冷启动到就绪 ----
    let ready = false
    while (now() - t0 < readyBudgetMs) {
      if (aborted()) return cancelled('ready')
      const r = await probeOnce(plan.ready_url, 2000)
      if (r instanceof Error && r.engineFailed) {
        return { ...out, stage: 'ready', error: '宿主报加载失败', detail: r.detail }
      }
      if (r === true) { ready = true; break }
      if (exited !== null) {
        return { ...out, stage: 'ready',
          error: `引擎进程启动后退出了（code=${exited}），看 ${path.join(logDir, `${id}.err.log`)}` }
      }
      await sleep(opts.pollMs === undefined ? 1000 : opts.pollMs)
    }
    if (aborted()) return cancelled('ready')
    out.readyMs = now() - t0
    if (!ready) return { ...out, stage: 'ready', error: `等了 ${readyBudgetMs}ms 仍未就绪` }

    // ---- 2. 合成一段 max_chars 那么长的 ----
    onStage('synth')
    const t1 = now()
    const r = await post(plan.base_url + '/tts', { ...request, text }, synthBudgetMs, signal)
    if (aborted()) return cancelled('synth')
    out.synthMs = now() - t1
    if (r.status !== 200) {
      const msg = r.body ? r.body.toString('utf8').slice(0, 1500) : (r.error || '')
      return { ...out, stage: 'synth', error: `合成返回 ${r.status}`, detail: msg }
    }
    out.synthOk = true
    out.wavBytes = r.body ? r.body.length : 0
    out.sampleRate = sampleRateOf(r.body, readWavFormat)
    if (out.sampleRate === null) out.note = '返回的不是可读的 wav 头，读不出采样率'
    out.ok = true
    return out
  } catch (e) {
    return { ...out, stage: 'spawn', error: String((e && e.message) || e) }
  } finally {
    try { if (child && child.killTree) await child.killTree(); else if (child) child.kill() } catch { /* 已经退了 */ }
  }
}

/**
 * 试运行并落盘：measureEngine → deriveValues → 本机记录（整份覆盖）。名片一个字都不动。
 * 就绪量到了、合成失败 ⇒ 只记就绪那一项（量到什么记什么），单段超时退回名片或平台默认。
 * 一项都未量到 ⇒ 不碰旧记录：一次起不来不该抹掉上一次量到的数。
 */
async function measureAndPersist (id, opts = {}) {
  const { readManifestById } = require('./save')
  const cur = readManifestById(id, opts.rootOpts || {})
  if (!cur.ok) return { ok: false, stage: 'read', error: cur.error }
  const m = await (opts.measure || measureEngine)(id, opts)
  const values = deriveValues(m || {})
  if (!Object.keys(values).length) {
    return { ok: false, measurement: m, values, error: (m && m.error) || '什么都未量到' }
  }
  const roots = rootsFor(id, opts)
  const { writeTimings } = platform('lib/engines/localTimings.js')
  const saved = writeTimings(roots.write, id, values, {
    readings: { readyMs: m.readyMs, synthMs: m.synthOk ? m.synthMs : null, chars: m.chars,
      sampleRate: m.sampleRate === undefined ? null : m.sampleRate },
  })
  if (!saved.ok) return { ok: false, measurement: m, values, error: saved.error }
  return { ok: m.ok === true, measurement: m, values, path: saved.path,
    error: m.ok ? undefined : m.error }
}

module.exports = {
  MARGIN, BUDGET, deriveValues, textOfLength, rootsFor,
  measureEngine, measureAndPersist, toEngineWords,
}
