'use strict'

// ---------------------------------------------------------------------------
//  Launch plan —— 「起哪台引擎、拿什么起」从名片算出来
// ---------------------------------------------------------------------------
//
// 这个文件在还契约 §9 的账：**平台的启动脚本里写死了某一台引擎的知识**。
// 搬家前 tools/scripts/start.ps1 里躺着这四样，全是 GPT-SoVITS 专有的：
//
//   :49  $ENGINE_SCRIPT = ...\lib\inference\infer_server.py   ← 入口
//   :52  $ENGINE_PORT   = 9880                                ← 端口
//   :149 $hay.Contains('infer_server.py')                     ← 认自家进程
//   :283 @($ENGINE_SCRIPT,'-a',$H,'-p',$P,'-c',$ENGINE_CFG)   ← 命令行
//
// 它们合起来其实是**一张没写在名片上的名片**。第三台引擎的作者会发现：
// 名片写完了，引擎还是起不来，因为得改 start.ps1 —— 而那正是「加一台引擎
// 不碰 lib/」这条标准要挡住的事。
//
// ⭐⭐ 这一刀的边界：只搬「起什么」，不搬「怎么起」。
//
// start.ps1 里另外那 90 行端口逻辑（Test-Port / Get-ListenerPid /
// Resolve-Port / Test-IsOwnProcess）**一行都不动**。它们是被真机 bug 打磨
// 出来的 Windows 专有知识 —— 只认 LISTENING 不认 TIME_WAIT（修「点 Stop
// 再 Start 两次」那个 bug）、Get-NetTCPConnection 不可用时退回解析 netstat、
// 能区分「我上次留下的」和「别人占了」。把它们重写成 Node 我做不到
// 「行为一个字节不变」：这台机器是 Linux，netstat -ano 的输出长什么样我
// 验不了。⛔ 这和 2b 那个 symlink 坑是同一个形状 —— Windows-only 的失败
// 模式，在这里结构上验不出来，就不该在这里重写。
//
// 所以本文件是一个**纯函数**：名片进，计划出。不 spawn、不联网、不读环境
// 变量（除了下面那条明确说明的），因此可以在任何机器上被测穷。
//
// ---------------------------------------------------------------------------
//  ⭐⭐ 「听哪儿」和「连哪儿」是两件事
// ---------------------------------------------------------------------------
//
// profile.base_url 回答的是「合成请求发到哪儿」（连），它会被 base_url_env
// （GPT_SOVITS_BASE_URL）顶掉 —— 那是给「引擎在别的机器上/别人起的」用的。
//
// 本文件要的是「这台引擎自己该监听哪个端口」（听），只能来自名片声明的
// default_base_url。⛔ 绝不能读 base_url_env：
//
//   如果有人把 GPT_SOVITS_BASE_URL 指向一台远程引擎，今天 start.ps1 仍然
//   会在本地 9880 起一台（然后把那个变量覆盖掉）。要是这里改成听 env，
//   就会变成「在本地起一台监听远程端口号的引擎」—— 既不是用户想要的，
//   也是行为变更。
//
// 这个区分不是洁癖：它是 base_url_env 这个机制今天唯一没被写下来的边界。

const path = require('node:path')
const { resolveRuntimePaths } = require('./envCheck')
const { isOnDemand, shouldPreload } = require('./residency')

function planError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// args 里允许出现的占位符。⛔ 和 RUNTIME_KEYS 同一个道理：不认识的占位符
// **必须抛**，不能原样留着。留着的后果是 python 收到一个字面量 "{prot}"
// 当路径去打开，报一句 FileNotFoundError，而名片看着完全正常。
//
// ⭐⭐ `{profile_json}` —— 通用宿主 lib/engines/host.py 专用的那一个
//   它和另外五个**来路不同**：那五个平台自己算得出来（端口、目录），
//   这一个的值是**一份要先落到盘上的文件**（hostProfile.js 的产物）。
//   ⇒ 本文件是纯函数，不写盘：这里只负责把路径展开进 args，并在计划里
//     挂一面旗子 `profile_json_path`，告诉调用方「spawn 之前你得把它写出来」。
//     真正落盘在 engine-launch-plan.cjs（它本来就是有副作用的那一层）。
//
//   ⛔ 为什么不让 host.py 自己去读 manifest.json：契约 §4 第 4 步
//     「平台不许把猜测当成已确认直接装上 / 没被点过头的绑定 = 没装」。
//     宿主自己读到的是**没有确认状态**的原始名片，等于把「我猜是这个」
//     当「人说是这个」用。名片语义只能有一份实现，在 Node 这边。
const PLACEHOLDERS = Object.freeze([
  'host', 'port', 'root', 'engine_dir', 'checkpoints', 'profile_json',
])

// 展开后需要按本机分隔符规整的那几个 —— 它们的值是路径。
// 例：名片写 "{root}/lib/inference/tts_infer.yaml"，在 Windows 上展开成
// "D:\...\lib/inference/tts_infer.yaml"（混着两种分隔符），normalize 之后
// 才等于 start.ps1 里 Join-Path 拼出来的那个字符串。
// ⚠ profile_json 必须在这张表里：它是路径。只进 PLACEHOLDERS 不进 PATHISH，
//   Windows 上会传出 "D:\...\cache/engines/x.profile.json" 这种混分隔符的串。
const PATHISH = Object.freeze(['root', 'engine_dir', 'checkpoints', 'profile_json'])

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g

// ⭐ 从 argv 里丢掉「标志 + 它的值」成对出现的那些。
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
        `引擎 ${profile.id} 的 runtime.args 里有平台不认识的占位符 ${whole} —— ` +
        `认识的只有 ${PLACEHOLDERS.map((p) => `{${p}}`).join(' / ')}。` +
        '拼错的占位符如果原样传给引擎，表现是「引擎说某个文件找不到」而不是「manifest.json 写错了」。',
        { id: profile.id, key: 'runtime.args', placeholder: whole })
    }
    const v = values[name]
    if (v === null || v === undefined) {
      throw planError('ENGINE_MANIFEST_INCOMPLETE',
        `引擎 ${profile.id} 的 runtime.args 用了 ${whole}，但 manifest.json 没有给出它的值 —— ` +
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

// 从名片声明的 default_base_url 里取出「该监听哪儿」。
// ⭐ 刀 A3（2026-09-01）：default_base_url 变为**可选**——名片没写它时，
//   平台由 opts.port 提供监听端口（平台分配端口 → 写进 base_url_env）。
//   名片写了就用名片的值；两份都没有 ⇒ 才算不完整，此时才抛。
function parseListen(profile, opts) {
  // ⭐⭐ stdio 传输：引擎**不监听任何 TCP 端口**。
  //   ⛔ 绝不能回落成 127.0.0.1:<名片端口>：stdio 下没人听那个端口，
  //     而「连不上」和「连上了别人的引擎」症状完全不同 ——
  //     前者会超时（安全），后者会静默给出别人的答案（危险）。
  if ((opts && opts.transport) === 'stdio') {
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

  // 名片没写 default_base_url：⚠ 由平台通过 opts.port 传进来。
  // ⛔ 这里不能凭空猜一个默认端口（0、9880 都不行），否则端口冲突保护
  //   （start.ps1 的 Resolve-Port）会拿一个猜出来的端口去问「有人在听吗」，
  //   永远没有冲突——那正是端口保护静默失效的经典形态。
  const callerPort = opts && opts.port
  if (callerPort != null) {
    const port = Number(callerPort)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { host: '127.0.0.1', port, source: 'platform' }
    }
    // 端口非法 ⇒ 不在这抛（这里抛会报「名片不完整」误导），让外层
    // buildLaunchPlan 统一报 ENGINE_LAUNCH_PORT_INVALID（第 239-243 行）。
  }

  throw planError('ENGINE_MANIFEST_INCOMPLETE',
    `引擎 ${profile.id} 的 manifest.json 没有 default_base_url，同时启动调用也没给端口 —— ` +
    '平台不知道该让这台引擎监听哪个端口。' +
    '（这是刀 A3 之后的合法形态：名片可不写 default_base_url，改由平台分配端口；' +
    '平台要调用方在 buildLaunchPlan({ port }) 那一步把分配好的端口传进来。）',
    { id: profile.id, key: 'default_base_url', got: 'missing' })
}

/**
 * 算出「怎么把这台引擎起起来」。
 *
 * @param {object} profile  resolveEngineProfile() 的产物
 * @param {object} [opts]
 *   @param {string} [opts.rootDir]  项目根；默认按本文件位置推
 *   @param {number} [opts.port]     实际要用的端口。不传就用名片声明的那个。
 *   @param {string} [opts.profileJsonPath]  覆盖名片解析结果的落盘位置。
 *     不传就是 <root>/cache/engines/<id>.profile.json —— 纯算出来的，
 *     所以调用方**没有可忘的东西**。
 *     ⭐ 只有名片 args 里真的用了 {profile_json} 才会被取用；没用到就完全
 *       不影响结果（传了也不会凭空多出一个字段）。
 *     ⇒ 计划里回一个 `profile_json_path`：**它在 = 调用方 spawn 之前必须
 *       把 buildHostProfile(id) 写到那儿**。不在 = 这台引擎不需要。
 *   @param {string} [opts.checkpointsOverride]  这一次要用哪一份模型。
 *     ⭐⭐⭐ 顶替 {checkpoints} 展开出来的那个目录。
 *
 *     为什么是"顶替底模目录"而不是新加一个占位符：一台引擎的模型位如果
 *     标着 applies_at:"launch"，它说的就是「这个进程要装哪一份模型」；
 *     而"这个进程装哪一份"，在名片上表达出来**就是它的 checkpoints 指向
 *     哪儿**（IndexTTS2 的 init_args 里 cfg_path 和 model_dir 两个都是从
 *     {checkpoints} 长出来的）。⇒ 上游一行都不用改，因为这正是作者自己
 *     换模型时会做的事：换个目录再起一遍。
 *
 *     ⚠ 代价说清楚：这条路要求**被选中的那个目录长得跟原厂底模目录一样**
 *       （名片 init_args 从 {checkpoints} 拼出来的每个文件都得在）。少了
 *       文件的话，报错来自引擎自己（找不到 config.yaml 之类），平台原样
 *       传回去 —— 这比平台自己编一句"模型无效"要准，因为只有引擎知道它
 *       缺的是哪一个文件。
 *
 *     ⛔ 不传 = 用名片声明的底模目录，行为一个字节不变。
 *

 * ⭐ 为什么 port 可以从外面塞进来：端口冲突的判定（我的旧进程 / 别人的进程 /
 *   往上挪一个）留在 start.ps1 里，见本文件顶部。所以调用顺序是
 *   「先问名片要期望端口 → 脚本解决冲突 → 再带着定下来的端口问一次完整计划」。
 *   两次调用都是纯函数，没有隐藏状态。
 */
function buildLaunchPlan(profile, opts = {}) {
  const rootDir = opts.rootDir || path.resolve(__dirname, '..', '..')

  // ⭐ 地址先算，它和「谁来起这台引擎」无关。
  //   一台不由平台启动的引擎**照样有地址** —— 那正是后端连它用的地址，
  //   写在 default_base_url 上，跟 runtime 段没有关系。
  const listen = parseListen(profile, opts)

  // ⭐ stdio 模式下 port 就是 null，而且**必须**是 null：它没端口可校验，
  //   更重要的是绝不能让一个 null 端口被拼进 "http://null:null" ——
  //   那个假地址会让所有下游的排查方向全错。
  const isStdio = listen.source === 'stdio'
  if (isStdio) {
    // ⭐ stdio 模式下由平台启动的路径在下面（return 那支），
    //   这里只保证「不由平台启动」那一支的字段形状不变。
  }

  // 名片没写 runtime = 这台引擎不由平台起（作者自己起、或还没接上电）。
  // ⭐ 这是合法状态，不是错误 —— 但必须和「能起」区分得一眼看见，
  //   否则启动脚本会拿着一份空计划去 spawn 一个 undefined。
  if (!profile.runtime) {
    return {
      id: profile.id,
      label: profile.label,
      launchable: false,
      reason: `${profile.id} 的 manifest.json 没有 runtime 段 —— 这台引擎不由平台启动。`,
      // ⛔ 这三个字段**必须**跟着一起给，哪怕平台不起它。
      //   start.ps1 的端口保护（Resolve-Port）对这台引擎照样要生效：它想听
      //   9880，别的程序就不能占着 9880 不放。少了这几个字段，PowerShell 那边
      //   拿到的是 $null，[int]$null = 0，Resolve-Port 会拿 0 号端口去问
      //   「有人在听吗」—— 永远没有，于是端口冲突保护对这台引擎**静默失效**。
      host: listen.host,
      port: listen.port,
      desired_port: listen.port,
      // ⭐ stdio 模式不给假地址（见上面那段理由）。
    base_url: isStdio ? null : `http://${listen.host}:${listen.port}`,
      // ⭐ 不由平台启动的引擎**也要给**：端口被别的程序占了要挪，挪完
      //   后端得知道新地址，靠的就是往这个变量里写。少了它，这台引擎
      //   一挪端口后端就永远连着旧地址。
      base_url_env: profile.base_url_env || null,
      // ⛔ 平台起不了它 ⇒ 谈不上预热，也谈不上按需释放。
      //   ⚠ 这两个键**必须给**（哪怕都是 false）：少一个键，读计划那一侧
      //     拿到的是 undefined，而 undefined 在 PowerShell 里是 $null、
      //     在 JS 里是 falsy —— 恰好都跟 false 表现一样，于是这个洞会一直
      //     不被发现，直到某天有人把判断写成「!= true」。
      preload: false,
      on_demand: false,
    }
  }

  // ⭐ stdio 模式下 port 就是 null，而且**必须**是 null：它没端口可校验，
//   更重要的是绝不能让一个 null 端口被拼进 "http://null:null" ——
//   那个假地址会让所有下游的排查方向全错。
  const port = isStdio ? null
    : (opts.port === undefined || opts.port === null ? listen.port : Number(opts.port))
  if (!isStdio && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw planError('ENGINE_LAUNCH_PORT_INVALID',
      `要给引擎 ${profile.id} 用的端口不是一个合法端口号：${JSON.stringify(opts.port)}`,
      { id: profile.id, port: opts.port })
  }

  const p = resolveRuntimePaths(profile, rootDir)

  // ⭐ 这一次选中的那一份模型顶替底模目录。理由见上面 opts 的注释。
  // ⚠ 相对路径按项目根解析 —— 盘上模型的登记形式是相对路径
  //   （assets/<角色>/models/<引擎id>/<位名>/…），直接丢给引擎当 cwd
  //   相对路径用会解到引擎自己的目录去，那是另一个地方。
  const ckptOverride = opts.checkpointsOverride == null || opts.checkpointsOverride === ''
    ? null
    : path.resolve(rootDir, String(opts.checkpointsOverride))

  const values = {
    host: listen.host,
    port: String(port),
    root: rootDir,
    engine_dir: profile.dir,
    // 名片没写 checkpoints 时是 null ⇒ 用了就抛。
    // ⚠ 但顶替值在的话就轮不到它 null：这一次明确说了要用哪一份。
    checkpoints: ckptOverride || p.checkpoints,
    // ⭐⭐ 有默认值，而且**算得出来**：<root>/cache/engines/<id>.profile.json。
    //   第一版是「调用方必须传，不传就抛」，写了一句很漂亮的报错指向调用方 ——
    //   然后盘上三处真名片的体检当场全红，因为它们只想算个计划，凭什么关心
    //   一份缓存文件放哪儿。⇒ 与其把报错写好，不如**让这个错不可能发生**：
    //   路径由 rootDir + id 纯算出来，调用方忘不了，因为没有可忘的东西。
    //   ⚠ opts.profileJsonPath 保留成覆盖口，给 run_ab.py 这类要指定位置的工具。
    profile_json: path.resolve(
      rootDir,
      opts.profileJsonPath || path.join('cache', 'engines', `${profile.id}.profile.json`)),
  }
  // 哪些占位符**真的**被用到了。⛔ 判据只能是「展开时命中过」，不能是
  //   「调用方传了 profileJsonPath」—— 后者会让一台压根不用宿主的引擎也
  //   被要求写一份名片文件，白落一个没人读的文件在盘上。
  const used = new Set()
  // ⛔ 先查形状再 .map()。不查的话，一张写了 runtime 却漏了 args 的名片会
  //   在这里抛 "Cannot read properties of undefined (reading 'map')" ——
  //   这句话经 CLI 传到 start.ps1、再打到用户的启动窗口里，说的是 JS 的内部
  //   实现，一个字都没提到"哪张名片、少了哪个字段"。接引擎的人对着它无从下手。
  // ⚠ 空数组是允许的：一台不需要任何命令行参数、全靠配置文件的引擎是合法的。
  //   非法的只有"没写"和"写成了别的类型"。
  const rawArgs = profile.runtime.args
  if (!Array.isArray(rawArgs)) {
    throw planError('ENGINE_LAUNCH_ARGS_INVALID',
      `引擎 ${profile.id} 的 manifest.json 写了 runtime 却没写 runtime.args（或者写的不是数组）—— ` +
      '平台不知道该拿什么命令行去起它。要起一台引擎，manifest.json 必须说清参数怎么拼；' +
      '一个都不需要就写成空数组 []。',
      { id: profile.id, key: 'runtime.args', got: rawArgs === undefined ? 'undefined' : typeof rawArgs })
  }
  for (const a of rawArgs) {
    if (typeof a !== 'string') {
      throw planError('ENGINE_LAUNCH_ARGS_INVALID',
        `引擎 ${profile.id} 的 runtime.args 里有一项不是字符串：${JSON.stringify(a)} —— ` +
        '命令行参数只能是字符串。数字要写成 "9880" 这样带引号的形式。',
        { id: profile.id, key: 'runtime.args', got: typeof a })
    }
  }
  // ⭐ stdio 模式下 --host/--port 连同它们的值**整对丢掉**。
  //   名片里的 ['--host','{host}','--port','{port}'] 是给「引擎起个 HTTP 服务器」
  //   准备的。stdio 下引擎不监听端口，而 host.py 拿到 --port null 会怎样？
  //   得看它怎么解析 —— 可能是「监听 0 号端口」（= 随机端口，于是又占了一个
  //   我们以为不存在的端口）。⛔ 两种都不是「不监听」。
  //   ⭐ 丢的是**成对的**（标志 + 它的值）：逐个过滤会留下一个孤零零的
  //     '--port'，它的下一个参数（{checkpoints}）会被当成端口号吃掉。
  const dropListenFlags = isStdio
  const args0 = dropListenFlags
    ? dropFlagPairs(rawArgs, new Set(['--host', '--port', '--listen', '--bind']))
    : rawArgs
  // ⭐ stdio 模式要**显式告诉宿主**走 stdio。
  //   ⛔ 不靠「没给 --port 就当 stdio」—— 那是推断，而推断在
  //     「名片没写 default_base_url」的合法情形下会误判成 stdio，
  //     于是引擎不开端口、平台却在等 TCP ⇒ 双方永久等待。
  const args1 = isStdio && !args0.includes('--stdio') ? args0.concat(['--stdio']) : args0
  const args = args1.map((a) => expandArg(profile, a, values, used))

  // 认自家进程用的记号：调用方拿它去 Contains() 一个进程的命令行。
  //
  // 搬家前 start.ps1:149 写死的是文件名 'infer_server.py'。这里给的是
  // **入口的绝对路径**（小写），理由是文件名会撞：两台引擎的入口重名是
  // 完全可能的（当时 _TEMPLATE 教人写 shim.py，撞名几乎是必然），
  // 而 Test-IsOwnProcess
  // 的另一半守卫只查「在不在本项目根下」—— 两台自家引擎之间它分不开。
  // 撞了的后果很具体：IndexTTS2 占着 9880 时，start.ps1 会认为「我的引擎
  // 已经在跑了」，于是 GPT-SoVITS 永远起不来，而且不报任何错。
  //
  // ⭐ 对 GPT-SoVITS 这不是行为变更：今天在跑的那个进程，命令行里本来就是
  //   start.ps1 拼进去的绝对路径（$ENGINE_SCRIPT），Contains 照样命中。
  //   新写法只会更严，不会更松。
  // ⚠ 小写：调用方（Test-IsOwnProcess）拿到的命令行已经 ToLowerInvariant 过。
  //
  // ⛔⛔ 2026-08-27：通用宿主把上面这段推理的地基抽掉了。
  //   上面写「文件名会撞，所以用绝对路径」—— 可是走 lib/engines/host.py 的
  //   引擎，**入口的绝对路径也是同一个**。以前是「两台可能同名」，
  //   现在是「所有走宿主的引擎必然同路径」，同一个撞车原样复活，而且更狠。
  //   后果就是上面那段写的：A 占着端口时 start.ps1 认为「我的引擎已经在
  //   跑了」，B 永远起不来，且不报任何错。
  //
  // ⭐ 修法：走宿主的引擎，改用**那份名片解析结果的路径**当记号 ——
  //   它一台引擎一个（cache/engines/<id>.profile.json），而且就明明白白
  //   摆在命令行里（--profile-json 后面那个值），Contains() 照样命中。
  //   ⇒ 不走宿主的引擎（自带入口）行为一个字节不变，仍是入口绝对路径。
  const ownProcessMark = (used.has('profile_json') ? values.profile_json : p.entry)
    .toLowerCase()

  // ⭐⭐ 这面旗子是给调用方看的一条**指令**，不是一条信息：
  //   它在 ⇒ 「spawn 之前先把 buildHostProfile(id) 写到这个路径」。
  //   它不在 ⇒ 这台引擎不走通用宿主，什么都不用做。
  //   ⛔ 一台引擎的入口都指到 host.py 了却没有这面旗子，表现是宿主开口就
  //     FATAL「--profile-json 是必须的」—— 那时候看起来像宿主的毛病，
  //     其实是名片 args 里漏写了 {profile_json}。
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
    // 名片声明的端口。start.ps1 拿它当「期望端口」去解冲突；
    // 冲突挪走之后 port 会和它不一样，这两个数**要分得清**。
    desired_port: listen.port,
    base_url: isStdio ? null : `http://${listen.host}:${port}`,
    // ⭐ stdio 下探活走 stdin/stdout，没有 URL。
    ready_url: isStdio ? null
      : `http://${listen.host}:${port}${profile.runtime.ready_endpoint}`,
    // ⭐ 告诉 spawnEngine 用 stdio 传输（它据此改 spawn 的 stdio 选项）。
    transport: isStdio ? 'stdio' : (opts && opts.transport) || 'http',
    ready_timeout_ms: profile.runtime.ready_timeout_ms,
    own_process_mark: ownProcessMark,
    // 把地址告诉后端时该写哪个环境变量。null = 这台引擎没声明，
    // 端口一旦被挪走后端就跟不上（start.ps1 会为此专门警告一次）。
    base_url_env: profile.base_url_env || null,
    // ⭐⭐ 开机要不要顺手把它点着。
    //   以前这里是「名片写了 preload:true 就是 true」，而盘上两张真名片
    //   都写着 true，且这一行**一个消费者都没有** —— 于是启动脚本的实际
    //   行为是「装了几台就起几台」，其中一台一起进程就吃约 6G 内存。
    //   现在改成推导（见 residency.js）：
    //     模型是开进程那一步吃进去的 ⇒ 不预热，第一次真有请求才起。
    //     进程只是个壳          ⇒ 照常预热（关掉也省不下什么）。
    //   ⚠ 名片写 preload:false 仍然一票否决，作者比平台更清楚自己那台。
    preload: shouldPreload(profile),
    // 这台引擎「起着贵不贵」。true ⇒ 用完一段时间后会被放掉，换模型会重开。
    // 给启动脚本和界面看，⛔ 不是名片字段，是推出来的。
    on_demand: isOnDemand(profile),
    // 这一次实际用的底模目录（可能被这一次选中的模型顶替过）。
    // ⭐ 放进计划是为了让「装的是不是这一份」这件事在日志里看得见。
    checkpoints: values.checkpoints,
    load_params: opts.loadParams || {},
    profile_json_path: profileJsonPath,
  }
}

module.exports = { buildLaunchPlan, PLACEHOLDERS, PATHISH }
