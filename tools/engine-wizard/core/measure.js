'use strict'
// 第 5 步「试跑」：真起一次引擎，量出冷启动到就绪、合成一段的耗时，按余量写回名片。
//
// 写回哪几项（平台有默认值、名片里可以不写的三项，见 lib/engines/profile.js 的 DEFAULTS）：
//   runtime.ready_timeout_ms   冷启动到 /health 就绪
//   timeout_ms                 合成一段（max_chars 那么长）的单请求耗时
//   max_chars                  试跑时真合成过这么长的一段，确认能用
// 写回的出处一律记 measured（lib/engines/profile/topkeys.js 的 MEASURED_SOURCES）。
//
// 不覆盖人写的值：出处是 estimated（向导「添加一项」时先记的，见 editor/optionalKeys.js 的
//   addItem）或者干脆没写（平台默认）才写回；出处是 measured / upstream 的一律保留。
//   measured 也不覆盖：盘上分不清它是上一次试跑写的还是人照量到的数抄的，宁可留着、在结果里说明。
//
// 引擎怎么起：照平台自己的启动计划（lib/engines/launchPlan.js + spawnEngine.js），
//   与合成服务按需起引擎走同一条路，量出来的才是平台上真实的冷启动。
//   副作用（起进程、探活、发请求）都可注入，纯函数部分不起进程就能测。

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')

const ROOT = path.join(__dirname, '..', '..', '..')
function platform (rel) { return require(path.join(ROOT, rel)) }

// [名片键路径, 出处键路径]
const MEASURED_FIELDS = Object.freeze([
  ['runtime.ready_timeout_ms', 'runtime.ready_timeout_ms_source'],
  ['timeout_ms', 'timeout_ms_source'],
  ['max_chars', 'max_chars_source'],
])

// 余量：CPU 机器上一次和下一次能差出一截（缓存冷热、别的进程抢核），按倍数 + 下限留。
//   就绪：2 倍，且至少多 30 秒；单段：3 倍，且至少多 60 秒。都向上取整到 10 秒。
const MARGIN = Object.freeze({
  ready: { factor: 2, minExtraMs: 30000 },
  synth: { factor: 3, minExtraMs: 60000 },
  roundMs: 10000,
})

function get (obj, keyPath) {
  return keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function setPath (obj, keyPath, value) {
  const keys = keyPath.split('.')
  const root = { ...(obj || {}) }
  let cur = root
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = { ...(cur[keys[i]] || {}) }
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
  return root
}

function roundUp (ms, step) {
  return Math.ceil(ms / step) * step
}

function withMargin (ms, m) {
  return roundUp(Math.max(ms * m.factor, ms + m.minExtraMs), MARGIN.roundMs)
}

/**
 * 这一项能不能被量到的值写回。
 * 值没写（平台默认）或者出处是 estimated ⇒ 能；出处缺了但值写了 ⇒ 平台本来就拒收这张名片，
 *   也当成没表态写回（带上出处它才合法）。其余（measured / upstream）⇒ 不能。
 */
function canOverwrite (manifest, key, srcKey) {
  const v = get(manifest, key)
  const src = get(manifest, srcKey)
  if (v === undefined || v === null) return true
  return src === undefined || src === null || src === 'estimated'
}

/**
 * 量到的读数 → 要写回的值。读数缺哪项就不给哪项（没量到的不编）。
 * @param {{readyMs?:number, synthMs?:number, chars?:number, synthOk?:boolean}} m
 */
function deriveValues (m) {
  const out = {}
  if (Number.isFinite(m.readyMs) && m.readyMs >= 0) {
    out['runtime.ready_timeout_ms'] = withMargin(m.readyMs, MARGIN.ready)
  }
  if (m.synthOk && Number.isFinite(m.synthMs) && m.synthMs >= 0) {
    out.timeout_ms = withMargin(m.synthMs, MARGIN.synth)
    if (Number.isInteger(m.chars) && m.chars > 0) out.max_chars = m.chars
  }
  return out
}

/**
 * 把量到的值写进名片（返回新对象，原对象不动）。
 * @returns {{manifest:object, written:Array, kept:Array}}
 */
function applyMeasurements (manifest, values) {
  let next = { ...(manifest || {}) }
  const written = []
  const kept = []
  for (const [key, srcKey] of MEASURED_FIELDS) {
    if (!(key in values)) continue
    const before = get(manifest, key)
    if (!canOverwrite(manifest, key, srcKey)) {
      kept.push({ key, value: before, source: get(manifest, srcKey), measured: values[key] })
      continue
    }
    next = setPath(next, key, values[key])
    next = setPath(next, srcKey, 'measured')
    written.push({ key, value: values[key], before: before === undefined ? null : before,
      beforeSource: get(manifest, srcKey) || null })
  }
  return { manifest: next, written, kept }
}

/**
 * 试跑用的文本：照用户给的文本凑到 n 个字符（不够就重复，超了就截），
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

function postJson (url, body, timeoutMs) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 真起一次引擎并量。返回读数，不写名片（写回是 persist 的事）。
 *
 * @param {string} id
 * @param {object} opts
 * @param {object} opts.request   合成请求体（引擎方言：text、ref_audio_path、call_time 参数）
 * @param {number} [opts.readyBudgetMs]  最长等多久就绪（量的是真实冷启动，不能被估计值卡住）
 * @param {number} [opts.synthBudgetMs]  单段最长等多久
 * @param {object} [opts.deps]  注入：{ resolveProfile, buildLaunchPlan, spawnFromPlan, probeOnce, post, now }
 */
async function measureEngine (id, opts = {}) {
  const deps = opts.deps || {}
  const now = deps.now || (() => Date.now())
  const resolveProfile = deps.resolveProfile
    || ((i) => platform('lib/engines/profile.js').resolveEngineProfile(i, process.env))
  const buildLaunchPlan = deps.buildLaunchPlan || platform('lib/engines/launchPlan.js').buildLaunchPlan
  const spawnFromPlan = deps.spawnFromPlan || platform('lib/engines/spawnEngine.js').spawnFromPlan
  const probeOnce = deps.probeOnce || platform('lib/engines/spawnEngine.js').probeOnce
  const post = deps.post || postJson

  const request = { ...(opts.request || {}) }
  if (!request.text || !String(request.text).trim()) {
    return { ok: false, stage: 'spec', error: '试跑要一段文本（request.text）' }
  }

  let profile
  try { profile = resolveProfile(id) } catch (e) {
    return { ok: false, stage: 'profile', error: `平台解析不出 ${id} 的名片：${e.message}` }
  }
  if (!profile.runtime) {
    return { ok: false, stage: 'profile', error: '名片没有 runtime 段，平台不负责起它，量不了冷启动' }
  }
  toEngineWords(profile, request)

  let plan
  try {
    const port = profile.default_base_url ? undefined : (opts.port || await freePort())
    plan = buildLaunchPlan(profile, { rootDir: opts.rootDir || ROOT, port })
  } catch (e) {
    return { ok: false, stage: 'plan', error: e.message, code: e.code }
  }
  if (!plan.launchable) return { ok: false, stage: 'plan', error: plan.reason }

  const readyBudgetMs = opts.readyBudgetMs || 15 * 60 * 1000
  const synthBudgetMs = opts.synthBudgetMs || 15 * 60 * 1000
  const chars = profile.max_chars
  const text = textOfLength(request.text, chars)

  const out = { ok: false, id, base_url: plan.base_url, chars: text.length, text }
  let child = null
  const t0 = now()
  try {
    child = spawnFromPlan(plan, { rootDir: opts.rootDir || ROOT })
    let exited = null
    if (child && typeof child.on === 'function') child.on('exit', (code) => { exited = code })

    // ---- 1. 冷启动到就绪 ----
    let ready = false
    while (now() - t0 < readyBudgetMs) {
      const r = await probeOnce(plan.ready_url, 2000)
      if (r instanceof Error && r.engineFailed) {
        return { ...out, stage: 'ready', error: '宿主报加载失败', detail: r.detail }
      }
      if (r === true) { ready = true; break }
      if (exited !== null) {
        return { ...out, stage: 'ready', error: `引擎进程启动后退出了（code=${exited}），看 logs/${id}.err.log` }
      }
      await sleep(opts.pollMs || 1000)
    }
    out.readyMs = now() - t0
    if (!ready) return { ...out, stage: 'ready', error: `等了 ${readyBudgetMs}ms 仍未就绪` }

    // ---- 2. 合成一段 max_chars 那么长的 ----
    const t1 = now()
    const r = await post(plan.base_url + '/tts', { ...request, text }, synthBudgetMs)
    out.synthMs = now() - t1
    if (r.status !== 200) {
      const msg = r.body ? r.body.toString('utf8').slice(0, 1500) : (r.error || '')
      return { ...out, stage: 'synth', error: `合成返回 ${r.status}`, detail: msg }
    }
    out.synthOk = true
    out.wavBytes = r.body ? r.body.length : 0
    out.sampleRate = Number((r.headers || {})['x-sample-rate']) || null
    out.ok = true
    return out
  } catch (e) {
    return { ...out, stage: 'spawn', error: String((e && e.message) || e) }
  } finally {
    try { if (child && child.killTree) await child.killTree(); else if (child) child.kill() } catch { /* 已经退了 */ }
  }
}

/**
 * 试跑并写回：measureEngine → deriveValues → applyMeasurements → saveManifest(overwrite)。
 * 名片读写走向导自己的 save.js（写只落本 checkout，见 wizardRoot.js）。
 * 就绪量到了、合成失败 ⇒ 只写就绪那一项（量到什么写什么）。
 */
async function measureAndPersist (id, opts = {}) {
  const { readManifestById, saveManifest } = require('./save')
  const cur = readManifestById(id)
  if (!cur.ok) return { ok: false, stage: 'read', error: cur.error }
  const m = await (opts.measure || measureEngine)(id, opts)
  const values = deriveValues(m)
  if (!Object.keys(values).length) {
    return { ok: false, measurement: m, written: [], kept: [], error: m.error || '什么都没量到' }
  }
  const { manifest, written, kept } = applyMeasurements(cur.manifest, values)
  let saved = null
  if (written.length) {
    saved = saveManifest(manifest, { overwrite: true })
    if (!saved.ok) return { ok: false, measurement: m, written, kept, error: saved.error }
  }
  return { ok: m.ok === true, measurement: m, values, written, kept,
    path: saved ? saved.path : cur.path, error: m.ok ? undefined : m.error }
}

module.exports = {
  MEASURED_FIELDS, MARGIN, canOverwrite, deriveValues, applyMeasurements, textOfLength,
  measureEngine, measureAndPersist, toEngineWords,
}
