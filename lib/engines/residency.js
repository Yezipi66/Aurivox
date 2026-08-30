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

/** 常驻上限的默认值。Owner 2026-08-30：「默认设限 2，理论上不设限」。 */
const DEFAULT_CAP = 2

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
  // 位名排序，保证同一组选择永远拼出同一个键（对象键序不可依赖）。
  return slots
    .map((s) => s.name)
    .sort()
    .map((name) => {
      const v = sel[name]
      return `${name}=${v == null || v === '' ? '' : String(v)}`
    })
    .join('\u0000')
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
 *   cap:       常驻上限
 *   idleMs:    空闲释放阈值
 *   now:       当前时间戳（毫秒）
 * }
 * @returns {{ action:'reuse'|'start'|'relaunch', evict:string[], reason:string }}
 *   evict = 为了给这一台腾地方，必须先关掉的那几台（按最久没用排序）
 */
function planAdmission(state) {
  const residents = Array.isArray(state.residents) ? state.residents.slice() : []
  const cap = Number.isInteger(state.cap) && state.cap > 0 ? state.cap : DEFAULT_CAP
  const idleMs = Number.isInteger(state.idleMs) && state.idleMs > 0 ? state.idleMs : DEFAULT_IDLE_MS
  const now = Number.isFinite(state.now) ? state.now : 0
  const id = state.id
  const key = state.key == null ? '' : String(state.key)

  const me = residents.find((r) => r && r.id === id)

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
  DEFAULT_IDLE_MS,
  MAX_LAUNCH_SLOTS,
  launchSlots,
  callSlots,
  isOnDemand,
  shouldPreload,
  launchKeyOf,
  planAdmission,
  planSweep,
}
