// 名片表单的自动填：判定与填值都是纯函数，好测。
//
// 这一份从 ManifestForm.jsx 里抽出来，因为自动填的判定有四条分支，
// 塞在 React effect 里就只能靠点界面来验，而点界面验不到「不该填的时候没填」。

// 名片里哪些段是「这台引擎自己的」。
//
// 为什么要按段分：换引擎时，上一台引擎的名片内容必须清干净，
// 但清干净不等于清空。id、label、contract_version 这些是「这张名片长什么样」，
// 与哪台引擎无关；runtime、call、models、maps、parameters 这些是「这台引擎怎么跑」，
// 换引擎就得清掉。
//
// 判据依据：平台验的是 runtime / call / capabilities / models / maps / parameters
// 这些段（lib/engines/profile.js 的 profileTopKeys）。id / label / contract_version
// 是名片自身的声明（lib/engines/profileTopKeys.node.test.js 单独断言过它们是顶层键）。
//
// 不按「逐个键名硬编码要清的字段」来清：那清单会漏，漏一个就是上一台引擎的
//   残留混进这一台的名片。按「段」分，清一次就清全。
const ENGINE_SPECIFIC_KEYS = [
  'runtime', 'call', 'models', 'maps', 'parameters', 'output_formats',
  'capabilities', 'install', 'upstream',
  // 下面这几个是顶层的单值字段，同样是「这台引擎怎么跑」的参数：
  //   max_chars / timeout_ms 是这台引擎的预算；
  //   base_url_env / default_base_url 是这台引擎的地址；
  //   weights 是这台引擎的模型位；
  //   local_changes 是这台引擎相对上游改了什么。
  // 漏掉它们的后果与漏掉 runtime 一样：换引擎后表单里留着上一台的值。
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
  // runtime 段不在 ⇒ 不填。checkpoints 是「由平台启动」的配置：
  //   磁盘上读进来的名片可能整段没有 runtime（引擎自行起，平台 parseRuntime
  //   视为合法态），这里若替他把段造出来，等于把一张自行启动的名片悄悄改成
  //   平台启动形态。平台启动的路径上，换引擎时代填已把 runtime 段建好，
  //   这里照样填得进。
  if (!manifest.runtime) return false
  const rt = manifest.runtime || {}
  const current = rt.checkpoints
  // 这一格空着 ⇒ 填。
  if (!current) return true
  // 这一格已经指着一台别的引擎 ⇒ 改掉。
  //   落盘路径是 engines/<id>/checkpoints 这一族，路径里的引擎名与当前
  //   名片的 id 不一致 ⇒ 这一格是换引擎时留下的上一台的残留。
  //   换成当前 id 对应的那一份，否则表单里留着上一台的权重路径。
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

// 平台代填的启动三件套。值不是拍的，是本仓库自己的惯例：
//   环境目录 = engines/<id>/.venv（envDetect 建环境用的同一个推导，现有名片全同款）；
//   启动脚本 = ../../lib/engines/host.py（平台通用宿主，一份对所有引擎，模板同款；
//              引擎自带服务脚本的才改，比如老引擎自己的 infer_server）；
//   就绪端点 = /health（宿主自带，lib/engines/host.py 的路由表里有）。
// 就绪等待（ready_timeout_ms）故意不代填：各引擎 180s~240s 不等，冷启动快慢是
// 引擎自己的特性，猜了就得改；而且它是「写了就必须写出处」的数，代填等于编来源。
export function runtimeLaunchDefaults (id) {
  return {
    python: `engines/${id}/.venv`,
    entry: '../../lib/engines/host.py',
    ready_endpoint: '/health',
  }
}

/**
 * 新名片代填启动三件套。只在 runtime 段缺着时填：
 * 磁盘上读进来的名片（包括自行启动、整段没有 runtime 的）一律不动，
 * 使用者已经填过的段也不动。只在「换引擎刚清出一张新名片」这一刻用。
 *
 * @param {object} manifest 刚清干净的新名片
 * @returns {object} 代填后的名片（原对象不动；没 id 或已有 runtime 时原样返回）
 */
export function withLaunchDefaults (manifest) {
  if (!manifest || !manifest.id) return manifest
  if (manifest.runtime) return manifest
  return { ...manifest, runtime: runtimeLaunchDefaults(manifest.id) }
}

/**
 * capabilities.reference_clip_seconds 的默认答案：没表态就当「不限制」。
 *
 * 平台要求这个键必须存在，漏写会被拒（lib/engines/profile.js 的
 * 「忘了写」和「不限制」必须能区分开）。但那是给手写名片的护栏：
 * 向导的立场是替使用者把默认答案写明，表单里那一格开局就显示
 * 「不限制」，使用者不需要去找 null，只有要限长度的引擎才动它。
 *
 * 只在 capabilities 段已存在且键缺失时补 null；没有 capabilities 段的
 * 名片不动：那段的其他必填项（requires_reference_audio 等）会先被
 * 校验拦下，等使用者填第一格 capabilities 时会重新过这里。
 *
 * @param {object} manifest 当前名片
 * @returns {object} 补了默认答案的名片（原对象不动；无需补时原样返回）
 */
export function withClipAnswered (manifest) {
  if (!manifest || !manifest.capabilities) return manifest
  if ('reference_clip_seconds' in manifest.capabilities) return manifest
  return {
    ...manifest,
    capabilities: { ...manifest.capabilities, reference_clip_seconds: null },
  }
}

/**
 * 扫描认出了参考音频参数 ⇒ 推断这台引擎需要参考音频。
 *
 * 为什么敢推断：requires_reference_audio 的含义是「没有参考音频的请求要不要拦」，
 * 而扫描认出 ref_audio 槽位（voice / ref_audio / prompt_wav / spk 这族参数名）
 * 本身就是「这台引擎的合成入口要一份参考录音」的证据。现有名片全数印证：
 * maps 里提到参考音频的引擎，capabilities.requires_reference_audio 都是 true。
 *
 * 只在值没写时填：名片里已经写了（哪怕是 false）一律不动，
 * 那是使用者或已有名片的明确表态，扫描无权推翻。
 *
 * @param {object} manifest 当前名片
 * @param {string|null} matchedRefAudio 扫描认出的参考音频参数名（scanAutofill 的 matched.ref_audio）
 * @returns {object} 推断后的名片（原对象不动；无证据或已表态时原样返回）
 */
export function withInferredRefAudio (manifest, matchedRefAudio) {
  if (!manifest || !matchedRefAudio) return manifest
  const caps = manifest.capabilities || {}
  if (caps.requires_reference_audio !== undefined) return manifest
  return {
    ...manifest,
    capabilities: { ...caps, requires_reference_audio: true },
  }
}
