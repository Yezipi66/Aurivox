// 清查 Python 文件的注释。
// 口径：Python 的注释用 tokenize 取（# 行与 docstring），不用正则猜。
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const MAIN = 'D:/Project/tts_broker_openai_compat'
const SKIP = new Set(['node_modules', '__pycache__', 'dist', '.git', '.venv', '.staging', 'venv', 'build', 'cache', 'engines', 'runtime', 'dev'])
const ROOTS = ['lib', 'tools', 'pipeline']

function walk (p, out) {
  let st
  try { st = fs.statSync(p) } catch (e) { return out }
  if (st.isFile()) {
    if (/\.py$/.test(p)) out.push(p)
    return out
  }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const f = path.join(p, e.name)
    if (e.isDirectory()) walk(f, out)
    else if (/\.py$/.test(f)) out.push(f)
  }
  return out
}

const done = new Set(execFileSync('git', ['diff', '--name-only', 'b8cf142..HEAD'],
  { cwd: MAIN, encoding: 'utf-8' }).trim().split('\n').map((x) => x.trim()))

const rows = []
for (const f of walk(MAIN, [])) {
  const rel = path.relative(MAIN, f).split(path.sep).join('/')
  if (done.has(rel)) continue
  const src = fs.readFileSync(f, 'utf-8')
  const lines = src.split('\n')
  // # 注释行
  let hashLines = 0
  for (const l of lines) {
    const t = l.trim()
    if (t.startsWith('#')) hashLines++
  }
  // docstring：AST 里的首条字符串常量
  let docLines = 0
  let docFound = false
  try {
    const py = execFileSync('python', ['-c', `
import ast, sys
src = open(sys.argv[1], encoding='utf-8').read()
tree = ast.parse(src)
out = []
for node in ast.walk(tree):
    if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        d = ast.get_docstring(node, clean=False)
        if d:
            out.append(len(d.splitlines()) + 1)
print(max(out) if out else 0)
`, f], { encoding: 'utf-8' }).trim()
    docLines = Number(py) || 0
    docFound = docLines > 0
  } catch (e) { /* python 不可用就只统计 # 注释 */ }

  const total = lines.filter((l) => l.trim() !== '').length
  rows.push({ rel, hash: hashLines, doc: docLines, total, com: hashLines + docLines })
}

rows.sort((a, b) => b.com - a.com)
const withCom = rows.filter((r) => r.com > 0)
console.log('未改的 Python 文件：' + rows.length + ' 个')
console.log('  有注释的：' + withCom.length + ' 个')
console.log('  完全没有注释的：' + (rows.length - withCom.length) + ' 个')
console.log('  注释行合计：' + withCom.reduce((s, r) => s + r.com, 0) + ' 行（# 注释 + docstring）')
console.log('\n有注释且 >= 5 行的：' + withCom.filter((r) => r.com >= 5).length + ' 个')
console.log('\n前 30 个：')
for (const r of withCom.slice(0, 30)) {
  console.log('  ' + String(r.com).padStart(3) + ' 行（# ' + r.hash + ' / doc ' + r.doc + '）  ' + r.rel)
}
if (process.argv[2]) {
  fs.writeFileSync(process.argv[2], withCom.map((r) => r.rel).join('\n') + '\n')
  console.log('\n清单已写：' + process.argv[2])
}
