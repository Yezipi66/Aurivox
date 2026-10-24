'use strict'

// 第 2 步的版本选择：把组件真正渲染成 HTML 再断言。
//
// 判据的理由：下拉框里列哪些版本、选中后回调什么值，
//   都要看渲染出来的东西。选中的值要能区分「上游声明的版本」
//   与「使用者另选的版本」：回到上游声明时回调空串。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const PANEL = path.join(EDITOR_DIR, 'StepDeps.jsx')
const WEB_DIR = path.join(__dirname, '..', '..', '..', 'web')

function loadPanel () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  if (!esbuild) return null
  const src = fs.readFileSync(PANEL, 'utf8')
  const code = esbuild.transformSync(src, {
    loader: 'jsx', format: 'cjs', target: 'node18', jsx: 'automatic',
  }).code
  const mod = { exports: {} }
  const stub = (id) => {
    if (id === 'react') return require(path.join(WEB_DIR, 'node_modules', 'react'))
    if (id === 'react/jsx-runtime') {
      return require(path.join(WEB_DIR, 'node_modules', 'react', 'jsx-runtime.js'))
    }
    if (id === 'react-dom/server') return require(path.join(WEB_DIR, 'node_modules', 'react-dom', 'server.js'))
    if (/i18n/.test(id)) return { useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) }
    if (/\.\/(Pipeline|UndoClone|useInstallSession)/.test(id)) return { default: () => null }
    throw new Error('VersionSelect 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  run(mod.exports, stub, mod, PANEL, EDITOR_DIR)
  return mod.exports
}

function render (props) {
  const mod = loadPanel()
  if (!mod) return null
  const React = require(path.join(WEB_DIR, 'node_modules', 'react'))
  const server = require(path.join(WEB_DIR, 'node_modules', 'react-dom', 'server.js'))
  return server.renderToStaticMarkup(
    React.createElement(mod.VersionSelect, Object.assign({
      t: (en, zh) => zh || en,
      suggestions: [],
      onChange: () => {},
    }, props || {}))
  )
}

test('守卫：这份测试真的渲染出了版本选择', () => {
  const html = render({ name: 'einops', spec: 'einops==0.8.1' })
  assert.ok(html, '没渲染出 HTML。缺 esbuild 依赖时这一条会红，'
    + '那是环境问题，不要连同下面那些一起跳过。')
})

test('默认选项是上游声明的版本', () => {
  const html = render({ name: 'einops', spec: 'einops==0.8.1' })
  assert.ok(html.includes('版本 0.8.1'), '要列出上游声明的版本')
  assert.ok(html.includes('上游声明'), '要说明这个版本是上游声明的')
})

test('给了建议版本时，它也在选项里', () => {
  const html = render({
    name: 'torch', spec: 'torch==2.5.1', suggestions: ['2.6.0'],
  })
  assert.ok(html.includes('版本 2.6.0'), '建议版本要列出来')
})

test('上游没钉版本时，说明写清楚', () => {
  const html = render({ name: 'einops', spec: 'einops' })
  assert.ok(html.includes('上游未声明版本'), '上游没钉版本时要说明')
})

test('始终有手写版本号的入口', () => {
  const html = render({ name: 'einops', spec: 'einops==0.8.1' })
  assert.ok(html.includes('手写版本号'), '要能手写版本号')
})

test('当前选的是另写的版本时，那个版本要在选项里（不是被丢掉）', () => {
  const html = render({
    name: 'einops', spec: 'einops==0.8.1', value: '0.7.0',
  })
  assert.ok(html.includes('0.7.0'), '手写的版本不能从下拉框里消失')
})

test('当前选的是建议版本时，那个版本要在选项里', () => {
  const html = render({
    name: 'torch', spec: 'torch==2.5.1', suggestions: ['2.6.0'], value: '2.6.0',
  })
  assert.ok(html.includes('2.6.0'), '建议版本不能从下拉框里消失')
})

test('declaredVersion：精确钉住、区间、没钉三种都要读对', () => {
  const mod = loadPanel()
  assert.strictEqual(mod.declaredVersion('einops==0.8.1'), '0.8.1')
  assert.strictEqual(mod.declaredVersion('einops>=0.8.1'), '0.8.1')
  assert.strictEqual(mod.declaredVersion('torch==2.5.1'), '2.5.1')
  assert.strictEqual(mod.declaredVersion('einops'), '')
  assert.strictEqual(mod.declaredVersion(''), '')
})
