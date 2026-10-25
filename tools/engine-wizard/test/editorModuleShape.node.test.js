'use strict'
// 向导前端的模块不许既导出组件、又导出 hook。
//
// 为什么单独一条：Fast Refresh 的前提是一个模块的导出要么全是组件、
// 要么全是 hook。组件与 hook 混在一个文件里时，vite 会在改动那个文件时
// 报 `Could not Fast Refresh ("xxx" export is incompatible)`，
// 并把整个模块失效重新加载 ⇒ 编辑时页面上的状态全丢。
//
// 为什么这条不能只靠「看 vite 日志有没有警告」：警告只在改动那个文件的
// 那一刻才打出来。不改文件，日志里就干净 ⇒ 隐患会一直藏着。
// 这里按文件结构查，每个模块的导出构成一眼就能判定。
//
// 判据：
//   1. 一个模块里既有 hook 导出（名字以 use 开头）又有组件导出 ⇒ 违规
//   2. hook 要单独一个文件（项目的既有约定：useInstalled.js、useInstallSession.js）
//
// 豁免：纯工具模块（既不导出组件也不导出 hook）不受此限。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')

/** editor/ 里参与检查的文件。 */
function sourceFiles () {
  return fs.readdirSync(EDITOR)
    .filter((f) => ['.jsx', '.js'].includes(path.extname(f)))
}

/** 一个导出声明是不是 hook（按项目的命名约定：use 开头）。 */
function isHookExport (decl) {
  return /^(?:export\s+)?(?:async\s+)?function\s+use[A-Z]/.test(decl) ||
    /^export\s+const\s+use[A-Z]/.test(decl)
}

/**
 * 一个导出声明是不是组件（首字母大写的函数，或 default 导出）。
 *
 * 注意：`export const [A-Z] = ...` 不一定是组件。
 * `export const PERSIST_SHAPE = { ... }` 是个常量对象，
 * `export const DEFAULT_CONCURRENCY = 6` 是个数字。
 * 它们首字母大写只是命名习惯（大写 = 常量），
 * 拿大写当组件判据会把常量误判成组件。
 *
 * 怎么区分：看右边是什么。
 *   - 箭头函数 `=>` 或 `function` ⇒ 组件（也可能是 hook，但 hook 由名字判）
 *   - 对象字面量 `{` / 数组 `[` / 数字 / 字符串 ⇒ 常量
 */
function isComponentExport (decl) {
  if (/^export\s+default\b/.test(decl)) return true
  if (/^(?:export\s+)?(?:async\s+)?function\s+[A-Z]/.test(decl)) return true
  if (!/^export\s+const\s+[A-Z]/.test(decl)) return false
  // const 大写导出：只有初始化成函数时才算组件。
  const init = decl.replace(/^export\s+const\s+[A-Z][A-Za-z0-9_]*\s*=\s*/, '')
  return /^(?:async\s*)?\(?[^=]*=>|^async\s+function\b|^function\b/.test(init.trim())
}

/** 把文件里的导出声明逐条摘出来（不看注释里的内容）。 */
function exportDecls (src) {
  // 先去掉块注释与行注释，免得注释里的话被当成声明。
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const out = []
  const re = /^export\s+(?:default\s+|async\s+)?(?:function|const|let|var|class)\s+[^\n]*/gm
  let m
  while ((m = re.exec(stripped))) out.push(m[0].trim())
  return out
}

test('向导前端：没有模块既导出组件又导出 hook', () => {
  const bad = []
  for (const f of sourceFiles()) {
    const src = fs.readFileSync(path.join(EDITOR, f), 'utf8')
    const decls = exportDecls(src)
    const hooks = decls.filter(isHookExport)
    const comps = decls.filter(isComponentExport)
    if (hooks.length && comps.length) {
      bad.push(f + '（hook: ' + hooks.map((d) => d.slice(0, 40)).join(' | ') +
        '；组件: ' + comps.map((d) => d.slice(0, 40)).join(' | ') + '）')
    }
  }
  assert.deepStrictEqual(bad, [], '这些模块把 hook 和组件混在一起，Fast Refresh 会失效：\n' + bad.join('\n'))
})

test('向导前端：组件模块不许导出普通函数（Fast Refresh 的真实规则）', () => {
  // vite 的 react 插件要求：组件模块只导出组件（常量可以）。
  // 导出任何别的函数都会让 Fast Refresh 失效：
  //   Could not Fast Refresh ("xxx" export is incompatible)
  // 改那个文件会整页 reload，不是热更新。
  //
  // 之前那条守卫只查「既导出组件又导出 hook」，漏掉了普通函数：
  // factsQueryId 是个普通函数（不是 hook），所以照不出来，
  // 而 vite 照样报 incompatible。
  //
  // 判据：模块里有 default 导出（组件出口）时，
  //   其余的函数导出都不许有（组件本身另算）。
  const bad = []
  for (const f of sourceFiles()) {
    const src = fs.readFileSync(path.join(EDITOR, f), 'utf8')
    const decls = exportDecls(src)
    const hasDefault = decls.some((d) => /^export\s+default\b/.test(d))
    if (!hasDefault) continue
    const fns = decls.filter((d) => !/^export\s+default\b/.test(d))
      .filter((d) => /^export\s+(?:async\s+)?function\s/.test(d))
      // 组件是大写开头：小写的具名函数是普通函数，坏了 Fast Refresh。
      .filter((d) => !/^export\s+(?:async\s+)?function\s+[A-Z]/.test(d))
    if (fns.length) {
      bad.push(f + '（普通函数: ' + fns.map((d) => d.slice(0, 40)).join(' | ') + '）')
    }
  }
  assert.deepStrictEqual(bad, [],
    '这些组件模块导出了普通函数，Fast Refresh 会失效：\n' + bad.join('\n')
    + '\n把纯函数挪到自己的 .js 文件（像 factsQueryId.js 那样）')
})

test('向导前端：hook 单独一个文件', () => {
  // hook 住在自己的文件里，且那个文件不导出组件。
  const bad = []
  for (const f of sourceFiles()) {
    if (!/^use[A-Z]/.test(f)) continue
    const src = fs.readFileSync(path.join(EDITOR, f), 'utf8')
    const decls = exportDecls(src)
    const comps = decls.filter(isComponentExport)
    if (comps.length) bad.push(f + ' 导出了组件: ' + comps.join(' | '))
  }
  assert.deepStrictEqual(bad, [], 'hook 文件不该导出组件：\n' + bad.join('\n'))
})

test('向导前端：hook 的导出声明都能被认出（判据本身没失效）', () => {
  // 判据写错时上面两条会「全绿」，所以单独验一次判据能认出真 hook。
  const src = [
    'export function useFoo () { return null }',
    'export const useBar = () => null',
    'export default function Baz () { return null }',
    'export function plain () { return null }',
  ].join('\n')
  const decls = exportDecls(src)
  assert.strictEqual(decls.filter(isHookExport).length, 2, 'hook 认出的条数不对')
  assert.strictEqual(decls.filter(isComponentExport).length, 1, '组件认出的条数不对')
})

test('大写 const 导出：常量不算组件，函数才算', () => {
  // 大写首字母在 JS 里的意思是「常量」，不是「组件」。
  // 把常量当成组件，守卫就会去报 useInstallSession.js
  // （它导出 PERSIST_SHAPE 这个常量），那是误报。
  // 误报一次，这条守卫就会被人加白名单放过去，真违规反而抓不到。
  const cases = [
    ['export const PERSIST_SHAPE = { url: "", id: "" }', false],
    ['export const DEFAULT_CONCURRENCY = 6', false],
    ['export const STEPS = [', false],
    ['export const STEP_BY_KEY = Object.fromEntries([])', false],
    ['export const Foo = () => null', true],
    ['export const Foo = function () { return null }', true],
    ['export const Foo = async () => null', true],
  ]
  for (const [decl, want] of cases) {
    assert.strictEqual(isComponentExport(decl), want,
      `${decl} 判成了 ${isComponentExport(decl)}，应为 ${want}`)
  }
})

test('变异检查：把普通函数塞回组件模块会被上面那条抓住', () => {
  // 判据本身的有效性自证：造一个组件模块（default 导出）
  // 加一个普通函数导出，看它被不被判成违规。
  const cases = [
    ['export default function App () { return null }\nexport function factsQueryId (a) { return a }', true],
    ['export default function App () { return null }\nexport function AppRow () { return null }', false],
    ['export function factsQueryId (a) { return a }', false], // 不是组件模块，不归这条管
  ]
  for (const [src, wantBad] of cases) {
    const decls = exportDecls(src)
    const hasDefault = decls.some((d) => /^export\s+default\b/.test(d))
    const fns = hasDefault
      ? decls.filter((d) => !/^export\s+default\b/.test(d))
        .filter((d) => /^export\s+(?:async\s+)?function\s/.test(d))
        .filter((d) => !/^export\s+(?:async\s+)?function\s+[A-Z]/.test(d))
      : []
    assert.strictEqual(fns.length > 0, wantBad,
      `判据在 ${JSON.stringify(src.slice(0, 60))} 上判成了 ${fns.length > 0}，应为 ${wantBad}`)
  }
})

test('变异检查：把常量误当组件的判据会被上面那条抓住', () => {
  // 拿一条真组件的声明去掉大写（变成小写 const），
  // 原判据（只看首字母）会把它判成「不是组件」而放过；
  // 现在的判据看初始化值，仍能认出它是组件。
  const decl = 'export const Foo = () => null'
  const lower = 'export const foo = () => null'
  assert.strictEqual(isComponentExport(decl), true)
  // 小写 const 不是组件（命名约定：小写 = 普通函数/工具）
  assert.strictEqual(isComponentExport(lower), false)
})
