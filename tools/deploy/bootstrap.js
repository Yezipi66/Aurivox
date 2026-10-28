/**
 * 两个路径是不是同一个可执行文件。
 *
 * 比的是 realpath，不是路径字符串：CPython 建 venv 时往 pyvenv.cfg 里写的
 * `executable` 是 `os.path.realpath(sys.executable)`（Lib/venv/__init__.py 的
 * create_configuration），已经把 symlink 解析掉了。
 *   · posix 上 venv 的 bin/python 是指向 base 的 symlink ⇒ 记进去的是真 base 路径，
 *     与「建 venv 时用的那个入口路径」字符串不同，但指向同一个文件。
 *   · Windows 上 venv 的 Scripts\python.exe 是复制 ⇒ realpath 不变，字符串相同。
 * 所以只比字符串的话，posix 上永远判成「base 不是它」⇒ 根 venv 每次都被判不健康
 * （bootstrap.js 的健康检查与建完后的复核都会误判）。
 *
 * 大小写只在 Windows 上归一：那边文件系统不区分大小写，
 * `C:\Python\python.exe` 与 `c:\python\python.exe` 是同一个文件。
 * posix 上文件系统区分大小写，把两条不同路径强行归一成一个
 * 会把「不是同一个文件」判成「是」⇒ 那是把坏 venv 当成好的。
 *
 * 路径不存在时 realpathSync 会抛（base 指向的旧解释器已被删掉正是要抓的场景）
 * ⇒ 退回按解析后的绝对路径比：路径不同仍然判否，不会把坏 venv 当成好的。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameInterpreterPath (a, b) {
  const fold = process.platform === 'win32'
  const norm = (p) => {
    let out
    try { out = fs.realpathSync.native(p) }
    catch (_) { out = path.resolve(p) }
    return fold ? out.toLowerCase() : out
  }
  return norm(a) === norm(b)
}

/**
 * 这个 venv 是不是从当前内嵌解释器部署出来的。
 *
 * 判据读 `pyvenv.cfg` 里的 `executable`（建它时用的 base 解释器绝对路径）
 * 与当前内嵌解释器比。
 *
 * 为什么比 base 而不是比版本号：
 *   venv 不可搬运，`pyvenv.cfg` 把 base 的绝对路径烤进去了。
 *   项目目录被移动 / 改名，或本机的 Python 被外部工具换过版本之后，
 *   现有 venv 仍指向那个旧 base。而 `tools/wheels/` 里的轮子按 ABI 钉死
 *   （例如 jieba_fast 只认 cp311）⇒ base 换了版本，轮子就装不上。
 *   所以「能不能跑」不够，要「是不是从这个 base 来的」。
 *
 * @param {string} venvDir venv 目录
 * @param {string} embeddedPython 当前内嵌解释器的绝对路径
 * @returns {{ok:boolean, reason:string, base:string|null, embedded:string}}
 */
function venvBaseMatches (venvDir, embeddedPython) {
  const embedded = path.resolve(embeddedPython)
  let cfg = ''
  try { cfg = fs.readFileSync(path.join(venvDir, 'pyvenv.cfg'), 'utf8') } catch (_) { /* 读不到当没有 */ }
  const m = cfg.match(/^executable\s*=\s*(.+)$/m)
  const base = m ? m[1].trim() : null
  if (!base) {
    return { ok: false, reason: 'no-base-in-pyvenv-cfg', base: null, embedded }
  }
  if (!sameInterpreterPath(base, embedded)) {
    return { ok: false, reason: 'base-differs', base, embedded }
  }
  return { ok: true, reason: 'base-matches', base, embedded }
}

/**
 * 现有 venv 能不能用。
 *
 * 两道判据，都要过：
 *   ① 解释器能跑（`import sys` 退出码 0）；
 *   ② base 是当前内嵌解释器（见 venvBaseMatches）。
 *
 * 只判「能跑」会漏掉一类情况：外部工具把本机 Python 换成了别的版本，
 * venv 照样能跑，但它的 ABI 与平台基座不同，轮子会装不上。
 */
function inspectExistingVenv (venvDir, venvPythonExe, embeddedPython) {
  if (!fs.existsSync(venvPythonExe)) {
    return { ok: false, reason: 'no-interpreter', base: null }
  }
  const r = spawnSync(venvPythonExe, ['-c', 'import sys'], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) {
    return { ok: false, reason: 'cannot-run', base: null }
  }
  const base = venvBaseMatches(venvDir, embeddedPython)
  if (!base.ok) {
    return { ok: false, reason: base.reason, base: base.base }
  }
  return { ok: true, reason: 'healthy', base: base.base }
}

// 首次部署的主体（跨平台）：定位 Python 3.11、建 venv、装依赖、装 torch / onnxruntime、
// 装 ffmpeg、恢复后端 node 依赖、自检导入、下载模型。bootstrap.bat 与 bootstrap.sh 是薄壳，只调这份主体。
// 恢复 node 依赖走 `node node_modules/npm/bin/npm-cli.js`，不调 npm.cmd：npm.cmd 按 PATH 推断前缀，
// 装过全局 Node 的机器上会跳到全局那份，版本不一致，报 ERR_REQUIRE_ESM 而错误里不提这件事。

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

// deploy.bat 可能用 `-File x.ps1 --platform-only` 的形式调过来，参数里会带那个 `-File`。
// 只认认识的开关，其余忽略：不认识的参数就报错是给 CLI 用的，不是给内部调用的。
const argv = process.argv.slice(2)
// --platform-only：只装平台自己的工具链包，不装 torch。默认保持原样（false）。
const PLATFORM_ONLY = argv.includes('--platform-only') || argv.includes('-PlatformOnly')

// --dry-run：只走「找解释器 / 认 venv / 算清楚要装什么」这些只读的部分，然后把计划打出来就停。
// 它停在 venv 健康检查之前：健康检查发现 venv 坏了会真的重建，所以 dry-run 不承诺「什么都没改」。
const DRY = argv.includes('--dry-run')

// --venv-only：只做「把根 venv 部署成当前内嵌解释器」这一件事，即建/重建 venv 与装平台工具链包，
//   然后就停。不装 torch、不下 ffmpeg、不恢复 node 依赖、不问模型。
//   为什么单独一个入口：根 venv 的 base 会被外部工具换掉，
//   「重建根 venv」这件事本身要能独立、无人值守地重复做。
//   它固定走平台瘦版那份 requirements（--platform-only 的语义）：
//   根 venv 是平台的环境，引擎依赖归各引擎自己的 .venv。
const VENV_ONLY = argv.includes('--venv-only') || argv.includes('-VenvOnly')

// 每条 [deploy] 消息都追加进日志文件。事后排查依赖这份日志。
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

/** 原样打印（不带 [deploy] 前缀），给自检那些第三方输出看 */
function raw (m) {
  console.log(m)
  try { fs.appendFileSync(LOG_FILE, m + '\n', 'utf8') } catch (e) { console.warn('[deploy] 日志写不进去不该拦住部署：', e.message) }
}

// 跑一个原生命令，输出直接进终端。进度条要能实时看见且不经过中间层，所以用 stdio: 'inherit'。
// 第三个参数可传输出文件（要留档时用），此时 inherit 换成落盘。
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

// 跑一个 python 探针脚本。不把多词字符串塞进 `python -c`：Windows 的原生参数重解析会把引号吃掉
//// （python 只收到一段残缺代码，报 SyntaxError）。落一个临时文件再跑，不依赖 shell 的引号规则。
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
  // 0. 向导的旁白文件（deploy_wizard.py 写的）
  // deploy.bat 先跑 deploy_wizard.py（许可确认 + 选模型），向导在本脚本旁边放两个旁白文件：
  //   .deploy_models.txt  → 逗号分隔的模型组（"core,g2pw,asr"），或空
  //   .deploy_ffmpeg.txt  → "1" 下载 ffmpeg，"0" 跳过
  // 有就读；没有就走交互。null 表示「没这个文件 ⇒ 交互」。
  function readSidecar (name) {
    const p = path.join(SCRIPT_DIR, name)
    if (!fs.existsSync(p)) return null
    const c = fs.readFileSync(p, 'utf8')
    return c ? c.trim() : ''
  }
  const SEL_MODELS = readSidecar('.deploy_models.txt')
  const SEL_FFMPEG = readSidecar('.deploy_ffmpeg.txt')

  // 非 ASCII 安装路径：警告，不拒绝。下面给所有子进程强制了 UTF-8，现代 Windows 一般能处理 Unicode 路径。
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

    // 全部路径常量。集中在这里，第 2 / 3 / 4c 步与 dry-run 报告读的是同一批路径，
    // 报告与执行不会不一致。
    const VENV = path.join(ROOT, 'venv')
    const WHEELS = path.join(ROOT, 'tools', 'wheels')
    // --venv-only 固定走瘦版：根 venv 是平台的环境，引擎依赖归各引擎自己的 .venv。
    const REQ = path.join(ROOT,
      (PLATFORM_ONLY || VENV_ONLY) ? 'requirements-platform.txt' : 'requirements-gpt-sovits.txt')
    const NODE_DIR = path.join(ROOT, 'tools', 'runtime', 'node')
    const NODE_EXE = path.join(NODE_DIR, IS_WIN ? 'node.exe' : 'node')
    const NPM_CLI = path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js')

    // 1. 定位 Python 3.11
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
    // Windows 上 `where python` 可能返回 Microsoft Store 的桩（App Execution Alias），那个东西一跑就弹出商店。
    // 所以候选逐个试真能 --version 的。
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

  // 2. 建 venv。venv 的解释器路径按平台推导：Windows 是 Scripts\python.exe，macOS/Linux 是 bin/python。
  const vr = venvPython(VENV, process.platform)
  if (!vr.ok) Die(vr.why)
  const VENV_PY = vr.python

  if (DRY) {
  // 只读的那一半到此为止
  const reqPath = REQ
  const vrDry = venvPython(VENV, process.platform)
  const wheels = fs.existsSync(WHEELS)
    ? fs.readdirSync(WHEELS).filter(f => f.endsWith('.whl')).length : 0
  const npmCliOk = fs.existsSync(NODE_EXE) && fs.existsSync(NPM_CLI)
  raw('')
  raw('--dry-run：没有装任何东西、没有改任何文件。以下是实际会执行的步骤：')
  raw('')
  raw('  解释器      ' + EMB_PY + '  (' + pyver + ')')
  raw('  venv 目录   ' + VENV)
  raw('  venv 解释器 ' + (vrDry.ok ? vrDry.python : '缺失：' + vrDry.why))
  raw('  requirements ' + path.basename(reqPath) +
      (fs.existsSync(reqPath) ? '' : '   不存在！'))
  raw('  本地 wheel  ' + (wheels ? wheels + ' 个' : (fs.existsSync(WHEELS) ? '目录是空的' : '缺失：tools/wheels 不存在')))
  raw('  uv          ' + (process.env.TTS_NO_UV === '1' ? '跳过（TTS_NO_UV=1）' : '装，装不上退回 pip'))
  if (VENV_ONLY) {
    raw('  torch       跳过（--venv-only）')
    raw('  ffmpeg      跳过（--venv-only）')
    raw('  npm         跳过（--venv-only）')
    raw('  模型        跳过（--venv-only）')
  } else {
    raw('  torch       ' + (PLATFORM_ONLY ? '跳过（--platform-only）' : '委托 tools/cli/install-torch.js'))
    raw('  ffmpeg      ' + (SEL_FFMPEG === '0' ? '跳过（向导没选）' : fs.existsSync(path.join(SCRIPT_DIR, 'download_ffmpeg.py')) ? '下载' : '缺失：download_ffmpeg.py 不存在'))
    raw('  npm         ' + (npmCliOk ? 'node + npm-cli.js（不走 npm.cmd）'
      : fs.existsSync(path.join(ROOT, 'package.json')) ? '⚠️ 自带 npm 不在 → 退回 PATH 上的 npm' : '缺失：package.json 不存在'))
    raw('  模型        ' + (SEL_MODELS === null ? '没有旁白文件 → 看有没有终端' : SEL_MODELS === '' ? '向导没选 → 跳过' : '下：' + SEL_MODELS))
  }
  raw('')
  raw('  去掉 --dry-run 即真正部署。')
  raw('')
  say('DarkCyan', `full log: ${LOG_FILE}`)
  process.exit(0)
}

  // venv 不可搬运：pyvenv.cfg 把建它的那个 base 解释器的绝对路径烤了进去。项目目录被移动或改名之后，
  // 现有 venv 的解释器仍指向旧 base 路径，每次调用都死在 `No Python at '...\python.exe'`。
  // 所以不盲信现有 venv：先健康检查，坏了就对着当前内嵌运行时重建。
  // 健康检查有两道判据（inspectExistingVenv）：解释器能跑，且 base 就是当前内嵌解释器。
  //   只判「能跑」会漏掉「外部工具把本机的 Python 换成了别的版本」：
  //   venv 照样能跑，但它的 ABI 与平台基座不同，tools/wheels 里的 cp311 轮子装不上。
  const existing = inspectExistingVenv(VENV, VENV_PY, EMB_PY)
  let venvOk = existing.ok
  if (venvOk) {
    Ok(`venv already exists and works: ${VENV}`)
  } else {
    if (fs.existsSync(VENV)) {
      const why = existing.reason === 'base-differs'
        ? `its base interpreter is ${existing.base}, not the embedded runtime ${EMB_PY}`
        : existing.reason === 'cannot-run'
          ? 'its interpreter cannot run'
          : existing.reason === 'no-interpreter'
            ? 'its interpreter is missing'
            : 'its pyvenv.cfg does not name a base interpreter'
      Warn(`existing venv is broken or was moved from another path (${why}); rebuilding it: ${VENV}`)
      try { fs.rmSync(VENV, { recursive: true, force: true }) }
      catch (e) { Die(`删不掉坏掉的 venv（${VENV}）：${e.message}\n        可能有进程正占着它。`) }
    }
    Info('creating venv ...')
    const r = runNative(EMB_PY, ['-m', 'venv', VENV])
    if (!fs.existsSync(VENV_PY)) Die('venv creation failed.')
    // 刚建出来的 venv 必须真的能跑：只看文件在不够。
    const chk = spawnSync(VENV_PY, ['-c', 'import sys'], { encoding: 'utf8', windowsHide: true })
    if (chk.status !== 0) Die('venv was created but its python cannot run. Check the embedded runtime.')
    // 而且它的 base 必须就是当前内嵌解释器，否则装的是另一个 ABI 的轮子。
    const built = venvBaseMatches(VENV, EMB_PY)
    if (!built.ok) {
      Die(`venv was created but its base is not the embedded runtime `
        + `(pyvenv.cfg says ${built.base || 'nothing'}, expected ${EMB_PY}). `
        + 'The embedded runtime may be incomplete.')
    }
    Ok('venv created.')
  }

  // 升 pip
  Info('upgrading pip / setuptools / wheel ...')
  runNative(VENV_PY, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools<81', 'wheel'])

  // 装 uv。并行下载 + 全局缓存，比 pip 快很多。它是个很小的无依赖 wheel；装不上就退回 pip。
  // 不关它的进度条、也不限制并行度：进度条实时显示在终端上（走 runNative 的 inherit），
  // 而若本机的杀软或 EDR 仍拦它，失败就自动退回 pip。
  if (!process.env.UV_HTTP_TIMEOUT) process.env.UV_HTTP_TIMEOUT = '120'
  // uv 的全局缓存与 venv 常在不同盘，hardlink 不可用时它会一边探测一边退回整份拷贝并打警告。
  // 直接让它拷贝：没有警告，行为确定。
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

  // 3. 装项目依赖（不含 torch）。两份 requirements 的分工：requirements-gpt-sovits.txt 是推理栈的依赖
  // （含 torch，体积很大），requirements-platform.txt 是平台自己要的几个工具链包（很小）。
  // 默认装含 torch 的那份：训练线要 torch，切默认会让训练立刻不可用。
  // REQ 已在上面按开关选好了（--venv-only 固定走瘦版）。
  if (PLATFORM_ONLY || VENV_ONLY) {
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
  // requirements 是完整的 pip freeze 快照（每个传递依赖都被钉住）。用 --no-deps 装，让 pip 逐个按 pin 装，
  // 不跑依赖解析器。这是复现冻结环境的正确方式，也避开「纸面冲突」（比如新版 fsspec vs 旧 datasets 上界）：
  // 那些冲突在冻结它的环境里并不存在。
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
      // 刻意不退回带解析器重试。requirements 是给 --no-deps 用的冻结快照；带解析器重跑只会翻出那些纸面冲突
      // （accelerate 要 torch>2.2 vs 钉死的 torch==2.2.0+cu121），而它们在冻结环境里毫无影响。
      // --no-deps 失败意味着有一个包取不到或建不起来：看上面最后一条错误。
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

  // 轻量自检：pip check。--no-deps 相信冻结是完整的。做个轻量核对，让漏掉的 pin 在这里带着明确提示冒出来，
  // 而不是变成后面某个莫名的 import 错误。
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

  // --venv-only：根 venv 部署完毕，到此为止。
  //   不装 torch、不下 ffmpeg、不恢复 node 依赖、不问模型：
  //   那些是「平台其余部分」，与「根 venv 用哪个 base 部署」是两件事。
  if (VENV_ONLY) {
    const ver = spawnSync(VENV_PY, ['--version'], { encoding: 'utf8', windowsHide: true })
    const vtxt = ((ver.stdout || '') + (ver.stderr || '')).trim()
    Ok(`venv deployed from the embedded runtime: ${VENV}`)
    Ok(`  interpreter : ${VENV_PY} (${vtxt})`)
    Ok(`  base        : ${EMB_PY}`)
    say('DarkCyan', `full log: ${LOG_FILE}`)
    process.exit(0)
  }

  // 4. torch + onnxruntime：委托给跨平台主体。两者都不在 requirements 里（体积大、构建目标相关、
  // 独立 index、按设备条件），由它们自己那个可重跑的安装器处理，它用一次设备探测为两者选 CUDA / XPU / ROCm / CPU。
  // 脚本缺失时直接报错，不留 inline 回退：第二份安装逻辑迟早与主体漂开。
  const TORCH_BODY = path.join(ROOT, 'tools', 'cli', 'install-torch.js')
  let TORCH_OK = false
  if (PLATFORM_ONLY) {
    // torch 体积很大，而平台（Node 进程）一个字节都用不到它：fastapi/uvicorn 只被推理侧的
    // infer_server.py 用，routes/ 零重依赖。
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

  // 通过真的 import 来验证 torch，那是唯一可信的信号。被杀软杀掉的 uv/pip（或一次网络错误）会留下
  // 「步骤完成了但 torch 根本没装」的状态。我们把它放进最后的小结里，让 torch 缺失无法被忽略。
  // --platform-only 时不跑这段：跳过安装之后若照旧跑 import torch，它必然失败，报出来的是「PyTorch 未装好」
  // 而真实原因是「按开关跳过了」。那个症状极具欺骗性：它把「按开关跳过」说成「装失败了」，
  // 而使用者看到之后会去重跑 install-torch，正好装上那几 GB。
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

  // 4b. ffmpeg + ffprobe（项目内，不动全局）。UVR5 人声分离（pipeline/uvr5/webui.py）与后端的音频转码
  // 都要 ffmpeg/ffprobe。download_ffmpeg.py 把静态构建取进 vendor\ffmpeg\<platform>\（幂等：已能跑就跳过）。
  // 这里失败非致命，后端会退到系统 ffmpeg / WAV，但人声分离没有它就不行，所以要在小结里把状态说出来。
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

  // 4c. 后端 node 依赖（npm ci）。node_modules 不随包分发（04_pack_release.py 把它排除了：缩小 zip，
  // 而且不物理再分发第三方 npm 包）。这里从随包的 package-lock.json 恢复后端与根部的生产依赖。
  // 前端随包已构建（web\dist），它自己的 node_modules 运行时不需要，只有 server.js 用的那些。
  let NODE_OK = false
  const PKG_JSON = path.join(ROOT, 'package.json')
  const PKG_LOCK = path.join(ROOT, 'package-lock.json')
  const NODE_MODULES = path.join(ROOT, 'node_modules')

  if (!fs.existsSync(PKG_JSON)) {
    Warn(`package.json not found at project root: ${PKG_JSON} — skipping node deps.`)
  } else {
    // 优先 `node node_modules/npm/bin/npm-cli.js`，不调 npm.cmd：npm.cmd 靠 PATH 推断 npm 在哪，装过全局 Node 的
    // 机器上会跳到全局那份，版本不一致，报 ERR_REQUIRE_ESM 而错误里不提这件事。
    let npmExe = null
    let npmArgs = null
    if (fs.existsSync(NODE_EXE) && fs.existsSync(NPM_CLI)) {
      npmExe = NODE_EXE
      npmArgs = [NPM_CLI]
      // 自带的 node 目录排到 PATH 最前。
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
      // 快路径：node_modules 已恢复时跳过（npm 成功安装后会写这个标记）。否则每次重新部署都会 wipe + 重装一遍。
      const nmMarker = path.join(NODE_MODULES, '.package-lock.json')
      if (fs.existsSync(NODE_MODULES) && fs.existsSync(nmMarker)) {
        Ok('backend node deps already present — skipping npm install (delete node_modules\\ to force).')
        NODE_OK = true
      } else {
        // npm ci 可复现且严格照锁文件，但它要求锁文件存在。只有锁文件缺失时才退回 `npm install`。
        // 刻意不带 --omit=dev：后端依赖（express / cors / multer / js-yaml / argparse 及其传递依赖）全是极小的运行时包，
        // 没有 dev-only 的臃肿可省，而去掉 --omit=dev 能消除「某个运行时包恰好落在 devDependencies 里」的风险。
        // npm ci 装的正是 package-lock.json 钉住的东西。
        const args = npmArgs.concat(fs.existsSync(PKG_LOCK)
          ? ['ci', '--no-audit', '--no-fund']
          : ['install', '--no-audit', '--no-fund'])
        if (!fs.existsSync(PKG_LOCK)) {
          Warn('package-lock.json missing — falling back to `npm install` (NOT reproducible).')
        }
        Info(fs.existsSync(PKG_LOCK)
          ? 'restoring backend node deps: npm ci ...'
          : 'restoring backend node deps: npm install ...')
        const n = runNative(npmExe, args, { cwd: ROOT })   // npm 必须在持有 package.json 的目录里跑
        if (n.rc === 0 && fs.existsSync(NODE_MODULES)) { NODE_OK = true; Ok('backend node deps installed.') }
        else Warn('npm install FAILED — the backend server will not start until deps are restored.')
      }
    }
  }

  // 4d. 刷新 node 包许可清单。node_modules 不随包分发，它的逐包许可能只能在 npm ci 恢复之后才读。
  // 从已安装的元数据重新生成 THIRD_PARTY_LICENSES/runtime/node_packages.json，
  // 让许可中心反映真正装上了什么。
  // 这里失败从不拦住部署。
  if (NODE_OK) {
    const genNode = path.join(ROOT, 'tools', 'build', 'gen_node_licenses.py')
    if (fs.existsSync(genNode)) {
      const g = runNative(EMB_PY, [genNode, '--root', ROOT])
      if (g.rc === 0) Ok('node license inventory refreshed (THIRD_PARTY_LICENSES\\runtime\\node_packages.json).')
      else Warn('gen_node_licenses.py returned non-zero — node_packages.json not refreshed (non-fatal).')
    }
  }

  // 5. 自检导入。每个模块先打印再导入（立刻 flush），这样部署窗口能看到实时进度，
  // 而且万一某个 import 卡住，能确切看到卡在哪一个，而不是盯着一屏静默。
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

  // 尽力而为：hf_transfer（让模型下载更快：并行 + 分块）。download_models.py 在能 import 时会自动启用它；
  // 装它不是必须的。
  Info('installing hf_transfer (accelerates model downloads) ...')
  {
    const args = UV_OK
      ? ['-m', 'uv', 'pip', 'install', '--python', VENV_PY, 'hf_transfer']
      : ['-m', 'pip', 'install', 'hf_transfer']
    if (runNative(VENV_PY, args).rc !== 0) {
      Warn('hf_transfer install failed (non-fatal — downloads just use the default path).')
    }
  }

  // 6. 模型
  raw('')
  const dl = path.join(SCRIPT_DIR, 'download_models.py')
  const pyRel = path.relative(ROOT, VENV_PY)   // 用于提示的那条命令必须是相对路径，
                                               // 而绝不是 `venv\Scripts\python.exe`
                                               // （macOS/Linux 上没有那个布局）
  if (!fs.existsSync(dl)) {
    Warn(`download_models.py not found: ${dl}`)
  } else if (SEL_MODELS !== null) {
    // 非交互：控制台向导已经收集了模型选择（按许可组确认 + 选择），照办。
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
    // 独立 bootstrap（没有向导旁白）且真的有终端：保留交互提问。两个前提缺一不可：isTTY，否则在 CI 或管道里
    // 读 stdin 会一直等一个永远不会来的回答；TTS_NONINTERACTIVE=1，让「人在场但不想被问」的场合能跳过。
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
    // 没有终端（或明确要求非交互）：不问，直接说清怎么补跑。不在这里读 stdin，阻塞等一个不会来的回答，
    // 那会让 CI 上的部署挂到超时，而它本来只需要跳过这一步。
    Info('No model selection available and no interactive terminal — skipping model download.')
    Info(`Run  ${pyRel} tools\\deploy\\download_models.py --wizard  to fetch them.`)
  }

  // 小结
  raw('')
  raw('============================================================')
  raw('  部署结果小结 / Deployment summary')
  raw('------------------------------------------------------------')
  Ok('  依赖 (dependencies) : installed')
  if (PLATFORM_ONLY) {
    // 不是「缺失」，是按要求没装。不许报成 MISSING/FAILED，那会让使用者去补装那几 GB，
    // 正好把「平台瘦下来」这件事抵消掉。
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
    raw('     修复: 在项目根目录运行下面这条（不要用 npm.cmd，理由见下）:')
    raw('       tools\\runtime\\node\\node.exe tools\\runtime\\node\\node_modules\\npm\\bin\\npm-cli.js ci')
    raw('       npm.cmd 按 PATH 推断 npm 在哪 ⇒ 装过全局 Node 的机器上会跳到全局')
    raw('       那份（版本不匹配，报 ERR_REQUIRE_ESM，而错误里一个字都不提这回事）')
    raw('           (需要 package-lock.json 与 node 运行时;详见部署日志)')
  }
  raw('============================================================')
  raw('')
  // 后端同时需要 torch（推理）与 node 依赖（broker 进程本身）。--platform-only：平台本身是 Node 进程，
  // 一个字节都不用 torch，这一格不适用。
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

// 顶层 await 与 require 不能共存（ERR_AMBIGUOUS_MODULE_SYNTAX），所以整个主体在 main() 里跑。
// require.main 守卫：测试要 require 这份文件取里面的纯函数，
// 不能一 require 就把整个部署执行一遍。
if (require.main === module) {
  main().catch(e => {
    console.error('[deploy][FATAL] ' + (e && e.stack ? e.stack : e))
    try { say('DarkCyan', `full log: ${LOG_FILE}`) } catch (_) {}
    process.exit(1)
  })
}

module.exports = { venvBaseMatches, inspectExistingVenv, sameInterpreterPath }
