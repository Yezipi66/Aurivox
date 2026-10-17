'use strict'

// ---------------------------------------------------------------------------
// 顶层键白名单 + 实测数的 _source 出处守卫
// ---------------------------------------------------------------------------
// checkTopKeys：顶层出现平台不认识的键 ⇒ 当场抛（拼错被静默忽略最难查）。
// checkMeasuredSources / sourceOf：写了 max_chars / timeout_ms /
// runtime.ready_timeout_ms 就必须带同级 `_source`。
// 依赖 ./fields 的 profileError。
// 纪律同 profile.js 顶部那条：本文件里不许出现任何具体引擎的名字。

const { profileError } = require('./fields')

// ---------------------------------------------------------------------------
// 顶层也要有白名单
// ---------------------------------------------------------------------------
// `runtime` 段早就有 RUNTIME_KEYS 了（上面那一段），理由写得很清楚：
// 拼错被静默忽略，表现成「平台反复查询却一直等到超时」而名片看着完全正常。
// 但顶层一直没有这道闸。写 `"max_char": 1`（少个 s）今天的表现是：
// 名片解析成功、平台照常起、然后用它自己那个默认的分段长度去切文本
// 作者调了一个不存在的键，一声不吭。
// 这比 runtime 那一层更值得守：runtime 里拼错至少还会超时，
// 顶层拼错连症状都没有，只是「设了没效果」。
// 名单的来源是量出来的，不是想出来的：三张真名片（gpt-sovits 19 键 /
// indextts2 21 键 / _TEMPLATE 22 键）的并集，加上 registry.js:60-61
// 在读盘时注进来的 `dir`（`id` 它也会覆写，本来就在表上）。
// 以 `_` 开头的注释键到不了这里：registry.js:29 的 stripComments 先剥掉了。
// 加一个新的顶层键时，必须同时加进这张表。漏加的表现是那台引擎
// 整个装不上（当场抛）， 不是静默，这是故意的：一个响的错好过一个哑的。
const TOP_KEYS = Object.freeze([
  // 身份
  'contract_version', 'id', 'label', 'dir',
  // 来源与本地改动（C10）
  'upstream', 'local_changes', 'install', 'models',
  // 模型位
  'weights',
  // 地址（ §5.9 五：这两个键在退休路上，A3/C4 会来拆；今天仍然是活键）
  'default_base_url', 'base_url_env',
  // 预算
  'max_chars', 'max_chars_source', 'timeout_ms', 'timeout_ms_source',
  // 能力与进程
  'capabilities', 'runtime', 'call',
  // 请求体三段
  'maps', 'payload_keys', 'defaults', 'defaults_env',
  // 界面参数两段
  'param_keys', 'params', 'parameters', 'input',
  // 输出
  'output_formats',
])

// 这里故意没有一张「已退休的顶层键」表：
// 我试过一版：仿照 `capabilities.hot_swap_models` 的退休路，让删掉的那个
// 顶层键「照装 + 提醒一次」，好让上游作者手上的老名片不至于突然装不上。
// 它当场撞上的归零守卫（`synthesis.engineRequired.node.test.js:465`：
// 全仓库活代码不许再出现那个词）：因为「提醒一次」这条路必须把那个词
// 写进活代码，否则提醒不出名字来。
// 两条规矩在这里是真的打架， 不是我实现错了：
// 退休路说「老名片照装，别让一次删除损坏别人的引擎」
// A1 归零说「那个词一个字都不许再出现，否则它会从后门爬回来」
// 今天按 A1 优先处理（我不改那条守卫来让自己的代码过）。
// ⇒ 老名片写着那个键 ⇒ 装不上，报的是下面那句「顶层有个平台不认识的键」。
// 预言：那句话指名道姓、还列全了认识的键，作者删掉那一行就能装
// 代价是他不知道那个键曾经是什么意思。
// 与 hot_swap_models 的处理不一致（那个是照装+提醒），
// 两者的区别今天只有一条：那个词没有归零守卫盯着。 这不是理由，是现状。

// 拼错的键要给出「你是不是想写 X」。 不猜着改，只提示。
// 经典的 Levenshtein，名单只有二十来个词、一台引擎解析一次，代价忽略不计。
function editDistance(a, b) {
  const m = a.length
  const n = b.length
  let prev = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

function nearestKey(bad) {
  let best = null
  let bestD = Infinity
  for (const k of TOP_KEYS) {
    const d = editDistance(bad, k)
    if (d < bestD) { bestD = d; best = k }
  }
  // 距离 3 以上就不是拼错了，是另一个词：别把无关的键"猜"成某个已知键。
  return bestD <= 3 ? best : null
}

/**
 * 顶层键白名单。 不认识的键当场抛，不静默忽略。
 *
 * 判据：`{"max_char": 1}`（少个 s）必须报错。
 * 静默忽略它 = 作者调了一个不存在的旋钮而毫无察觉，
 * 这正是 C11 要杀的那类「设了没效果」。
 */
function checkTopKeys(manifest) {
  for (const k of Object.keys(manifest)) {
    if (TOP_KEYS.includes(k)) continue
    const guess = nearestKey(k)
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 顶层有一个平台不认识的键：${k}` +
      (guess ? `是不是想写 ${guess}？` : '。') +
      ' 平台不静默忽略它：忽略的表现是「你设了它，但什么都没发生」，' +
      '而名片看上去完全正常，这是最难查的一类问题。' +
      `认识的顶层键只有这 ${TOP_KEYS.length} 个：${TOP_KEYS.join(' / ')}。` +
      '（要写给人看的注释，用 _ 开头：那种键读盘时就被剥掉了。）',
      { id: manifest.id, key: k, did_you_mean: guess })
  }
}

// ---------------------------------------------------------------------------
// 实测得来的数，填了就必须带 `_source`
// ---------------------------------------------------------------------------
// 名片里有三个数，接引擎的人第一次是填不出来的（`max_chars` /
// `timeout_ms` / `runtime.ready_timeout_ms`），都得跑过才知道。C13.2 的规矩：
// 这些数可以不写（C13.1，另说）；但写了就必须说明出处：同级必须有
// 对应的 `_source`（`max_chars_source` / `timeout_ms_source` /
// `ready_timeout_ms_source`），取值只能是 `measured` / `upstream` / `estimated`。
// 为什么要守：一个 `estimated` 被当成 `measured` 去信，表现是「引擎明明
// 还在正常加载，平台先放弃了」，排查的人去查引擎、不会怀疑这个数
// 出处本身就是判据的一部分。
// C13.1「留空合法 + 保守默认值」本轮暂缓：今天 `timeout_ms` /
// `max_chars` 仍是 `required()`（缺就抛），而 `max_chars` 的保守值契约自己
// 说「没有答案，明记的账」。这轮只落 C13.2 的出处守卫，不动默认值回退。
// 本函数里不许出现任何一台引擎的 id：出处规则对所有引擎通用。
const MEASURED_SOURCES = Object.freeze(['measured', 'upstream', 'estimated'])

// [数据键, _source 键, 所在段名(报错用)]。ready_timeout_ms 在 runtime 段内。
const MEASURED_PAIRS = Object.freeze([
  ['max_chars', 'max_chars_source', 'manifest.json 顶层'],
  ['timeout_ms', 'timeout_ms_source', 'manifest.json 顶层'],
])

function sourceOf(obj, sourceKey, segment) {
  if (!obj || !(sourceKey in obj)) return null
  const v = obj[sourceKey]
  if (!MEASURED_SOURCES.includes(v)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${obj._idForMsg || '<engine>'} 的 ${segment}${sourceKey} 写的是 ${JSON.stringify(v)}` +
      `必须是 ${MEASURED_SOURCES.join(' / ')} 之一（measured=本项目实测，upstream=上游文档写的，estimated=推算/经验拍）。` +
      ' 不认识的出处值不能默默当实测用：一个 estimated 被当成 measured 去信，' +
      '平台会提前放弃一个实际还在正常加载的引擎。',
      { key: sourceKey, value: v, allowed: MEASURED_SOURCES })
  }
  return v
}

function checkMeasuredSources(manifest) {
  // 顶层两个：max_chars / timeout_ms
  for (const [key, srcKey] of MEASURED_PAIRS) {
    if (!(key in manifest)) continue // C13.1 留空合法，不校验
    if (!(srcKey in manifest)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 manifest.json 顶层写了 ${key} 但没有 ${srcKey}` +
        `${key} 是跑过才知道的数，写了就必须说明它怎么来的（measured / upstream / estimated），` +
        '否则半年后没人分得清这是量出来的还是拍出来的。' +
        '（如果尚未测量，把这一行删掉即可，平台会用保守值。）',
        { id: manifest.id, key, missing_source: srcKey })
    }
    sourceOf(manifest, srcKey, 'manifest.json 顶层')
  }
  // runtime 段：ready_timeout_ms
  const r = manifest.runtime
  if (r && 'ready_timeout_ms' in r) {
    if (!('ready_timeout_ms_source' in r)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 manifest.json runtime 段写了 ready_timeout_ms 但没有 ready_timeout_ms_source` +
        '同理，写了就得说明出处。',
        { id: manifest.id, key: 'runtime.ready_timeout_ms', missing_source: 'runtime.ready_timeout_ms_source' })
    }
    sourceOf(Object.assign({ _idForMsg: manifest.id }, r), 'ready_timeout_ms_source', 'runtime 段')
  }
}

module.exports = {
  editDistance, nearestKey, checkTopKeys, sourceOf, checkMeasuredSources,
}
