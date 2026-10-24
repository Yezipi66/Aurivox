'use strict'

// 第 2 步的版本修改：把组件真正渲染成 HTML 再断言。
//
// 判据的理由：版本这件事只有「铅笔 + 手写」一条路，界面上不许出现
//   平台给出的候选版本（候选意味着平台替使用者挑版本，而版本本是
//   上游声明的事，平台手上没有「这个包有哪些版本」这份事实）。
//   所以这几条守的是：铅笔在、输入框在不点铅笔时不出现、
//   覆盖后的版本显示得出来、设为不安装的包不给改。

const { test } = require('node:test')
const assert = require('node:assert')
const { renderStepDeps, loadStepDeps } = require('./stepDepsRender')

function render (props) {
  return renderStepDeps('VersionSelect', Object.assign({
    t: (en, zh) => zh || en,
    onChange: () => {},
  }, props || {}))
}

test('守卫：这份测试真的渲染出了版本控件', () => {
  const html = render({ name: 'einops', spec: 'einops==0.8.1' })
  assert.ok(html, '没渲染出 HTML。缺 esbuild 依赖时这一条会红，'
    + '那是环境问题，不要连同下面那些一起跳过。')
})

test('没点铅笔时不出现输入框（只有版本号与铅笔）', () => {
  const html = render({ name: 'einops', spec: 'einops==0.8.1' })
  assert.ok(!html.includes('<input'), '没进编辑态就不该有输入框')
  assert.ok(!html.includes('<select'), '不许用下拉框列候选版本')
})

test('版本号后面有一支铅笔', () => {
  const html = render({ name: 'einops', spec: 'einops==0.8.1' })
  assert.ok(html.includes('修改 einops 的版本'), '铅笔按钮要说明它改的是哪个包的版本')
  assert.ok(html.includes('<svg'), '铅笔是 SVG 图标')
})

test('默认显示上游声明的版本', () => {
  const html = render({ name: 'einops', spec: 'inops==0.8.1'.replace('inops', 'einops') })
  assert.ok(html.includes('0.8.1'), '要显示上游声明的版本')
})

test('上游没钉版本时，写明未声明', () => {
  const html = render({ name: 'einops', spec: 'einops' })
  assert.ok(html.includes('未声明'), '上游没钉版本时要说明')
})

test('已经覆盖过的版本显示得出来（不必再点铅笔）', () => {
  const html = render({
    name: 'einops', spec: 'einops==0.8.1', value: '0.7.0',
  })
  assert.ok(html.includes('0.7.0'), '手写的版本不能消失')
})

test('设为不安装的包不给改版本（没有铅笔）', () => {
  const html = render({
    name: 'einops', spec: 'einops==0.8.1', editable: false,
  })
  assert.ok(!html.includes('<svg'), '不可编辑时不该有铅笔')
  assert.ok(!html.includes('<input'), '不可编辑时不该有输入框')
  assert.ok(html.includes('0.8.1'), '仍要显示上游声明的版本')
})

test('declaredVersion：精确钉住、区间、没钉三种都要读对', () => {
  const mod = loadStepDeps()
  assert.strictEqual(mod.declaredVersion('einops==0.8.1'), '0.8.1')
  assert.strictEqual(mod.declaredVersion('einops>=0.8.1'), '0.8.1')
  assert.strictEqual(mod.declaredVersion('torch==2.5.1'), '2.5.1')
  assert.strictEqual(mod.declaredVersion('einops'), '')
  assert.strictEqual(mod.declaredVersion(''), '')
})
