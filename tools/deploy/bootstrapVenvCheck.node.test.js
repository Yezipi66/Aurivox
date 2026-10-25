'use strict'

// 根 venv 的健康检查判据：能不能跑 **且** base 是不是当前内嵌解释器。
//
// 背景（docs/ONBOARDING_PLAN.md A22）：平台根 venv 被外部工具换成了 CPython 3.14.7，
// 它照样能跑，于是旧的健康检查说「already exists and works」。
// 而 tools/wheels 里的 jieba_fast 轮子只认 cp311 ⇒ 训练线装不上。
// 所以判据加了第二道：base 必须是内嵌解释器。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const { venvBaseMatches, inspectExistingVenv, sameInterpreterPath } = require('./bootstrap.js')
const { canSpawnPython, askPathForAbsolute } = require(path.join(ROOT, 'lib', 'util', 'pythonResolve.js'))

/**
 * 找一个真的能按绝对路径跑起来的解释器，当这条文件的正样本。
 *
 * 不用固定那一个：仓库内嵌解释器是很大的二进制，不进版本库，
 * 干净检出与 CI 上都没有它。拿它当唯一正样本，这组守卫在 CI 上恒红，
 * 而它守的东西（base 是不是这个解释器）与「是哪一个解释器」无关。
 * 候选顺序与 lib/util/pythonResolve.js 的 projectPythonCandidates 一致。
 */
function positivePython () {
  const candidates = [
    path.join(ROOT, 'tools', 'runtime', 'python', 'python.exe'),
    path.join(ROOT, 'tools', 'runtime', 'python', 'bin', 'python3'),
    path.join(ROOT, 'venv', 'Scripts', 'python.exe'),
    path.join(ROOT, 'venv', 'bin', 'python'),
  ]
  for (const name of ['python3', 'python']) {
    const abs = askPathForAbsolute(name)
    if (abs) candidates.push(abs)
  }
  for (const c of candidates) {
    if (canSpawnPython(c)) return c
  }
  return null
}

/** 造一个只有 pyvenv.cfg 的假 venv 目录 */
function makeCfg (dir, executable) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pyvenv.cfg'),
    'home = ' + path.dirname(executable) + '\n'
    + 'include-system-site-packages = false\n'
    + 'version = 3.11.9\n'
    + 'executable = ' + executable + '\n',
    'utf8')
  return dir
}

function tmpDir (name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-venvchk-' + name + '-'))
}

test('正样本：找一个能按绝对路径跑起来的解释器', () => {
  const py = positivePython()
  assert.ok(py,
    '一个能用的解释器都找不到：内嵌解释器、平台根 venv、PATH 上的 python 都没有')
})

test('base 就是这个解释器 ⇒ 通过', () => {
  const py = positivePython()
  const dir = makeCfg(tmpDir('ok'), py)
  const r = venvBaseMatches(dir, py)
  assert.strictEqual(r.ok, true, `应通过，实际 ${r.reason}`)
  assert.strictEqual(r.reason, 'base-matches')
})

test('base 是别的解释器 ⇒ 不通过，并说清 base 是谁', () => {
  const py = positivePython()
  const dir = makeCfg(tmpDir('diff'), 'C:\\somewhere\\else\\python.exe')
  const r = venvBaseMatches(dir, py)
  assert.strictEqual(r.ok, false, 'base 不同就该不通过')
  assert.strictEqual(r.reason, 'base-differs')
  assert.ok(r.base && r.base.includes('else'), '要报出 base 是谁')
})

test('pyvenv.cfg 读不到 ⇒ 不通过（不能当成健康）', () => {
  const py = positivePython()
  const dir = tmpDir('nocfg')
  const r = venvBaseMatches(dir, py)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'no-base-in-pyvenv-cfg')
})

test('pyvenv.cfg 里没有 executable 那一行 ⇒ 不通过', () => {
  const py = positivePython()
  const dir = tmpDir('noexe')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pyvenv.cfg'), 'home = C:\\x\nversion = 3.11.9\n', 'utf8')
  const r = venvBaseMatches(dir, py)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'no-base-in-pyvenv-cfg')
})

test('base 路径大小写不同也算同一个（Windows 不区分大小写）', () => {
  const py = positivePython()
  const dir = makeCfg(tmpDir('case'), py.toUpperCase())
  const r = venvBaseMatches(dir, py)
  assert.strictEqual(r.ok, true, 'Windows 上路径不区分大小写，不该误判')
})

test('解释器缺失 ⇒ 不通过', () => {
  const py = positivePython()
  const dir = tmpDir('nointerp')
  const r = inspectExistingVenv(dir, path.join(dir, 'Scripts', 'python.exe'), py)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'no-interpreter')
})

test('解释器能跑但 base 不是这个解释器 ⇒ 不通过（这是 3.14 那个场景）', () => {
  // 真的建一个能跑的 venv，但它的 base 指向别处
  const py = positivePython()
  const dir = path.join(tmpDir('livewrong'), '.venv')
  const { spawnSync } = require('node:child_process')
  const r = spawnSync(py, ['-m', 'venv', dir], { encoding: 'utf8', timeout: 180000 })
  assert.strictEqual(r.status, 0, '造不出测试用的 venv')
  // 把 pyvenv.cfg 的 base 改掉，模拟「外部工具换过 Python」
  const cfgPath = path.join(dir, 'pyvenv.cfg')
  const cfg = fs.readFileSync(cfgPath, 'utf8')
    .replace(/^executable\s*=.*$/m, 'executable = C:\\other\\python.exe')
  fs.writeFileSync(cfgPath, cfg, 'utf8')
  const vpy = path.join(dir, process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
  const rr = inspectExistingVenv(dir, vpy, py)
  assert.strictEqual(rr.ok, false, 'base 不对就必须重建，哪怕解释器能跑')
  assert.strictEqual(rr.reason, 'base-differs')
})

test('解释器能跑且 base 是这个解释器 ⇒ 通过', () => {
  const py = positivePython()
  const dir = path.join(tmpDir('liveok'), '.venv')
  const { spawnSync } = require('node:child_process')
  const r = spawnSync(py, ['-m', 'venv', dir], { encoding: 'utf8', timeout: 180000 })
  assert.strictEqual(r.status, 0, '造不出测试用的 venv')
  const vpy = path.join(dir, process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
  const rr = inspectExistingVenv(dir, vpy, py)
  assert.strictEqual(rr.ok, true, `应通过，实际 ${rr.reason}`)
})

// ------------------------------------------------------------------
// 路径比较这一层：symlink 与真身算同一个
// ------------------------------------------------------------------

test('base 是指向同一个文件的 symlink ⇒ 算同一个解释器', () => {
  // 这条是 posix 上的真实形状：CPython 建 venv 时往 pyvenv.cfg 里写的是
  // `os.path.realpath(sys.executable)`（Lib/venv/__init__.py 的
  // create_configuration），symlink 已经被解析掉了。
  // 于是 base 记的是真身路径，与「建它时用的那个入口路径」字符串不同，
  // 但指向同一个文件 ⇒ 不能判成「base 不是它」。
  // 只比字符串的话，posix 上根 venv 每次都被判不健康 ⇒ bootstrap 每次重建。
  //
  // 夹具用「链接一个目录」而不是「链接解释器文件」：
  // Windows 上建文件级 symlink 要管理员权限（EPERM），目录级 junction 不要。
  const py = positivePython()
  const d = tmpDir('link')
  const linkDir = path.join(d, 'linked-python-dir')
  try {
    fs.symlinkSync(path.dirname(py), linkDir, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (e) {
    // 建不出链接的机器上这条验不了，但不许假装通过。
    assert.fail(`造不出目录链接：${e.message}`)
  }
  const linkedPy = path.join(linkDir, path.basename(py))
  assert.strictEqual(fs.existsSync(linkedPy), true, '链接里的解释器要能访问')
  assert.notStrictEqual(path.resolve(linkedPy), path.resolve(py),
    '两条路径的字符串要不同（否则这条验不到 realpath 这一层）')
  assert.strictEqual(sameInterpreterPath(linkedPy, py), true,
    '链接路径与它的真身是同一个解释器')
  // 走完整的判据，验的是 posix 上的真实形状：
  //   传进来的解释器是链接路径（venv 的 bin/python 就是这种），
  //   base 记的却是真身路径（CPython 写的是 realpath(sys.executable)）。
  //   两个字符串不同，但指向同一个文件 ⇒ 判据要通过。
  // 只比字符串的话这里会判否 ⇒ posix 上根 venv 每次都被判不健康。
  const dir = makeCfg(tmpDir('linkcfg'), fs.realpathSync.native(py))
  const r = venvBaseMatches(dir, linkedPy)
  assert.strictEqual(r.ok, true, `应通过，实际 ${r.reason}`)
})

test('路径不存在时按绝对路径比 ⇒ 不同的路径仍判否', () => {
  const d = tmpDir('gone')
  const missing = path.join(d, 'no-such-python')
  assert.strictEqual(sameInterpreterPath(missing, path.join(d, 'other')), false)
})
