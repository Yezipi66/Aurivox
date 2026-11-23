'use strict'
// 权重目录的一致性：第 3 步改的「存放位置」、第 4 步名片的 runtime.checkpoints、
//   下载命令的 local_dir，必须是同一个答案，且与进入步骤的顺序无关。
//
// 守的是「状态 → 行为」，不是实现：
//   ① 无声明、无快照 → 默认权重目录
//   ② 有快照（第 3 步改过）→ 快照值
//   ③ 名片已声明 → 名片值（盖过快照：第 4 步是权重的权威声明）
//   ④ 坏快照 / 非法快照 → 拒绝并回退，不崩、绝不把权重写到引擎目录之外
//
// 为什么守这些：这一处算错，症状是「第 3 步说下好了、第 5 步说目录不存在」，
//   或者权重被写到 engines/<id>/ 之外（资产事故）。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { weightsDirFor } = require('../core/checkpointsPath.js')

function mkdtempRoot () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-wdir-'))
  fs.mkdirSync(path.join(dir, 'engines'), { recursive: true })
  return dir
}

function writeSnapshot (root, id, value) {
  const dir = path.join(root, 'engines', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'wizard.json'), JSON.stringify({ downloadDir: value }))
}

// ① 无声明、无快照 → 默认
test('没有名片也没有快照时，权重目录是默认 checkpoints', () => {
  const root = mkdtempRoot()
  assert.equal(weightsDirFor(root, 'demo', null), 'engines/demo/checkpoints')
})

// ② 有快照 → 快照值（第 3 步改过存放位置）
test('第 3 步改过存放位置后，权重目录跟随快照', () => {
  const root = mkdtempRoot()
  writeSnapshot(root, 'demo', 'weights/s2')
  assert.equal(weightsDirFor(root, 'demo', null), 'engines/demo/weights/s2')
})

// ③ 名片声明盖过快照
test('名片声明了 runtime.checkpoints 时，以名片为准', () => {
  const root = mkdtempRoot()
  writeSnapshot(root, 'demo', 'weights/s2')
  const manifest = { id: 'demo', runtime: { checkpoints: 'cp/from-card' } }
  assert.equal(weightsDirFor(root, 'demo', manifest), 'cp/from-card')
})

// ④a 坏快照：不崩，回退默认
test('快照文件是坏 JSON 时回退默认，不抛错', () => {
  const root = mkdtempRoot()
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'wizard.json'), '{ not json')
  assert.equal(weightsDirFor(root, 'demo', null), 'engines/demo/checkpoints')
})

// ④b 非法快照：绝对路径 / 向外 / 当前目录 → 拒绝，回退默认
test('快照的 downloadDir 向外或绝对时拒绝，回退默认（不写到引擎目录外）', () => {
  const root = mkdtempRoot()
  for (const bad of ['../escape', '/abs/path', '.', '..']) {
    writeSnapshot(root, 'demo', bad)
    assert.equal(weightsDirFor(root, 'demo', null), 'engines/demo/checkpoints', `应拒绝 ${bad}`)
  }
})

// ④c 空值快照 → 视为没有，回退默认
test('快照 downloadDir 为空时视为未设置', () => {
  const root = mkdtempRoot()
  writeSnapshot(root, 'demo', '')
  assert.equal(weightsDirFor(root, 'demo', null), 'engines/demo/checkpoints')
})

// ⑤ 两种记法：手动改记全局（项目根相对），自动写盘记相对（引擎内），读取都要还原
test('手动记全局、自动记相对，读取结果一致', () => {
  const root = mkdtempRoot()
  writeSnapshot(root, 'demo', 'engines/demo/weights/s2')
  assert.equal(weightsDirFor(root, 'demo', null), 'engines/demo/weights/s2')
  writeSnapshot(root, 'demo', 'weights/s2')
  assert.equal(weightsDirFor(root, 'demo', null), 'engines/demo/weights/s2')
})
