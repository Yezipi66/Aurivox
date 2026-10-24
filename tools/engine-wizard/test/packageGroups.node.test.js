'use strict'

// 第 2 步依赖清单的两个分区：把组件真正渲染成 HTML 再断言。
//
// 判据的理由：过去这两个分区只在「一半被排除」时才显示标题，
//   全部安装时两个标题整个消失 ⇒ 使用者看到的分组会随点击而变，
//   看不出这两个分区本来就在。
//
// 用 web/ 里现成的 react + react-dom/server（React 18），
// 被测组件是 tools/engine-wizard/editor/StepDeps.jsx 里的那份实现。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const PANEL = path.join(EDITOR_DIR, 'StepDeps.jsx')
const WEB_DIR = path.join(__dirname, '..', '..', '..', 'web')

const PKGS = ['einops==0.8.1', 'transformers==4.44.0', 'soundfile==0.12.1']

/**
 * 把 StepDeps.jsx 编译成 CJS 并取其导出的 PackageGroups。
 * react / react-dom/server / i18n 走 web/node_modules 的真货，
 * 只有跟本测试无关的旁支模块给替身。
 */
function loadGroups () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  if (!esbuild) return null
  const src = fs.readFileSync(PANEL, 'utf8')
  const code = esbuild.transformSync(src, {
    loader: 'jsx',
    format: 'cjs',
    target: 'node18',
    jsx: 'automatic',
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
    throw new Error('PackageGroups 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  run(mod.exports, stub, mod, PANEL, EDITOR_DIR)
  return mod.exports
}

/**
 * 渲染依赖分组，返回 HTML 字符串。
 * @param {string[]} skipped 被设为不安装的包
 */
function renderGroups (skipped) {
  const mod = loadGroups()
  if (!mod) return null
  const Groups = mod.PackageGroups
  if (!Groups) return null
  const React = require(path.join(WEB_DIR, 'node_modules', 'react'))
  const server = require(path.join(WEB_DIR, 'node_modules', 'react-dom', 'server.js'))
  const off = new Set(skipped || [])
  return server.renderToStaticMarkup(
    React.createElement(Groups, {
      packages: PKGS,
      isSkipped: (p) => off.has(p),
      onToggle: () => {},
      t: (en, zh) => zh || en,
    })
  )
}

test('守卫：这份测试真的渲染出了依赖分组', () => {
  const html = renderGroups([])
  assert.ok(html, '没渲染出 HTML。缺 esbuild 依赖时这一条会红，'
    + '那是环境问题，不要连同下面那些一起跳过。')
})

test('两个分区一直都在：全部安装时也显示「要安装的包」与「设为不安装的包」', () => {
  const html = renderGroups([])
  assert.ok(html.includes('要安装的包'), '全部安装时也要显示「要安装的包」这个分区')
  assert.ok(html.includes('设为不安装的包'), '全部安装时也要显示「设为不安装的包」这个分区')
})

test('全部安装时，「设为不安装的包」那里写明没有不安装的包', () => {
  const html = renderGroups([])
  assert.ok(html.includes('没有设为不安装的包'),
    '全部安装时要写明没有设为不安装的包，不能留空')
})

test('全部安装时，每个包都出现在「要安装的包」里', () => {
  const html = renderGroups([])
  for (const p of PKGS) {
    assert.ok(html.includes(p), `${p} 要出现在「要安装的包」里`)
  }
})

test('排除一个包时，它出现在「设为不安装的包」里，且两个分区都还在', () => {
  const html = renderGroups(['einops==0.8.1'])
  assert.ok(html.includes('要安装的包'), '排除后「要安装的包」这个分区还要在')
  assert.ok(html.includes('设为不安装的包'), '排除后「设为不安装的包」这个分区还要在')
  assert.ok(html.includes('没有设为不安装的包') === false,
    '有被排除的包时，不能再写「没有设为不安装的包」')
  assert.ok(html.includes('einops==0.8.1'), '被排除的包要出现在「设为不安装的包」里')
})

test('全部排除时，「要安装的包」那里写明没有要安装的包', () => {
  const html = renderGroups(PKGS)
  assert.ok(html.includes('没有要安装的包'),
    '全部排除时要写明没有要安装的包，不能留空')
  assert.ok(html.includes('设为不安装的包'), '全部排除时「设为不安装的包」这个分区还要在')
})
