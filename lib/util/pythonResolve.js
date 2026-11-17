'use strict'

// 挑一个「真的能按绝对路径跑起来」的 Python。判据不能只看文件在不在：venv 文件在，
// 但 pyvenv.cfg 的 home 可能指向另一台机器，启动就报 trampoline failed to spawn；
// 也不能只看「能不能跑」：调用方要把路径交给平台做路径运算，裸名字参与不了。
// 安装路径里带 `*` 时按绝对路径 spawn 是 ENOENT，path.resolve 还会吃掉反斜杠，
// 所以必须验证 sys.executable 也能按绝对路径 spawn。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// 探测用的代码：必须真的执行一点东西，不能只问版本号（破损安装上两者会分叉）。
const PROBE_CODE = 'import sys; sys.stdout.write(sys.executable)'
const PROBE_TIMEOUT_MS = 20000

// 这个可执行文件能不能按绝对路径起起来并执行代码。裸名字通过不代表绝对路径也能跑。
function canSpawnPython (exe, opts = {}) {
  if (!exe || typeof exe !== 'string') return false
  // 相对路径 / 裸名字一律判否：那正是本文件要防的形状。
  if (!path.isAbsolute(exe)) return false
  let st
  try { st = fs.statSync(exe) } catch (e) { return false }
  // 目录也会被 existsSync 判成「在」，而 spawn 一个目录必然失败。
  if (!st.isFile()) return false

  let r
  try {
    r = spawnSync(exe, ['-c', PROBE_CODE], {
      encoding: 'utf8',
      timeout: opts.timeoutMs || PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: false,      // 走 shell 会被带空格的路径坑
    })
  } catch (e) {
    return false
  }
  if (r.error || r.status !== 0) return false
  // 一定要它把 sys.executable 吐出来：我们要的就是这个路径本身。
  return Boolean((r.stdout || '').trim())
}

// 按给定顺序找第一个能用的解释器；全都不行时试 PATH（借裸名问出绝对路径再复核）。
function firstWorkingPython (candidates, opts = {}) {
  for (const c of candidates || []) {
    if (canSpawnPython(c, opts)) return c
  }
  for (const name of (opts.pathNames || ['python3', 'python'])) {
    const abs = askPathForAbsolute(name, opts)
    if (abs && canSpawnPython(abs, opts)) return abs
  }
  return null
}

// 借一个 PATH 上的裸名字问出它自己的绝对路径。问不到就 null：绝不返回裸名字。
function askPathForAbsolute (name, opts = {}) {
  let r
  try {
    r = spawnSync(name, ['-c', PROBE_CODE], {
      encoding: 'utf8',
      timeout: opts.timeoutMs || PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
    })
  } catch (e) {
    return null
  }
  if (r.error || r.status !== 0) return null
  const abs = (r.stdout || '').trim()
  // 有些包装器吐的是启动器路径而不是真解释器，非绝对路径的一律不要。
  return abs && path.isAbsolute(abs) ? abs : null
}

// 部署时确定的那一个平台解释器，平台脚本一律用它。
//   bootstrap 用它建根 venv，venv/pyvenv.cfg 的 command 就是这一个路径；
//   版本固定、随仓库走，不随启动终端变化。没有候选、没有优先级、没有兜底：
//   拿不到就返回 null，由调用方报错并指路重装平台，不另找别的解释器。
function platformPython(rootDir) {
  const root = rootDir || path.join(__dirname, '..', '..')
  const exe = process.platform === 'win32'
    ? path.join(root, 'tools', 'runtime', 'python', 'python.exe')
    : path.join(root, 'tools', 'runtime', 'python', 'bin', 'python3')
  return canSpawnPython(exe) ? exe : null
}

// 只给测试用：按目录形状列几个候选，用来构造虚拟环境目录。
//   生产代码不用它列解释器，平台脚本走 platformPython。
function projectPythonCandidates (rootDir, leading = []) {
  return [
    ...leading,
    path.join(rootDir, 'tools', 'runtime', 'python', 'python.exe'),
    path.join(rootDir, 'tools', 'runtime', 'python', 'bin', 'python3'),
    path.join(rootDir, 'venv', 'Scripts', 'python.exe'),
    path.join(rootDir, 'venv', 'bin', 'python'),
  ]
}

module.exports = {
  canSpawnPython, firstWorkingPython, askPathForAbsolute,
  platformPython, projectPythonCandidates, PROBE_CODE,
}
