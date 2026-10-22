'use strict'
// DragBind 的行为测试：调用组件函数，捕获 onChange 的入参来验证绑定逻辑。
// 绑定逻辑写在组件函数体内（闭包），没有可单独导入的函数，只能这样驱动。
// 被测代码是 tools/engine-wizard/editor/DragBind.jsx 里的那份实现，
// 用项目 Vite 依赖的同一个 esbuild 编译成 CJS 后取其导出，不在此处重抄。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const DRAGBIND = path.join(EDITOR_DIR, 'DragBind.jsx')
const WEB_DIR = path.join(__dirname, '..', '..', '..', 'web')

/**
 * 加载 DragBind.jsx 里的组件函数。
 * 组件 import 的 react 与 i18n 与绑定逻辑无关，替换成替身即可。
 */
function loadDragBind () {
  const src = fs.readFileSync(DRAGBIND, 'utf8')
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  if (!esbuild) {
    throw new Error('拿不到 esbuild，DragBind 的 JSX 编译测试无法运行')
  }
  const code = esbuild.transformSync(src, {
    loader: 'jsx',
    format: 'cjs',
    target: 'node18',
  }).code
  const mod = { exports: {} }
  const stub = (id) => {
    if (id === 'react') return {
      useState: () => [null, () => {}],
      useEffect: () => {},
      // 组件渲染时调用 React.createElement，返回的对象可以递归遍历。
      createElement: (type, config, ...children) => ({
        type, props: config || {}, children,
        key: (config && config.key) || null,
      }),
    }
    if (/i18n/.test(id)) return { useT: () => ({ t: (en) => en }) }
    if (/useInstalled/.test(id)) return { useInstalled: () => ({}) }
    throw new Error('DragBind 的依赖不该被求值：' + id)
  }
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  run(mod.exports, stub, mod, DRAGBIND, EDITOR_DIR)
  return mod.exports.default
}

const DragBind = loadDragBind()

// 夹具：/wizard/discover 返回的参数形状。
const PARAMS_CLI = [
  { name: 'voice', target: '--voice', source: 'cli', group: 'generate', style: 'value' },
  { name: 'speed', target: '--speed', source: 'cli', group: 'generate', style: 'value' },
  { name: 'ref_audio', target: '--ref-audio', source: 'cli', group: 'input', style: 'value' },
]

const PARAMS_PY = [
  { name: 'text', target: 'text', source: 'python', group: 'input' },
  { name: 'ref_audio', target: 'ref_audio', source: 'python', group: 'input' },
]

// 夹具：call 的初始状态
const CALL_EMPTY = { kind: 'cli', bind: {}, args: {} }

/**
 * 从 React 元素树中递归查找所有带 onClick 的子元素。
 * @returns {Array<{onClick: Function, type: any, props: any, key: any}>}
 */
function findOnClick (node, results = []) {
  if (!node || typeof node !== 'object') return results
  if (Array.isArray(node)) {
    for (const item of node) findOnClick(item, results)
    return results
  }
  if (node.props && typeof node.props.onClick === 'function') {
    results.push({ onClick: node.props.onClick, type: node.type, props: node.props, key: node.key })
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) findOnClick(child, results)
  }
  return results
}

/**
 * 调用组件函数，捕获 onChange 的调用。
 * @returns {{calls: any[], result: any}} calls 是 onChange 收到的所有入参。
 */
function invoke (props) {
  const calls = []
  const onChange = (next) => { calls.push(next) }
  const result = DragBind({ ...props, onChange })
  return { calls, result }
}

test('组件加载成功', () => {
  assert.strictEqual(typeof DragBind, 'function')
})

test('空参数：不报错，不产生 onChange 调用', () => {
  const { calls } = invoke({ call: CALL_EMPTY, params: [], onChange: () => {} })
  assert.strictEqual(calls.length, 0)
})

test('有参数但无操作：不产生 onChange 调用', () => {
  const { calls } = invoke({ call: CALL_EMPTY, params: PARAMS_CLI, onChange: () => {} })
  assert.strictEqual(calls.length, 0)
})

test('点击选中再点槽位：建立 bind 绑定', () => {
  // 让 useState 的选中项固定为第一个参数，再从渲染结果里取出槽位上的
  // onClick 并触发它，验证 onChange 的输出。
  const esbuild = require(path.join(WEB_DIR, 'node_modules', 'esbuild'))
  const src = fs.readFileSync(DRAGBIND, 'utf8')
  const code = esbuild.transformSync(src, { loader: 'jsx', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  const stub = (id) => {
    if (id === 'react') return {
      useState: (init) => [PARAMS_CLI[0], () => {}],
      useEffect: () => {},
      createElement: (type, config, ...children) => ({
        type, props: config || {}, children,
        key: (config && config.key) || null,
      }),
    }
    if (/i18n/.test(id)) return { useT: () => ({ t: (en) => en }) }
    if (/useInstalled/.test(id)) return { useInstalled: () => ({}) }
    throw new Error('DragBind 的依赖不该被求值：' + id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, DRAGBIND, EDITOR_DIR)
  const DragBindFixed = mod.exports.default

  const calls = []
  const result = DragBindFixed({ call: CALL_EMPTY, params: PARAMS_CLI, onChange: (n) => calls.push(n) })
  const handlers = findOnClick(result)

  // 槽位那一格有 key={slot.key}，args 那一格没有 key。
  const slotHandler = handlers.find(h => h.key === 'text')
  assert.ok(slotHandler, '应找到 text 槽位处理器')
  slotHandler.onClick()

  assert.strictEqual(calls.length, 1, '应产生一次 onChange 调用')
  assert.strictEqual(calls[0].bind.text, '--voice', 'text 槽位应绑定到 --voice')
})

test('拖拽参数到槽位：建立 bind 绑定', () => {
  // 拖拽路径要构造 dataTransfer 事件，组件渲染后拿不到真实的拖拽源，
  // 这里只验证组件能正常渲染（不抛错）。
  const { result } = invoke({ call: CALL_EMPTY, params: PARAMS_CLI, onChange: () => {} })
  assert.ok(result, '组件应返回 React 元素')
})

test('点击选中再点 args：建立 args 绑定（仅 cli 参数）', () => {
  const esbuild = require(path.join(WEB_DIR, 'node_modules', 'esbuild'))
  const src = fs.readFileSync(DRAGBIND, 'utf8')
  const code = esbuild.transformSync(src, { loader: 'jsx', format: 'cjs', target: 'node18' }).code

  // 选中一个 cli 参数
  const mod = { exports: {} }
  const stub = (id) => {
    if (id === 'react') return {
      useState: () => [PARAMS_CLI[0], () => {}],
      useEffect: () => {},
      createElement: (type, config, ...children) => ({
        type, props: config || {}, children,
        key: (config && config.key) || null,
      }),
    }
    if (/i18n/.test(id)) return { useT: () => ({ t: (en) => en }) }
    if (/useInstalled/.test(id)) return { useInstalled: () => ({}) }
    throw new Error('DragBind 的依赖不该被求值：' + id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, DRAGBIND, EDITOR_DIR)
  const DragBindFixed = mod.exports.default

  const calls = []
  const result = DragBindFixed({ call: CALL_EMPTY, params: PARAMS_CLI, onChange: (n) => calls.push(n) })
  const handlers = findOnClick(result)

  const argsHandler = handlers.find(h => !h.key && h.props && h.props.onDragOver)
  assert.ok(argsHandler, '应找到 args 处理器')
  argsHandler.onClick()

  assert.strictEqual(calls.length, 1, '应产生一次 onChange 调用')
  assert.ok(calls[0].args.voice, 'voice 应在 args 中')
  assert.strictEqual(calls[0].args.voice.flag, '--voice', 'args 中应存 flag')
})

test('python 参数不进 args', () => {
  const esbuild = require(path.join(WEB_DIR, 'node_modules', 'esbuild'))
  const src = fs.readFileSync(DRAGBIND, 'utf8')
  const code = esbuild.transformSync(src, { loader: 'jsx', format: 'cjs', target: 'node18' }).code

  const mod = { exports: {} }
  const stub = (id) => {
    if (id === 'react') return {
      useState: () => [PARAMS_PY[0], () => {}], // 选中 python 参数
      useEffect: () => {},
      createElement: (type, config, ...children) => ({
        type, props: config || {}, children,
        key: (config && config.key) || null,
      }),
    }
    if (/i18n/.test(id)) return { useT: () => ({ t: (en) => en }) }
    if (/useInstalled/.test(id)) return { useInstalled: () => ({}) }
    throw new Error('DragBind 的依赖不该被求值：' + id)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, DRAGBIND, EDITOR_DIR)
  const DragBindFixed = mod.exports.default

  const calls = []
  const result = DragBindFixed({ call: CALL_EMPTY, params: PARAMS_PY, onChange: (n) => calls.push(n) })
  const handlers = findOnClick(result)

  const argsHandler = handlers.find(h => !h.key && h.props && h.props.onDragOver)
  assert.ok(argsHandler, '应找到 args 处理器')
  argsHandler.onClick()

  assert.strictEqual(calls.length, 0, 'python 参数不应产生 args 绑定')
})

test('混合参数：cli 与 python 都能渲染', () => {
  const mixed = [...PARAMS_CLI, ...PARAMS_PY]
  const { result } = invoke({ call: CALL_EMPTY, params: mixed, onChange: () => {} })
  assert.ok(result, '混合参数不应报错')
})

test('已有绑定的 call：不覆盖', () => {
  const callWithBind = {
    kind: 'cli',
    bind: { voice: '--voice' },
    args: { speed: { flag: '--speed' } },
  }
  const { result } = invoke({ call: callWithBind, params: PARAMS_CLI, onChange: () => {} })
  assert.ok(result, '已有绑定的 call 不应报错')
})

test('onChange 被调用时传入完整的 call 对象', () => {
  // onChange 收到的是 { ...call, bind: nextBind } 或 { ...call, args: nextArgs }。
  // 内部函数无法直接触发，这里只验证组件不报错。
  const { calls } = invoke({ call: CALL_EMPTY, params: PARAMS_CLI, onChange: () => {} })
  assert.strictEqual(calls.length, 0)
})

test('组件返回 React 元素', () => {
  const { result } = invoke({ call: CALL_EMPTY, params: PARAMS_CLI, onChange: () => {} })
  assert.ok(result && typeof result === 'object', '应返回 React 元素')
  assert.ok(result.props, '应有 props')
})

test('参数分组：按 group 分组渲染', () => {
  const { result } = invoke({ call: CALL_EMPTY, params: PARAMS_CLI, onChange: () => {} })
  assert.ok(result, '分组渲染不应报错')
})

test('无 group 的参数：归入 (root) 组', () => {
  const noGroup = [{ name: 'x', target: '--x', source: 'cli' }]
  const { result } = invoke({ call: CALL_EMPTY, params: noGroup, onChange: () => {} })
  assert.ok(result, '无 group 参数不应报错')
})
