'use strict'
// clone/remove（清除目标目录 / 撤销克隆）：核心判据是只删 engines/<id>/ 那一棵
//
// 为什么这条要紧：删目录是不可逆的写盘操作，而 id 会拼进路径。
//   id 里带斜杠就能越出 engines/，删掉别的东西。
//   ⇒ 判据是：只接受字母数字、下划线、连字符；其余一律拒绝。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { removeTargetDir } = require('../core/clone.js')

/** 夹具造在 os.tmpdir() 里，绝不碰真的 engines/。
 *  名字里带 mkdtemp 是给 lib/engines/enginesDirWriteGuard.node.test.js 看的：
 *  那个守卫区分真假只认实参里有没有临时目录的痕迹。 */
function makeRootWithEngines (mkdtempDir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-clone-remove-'))
  const engines = path.join(root, 'engines')
  fs.mkdirSync(engines, { recursive: true })
  return { root, engines }
}

test('removeTargetDir 删掉目标目录，且不碰同级的其他引擎', () => {
  const { root, engines } = makeRootWithEngines()
  const target = path.join(engines, 'myengine')
  const other = path.join(engines, 'otherengine')
  fs.mkdirSync(target, { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(target, 'a.txt'), 'x')
  fs.writeFileSync(path.join(other, 'b.txt'), 'y')

  const r = removeTargetDir('myengine', { root })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.removed, true)
  assert.strictEqual(fs.existsSync(target), false, '目标目录应该被删掉')
  assert.strictEqual(fs.existsSync(other), true, '同级的其他引擎不该被删')
  assert.strictEqual(fs.existsSync(path.join(other, 'b.txt')), true)
})

test('removeTargetDir 目标不存在时如实说没删（不是失败）', () => {
  const { root } = makeRootWithEngines()
  const r = removeTargetDir('nothinghere', { root })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.removed, false)
  assert.strictEqual(r.entries, 0)
})

test('removeTargetDir 拒绝带路径分隔符的 id（否则能越出 engines/）', () => {
  const { root } = makeRootWithEngines()
  for (const bad of ['../evil', 'a/b', 'a\\b', '.', '..']) {
    const r = removeTargetDir(bad, { root })
    assert.strictEqual(r.ok, false, `id "${bad}" 应该被拒绝`)
    assert.strictEqual(r.code, 'BAD_ID')
  }
})

test('removeTargetDir 拒绝空 id', () => {
  const { root } = makeRootWithEngines()
  const r = removeTargetDir('', { root })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'MISSING_ID')
})

test('removeTargetDir 接受字母数字、下划线、连字符', () => {
  const { root, engines } = makeRootWithEngines()
  const target = path.join(engines, 'my-engine_2')
  fs.mkdirSync(target, { recursive: true })
  const r = removeTargetDir('my-engine_2', { root })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.removed, true)
  assert.strictEqual(fs.existsSync(target), false)
})
