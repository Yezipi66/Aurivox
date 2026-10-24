'use strict'

// 第 2 步的升级 Torch 弹窗：把组件真正渲染成 HTML 再断言。
//
// 用 web/ 里现成的 react + react-dom/server（React 18），
// 被测组件是 tools/engine-wizard/editor/StepDeps.jsx 里的那份实现。
// 渲染出来的 HTML 里能看到：弹窗有没有出现、说的版本对不对、
// 两个按钮的中英文文案在不在。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const PANEL = path.join(EDITOR_DIR, 'StepDeps.jsx')
const WEB_DIR = path.join(__dirname, '..', '..', '..', 'web')

const SUGGESTION = {
  ok: false,
  backend: 'ipex',
  pythonVersion: '3.11',
  declared: '2.5.1',
  suggested: '2.6.0',
  reason: 'version-not-on-this-backend',
}

// 这个后端在本机 Python 上一个轮子都没有：换 torch 版本解决不了。
const NO_WHEEL = {
  ok: false,
  backend: 'ipex',
  pythonVersion: '3.11',
  declared: '2.5.1',
  available: [],
  reason: 'no-wheel-for-this-python',
}

/**
 * 把 StepDeps.jsx 编译成 CJS 并取其导出的 TorchUpgradeDialog。
 * react / react-dom/server / i18n 走 web/node_modules 的真货，
 * 只有跟本测试无关的旁支模块给替身。
 */
function loadDialog () {
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
    throw new Error('TorchUpgradeDialog 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  run(mod.exports, stub, mod, PANEL, EDITOR_DIR)
  return mod.exports
}

/**
 * 渲染弹窗，返回 HTML 字符串。
 * @param {object} suggestion 探测出的建议
 * @param {string} backendLabel 后端名（给人看的）
 */
function renderDialog (suggestion, backendLabel) {
  const mod = loadDialog()
  if (!mod) return null
  const Dialog = mod.TorchUpgradeDialog
  if (!Dialog) return null
  const React = require(path.join(WEB_DIR, 'node_modules', 'react'))
  const server = require(path.join(WEB_DIR, 'node_modules', 'react-dom', 'server.js'))
  return server.renderToStaticMarkup(
    React.createElement(Dialog, {
      suggestion,
      backendLabel: backendLabel || 'XPU',
      onAccept: () => {},
      onDecline: () => {},
    })
  )
}

test('守卫：这份测试真的渲染出了弹窗组件', () => {
  const html = renderDialog(SUGGESTION, 'XPU')
  assert.ok(html, '没渲染出 HTML。缺 esbuild 依赖时这一条会红，'
    + '那是环境问题，不要连同下面那些一起跳过。')
})

test('弹窗出现在遮罩上，不是藏在页面里', () => {
  const html = renderDialog(SUGGESTION, 'XPU')
  assert.ok(html.includes('modal-overlay'), '弹窗要挂在遮罩上')
  assert.ok(html.includes('modal-card'), '弹窗本体用 modal-card')
})

test('弹窗把建议版本写出来', () => {
  const html = renderDialog(SUGGESTION, 'XPU')
  assert.ok(html.includes('2.5.1'), '要说明上游声明的是哪个版本')
  assert.ok(html.includes('2.6.0'), '要说明建议装的是哪个版本')
})

test('弹窗把后端名写出来（使用者据此判断）', () => {
  const html = renderDialog(SUGGESTION, 'XPU')
  assert.ok(html.includes('XPU'), '要写后端名')
})

test('原因不写成 Python 版本的问题：版本与后端的组合没有可用 wheel', () => {
  const html = renderDialog(SUGGESTION, 'XPU')
  // 上游声明的版本在这个后端上根本发过没有，与 Python 版本无关。
  assert.ok(html.includes('没有适配的 wheel'), '要说清是这个组合没有可用 wheel')
  assert.ok(!html.includes('没有适配 Python'), '不许把原因写成 Python 版本不匹配')
  assert.ok(!/没有适配 Python/.test(html), '不许出现「没有适配 Python」这种说法')
})

test('弹窗给两条路：装建议版本 与 取消', () => {
  const html = renderDialog(SUGGESTION, 'XPU')
  assert.ok(html.includes('安装 Torch 2.6.0'), '要有一个直接装建议版本的按钮')
  assert.ok(html.includes('取消'), '要有取消按钮')
})

test('两个按钮都是 type=button，不误触表单提交', () => {
  const html = renderDialog(SUGGESTION, 'XPU')
  const buttons = html.match(/<button[^>]*>/g) || []
  assert.ok(buttons.length >= 2, `至少两个按钮，实际 ${buttons.length} 个`)
  for (const b of buttons) {
    assert.ok(b.includes('type="button"'), `按钮要声明 type=button：${b}`)
  }
})

test('这个后端一个轮子都没有 ⇒ 说清装不了，且不给假的版本选项', () => {
  const html = renderDialog(NO_WHEEL, 'XPU')
  assert.ok(html.includes('2.5.1'), '要说明上游声明的是哪个版本')
  assert.ok(html.includes('XPU'), '要写后端名')
  assert.ok(html.includes('这个后端上装不了 Torch'), '要说清这个后端上装不了')
  assert.ok(html.includes('没有适配的 wheel'), '要说清是这个组合没有可用 wheel')
  assert.ok(!/没有适配 Python/.test(html), '不许把原因写成 Python 版本不匹配')
  // 按钮文案里不该出现「装 Torch <版本>」（正文里提到 Torch 是正常的）。
  assert.ok(!/安装 Torch \d/.test(html), '没有可替换版本时不该出现「装 Torch X」这个按钮')
  assert.ok(html.includes('照原样装'), '要留一条「照原样装」的路，由使用者承担结果')
})

test('没有可替换版本时，弹窗仍然给两条路（取消 与 照原样装）', () => {
  const html = renderDialog(NO_WHEEL, 'XPU')
  const buttons = html.match(/<button[^>]*>/g) || []
  assert.strictEqual(buttons.length, 2,
    `两条路两个按钮，实际 ${buttons.length} 个：${NO_WHEEL.reason}`)
})
