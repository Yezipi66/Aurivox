'use strict'

// 由引擎名片算出启动计划（解释器、入口、参数、端口），新增引擎无需改启动脚本。
// 纯函数。端口冲突由 tools/cli/start.js 处理：先取期望端口，脚本解决冲突后带最终端口再算一次。
// 监听端口只取 default_base_url，不读 base_url_env（后者是后端连接地址，可能在远程）。
// 走 stdio 的引擎（profile.transport，见 profile.js 的 inferTransport）没有端口：计划里 port / base_url
// 都是 null，进程只能由后端拉起，因为管道只在拉起它的那个进程手里。

const path = require('node:path')
const { resolveRuntimePaths } = require('./envCheck')
const { isOnDemand, shouldPreload } = require('./residency')

function planError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// runtime.args 可用的占位符，未知的直接报错。{profile_json} 供通用宿主 host.py 使用，
// 文件由调用方写出；宿主不自己解析 manifest.json，名片语义只在 Node 侧实现。
const PLACEHOLDERS = Object.freeze([
  'host', 'port', 'root', 'engine_dir', 'checkpoints', 'profile_json',
])

// 值为路径的占位符，展开后用 path.normalize 统一分隔符。
const PATHISH = Object.freeze(['root', 'engine_dir', 'checkpoints', 'profile_json'])

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g

// 从 argv 中成对移除指定标志及其后的值。
function dropFlagPairs(args, flags) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (flags.has(args[i])) { i += 1; continue }
    out.push(args[i])
  }
  return out
}

function expandArg(profile, raw, values, used) {
  let sawPathish = false
  const out = raw.replace(PLACEHOLDER_RE, (whole, name) => {
    if (!PLACEHOLDERS.includes(name)) {
      throw planError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${profile.id} 的 runtime.args 里有平台不认识的占位符 ${whole}` +
        `认识的只有 ${PLACEHOLDERS.map((p) => `{${p}}`).join(' / ')}。` +
        '拼错的占位符如果原样传给引擎，表现是「引擎说某个文件找不到」而不是「manifest.json 写错了」。',
        { id: profile.id, key: 'runtime.args', placeholder: whole })
    }
    const v = values[name]
    if (v === null || v === undefined) {
      throw planError('ENGINE_MANIFEST_INCOMPLETE',
        `引擎 ${profile.id} 的 runtime.args 用了 ${whole}，但 manifest.json 没有给出它的值` +
        (name === 'checkpoints'
          ? '用 {checkpoints} 就必须写 runtime.checkpoints。'
          : `平台算不出 ${whole}。`),
        { id: profile.id, key: 'runtime.args', placeholder: whole })
    }
    if (PATHISH.includes(name)) sawPathish = true
    if (used) used.add(name)
    return String(v)
  })
  return sawPathish ? path.normalize(out) : out
}

// 传输方式：调用方显式给的 opts.transport 优先，否则用名片推出来的 profile.transport。
function transportOf(profile, opts) {
  const asked = opts && opts.transport
  if (asked === 'stdio' || asked === 'http') return asked
  return (profile && profile.transport) === 'stdio' ? 'stdio' : 'http'
}

// 监听地址优先级：stdio（不监听）> 名片 default_base_url > opts.port，都没有则报错。
function parseListen(profile, opts) {
  if (transportOf(profile, opts) === 'stdio') {
    return { host: null, port: null, source: 'stdio' }
  }

  const declared = profile.default_base_url
  if (declared) {
    let u
    try {
      u = new URL(declared)
    } catch {
      u = null
    }
    if (!u || !u.port) {
      throw planError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${profile.id} 的 default_base_url 必须是带端口的地址（如 http://127.0.0.1:9880），` +
        `现在写的是 ${JSON.stringify(declared)}`,
        { id: profile.id, key: 'default_base_url', value: declared })
    }
    return { host: u.hostname, port: Number(u.port), source: 'manifest' }
  }

  // 不猜默认端口：猜出的端口会让 start.ps1 的端口冲突检查失去意义。
  const callerPort = opts && opts.port
  if (callerPort != null) {
    const port = Number(callerPort)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { host: '127.0.0.1', port, source: 'platform' }
    }
    // 端口非法时不在这里报错，交给 buildLaunchPlan 报 ENGINE_LAUNCH_PORT_INVALID。
  }

  throw planError('ENGINE_MANIFEST_INCOMPLETE',
    `引擎 ${profile.id} 的 manifest.json 没有 default_base_url，同时启动调用也没给端口` +
    '平台不知道该让这台引擎监听哪个端口。' +
    '（启动脚本是平台通用宿主时不用写：那种引擎走 stdio，不占端口。）',
    { id: profile.id, key: 'default_base_url', got: 'missing' })
}

/**
 * @param {object} profile  resolveEngineProfile() 的产物
 * @param {object} [opts]  rootDir, port, transport('stdio'|'http'), profileJsonPath, loadParams,
 *   checkpointsOverride：替换 {checkpoints} 的模型目录，launch 位的选择由此生效。
 * @returns {object} launchable 为 false 表示引擎不由平台启动；
 *   profile_json_path 非 null 时，调用方须在 spawn 前写出 buildHostProfile(id)。
 */
function buildLaunchPlan(profile, opts = {}) {
  const rootDir = opts.rootDir || path.resolve(__dirname, '..', '..')

  const listen = parseListen(profile, opts)

  const isStdio = listen.source === 'stdio'

  // 没有 runtime 段：合法状态，引擎由用户自行启动。
  if (!profile.runtime) {
    return {
      id: profile.id,
      label: profile.label,
      launchable: false,
      reason: `${profile.id} 的 manifest.json 没有 runtime 段，这台引擎不由平台启动。`,
      // start.ps1 仍要为它做端口冲突保护，缺这些字段时端口会被当成 0。
      host: listen.host,
      port: listen.port,
      desired_port: listen.port,
      base_url: isStdio ? null : `http://${listen.host}:${listen.port}`,
      base_url_env: profile.base_url_env || null,
      preload: false,
      on_demand: false,
    }
  }

  const port = isStdio ? null
    : (opts.port === undefined || opts.port === null ? listen.port : Number(opts.port))
  if (!isStdio && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw planError('ENGINE_LAUNCH_PORT_INVALID',
      `要给引擎 ${profile.id} 用的端口不是一个合法端口号：${JSON.stringify(opts.port)}`,
      { id: profile.id, port: opts.port })
  }

  const p = resolveRuntimePaths(profile, rootDir)

  // 相对路径按项目根解析（模型登记的是 assets/... 相对路径），不能按引擎 cwd 解析。
  const ckptOverride = opts.checkpointsOverride == null || opts.checkpointsOverride === ''
    ? null
    : path.resolve(rootDir, String(opts.checkpointsOverride))

  const values = {
    host: listen.host,
    port: String(port),
    root: rootDir,
    engine_dir: profile.dir,
    checkpoints: ckptOverride || p.checkpoints,
    profile_json: path.resolve(
      rootDir,
      opts.profileJsonPath || path.join('cache', 'engines', `${profile.id}.profile.json`)),
  }
  // 记录展开时实际命中的占位符；只有用到 {profile_json} 的引擎才需要写该文件。
  const used = new Set()
  // 先校验类型，让报错指向名片字段。空数组合法。
  const rawArgs = profile.runtime.args
  if (!Array.isArray(rawArgs)) {
    throw planError('ENGINE_LAUNCH_ARGS_INVALID',
      `引擎 ${profile.id} 的 manifest.json 写了 runtime 却没写 runtime.args（或者写的不是数组）：` +
      '平台不知道该用什么命令行参数启动。要启动一台引擎，manifest.json 必须说明参数如何拼装；' +
      '若无需参数则写成空数组 []。',
      { id: profile.id, key: 'runtime.args', got: rawArgs === undefined ? 'undefined' : typeof rawArgs })
  }
  for (const a of rawArgs) {
    if (typeof a !== 'string') {
      throw planError('ENGINE_LAUNCH_ARGS_INVALID',
        `引擎 ${profile.id} 的 runtime.args 里有一项不是字符串：${JSON.stringify(a)}` +
        '命令行参数只能是字符串。数字要写成 "9880" 这样带引号的形式。',
        { id: profile.id, key: 'runtime.args', got: typeof a })
    }
  }
  // stdio 下成对移除监听类参数及其值。不能逐个过滤：
  // 剩下孤立的 '--port' 会把下一个参数当成端口号。
  const dropListenFlags = isStdio
  const args0 = dropListenFlags
    ? dropFlagPairs(rawArgs, new Set(['--host', '--port', '--listen', '--bind']))
    : rawArgs
  // 显式传 --stdio，不让宿主从「没有 --port」推断，否则平台分配端口时会被误判。
  const args1 = isStdio && !args0.includes('--stdio') ? args0.concat(['--stdio']) : args0
  const args = args1.map((a) => expandArg(profile, a, values, used))

  // start.ps1 用它在进程命令行里识别自家引擎。走 host.py 的引擎入口相同，
  // 必须用每台唯一的 profile.json 路径，否则会把 A 误认成 B。
  const ownProcessMark = (used.has('profile_json') ? values.profile_json : p.entry)
    .toLowerCase()

  const profileJsonPath = used.has('profile_json') ? values.profile_json : null

  return {
    id: profile.id,
    label: profile.label,
    launchable: true,
    python: p.python,
    entry: p.entry,
    args,
    cwd: p.cwd,
    host: listen.host,
    port,
    // 名片的期望端口，冲突挪动后可能与 port 不同。
    desired_port: listen.port,
    base_url: isStdio ? null : `http://${listen.host}:${port}`,
    ready_url: isStdio ? null
      : `http://${listen.host}:${port}${profile.runtime.ready_endpoint}`,
    // stdio 的探活走管道，要的是路径本身（engineChannel.js 的 probe）。
    ready_endpoint: profile.runtime.ready_endpoint,
    transport: isStdio ? 'stdio' : 'http',
    ready_timeout_ms: profile.runtime.ready_timeout_ms,
    own_process_mark: ownProcessMark,
    base_url_env: profile.base_url_env || null,
    // 是否开机预热、是否按需启动并空闲释放，规则见 residency.js。
    preload: shouldPreload(profile),
    on_demand: isOnDemand(profile),
    checkpoints: values.checkpoints,
    load_params: opts.loadParams || {},
    profile_json_path: profileJsonPath,
  }
}

module.exports = { buildLaunchPlan, transportOf, PLACEHOLDERS, PATHISH }
