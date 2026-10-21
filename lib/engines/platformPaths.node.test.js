// lib/engines/platformPaths.js 的测试：名片上那些「Windows 形状」的路径。
// platformPaths 是纯函数，platform 显式传入，所以 macOS / Linux 的形状在这台 Windows
// 机器上就能测。这一层验到的是「形状对不对」，「在 macOS 上真跑起来」仍然验不到，
// 两者不是一回事。形状错了就是「在某个平台上引擎永远没装」。

const { listEngines } = require('./registry')

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const { venvPythonRelPath, venvPython, resolveEnginePython } = require('./platformPaths')


test('win32 → Scripts/python.exe（Windows 布局）', () => {
  assert.equal(venvPythonRelPath('win32'), path.join('Scripts', 'python.exe'))
  // 变异靶：写成 bin/python（posix 形状）⇒ 这条必须红
  assert.ok(venvPythonRelPath('win32').includes('Scripts'))
})

test('linux → bin/python', () => {
  assert.equal(venvPythonRelPath('linux'), path.join('bin', 'python'))
  // 变异靶：给 linux 也返回 Scripts/python.exe ⇒ 必须红（那个形状在 Linux 上永不成立）
  assert.ok(!venvPythonRelPath('linux').includes('Scripts'))
})

test('darwin → bin/python（与 linux 同形状）', () => {
  assert.equal(venvPythonRelPath('darwin'), path.join('bin', 'python'))
  // 变异靶：darwin 单独给个 Scripts ⇒ 必须红
  assert.ok(!venvPythonRelPath('darwin').includes('Scripts'))
})

test('不认识的平台 ⇒ null，⛔ 不猜', () => {
  // 猜错的后果：「指到一个不存在的文件」⇒ 报「这台引擎没装」，而用户什么都没做错。
  // 给 null 才能让调用方说「这个平台我不支持」，那是一句用户能看懂的话。
  assert.equal(venvPythonRelPath('freebsd'), null)
  assert.equal(venvPythonRelPath('sunos'), null)
  assert.equal(venvPythonRelPath(''), null)
  assert.equal(venvPythonRelPath(undefined), null)
  // 变异靶：兜底返回 win32 形状 ⇒ 必须红
  assert.notEqual(venvPythonRelPath('freebsd'), path.join('Scripts', 'python.exe'))
})


test('venvPython: 拼出完整路径', () => {
  const r = venvPython('/proj/engines/x/.venv', 'linux')
  assert.equal(r.ok, true)
  assert.equal(r.python, path.join('/proj/engines/x/.venv', 'bin', 'python'))
})

test('venvPython: 不支持的平台 ⇒ ok:false + 理由', () => {
  const r = venvPython('/proj/.venv', 'plan9')
  assert.equal(r.ok, false)
  // 理由里必须带平台名：用户看到的是这句
  assert.match(r.why, /plan9/)
})


test('resolveEnginePython: 名片给相对目录，按平台落成绝对路径', () => {
  const r = resolveEnginePython('/proj', 'engines/x/.venv', 'linux')
  assert.equal(r, path.resolve('/proj', 'engines/x/.venv', 'bin', 'python'))
})

test('resolveEnginePython: 同一张名片在三个平台上落三个位置', () => {
  // 这条是本文件存在的全部理由：一张名片在 win32/linux/darwin 上都必须落到存在的那个文件上。
  const declared = 'engines/x/.venv'
  const seen = ['win32', 'linux', 'darwin'].map(
    (p) => resolveEnginePython('/proj', declared, p))
  assert.equal(new Set(seen).size, 2, 'win32 一个形状，posix 两个平台一个形状')
  assert.ok(seen.every((p) => p.startsWith(path.resolve('/proj', declared))),
    '三个都必须落在同一个 venv 目录里')
})

test('resolveEnginePython: 不支持的平台仍给形状正确的路径（让老报错继续成立）', () => {
  // 理由：换掉错误形状会让「这台引擎没装」变成更难懂的一句话。envCheck 那层会另外报
  // 「这个平台不支持」，两件事分开说。
  const r = resolveEnginePython('/proj', 'venv', 'plan9')
  assert.equal(r, path.join(path.resolve('/proj', 'venv'), 'bin', 'python'))
})


test('⛔ 守卫：盘上三张真名片 + 模板的 runtime.python 必须是**目录**', () => {
  const fs = require('node:fs')
  const ROOT = path.resolve(__dirname, '..', '..')
  // 从 listEngines() 动态获取已装引擎，不硬编码引擎 id：本机没装某台引擎时，
  // 硬编码会让这条守卫假失败。
  const manifests = [
    ...listEngines().map((e) => `engines/${e.id}/manifest.json`),
    'engines/_TEMPLATE/manifest.json',
  ]
  for (const rel of manifests) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
    const py = m.runtime && m.runtime.python
    assert.ok(py, `${rel} 没有 runtime.python`)
    // 变异靶：把某张名片改回 `.../Scripts/python.exe` ⇒ 这条必须红。而它在 Linux 上的
    // 症状是「引擎永远显示没装」，而用户什么都没做错。
    assert.ok(!/python\.exe$/i.test(py),
      `${rel} 的 runtime.python 又写死成可执行文件了：${py}\n` +
      `  ⛔ 那个形状只在 Windows 上成立（Linux/macOS 是 .venv/bin/python）。`)
  }
})
