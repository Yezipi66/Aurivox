'use strict'
// 向导前端的模块依赖不许成环。
//
// 为什么单独一条：Rollup 构建器对循环依赖是容忍的
// （它把环上的模块顺序排好，运行时也能跑），所以「构建成功」不等于没有环。
// 而环是真实的坑：环上两个组件互相 import 时，谁先被求值取决于打包顺序，
// 于是出现「有时候是 A 有时是 B」的偶发行为，改一处就换个地方坏。
//
// 第 4 步三栏改造就差点踩上：ParamDropZone 要渲染 ParamRow，
// ParamRow 又要从 ManifestForm 取字段规格 ⇒ 环。
// 当时拆成独立文件断开了，但「拆开就没事」是猜的，这里让它变成测出来的。
//
// 判据：解析 editor/ 目录里每个 JSX/JS 的相对 import，画出依赖图，找环。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')

/** editor/ 里参与依赖图的文件。 */
function sourceFiles () {
  return fs.readdirSync(EDITOR)
    .filter((f) => ['.jsx', '.js'].includes(path.extname(f)))
}

/** 把一个 import 说明符解析成 editor/ 里的真实文件名；解析不到就返回 null。 */
function resolveLocal (fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.normalize(path.join(EDITOR, spec))
  const candidates = [
    base,
    base + '.jsx',
    base + '.js',
    path.join(base, 'index.jsx'),
    path.join(base, 'index.js'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.basename(c)
  }
  return null
}

/** 画出依赖图：文件名 → 它 import 的本地文件名。 */
function buildGraph () {
  const graph = new Map()
  for (const f of sourceFiles()) {
    const src = fs.readFileSync(path.join(EDITOR, f), 'utf8')
    const deps = new Set()
    // 只抓行首的 import ... from '...'：动态 import 与 export ... from 不是环的来源。
    const re = /(?:^|\n)\s*import\s+(?:[\s\S]*?)\s*from\s+['"]([^'"]+)['"]/g
    let m
    while ((m = re.exec(src)) !== null) {
      const target = resolveLocal(f, m[1])
      if (target) deps.add(target)
    }
    graph.set(f, [...deps])
  }
  return graph
}

/** 找出所有环。每个环记成「A -> B -> A」。 */
function findCycles (graph) {
  const cycles = []
  const done = new Set()
  const visiting = new Set()
  const stack = []

  const dfs = (node) => {
    if (done.has(node)) return
    if (visiting.has(node)) {
      const at = stack.indexOf(node)
      if (at >= 0) cycles.push(stack.slice(at).concat(node))
      return
    }
    visiting.add(node)
    stack.push(node)
    for (const dep of graph.get(node) || []) dfs(dep)
    stack.pop()
    visiting.delete(node)
    done.add(node)
  }

  for (const f of graph.keys()) dfs(f)
  // 同一个环可能从不同起点被数到多次，按「环里的文件名集合」去重。
  const seen = new Set()
  return cycles.filter((c) => {
    const key = [...new Set(c)].sort().join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

test('向导前端模块依赖不许成环（构建成功不等于没有环）', () => {
  const cycles = findCycles(buildGraph())
  assert.deepStrictEqual(cycles, [],
    `\n向导前端有 ${cycles.length} 个循环依赖：\n  `
    + `${cycles.map((c) => c.join(' -> ')).join('\n  ')}\n`
    + '环上的两个组件互相 import 时，谁先被求值取决于打包顺序，'
    + '会出现「改一处就换个地方坏」的偶发行为。断开环：把公共部分提到第三个文件。')
})

test('环检测器本身能抓到环（判据来源自身要可信）', () => {
  // 造一个小图：a → b → a，以及 a → c（无环）
  const graph = new Map([
    ['a.js', ['b.js']],
    ['b.js', ['a.js']],
    ['c.js', []],
  ])
  const cycles = findCycles(graph)
  assert.equal(cycles.length, 1, '没抓到 a → b → a')
  assert.ok(cycles[0].includes('a.js') && cycles[0].includes('b.js'))
})
