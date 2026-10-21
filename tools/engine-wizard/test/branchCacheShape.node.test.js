'use strict'
// 分支探测的缓存路径：命中时返回形状必须与未命中一致。
// 这条是独立验收抓出来的缺陷（缓存命中返回原始值、调用方按对象读，当场崩）。
const assert = require('node:assert')
const { test } = require('node:test')

const wb = require('../core/wizardbridge.js')
// 被测函数不在 exports 里时跳过（避免测试依赖内部结构）
const hasInternals = typeof wb.__test__ === 'object' && wb.__test__ !== null

test('缓存命中与未命中返回同一种形状', { skip: !hasInternals && '内部函数未导出' }, async () => {
  const { readDefaultBranch, _branchCache } = wb.__test__
  _branchCache.clear()
  _branchCache.set('owner/repo', { at: Date.now(), value: 'trunk', why: null })
  const r = await readDefaultBranch('owner', 'repo')
  assert.strictEqual(typeof r, 'object', '命中时必须是对象')
  assert.strictEqual(r.branch, 'trunk', '命中时 .branch 要能读到分支名')
  _branchCache.clear()
})

test('缓存里存的是失败结果时，命中也不能崩', { skip: !hasInternals && '内部函数未导出' }, async () => {
  const { readDefaultBranch, _branchCache } = wb.__test__
  _branchCache.clear()
  _branchCache.set('owner/repo', { at: Date.now(), value: null, why: 'RATE_LIMITED' })
  const r = await readDefaultBranch('owner', 'repo')
  assert.strictEqual(typeof r, 'object')
  assert.strictEqual(r.branch, null)
  assert.strictEqual(r.why, 'RATE_LIMITED', '失败原因要带出来')
  _branchCache.clear()
})
