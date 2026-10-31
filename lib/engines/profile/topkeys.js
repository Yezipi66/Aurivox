'use strict'

// 顶层键白名单 + 量出来的数的 _source 出处守卫。
// checkTopKeys：顶层出现平台不认识的键 ⇒ 当场抛（拼错被静默忽略最难查）。
// checkMeasuredSources / sourceOf：写了 max_chars / timeout_ms / runtime.ready_timeout_ms 就得带 `_source`。

const { profileError } = require('./fields')

// 顶层拼错比 runtime 那一层更值得守：runtime 里拼错至少还会超时，顶层拼错连症状都
// 没有，只是「设了没效果」。名单是已装名片顶层键的并集，加上 registry.js 在读盘时注
// 进来的 `dir`；以 `_` 开头的注释键到不了这里（registry.js 先剥掉了）。
// 加新顶层键必须同时加进这张表：漏加的表现是那台引擎整个装不上，当场抛，不是静默。
// 表按身份 / 来源与本地改动 / 模型位 / 地址 / 预算 / 能力与进程 / 请求体三段 / 界面参数两段 / 输出分块排列；
// 地址那组的 default_base_url 与 base_url_env 是活键，但已在退休路上。
const TOP_KEYS = Object.freeze([
  'contract_version', 'id', 'label', 'dir',
  'upstream', 'local_changes', 'install', 'models',
  'weights',
  'default_base_url', 'base_url_env',
  'max_chars', 'max_chars_source', 'timeout_ms', 'timeout_ms_source',
  'capabilities', 'runtime', 'call',
  'maps', 'languages', 'pron', 'payload_keys', 'defaults', 'defaults_env', 'voice_defaults',
  'param_keys', 'params', 'parameters', 'input',
  'output_formats',
])

// 这里故意没有「已退休的顶层键」表：老名片带着退休键要能照装，就得把那个键名写进
// 活代码，与「退休的键一个字都不许再出现在活代码里」的守卫冲突 ⇒ 归零优先，装不上。

// 拼错的键只给「你是不是想写 X」的提示，不猜着改。
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

// 顶层出现不认识的键当场抛，不静默忽略：`{"max_char": 1}`（少个 s）静默忽略 =
// 作者调了一个不存在的旋钮而毫无察觉。
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

// 量出来的数（max_chars / timeout_ms / runtime.ready_timeout_ms）可以不写，写了就必须
// 带同级 `_source`，取值只能是 measured / upstream / estimated：estimated 被当成
// measured 去信，平台会在引擎还在正常加载时先放弃，排查的人只会去查引擎。
const MEASURED_SOURCES = Object.freeze(['measured', 'upstream', 'estimated'])

// [数据键, _source 键, 所在段名(报错用)]。ready_timeout_ms 在 runtime 段内，不在这张表里。
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
  for (const [key, srcKey] of MEASURED_PAIRS) {
    if (!(key in manifest)) continue // 留空合法，不校验
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
