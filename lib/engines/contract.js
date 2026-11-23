'use strict'

// 名片契约 v0.1.1：磁盘上是三大节，内存里仍是旧扁平视图。
//
// 磁盘（唯一真相）：
//   registration  不启动引擎就能回答的静态声明：身份 / 环境落点 / 权重位 / 预算 / 能力
//   invocation    调用字段，kind 二选一，python 或 cli 整支落盘，各自带自己的 parameters[]
//   acceptance    第 5 步真跑结论，扁平标量，不记时效状态
//
// 内存（派生，不落盘）：
//   fromV011() 把三节摊平成老代码认识的形状（顶层 id / runtime / call / parameters ...），
//   让 registry / profile / hostProfile / 向导表单 / web 都不用改。
//   toV011()  反向，保存时把扁平视图收成三节。
//
// 单一真相只认磁盘三节。内存扁平是每次读盘现算的投影，不写回去，所以不会出现
// 「两个字段各自漂移」。cwd 只有一个：registration.environment.cwd；调用时 host 用它，
// 启动时 spawn 用它，acceptance.weights 的相对路径也以它为基准。
//
// 本文件不出现任何具体引擎名。

const CONTRACT_VERSION = 4

// 这组键属于静态注册信息：不启动引擎就能回答。
const REGISTRATION_KEYS = Object.freeze([
  'id', 'label', 'upstream', 'local_changes', 'install', 'models', 'weights',
  'default_base_url', 'base_url_env',
  'max_chars', 'max_chars_source', 'timeout_ms', 'timeout_ms_source',
  'capabilities', 'runtime',
  'maps', 'input', 'output_formats',
])

// 调用分支自己的字段；parameters[] 归当前 kind 那一支，形态由父节点决定，
// 不再需要扁平结构下的 scan_kind 标记。
// 拆两组：call.* 在扁平视图里属于 call 对象，参数声明在扁平视图里属于顶层。
const CALL_KEYS = Object.freeze([
  'module', 'class', 'method', 'methods', 'default_method',
  'init_args', 'bind', 'argv', 'args', 'text_via', 'returns',
  'generator_sample_rate', 'seed', 'weights',
])
const PARAM_DECL_KEYS = Object.freeze([
  'parameters', 'param_keys', 'payload_keys', 'params', 'defaults', 'defaults_env',
])
const INVOCATION_KEYS = Object.freeze(['kind'].concat(CALL_KEYS, PARAM_DECL_KEYS))
// 形态自身的名字。磁盘上 invocation 只写其中一支，另一支不落盘。
const BRANCH_BY_KIND = Object.freeze({ python: 'python', cli: 'cli' })

function isV011(obj) {
  return Boolean(obj && typeof obj === 'object' && !Array.isArray(obj)
    && obj.registration && typeof obj.registration === 'object')
}

function pickKeys(src, keys) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k]
  return out
}

// 合并两个 cwd：v0.1.1 之前名片可能两个都写（值相同或不同）。
// 取调用目录 call.cwd 优先：那是引擎代码真正运行的位置；启动目录只决定
// 进程从哪儿起来，两者合并后以运行目录为准，避免 voxcpm 那类 CLI 找不到相对路径的模型。
function mergedCwd(registration, branch) {
  const env = registration && registration.environment
  if (env && Object.prototype.hasOwnProperty.call(env, 'cwd')) return env.cwd
  const runtime = registration && registration.runtime
  const call = branch || {}
  if (call.cwd !== undefined && call.cwd !== null) return call.cwd
  if (runtime && Object.prototype.hasOwnProperty.call(runtime, 'cwd')) return runtime.cwd
  return undefined
}

/**
 * 三节 → 老扁平视图。已经是扁平的输入原样返回（幂等）。
 * acceptance 不进扁平视图：那是验收事实，不是注册声明；时效由读取侧现算。
 */
function fromV011(raw) {
  if (!isV011(raw)) return raw
  const reg = raw.registration || {}
  const inv = raw.invocation || {}
  const kind = inv.kind
  const hasBranch = kind === 'cli' || kind === 'python'
  const branch = (hasBranch && inv[kind] && typeof inv[kind] === 'object') ? inv[kind] : {}
  // 没有调用形态的引擎（自带服务、不由通用宿主调用）：参数声明挂在 invocation 顶层，
  // 摊平回老视图时不造 call，和原名片「没有 call 段」保持一致。
  const declSource = hasBranch ? branch : inv

  // environment 是 runtime 的新家；扁平视图里还要叫 runtime。
  const regFlat = pickKeys(reg, REGISTRATION_KEYS.filter((k) => k !== 'runtime'))
  const environment = (reg.environment && typeof reg.environment === 'object') ? reg.environment : {}
  const runtime = Object.assign({}, environment, reg.runtime || {})
  const cwd = mergedCwd(reg, hasBranch ? branch : null)
  if (cwd !== undefined) runtime.cwd = cwd
  else delete runtime.cwd

  // 参数声明在老扁平视图里是顶层字段。
  const out = Object.assign({}, regFlat, pickKeys(declSource, PARAM_DECL_KEYS))
  out.runtime = runtime
  if (hasBranch) {
    // 老扁平视图里这些字段在 call 对象内，不在顶层。
    const call = pickKeys(branch, CALL_KEYS)
    call.kind = kind
    if (cwd !== undefined) call.cwd = cwd
    else delete call.cwd
    out.call = call
  }
  // 注释键（_ 开头）原样带过去，不挑名字：写给人看的说明不该被契约投影删掉。
  for (const k of Object.keys(raw)) {
    if (k.startsWith('_')) out[k] = raw[k]
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'contract_version')) {
    out.contract_version = raw.contract_version
  }
  return out
}

/**
 * 老扁平视图 → 三节。已经是三节的输入原样返回（幂等）。
 * acceptance 单独带过去，不参与投影。
 */
function toV011(flat, opts = {}) {
  if (isV011(flat)) {
    // 三节输入幂等；但显式给了 acceptance 时要能替换它（第 5 步写入用）。
    if (opts.acceptance && typeof opts.acceptance === 'object') {
      return Object.assign({}, flat, { acceptance: opts.acceptance })
    }
    return flat
  }
  const src = flat || {}
  const reg = pickKeys(src, REGISTRATION_KEYS)
  const environment = Object.assign({}, src.runtime || {})
  delete reg.runtime

  // cwd 合并：调用目录 call.cwd 优先于启动目录 runtime.cwd。
  // 直接按源取，不走 mergedCwd（那个是给「三节→扁平」用的，优先级相反会选错）。
  const callSrc = src.call && typeof src.call === 'object' ? src.call : {}
  let cwd
  if (callSrc.cwd !== undefined && callSrc.cwd !== null) cwd = callSrc.cwd
  else if (environment.cwd !== undefined && environment.cwd !== null) cwd = environment.cwd
  delete environment.cwd

  const kind = callSrc.kind === 'cli' ? 'cli' : (callSrc.kind === 'python' ? 'python' : null)
  const invocation = { kind }
  if (kind) {
    const branch = pickKeys(callSrc, CALL_KEYS)
    for (const k of PARAM_DECL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src, k)) branch[k] = src[k]
    }
    invocation[BRANCH_BY_KIND[kind]] = branch
  } else {
    // 自带服务、不由通用宿主调用：没有调用分支，参数声明留顶层。
    for (const k of PARAM_DECL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src, k)) invocation[k] = src[k]
    }
  }

  const out = {
    contract_version: CONTRACT_VERSION,
    registration: reg,
    invocation,
  }
  if (cwd !== undefined) environment.cwd = cwd
  if (Object.keys(environment).length) reg.environment = environment

  const preserved = Object.keys(src).filter((k) => k.startsWith('_'))
  for (const k of preserved) out[k] = src[k]
  if (opts.acceptance && typeof opts.acceptance === 'object') out.acceptance = opts.acceptance
  return out
}

/** 从名片（三节或扁平）取 id。 */
function idOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  if (isV011(raw)) return raw.registration && raw.registration.id
  return raw.id
}

/** 从一个读进来的名片（三节或扁平）取验收记录，没有就 null。 */
function acceptanceOf(raw) {
  if (!isV011(raw)) return null
  return raw.acceptance && typeof raw.acceptance === 'object' ? raw.acceptance : null
}

/** 取唯一的引擎环境目录（相对项目根），供权重相对路径与向导展示使用。 */
function engineCwdOf(raw) {
  if (isV011(raw)) return mergedCwd(raw.registration || {}, null)
  return mergedCwd({ runtime: raw && raw.runtime }, raw && raw.call)
}

module.exports = {
  CONTRACT_VERSION, isV011, fromV011, toV011, idOf, acceptanceOf, engineCwdOf,
}
