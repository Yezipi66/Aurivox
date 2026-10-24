'use strict'

// 第 2 步的「装依赖」交互：点安装时的决策与弹窗。
//
// 被测代码是 tools/engine-wizard/editor/StepDeps.jsx 里的那份实现，
// 用项目 Vite 依赖的同一个 esbuild 编译成 CJS 后取其导出，不在此处重抄。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const PANEL = path.join(EDITOR_DIR, 'StepDeps.jsx')
const WEB_DIR = path.join(__dirname, '..', '..', '..', 'web')

/**
 * 加载 StepDeps.jsx 里的 installDecision。
 * 组件 import 的 react 与 i18n 与这个纯函数无关，替换成替身即可。
 */
function loadInstallDecision () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  if (!esbuild) return null
  const src = fs.readFileSync(PANEL, 'utf8')
  const code = esbuild.transformSync(src, {
    loader: 'jsx',
    format: 'cjs',
    target: 'node18',
  }).code
  const mod = { exports: {} }
  const stub = (id) => {
    if (id === 'react') return {}
    if (/i18n/.test(id)) return { useT: () => ({ t: (en) => en, lang: 'en' }) }
    // 子组件与旁支模块本测试不需要它们渲染。
    if (/\.\/(Pipeline|UndoClone|useInstallSession)/.test(id)) return { default: () => null }
    throw new Error('installDecision 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  run(mod.exports, stub, mod, PANEL, EDITOR_DIR)
  return mod.exports.installDecision
}

const installDecision = loadInstallDecision()

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

// 没能联网确认（index 抓不到）。
const UNCHECKED = {
  ok: false,
  backend: 'ipex',
  pythonVersion: '3.11',
  declared: '2.5.1',
  available: [],
  reason: 'could-not-check',
}

test('守卫：这份测试真的拿到了活代码里的那个纯函数', () => {
  assert.equal(typeof installDecision, 'function',
    '没拿到 installDecision。缺 esbuild 依赖时这一条会红，'
    + '那是环境问题，不要连同下面那些一起跳过。')
})

test('探测出建议且还没答过 ⇒ 先弹窗，不直接装', () => {
  const d = installDecision(SUGGESTION, null)
  assert.strictEqual(d.ask, true, '有建议且没答过 ⇒ 要弹窗')
  assert.strictEqual(d.upgradeTorch, false, '弹窗阶段不擅自升级')
})

test('确认不可用但没有可替换的版本 ⇒ 照样弹窗（不能静默放行）', () => {
  // 这一条是「不要让使用者撞原始报错」的关键：
  //   弹窗前就说出「这个后端上装不了」，而不是装到一半炸。
  for (const s of [NO_WHEEL, UNCHECKED]) {
    const d = installDecision(s, null)
    assert.strictEqual(d.ask, true,
      `不可用/没确认时必须弹窗：${s.reason}`)
    assert.strictEqual(d.upgradeTorch, false, '弹窗阶段不擅自升级')
    assert.deepStrictEqual(d.torchSuggestion, s, '结论要一起带上去')
  }
})

test('没有建议也没有不可用的结论 ⇒ 直接装，不弹窗', () => {
  for (const s of [null, {}, { suggested: null }, { ok: true, suggested: null }]) {
    const d = installDecision(s, null)
    assert.strictEqual(d.ask, false, `没有建议不该弹窗：${JSON.stringify(s)}`)
    assert.strictEqual(d.upgradeTorch, false)
  }
})

test('使用者已接受升级 ⇒ 直接按升级装，不再弹窗', () => {
  const d = installDecision(SUGGESTION, true)
  assert.strictEqual(d.ask, false, '答过就不该再拦')
  assert.strictEqual(d.upgradeTorch, true, '按接受执行')
  assert.deepStrictEqual(d.torchSuggestion, SUGGESTION)
})

test('没有可替换的版本时，「接受」不能走升级路线', () => {
  // 后端的升级路线要求 torchSuggestion.suggested 存在，
  //   没有就报 NO_TORCH_SUGGESTION，整个计划失败。
  for (const s of [NO_WHEEL, UNCHECKED]) {
    const d = installDecision(s, true)
    assert.strictEqual(d.upgradeTorch, false,
      `没有可替换的版本就不该走升级路线：${s.reason}`)
  }
})

test('使用者已拒绝升级 ⇒ 直接按原样装，不再弹窗', () => {
  const d = installDecision(SUGGESTION, false)
  assert.strictEqual(d.ask, false, '答过就不该再拦')
  assert.strictEqual(d.upgradeTorch, false, '按拒绝执行，不升级')
})

test('拒绝升级后仍把建议带上去（后端据此知道是使用者主动拒绝）', () => {
  const d = installDecision(SUGGESTION, false)
  assert.deepStrictEqual(d.torchSuggestion, SUGGESTION,
    '建议要一起传，否则后端分不清「没探测到」与「探测到但被拒绝」')
})
