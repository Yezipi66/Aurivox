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

const { venvBaseMatches, inspectExistingVenv } = require('./bootstrap.js')

const EMB = path.join(__dirname, '..', '..', 'tools', 'runtime', 'python',
  process.platform === 'win32' ? 'python.exe' : 'python')

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

test('守卫：内嵌解释器在（否则后面几条测的是假场景）', () => {
  assert.ok(fs.existsSync(EMB), `内嵌解释器不在：${EMB}`)
})

test('base 就是内嵌解释器 ⇒ 通过', () => {
  const dir = makeCfg(tmpDir('ok'), EMB)
  const r = venvBaseMatches(dir, EMB)
  assert.strictEqual(r.ok, true, `应通过，实际 ${r.reason}`)
  assert.strictEqual(r.reason, 'base-matches')
})

test('base 是别的解释器 ⇒ 不通过，并说清 base 是谁', () => {
  const dir = makeCfg(tmpDir('diff'), 'C:\\somewhere\\else\\python.exe')
  const r = venvBaseMatches(dir, EMB)
  assert.strictEqual(r.ok, false, 'base 不同就该不通过')
  assert.strictEqual(r.reason, 'base-differs')
  assert.ok(r.base && r.base.includes('else'), '要报出 base 是谁')
})

test('pyvenv.cfg 读不到 ⇒ 不通过（不能当成健康）', () => {
  const dir = tmpDir('nocfg')
  const r = venvBaseMatches(dir, EMB)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'no-base-in-pyvenv-cfg')
})

test('pyvenv.cfg 里没有 executable 那一行 ⇒ 不通过', () => {
  const dir = tmpDir('noexe')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pyvenv.cfg'), 'home = C:\\x\nversion = 3.11.9\n', 'utf8')
  const r = venvBaseMatches(dir, EMB)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'no-base-in-pyvenv-cfg')
})

test('base 路径大小写不同也算同一个（Windows 不区分大小写）', () => {
  const dir = makeCfg(tmpDir('case'), EMB.toUpperCase())
  const r = venvBaseMatches(dir, EMB)
  assert.strictEqual(r.ok, true, 'Windows 上路径不区分大小写，不该误判')
})

test('解释器缺失 ⇒ 不通过', () => {
  const dir = tmpDir('nointerp')
  const r = inspectExistingVenv(dir, path.join(dir, 'Scripts', 'python.exe'), EMB)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'no-interpreter')
})

test('解释器能跑但 base 不是内嵌的 ⇒ 不通过（这是 3.14 那个场景）', () => {
  // 真的建一个能跑的 venv，但它的 base 指向别处
  const dir = path.join(tmpDir('livewrong'), '.venv')
  const { spawnSync } = require('node:child_process')
  const r = spawnSync(EMB, ['-m', 'venv', dir], { encoding: 'utf8', timeout: 180000 })
  assert.strictEqual(r.status, 0, '造不出测试用的 venv')
  // 把 pyvenv.cfg 的 base 改掉，模拟「外部工具换过 Python」
  const cfgPath = path.join(dir, 'pyvenv.cfg')
  const cfg = fs.readFileSync(cfgPath, 'utf8')
    .replace(/^executable\s*=.*$/m, 'executable = C:\\other\\python.exe')
  fs.writeFileSync(cfgPath, cfg, 'utf8')
  const py = path.join(dir, process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
  const rr = inspectExistingVenv(dir, py, EMB)
  assert.strictEqual(rr.ok, false, 'base 不对就必须重建，哪怕解释器能跑')
  assert.strictEqual(rr.reason, 'base-differs')
})

test('解释器能跑且 base 是内嵌的 ⇒ 通过', () => {
  const dir = path.join(tmpDir('liveok'), '.venv')
  const { spawnSync } = require('node:child_process')
  const r = spawnSync(EMB, ['-m', 'venv', dir], { encoding: 'utf8', timeout: 180000 })
  assert.strictEqual(r.status, 0, '造不出测试用的 venv')
  const py = path.join(dir, process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
  const rr = inspectExistingVenv(dir, py, EMB)
  assert.strictEqual(rr.ok, true, `应通过，实际 ${rr.reason}`)
})
