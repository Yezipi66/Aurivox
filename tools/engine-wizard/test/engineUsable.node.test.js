'use strict'
// 「能用」打绿勾的判据（savebridge.js 的 withUsable）：
//   ① 平台认可：有有效 manifest.json（manifestPresent && idMatchesDir）；
//   ② 权重就绪：checkpointStatus(profile).ready === true。
//   环境不进门（GSV 这类底座引擎按名片查 .venv 会判 false 但实际能用）。
// 用注入的 fake 平台模块测，不碰真实 engines/ 的权重状态（单测不能依赖它）。

const { test } = require('node:test')
const assert = require('node:assert')

const { withUsable } = require('../core/savebridge.js')

// fake 平台模块：resolveEngineProfile 返回 {id}，checkpointStatus 按 ready 返回。
function fakeModules ({ ready = true, throws = false } = {}) {
  return {
    profile: {
      resolveEngineProfile: (id) => {
        if (throws) throw new Error('ENGINE_MANIFEST_INVALID')
        return { id }
      },
    },
    checkpoints: {
      checkpointStatus: (p) => ({ id: p.id, ready }),
    },
  }
}

test('没有名片的引擎 ⇒ 不可用（不碰平台判据）', () => {
  const out = withUsable([{ id: 'piper', manifestPresent: false, idMatchesDir: false }])
  assert.strictEqual(out[0].usable, false)
  assert.strictEqual(out[0].id, 'piper', '原字段要保留')
})

test('名片坏（resolveEngineProfile 抛）⇒ 不可用，不炸', () => {
  const out = withUsable(
    [{ id: 'broken', manifestPresent: true, idMatchesDir: true }],
    fakeModules({ throws: true }))
  assert.strictEqual(out[0].usable, false)
})

test('有有效名片且权重就绪 ⇒ 可用', () => {
  const out = withUsable(
    [{ id: 'gpt-sovits', manifestPresent: true, idMatchesDir: true }],
    fakeModules({ ready: true }))
  assert.strictEqual(out[0].usable, true)
})

test('有有效名片但权重没齐 ⇒ 不可用', () => {
  const out = withUsable(
    [{ id: 'gpt-sovits', manifestPresent: true, idMatchesDir: true }],
    fakeModules({ ready: false }))
  assert.strictEqual(out[0].usable, false)
})

test('id 与目录名不一致（idMatchesDir=false）⇒ 不可用', () => {
  const out = withUsable(
    [{ id: 'gpt-sovits', manifestPresent: true, idMatchesDir: false }],
    fakeModules({ ready: true }))
  assert.strictEqual(out[0].usable, false, '名片 id 与目录名不符，平台不认这台引擎')
})

test('空列表 ⇒ 空列表（不炸）', () => {
  assert.deepStrictEqual(withUsable([]), [])
})
