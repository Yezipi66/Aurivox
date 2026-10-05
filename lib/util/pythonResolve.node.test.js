#!/usr/bin/env node
'use strict'

// ============================================================================
//  pythonResolve 的真行为测试
//
//  ⭐ 本文件的价值全在**判别力**：能不能把「文件在但起不来」和
//  「真的能用」分开。改判据的那一刀（A15）就靠它证明。
//
//  ⚠️ 判据的形状（照项目纪律「守卫必须能被证伪」）：
//  每条断言都对着**一个具体的坏形状**，不是对着 happy path。
//  把 canSpawnPython 改回 `fs.existsSync` ⇒ 下面第 2/3/4 条必须变红。
// ============================================================================

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const { canSpawnPython, firstWorkingPython, askPathForAbsolute } = require('./pythonResolve')

// ⭐ 本仓库自带的可重定位解释器（deploy.bat 就用它建 venv）。
//   它绝对路径可用 ⇒ 是唯一能当「正样本」的东西。
const EMBEDDED = path.join(ROOT, 'tools', 'runtime', 'python', 'python.exe')
const EMBEDDED_POSIX = path.join(ROOT, 'tools', 'runtime', 'python', 'bin', 'python3')

function tmpdir (name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aurivox-pyres-${name}-`))
}

// ---------------------------------------------------------------------------
// 1 · 正样本：仓库内嵌解释器按绝对路径能跑
// ---------------------------------------------------------------------------
test('✅ 仓库内嵌解释器按绝对路径判为可用', () => {
  assert.ok(fs.existsSync(EMBEDDED), `夹具缺失：${EMBEDDED}`)
  assert.strictEqual(canSpawnPython(EMBEDDED), true)
})

// ---------------------------------------------------------------------------
// 2 ⭐ 核心判别力：**文件在，但起不来** ⇒ 必须判否
//
//   这就是本机四个 venv 的形状（pyvenv.cfg 的 home 指向另一台机器）。
//   只看 fs.existsSync 的判据在这里会返回 true。
// ---------------------------------------------------------------------------
test('⭐ 文件存在但起不来 ⇒ 判否（venv 被搬过机器的那种形状）', () => {
  // ⚠️⚠️ 2026-10-04（A19）：这条断言原先**直接拿盘上的 venv/Scripts/python.exe
  //   当反例** —— 而 A19 把那个 venv 换成了能跑的瘦版 ⇒ **反例消失，测试失效**（实测变红）。
  //
  // ⭐ 教训与本文件其余判别力测试一致：**夹具不能依赖「真实环境恰好是坏的」**。
  //   环境会被修好，而依赖「它坏着」的守卫会在被修好的那一刻悄悄失去意义。
  //   ⇒ 现在自己造同形状的反例（文件在、但不是可执行体）。
  const d = tmpdir('dead')
  const fake = path.join(d, 'python.exe')
  fs.writeFileSync(fake, 'this file exists but is not a program')
  assert.strictEqual(fs.existsSync(fake), true, '夹具前提：文件确实在')
  assert.strictEqual(
    canSpawnPython(fake), false,
    '⛔ 只看文件存在的话这里会是 true —— 判据退化了')

  // ⭐ 而真正那个 venv 现在的**正确**读数是「能用」（A19 之后它就是好的）。
  //   把它显式断言出来，是为了让「它坏过」这件事留在记录里 ——
  //   否则下一个人会以为它一直是对的，而不知道它曾经指向另一台机器。
  const rootVenv = path.join(ROOT, 'venv', 'Scripts', 'python.exe')
  if (fs.existsSync(rootVenv)) {
    assert.strictEqual(canSpawnPython(rootVenv), true,
      '平台根 venv（A19 重建过，home 指向仓库内嵌解释器）应当是可用的')
  }
})

// ---------------------------------------------------------------------------
// 3 · 文件在但不是可执行体 ⇒ 判否
// ---------------------------------------------------------------------------
test('⛔ 文件在但不是可执行体 ⇒ 判否', () => {
  const d = tmpdir('txt')
  const notExe = path.join(d, 'python.exe')
  fs.writeFileSync(notExe, 'this is not a program')
  assert.strictEqual(fs.existsSync(notExe), true)
  assert.strictEqual(canSpawnPython(notExe), false)
})

// ---------------------------------------------------------------------------
// 4 · 目录 ⇒ 判否（existsSync 对目录也返回 true）
// ---------------------------------------------------------------------------
test('⛔ 目录 ⇒ 判否（existsSync 对目录也返回 true）', () => {
  const d = tmpdir('dir')
  const asDir = path.join(d, 'python.exe')
  fs.mkdirSync(asDir)
  assert.strictEqual(fs.existsSync(asDir), true)
  assert.strictEqual(canSpawnPython(asDir), false)
})

// ---------------------------------------------------------------------------
// 5 ⭐ 裸名字 / 相对路径一律判否 —— 这条是本文件存在的另一半理由
// ---------------------------------------------------------------------------
test('⛔ 裸名字与相对路径一律判否（它们过不了路径运算）', () => {
  assert.strictEqual(canSpawnPython('python'), false)
  assert.strictEqual(canSpawnPython('python3'), false)
  assert.strictEqual(canSpawnPython('venv/Scripts/python.exe'), false)
  assert.strictEqual(canSpawnPython('.'), false)
  assert.strictEqual(canSpawnPython(''), false)
  assert.strictEqual(canSpawnPython(null), false)
})

// ---------------------------------------------------------------------------
// 6 · 不存在 / 不可读的路径 ⇒ 判否，且不许抛
// ---------------------------------------------------------------------------
test('不存在的路径 ⇒ 判否，不抛', () => {
  const d = tmpdir('missing')
  assert.strictEqual(canSpawnPython(path.join(d, 'nope', 'python.exe')), false)
})

// ---------------------------------------------------------------------------
// 7 ⭐ firstWorkingPython：**跳过坏的，挑下一个好的**
//
//   候选顺序 = [一个坏的内嵌夹具, 真的内嵌解释器]
//   判据退化成 existsSync 的话，它会返回那个坏的第一条。
// ---------------------------------------------------------------------------
test('⭐ firstWorkingPython 跳过起不来的，挑第一个真能用的', () => {
  const d = tmpdir('first')
  const broken = path.join(d, 'python.exe')
  fs.writeFileSync(broken, 'broken')
  assert.strictEqual(
    firstWorkingPython([broken, EMBEDDED]),
    EMBEDDED,
    '⛔ 返回了那个起不来的 ⇒ 判据只看文件存在')
})

// ---------------------------------------------------------------------------
// 8 · 全都不可用 ⇒ null（⛔ 绝不退回裸名字）
// ---------------------------------------------------------------------------
test('全部候选都不可用 ⇒ null（⛔ 绝不返回裸名字）', () => {
  const d = tmpdir('none')
  const broken = path.join(d, 'python.exe')
  fs.writeFileSync(broken, 'broken')
  const got = firstWorkingPython([broken], { pathNames: ['__no_such_python_xyz__'] })
  assert.strictEqual(got, null)
})

// ---------------------------------------------------------------------------
// 9 ⭐ askPathForAbsolute：借 PATH 问绝对路径，且只接受绝对路径
// ---------------------------------------------------------------------------
test('askPathForAbsolute 对不存在的名字返回 null', () => {
  assert.strictEqual(askPathForAbsolute('__no_such_python_xyz__'), null)
})

test('⭐ askPathForAbsolute 只吐绝对路径（裸名字参与不了路径运算）', () => {
  const abs = askPathForAbsolute('python')
  if (abs === null) return   // 这台机器 PATH 上没有 python，跳过（不是失败）
  assert.ok(path.isAbsolute(abs), `吐出来的不是绝对路径：${abs}`)
})

// ---------------------------------------------------------------------------
// 10 ⭐ 端到端：拿本文件选出来的解释器，真跑一次平台自己的 .py
//
//     这是「它真的能用」而不是「它自称能用」的判据。
// ---------------------------------------------------------------------------
test('⭐⭐ 选出来的解释器能真跑平台自己的 .py', () => {
  const py = firstWorkingPython([EMBEDDED, EMBEDDED_POSIX])
  assert.ok(py, '一个都没选出来 —— 这台机器上应该至少有仓库内嵌的那个')
  for (const script of [
    'lib/inference/config_repair.py',
    'lib/inference/alias_fold.py',
    'lib/engines/env_probe.py',
  ]) {
    const abs = path.join(ROOT, script)
    assert.ok(fs.existsSync(abs), `夹具缺失：${abs}`)
    const { spawnSync } = require('node:child_process')
    const r = spawnSync(py, [abs, '--help'], { encoding: 'utf8', timeout: 60000 })
    assert.strictEqual(r.status, 0,
      `${script} 用 ${py} 跑不出 0（status=${r.status}）：${(r.stderr || '').slice(0, 300)}`)
  }
})
