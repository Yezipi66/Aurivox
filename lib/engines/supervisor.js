'use strict'

// 引擎进程的看管人：按需启动、不用就放、换模型就带着新的重开。
// 归这里：什么时候起、什么时候停、起完等它上线、装的是不是要的那一份。
// 不归这里：端口怎么定（那套逻辑留在启动脚本里）；也不归排队（平台已有一把全局
// 合成锁，ensure() 只在锁里被调用）。
// 依赖全部注入 ⇒ 这个文件可以在一台没有引擎、没有 Python、没有网络的机器上测穷。

const {
  DEFAULT_CAP, DEFAULT_IDLE_MS, MAX_LAUNCH_SLOTS, autoCapFor,
  isOnDemand, startupKeyOf, planAdmission, planSweep, launchSlots,
} = require('./residency')

// 暂定值：调用方没说用户确认过没有的时候，当成确认过（放行）。
// 理由：下游 OpenAI 兼容口发的是标准 POST /v1/audio/speech：body 里塞不进
// confirm 字段（塞了才叫破坏兼容），那头也没有界面能弹框，甚至可能没有人。
// 翻成 false 就是「没人可问时拒绝」，代价是一个标准请求被以一个 OpenAI 协议里
// 根本不存在的理由拒掉。
// 不许做成环境变量：变量意味着「这是给用户调的」，而这是我们自己还没想明白。
// 也不许因为它今天是 true 就把 needs_confirm 那一支删掉。
const ASSUME_CONFIRMED_WHEN_NOBODY_TO_ASK = true

/** 起不来 / 等不到上线时抛这个，带 code 方便上层分类。   */
function supErr(code, message, details = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, details)
  return e
}

function intFromEnv(env, name, fallback) {
  const raw = env && env[name]
  if (raw == null || String(raw).trim() === '') return fallback
  const n = parseInt(String(raw), 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

class EngineSupervisor {
  /**
   * deps 全部注入：spawn / probe / buildPlan / loadProfile / now / sleep / log / env，
   * 外加 mem（{ sampleTree(pid), freeMb() }）与 ledger（{ needMb(id), record(id, mb),
   * markAttempting(id), reapAttempts() }）。
   * mem / ledger 必须注入，不许在文件顶上直接 require：直接 require 的话，那些测试会
   * 真读真写用户的 state\ 目录。两个都不给 ⇒ 内存判据整个不生效。
   */
  constructor(deps = {}) {
    this.spawn = deps.spawn
    this.probe = deps.probe
    this.buildPlan = deps.buildPlan
    this.loadProfile = deps.loadProfile
    this.now = deps.now || (() => Date.now())
    this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.log = deps.log || (() => {})
    this.mem = deps.mem || null
    this.ledger = deps.ledger || null
    // 见文件顶上那段。 不从 env 读：它不是给用户调的。
    this.assumeConfirmed = deps.assumeConfirmed === undefined
      ? ASSUME_CONFIRMED_WHEN_NOBODY_TO_ASK
      : !!deps.assumeConfirmed
    const env = deps.env || {}
    // 这两个数不进名片：契约 §5.6 说超时/排队这一类是平台的事。
    // cap 的来源三段：AURIVOX_ENGINE_CAP 显式设的（永不覆盖）→ 按机器总内存自动算
    // （每 8G 多养一台）→ 量不到总内存则用 DEFAULT_CAP(=2)。
    const envCap = intFromEnv(env, 'AURIVOX_ENGINE_CAP', null)
    let totalMb = null
    try { totalMb = this.mem && typeof this.mem.totalMb === 'function' ? this.mem.totalMb() : null }
    catch (err) { this.log(`[engine] 无法读取总内存，cap 退回默认：${(err && err.message) || err}`) }
    this.totalMb = totalMb
    this.capAuto = autoCapFor(totalMb)
    this.cap = envCap !== null ? envCap : this.capAuto
    this.capSource = envCap !== null ? 'env' : (Number.isFinite(totalMb) ? 'auto' : 'default')
    this.idleMs = intFromEnv(env, 'AURIVOX_ENGINE_IDLE_MS', DEFAULT_IDLE_MS)
    // 轮询间隔。 不是超时预算：预算来自名片的 ready_timeout_ms。
    this.pollMs = intFromEnv(env, 'AURIVOX_ENGINE_POLL_MS', 1000)

    /** id -> { id, proc, key, lastUsedAt, onDemand, startedAt, label }   */
    this.residents = new Map()
    /** 上一次「正在做什么」，给界面看。id -> {phase, since, detail}   */
    this.progress = new Map()
  }

  // -- 只读视图 -------------------------------------------------------------

  _snapshot() {
    return Array.from(this.residents.values()).map((r) => ({
      id: r.id, key: r.key, busy: !!r.busy,
      lastUsedAt: r.lastUsedAt, onDemand: r.onDemand,
    }))
  }

  /** 给 /api/engines 和界面用：现在哪些在运行、在做什么。   */
  status() {
    const out = {}
    for (const r of this.residents.values()) {
      out[r.id] = {
        running: true,
        pid: r.proc && r.proc.pid != null ? r.proc.pid : null,
        started_at: r.startedAt,
        last_used_at: r.lastUsedAt,
        on_demand: r.onDemand,
        busy: !!r.busy,
        // 这个进程现在装的是哪一份模型。界面靠它回答「我选的那个到底生效了没有」。
        // null = 这台引擎没有开进程时吃进去的模型位（装什么都一样）。
        launch_key: r.key == null ? null : r.key,
      }
    }
    for (const [id, p] of this.progress.entries()) {
      out[id] = Object.assign({ running: false }, out[id], { phase: p.phase, phase_since: p.since, detail: p.detail })
    }
    return out
  }

  /**
   * 「平台此刻占了你的什么」。放在这里而不是 route 层：occupancy 需要 mem / ledger /
   * cap / status 四样东西，只有这个对象四样都有。
   */
  occupancy(profiles) {
    // 注入进来的 this.ledger 是一薄层闭包，它不会返回整本账。所以这里不能指望
    // `this.ledger.load()`：那个方法不存在，而 `typeof undefined === 'function'`
    // 为假 ⇒ 静默跳过 ⇒ 所有 peak_mb 都是 null ⇒ 「从未测量过」。
    // 解法：问闭包要「这一台量过没有」，而不是要整本账。
    let attempting = null
    if (this.ledger && typeof this.ledger.crashesOf === 'function') {
      try { attempting = this.ledger.attemptingIds ? this.ledger.attemptingIds() : null }
      catch (_) { attempting = null }
    }
    const { occupancyReport } = require('./occupancy')
    return occupancyReport({
      profiles: profiles || [],
      status: this.status(),
      // 逐台问「你量过多少」。needMb 返回 null = 从未测量，正是 occupancy 里
      // peak_mb=null 的含义：两者语义天然一致。
      needMbOf: this.ledger && typeof this.ledger.needMb === 'function'
        ? (id) => this.ledger.needMb(id) : null,
      attempting,
      mem: this.mem,
      cap: this.cap,
      capSource: this.capSource,
    })
  }

  _setPhase(id, phase, detail) {
    if (phase === null) this.progress.delete(id)
    else this.progress.set(id, { phase, since: this.now(), detail: detail || '' })
  }

  // -- 内存 -----------------------------------------------------------------

  /**
   * 喂给 planAdmission 的那两个数。任何一样拿不到就整个不给：半份判据比没有判据更坏
   * （只有 needMb 没有 freeMb 会让判据静悄悄地不生效，日志上察觉不到）。
   */
  _memState(id) {
    if (!this.mem || !this.ledger) return {}
    let freeMb = null
    let needMb = null
    try {
      freeMb = this.mem.freeMb()
    } catch (err) {
      this.log(`[engine] 无法读取剩余内存，这次不做内存判断：${(err && err.message) || err}`)
      return {}
    }
    try {
      needMb = this.ledger.needMb(id)
    } catch (err) {
      this.log(`[engine] 无法读取 ${id} 的内存账，视为未测量：${(err && err.message) || err}`)
      needMb = null
    }
    if (!Number.isFinite(freeMb)) return {}
    return { freeMb, needMb }
  }

  /**
   * 趁进程还活着，把它这一趟最多吃过多少记下来。时机是「还活着的最后一刻」：合成刚
   * 执行完、或者马上要 kill 它。不需要采样器：操作系统一直在记峰值。
   * 进程已经没了 ⇒ 整笔丢掉，绝不写 0：写 0 等于声称这台引擎不吃内存。
   */
  _recordMem(id, why = '') {
    if (!this.mem || !this.ledger) return null
    const r = this.residents.get(id)
    const pid = r && r.proc && r.proc.pid != null ? r.proc.pid : null
    if (pid == null) return null
    let s
    try {
      s = this.mem.sampleTree(pid)
    } catch (err) {
      this.log(`[engine] 量 ${id} 的内存时出了点事，这笔不记：${(err && err.message) || err}`)
      return null
    }
    if (!s || !s.ok || !Number.isFinite(s.peakMb) || s.peakMb <= 0) return null
    try {
      this.ledger.record(id, s.peakMb)
    } catch (err) {
      this.log(`[engine] ${id} 的内存账写不进去，忽略：${(err && err.message) || err}`)
      return null
    }
    this.log(`[engine] 记下 ${id} 最多占用 ${s.peakMb} MB`
      + `（${s.count} 个进程${s.peakExact ? '' : '， 这台系统只给得出当前值'}）`
      + (why ? `（${why}）` : ''))
    return s
  }

  /**
   * 开机时结上一轮的账：还挂着「正在试」的，都是未正常退出的（被 OOM 打死的进程来
   * 不及让我们读峰值，这是它唯一会留下的痕迹）。
   */
  reapCrashes() {
    if (!this.ledger || typeof this.ledger.reapAttempts !== 'function') return []
    let ids = []
    try {
      ids = this.ledger.reapAttempts() || []
    } catch (err) {
      this.log(`[engine] 结上一轮的内存账时出了点事，忽略：${(err && err.message) || err}`)
      return []
    }
    for (const id of ids) {
      this.log(`[engine]  ${id} 上次启动未正常退出（可能是内存不够被系统杀了）`)
    }
    return ids
  }

  // -- 起 / 停 --------------------------------------------------------------

  /**
   * 关掉一台。 幂等：未运行就什么都不做。
   * 不等它真的死透：等不到的话（进程卡在 CUDA 里）会把调用方一起挂住，而调用方是那把
   * 全局合成锁的持有者 ⇒ 整个服务停摆。宁可放掉引用。
   */
  stop(id, why = '') {
    const r = this.residents.get(id)
    if (!r) return false
    // 这是这个进程活着的最后一刻：峰值只能现在读。
    // kill 之后再读拿到的是 ok:false，那一整段的教训就白丢了。
    this._recordMem(id, '关掉之前最后量一次')
    this.residents.delete(id)
    this._setPhase(id, null)
    try {
      if (r.proc && typeof r.proc.killTree === 'function') r.proc.killTree()
      else if (r.proc && typeof r.proc.kill === 'function') r.proc.kill()
    } catch (err) {
      this.log(`[engine] 关 ${id} 时出了点事，忽略：${(err && err.message) || err}`)
    }
    this.log(`[engine] 放掉 ${id}${why ? `（${why}）` : ''}`)
    return true
  }

  /**
   * 全部关掉。why 记进日志；exiting = true 表示进程正在退出，只能同步。
   * `exiting` 是参数而不是从 `why` 里推断出来的字符串：唯一的调用方传的是「后端退出」，
   * 而默认值是 'shutting down'，拿 why 去判退出恒为 false。
   */
  stopAll(why = 'shutting down', exiting = false) {
    // 退出路径上只能同步：process.on('exit') 里没有事件循环再跑一轮，异步的
    // taskkill 会在完成前被掐掉 ⇒ 引擎被留在身后。
    for (const id of Array.from(this.residents.keys())) {
      if (exiting) {
        const r = this.residents.get(id)
        // 退出路径上不记账：_recordMem 要扫一遍全机器进程表，而后端正在退出。
        // 这笔账丢了也不要紧：下次这台引擎起来时 _launchAndWait 结尾会无条件记。
        this.residents.delete(id)
        this._setPhase(id, null)
        try {
          if (r.proc && typeof r.proc.killTreeSync === 'function') r.proc.killTreeSync()
          else if (r.proc && typeof r.proc.kill === 'function') r.proc.kill()
        } catch { /* 退出路径上不许再抛 */ }
      } else {
        this.stop(id, why)
      }
    }
  }

  /**
   * 定时清扫：把空闲够久的按需引擎放掉。与「有人来抢名额」无关：内存该吐就吐。
   */
  sweep() {
    const doomed = planSweep(this._snapshot(), { now: this.now(), idleMs: this.idleMs })
    for (const id of doomed) this.stop(id, `空闲超过 ${Math.round(this.idleMs / 1000)} 秒`)
    return doomed
  }

  /**
   * 保证这台引擎在运行，而且装的就是这一次要的那一份模型。合成路径在全局合成锁内调
   * 它一次。selection 是 { <位名>: <选中的路径> }，平台级的键，不进引擎请求体。
   */
  async ensure(profile, selection, opts = {}) {
    if (!profile || !profile.id) throw supErr('ENGINE_UNKNOWN', '没说要用哪台引擎')
    const id = profile.id

    // 名片没写 runtime = 这台引擎由作者自己起。平台起不了它，也不该假装起了。
    // 这是合法状态，不是错误：直接放行，连不上会在那一层报「引擎没上线」。
    if (!profile.runtime) {
      return { action: 'not-ours', base_url: profile.base_url, waited_ms: 0 }
    }

    const slots = launchSlots(profile)
    if (slots.length > MAX_LAUNCH_SLOTS) {
      // 理由见 residency.js 的 MAX_LAUNCH_SLOTS：今天只有一个地方能送。
      throw supErr('ENGINE_TOO_MANY_LAUNCH_SLOTS',
        `引擎 ${id} 有 ${slots.length} 个「开进程那一步吃进去」的模型位（${slots.map(s => s.name).join(' / ')}）` +
        '平台今天只能送进去一个。多出来的那个如果放行，表现会是「选了不生效、不报错、声音不对」。' +
        '要支持多个，得先给它一条真正的送法，不是在这里放行。',
        { id, slots: slots.map((s) => s.name) })
    }

    const loadParams = opts.loadParams || {}
    const key = startupKeyOf(profile, selection, loadParams)
    const onDemand = isOnDemand(profile)
    // confirmed 由调用方说了算。没说的时候用那个暂定值（见文件顶上）：
    // 不许把「没说」当成「说了不同意」，否则每次合成都拒。
    const confirmed = opts.confirmed === undefined ? this.assumeConfirmed : !!opts.confirmed
    const plan = planAdmission({
      residents: this._snapshot(),
      id, key, onDemand, cap: this.cap, idleMs: this.idleMs, now: this.now(),
      ...this._memState(id),
      confirmed,
    })

    // 拒绝那一支必须在 evict 之前返回：一次注定失败的请求不该顺手关掉别人。
    if (plan.action === 'busy') {
      throw supErr('ENGINE_BUSY_OTHER_WEIGHT',
        `引擎 ${id} 正在执行另一次合成，而这一次要的是另一份「进程启动时载入」的模型。` +
        '换那一份得把进程重开一次：重开就等于把正在执行的那次截断（得到不完整音频，或者一句引擎原话报错）。' +
        '请等它执行完再试。',
        { id, key, busy_key: (this.residents.get(id) || {}).key || null })
    }

    // 内存那两支跟 busy 同一条规则：拒绝时不为这次请求腾地方。
    // 为一次注定失败的请求顺手关掉别人 = 副作用发生了、请求还是失败了。
    if (plan.action === 'needs_confirm') {
      // 到这里只有一种可能：调用方显式传了 confirmed:false。抛的这个错是给「知道怎么问
      // 用户的那个调用方」接住去弹框的，不是给用户看的最终文案，数字放在 mem 里让它
      // 自己排版。这句里不许写「预计需要多少」：走到这一支的全部原因就是我们不知道。
      const m = plan.mem || {}
      const measured = Number.isFinite(m.needMb)
      const message = measured
        ? `启动引擎 ${id} 可能需要较多系统内存：历史峰值 ${m.needMb} MB，` +
          `加上余量预计约 ${m.wantMb} MB，当前可用 ${m.freeMb} MB。`
        : `平台还没有引擎 ${id} 的系统内存历史数据，当前可用 ${m.freeMb} MB。`
      throw supErr('ENGINE_MEMORY_CONFIRM_REQUIRED',
        message + '继续可能导致系统明显变慢、使用大量页面文件、引擎启动失败，' +
        '或相关进程被操作系统终止。是否仍要在本次请求中尝试启动？',
        { id, mem: m, can_continue: true, confirmation_scope: 'single_request' })
    }

    for (const victim of plan.evict) this.stop(victim, '给别的引擎腾地方 / 空闲太久')

    if (plan.action === 'reuse') {
      const r = this.residents.get(id)
      r.lastUsedAt = this.now()
      return { action: 'reuse', base_url: r.baseUrl, waited_ms: 0 }
    }

    if (plan.action === 'relaunch') {
      this.stop(id, '要换的这一份模型是开进程那一步吃进去的')
    }

    const t0 = this.now()
    const baseUrl = await this._launchAndWait(profile, selection, key, loadParams)
    return { action: plan.action, base_url: baseUrl, waited_ms: this.now() - t0 }
  }

  /**
   * 真的把它拉起来，然后等它上线。runtime.ready_endpoint / ready_timeout_ms
   * 在这里第一次有执行者。
   */
  async _launchAndWait(profile, selection, key, loadParams = {}) {
    const id = profile.id

    // launch 位选中的那一份怎么送进进程：重定向那台引擎的底模目录（名片 args /
    // init_args 里的 {checkpoints}）。一个 launch 位说的就是「这个进程要装哪一份模型」，
    // 而进程装哪一份，在名片上表达出来就是它的 checkpoints 指向哪儿 ⇒ 上游一行都不用
    // 改。没选（或没有 launch 位）⇒ 不覆盖。
    const slots = launchSlots(profile)
    const chosen = slots.length === 1 && selection ? selection[slots[0].name] : null
    const opts = { loadParams }
    if (chosen) opts.checkpointsOverride = String(chosen)

    // 端口：用启动脚本已经定下来的那个（它写进了 base_url_env）。
    let port
    try {
      port = Number(new URL(profile.base_url).port) || undefined
    } catch {
      port = undefined
    }
    if (port) opts.port = port

    this._setPhase(id, 'starting', '正在启动引擎')
    let plan
    try {
      plan = this.buildPlan(profile, opts)
    } catch (err) {
      this._setPhase(id, null)
      throw err
    }
    if (!plan || !plan.launchable) {
      this._setPhase(id, null)
      throw supErr('ENGINE_NOT_LAUNCHABLE',
        `引擎 ${id} 不由平台启动（manifest.json 没有 runtime 段）`, { id })
    }

    // 起之前先落一笔「正在试 id」。这是给崩掉那一次准备的：被系统杀掉的进程来不及
    // 让我们读峰值，下次开机看见这条还挂着，就知道「它上次未正常退出」。
    // 必须在 spawn 之前：spawn 之后才记的话，起一半就被杀的那次一点痕迹都不会留下。
    if (this.ledger && typeof this.ledger.markAttempting === 'function') {
      try {
        this.ledger.markAttempting(id)
      } catch (err) {
        this.log(`[engine] 记不下「正在试 ${id}」，继续起：${(err && err.message) || err}`)
      }
    }

    let proc
    try {
      proc = await this.spawn(plan)
    } catch (err) {
      this._setPhase(id, null)
      throw supErr('ENGINE_SPAWN_FAILED',
        `起不来引擎 ${id}：${(err && err.message) || err}`, { id, cause: err })
    }

    const rec = {
      id,
      label: profile.label || id,
      proc,
      key,
      baseUrl: plan.base_url,
      startedAt: this.now(),
      lastUsedAt: this.now(),
      onDemand: isOnDemand(profile),
      busy: false,
    }
    this.residents.set(id, rec)

    // 探活循环。预算来自名片：runtime.ready_timeout_ms。平台不替它定这个数：
    // 一台冷启动慢的引擎和一台 2 秒起来的引擎，用同一个预算必然坑一头。
    const budget = Number(plan.ready_timeout_ms) || 0
    this._setPhase(id, 'loading', `正在加载模型（这台引擎最多要 ${Math.round(budget / 1000)} 秒）`)
    const deadline = this.now() + budget
    let ok = false
    let lastErr = null
    for (;;) {
      // 先看进程还在不在。它自己崩了的话，再探满预算纯属浪费用户的时间，而且最后报
      // 出来的是「超时」，把人指向「机器太慢」，而真相是引擎启动时就抛异常退出了。
      if (proc && proc.exitCode != null) {
        this.residents.delete(id)
        this._setPhase(id, null)
        throw supErr('ENGINE_EXITED_EARLY',
          `引擎 ${id} 刚启动就退出了（退出码 ${proc.exitCode}）：请查看 logs\\${id}.err.log。`,
          { id, exitCode: proc.exitCode })
      }
      try {
        const r = await this.probe(plan.ready_url, this.pollMs)
        // probe 可能回 true / false / 一个带 engineFailed 的 Error：第三种是「引擎自己
        // 说加载已经失败了」（见 probeOnce：它读 /health 的 body 才拿得到）。不能当成
        // false 继续等：等到预算耗尽只会报「超时」。
        if (r instanceof Error && r.engineFailed) {
          this.stop(id, '加载失败')
          throw supErr('ENGINE_LOAD_FAILED',
            `引擎 ${id} 加载失败了（不是超时）：\n${r.message}\n` +
            `看 logs\\${id}.log 有完整 traceback。`,
            { id, ready_url: plan.ready_url, cause: r, detail: r.detail || null })
        }
        ok = r
      } catch (err) {
        // 别把刚构造的那个 ENGINE_LOAD_FAILED 再包一层：它已经说清了。
        if (err && err.code === 'ENGINE_LOAD_FAILED') throw err
        ok = false
        lastErr = err
      }
      if (ok) break
      if (this.now() >= deadline) break
      await this.sleep(this.pollMs)
    }

    if (!ok) {
      this.stop(id, '等不到它上线')
      throw supErr('ENGINE_READY_TIMEOUT',
        `引擎 ${id} 已启动，但 ${Math.round(budget / 1000)} 秒之内没有上线（探活地址 ${plan.ready_url}）。` +
        `这个预算是它自己在 manifest.json 里写的 ready_timeout_ms。看 logs\\${id}.log 找加载卡在哪。`,
        { id, ready_url: plan.ready_url, budget_ms: budget, cause: lastErr })
    }

    rec.lastUsedAt = this.now()
    this._setPhase(id, null)
    this.log(`[engine] ${id} 上线（用了 ${((this.now() - rec.startedAt) / 1000).toFixed(1)} 秒）`)
    // 上线这一刻就记一笔：模型已经装进内存了，这是一个真实观测到的数。record 会
    // 顺手把「正在试」那条销掉 ⇒ 一台已启动却从没被用过就被 sweep 掉的引擎，不会被
    // 误记成崩过。这个数偏小（还没推理过），不要紧：账本只涨不落。
    this._recordMem(id, '刚上线')
    return plan.base_url
  }

  /**
   * 合成开始/结束时标一下，免得正在忙的引擎被腾地方腾掉。
   * 「合成刚结束」是读峰值最好的时机，而这个方法已经在那个时机被调用了
   * （synthesisService.js 的 finally 里）⇒ 读峰值和记账关在本文件内部。
   * 不要为此新开一个 onSynthesisDone()：那会多出一个可以忘记调用的接线点，而忘了调
   * 的症状是「账本永远学不会」，没有任何报错。
   */
  markBusy(id, busy) {
    const r = this.residents.get(id)
    if (!r) return
    const wasBusy = !!r.busy
    r.busy = !!busy
    r.lastUsedAt = this.now()
    // 只在「忙 → 不忙」这个沿上量。 不在每次调用都量：markBusy(id,false) 可能被
    // 重复调，而每量一次就要问一次操作系统。
    if (wasBusy && !busy) this._recordMem(id, '合成刚执行完')
  }
}

module.exports = { EngineSupervisor }
