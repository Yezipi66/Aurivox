'use strict'

// 第 2 步的版本修改：把组件真正渲染成 HTML 再断言。
//
// 这几条守三件事：
//   ① 笔在 pill 里面，不在 pill 外面；
//   ② 版本号只出现一次（pill 里的那一段），不重复显示；
//   ③ 界面显示的那条 spec 与后端给的那份一致（界面不自己拼）。
//
// 「点笔会不会真的冒泡到整行」由 pencilClick.node.test.js 用 jsdom
//   真点一次来守（SSR 的 HTML 里没有事件属性，查不出来）。

const { test } = require('node:test')
const assert = require('node:assert')
const { renderStepDeps, loadStepDeps } = require('./stepDepsRender')

function renderGroups (props) {
  return renderStepDeps('PackageGroups', Object.assign({
    packages: ['einops==0.8.1', 'torch==2.5.1'],
    isSkipped: () => false,
    onToggle: () => {},
    onVersion: () => {},
    versionOverrides: {},
    t: (en, zh) => zh || en,
  }, props || {}))
}

test('守卫：这份测试真的渲染出了版本控件', () => {
  const html = renderStepDeps('SpecPill', {
    name: 'einops', spec: 'einops==0.8.1', value: '',
    onChange: () => {}, t: (en, zh) => zh || en,
  })
  assert.ok(html, '没渲染出 HTML。缺 esbuild 依赖时这一条会红，'
    + '那是环境问题，不要连同下面那些一起跳过。')
})

test('pill 里面是包名、版本号、笔（没有下拉框）', () => {
  const html = renderStepDeps('SpecPill', {
    name: 'einops', spec: 'einops==0.8.1', value: '',
    onChange: () => {}, t: (en, zh) => zh || en,
  })
  assert.ok(!html.includes('<select'), '不许用下拉框列候选版本')
  assert.ok(!html.includes('<input'), '没点笔时不该有输入框')
  assert.ok(html.includes('<svg'), 'pill 里要有笔')
  assert.ok(html.includes('修改 einops 的版本'), '铅笔按钮要说明它改的是哪个包的版本')
})

test('版本号在 pill 里只出现一次', () => {
  const html = renderStepDeps('SpecPill', {
    name: 'einops', spec: 'einops==0.8.1', value: '',
    onChange: () => {}, t: (en, zh) => zh || en,
  })
  const n = (html.match(/0\.8\.1/g) || []).length
  assert.strictEqual(n, 1, '版本号出现 ' + n + ' 次（该只出现一次）：' + html)
})

test('整条 spec 是连续的一段（复制粘贴不断）', () => {
  const html = renderStepDeps('SpecPill', {
    name: 'einops', spec: 'einops==0.8.1', value: '',
    onChange: () => {}, t: (en, zh) => zh || en,
  })
  assert.ok(html.includes('einops==0.8.1'), '整条 spec 要在一个元素里连续：' + html)
})

test('不可编辑时不显示笔', () => {
  const html = renderStepDeps('SpecPill', {
    name: 'einops', spec: 'einops==0.8.1', value: '',
    onChange: () => {}, t: (en, zh) => zh || en,
    editable: false,
  })
  assert.ok(!html.includes('<svg'), '不可编辑时不该有笔')
  assert.ok(html.includes('einops==0.8.1'), '仍要显示那条 spec')
})

test('splitSpec：一条 spec 拆成头、版本、尾', () => {
  const mod = loadStepDeps()
  let r = mod.splitSpec('einops==0.8.1')
  assert.strictEqual(r.head, 'einops==')
  assert.strictEqual(r.version, '0.8.1')
  assert.strictEqual(r.tail, '')

  r = mod.splitSpec('einops>=0.8.1')
  assert.strictEqual(r.head, 'einops>=')
  assert.strictEqual(r.version, '0.8.1')

  r = mod.splitSpec('torch==2.5.1')
  assert.strictEqual(r.head, 'torch==')
  assert.strictEqual(r.version, '2.5.1')

  r = mod.splitSpec('einops')
  assert.strictEqual(r.head, 'einops')
  assert.strictEqual(r.version, '')

  r = mod.splitSpec('einops[extra]==0.7.0')
  assert.strictEqual(r.head, 'einops[extra]==')
  assert.strictEqual(r.version, '0.7.0')
})

test('declaredVersion：精确钉住、区间、没钉三种都要读对', () => {
  const mod = loadStepDeps()
  assert.strictEqual(mod.declaredVersion('einops==0.8.1'), '0.8.1')
  assert.strictEqual(mod.declaredVersion('einops>=0.8.1'), '0.8.1')
  assert.strictEqual(mod.declaredVersion('torch==2.5.1'), '2.5.1')
  assert.strictEqual(mod.declaredVersion('einops'), '')
  assert.strictEqual(mod.declaredVersion(''), '')
})

test('finalSpec：按包名找出后端给的那条', () => {
  const mod = loadStepDeps()
  assert.strictEqual(mod.finalSpec(['einops==0.7.0', 'torch==2.6.0'], 'einops', 'einops==0.8.1'),
    'einops==0.7.0')
  assert.strictEqual(mod.finalSpec(['einops==0.7.0'], 'torch', 'torch==2.5.1'),
    'torch==2.5.1', '找不到时退回上游原文')
  assert.strictEqual(mod.finalSpec(null, 'torch', 'torch==2.5.1'), 'torch==2.5.1')
})

test('pill 上显示的是后端给的那条 spec（界面不自己拼）', () => {
  const html = renderGroups({
    specs: ['einops==0.7.0', 'torch==2.6.0'],
  })
  assert.ok(html.includes('einops==0.7.0'), '要显示后端算好的那条 spec')
  assert.ok(html.includes('torch==2.6.0'), '要显示后端算好的那条 spec')
  assert.ok(!html.includes('einops==0.8.1'), '不该还显示上游原文')
  assert.ok(!html.includes('torch==2.5.1'), '不该还显示上游原文')
})

test('后端没给 spec 时退回上游原文', () => {
  const html = renderGroups({})
  assert.ok(html.includes('einops==0.8.1'), '后端没给就显示上游原文')
})

test('手写的版本立刻显示在 pill 里', () => {
  const html = renderGroups({
    versionOverrides: { einops: '0.7.0' },
  })
  assert.ok(html.includes('einops==0.7.0'), '手写的版本要显示出来')
  assert.ok(!html.includes('einops==0.8.1'), '不该还显示上游那个版本')
})

test('设为不安装的包在 pill 里没有笔', () => {
  const html = renderGroups({
    isSkipped: (p) => p === 'torch==2.5.1',
  })
  const chips = [...html.matchAll(/<span class="pf-chip"[^>]*>([\s\S]*?)<\/span>/g)]
  assert.ok(chips.length >= 2, '应该有两个 pill：' + html.slice(0, 400))
  const off = chips.find((m) => m[1].includes('torch'))
  assert.ok(off, '找不到 torch 那个 pill')
  assert.ok(!off[1].includes('<svg'), '设为不安装的包不该有笔')
})

test('点笔不许冒泡到整行：源码里必须有断冒泡', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'editor', 'StepDeps.jsx'), 'utf8')
  assert.ok(/onPointerDown=\{stop\}/.test(src),
    '笔的按钮上没有断冒泡的处理函数：点笔会冒泡到整行 ⇒ 等于把这个包设为不安装')
})
