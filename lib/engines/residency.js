'use strict'

// ---------------------------------------------------------------------------
//  引擎该不该常驻 —— 从名片上**已经有的**东西推，不新增任何字段
// ---------------------------------------------------------------------------
//
// ⭐⭐⭐ 这个文件在还的账，是 Owner 的原话：
//
//    「接入 IndexTTS3、4、5，我一次启动是不是要启动 4 台引擎，
//      这个是工程该有的思维吗？」
//
//    今天启动脚本的行为是「engines\ 下装了几台就起几台」。而其中一台
//    **开进程那一刻就吃掉约 6G 内存**（还没合成一个字）。装到第四台，
//    开机就是四份内存一起吃。
//
// ── 判据从哪来：不问作者，从模型位推 ───────────────────────────────────
//
// 上一刀（2026-08-30）把「换一份模型送到哪一步」降到了**模型位**上，
// 穷举只有两种（契约 §5.8）：
//
//    applies_at = 'launch'  开进程那一步吃进去的 ⇒ 换一份要带着它重开一次
//    applies_at = 'call'    进程活着时一次调用换掉
//
// ⭐⭐ 「模型是开进程那一刻吃进内存的」和「换它要重开进程」是**同一件事的
//    两面**。所以「起着贵不贵」这个问题，名片上**已经答过了**，只是答在
//    另一个字段上。⇒ 本文件只做推导，不要求作者多写一行。
//
//    有 launch 位  ⇒ 进程 = 模型。起着就吃内存，放掉真的能吐出来。
//                     ⇒ **开机不预热，第一次真有请求才起，空闲了就释放。**
//    只有 call 位  ⇒ 进程是个壳，模型是后来喂进去的。起着不吃什么，
//                     关掉也省不下，重开还白等一次。
//                     ⇒ **可以开机预热，不做空闲释放。**
//
// ⛔ 这里不认识任何一台具体的引擎。判据是位上的 applies_at，装一台谁都没
//    见过的引擎，这个文件一个字都不用改。下面有守卫测试盯着。
//
// ── 一个我必须说出来的洞 ───────────────────────────────────────────────
//
// ⚠ 一台**一个模型位都没声明**的引擎（只有一个写死底模、不支持微调的那种），
//   按上面的规则落进「不做空闲释放」那一档 —— 它仍然受常驻上限约束，所以
//   不会失控，但不会主动吐内存。这是**已知且故意**的：位都没有的引擎，
//   平台手上没有任何关于「它起着贵不贵」的证据，而在没有证据时选择
//   「不动它」比选择「关掉它」安全（关错了的代价是每次请求都白等一次冷启动）。
//   真遇到这种引擎再说，⛔ 不要在这里替它猜。
//
// ── 这两个数不进名片 ───────────────────────────────────────────────────
//
// 常驻上限（默认 2，Owner 2026-08-30 定）和空闲释放时长（默认 10 分钟）
// 是**平台配置**，契约 §5.6 写明了这一类（超时 / 重试 / 排队）是平台的事，
// 名片没资格声明。它们在 supervisor.js 里从环境变量读，本文件只做纯计算。

/**
 * 常驻上限的**兜底**值。
 *
 * ⚠⚠ 2026-08-31 Owner 推翻了它原来的角色。它曾经是法官，现在只是护栏。
 *
 * ⭐⭐⭐ 为什么它当不了法官：它是个**代理指标**。我们真正想问的是
 *   「内存还够不够」，它却去问「我开了几台」，中间靠两个假设换算 ——
 *   「一台大概吃多少」和「这台机器上只有我们在跑」。假设一破就答错，
 *   而且**不会有任何提示**。
 *   真机实测把两个假设都打穿了：GSV 峰值 3547MB、IndexTTS2 6–8G，差一倍
 *   有余；16G 机器空着的时候只剩 6230MB，被别的程序吃掉了 9894MB。
 *
 * ⭐ 正解是直接量：起之前看一眼**还剩多少内存**。这个数天然已经把别人
 *   吃掉的算进去了 ——「别人开了几台」这个问题不是被解决，是根本不用问。
 *
 * ⛔ 它保留下来只干一件事：内存估算整个失灵时（量不到、账本坏了、
 *   全是 null），别让平台一口气起 20 台。护栏不负责判断，只负责兜底。
 * ⛔ 也**不许**拿端口池大小来当上限：端口有 65535 个，不稀缺。上限只能
 *   来自稀缺的那样东西 —— 内存。拿端口当上限的后果是 64G 机器上明明够
 *   开 4 台却只肯开 2 台，而且报错会说「端口不够」，把人指向一个根本
 *   没有问题的地方。
 */
const DEFAULT_CAP = 2

/**
 * 量出来的内存数上再乘多少余量。
 *
 * ⭐ 为什么必须有余量：树是靠父子链收的，而链会断（真机见过四层链，
 *   中间那层是个跑完就退的壳）。断链 ⇒ 漏算 ⇒ 判得乐观 ⇒ 机器 OOM。
 *   余量只往上加，⛔ 不往下抹。
 */
const DEFAULT_HEADROOM = 1.15

/** 空闲多久之后释放（毫秒）。只对「起进程就吃内存」那一档生效。 */
const DEFAULT_IDLE_MS = 10 * 60 * 1000

/**
 * 这台引擎的模型位里，哪些是「开进程那一步吃进去的」。
 *
 * ⛔ 兜底取 launch（与名片解析那一侧、前端那一侧同一个理由）：
 *    填错的后果不对称 —— 该 launch 当 call ⇒ 发一个引擎不读的键、
 *    声音没变、**不报错**；反过来只是多重开一次，慢但不撒谎。
 */
function launchSlots(profile) {
  const slots = (profile && profile.weight_slots) || []
  return slots.filter((s) => s && s.applies_at !== 'call')
}

/** 这台引擎的模型位里，哪些是「进程活着时一次调用换掉」的。 */
function callSlots(profile) {
  const slots = (profile && profile.weight_slots) || []
  return slots.filter((s) => s && s.applies_at === 'call')
}

/**
 * 这台引擎起着贵不贵 —— 贵就按需拉起。
 *
 * ⭐ 判据只有一条：有没有 launch 位。理由见文件头。
 */
function isOnDemand(profile) {
  return launchSlots(profile).length > 0
}

/**
 * 开机要不要顺带把它拉起来。
 *
 * ⚠ 名片上那个 runtime.preload 仍然被尊重，但它**只能往下压不能往上抬**：
 *    作者写 false ⇒ 不预热（他比平台更清楚自己那台起着有多贵）。
 *    作者写 true  ⇒ 平台仍然要看有没有 launch 位。
 *
 *    ⛔ 为什么 true 不能一锤定音：盘上两张真名片今天**都写着 true**
 *      （那一行今天一个消费者都没有，作者是照着模板抄的）。让 true
 *      直接生效 = 这一刀等于什么都没改，开机照样把那台吃 6G 的点着。
 *      ⇒ 一个从来没被读过的字段，不该在它第一次被读到的那天就拥有
 *        「让用户吃掉 6G 内存」的权力。
 *
 * ⚠ 不由平台启动的引擎（名片没写 runtime）永远返回 false —— 平台起不了它。
 */
function shouldPreload(profile) {
  if (!profile || !profile.runtime) return false
  if (profile.runtime.preload === false) return false
  return !isOnDemand(profile)
}

/**
 * 这一次请求，launch 位各选了哪一份 —— 拼成一个可比较的键。
 *
 * ⭐ 「进程里现在装的是不是这一份」就靠比这个字符串。相等 ⇒ 直接用；
 *    不等 ⇒ 关掉、带着新的重开一次。
 *
 * ⛔ 返回 '' 表示「这台引擎没有 launch 位」，与「有位但没选」（返回带空值的键）
 *    必须分得开：前者永远不需要重开，后者第一次选中时需要。
 *
 * @param profile   resolveEngineProfile() 的产物
 * @param selection { <位名>: <选中的路径> }。平台级的键，⛔ 不进引擎请求体。
 */
function launchKeyOf(profile, selection) {
  const slots = launchSlots(profile)
  if (slots.length === 0) return ''
  const sel = selection || {}
  return slots.map((s) => s.name).sort().map((name) => {
    const v = sel[name]
    return `${name}=${v == null || v === '' ? '' : String(v)}`
  }).join('\u0000')
}

function stablePairs(value) {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.keys(obj).sort().map((name) => [name, obj[name]])
}

function startupKeyOf(profile, selection, loadParams) {
  const weights = launchKeyOf(profile, selection)
  const load = stablePairs(loadParams)
  if (!weights && load.length === 0) return ''
  return JSON.stringify({ weights, load })
}

/**
 * 一台引擎最多允许有几个 launch 位。
 *
 * ⚠⚠ 今天平台把 launch 位的选择送进进程的办法，是**重定向那台引擎的
 *    底模目录**（{checkpoints} 占位符）—— 而一个进程只有一个底模目录。
 *    ⇒ 两个 launch 位没有地方可送，第二个会被静默丢掉。
 *
 * ⭐ 所以这里**当场拒绝**而不是挑一个送：静默丢掉的表现是「选了不生效、
 *    不报错、声音不对」，那是这个仓库里最难查的一种坏法。
 *    真出现两个 launch 位的引擎时，要做的是给它一条真正的送法，不是在
 *    这里放行。
 */
const MAX_LAUNCH_SLOTS = 1

/**
 * 一次「这台引擎现在能不能直接用」的裁决。
 *
 * 纯函数：现状进，动作出。⛔ 不 spawn、不联网、不读时钟（now 传进来）。
 *
 * @param state {
 *   residents: [{ id, key, busy?, lastUsedAt, onDemand }]  当前活着的进程
 *   id:        要用哪一台
 *   key:       这一次要的 launch 位选择（launchKeyOf 的产物）
 *   onDemand:  这一台是不是按需档
 *   cap:       常驻上限（兜底护栏，见 DEFAULT_CAP）
 *   idleMs:    空闲释放阈值
 *   now:       当前时间戳（毫秒）
 *   freeMb:    这台机器现在还剩多少内存（MB）。不给 ⇒ 不做内存判断
 *   needMb:    这一台历史上最多吃过多少（MB）。**null = 从来没量过**
 *   headroom:  余量倍数，默认 1.15
 *   confirmed: 用户已经在「第一次启动」那个框上点过继续
 * }
 * @returns {{ action:'reuse'|'start'|'relaunch'|'busy'|'needs_confirm',
 *             evict:string[], reason:string, mem?:object }}
 *   evict = 为了给这一台腾地方，必须先关掉的那几台（按最久没用排序）
 *
 * ⭐⭐⭐ needMb 的 **null 和 0 必须分得开**：null 是「不知道它吃多少」
 *   （⇒ needs_confirm，让用户自己决定要不要赌这一把），0 是「它不吃内存」
 *   （⇒ 随便起）。把两者混起来，等于把最危险的情况当成最安全的。
 *
 * ⭐⭐⭐ 'busy' = 这台引擎正在给别人合成，而来的这一次要的是**另一份**
 *   launch 位模型。换那一份要重开进程 ⇒ 重开 = 把正在跑的那次腰斩。
 *   ⛔ 这里**当场拒绝**，理由与 MAX_LAUNCH_SLOTS 同一条：静默毁掉别人
 *   那一次合成（半截 WAV / 引擎原话报错），是这个仓库里最难查的坏法 ——
 *   而且坏的是 A，报错的却在 B 那边一切正常。
 */
function planAdmission(state) {
  const residents = Array.isArray(state.residents) ? state.residents.slice() : []
  const cap = Number.isInteger(state.cap) && state.cap > 0 ? state.cap : DEFAULT_CAP
  const idleMs = Number.isInteger(state.idleMs) && state.idleMs > 0 ? state.idleMs : DEFAULT_IDLE_MS
  const now = Number.isFinite(state.now) ? state.now : 0
  const id = state.id
  const key = state.key == null ? '' : String(state.key)

  const me = residents.find((r) => r && r.id === id)

  // ⭐ 最先判：自己正忙，而要的是另一份 launch 模型 ⇒ 当场拒绝。
  //   ⛔ 拒绝这一支**不做任何 evict**：这一次请求不会起任何进程，没有谁
  //     需要腾地方；空闲太久的那几台由 planSweep 那条定时线去放（同一条
  //     规则，各自有测试）。为一次注定失败的请求顺手关掉别人 = 副作用
  //     发生了、请求还是失败了，两头都不落好。
  if (me && me.busy && me.key !== key) {
    return {
      action: 'busy',
      evict: [],
      reason: '这台引擎正在给别人合成，而这一次要的是另一份「开进程那一步吃进去」的模型 —— 换它得重开进程，会把正在跑的那次腰斩',
    }
  }

  // 先把「反正也该放掉的」挑出来 —— 空闲超时的按需档引擎。
  // ⭐ 这一步与够不够上限**无关**：内存该吐就吐，不该等到有人来抢才吐。
  // ⛔ 但绝不碰自己（下面马上要用它）和正在忙的。
  const expired = residents
    .filter((r) => r && r.id !== id && r.onDemand && !r.busy &&
      Number.isFinite(r.lastUsedAt) && (now - r.lastUsedAt) >= idleMs)
    .map((r) => r.id)

  const evict = expired.slice()
  const survivors = residents.filter((r) => r && !evict.includes(r.id))

  let action
  let reason
  if (me && me.key === key) {
    action = 'reuse'
    reason = '这台引擎已经在跑，而且装的就是这一份模型'
  } else if (me) {
    action = 'relaunch'
    reason = '这台引擎在跑，但装的不是这一份模型 —— 它的模型是开进程那一步吃进去的，要带着新的重开一次'
  } else {
    action = 'start'
    reason = '这台引擎还没起'
  }

  // reuse 不占新名额（它本来就在里面）。start / relaunch 要保证放得下：
  // relaunch 会先关掉自己再起，所以它占的名额数不变 ⇒ 也不用腾。
  if (action === 'start') {
    // 算上自己之后有几台。超了就按「最久没用」关掉，⛔ 正在忙的不动。
    const candidates = survivors
      .filter((r) => !r.busy)
      .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0))
    let count = survivors.length + 1
    for (const c of candidates) {
      if (count <= cap) break
      evict.push(c.id)
      count -= 1
    }
  }

  // -------------------------------------------------------------------------
  //  内存判据。
  //
  //  ⭐ 只有 'start' 走这一段。'relaunch' **不走** —— 它先关掉自己再起，
  //    一关一起吃的是同一块内存，净增为零。它跟 cap 不占新名额是同一个理由。
  //    'reuse' 更不用说，进程已经在了。
  // -------------------------------------------------------------------------
  if (action === 'start') {
    const headroom = Number.isFinite(state.headroom) && state.headroom >= 1
      ? state.headroom : DEFAULT_HEADROOM
    const free = Number.isFinite(state.freeMb) ? state.freeMb : null
    // ⛔⛔ 这里**必须**写成 `>= 0`。写 `> 0` 会把 0 折进 null 那一支，
    //   而这一整段的前提就是 0（不吃内存）和 null（不知道）分得开。
    //   我第一版就写成了 `> 0`，紧挨着的注释还在说不许这么写 ——
    //   ⭐ 一条规则光写在注释里不算数，得有条测试盯着。
    const need = Number.isFinite(state.needMb) && state.needMb >= 0 ? state.needMb : null

    // ⭐ 要关掉的那几台会把内存还回来，所以判断时该算上。
    //   ⛔ 加回来的是它们的**当前**用量（rssMb），不是峰值 —— 峰值是历史
    //     最高，早就还给系统了，按峰值加回来是凭空多出一截，方向危险。
    const freed = evict.reduce((sum, eid) => {
      const r = residents.find((x) => x && x.id === eid)
      return sum + (r && Number.isFinite(r.rssMb) && r.rssMb > 0 ? r.rssMb : 0)
    }, 0)

    if (free != null) {
      const budget = free + freed
      if (need == null) {
        // 从来没量过这一台。⭐ 走 B 路：**不拦，但要问**。
        //   ⛔ 不许在这里编一个「大概要 4G」的数去拦 —— 我们答不上来，
        //     正是因为答不上来才走到这一支。编出来的数被用户信了之后，
        //     错的会算在平台头上，而不是算在「平台不知道」头上。
        //   ⭐ 让「不知道」只发生一次：这次跑完就有实测了，以后不再问。
        if (!state.confirmed) {
          return {
            action: 'needs_confirm',
            evict: expired.slice(),   // ⛔ 见下：注定不起的请求不给它腾地方
            reason: '这是第一次启动这台引擎，平台还不知道它要占多少内存',
            mem: { freeMb: free, needMb: null, budgetMb: budget, headroom },
          }
        }
      } else {
        const want = Math.ceil(need * headroom)
        if (want > budget && !state.confirmed) {
          // 已知需求超过当前预算也不是平台替用户作决定的理由。这里和
          // 「第一次启动、尚无历史数据」统一为一次性风险确认。确认前不为
          // 这次请求驱逐任何仍可用的引擎；确认后才按原计划继续启动。
          return {
            action: 'needs_confirm',
            evict: expired.slice(),
            reason: '系统内存可能不足 —— 这台引擎历史上最多吃到过 ' + need +
              ' MB（加余量后算 ' + want + ' MB），现在可用 ' + budget + ' MB',
            mem: { freeMb: free, needMb: need, wantMb: want, budgetMb: budget, headroom },
          }
        }
      }
    }
  }

  return { action, evict, reason }
}

/**
 * 定时清扫：现在有哪几台该放掉了。
 *
 * ⭐ 与 planAdmission 里那一段是同一条规则，⛔ 但不能共用同一段代码就完事 ——
 *   这里没有「自己」要保护，那边有。分开写，各自有测试。
 */
function planSweep(residents, opts = {}) {
  const idleMs = Number.isInteger(opts.idleMs) && opts.idleMs > 0 ? opts.idleMs : DEFAULT_IDLE_MS
  const now = Number.isFinite(opts.now) ? opts.now : 0
  return (residents || [])
    .filter((r) => r && r.onDemand && !r.busy &&
      Number.isFinite(r.lastUsedAt) && (now - r.lastUsedAt) >= idleMs)
    .map((r) => r.id)
}

module.exports = {
  DEFAULT_CAP,
  DEFAULT_HEADROOM,
  DEFAULT_IDLE_MS,
  MAX_LAUNCH_SLOTS,
  launchSlots,
  callSlots,
  isOnDemand,
  shouldPreload,
  launchKeyOf, startupKeyOf,
  planAdmission,
  planSweep,
}
