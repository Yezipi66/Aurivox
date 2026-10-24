'use strict'

// 克隆刚完成时，问完成状态要用「刚克隆用的那个 id」。
//
// 背景：wz.id 的 setState 是异步的，克隆刚完成那一刻读闭包里的 wz.id
// 拿到的是上一个渲染的旧值（刚进向导时是空）⇒ 请求带空 id ⇒ 流程条一个勾都不亮。
// 所以 onDone 把刚克隆的 id 传出来，reloadFacts 优先用它。
//
// 被测代码是 tools/engine-wizard/editor/App.jsx 里的那份实现，
// 用项目 Vite 依赖的同一个 esbuild 编译成 CJS 后取其导出。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const PANEL = path.join(EDITOR_DIR, 'App.jsx')

function loadFactsQueryId () {
  const { esbuild, resolveFromRoot } = require('../../../lib/testDeps.js')
  const src = fs.readFileSync(PANEL, 'utf8')
  const code = esbuild().transformSync(src, {
    loader: 'jsx',
    format: 'cjs',
    target: 'node18',
  }).code
  const mod = { exports: {} }
  const reactPath = resolveFromRoot('react')
  const jsxRuntimePath = resolveFromRoot('react/jsx-runtime')
  if (!reactPath || !jsxRuntimePath) {
    throw new Error('拿不到 react / react/jsx-runtime：根与 web/ 的 node_modules 里都没有它')
  }
  const stub = (id) => {
    if (id === 'react') return require(reactPath)
    if (id === 'react/jsx-runtime') return require(jsxRuntimePath)
    if (/i18n/.test(id)) return { useT: () => ({ t: (en) => en, lang: 'en' }), LangToggle: () => null }
    // 子组件本测试不需要渲染。
    if (/\.\//.test(id)) return { default: () => null, STEPS: [], stepDone: () => false }
    throw new Error('factsQueryId 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  run(mod.exports, stub, mod, PANEL, EDITOR_DIR)
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
