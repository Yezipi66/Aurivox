'use strict'
// 「能用」打绿勾的判据（savebridge.js 的 withUsable）：
//   ① 平台认可：有有效 manifest.json（manifestPresent && idMatchesDir）；
//   ② 权重：checkpointStatus 是三态，折算只有一条路：「确知缺」（ready===false）
//      才摘勾。ready===null 有两种来由：名片没写 runtime.checkpoints（无从提证，
//      不给勾），或写了目录但没给 models.required 清单（目录在且非空，说不出齐
//      不齐但没有缺文件的证据，按规范「不填也能用」给勾）。
//   环境不进门（GSV 这类底座引擎按名片查 .venv 会判 false 但实际能用）。
// 用注入的 fake 平台模块测，不碰真实 engines/ 的权重状态（单测不能依赖它）。

const { test } = require('node:test')
const assert = require('node:assert')

const { withUsable } = require('../core/savebridge.js')

// fake 平台模块：resolveEngineProfile 返回 {id}；checkpointStatus 按入参出三态
//   与目录证据（declared / exists / is_dir / entries），与真模块的字段形状一致。
function fakeModules ({
  ready = true, throws = false,
  declared = true, exists = true, isDir = true, entries = 7,
} = {}) {
  return {
    profile: {
      resolveEngineProfile: (id) => {
        if (throws) throw new Error('ENGINE_MANIFEST_INVALID')
        return { id }
      },
    },
    checkpoints: {
      checkpointStatus: () => ({
        ready,
        declared,
        exists,
        is_dir: isDir,
        entries: exists && isDir ? entries : null,
      }),
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

test('有有效名片且权重验过齐全（ready=true）⇒ 可用', () => {
  const out = withUsable(
    [{ id: 'gpt-sovits', manifestPresent: true, idMatchesDir: true }],
    fakeModules({ ready: true }))
  assert.strictEqual(out[0].usable, true)
})

test('有有效名片但确知缺权重（ready=false）⇒ 不可用', () => {
  const out = withUsable(
    [{ id: 'gpt-sovits', manifestPresent: true, idMatchesDir: true }],
    fakeModules({ ready: false, exists: false, entries: null }))
  assert.strictEqual(out[0].usable, false)
})

// ---- 三态的中间态：ready===null（平台说不出齐不齐）----
// 这一支是回归守卫：旧实现只认 ready===true，把 null 一律折成「不能用」，
//   一台底模下好了但名片没写文件清单的引擎会永远挂不上勾。
test('底模目录在且非空、名片没给 required 清单（ready=null）⇒ 可用', () => {
  const out = withUsable(
    [{ id: 'gpt-sovits', manifestPresent: true, idMatchesDir: true }],
    fakeModules({ ready: null, declared: true, exists: true, entries: 7 }))
  assert.strictEqual(out[0].usable, true,
    '平台无从证伪，按规范「不填也能用」给勾：不能因验不了就说它坏')
})

test('名片连 runtime.checkpoints 都没写（ready=null 且无目录证据）⇒ 不可用', () => {
  const out = withUsable(
    [{ id: 'gpt-sovits', manifestPresent: true, idMatchesDir: true }],
    fakeModules({ ready: null, declared: false, exists: false, entries: null }))
  assert.strictEqual(out[0].usable, false, '没有任何底模存在的证据，不该给勾')
})

test('底模目录在但是空目录（ready=null）⇒ 不可用', () => {
  const out = withUsable(
    [{ id: 'gpt-sovits', manifestPresent: true, idMatchesDir: true }],
    fakeModules({ ready: null, declared: true, exists: true, entries: 0 }))
  assert.strictEqual(out[0].usable, false, '空目录不构成「下过底模」的证据')
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
