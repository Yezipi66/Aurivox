// 名片表单的自动填：判定与填值都是纯函数。
// 抽出来是因为自动填有四条分支，塞在 React effect 里只能靠点界面验，
// 而点界面验不到「不该填的时候没填」。

// 换引擎时要清掉哪些段：「这台引擎怎么跑」的那部分（runtime / call / models…）。
// id / label / contract_version 是名片自身的声明，留着：清干净不等于清空。
const ENGINE_SPECIFIC_KEYS = [
  'runtime', 'call', 'models', 'maps', 'parameters', 'output_formats',
  'capabilities', 'install', 'upstream',
  // 下面这几个是顶层的单值字段，同样属于「这台引擎怎么跑」，漏掉与漏掉 runtime 同后果。
  'max_chars', 'max_chars_source', 'timeout_ms', 'timeout_ms_source',
  'base_url_env', 'default_base_url', 'weights', 'local_changes',
  'payload_keys', 'defaults', 'defaults_env', 'param_keys', 'params', 'input',
  'dir',
]

// 名片里带下划线开头的键是注释（_comment_xxx），不是内容。
// 换引擎时这些注释描述的是上一台引擎，留着就是误导。
function isCommentKey (key) {
  return key.startsWith('_')
}

/**
 * 换引擎时，把上一台引擎的痕迹从名片里清掉。
 *
 * 清掉：ENGINE_SPECIFIC_KEYS 里的段，以及所有下划线开头的注释键。
 * 保留：id、label、contract_version，以及任何不在上面清单里的段
 *   （清单之外的段留给上层决定，不在这里替平台猜）。
 *
 * @param {object} manifest 当前名片（上一台引擎的）
 * @param {string} nextId 要换成的引擎 id
 * @param {string} [nextLabel] 要换成的引擎 label（不给就用 id）
 * @returns {object} 清干净的新名片（原对象不动）
 */
export function manifestForEngineSwitch (manifest, nextId, nextLabel) {
  const src = manifest || {}
  const next = {}
  for (const k of Object.keys(src)) {
    if (ENGINE_SPECIFIC_KEYS.includes(k)) continue
    if (isCommentKey(k)) continue
    next[k] = src[k]
  }
  next.id = nextId
  // label 用新的：不给就用 id。
  // 不回退到 src.label：那一行是上一台的描述，
  //   留着就是一张「id 是新引擎、label 写着上一台」的名片。
  next.label = nextLabel || nextId
  if (next.contract_version === undefined) next.contract_version = 2
  return next
}

/**
 * 该不该把 runtime.checkpoints 自动填成落盘路径。
 *
 * @param {object} manifest 当前名片
 * @param {string|null} checkpointsPath 第 3 步的落盘路径（相对项目根，后端送来）
 * @returns {boolean} 该填就 true
 */
export function shouldAutoFillCheckpoints (manifest, checkpointsPath) {
  // 落盘路径还没有 ⇒ 没得填
  if (!checkpointsPath) return false
  // 引擎 id 还没定 ⇒ 算不出这一台引擎的落盘路径
  if (!manifest || !manifest.id) return false
  const rt = manifest.runtime || {}
  const current = rt.checkpoints
  // 这一格空着 ⇒ 填。
  if (!current) return true
  // 这一格已经指着别的引擎（路径里的引擎名与当前 id 不一致）⇒ 换引擎留下的残留，改掉。
  const owner = checkpointOwner(current)
  if (owner && owner !== manifest.id) return true
  // 这一格指的就是当前这台 ⇒ 使用者填过或是自动填的，不动它。
  return false
}

/**
 * 从落盘路径里读出它属于哪台引擎。
 *
 * 路径形如 engines/<id>/checkpoints。读不出来（路径不是这一族）就返回 null，
 *   那时按「使用者自己填的」处理，不覆盖。
 *
 * @param {string} path 落盘路径
 * @returns {string|null} 引擎 id；读不出来则 null
 */
export function checkpointOwner (path) {
  if (typeof path !== 'string') return null
  const m = path.match(/^engines[\\/]+([^\\/]+)[\\/]/)
  return m ? m[1] : null
}

/**
 * 填上 runtime.checkpoints。调用前先问 shouldAutoFillCheckpoints。
 *
 * @param {object} manifest 当前名片
 * @param {string} checkpointsPath 第 3 步的落盘路径
 * @returns {object} 填好的新名片（原对象不动）
 */
export function withAutoFilledCheckpoints (manifest, checkpointsPath) {
  const rt = (manifest && manifest.runtime) || {}
  return {
    ...manifest,
    runtime: { ...rt, checkpoints: checkpointsPath },
  }
}
