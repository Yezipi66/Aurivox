//  前端未解析引用守卫：web/src 下每个 .jsx/.js 里被引用但既没 import 也没定义的
//  顶层标识符，一律算违规。
//
// 为什么需要它：
//   这两个 bug 都是「页面一打开就白屏」，而且 npm test 全绿、vite build 也绿：
//   - TrainingTab.jsx 用了 <Select> 却没 import（拆 TrainingTab 时丢的）
//   - GenerateTab.jsx 用了 useCallback 却没 import（拆 App.jsx 时丢的）
//   rollup 只把裸标识符原样留在 bundle 里，编译期不报错；运行到那一行才
//   ReferenceError。这种坏法人眼看不出来（谁也不会逐页点开每个下拉），
//   所以必须有一条逐个文件解析作用域的守卫盯着。
//
// 判据：单遍遍历同时做两件事：进函数体/块之前，先把该作用域的参数与声明
//   入栈（JS 的提升语义），再递归子节点；遇到引用就查这条栈。查不到、又不是
//   浏览器或 React 全局 ⇒ 报出来。`<Select` 这种 JSX 大写标识符也一并覆盖。
//
// 禁令：不许把这条测试改成「检查文件里有没有 import Select 这个词」。
//   它必须按作用域判：换任何一个别的名字漏 import，它也得红。
import { createRequire } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 扫描范围就是本目录（web/src）；仓库根在上两级。
const SRC = HERE
const ROOT = path.resolve(SRC, '..', '..')
const require = createRequire(import.meta.url)

// @babel/parser 装在 web/node_modules（前端 devDependency），要从那里解析。
// 解析不到就抛：跟注释守卫同源，宁可红也不许静默跳过。
let parse
try {
  parse = require(require.resolve('@babel/parser', {
    paths: [path.join(ROOT, 'web'), ROOT],
  })).parse
} catch (e) {
  throw new Error(`拿不到 @babel/parser，未解析引用守卫无法解析源码：${e.message}`)
}

// 浏览器 / 框架 / Node 全局：不来自 import 是正常的。
const GLOBALS = new Set([
  'React', 'useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useReducer',
  'useContext', 'useLayoutEffect', 'useId', 'useDeferredValue', 'useTransition',
  'useSyncExternalStore', 'useImperativeHandle', 'useDebugValue',
  'window', 'document', 'console', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'fetch', 'AbortController', 'AbortSignal', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileList', 'FileReader', 'FormData',
  'localStorage', 'sessionStorage', 'navigator', 'location', 'history', 'alert',
  'confirm', 'prompt', 'open', 'close', 'requestAnimationFrame', 'cancelAnimationFrame',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'Event', 'CustomEvent',
  'Audio', 'AudioContext', 'webkitAudioContext', 'Image', 'TextDecoder', 'TextEncoder',
  'Intl', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect', 'structuredClone',
  // 二进制与上下文对象：本仓库直接 new / 直接引用，不来自 import。
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Provider', 'Consumer',
  'process', 'require', 'module', 'exports', '__dirname', '__filename', 'globalThis',
  // 内建对象与静态函数：本仓库大量直接调用，不来自 import。
  'String', 'Number', 'Boolean', 'Object', 'Array', 'JSON', 'Math', 'Date', 'Map',
  'Set', 'Promise', 'Error', 'TypeError', 'RangeError', 'RegExp', 'Function',
  'BigInt', 'NaN', 'Infinity', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'escape', 'unescape', 'atob', 'btoa', 'queueMicrotask', 'performance',
  'crypto', 'Headers', 'Request', 'Response', 'ReadableStream', 'Worker',
  'WebSocket', 'XMLHttpRequest', 'DOMParser', 'Element', 'Node', 'HTMLElement',
  'getComputedStyle', 'matchMedia', 'scrollTo', 'scrollBy', 'print', 'focus', 'blur',
])

// JS 保留字与字面量：解析器不会把它们当引用，列在这里只为稳。
const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'of', 'in',
  'new', 'typeof', 'instanceof', 'delete', 'void', 'await', 'async', 'yield',
  'class', 'extends', 'this', 'super', 'try', 'catch', 'finally', 'throw',
  'switch', 'case', 'default', 'break', 'continue', 'while', 'do', 'import',
  'export', 'from', 'as', 'null', 'undefined', 'true', 'false', 'static', 'get', 'set',
])

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, out)
    else if (/\.(jsx?|mjs|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}

function bindingNames(node, out = []) {
  if (!node || typeof node !== 'object') return out
  switch (node.type) {
    case 'Identifier': out.push(node.name); return out
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') bindingNames(p.argument, out)
        else bindingNames(p.value, out)
      }
      return out
    case 'ArrayPattern':
      for (const e of node.elements) if (e) bindingNames(e, out)
      return out
    case 'AssignmentPattern': return bindingNames(node.left, out)
    case 'RestElement': return bindingNames(node.argument, out)
  }
  return out
}

/**
 * 返回该文件里「未解析的顶层引用」[{ name, line }]。
 * 单遍遍历：每个作用域先把参数与块内声明入栈（提升语义），再递归子节点；
 * 引用当场解析。
 */
function unresolvedIn(file) {
  const src = fs.readFileSync(file, 'utf8')
  let ast = null
  for (const opts of [
    { sourceType: 'unambiguous', plugins: ['jsx'] },
    { sourceType: 'module', plugins: ['jsx'] },
    { sourceType: 'script', plugins: ['jsx'] },
  ]) {
    try { ast = parse(src, opts); break } catch { ast = null }
  }
  if (!ast) return { parseError: true }

  const scopes = [new Set()]
  const bad = []
  const seen = new Set()

  const known = (name) => {
    if (GLOBALS.has(name) || KEYWORDS.has(name)) return true
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return true
    return false
  }
  const note = (name, node) => {
    const key = `${name}@${node.loc && node.loc.start.line}`
    if (seen.has(key)) return
    seen.add(key)
    bad.push({ name, line: node.loc && node.loc.start.line })
  }
  const declareAll = (names) => { for (const n of names) if (n) scopes[scopes.length - 1].add(n) }
  // 收集一个节点（VariableDeclarator id / 函数参数 / 解构）带来的绑定名。
  const collect = (node) => { const o = []; bindingNames(node, o); return o }

  // 把一个块/函数体里的全部顶层声明登记到一个新作用域（JS 提升语义：
  // 块内后声明的 const 在块开头就可见，所以先扫一遍再递归）。
  function predeclare(statements) {
    const scope = new Set()
    for (const st of statements || []) {
      switch (st.type) {
        case 'VariableDeclaration':
          for (const d of st.declarations) for (const n of collect(d.id)) scope.add(n)
          break
        case 'FunctionDeclaration':
          if (st.id) scope.add(st.id.name)
          break
        case 'ClassDeclaration':
          if (st.id) scope.add(st.id.name)
          break
        case 'ImportDeclaration':
          for (const s of st.specifiers) scope.add(s.local.name)
          break
      }
    }
    scopes.push(scope)
  }

  function visit(node, isMemberProp) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const n of node) visit(n, false); return }
    switch (node.type) {
      case 'Identifier':
        if (!isMemberProp && !known(node.name)) note(node.name, node)
        return
      case 'JSXIdentifier':
        if (/^[A-Z]/.test(node.name) && !known(node.name)) note(node.name, node)
        return
      case 'ExportNamedDeclaration':
        // `export { A, B }` 的 specifier 是本地名的再导出，不是引用；
        // `export const X = ...` 的 declaration 照常走。
        if (node.declaration) { visit(node.declaration, false); return }
        return
      case 'ExportDefaultDeclaration':
        if (node.declaration) { visit(node.declaration, false); return }
        return
      case 'ExportAllDeclaration':
        return
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visit(node.object, false)
        visit(node.property, true)
        return
      case 'ObjectProperty':
        // 键不当引用。简写属性（{ foo }）的 key 与 value 是同一个节点，
        // 由 value 位置负责解析；非简写只走 value。
        if (node.shorthand) { visit(node.value, false); return }
        visit(node.value, false)
        return
      case 'ObjectMethod':
      case 'ClassMethod':
      case 'ClassPrivateMethod':
        scopes.push(new Set())
        declareAll(node.params.flatMap(collect))
        visit(node.body, false)
        scopes.pop()
        return
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        scopes.push(new Set())
        declareAll(node.params.flatMap(collect))
        if (node.body && node.body.type === 'BlockStatement') predeclare(node.body.body)
        visit(node.body, false)
        scopes.pop()
        return
      case 'BlockStatement':
        predeclare(node.body)
        for (const st of node.body) visit(st, false)
        scopes.pop()
        return
      case 'CatchClause':
        scopes.push(new Set())
        if (node.param) declareAll(collect(node.param))
        visit(node.body, false)
        scopes.pop()
        return
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        // for 的 init/left 里的声明属于这个 for 自己的作用域。
        scopes.push(new Set())
        const decl = node.init || node.left
        if (decl && decl.type === 'VariableDeclaration') {
          declareAll(decl.declarations.flatMap(d => collect(d.id)))
        }
        visit(node.init, false)
        visit(node.left, false)
        visit(node.test, false)
        visit(node.update, false)
        visit(node.right, false)
        visit(node.body, false)
        scopes.pop()
        return
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k.endsWith('Comments')) continue
      const v = node[k]
      if (v && typeof v === 'object') visit(v, false)
    }
  }

  // 顶层 import / 声明先入 scopes[0]（程序级作用域）。
  // `export const X` / `export class Y` 的声明藏在 Export*Declaration 里，要解开。
  {
    const scope = new Set()
    const unwrap = (st) => (st && st.type && st.type.startsWith('Export') && st.declaration) ? st.declaration : st
    for (const raw of ast.program.body) {
      const st = unwrap(raw)
      switch (st.type) {
        case 'ImportDeclaration':
          for (const s of st.specifiers) scope.add(s.local.name)
          break
        case 'VariableDeclaration':
          for (const d of st.declarations) for (const n of collect(d.id)) scope.add(n)
          break
        case 'FunctionDeclaration':
          if (st.id) scope.add(st.id.name)
          break
        case 'ClassDeclaration':
          if (st.id) scope.add(st.id.name)
          break
      }
    }
    for (const n of scope) scopes[0].add(n)
  }

  for (const st of ast.program.body) visit(st, false)
  return { bad }
}

test('⛔ web/src 里不许有「用了却没 import / 没定义」的顶层标识符', () => {
  const files = walkFiles(SRC).filter(f => !/\.test\./.test(path.basename(f)))
  const all = []
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/')
    const r = unresolvedIn(f)
    if (r.parseError) { all.push(`${rel}: 解析失败`); continue }
    for (const b of r.bad) all.push(`${rel}:${b.line}  ${b.name}`)
  }
  assert.deepEqual(all, [],
    `\n有 ${all.length} 处未解析引用（页面打开就 ReferenceError，build 与 npm test 都不报）：\n  ${all.join('\n  ')}`)
})

test('守卫自身有效（扫到的文件数 > 0）', () => {
  const files = walkFiles(SRC)
  assert.ok(files.length > 30, `只扫到 ${files.length} 个文件，扫描范围写错了`)
})
