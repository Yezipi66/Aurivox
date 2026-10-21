// 扫全仓的注释占比，输出超标的文件清单。
// 用途：注释重写的批次划分依据。
// 用法：node tools/dev/comment-ratio.cjs [阈值，默认 25]
//
// 口径与 docs/COMMENT_GUIDELINE.md 第 8 条一致：
//   占比 = 注释行数 / 有效行数（代码行 + 注释行）
//   有效行按「有 token 的行」算，空行与只有大括号的行不算。
const { parse } = require('@babel/parser')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const THRESHOLD = Number(process.argv[2] || 25)
const SCAN_ROOTS = ['lib', 'web/src', 'tools']
const EXTRA_FILES = ['server.js']
// 排除：本机产物、第三方源码、助手产出物。
// 按「仓库根相对路径」判，不能按目录名：
//   按目录名判会把 lib/engines（自己的代码）也跳掉，
//   那正是注释最密的地方之一。
const SKIP_RELS = new Set([
  'cache', 'engines', 'dist', 'build', 'venv', '.venv', '.staging',
  'node_modules', '__pycache__', '.git', 'pretrained', 'models',
  'tools/dev', 'tools/runtime',
])
// 单层目录名：这些名字在任何层级都跳过。
const SKIP_NAMES = new Set(['node_modules', '__pycache__', 'dist', '.git', '.venv', '.staging', 'venv'])

// Babel 里注释 token 的 type 是字符串，代码 token 的 type 是带 label 的对象。
const isComment = (t) => typeof t.type === 'string'

function walk (p, out) {
  let st
  try { st = fs.statSync(p) } catch (e) { return out }
  if (st.isFile()) {
    if (/\.(js|jsx|cjs|mjs)$/.test(p)) out.push(p)
    return out
  }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (SKIP_NAMES.has(e.name)) continue
    const f = path.join(p, e.name)
    const rel = path.relative(ROOT, f).split(path.sep).join('/')
    // 一级目录（相对根）命中 SKIP_RELS 就整棵跳过。
    const top = rel.split('/')[0]
    if (SKIP_RELS.has(top)) continue
    if (e.isDirectory()) walk(f, out)
    else if (/\.(js|jsx|cjs|mjs)$/.test(e.name)) out.push(f)
  }
  return out
}

function ratioOf (src) {
  const ast = parse(src, { sourceType: 'unambiguous', plugins: ['jsx'], tokens: true })
  const code = new Set()
  const com = new Set()
  for (const t of ast.tokens) {
    if (isComment(t)) continue
    for (let l = t.loc.start.line; l <= t.loc.end.line; l++) code.add(l)
  }
  for (const c of ast.comments) {
    for (let l = c.loc.start.line; l <= c.loc.end.line; l++) com.add(l)
  }
  const total = code.size + com.size
  return { total, com: com.size, pct: total ? Math.round((com.size / total) * 100) : 0 }
}

const files = []
for (const r of SCAN_ROOTS) walk(path.join(ROOT, r), files)
for (const e of EXTRA_FILES) if (fs.existsSync(path.join(ROOT, e))) files.push(path.join(ROOT, e))

const rows = []
for (const f of files) {
  let src
  try { src = fs.readFileSync(f, 'utf8') } catch (e) { continue }
  let r
  try { r = ratioOf(src) } catch (e) { continue }
  if (!r.total) continue
  rows.push({ pct: r.pct, rel: path.relative(ROOT, f).split(path.sep).join('/'), total: r.total, com: r.com })
}

rows.sort((a, b) => b.pct - a.pct || a.rel.localeCompare(b.rel))
const over = rows.filter((r) => r.pct >= THRESHOLD)
console.log('占比 >= ' + THRESHOLD + '% 的文件，共 ' + over.length + ' 个（扫了 ' + rows.length + ' 个）')
for (const r of over) {
  console.log([r.pct, r.rel, r.total, r.com].join('\t'))
}
