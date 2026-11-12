'use strict'
// 第 1 步的两个判定：完成状态必须与界面上的目录名同源，撤销只对本次克隆出来的那台出现。
//   这两条都是「界面看上去没问题、实际会删错东西」的那类缺陷，用纯函数钉住。

const { test } = require('node:test')
const assert = require('node:assert')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'editor', 'prepareState.js')

function load () {
  const code = esbuild().transformSync(fs.readFileSync(SRC, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, () => {
    throw new Error('prepareState.js 不该有依赖')
  }, mod)
  return mod.exports
}

const { cloneDone, canUndoClone } = load()

test('完成状态只认当前目录名：facts 是另一台引擎时不算完成', () => {
  const facts = { prepare: true }
  assert.equal(cloneDone({ facts, factsId: 'piper', curId: 'piper' }), true)
  assert.equal(cloneDone({ facts, factsId: 'piper', curId: 'dia' }), false,
    '按 piper 问来的完成状态不能显示在 dia 上')
  assert.equal(cloneDone({ facts, factsId: null, curId: 'dia' }), false)
  assert.equal(cloneDone({ facts, factsId: 'dia', curId: '' }), false, '目录名为空时不判定')
  assert.equal(cloneDone({ facts: { prepare: false }, factsId: 'dia', curId: 'dia' }), false)
  assert.equal(cloneDone({}), false, '没有 facts 时不算完成')
})

test('撤销克隆只对本次克隆出来的那台出现', () => {
  const fresh = { ok: true, id: 'dia' }
  assert.equal(canUndoClone(fresh, 'dia'), true)
  assert.equal(canUndoClone(fresh, 'piper'), false, '换了一个目录名就不该删')
  assert.equal(canUndoClone(null, 'dia'), false, '没克隆过就不该出现')
  assert.equal(canUndoClone({ ok: false, id: 'dia' }, 'dia'), false)
  assert.equal(canUndoClone({ ok: true }, 'dia'), false, '没有 id 的记录不能当依据')
})

test('复用已有目录不是克隆：不出现撤销按钮，免得删掉一台已接入的引擎', () => {
  assert.equal(canUndoClone({ ok: true, id: 'piper', reused: true }, 'piper'), false)
})

test('第 1 步确实接了这两个判定，不是另写一份条件', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'editor', 'StepPrepare.jsx'), 'utf8')
  assert.match(src, /const done = cloneDone\(\{ facts, factsId, curId \}\)/,
    '完成状态必须用 cloneDone：只比 facts.prepare 会把旧引擎的状态显示在新仓库上')
  assert.match(src, /canUndoClone\(cloneRes, curId\)/,
    '撤销按钮必须用 canUndoClone：复用或别的目录名都不该出现')
})
