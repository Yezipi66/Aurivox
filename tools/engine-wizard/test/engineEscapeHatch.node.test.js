'use strict'
// 全局逃生口（EngineEscapeHatch）的行为守卫：
//   ① 只渲染一个引擎下拉（一列），值绑暂存的选择（初始 = 当前目标）；
//   ② 换选只暂存：提交要走「切换引擎」按钮 + 二次确认，确认才回调 onSwitch；
//   ③ 只在第 2-5 步渲染（第 1 步是克隆，不选已有引擎）；
//   ④ 第 4 步的 EngineIdentity 下拉换引擎时也同步全局目标（onEngineTarget）；
//   ⑤ App 的 switchEngine 换目标时连同名片与操作记录一起重读。
//
// 组件行为用 jsdom 真渲染（照 engineSwitch.node.test.js 的写法）；
// App.jsx 的门控与 EngineIdentity 的同步用源码断言（照 manifestLayout 的写法）。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')

const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { JSDOM } = require(resolveFromRoot('jsdom'))

/** 编译并加载一个 JSX 模块；外部依赖用 stub。 */
function loadJsx (file, stubMap) {
  const esb = esbuild()
  const code = esb.transformSync(fs.readFileSync(path.join(EDITOR_DIR, file), 'utf8'), {
    loader: 'jsx', format: 'cjs', target: 'node18',
  }).code
  const mod = { exports: {} }
  const stub = (id) => {
    for (const [k, v] of Object.entries(stubMap)) {
      if (id === k || id.endsWith(k)) return v
    }
    throw new Error(file + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, path.join(EDITOR_DIR, file), EDITOR_DIR)
  return mod.exports
}

const i18nStub = { useT: () => ({ t: (en) => en }) }

const DIRS = [
  { id: 'piper', manifestPresent: false },
  { id: 'spark-tts', manifestPresent: true },
]

const EngineEscapeHatch = loadJsx('EngineEscapeHatch.jsx', {
  react: React,
  'web/src/lib/i18n': i18nStub,
}).default

/** 起一个 jsdom 页面。 */
function mount () {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:5199/',
    pretendToBeVisual: true,
  })
  const define = (key, value) => {
    Object.defineProperty(global, key, { value, writable: true, configurable: true })
  }
  define('window', dom.window)
  define('document', dom.window.document)
  define('navigator', dom.window.navigator)
  define('HTMLElement', dom.window.HTMLElement)
  define('Element', dom.window.Element)
  define('Node', dom.window.Node)
  define('getComputedStyle', dom.window.getComputedStyle)
  define('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0))
  define('cancelAnimationFrame', (id) => clearTimeout(id))
  const container = dom.window.document.getElementById('root')
  return { dom, container, root: ReactDOMClient.createRoot(container) }
}

const settle = () => new Promise((r) => setTimeout(r, 40))

/** 把下拉改成指定值（走原生 setter + change 事件，与浏览器一致）。 */
async function pickInSelect (dom, container, value) {
  const sel = container.querySelector('select')
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, value)
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await settle()
}

/** 点一个按钮（原生 click 事件冒泡到 React 根）。 */
async function clickBtn (dom, btn) {
  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }))
  await settle()
}

test('只渲染一个引擎下拉，值绑暂存的选择（初始 = 当前目标）', async () => {
  const { container, root } = mount()
  root.render(React.createElement(EngineEscapeHatch, {
    id: 'piper', dirs: DIRS, onSwitch: () => {},
  }))
  await settle()
  const sels = container.querySelectorAll('select')
  assert.strictEqual(sels.length, 1, '逃生口只该有一个下拉（一列）')
  assert.strictEqual(sels[0].value, 'piper', '下拉初始值应是当前目标')
})

// ---- 暂存语义：选了不等于切了 ----
// 旧版下拉改选即 setWz：只换了一半（完成状态跟着换，第 4 步的名片还停在
//   旧目标上，保存也写回旧目标）。改成交付按钮 + 二次确认：确认才真正提交。
test('换选只暂存不提交：onSwitch 不被调用', async () => {
  const { dom, container, root } = mount()
  const switched = []
  root.render(React.createElement(EngineEscapeHatch, {
    id: 'piper', dirs: DIRS, onSwitch: (id) => switched.push(id),
  }))
  await settle()
  await pickInSelect(dom, container, 'spark-tts')
  assert.strictEqual(container.querySelector('select').value, 'spark-tts',
    '下拉值应是暂存的选择')
  assert.deepStrictEqual(switched, [], '换选不该直接提交：静默半切换是旧病')
})

// ---- 按钮出现条件：暂存与当前不同（且非空）才有；相同或空都没有 ----
test('暂存与当前不同时出现「切换引擎」按钮，相同时不出现', async () => {
  const { dom, container, root } = mount()
  root.render(React.createElement(EngineEscapeHatch, {
    id: 'piper', dirs: DIRS, onSwitch: () => {},
  }))
  await settle()
  assert.ok(!container.querySelector('.confirm-actions button'),
    '暂存 = 当前时不应出现提交按钮')
  await pickInSelect(dom, container, 'spark-tts')
  const btn = container.querySelector('.confirm-actions button')
  assert.ok(btn, '暂存与当前不同时应出现提交按钮（右下角）')
  assert.strictEqual(btn.textContent, 'Switch engine', '按钮文案应是「切换引擎」')
})

test('暂存回占位项（空目标）时不出现提交按钮', async () => {
  const { dom, container, root } = mount()
  root.render(React.createElement(EngineEscapeHatch, {
    id: 'piper', dirs: DIRS, onSwitch: () => {},
  }))
  await settle()
  await pickInSelect(dom, container, '')
  assert.ok(!container.querySelector('.confirm-actions button'),
    '空目标不该能提交：占位项不是一次有效的切换')
})

// ---- 二次确认：取消不提交，确认才提交 ----
test('点「切换引擎」弹确认框；取消不提交，确认才提交', async () => {
  const { dom, container, root } = mount()
  const switched = []
  root.render(React.createElement(EngineEscapeHatch, {
    id: 'piper', dirs: DIRS, onSwitch: (id) => switched.push(id),
  }))
  await settle()
  await pickInSelect(dom, container, 'spark-tts')
  await clickBtn(dom, container.querySelector('.confirm-actions button'))
  const overlay = container.querySelector('.modal-overlay')
  assert.ok(overlay, '点「切换引擎」应弹出二次确认')
  const buttons = [...overlay.querySelectorAll('button')]
  const cancel = buttons.find((b) => /Cancel/.test(b.textContent))
  const confirm = buttons.find((b) => /Confirm switch/.test(b.textContent))
  assert.ok(cancel && confirm, '确认框应同时给「取消」与「确认切换」两条路')

  await clickBtn(dom, cancel)
  assert.ok(!container.querySelector('.modal-overlay'), '取消应关闭确认框')
  assert.deepStrictEqual(switched, [], '取消不应提交')

  await clickBtn(dom, container.querySelector('.confirm-actions button'))
  const overlay2 = container.querySelector('.modal-overlay')
  await clickBtn(dom, [...overlay2.querySelectorAll('button')]
    .find((b) => /Confirm switch/.test(b.textContent)))
  assert.deepStrictEqual(switched, ['spark-tts'], '确认才提交 onSwitch，并带上目标 id')
})

// ---- 提交成功后：外层目标更新，暂存同步、按钮收掉 ----
test('外部目标变化后暂存同步，提交按钮收掉', async () => {
  const { dom, container, root } = mount()
  root.render(React.createElement(EngineEscapeHatch, {
    id: 'piper', dirs: DIRS, onSwitch: () => {},
  }))
  await settle()
  await pickInSelect(dom, container, 'spark-tts')
  assert.ok(container.querySelector('.confirm-actions button'))
  // 提交成功：外层把已提交目标换成 spark-tts
  root.render(React.createElement(EngineEscapeHatch, {
    id: 'spark-tts', dirs: DIRS, onSwitch: () => {},
  }))
  await settle()
  assert.strictEqual(container.querySelector('select').value, 'spark-tts',
    '外部目标更新后暂存应同步')
  assert.ok(!container.querySelector('.confirm-actions button'),
    '暂存与已提交目标一致时按钮应收掉')
})

test('没有目标时显示占位项，不崩', async () => {
  const { container, root } = mount()
  root.render(React.createElement(EngineEscapeHatch, {
    id: '', dirs: DIRS, onSwitch: () => {},
  }))
  await settle()
  const sel = container.querySelector('select')
  assert.strictEqual(sel.value, '', '空目标应显示占位项')
  assert.strictEqual(sel.options.length, DIRS.length + 1, '占位 + 每个引擎一项')
})

// ---- App.jsx 的门控：逃生口只在第 2-5 步渲染，顶部不再有全局下拉 ----
test('App.jsx 不再有顶部「当前引擎」下拉', () => {
  const app = fs.readFileSync(path.join(EDITOR_DIR, 'App.jsx'), 'utf8')
  assert.ok(!/wz-engine-pick/.test(app),
    '顶部「当前引擎」下拉还在（wz-engine-pick）：应已移除，改由每步的逃生口承担')
})

test('App.jsx 渲染逃生口，且门控排除第 1 步', () => {
  const app = fs.readFileSync(path.join(EDITOR_DIR, 'App.jsx'), 'utf8')
  assert.ok(/EngineEscapeHatch/.test(app), 'App.jsx 没有渲染逃生口')
  assert.ok(/page !== 'prepare'/.test(app),
    '逃生口没排除第 1 步：第 1 步是克隆，不该出现「选已有引擎」')
})

// ---- App.jsx 的提交语义：换引擎要连同名片与操作记录一起换 ----
// 只改 wz.id 是半切换：完成状态跟着换了，第 4 步的名片还停在旧目标上
//   （manifestEngineId 优先取 manifest.id），保存也写回旧目标。
//   switchEngine 负责把名片、JSON 编辑缓冲、完成状态、目录清单一起换掉。
function switchEngineBody (app) {
  const start = app.indexOf('const switchEngine')
  assert.ok(start > 0, 'App.jsx 没有 switchEngine：逃生口换引擎后状态不跟着换')
  const end = app.indexOf('\n  }', start)
  assert.ok(end > start, 'switchEngine 的函数体找不到右花括号：提取失败')
  return app.slice(start, end + '\n  }'.length)
}

test('App.jsx 有 switchEngine：换引擎时名片、缓冲、完成状态一起重读', () => {
  const body = switchEngineBody(fs.readFileSync(path.join(EDITOR_DIR, 'App.jsx'), 'utf8'))
  assert.ok(/setWz\(\(cur\) => \(\{ \.\.\.cur, id: nextId \}\)\)/.test(body),
    'switchEngine 没换 wz.id')
  assert.ok(/\/wizard\/manifest\//.test(body),
    'switchEngine 没按新引擎读盘上的名片：第 4 步还会停在上一台')
  assert.ok(/manifestForEngineSwitch/.test(body),
    'switchEngine 没有新引擎无名片时的回落（清段空壳）')
  assert.ok(/setText\(null\)/.test(body) && /setErr\(null\)/.test(body),
    'switchEngine 没重置 JSON 编辑缓冲与解析错误：旧名片会借防抖分支回来')
  assert.ok(/reloadFacts\(nextId\)/.test(body),
    'switchEngine 没调 reloadFacts(nextId)：完成状态（绿勾）不随引擎换')
  assert.ok(/reloadDirs\(\)/.test(body),
    'switchEngine 没调 reloadDirs()：引擎目录清单不刷新')
})

test('App.jsx 逃生口用 onSwitch 接 switchEngine（不再静默半切换）', () => {
  const app = fs.readFileSync(path.join(EDITOR_DIR, 'App.jsx'), 'utf8')
  assert.ok(/<EngineEscapeHatch id=\{wz\.id\} dirs=\{engineDirs\} onSwitch=\{switchEngine\} \/>/.test(app),
    '逃生口没接 switchEngine：换引擎仍只换 wz.id，第 4 步的名片不跟')
})

// ---- 克隆完成 ⇒ 下拉数据源要刷新 ----
// useEngineDirs 只在挂载时 fetch 一次；克隆新引擎后不刷新的话，第 2 步起逃生口里
//   看不到刚克隆的那台（状态一致性问题）。判据：App 解构出 reload，并在 onDone 里调用。
test('App.jsx 解构 useEngineDirs 的 reload，克隆完成时刷新下拉', () => {
  const app = fs.readFileSync(path.join(EDITOR_DIR, 'App.jsx'), 'utf8')
  assert.ok(/const \{ dirs: engineDirs, reload: reloadDirs \} = useEngineDirs\(\)/.test(app),
    'App 只解构了 dirs，没解构 reload：克隆完成后下拉数据源不刷新，看不到刚克隆的引擎')
  // onDone 里必须调用 reloadDirs()（克隆完成后立刻让新引擎进下拉）
  const onDone = (app.match(/onDone=\{\(clonedId\) => \{[\s\S]*?\}\}/) || [''])[0]
  assert.ok(onDone.includes('reloadDirs()'),
    'onDone 里没调 reloadDirs()：克隆完成后逃生口下拉不会出现刚克隆的引擎')
})

// ---- EngineIdentity 换引擎时同步全局目标 ----
test('EngineIdentity 换引擎回调 onEngineTarget（同步全局目标）', () => {
  const identity = fs.readFileSync(path.join(EDITOR_DIR, 'EngineIdentity.jsx'), 'utf8')
  assert.ok(/onEngineTarget/.test(identity),
    'EngineIdentity 没接 onEngineTarget：第 4 步换引擎不同步全局目标')
})
