'use strict'

// ---------------------------------------------------------------------------
// 引擎该不该常驻：从名片上**已经有的**东西推，不新增任何字段
// ---------------------------------------------------------------------------
//
// 这个文件在还的账，是 Owner 的原话：
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
// 上一版把「换一份模型送到哪一步」降到了**模型位**上，穷举只有两种（契约 §5.8）：
//
//    applies_at = 'launch'  开进程那一步吃进去的 ⇒ 换一份要带着它重开一次
//    applies_at = 'call'    进程活着时一次调用换掉
//
// 「模型是开进程那一刻吃进内存的」和「换它要重开进程」是**同一件事的
//    两面**。所以「起着贵不贵」这个问题，名片上**已经答过了**，只是答在
//    另一个字段上。⇒ 本文件只做推导，不要求作者多写一行。
//
//    有 launch 位  ⇒ 进程 = 模型。起着就吃内存，放掉真的能吐出来。
//                     ⇒ **开机不预热，第一次有请求时才启动，空闲了就释放。**
//    只有 call 位  ⇒ 进程是个壳，模型是后来喂进去的。起着不吃什么，
//                     关掉也省不下，重开还白等一次。
//                     ⇒ **可以开机预热，不做空闲释放。**
//
// 这里不认识任何一台具体的引擎。判据是位上的 applies_at，装一台谁都没
//    见过的引擎，这个文件一个字都不用改。下面有守卫测试盯着。
//
// ── 一个必须说明的缺口 ─────────────────────────────────────────────────
//
// 一台**一个模型位都没声明**的引擎（只有一个写死底模、不支持微调的那种），
//   按上面的规则落进「不做空闲释放」那一档，它仍然受常驻上限约束，所以
//   不会失控，但不会主动释放内存。这是**已知且故意**的：位都没有的引擎，
//   平台手上没有任何关于「它起着贵不贵」的证据，而在没有证据时选择
//   「不动它」比选择「关掉它」安全（关错了的代价是每次请求都白等一次冷启动）。
//   真遇到这种引擎再说，不要在这里替它猜。
//
// ── 这两个数不进名片 ───────────────────────────────────────────────────
//
// 常驻上限（默认 2）和空闲释放时长（默认 10 分钟）
// 是**平台配置**，契约 §5.6 写明了这一类（超时 / 重试 / 排队）是平台的事，
// 名片没资格声明。它们在 supervisor.js 里从环境变量读，本文件只做纯计算。

/**
 * 常驻上限的**兜底**值。
 *
 * 它曾经是判据，现在降级为护栏。
 *
 * 为什么它当不了判据：它是个**代理指标**。真正要回答的是
 *   「内存还够不够」，它却去问「已启动几台」，中间靠两个假设换算：
 *   「一台大约占用多少」和「本机上只有本平台在运行」。假设一旦不成立就答错，
 *   而且**不会有任何提示**。
 *   真机实测把两个假设都打穿了：GSV 峰值 3547MB、IndexTTS2 6–8G，差一倍
 *   有余；16G 机器空着的时候只剩 6230MB，被别的程序占用了 9894MB。
 *
 * 正解是直接测量：启动前查看**剩余内存**。这个数天然已经把别的程序
 *   占用计入，「别人开了几台」这个问题不必再问。
 *
 * 它保留下来只干一件事：内存估算整个失灵时（量不到、账本损坏、
 *   全是 null），不让平台一次启动 20 台。护栏不负责判断，只负责兜底。
 * 也**不许**拿端口池大小当上限：端口有 65535 个，不稀缺。上限只能
 *   来自稀缺的资源：内存。拿端口当上限的后果是 64G 机器上明明可以
 *   启动 4 台却只启动 2 台，而且报错会说「端口不够」，把问题指向一个
 *   并不存在的方向。
 */
const DEFAULT_CAP = 2

/**
 * 自动 cap：**总内存每 8G 多容纳一台**。
 *
 *     8G → 1    16G → 2    32G → 4    64G → 8    128G → 16
 *
 * 三个数从哪来，优先级**从高到低**：
 *   1. 用户显式设定的（AURIVOX_ENGINE_CAP 或前端设置）：永不覆盖
 *   2. 本函数按 totalMb 计算
 *   3. 连 totalMb 都量不到 ⇒ 退回 DEFAULT_CAP（= 2）
 *
 * 为什么**不用**「按账本里最大的 peakMb 计算」（该方案已被否决，理由成立）：
 *   1. 刚装好、还没运行过任何引擎时，账本全是 null ⇒ 那个分母根本不存在。
 *      而那**正是最需要护栏的时刻**：平台对每台引擎一无所知。
 *   2. 引擎混用时它无法回答：一个 GSV(3.5G) 加一个 IndexTTS2(8.4G)
 *      要算几个 cap？取最大值会被占用小的那台拖累；取平均值会漏算
 *      占用大的那台。
 *      「cap 是几台」与「每台占用多少」是两个问题，合并成一个数必然失真。
 *   3. 8G 不是估计值：它就是一台主流 TTS 引擎的量级（实测 GSV 3.5G、
 *      IndexTTS2 8.4G，8G 落在两者之间偏保守一侧）。
 *
 * 本函数**只回答「本机能容纳几台」**，不回答「此刻是否充足」。
 *   后者是 freeMb 加 needs_confirm 那一支的职责（实测已覆盖）。
 *   使用 totalMb 而不是 freeMb：cap 是**能力**问题，不是**现状**问题。
 *   若用 freeMb，别的程序启动一个浏览器就会改变 cap，导致同一台机器
 *   每次启动的 cap 都不同，无法解释「为何昨天能启动 3 台而今天只能启动 1 台」。
 *
 * @param {number|null|undefined} totalMb 机器总内存 MB
 * @returns {number} 至少 1：0 台等于平台完全不可用，那不是护栏
 */
const MB_PER_ENGINE = 8 * 1024
const MIN_AUTO_CAP = 1

function autoCapFor(totalMb) {
  if (!Number.isFinite(totalMb) || totalMb <= 0) return DEFAULT_CAP
  return Math.max(MIN_AUTO_CAP, Math.floor(totalMb / MB_PER_ENGINE))
}

/**
 * 量出来的内存数上再乘多少余量。
 *
 * 为什么必须有余量：进程树依赖父子链回收，而链会断（真机见过四层链，
 *   中间那层是执行完即退出的壳进程）。断链 ⇒ 漏算 ⇒ 判断偏乐观 ⇒ 机器 OOM。
 *   余量只向上增加，不向下削减。
 */
const DEFAULT_HEADROOM = 1.15

/** 空闲多久之后释放（毫秒）。只对「启动进程即占用内存」那一档生效。 */
const DEFAULT_IDLE_MS = 10 * 60 * 1000

/**
 * 这台引擎的模型位里，哪些是「开进程那一步加载的」。
 *
 * 兜底取 launch（与名片解析那一侧、前端那一侧同一个理由）：
 *    填写错误的后果不对称：该填 launch 填成 call，会发送一个引擎不读取的键、
 *    声音未变、**不报错**；反过来只是多重启一次，较慢但不会给出错误信息。
 */
function launchSlots(profile) {
  const slots = (profile && profile.weight_slots) || []
  return slots.filter((s) => s && s.applies_at !== 'call')
}

/** 这台引擎的模型位里，哪些是「进程存活期间由一次调用切换」的。 */
function callSlots(profile) {
  const slots = (profile && profile.weight_slots) || []
  return slots.filter((s) => s && s.applies_at === 'call')
}

/**
 * 这台引擎启动开销是否高：高则按需启动。
 *
 * 判据只有一条：有没有 launch 位。理由见文件头。
 */
function isOnDemand(profile) {
  return launchSlots(profile).length > 0
}

/**
 * 开机要不要顺带把它启动起来。
 *
 * 名片上那个 runtime.preload 仍然被尊重，但它**只能下调不能上调**：
 *    作者写 false ⇒ 不预热（作者比平台更清楚自己那台的启动开销）。
 *    作者写 true  ⇒ 平台仍然要看有没有 launch 位。
 *
 *    为什么 true 不能直接生效：盘上两张真实名片目前**都写着 true**
 *      （该字段目前没有任何读取方，作者是照模板填写的）。若让 true
 *      直接生效，则本次改动等于没有生效，开机仍会启动那台占用 6G 的引擎。
 *      ⇒ 一个从未被读取的字段，不应在它第一次被读取时就拥有
 *        「让用户承担 6G 内存占用」的权力。
 *
 * 不由平台启动的引擎（名片未写 runtime）永远返回 false：平台无法启动它。
 */
function shouldPreload(profile) {
  if (!profile || !profile.runtime) return false
  if (profile.runtime.preload === false) return false
  return !isOnDemand(profile)
}

/**
 * 这一次请求，launch 位各选了哪一份：拼成一个可比较的键。
 *
 * 「进程里当前加载的是不是这一份」就靠比对这个字符串。相等 ⇒ 直接使用；
 *    不等 ⇒ 关闭、带着新的重启一次。
 *
 * 返回 '' 表示「这台引擎没有 launch 位」，与「有位但未选择」（返回带空值的键）
 *    必须区分：前者永远不需要重启，后者在第一次选中时需要。
 *
 * @param profile   resolveEngineProfile() 的产物
 * @param selection { <位名>: <选中的路径> }。平台级的键，不进引擎请求体。
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
 * 目前平台把 launch 位的选择送进进程的办法，是**重定向该引擎的
 *    底模目录**（{checkpoints} 占位符），而一个进程只有一个底模目录。
 *    ⇒ 两个 launch 位没有地方可送，第二个会被静默丢弃。
 *
 * 所以这里**直接拒绝**而不是挑一个送入：静默丢弃的表现是「选择不生效、
 *    不报错、声音不对」，那是本仓库最难排查的一类故障。
 *    真出现两个 launch 位的引擎时，应当为它提供一条真正的传递途径，
 *    而不是在此放行。
 */
const MAX_LAUNCH_SLOTS = 1

/**
 * 一次「这台引擎现在能不能直接使用」的裁决。
 *
 * 纯函数：现状进，动作出。不 spawn、不联网、不读时钟（now 由入参传入）。
 *
 * @param state {
 *   residents: [{ id, key, busy?, lastUsedAt, onDemand }]  当前存活的进程
 *   id:        要用哪一台
 *   key:       这一次要的 launch 位选择（launchKeyOf 的产物）
 *   onDemand:  这一台是否按需档
 *   cap:       常驻上限（兜底护栏，见 DEFAULT_CAP）
 *   idleMs:    空闲释放阈值
 *   now:       当前时间戳（毫秒）
 *   freeMb:    本机当前剩余内存（MB）。不提供 ⇒ 不做内存判断
 *   needMb:    这一台历史上最高占用（MB）。**null = 从未测量**
 *   headroom:  余量倍数，默认 1.15
 *   confirmed: 用户已在「第一次启动」提示中确认继续
 * }
 * @returns {{ action:'reuse'|'start'|'relaunch'|'busy'|'needs_confirm',
 *             evict:string[], reason:string, mem?:object }}
 *   evict = 为了给这一台腾出资源，必须先关闭的那几台（按最久未用排序）
 *
 * needMb 的 **null 与 0 必须区分**：null 表示「不知道它占用多少」
 *   （⇒ needs_confirm，由用户决定是否继续），0 表示「它不占用内存」
 *   （⇒ 可直接启动）。把两者混同，等于把最危险的情形当作最安全的情形。
 *
 * 'busy' = 这台引擎正在为另一个请求合成，而本次请求要的是**另一份**
 *   launch 位模型。切换该模型需要重启进程 ⇒ 重启会截断正在执行的那次合成。
 *   这里**直接拒绝**，理由与 MAX_LAUNCH_SLOTS 相同：静默破坏另一个请求
 *   的合成结果（不完整的 WAV、引擎返回的原始错误），是本仓库最难排查的
 *   故障模式，而且故障出现在 A，报错却显示在一切正常的 B 上。
 */
function planAdmission(state) {
  const residents = Array.isArray(state.residents) ? state.residents.slice() : []
  const cap = Number.isInteger(state.cap) && state.cap > 0 ? state.cap : DEFAULT_CAP
  const idleMs = Number.isInteger(state.idleMs) && state.idleMs > 0 ? state.idleMs : DEFAULT_IDLE_MS
  const now = Number.isFinite(state.now) ? state.now : 0
  const id = state.id
  const key = state.key == null ? '' : String(state.key)

  const me = residents.find((r) => r && r.id === id)

  // 最先判断：自身正忙，而本次要的是另一份 launch 模型 ⇒ 直接拒绝。
  //   这一支**不做任何 evict**：本次请求不会启动任何进程，没有谁
  //     需要腾出资源；空闲过久的那几台由 planSweep 那条定时线释放（同一条
  //     规则，各自有测试）。为一次注定失败的请求顺手关闭其他引擎，等于
  //     副作用已发生而请求仍失败，两方面都不利。
  if (me && me.busy && me.key !== key) {
    return {
      action: 'busy',
      evict: [],
      reason: '这台引擎正在执行另一次合成，而这一次要的是另一份「进程启动时载入」的模型，切换它需要重启进程，会截断正在执行的那次合成',
    }
  }

  // 先把「确实该释放的」挑出来：空闲超时的按需档引擎。
  // 这一步与是否超出上限**无关**：内存应当及时释放，不应等到有请求争用时才释放。
  // 但绝不处理自身（下面马上要用它）和正在忙的引擎。
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
    reason = '这台引擎已在运行，而且加载的就是这一份模型'
  } else if (me) {
    action = 'relaunch'
    reason = '这台引擎在运行，但加载的不是这一份模型：它的模型在进程启动时载入，需要带着新的模型重启一次'
  } else {
    action = 'start'
    reason = '这台引擎尚未启动'
  }

  // reuse 不占新名额（它本来就在其中）。start / relaunch 要保证放得下：
  // relaunch 会先关闭自己再启动，所以它占的名额数不变 ⇒ 也不需要腾出名额。
  //
  // cap 只在「不知道要占用多少」时兜底，不参与「是否充足」的判断。
  //
  // 判据是 `need == null`，不是「内存够不够」：
  // 「够不够」由下面的内存判据单独回答（budget 与 want 的比较），
  //   它更准确、也更早生效。两者分工：下面那支回答「能否启动这一台」；
  //   cap 回答「在完全不了解占用情况时，不要一次启动过多」。
  //
  // 为什么账本为空时它应当生效：
  //   那正是平台对每台引擎一无所知的时刻。`SEED_MB = null`（memledger.js）
  //   意味着第一次启动任何引擎都会走 needs_confirm 询问用户，用户确认继续后，
  //   需要有机制阻止「连续确认 20 次就启动 20 台」。
  //
  // 为什么账本有数据时它不应生效：
  //   每个引擎的 needMb 都是实测峰值（memledger 只增不减），加上 headroom
  //   之后与 freeMb 逐台核对，那已经是**按占用量**的判断。
  //   再叠加一个**按台数**的 cap，只会在内存充足时无谓地关闭用户的引擎。
  if (action === 'start') {
    const needKnown = Number.isFinite(state.needMb) && state.needMb >= 0
    if (!needKnown) {
      // 算上自己之后有几台。超出则按「最久未使用」关闭，正在忙的不处理。
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
  }

  // -------------------------------------------------------------------------
  //  内存判据。
  //
  //  只有 'start' 走这一段。'relaunch' **不走**：它先关闭自己再启动，
  //    一关一开占用的是同一块内存，净增为零。这与 cap 不占新名额同理。
  //    'reuse' 更不必说，进程已经存在。
  // -------------------------------------------------------------------------
  if (action === 'start') {
    const headroom = Number.isFinite(state.headroom) && state.headroom >= 1
      ? state.headroom : DEFAULT_HEADROOM
    const free = Number.isFinite(state.freeMb) ? state.freeMb : null
    // 这里**必须**写成 `>= 0`。写成 `> 0` 会把 0 归入 null 那一支，
    //   而这一段的前提正是 0（不占用内存）与 null（未知）必须区分。
    //   这条规则仅写在注释里不够，需要有一条测试守着。
    const need = Number.isFinite(state.needMb) && state.needMb >= 0 ? state.needMb : null

    // 要关闭的那几台会归还内存，所以判断时应当计入。
    //   计入的是它们的**当前**用量（rssMb），不是峰值：峰值是历史
    //     最高值，早已归还系统，按峰值计入会凭空多算，方向危险。
    const freed = evict.reduce((sum, eid) => {
      const r = residents.find((x) => x && x.id === eid)
      return sum + (r && Number.isFinite(r.rssMb) && r.rssMb > 0 ? r.rssMb : 0)
    }, 0)

    if (free != null) {
      const budget = free + freed
      if (need == null) {
        // 从未测量这一台。走 B 路：**不阻止，但要询问**。
        //   不允许在此编造一个「大约需要 4G」的数值去阻止：无法回答
        //     正是走到这一支的原因。编造的数值被采信后，错误会被归因于
        //     平台，而不是归因于「平台没有测量数据」。
        //   让「未知」只发生一次：本次执行完就有了实测值，以后不再询问。
        if (!state.confirmed) {
          return {
            action: 'needs_confirm',
            evict: expired.slice(),   // 见下：注定不启动的请求不为它腾出资源
            reason: '这是第一次启动这台引擎，平台还不知道它要占用多少内存',
            mem: { freeMb: free, needMb: null, budgetMb: budget, headroom },
          }
        }
      } else {
        const want = Math.ceil(need * headroom)
        if (want > budget && !state.confirmed) {
          // 已知需求超过当前预算也不是平台替用户作决定的理由。这里与
          // 「第一次启动、尚无历史数据」统一为一次性风险确认。确认前不为
          // 本次请求驱逐任何仍可用的引擎；确认后才按原计划继续启动。
          return {
            action: 'needs_confirm',
            evict: expired.slice(),
            reason: '系统内存可能不足：这台引擎历史上最多占用过 ' + need +
              ' MB（加余量后为 ' + want + ' MB），当前可用 ' + budget + ' MB',
            mem: { freeMb: free, needMb: need, wantMb: want, budgetMb: budget, headroom },
          }
        }
      }
    }
  }

  return { action, evict, reason }
}

/**
 * 定时清扫：当前有哪些引擎应当释放。
 *
 * 与 planAdmission 中那一处是同一条规则，但不能共用同一段代码：
 *   这里没有「自身」需要保护，那边有。分开实现，各自有测试覆盖。
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
  autoCapFor,
  MB_PER_ENGINE,
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
