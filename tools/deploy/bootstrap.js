// =============================================================================
//  bootstrap.js — 首次部署（跨平台主体）
//  取代 tools\deploy\bootstrap.ps1（665 行 PowerShell）。
//
//  步骤：
//    1. 定位 Python 3.11（tools\runtime\python）
//    2. 在项目根建 venv
//    3. 装依赖：本地 wheel（tools\wheels）+ PyPI，**不含 torch**
//    4. 装 torch / onnxruntime（委托 tools\cli\install-torch.js）
//    4b. ffmpeg + ffprobe（项目内，不动全局）
//    4c. 恢复后端 node 依赖（npm ci）—— node_modules **不随包分发**
//    4d. 刷新 node 包许可清单
//    5. 自检导入
//    6. 模型下载（download_models.py）
//
//  ⚠️⚠️ 关于「换壳」这件事的真实情况：实测原 .ps1 665 行里，
//     真正锁死 Windows 的只有两处 ——
//       · `venv\Scripts\python.exe`（6 处）—— macOS/Linux 是 `venv/bin/python`
//       · `Join-Path` 的反斜杠（7 处）
//     而 Get-NetTCPConnection / Get-CimInstance / Get-Process / netstat /
//     nvidia-smi / Win32_ / taskkill / 注册表 **各 0 处**。
//     ⇒ 也就是说：那 600 行是**平台无关的流程**，只是用 PowerShell 的壳写着。
//     所以这里是**照搬 + 换壳**，不是重新设计。
//
//  ⚠️⚠️ 一条不能丢的 Windows 血泪教训（在第 4c 步，那段注释比代码重要）：
//     ⛔ **绝不调 npm.cmd**。它先跑 npm-prefix.js 问「npm 在哪」，而那个脚本靠
//        「PATH 上有没有 npm」回答 ⇒ 机器上一旦装过全局 Node（很常见），
//        它就跳到全局那份，版本对不上，报 ERR_REQUIRE_ESM，
//        **而错误里一个字都不提这件事**。
//        ⛔ 升 Node 修不了 —— 新版 Node 自带同一份 npm-prefix.js。
//        ⭐ 解法：直接 `node node_modules/npm/bin/npm-cli.js`，绕开前缀推断。
// =============================================================================

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const SCRIPT_DIR = __dirname
const IS_WIN = process.platform === 'win32'
const { venvPython } = require(path.join(ROOT, 'lib', 'engines', 'platformPaths.js'))

// ── 参数 ────────────────────────────────────────────────────────────────────
// ⚠️ PowerShell 版是 `foreach ($a in $args)` 扫全部参数，而 deploy.bat 是
//   用 `-File x.ps1 --platform-only` 调的 ⇒ 参数里**可能带那个 `-File`**。
//   PowerShell 会把它自动剥掉；Node 不会 ⇒ 我们自己只认认识的开关，
//   忽略其余（不做「不认识的参数就报错」—— 那是给 CLI 用的，不是给内部调用的）。
const argv = process.argv.slice(2)
// ⭐ --platform-only：只装平台自己的 3 个工具链包，不装 torch / 那 6.6GB。
//   默认**保持原样（false）** —— 翻默认值会让老用户行为突变。
const PLATFORM_ONLY = argv.includes('--platform-only') || argv.includes('-PlatformOnly')

// ⭐ --dry-run：只走「找解释器 / 认 venv / 算清楚要装什么」这些**只读**的部分，
//   然后把计划打出来就停。
//   为什么需要它：这份脚本会重建 venv、装 6.6GB 依赖、改 node_modules ——
//   没有 dry-run 的话，验证它只能靠推理，而它有 6 个步骤、每一步都有分支。
//   ⚠️ 它**不**承诺「什么都没改」—— 步骤 2 那个 venv 健康检查若发现 venv 坏了，
//   就会真的重建。所以 dry-run 在这一步之前就停。
const DRY = argv.includes('--dry-run')

// ── 日志 ────────────────────────────────────────────────────────────────────
// ⚠️ 原版用 Start-Transcript 把整段会话抄进文件。Node 没有等价物，
//   而我们要的那部分很简单：**每个 [deploy] 消息都追加进日志文件**。
//   ⛔ 不要改成「只在出错时写」—— 原版正是靠这份 transcript 才能事后查
//     「uv 解析到四十多个包就闪退」这类问题。
const LOG_DIR = path.join(ROOT, 'logs')
const LOG_FILE = path.join(LOG_DIR,
  'deploy_' + new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15) + '.log')

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const C = { Cyan: 36, Green: 32, Yellow: 33, Red: 31, DarkCyan: 36, White: 37, Gray: 90 }
const say = (color, m) => {
  const line = '[deploy] ' + m
  console.log(useColor ? `\x1b[${C[color]}m${line}\x1b[0m` : line)
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch (_) { /* 日志写不进去不该拦住部署 */ }
}
const Info = m => say('Cyan', m)
const Ok = m => say('Green', m)
const Warn = m => say('Yellow', m)
const Die = m => { say('Red', m); process.exit(1) }

/** 原样打印（不带 [deploy] 前缀）—— 给自检那些第三方输出看 */
function raw (m) {
  console.log(m)
  try { fs.appendFileSync(LOG_FILE, m + '\n', 'utf8') } catch (_) {}
}

/**
 * 跑一个原生命令，**输出直接进终端**。
 *
 * ⚠️ 为什么用 stdio: 'inherit' 而不是 pipe 再转发：原 PowerShell 版用
 *   `Start-Process -NoNewWindow -Wait` 达到同样目的，注释里记着原因 ——
 *   「走 PowerShell 的原生命令/错误管线（那个曾经把宿主搞崩）」。
 *   ⇒ 进度条要能实时看见，且**不能**经过任何中间层。
 * ⭐ 第三个参数可传输出文件（要留档时用），此时 inherit 换成落盘。
 */
function runNative (exe, args, { cwd, capture = false, env } = {}) {
  const r = spawnSync(exe, args || [], {
    cwd: cwd || ROOT,
    env: env || process.env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    // Windows 上 spawn 一个 .cmd/.bat 必须走 shell；POSIX 上不需要。
    shell: IS_WIN && /\.(cmd|bat)$/i.test(exe),
    windowsHide: true,
    timeout: 30 * 60 * 1000,
  })
  return { rc: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') }
}

/** 跑一个 python 探针脚本。⛔ 不把多词字符串塞进 `python -c`：
 *  Windows PowerShell 5.1 的原生参数重解析会把引号吃掉（原版第 357-359 行
 *  的注释记了这个坑：python 只收到 `import torch; print(` ⇒ SyntaxError）。
 *  落一个临时文件再跑，跨平台且不依赖 shell 的引号规则。 */
function runPyProbe (py, src, { cwd } = {}) {
  const tmp = path.join(os.tmpdir(),
    'ttsbroker_probe_' + process.pid + '_' + Math.abs(hash(src)) + '.py')
  fs.writeFileSync(tmp, src, 'utf8')
  try {
    const r = spawnSync(py, ['-u', tmp], { cwd: cwd || ROOT, encoding: 'utf8' })
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    return { rc: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') }
  } finally { try { fs.unlinkSync(tmp) } catch (_) {} }
}
function hash (s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return h }


async function main () {
  // =============================================================================
  //  0. 向导的旁白文件（deploy_wizard.py 写的）
  // =============================================================================
  // deploy.bat 先跑 deploy_wizard.py（许可确认 + 选模型），向导在**本脚本旁边**
  // 放两个旁白文件：
  //   .deploy_models.txt  → 逗号分隔的模型组（"core,g2pw,asr"），或空
  //   .deploy_ffmpeg.txt  → "1" 下载 ffmpeg，"0" 跳过
  // 有就读（非交互：环境是固定的，只有「下载什么」是用户选的）；
  // 没有就保留原来的交互行为。null = 「没这个文件 ⇒ 交互」。
  function readSidecar (name) {
    const p = path.join(SCRIPT_DIR, name)
    if (!fs.existsSync(p)) return null
    const c = fs.readFileSync(p, 'utf8')
    return c ? c.trim() : ''
  }
  const SEL_MODELS = readSidecar('.deploy_models.txt')
  const SEL_FFMPEG = readSidecar('.deploy_ffmpeg.txt')

  // ── 0a. 非 ASCII 安装路径：警告，不拒绝 ────────────────────────────────────
  // ⛔ 硬拒绝（exit 7）已按用户要求移除。改成警告 + 继续：现代 Windows 一般
  //    能处理 Unicode 路径，而下面给所有子进程强制了 UTF-8。
  {
    const bad = [...ROOT].filter(ch => ch.charCodeAt(0) > 127)
    if (bad.length) {
      raw('')
      raw('============================================================')
      raw('[deploy][WARN] 安装路径里有非 ASCII 字符。')
      raw(`  path : ${ROOT}`)
      raw(`  bad  : ${bad.join(' ')}`)
      raw('  非英文路径在部分 Windows 配置下可能让 Python / ffmpeg 起不来。')
      raw('  若部署失败，把整个目录挪到纯英文路径（例如 D:\\TTS-Broker）再跑。')
      raw('  继续部署 ...')
      raw('============================================================')
    }
  }

  Info(`project root : ${ROOT}`)

    // =============================================================================
    //  0-1. 全部路径常量（集中在这里，因为 --dry-run 的报告要用它们）
    // =============================================================================
    // ⭐ 为什么集中在 --dry-run 之前定义：
    //   --dry-run 的报告要在真正开始部署**之前**就把「要动哪些东西」全打出来。
    //   ⛔ 我第一版把这些常量留在各自的步骤里 ⇒ dry-run 执行到那里时崩在
    //     **TDZ**（const 暂时性死区：`Cannot access 'WHEELS' before initialization`）。
    //     而崩在一条只读路径上是最难查的那种错 —— 你会以为部署坏了，其实是
    //     「验证部署的那个开关」坏了。
    //   ⭐ 所以下面第 2 / 3 / 4c 步**复用**同一批，不重新定义：
    //     报告与执行读的是同一批路径，不存在「报告说的」与「实际做的」不一致。
    const VENV = path.join(ROOT, 'venv')
    const WHEELS = path.join(ROOT, 'tools', 'wheels')
    const REQ = path.join(ROOT,
      PLATFORM_ONLY ? 'requirements-platform.txt' : 'requirements-gpt-sovits.txt')
    const NODE_DIR = path.join(ROOT, 'tools', 'runtime', 'node')
    const NODE_EXE = path.join(NODE_DIR, IS_WIN ? 'node.exe' : 'node')
    const NPM_CLI = path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js')

    // =============================================================================
    //  1. 定位 Python 3.11
    // =============================================================================
  const EMB_PY_IS_WIN = path.join(ROOT, 'tools', 'runtime', 'python',
    IS_WIN ? 'python.exe' : 'python')
  let EMB_PY = EMB_PY_IS_WIN
  if (!fs.existsSync(EMB_PY)) {
    Warn(`embedded python not found: ${EMB_PY}`)
    Warn('Falling back to a system python on PATH (must be 3.11.x).')
    const which = (n) => {
      const r = spawnSync(IS_WIN ? 'where' : 'which', [n],
        { encoding: 'utf8', windowsHide: true })
      return r.status === 0 ? (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] : null
    }
    // ⭐ Windows 上 `where python` 可能返回 Microsoft Store 的**桩**（App Execution
    //   Alias），那个东西一跑就弹出商店。所以候选逐个试真能 --version 的。
    const cands = [which('python3'), which('python')].filter(Boolean)
    EMB_PY = null
    for (const c of cands) {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', windowsHide: true })
      if (r.status === 0 && /Python/.test(r.stdout || r.stderr || '')) { EMB_PY = c; break }
    }
    if (!EMB_PY) {
      Die('No embedded python and no system python. '
        + 'Run tools\\build\\03_fetch_runtimes.py, or install Python 3.11.')
    }
  }
  const pyver = (() => {
    const r = spawnSync(EMB_PY, ['--version'], { encoding: 'utf8', windowsHide: true })
    return ((r.stdout || '') + (r.stderr || '')).trim()
  })()
  Info(`using python: ${EMB_PY} (${pyver})`)
  if (!/3\.11\./.test(pyver)) {
    Warn(`expected Python 3.11.x, got: ${pyver} — continuing but this may break compiled wheels.`)
  }

  // =============================================================================
  //  2. 建 venv
  // =============================================================================
  // ⭐ VENV 在上面 0-1 集中定义（--dry-run 的报告要用它）。
  // venv 的解释器路径**按平台推导**（原版硬编码 `Scripts\python.exe`）。
  const vr = venvPython(VENV, process.platform)
  if (!vr.ok) Die(vr.why)
  const VENV_PY = vr.python

  if (DRY) {
  // ── 只读的那一半到此为止 ──
  const reqPath = path.join(ROOT, PLATFORM_ONLY ? 'requirements-platform.txt' : 'requirements-gpt-sovits.txt')
  const vrDry = venvPython(VENV, process.platform)
  const wheels = fs.existsSync(WHEELS)
    ? fs.readdirSync(WHEELS).filter(f => f.endsWith('.whl')).length : 0
  const npmCliOk = fs.existsSync(NODE_EXE) && fs.existsSync(NPM_CLI)
  raw('')
  raw('--dry-run：没有装任何东西、没有改任何文件。以下是实际会执行的步骤：')
  raw('')
  raw('  解释器      ' + EMB_PY + '  (' + pyver + ')')
  raw('  venv 目录   ' + VENV)
  raw('  venv 解释器 ' + (vrDry.ok ? vrDry.python : '⛔ ' + vrDry.why))
  raw('  requirements ' + path.basename(reqPath) +
      (fs.existsSync(reqPath) ? '' : '   ⛔ 不存在！'))
  raw('  本地 wheel  ' + (wheels ? wheels + ' 个' : (fs.existsSync(WHEELS) ? '目录是空的' : '⛔ tools/wheels 不存在')))
  raw('  uv          ' + (process.env.TTS_NO_UV === '1' ? '跳过（TTS_NO_UV=1）' : '装，装不上退回 pip'))
  raw('  torch       ' + (PLATFORM_ONLY ? '跳过（--platform-only）' : '委托 tools/cli/install-torch.js'))
  raw('  ffmpeg      ' + (SEL_FFMPEG === '0' ? '跳过（向导没选）' : fs.existsSync(path.join(SCRIPT_DIR, 'download_ffmpeg.py')) ? '下载' : '⛔ download_ffmpeg.py 不存在'))
  raw('  npm         ' + (npmCliOk ? 'node + npm-cli.js（⛔ 不走 npm.cmd）'
    : fs.existsSync(path.join(ROOT, 'package.json')) ? '⚠️ 自带 npm 不在 → 退回 PATH 上的 npm' : '⛔ package.json 不存在'))
  raw('  模型        ' + (SEL_MODELS === null ? '没有旁白文件 → 看有没有终端' : SEL_MODELS === '' ? '向导没选 → 跳过' : '下：' + SEL_MODELS))
  raw('')
  raw('  去掉 --dry-run 即真正部署。')
  raw('')
  say('DarkCyan', `full log: ${LOG_FILE}`)
  process.exit(0)
}

// ⚠️⚠️ venv **不可搬运**：pyvenv.cfg 把建它的那个 base 解释器的**绝对路径**烤了进去。
  //   项目目录被移动 / 改名（或首次部署时就在非英文路径下）之后，
  //   现有 venv 的解释器仍是一个指向**旧 base 路径**的 trampoline，
  //   每次调用都死在 `No Python at '...\python.exe'`。
  //   ⇒ 所以我们不盲信现有 venv：先**健康检查**，坏了就对着当前内嵌运行时重建。
  //   这正是「整个项目可以随便搬」这件事的实现方式。
  let venvOk = false
  if (fs.existsSync(VENV_PY)) {
    const r = spawnSync(VENV_PY, ['-c', 'import sys'], { encoding: 'utf8', windowsHide: true })
    venvOk = r.status === 0
  }
  if (venvOk) {
    Ok(`venv already exists and works: ${VENV}`)
  } else {
    if (fs.existsSync(VENV)) {
      Warn(`existing venv is broken or was moved from another path; rebuilding it: ${VENV}`)
      try { fs.rmSync(VENV, { recursive: true, force: true }) }
      catch (e) { Die(`删不掉坏掉的 venv（${VENV}）：${e.message}\n        可能有进程正占着它。`) }
    }
    Info('creating venv ...')
    const r = runNative(EMB_PY, ['-m', 'venv', VENV])
    if (!fs.existsSync(VENV_PY)) Die('venv creation failed.')
    // 刚建出来的 venv 必须**真的能跑** —— 只看文件在不够
    const chk = spawnSync(VENV_PY, ['-c', 'import sys'], { encoding: 'utf8', windowsHide: true })
    if (chk.status !== 0) Die('venv was created but its python cannot run. Check the embedded runtime.')
    Ok('venv created.')
  }

  // ── 升 pip ─────────────────────────────────────────────────────────────────
  Info('upgrading pip / setuptools / wheel ...')
  runNative(VENV_PY, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools<81', 'wheel'])

  // ── 装 uv ──────────────────────────────────────────────────────────────────
  // uv 并行下载 + 全局缓存，比 pip 快 5-10 倍。它是个很小的无依赖 wheel；
  // 装不上就静默退回 pip。
  // 给 uv 一个宽松的网络超时。⛔ 刻意**不**关它的进度条、也不限制并行度：
  // 进度条实时显示在终端上（走 runNative 的 inherit，不过中间层），
  // 而若某台机器的杀软/EDR 仍拦它，我们不阉割所有人 —— 失败自动退回 pip。
  if (!process.env.UV_HTTP_TIMEOUT) process.env.UV_HTTP_TIMEOUT = '120'
  // ⚠️ uv 的全局缓存与 venv 常在**不同盘**（C: 缓存 vs D: venv）⇒ uv 不能 hardlink，
  //   会一边探测一边退回整份拷贝并打警告。直接让它拷贝：没有警告，行为确定。
  process.env.UV_LINK_MODE = 'copy'

  let UV_OK = false
  // 逃生口：TTS_NO_UV=1 完全跳过 uv。
  if (process.env.TTS_NO_UV === '1') {
    Warn('TTS_NO_UV=1 set — skipping uv, installing with pip only.')
  } else {
    Info('installing uv (parallel package installer) ...')
    if (runNative(VENV_PY, ['-m', 'pip', 'install', '--upgrade', 'uv']).rc === 0) {
      const v = spawnSync(VENV_PY, ['-m', 'uv', '--version'], { encoding: 'utf8', windowsHide: true })
      if (v.status === 0) { UV_OK = true; Ok('uv ready — will use it for parallel installs.') }
    }
    if (!UV_OK) Warn('uv unavailable — falling back to pip (slower).')
  }

  // =============================================================================
  //  3. 装项目依赖（不含 torch）
  // =============================================================================
  // 两份 requirements 的分工（实测名单是 git grep 量出来的）：
  //   requirements-gpt-sovits.txt   200 包 / 6.6 GB —— 它是 GPT-SoVITS 的依赖
  //   requirements-platform.txt      3 包 / 62 MB —— 平台自己真正要的
  //
  // ⚠️ 默认**不**切到 platform-only：训练线要 torch（Owner 2026-09-29 裁决「C3 暂不做」），
  //   今天切默认 ⇒ 训练立刻坏掉。
  //   ⭐ 这条路的终点：训练线也搬进 engines/<id>/.venv 之后，把默认翻过来，
  //   「用户自己下引擎」才不再是一句空话（今天装平台必背那 5-6GB）。
  if (PLATFORM_ONLY) {
    Info('using the platform-only requirements (no torch / no CUDA).')
    Info('the training line needs torch and will NOT work under this flag.')
  }
  if (!fs.existsSync(REQ)) Die(`requirements file not found: ${REQ}`)

  // tools\wheels：预编译 wheel（jieba_fast / pyopenjtalk 需要 C/C++ 编译器）
  const findLinks = []
  if (fs.existsSync(WHEELS)) {
    const whl = fs.readdirSync(WHEELS).filter(f => f.endsWith('.whl'))
    if (whl.length) {
      Info(`found ${whl.length} local wheel(s) in tools\\wheels — will prefer them.`)
      findLinks.push('--find-links', WHEELS)
    } else {
      Warn('tools\\wheels is empty — jieba_fast / pyopenjtalk will be built from source (needs a C/C++ compiler).')
    }
  } else {
    Warn('tools\\wheels missing — compile-needing packages may fail without a compiler.')
  }

  Info('installing project dependencies (this may take a while) ...')
  // requirements 是**完整的 pip freeze 快照**（每个传递依赖都被钉住）。用 --no-deps 装，
  // 让 pip 逐个按 pin 装**而不跑依赖解析器**。这是复现冻结环境的正确方式，
  // 而且避开「纸面冲突」（比如新版 fsspec vs 旧 datasets 上界）——
  // 那些冲突在冻结它的那台机器上根本不存在。
  if (UV_OK) {
    Info('installing with uv (parallel) ...')
    const rc = runNative(VENV_PY, ['-m', 'uv', 'pip', 'install', '--python', VENV_PY, '--no-deps',
      '--index-strategy', 'unsafe-best-match', ...findLinks, '-r', REQ]).rc
    if (rc !== 0) {
      Warn('uv install failed; falling back to pip --no-deps (most compatible) ...')
      UV_OK = false
    }
  }
  if (!UV_OK) {
    Info('installing with pip --no-deps ...')
    const rc = runNative(VENV_PY, ['-m', 'pip', 'install', '--no-deps', ...findLinks, '-r', REQ]).rc
    if (rc !== 0) {
      // ⛔ 刻意**不**退回带解析器重试。requirements 是给 --no-deps 用的冻结快照；
      //   带解析器重跑只会翻出那些**纸面**冲突（accelerate 1.14 要 torch>2.2 vs
      //   钉死的 torch==2.2.0+cu121），而它们在冻结环境里毫无影响 ——
      //   那是**红鲱鱼**，会浪费几个钟头。
      //   --no-deps 失败意味着**有一个包取不到或建不起来**：看上面**最后**一条错误。
      Warn('pip --no-deps install FAILED.')
      Warn('This is a frozen lock installed with --no-deps; we do NOT fall back to the')
      Warn('resolver on purpose (it would report fake accelerate/torch conflicts).')
      Warn('One package could not be fetched or built — look at the LAST error above.')
      Warn('Most common cause: a compile-needing wheel (jieba_fast / pyopenjtalk, etc.)')
      Warn('with no prebuilt .whl on a machine that lacks a C/C++ toolchain. Fix by')
      Warn('dropping a prebuilt .whl into tools\\wheels, OR installing a compiler,')
      Warn('then re-run deploy.')
      Die('dependency install failed (see the specific package error above).')
    }
  }
  Ok('project dependencies installed.')

  // ── 轻量自检：pip check ───────────────────────────────────────────────────
  // --no-deps 相信冻结是完整的。做个轻量核对，让**漏掉的 pin** 在这里
  // 带着明确提示冒出来，而不是变成后面某个莫名的 import 错误。
  Info('verifying dependency tree (pip check) ...')
  {
    const r = runNative(VENV_PY, ['-m', 'pip', 'check'])
    if (r.rc !== 0) {
      Warn('pip check reported issues above. If they are only "has requirement X, but')
      Warn('you have Y" warnings for packages that still import fine (common with a')
      Warn('frozen env), you can ignore them. If a package is MISSING, add it to the')
      Warn('requirements file and re-run deploy.')
    }
  }

  // =============================================================================
  //  4. torch + onnxruntime —— 委托给跨平台主体
  // =============================================================================
  // 两者都不在 requirements 里（巨大 / 构建目标相关 / 独立 index / 按设备条件），
  // 由它们自己那个可重跑的安装器处理 —— 它用**一次**设备探测
  // 为两者选 CUDA / XPU / ROCm / CPU。
  // ⛔ 原来这里有一段「脚本缺失时的 inline 回退」，已随主体单点一起删掉。
  const TORCH_BODY = path.join(ROOT, 'tools', 'cli', 'install-torch.js')
  let TORCH_OK = false
  if (PLATFORM_ONLY) {
    // torch 约 5-6GB，而平台（Node 进程）一个字节都用不到它 ——
    // 实测 fastapi/uvicorn 只被 GSV 的 infer_server.py 用，routes/ 零重依赖。
    Info('skipping PyTorch (--platform-only). Engines install their own.')
    Info('training is NOT available under this flag.')
  } else if (fs.existsSync(TORCH_BODY)) {
    Info('installing PyTorch via tools\\cli\\install-torch.js ...')
    const r = runNative(process.execPath, [TORCH_BODY])
    if (r.rc !== 0) Warn('torch install reported a non-zero exit — will verify by import below.')
  } else {
    Die(`install-torch body not found: ${TORCH_BODY}`)
    Die('The install package is incomplete. There is deliberately NO inline fallback:')
    Die('a second copy of the torch/onnxruntime install logic would drift from the body.')
  }

  // 通过**真的 import** 来验证 torch —— 那是唯一可信的信号。
  // 被杀软杀掉的 uv/pip（或一次网络错误）会留下「步骤完成了但 torch 根本没装」
  // 的状态。我们把它放进最后的小结里，让 torch 缺失无法被忽略。
  // ⭐ --platform-only 时**不跑**这段：跳过安装之后若照旧跑 import torch，
  //   它必然失败 ⇒ 会报「PyTorch 未装好」而真实原因是「按你的要求跳过了」。
  //   ⛔ 那个症状极具欺骗性：它把「按开关跳过」说成「装失败了」，
  //     而用户看到之后会去重跑 install-torch —— 正好装上那 5-6GB。
  if (PLATFORM_ONLY) {
    Info('skipping the PyTorch import check (--platform-only: nothing to verify).')
  } else {
    const p = runPyProbe(VENV_PY, `
  import torch
  print("  torch", torch.__version__, "cuda_available =", torch.cuda.is_available())
  `)
    if (p.rc === 0) { TORCH_OK = true; Ok('PyTorch verified (import OK).') }
    else Warn('PyTorch is NOT importable — it did not install correctly.')
  }

  // =============================================================================
  //  4b. ffmpeg + ffprobe（项目内，不动全局）
  // =============================================================================
  // UVR5 人声分离（pipeline/uvr5/webui.py）与后端的音频转码都要 ffmpeg/ffprobe。
  // download_ffmpeg.py 把静态构建取进 vendor\ffmpeg\<platform>\
  // （幂等：已能跑就跳过）。这里失败**非致命** —— 后端会退到系统 ffmpeg / WAV ——
  // 但人声分离没有它就不行，所以要在小结里把状态说出来。
  let FFMPEG_OK = false
  const ffScript = path.join(SCRIPT_DIR, 'download_ffmpeg.py')
  if (SEL_FFMPEG === '0') {
    Info('ffmpeg/ffprobe download skipped (not selected in the deploy wizard).')
  } else if (fs.existsSync(ffScript)) {
    Info('provisioning ffmpeg + ffprobe (project-local) ...')
    runNative(VENV_PY, [ffScript])
    const c = runNative(VENV_PY, [ffScript, '--check'], { capture: true })
    if (c.out) raw(c.out.trim())
    if (c.rc === 0) { FFMPEG_OK = true; Ok('ffmpeg/ffprobe ready.') }
    else Warn('ffmpeg/ffprobe NOT available — UVR5 vocal separation will fail until installed.')
  } else {
    Warn(`download_ffmpeg.py not found: ${ffScript}`)
  }

  // =============================================================================
  //  4c. 后端 node 依赖（npm ci）
  // =============================================================================
  // node_modules **不随包分发**（04_pack_release.py 把它排除了：缩小 zip，
  // 而且不物理再分发第三方 npm 包）。这里从随包的 package-lock.json 恢复
  // 后端/根部的**生产**依赖。前端随包**已构建**（web\dist），
  // 所以它自己的 node_modules 运行时不需要 —— 只有 server.js 用的那些。
  let NODE_OK = false
  const PKG_JSON = path.join(ROOT, 'package.json')
  const PKG_LOCK = path.join(ROOT, 'package-lock.json')
  const NODE_MODULES = path.join(ROOT, 'node_modules')

  if (!fs.existsSync(PKG_JSON)) {
    Warn(`package.json not found at project root: ${PKG_JSON} — skipping node deps.`)
  } else {
    // ⭐ 优先 `node node_modules/npm/bin/npm-cli.js`，**绝不调 npm.cmd**。
    //   理由见本文件头那段实测记录：npm.cmd 靠 PATH 推断 npm 在哪，
    //   装过全局 Node 的机器上会跳到全局那份，报 ERR_REQUIRE_ESM 而不解释原因。
    let npmExe = null
    let npmArgs = null
    if (fs.existsSync(NODE_EXE) && fs.existsSync(NPM_CLI)) {
      npmExe = NODE_EXE
      npmArgs = [NPM_CLI]
      // belt-and-suspenders：自带的 node 目录排到 PATH 最前
      process.env.PATH = NODE_DIR + path.delimiter + process.env.PATH
      const v = runNative(NODE_EXE, ['--version'], { capture: true }).out.trim()
      Info(`using bundled npm: ${NPM_CLI} (node ${v})`)
    } else {
      const sysNpm = (() => {
        const r = spawnSync(IS_WIN ? 'where' : 'which', ['npm'],
          { encoding: 'utf8', windowsHide: true })
        return r.status === 0 ? (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] : null
      })()
      if (sysNpm) { npmExe = sysNpm; Warn('bundled npm not found — using system npm on PATH.') }
    }

    if (!npmExe) {
      Warn('npm not found (neither the bundled npm-cli.js nor a system npm on PATH).')
      Warn('Backend node deps cannot be restored -> the server will not start.')
      Warn('Fix: ship npm alongside the node runtime (tools\\build\\03_fetch_runtimes.py')
      Warn('     must fetch the FULL node zip, not just node.exe) or install Node.js.')
    } else {
      // 快路径：node_modules 已恢复时跳过（npm 成功安装后会写这个标记）。
      // 否则每次重新部署都会 wipe + 重装一遍。
      const nmMarker = path.join(NODE_MODULES, '.package-lock.json')
      if (fs.existsSync(NODE_MODULES) && fs.existsSync(nmMarker)) {
        Ok('backend node deps already present — skipping npm install (delete node_modules\\ to force).')
        NODE_OK = true
      } else {
        // npm ci 可复现且严格照锁文件，但它**要求**锁文件存在。
        // 只有锁文件缺失时才退回 `npm install`（不该发生 —— 打包脚本会带着它，
        // 缺了也会警告）。
        //
        // ⚠️ 刻意**不带 --omit=dev**：后端依赖（express / cors / multer / js-yaml /
        //   argparse 及其传递依赖）全是极小的运行时包，没有 dev-only 的臃肿可省，
        //   而去掉 --omit=dev 能消除「某个运行时包恰好落在 devDependencies 里」
        //   的风险。npm ci 装的正是 package-lock.json 钉住的东西。
        const args = npmArgs.concat(fs.existsSync(PKG_LOCK)
          ? ['ci', '--no-audit', '--no-fund']
          : ['install', '--no-audit', '--no-fund'])
        if (!fs.existsSync(PKG_LOCK)) {
          Warn('package-lock.json missing — falling back to `npm install` (NOT reproducible).')
        }
        Info(fs.existsSync(PKG_LOCK)
          ? 'restoring backend node deps: npm ci ...'
          : 'restoring backend node deps: npm install ...')
        const n = runNative(npmExe, args, { cwd: ROOT })   // ⭐ npm 必须在持有 package.json 的目录里跑
        if (n.rc === 0 && fs.existsSync(NODE_MODULES)) { NODE_OK = true; Ok('backend node deps installed.') }
        else Warn('npm install FAILED — the backend server will not start until deps are restored.')
      }
    }
  }

  // =============================================================================
  //  4d. 刷新 node 包许可清单
  // =============================================================================
  // node_modules 不随包分发，所以它的逐包许可能只能在 npm ci 恢复之后才读。
  // 从**权威的已安装元数据**重新生成 THIRD_PARTY_LICENSES/runtime/node_packages.json，
  // 让许可中心（以及部署向导的第二层）反映真正装上了什么。
  // 尽力而为：这里失败**从不**拦住部署。
  if (NODE_OK) {
    const genNode = path.join(ROOT, 'tools', 'build', 'gen_node_licenses.py')
    if (fs.existsSync(genNode)) {
      const g = runNative(EMB_PY, [genNode, '--root', ROOT])
      if (g.rc === 0) Ok('node license inventory refreshed (THIRD_PARTY_LICENSES\\runtime\\node_packages.json).')
      else Warn('gen_node_licenses.py returned non-zero — node_packages.json not refreshed (non-fatal).')
    }
  }

  // =============================================================================
  //  5. 自检导入
  // =============================================================================
  // ⭐ 每个模块**先打印再导入**（立刻 flush），这样部署窗口能看到实时进度，
  //   而且万一某个 import 卡住，能确切看到**卡在哪一个**，而不是盯着一屏静默。
  Info('self-check: importing core packages ...')
  {
    const check = `
  import importlib, sys, time
  mods = ["torch","torchaudio","numpy","librosa","soundfile","transformers",
          "jieba_fast","pyopenjtalk","ctranslate2","faster_whisper","fastapi","onnxruntime"]
  bad = []
  for m in mods:
      print(("    importing %-16s ... " % m), end="", flush=True)
      t = time.time()
      try:
          importlib.import_module(m)
          print("ok (%.1fs)" % (time.time() - t), flush=True)
      except Exception as e:
          print("FAILED (%.1fs)" % (time.time() - t), flush=True)
          bad.append((m, repr(e)[:120]))
  try:
      import torch
      print("  torch", torch.__version__, "cuda_available=", torch.cuda.is_available(), flush=True)
  except Exception as e:
      print("  torch import failed:", e, flush=True)
  if bad:
      print("  MISSING/BROKEN:")
      for m, e in bad: print("    -", m, "=>", e)
      sys.exit(3)
  print("  all core imports OK")
  `
    const c = runPyProbe(VENV_PY, check)
    if (c.rc !== 0) Warn('some imports failed (see above). torch/CUDA or a compiled wheel may be missing.')
    else Ok('import self-check passed.')
  }

  // ── 尽力而为：hf_transfer（让模型下载更快：并行 + 分块）──────────────────
  // download_models.py 在能 import 时会自动启用它；装它不是必须的。
  Info('installing hf_transfer (accelerates model downloads) ...')
  {
    const args = UV_OK
      ? ['-m', 'uv', 'pip', 'install', '--python', VENV_PY, 'hf_transfer']
      : ['-m', 'pip', 'install', 'hf_transfer']
    if (runNative(VENV_PY, args).rc !== 0) {
      Warn('hf_transfer install failed (non-fatal — downloads just use the default path).')
    }
  }

  // =============================================================================
  //  6. 模型
  // =============================================================================
  raw('')
  const dl = path.join(SCRIPT_DIR, 'download_models.py')
  const pyRel = path.relative(ROOT, VENV_PY)   // ⭐ 用于提示的那条命令必须是相对路径，
                                               //   而 ⛔ 绝不是 `venv\Scripts\python.exe`
                                               //   （macOS/Linux 上没有那个布局）
  if (!fs.existsSync(dl)) {
    Warn(`download_models.py not found: ${dl}`)
  } else if (SEL_MODELS !== null) {
    // 非交互：控制台向导已经收集了模型选择（按许可组确认 + 选择），我们照办。
    if (SEL_MODELS === '') {
      Info('No model groups were selected in the deploy wizard — skipping model download.')
      Info(`Run  ${pyRel} tools\\deploy\\download_models.py --wizard  later to fetch them.`)
    } else {
      Info('========================================================')
      Info(` Downloading selected model groups: ${SEL_MODELS}`)
      Info('   -> models\\tts\\<engine> | models\\asr | models\\separation\\uvr5')
      Info('========================================================')
      runNative(VENV_PY, [dl, '--set', SEL_MODELS])
    }
  } else if (process.stdin.isTTY && process.env.TTS_NONINTERACTIVE !== '1') {
    // 独立 bootstrap（没有向导旁白）且**真的有终端**：保留原来的交互提问。
    // ⭐ ⛔ 两个前提缺一不可：
    //    · isTTY —— 否则在 CI / 管道里读 stdin 会一直等一个永远不会来的回答。
    //      （原版用 Read-Host，在那种环境里直接失败。）
    //    · TTS_NONINTERACTIVE=1 —— 让「人在场但不想被问」的场合能跳过。
    //      交互式提问在自动化里是不可测的。
    Info('========================================================')
    Info(' Dependencies done. Models are NOT bundled (~9GB).')
    Info(' Launch the model download wizard now? It downloads to')
    Info('   models\\tts\\<engine> | models\\asr | models\\separation\\uvr5')
    Info('========================================================')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ans = await new Promise(res => rl.question('Download models now? [Y/n] ', res))
    rl.close()
    if (!/^[Nn]/.test(ans || '')) runNative(VENV_PY, [dl, '--wizard'])
    else Info(`Skipped. Run  ${pyRel} tools\\deploy\\download_models.py --wizard  later.`)
  } else {
    // ⭐ 没有终端（或明确要求非交互）：**不问**，直接说清怎么补跑。
    //   ⛔ 绝不在这里读 stdin —— 阻塞等一个不会来的回答，
    //     那会让 CI 上的部署**挂到超时**，而它本来只需要跳过这一步。
    Info('No model selection available and no interactive terminal — skipping model download.')
    Info(`Run  ${pyRel} tools\\deploy\\download_models.py --wizard  to fetch them.`)
  }

  // =============================================================================
  //  小结
  // =============================================================================
  raw('')
  raw('============================================================')
  raw('  部署结果小结 / Deployment summary')
  raw('------------------------------------------------------------')
  Ok('  依赖 (dependencies) : installed')
  if (PLATFORM_ONLY) {
    // ⭐ 不是「缺失」，是**按要求没装**。⛔ 不许报成 MISSING/FAILED ——
    //   那会让用户去补装那 5-6GB，正好把「平台瘦下来」这件事抵消掉。
    Info('  PyTorch             : 未安装（--platform-only；各引擎自带自己的环境）')
    Info('                        训练线不可用；每台引擎要装它自己那份 torch。')
  } else if (TORCH_OK) {
    Ok('  PyTorch             : OK (import verified)')
  } else {
    raw('  PyTorch             : MISSING / FAILED  <== 需要手动补装!')
    raw('     修复: 运行 tools\\deploy\\install-torch.bat  (macOS/Linux 用 .sh)')
    raw('           若被杀毒(如迈克菲)拦截, 先把本目录加入杀软白名单,')
    raw('           或先设置 TTS_NO_UV=1 再重试。')
  }
  if (FFMPEG_OK) {
    Ok('  ffmpeg/ffprobe      : OK')
  } else {
    raw('  ffmpeg/ffprobe      : MISSING  <== 人声分离(UVR5)需要它!')
    raw(`     修复: ${pyRel} tools\\deploy\\download_ffmpeg.py`)
  }
  if (NODE_OK) {
    Ok('  后端 node 依赖        : OK (npm ci)')
  } else {
    raw('  后端 node 依赖        : MISSING / FAILED  <== 后端服务无法启动!')
    raw('     修复: 在项目根目录运行下面这条（⛔ 不要用 npm.cmd，理由见下）:')
    raw('       tools\\runtime\\node\\node.exe tools\\runtime\\node\\node_modules\\npm\\bin\\npm-cli.js ci')
    raw('       npm.cmd 按 PATH 推断 npm 在哪 ⇒ 装过全局 Node 的机器上会跳到全局')
    raw('       那份（版本对不上，报 ERR_REQUIRE_ESM，而错误里一个字都不提这回事）')
    raw('           (需要 package-lock.json 与 node 运行时;详见部署日志)')
  }
  raw('============================================================')
  raw('')
  // 后端同时需要 torch（推理）与 node 依赖（broker 进程本身）。
  // ⭐ --platform-only：平台本身是 Node 进程，一个字节都不用 torch ⇒ 这一格不适用。
  if (PLATFORM_ONLY) {
    if (NODE_OK) Ok('Bootstrap finished (platform only). Run start.bat; install engines separately.')
    else Warn('Bootstrap finished, but backend node deps are missing — restore them before start.bat.')
  } else if (TORCH_OK && NODE_OK) {
    Ok('Bootstrap finished. You can now run start.bat')
  } else if (!TORCH_OK && !NODE_OK) {
    Warn('Bootstrap finished, but PyTorch AND backend node deps are missing — fix both before start.bat.')
  } else if (!TORCH_OK) {
    Warn('Bootstrap finished, but PyTorch is missing — install it before running start.bat.')
  } else {
    Warn('Bootstrap finished, but backend node deps are missing — restore them before running start.bat.')
  }
  say('DarkCyan', `full log: ${LOG_FILE}`)
  process.exit(0)
}

// ⭐ 顶层 await 与 require 不能共存（ERR_AMBIGUOUS_MODULE_SYNTAX），
//   所以整个主体在 main() 里跑。
main().catch(e => {
  console.error('[deploy][FATAL] ' + (e && e.stack ? e.stack : e))
  try { say('DarkCyan', `full log: ${LOG_FILE}`) } catch (_) {}
  process.exit(1)
})
