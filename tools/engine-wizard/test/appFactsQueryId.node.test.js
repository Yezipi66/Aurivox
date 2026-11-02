'use strict'

// 克隆刚完成时，问完成状态要用「刚克隆用的那个 id」。
//
// 背景：wz.id 的 setState 是异步的，克隆刚完成那一刻读闭包里的 wz.id
// 拿到的是上一个渲染的旧值（刚进向导时是空）⇒ 请求带空 id ⇒ 流程条一个勾都不亮。
// 所以 onDone 把刚克隆的 id 传出来，reloadFacts 优先用它。
//
// 被测代码是 tools/engine-wizard/editor/factsQueryId.js 里的那份实现。
//
// 它原先放在 App.jsx 里并从那儿导出。App.jsx 是组件模块，
// 而 vite 的 react 插件要求组件模块只导出组件：
// 导出别的函数 ⇒ Fast Refresh 失效，改 App.jsx 会整页 reload。
// 所以纯函数搬到了自己的文件，这个测试也跟着改指新位置。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const SOURCE = path.join(EDITOR_DIR, 'factsQueryId.js')

function loadFactsQueryId () {
  const { esbuild } = require('../../../lib/testDeps.js')
  const src = fs.readFileSync(SOURCE, 'utf8')
  const code = esbuild().transformSync(src, {
    loader: 'js',
    format: 'cjs',
    target: 'node18',
  }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  run(mod.exports, require, mod, SOURCE, EDITOR_DIR)
  return mod.exports.factsQueryId
}

const factsQueryId = loadFactsQueryId()

test('守卫：这份测试真的拿到了活代码里的那个纯函数', () => {
  assert.equal(typeof factsQueryId, 'function',
    '没拿到 factsQueryId。缺 esbuild 依赖时这一条会红，'
    + '那是环境问题，不要连同下面那些一起跳过。')
})

test('克隆刚完成：传进来的 id 优先于 state 里的旧值', () => {
  // 此刻 state 里的 wz.id 还是空（setState 还没生效）
  assert.strictEqual(factsQueryId('spark-tts', ''), 'spark-tts',
    '必须用刚克隆的 id，否则请求带空 id，流程条一个勾都不亮')
})

test('没传 id 时退回 state 里的 id', () => {
  assert.strictEqual(factsQueryId(undefined, 'gpt-sovits'), 'gpt-sovits')
  assert.strictEqual(factsQueryId(null, 'gpt-sovits'), 'gpt-sovits')
  assert.strictEqual(factsQueryId('', 'gpt-sovits'), 'gpt-sovits')
})

test('两个都没有 ⇒ null（不请求、不猜）', () => {
  assert.strictEqual(factsQueryId(undefined, ''), null)
  assert.strictEqual(factsQueryId(null, null), null)
  assert.strictEqual(factsQueryId('', ''), null)
})

test('传进来的 id 与 state 里的 id 不同时，用传进来的那个', () => {
  assert.strictEqual(factsQueryId('new-id', 'old-id'), 'new-id',
    '使用者改过目录名时，要用刚克隆用的那个')
})
