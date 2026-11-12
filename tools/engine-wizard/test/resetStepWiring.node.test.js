'use strict'
// 「从头重装本步」的接线：只清记录等于没生效。
//
// 为什么这条要紧：记录清掉之后，下一次安装仍会沿用装了一半的 .venv，
//   装坏的那个包不会被重装，用户点完按钮看不出任何变化。
//   ⇒ 判据有三条：清记录之后要重读跳过表；端点要删 .venv；界面要刷新状态。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')

test('runEnv 先清记录再读跳过表（顺序反了等于没清）', () => {
  const src = read('tools', 'engine-wizard', 'core', 'envInstall.js')
  const resetAt = src.indexOf("resetEnvProgress(root, String(input.id || ''), 'env')")
  const readAt = src.indexOf("let doneKeys = readEnvProgress(root, String(input.id || ''), 'env')")
  assert.ok(resetAt > 0, '找不到清空断点记录那一句')
  assert.ok(readAt > resetAt,
    '⛔ 跳过表在清空之前就读了：清掉的那几条仍会被跳过，重置等于没做')
})

test('从头重装时会清掉上一次的失败标记', () => {
  const src = read('tools', 'engine-wizard', 'core', 'envInstall.js')
  const resetBlock = src.slice(src.indexOf('if (resetProgress) {'),
    src.indexOf("let doneKeys = readEnvProgress("))
  assert.match(resetBlock, /markPartialVenv\(root, String\(input\.id \|\| ''\), null\)/,
    '⛔ 没清失败标记：重置后仍会按「上次失败」再删一次环境')
})

test('界面发的是「清记录 + 删环境」，而不是只清记录', () => {
  const src = read('tools', 'engine-wizard', 'editor', 'StepDeps.jsx')
  assert.match(src, /removeVenv: true/,
    '⛔ 只清记录：下一次安装会沿用装了一半的环境，按钮看不出效果')
  assert.match(src, /onReload\(\)/,
    '⛔ 清完没刷新完成状态：界面会一直显示「已完成」')
})

test('删环境走确认弹窗，弹窗里写明要删的路径', () => {
  const src = read('tools', 'engine-wizard', 'editor', 'StepDeps.jsx')
  assert.match(src, /setAskReset\(true\)/,
    '⛔ 按钮没有打开确认弹窗')
  assert.match(src, /function ResetStepDialog/,
    '⛔ 找不到确认弹窗组件')
  assert.match(src, /const venvPath = 'engines\/' \+ engineId \+ '\/\.venv'/,
    '⛔ 弹窗没写清删哪个目录：不可逆动作要让人看见确切路径')
  assert.match(src, /<ResetStepDialog/,
    '⛔ 组件定义了却没渲染，点了按钮不会有任何反应')
})

test('App 把刷新完成状态的回调交给第 2 步', () => {
  const src = read('tools', 'engine-wizard', 'editor', 'App.jsx')
  assert.match(src, /onReload=\{\(\) => reloadFacts\(\)\}/,
    '⛔ App 没把 reloadFacts 传下去：重置后界面与磁盘不一致')
})
