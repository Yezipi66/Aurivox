'use strict'

// 加载 tools/engine-wizard/editor/StepDeps.jsx 里的组件，用于渲染成 HTML 再断言。
//
// 为什么要有这个共享模块：StepDeps.jsx 被好几个测试文件加载，
//   每个文件各写一份加载逻辑 ⇒ 组件多一个依赖（如图标）就要改三处，
//   漏一处那一处的测试就红，报错还指向「依赖不该被求值」这种看不懂的地方。
//
// 加载方式：esbuild 把 JSX 转成 CJS，再用 new Function 求值，
//   依赖走替身：react / react-dom/server / i18n 用 web/node_modules 里的真货，
//   图标组件（web/src/components/common/Icons.jsx）也用真货（它是 JSX，要单独转译），
//   只有与被测组件无关的旁支模块给替身。

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.join(__dirname, '..', '..', '..')
const EDITOR_DIR = path.join(REPO, 'tools', 'engine-wizard', 'editor')
const PANEL = path.join(EDITOR_DIR, 'StepDeps.jsx')
const WEB_DIR = path.join(REPO, 'web')

// web/node_modules 里的真货
function webRequire (dep) {
  if (dep === 'react') return require(path.join(WEB_DIR, 'node_modules', 'react'))
  if (dep === 'react/jsx-runtime') {
    return require(path.join(WEB_DIR, 'node_modules', 'react', 'jsx-runtime.js'))
  }
  if (dep === 'react-dom/server') {
    return require(path.join(WEB_DIR, 'node_modules', 'react-dom', 'server.js'))
  }
  return require(dep)
}

// 图标组件是 JSX，require 加载不了 ⇒ 单独转译成 CJS 再求值。
function loadIcons (esbuild) {
  const iconPath = path.join(WEB_DIR, 'src', 'components', 'common', 'Icons.jsx')
  const iconSrc = fs.readFileSync(iconPath, 'utf8')
  const iconCode = esbuild.transformSync(iconSrc, {
    loader: 'jsx', format: 'cjs', target: 'node18', jsx: 'automatic',
  }).code
  const iconMod = { exports: {} }
  const iconRun = new Function('exports', 'require', 'module', iconCode)
  iconRun(iconMod.exports, webRequire, iconMod)
  return iconMod.exports
}

/**
 * 加载 StepDeps.jsx 的导出。
 * @returns {object|null} 组件的导出；缺 esbuild 依赖时返回 null
 */
function loadStepDeps () {
  const esbuild = require(path.join(REPO, 'lib', 'testDeps.js')).esbuild()
  if (!esbuild) return null
  const src = fs.readFileSync(PANEL, 'utf8')
  const code = esbuild.transformSync(src, {
    loader: 'jsx', format: 'cjs', target: 'node18', jsx: 'automatic',
  }).code
  const mod = { exports: {} }
  const stub = (id) => {
    if (id === 'react' || id === 'react/jsx-runtime' || id === 'react-dom/server') {
      return webRequire(id)
    }
    if (/i18n/.test(id)) return { useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) }
    if (/components\/common\/Icons/.test(id)) return loadIcons(esbuild)
    if (/\.\/(Pipeline|UndoClone|useInstallSession)/.test(id)) return { default: () => null }
    throw new Error('StepDeps 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  run(mod.exports, stub, mod, PANEL, EDITOR_DIR)
  return mod.exports
}

/**
 * 把 StepDeps.jsx 里的某个组件渲染成 HTML 字符串。
 * @param {string} name 导出名（如 'VersionSelect' / 'PackageGroups'）
 * @param {object} props 组件属性
 * @returns {string|null} HTML；缺 esbuild 依赖时返回 null
 */
function renderStepDeps (name, props) {
  const mod = loadStepDeps()
  if (!mod) return null
  const Comp = mod[name]
  if (!Comp) return null
  const React = webRequire('react')
  const server = webRequire('react-dom/server')
  return server.renderToStaticMarkup(React.createElement(Comp, props))
}

module.exports = {
  REPO, EDITOR_DIR, PANEL, WEB_DIR,
  webRequire, loadIcons, loadStepDeps, renderStepDeps,
}
