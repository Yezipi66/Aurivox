'use strict'
// 断点续传的进度记录必须属于同一台引擎：
// 记录里的 engine 与本次要装的不一致时整段作废，不继承别人的完成记录。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { readProgress, writeProgress } = require('../core/installState.js')

function tmpRoot () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inststate-'))
}

test('同引擎：写进去的 key 读得回来', () => {
  const root = tmpRoot()
  writeProgress(root, 'engA', 'env', ['uv venv', 'uv sync'])
  const got = readProgress(root, 'engA', 'env')
  assert.strictEqual(got.size, 2)
  assert.ok(got.has('uv venv'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('别的引擎的记录不被继承：整段作废', () => {
  const root = tmpRoot()
  writeProgress(root, 'engA', 'env', ['uv venv', 'uv sync'])
  // 把 A 的记录挪到 B 的目录下（模拟目录改名 / 复制 / id 变更）
  const src = path.join(root, 'engines', 'engA', '.wizard-install.json')
  const dst = path.join(root, 'engines', 'engB', '.wizard-install.json')
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)

  const got = readProgress(root, 'engB', 'env')
  assert.strictEqual(got.size, 0, '记录属于 engA，读 engB 时必须作废，不许跳过步骤')
  fs.rmSync(root, { recursive: true, force: true })
})

test('两段互不干扰：env 的记录不影响 models', () => {
  const root = tmpRoot()
  writeProgress(root, 'engA', 'env', ['step1'])
  writeProgress(root, 'engA', 'models', ['dl1', 'dl2'])
  assert.strictEqual(readProgress(root, 'engA', 'env').size, 1)
  assert.strictEqual(readProgress(root, 'engA', 'models').size, 2)
  fs.rmSync(root, { recursive: true, force: true })
})

test('文件不存在 / 损坏 ⇒ 空集，不抛', () => {
  const root = tmpRoot()
  assert.strictEqual(readProgress(root, 'nope', 'env').size, 0)
  const f = path.join(root, 'engines', 'bad', '.wizard-install.json')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, '{ 这不是 JSON')
  assert.strictEqual(readProgress(root, 'bad', 'env').size, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('记录里没有 engine 字段时按可用处理（老文件兼容）', () => {
  const root = tmpRoot()
  const f = path.join(root, 'engines', 'engX', '.wizard-install.json')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ env: { done: [{ key: 'k1' }] }, models: { done: [] } }))
  assert.strictEqual(readProgress(root, 'engX', 'env').size, 1,
    '老文件没有 engine 字段，不能因此把记录当别人的丢掉')
  fs.rmSync(root, { recursive: true, force: true })
})
