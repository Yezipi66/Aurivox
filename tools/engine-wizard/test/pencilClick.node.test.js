'use strict'

// 「点笔不许冒泡到整行」这条守卫要真的跑一次点击。
//
// 为什么不能用 SSR 的 HTML 判：React 的事件处理器不渲染成 HTML 属性
//   （SSR 出来的 HTML 里根本没有 onPointerDown）⇒ 查属性只能查出
//   「源码里写了没有」，查不出「点了会不会冒泡」。
//   而这里要守的正是后者：笔在整行的点击区里面，
//   一点就冒泡 ⇒ 点笔等于把这个包设为不安装。
//
// 所以这里用 jsdom 挂一个真的 DOM，渲染真的组件，
//   然后在整行上放一个监听器，看点笔时它有没有被叫到。

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
// web 目录按本文件的位置推算，不能写死绝对路径：写死了换个检出目录就找不到依赖，
// CI 上（干净检出到别处）会直接报 MODULE_NOT_FOUND。
const { WEB_DIR, webRequire } = require('./stepDepsRender')
const { JSDOM } = require(path.join(WEB_DIR, 'node_modules', 'jsdom'))

const { loadStepDeps } = require('./stepDepsRender')

// React 的 concurrent root 是异步渲染的（commit 在微任务之后），
//   所以断言要等它真的把 DOM 挂上。
const tick = () => new Promise((r) => setTimeout(r, 20))

async function withDom (fn) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { pretendToBeVisual: true, url: 'http://127.0.0.1:5199/' })
  const saved = {
    window: global.window,
    document: global.document,
    navigator: Object.getOwnPropertyDescriptor(global, 'navigator'),
  }
  global.window = dom.window
  global.document = dom.window.document
  // Node 26 的 global.navigator 只有 getter ⇒ 不能直接赋值，
  //   要用 defineProperty 把它换成可写属性。
  Object.defineProperty(global, 'navigator', {
    value: dom.window.navigator, configurable: true, writable: true,
  })
  try {
    return await fn(dom)
  } finally {
    global.window = saved.window
    global.document = saved.document
    if (saved.navigator) Object.defineProperty(global, 'navigator', saved.navigator)
    else delete global.navigator
    dom.window.close()
  }
}

// 挂一个「第 2 步真实结构」：整行是点击区（切换是否安装），
//   行里面是 pill，pill 里面是版本号与笔。
async function mount (dom, Comp, props) {
  // React 与 react-dom 要与被测组件用的是同一份（组件那边的 react 是 webRequire 取的）。
  //   取两份不同的 React 会触发 Invalid hook call。
  const React = webRequire('react')
  const ReactDOM = require(path.join(WEB_DIR, 'node_modules', 'react-dom', 'client'))
  const state = { toggled: 0 }
  const root = dom.window.document.getElementById('root')
  ReactDOM.createRoot(root).render(
    React.createElement('div', {
      className: 'pf-row',
      onClick: () => { state.toggled += 1 },
    }, React.createElement(Comp, Object.assign({
      name: 'torch',
      spec: 'torch==2.5.1',
      value: '',
      onChange: () => {},
      t: (en, zh) => zh || en,
    }, props || {})))
  )
  await tick()
  return state
}

test('点笔不冒泡到整行（整行是切换是否安装的点击区）', async () => {
  const mod = loadStepDeps()
  assert.ok(mod, '拿不到组件')
  await withDom(async (dom) => {
    const state = await mount(dom, mod.SpecPill, { pillProps: { className: 'pf-chip' } })
    const btn = dom.window.document.querySelector('button.pkg-pencil')
    assert.ok(btn, '找不到笔按钮')
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()
    assert.strictEqual(state.toggled, 0,
      '点笔触发了整行的点击（切换了是否安装）⇒ 笔必须自己断掉冒泡')
  })
})

test('点 pill 的空白处会冒泡到整行（那才是切换是否安装）', async () => {
  const mod = loadStepDeps()
  assert.ok(mod, '拿不到组件')
  await withDom(async (dom) => {
    const state = await mount(dom, mod.SpecPill, { pillProps: { className: 'pf-chip' } })
    const chip = dom.window.document.querySelector('span.pf-chip')
    assert.ok(chip, '找不到 pill')
    chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()
    assert.strictEqual(state.toggled, 1, '点 pill 应该切换是否安装')
  })
})

test('点笔进编辑态（输入框出现）', async () => {
  const mod = loadStepDeps()
  assert.ok(mod, '拿不到组件')
  await withDom(async (dom) => {
    await mount(dom, mod.SpecPill, { pillProps: { className: 'pf-chip' } })
    const btn = dom.window.document.querySelector('button.pkg-pencil')
    assert.ok(btn, '找不到笔按钮')
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()
    const input = dom.window.document.querySelector('input')
    assert.ok(input, '点笔后没有出现输入框')
  })
})

test('版本号在 pill 里只出现一次（不许 pill 一遍、笔旁边一遍）', async () => {
  const mod = loadStepDeps()
  assert.ok(mod, '拿不到组件')
  await withDom(async (dom) => {
    await mount(dom, mod.SpecPill, { pillProps: { className: 'pf-chip' } })
    const chip = dom.window.document.querySelector('span.pf-chip')
    assert.ok(chip, '找不到 pill')
    const text = chip.textContent || ''
    const n = (text.match(/2\.5\.1/g) || []).length
    assert.strictEqual(n, 1, '版本号在 pill 里出现 ' + n + ' 次（该只出现一次）：' + text)
  })
})

test('pill 上是包名与约束加版本号连着的一条（torch==2.5.1）', async () => {
  const mod = loadStepDeps()
  assert.ok(mod, '拿不到组件')
  await withDom(async (dom) => {
    await mount(dom, mod.SpecPill, { pillProps: { className: 'pf-chip' } })
    const chip = dom.window.document.querySelector('span.pf-chip')
    assert.ok(chip, '找不到 pill')
    const text = (chip.textContent || '').trim()
    assert.ok(text.startsWith('torch=='), 'pill 上要显示包名与约束：' + text)
    assert.ok(text.includes('2.5.1'), 'pill 上要显示版本号：' + text)
  })
})
