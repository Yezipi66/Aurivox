'use strict'

// ---------------------------------------------------------------------------
//  引擎进程的看管人 —— 用到才起、不用就放、换模型就带着新的重开
// ---------------------------------------------------------------------------
//
// ⭐⭐⭐ 这个文件是契约 §9 里那句悬空引用的落点。§9 写着：
//
//    「这一档的账不是『某个数填多少』，是**探活循环没建**。
//      它归 §12 的进程管理那一步。」
//
//    —— 而 §12 从头到尾只有 0/1/2/3/4 五步，**根本没有"进程管理"那一步**。
//    引用悬了很久，因为那一步一直没人做。这一刀补上它。
//
// ── 在它之前是什么样 ───────────────────────────────────────────────────
//
//  1. 启动脚本把 engines\ 下装了的**每一台**都点着。其中一台开进程那一刻
//     就吃掉约 6G 内存。装到第四台，开机就是四份内存一起吃。
//  2. runtime.ready_endpoint / ready_timeout_ms（180000）**只被打印**：
//     启动脚本打一句「探活 …，预算 180 秒」然后直接退出，没有任何人去轮询。
//  3. launch 位的模型**换不了**：平台换模型只有一条路 —— 对活着的进程发一个
//     「换权重」请求。模型是开进程那一刻吃进去的引擎不吃这一套 ⇒ 界面上
//     选了不生效，而且**不报错**。
//
// ── 边界：什么归这里，什么不归 ─────────────────────────────────────────
//
//  ✅ 归这里：什么时候起、什么时候停、起完等它上线、装的是不是要的那一份。
//  ⛔ 不归这里：**端口怎么定**。那 90 行 Windows 端口逻辑
//     （Test-Port / Get-ListenerPid / Resolve-Port / Test-IsOwnProcess）
//     仍然全部留在启动脚本里，一行不动 —— 契约明写「不要因为跨平台方向
//     就回头重写那 90 行」。它们是被真机 bug 打磨出来的：只认 LISTENING
//     不认 TIME_WAIT、Get-NetTCPConnection 不可用时退回解析 netstat、
//     能区分「我上次留下的」和「别人占了」。这台机器是 Linux，验不了。
//
//     ⇒ 分工：**启动脚本定端口，本文件管起停。** 脚本把定下来的地址写进
//       每台引擎自己的 base_url_env 变量，后端从环境变量继承 ⇒ 本文件
//       spawn 的时候用的就是脚本定下来的那个端口，两边不会打架。
//
//  ⛔ 不归这里：**排队**。契约 §5.6 写明并发由平台排队，而平台已经有一把
//     全局合成锁（server.js 的 withGenerationLock）。本文件的 ensure() 只在
//     那把锁里被调用 ⇒ 同一时刻只有一个请求在决定「要不要重开」。
//     ⭐ 这也正好满足 §5.2.1 `scope: "locked"` 的要求：播种和换模型在同一把锁内。
//
// ── 依赖全部注入 ───────────────────────────────────────────────────────
//
// spawn / http / 时钟 / 日志都从构造函数进来。⇒ 这个文件可以在一台没有引擎、
// 没有 Python、甚至没有网络的机器上被测穷。⛔ 真机专有的失败模式不该只在
// 真机上才第一次被发现。

const {
  DEFAULT_CAP, DEFAULT_IDLE_MS, MAX_LAUNCH_SLOTS,
  isOnDemand, launchKeyOf, planAdmission, planSweep, launchSlots,
} = require('./residency')

// ---------------------------------------------------------------------------
//  ⛔ 暂定 A —— 这不是"想清楚了才这么定的"
// ---------------------------------------------------------------------------
//
//  调用方**没说**用户确认过没有的时候，当成确认过（放行）。
//
//  真正的问题是：**一个必须有人回答的问题，那条路上没有人。**
//  下游 OpenAI 兼容口发的是标准 POST /v1/audio/speech —— body 里塞不进
//  confirm 字段（塞了才叫破坏兼容），那头也没有界面能弹框，甚至可能没有人。
//
//  翻成 false 就是 B：没人可问时拒绝。⚠ B 的代价是一个标准请求被以一个
//  OpenAI 协议里根本不存在的理由拒掉 —— **那才是真会让人说"你们不兼容"的
//  那一个**。
//
//  ⛔ 不许把它做成环境变量。变量意味着"这是给用户调的"，而这是我们自己
//    还没想明白，用户答不了。
//  ⛔ 也不许因为它今天是 true 就把 needs_confirm 那一支删掉 —— 显式传
//    confirmed:false 的调用方（将来那个引擎管理页面）要靠它。
const ASSUME_CONFIRMED_WHEN_NOBODY_TO_ASK = true

/** 起不来 / 等不到上线时抛这个，带 code 方便上层分类。 */
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
   * @param deps {
   *   spawn:      (plan) => ({ pid, kill() })   真正把进程拉起来
   *   probe:      (url, timeoutMs) => Promise<boolean>  探活一次
   *   buildPlan:  (profile, opts) => plan       launchPlan.buildLaunchPlan
   *   loadProfile:(id) => profile               resolveEngineProfile
   *   now:        () => number
   *   sleep:      (ms) => Promise<void>
   *   log:        (line) => void
   *   env:        process.env
   *
   *   mem:        memprobe 那样的东西 { sampleTree(pid), freeMb() }
   *   ledger:     memledger 绑好 rootDir 之后的样子
   *               { needMb(id), record(id, mb), markAttempting(id), reapAttempts() }
   * }
   *
   * ⭐⭐ mem / ledger **必须注入，⛔ 不许在文件顶上直接 require**。
   *   直接 require 的话，本文件那 26 条测试会开始真读真写用户的 state\ 目录，
   *   而且会在假 pid 上真的去问操作系统 —— 一个纯逻辑的测试会因为
   *   "这台机器上没有这个进程" 而红。
   * ⚠ 两个都不给 ⇒ 内存判据整个不生效（老部署、测试夹具走这条）。
   *   ⛔ 不抛：一个纯粹的接线缺失不该表现成「合成失败」。
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
    // 见文件顶上那段。⛔ 不从 env 读 —— 它不是给用户调的。
    this.assumeConfirmed = deps.assumeConfirmed === undefined
      ? ASSUME_CONFIRMED_WHEN_NOBODY_TO_ASK
      : !!deps.assumeConfirmed
    const env = deps.env || {}
    // ⛔ 这两个数**不进名片**：契约 §5.6 说超时/排队这一类是平台的事。
    this.cap = intFromEnv(env, 'AURIVOX_ENGINE_CAP', DEFAULT_CAP)
    this.idleMs = intFromEnv(env, 'AURIVOX_ENGINE_IDLE_MS', DEFAULT_IDLE_MS)
    // 轮询间隔。⚠ 不是超时预算 —— 预算来自名片的 ready_timeout_ms。
    this.pollMs = intFromEnv(env, 'AURIVOX_ENGINE_POLL_MS', 1000)

    /** id -> { id, proc, key, lastUsedAt, onDemand, startedAt, label } */
    this.residents = new Map()
    /** 上一次「正在做什么」，给界面看。id -> {phase, since, detail} */
    this.progress = new Map()
  }

  // -- 只读视图 -------------------------------------------------------------

  _snapshot() {
    return Array.from(this.residents.values()).map((r) => ({
      id: r.id, key: r.key, busy: !!r.busy,
      lastUsedAt: r.lastUsedAt, onDemand: r.onDemand,
    }))
  }

  /** 给 /api/engines 和界面用：现在谁在跑、在干什么。 */
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
        // ⭐ 这个进程现在装的是**哪一份**模型。界面靠它回答「我选的那个到底
        //   生效了没有」—— 在这一行之前，那个问题只能靠听声音回答。
        //   null = 这台引擎没有开进程时吃进去的模型位（装什么都一样）。
        launch_key: r.key == null ? null : r.key,
      }
    }
    for (const [id, p] of this.progress.entries()) {
      out[id] = Object.assign({ running: false }, out[id], { phase: p.phase, phase_since: p.since, detail: p.detail })
    }
    return out
  }

  _setPhase(id, phase, detail) {
    if (phase === null) this.progress.delete(id)
    else this.progress.set(id, { phase, since: this.now(), detail: detail || '' })
  }

  // -- 内存 -----------------------------------------------------------------

  /**
   * 喂给 planAdmission 的那两个数。
   *
   * ⛔ 任何一样拿不到就整个不给 —— **半份判据比没有判据更坏**：
   *   只有 freeMb 没有 needMb 会走成 needs_confirm（对的），
   *   但只有 needMb 没有 freeMb 会让判据静悄悄地不生效，而日志上看不出来。
   * ⛔ 这里不抛。量不到内存是遗憾，起不了引擎是故障。
   */
  _memState(id) {
    if (!this.mem || !this.ledger) return {}
    let freeMb = null
    let needMb = null
    try {
      freeMb = this.mem.freeMb()
    } catch (err) {
      this.log(`[engine] 读不到剩余内存，这次不做内存判断：${(err && err.message) || err}`)
      return {}
    }
    try {
      needMb = this.ledger.needMb(id)
    } catch (err) {
      this.log(`[engine] 读不到 ${id} 的内存账，当成没量过：${(err && err.message) || err}`)
      needMb = null
    }
    if (!Number.isFinite(freeMb)) return {}
    return { freeMb, needMb }
  }

  /**
   * 趁进程还活着，把它这一趟最多吃过多少记下来。
   *
   * ⭐⭐⭐ 时机就是「**还活着的最后一刻**」：合成刚跑完、或者马上要 kill 它。
   *   ⛔ 不需要采样器 —— 操作系统一直在记峰值，事后读拿到的是整段的最高点。
   *   （真机验过：推理跑完之后读，三次读数恒 3547.0 一动没动。）
   * ⛔ 进程已经没了 ⇒ sampleTree 返回 ok:false ⇒ **整笔丢掉，绝不写 0**。
   *   写 0 等于声称这台引擎不吃内存 —— 那是账本里最危险的一条记录。
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
    this.log(`[engine] 记下 ${id} 最多吃到 ${s.peakMb} MB`
      + `（${s.count} 个进程${s.peakExact ? '' : '，⚠ 这台系统只给得出当前值'}）`
      + `${why ? `（${why}）` : ''}`)
    return s
  }

  /**
   * 开机时结上一轮的账：还挂着「正在试」的，都是没活着回来的。
   * ⭐ 被 OOM 打死的进程来不及让我们读峰值 —— 这是它唯一会留下的痕迹。
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
      this.log(`[engine] ⚠ ${id} 上次启动没活着回来（可能是内存不够被系统杀了）`)
    }
    return ids
  }

  // -- 起 / 停 --------------------------------------------------------------

  /**
   * 关掉一台。⚠ 幂等：没在跑就什么都不做。
   *
   * ⛔ 不等它真的死透 —— 等不到的话（进程卡在 CUDA 里）会把调用方一起挂住，
   *   而调用方是那把全局合成锁的持有者 ⇒ 整个服务停摆。宁可放掉引用，
   *   端口那一侧本来就有「这是不是我上次留下的」这套判断兜着。
   */
  stop(id, why = '') {
    const r = this.residents.get(id)
    if (!r) return false
    // ⭐ 这是这个进程活着的最后一刻 —— 峰值只能现在读。
    //   kill 之后再读拿到的是 ok:false，那一整段的教训就白丢了。
    this._recordMem(id, '关掉之前最后量一次')
    this.residents.delete(id)
    this._setPhase(id, null)
    try {
      if (r.proc && typeof r.proc.kill === 'function') r.proc.kill()
    } catch (err) {
      this.log(`[engine] 关 ${id} 时出了点事，忽略：${(err && err.message) || err}`)
    }
    this.log(`[engine] 放掉 ${id}${why ? `（${why}）` : ''}`)
    return true
  }

  /** 全部关掉。进程退出时调用。 */
  stopAll(why = 'shutting down') {
    for (const id of Array.from(this.residents.keys())) this.stop(id, why)
  }

  /**
   * 定时清扫：把空闲够久的按需引擎放掉。
   * ⭐ 与「有人来抢名额」无关 —— 内存该吐就吐。
   */
  sweep() {
    const doomed = planSweep(this._snapshot(), { now: this.now(), idleMs: this.idleMs })
    for (const id of doomed) this.stop(id, `空闲超过 ${Math.round(this.idleMs / 1000)} 秒`)
    return doomed
  }

  /**
   * 保证这台引擎在跑，而且装的就是这一次要的那一份模型。
   *
   * ⭐⭐ 这是整刀的入口。合成路径在**全局合成锁内**调它一次。
   *
   * @param profile    resolveEngineProfile() 的产物
   * @param selection  { <位名>: <选中的路径> } —— 平台级的键，⛔ 不进引擎请求体
   * @returns {{ action, base_url, waited_ms }}
   */
  async ensure(profile, selection, opts = {}) {
    if (!profile || !profile.id) throw supErr('ENGINE_UNKNOWN', '没说要用哪台引擎')
    const id = profile.id

    // 名片没写 runtime = 这台引擎由作者自己起。平台起不了它，也不该假装起了。
    // ⚠ 这是**合法状态**，不是错误：直接放行，合成照常发过去，连不上会在
    //   那一层报「引擎没上线」—— 那句话是对的，且指向作者自己那台。
    if (!profile.runtime) {
      return { action: 'not-ours', base_url: profile.base_url, waited_ms: 0 }
    }

    const slots = launchSlots(profile)
    if (slots.length > MAX_LAUNCH_SLOTS) {
      // 理由见 residency.js 的 MAX_LAUNCH_SLOTS：今天只有一个地方能送。
      throw supErr('ENGINE_TOO_MANY_LAUNCH_SLOTS',
        `引擎 ${id} 有 ${slots.length} 个「开进程那一步吃进去」的模型位（${slots.map(s => s.name).join(' / ')}）—— ` +
        '平台今天只能送进去一个。多出来的那个如果放行，表现会是「选了不生效、不报错、声音不对」。' +
        '要支持多个，得先给它一条真正的送法，不是在这里放行。',
        { id, slots: slots.map((s) => s.name) })
    }

    const key = launchKeyOf(profile, selection)
    const onDemand = isOnDemand(profile)
    // ⭐ confirmed 由调用方说了算。**没说**的时候用那个暂定值（见文件顶上）。
    //   ⛔ 不许把「没说」当成「说了不同意」—— 今天全仓库唯一的调用方就是
    //     合成路径，它不会说，那样等于每次合成都拒。
    const confirmed = opts.confirmed === undefined ? this.assumeConfirmed : !!opts.confirmed
    const plan = planAdmission({
      residents: this._snapshot(),
      id, key, onDemand, cap: this.cap, idleMs: this.idleMs, now: this.now(),
      ...this._memState(id),
      confirmed,
    })

    // ⭐ 拒绝那一支必须在 evict 之前返回：一次注定失败的请求不该顺手关掉别人。
    //   （planAdmission 那边 evict 已经是空数组，这里再摆一次顺序是为了
    //    「读到这一行的人不用回去查另一个文件才敢确定没有副作用」。）
    if (plan.action === 'busy') {
      throw supErr('ENGINE_BUSY_OTHER_WEIGHT',
        `引擎 ${id} 正在给另一次合成干活，而这一次要的是另一份「开进程那一步吃进去」的模型。` +
        '换那一份得把进程重开一次 —— 重开就等于把正在跑的那次腰斩（拿到半截音频，或者一句引擎原话报错）。' +
        '请等它跑完再试。',
        { id, key, busy_key: (this.residents.get(id) || {}).key || null })
    }

    // ⭐⭐ 内存那两支跟 busy 同一条规则：**拒绝时不为这次请求腾地方**。
    //   为一次注定失败的请求顺手关掉别人 = 副作用发生了、请求还是失败了。
    if (plan.action === 'no_memory') {
      const m = plan.mem || {}
      throw supErr('ENGINE_NO_MEMORY',
        `内存不够启动引擎 ${id}：这台引擎历史上最多吃到 ${m.needMb} MB，` +
        `加上余量需要约 ${m.wantMb} MB，而现在只剩 ${m.freeMb} MB。` +
        '请先关掉一些别的程序再试。',
        { id, mem: m })
    }

    if (plan.action === 'needs_confirm') {
      // ⛔ 到这里只有一种可能：调用方**显式**传了 confirmed:false。
      //   （没传的走上面那个暂定值，压根到不了这儿。）
      //   ⇒ 抛的这个错是给「知道怎么问用户的那个调用方」接住去弹框的，
      //     ⛔ 不是给用户看的最终文案。数字放在 mem 里让它自己排版。
      // ⛔ 这句里不许写"预计需要多少" —— 走到这一支的**全部原因**就是我们
      //   不知道。编一个数出来被信了之后，错会算在平台头上。
      const m = plan.mem || {}
      throw supErr('ENGINE_NEEDS_CONFIRM',
        `平台还没量过引擎 ${id} 要占多少内存 —— 这次跑完就会记住。` +
        `当前可用 ${m.freeMb} MB。` +
        '如果内存不够，系统可能会强制关掉正在运行的其他程序，未保存的工作会丢失。',
        { id, mem: m })
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
    const baseUrl = await this._launchAndWait(profile, selection, key)
    return { action: plan.action, base_url: baseUrl, waited_ms: this.now() - t0 }
  }

  /**
   * 真的把它拉起来，然后**等它上线**。
   *
   * ⭐⭐⭐ 这里是 runtime.ready_endpoint / ready_timeout_ms 第一次有执行者。
   *   在此之前那两个字段只被打印过一行字。
   */
  async _launchAndWait(profile, selection, key) {
    const id = profile.id

    // launch 位选中的那一份，怎么送进进程 ——
    // ⭐ 重定向那台引擎的**底模目录**（名片 args / init_args 里的 {checkpoints}）。
    //   一个 launch 位说的就是「这个进程要装哪一份模型」，而进程装哪一份，
    //   在名片上表达出来就是它的 checkpoints 指向哪儿。
    //   ⇒ 上游一行都不用改：作者本来就是这么起他自己那台的。
    // ⚠ 没选（或没有 launch 位）⇒ 不覆盖，用名片声明的底模目录。
    const slots = launchSlots(profile)
    const chosen = slots.length === 1 && selection ? selection[slots[0].name] : null
    const opts = {}
    if (chosen) opts.checkpointsOverride = String(chosen)

    // 端口：用**启动脚本已经定下来**的那个（它写进了 base_url_env，后端继承了）。
    // ⛔ 不重新解一遍端口冲突 —— 那 90 行不在这里。
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

    // ⭐⭐ 起之前先落一笔「正在试 id」。
    //   这是**给崩掉那一次准备的**：被系统杀掉的进程来不及让我们读峰值，
    //   下次开机看见这条还挂着，就知道「它上次没活着回来」。
    //   ⛔ 必须在 spawn **之前** —— spawn 之后才记的话，起一半就被杀的那次
    //     一点痕迹都不会留下，而那正是最该留痕的一次。
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

    // ── 探活循环 ────────────────────────────────────────────────────────
    // 预算来自名片：runtime.ready_timeout_ms。⛔ 平台不替它定这个数 ——
    //   一台冷启动 61 秒的引擎和一台 2 秒起来的引擎，用同一个预算必然坑一头。
    const budget = Number(plan.ready_timeout_ms) || 0
    this._setPhase(id, 'loading', `正在加载模型（这台引擎最多要 ${Math.round(budget / 1000)} 秒）`)
    const deadline = this.now() + budget
    let ok = false
    let lastErr = null
    for (;;) {
      // ⚠ 先看进程还在不在。它自己崩了的话，再探 180 秒纯属浪费用户的时间，
      //   而且最后报出来的会是「超时」—— 那句话把人指向"机器太慢"，
      //   而真相是引擎启动时就抛异常退出了（日志里写着）。
      if (proc && proc.exitCode != null) {
        this.residents.delete(id)
        this._setPhase(id, null)
        throw supErr('ENGINE_EXITED_EARLY',
          `引擎 ${id} 刚起来就退出了（退出码 ${proc.exitCode}）—— 看 logs\\${id}.err.log。`,
          { id, exitCode: proc.exitCode })
      }
      try {
        ok = await this.probe(plan.ready_url, this.pollMs)
      } catch (err) {
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
        `引擎 ${id} 起来了，但 ${Math.round(budget / 1000)} 秒之内没有上线（探活地址 ${plan.ready_url}）。` +
        `这个预算是它自己在 manifest.json 里写的 ready_timeout_ms。看 logs\\${id}.log 找加载卡在哪。`,
        { id, ready_url: plan.ready_url, budget_ms: budget, cause: lastErr })
    }

    rec.lastUsedAt = this.now()
    this._setPhase(id, null)
    this.log(`[engine] ${id} 上线（用了 ${((this.now() - rec.startedAt) / 1000).toFixed(1)} 秒）`)
    // ⭐ 上线这一刻就记一笔 —— 模型已经装进内存了，这是一个**真实观测到的**
    //   数，不是估的。而且 record 会顺手把「正在试」那条销掉 ⇒ 一台起来了
    //   却从没被用过就被 sweep 掉的引擎，⛔ 不会被误记成崩过。
    // ⚠ 这个数偏小（还没推理过）。不要紧：账本只涨不落，第一次合成完就会
    //   被更大的那个盖过去。
    this._recordMem(id, '刚上线')
    return plan.base_url
  }

  /**
   * 合成开始/结束时标一下，免得正在忙的引擎被腾地方腾掉。
   *
   * ⭐⭐⭐ 「合成刚结束」是读峰值最好的时机，而这个方法**已经**在那个时机被
   *   调用了（synthesisService.js 的 finally 里）⇒ 读峰值和记账 100% 关在
   *   本文件内部，**调用方一个字都不用改**。
   *   ⛔ 不要为此新开一个 onSynthesisDone() —— 那会多出一个可以忘记调用的
   *     接线点，而忘了调的症状是「账本永远学不会」，没有任何报错。
   * ⚠ 它在 finally 里 ⇒ **合成失败也会走到这儿**。那正是我们要的：跑失败了
   *   也照样吃了那么多内存，那笔账一样值钱。引擎真崩了的话进程已经没了，
   *   sampleTree 返回 ok:false ⇒ 整笔丢掉。
   */
  markBusy(id, busy) {
    const r = this.residents.get(id)
    if (!r) return
    const wasBusy = !!r.busy
    r.busy = !!busy
    r.lastUsedAt = this.now()
    // 只在「忙 → 不忙」这个沿上量。⛔ 不在每次调用都量：markBusy(id,false)
    //   可能被重复调，而每量一次就要问一次操作系统。
    if (wasBusy && !busy) this._recordMem(id, '合成刚跑完')
  }
}

module.exports = { EngineSupervisor }
