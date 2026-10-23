// 列出还没按注释规范改过的文件，按注释行数分批。
const { parse } = require('@babel/parser')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const MAIN = 'D:/Project/tts_broker_openai_compat'
const SKIP = new Set(['node_modules', '__pycache__', 'dist', '.git', '.venv', '.staging', 'venv', 'build', 'cache', 'engines', 'runtime', 'dev'])
const ROOTS = ['lib', 'web/src', 'tools', 'pipeline']

function walk (p, out, exts) {
  let st
  try { st = fs.statSync(p) } catch (e) { return out }
  if (st.isFile()) {
    if (exts.some((x) => x.test(p))) out.push(p)
    return out
  }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const f = path.join(p, e.name)
    if (e.isDirectory()) walk(f, out, exts)
    else if (exts.some((x) => x.test(f))) out.push(f)
  }
  return out
}

const done = new Set(execFileSync('git', ['diff', '--name-only', 'b8cf142..HEAD'],
  { cwd: MAIN, encoding: 'utf-8' }).trim().split('\n').map((x) => x.trim()))

const isC = (t) => typeof t.type === 'string'
const rest = []

for (const f of walk(MAIN, [], [/\.(js|jsx|cjs|mjs)$/])) {
  const rel = path.relative(MAIN, f).split(path.sep).join('/')
  if (done.has(rel)) continue
  let src
  try { src = fs.readFileSync(f, 'utf-8') } catch (e) { continue }
  let ast
  try { ast = parse(src, { sourceType: 'unambiguous', plugins: ['jsx'], tokens: true }) } catch (e) { continue }
  const com = new Set()
  for (const c of ast.comments || []) {
    for (let l = c.loc.start.line; l <= c.loc.end.line; l++) com.add(l)
  }
  if (com.size > 0) rest.push([com.size, rel])
}

rest.sort((a, b) => b[0] - a[0])

const CB = process.argv[2]
fs.mkdirSync(CB, { recursive: true })
for (const f of fs.readdirSync(CB)) fs.unlinkSync(path.join(CB, f))

const PER = 6
const batches = []
for (let i = 0; i < rest.length; i += PER) batches.push(rest.slice(i, i + PER))
batches.forEach((b, i) => {
  fs.writeFileSync(path.join(CB, 'batch' + (i + 1) + '.txt'), b.map((x) => x[1]).join('\n') + '\n')
})

console.log('JS 侧未改（且有注释）：' + rest.length + ' 个')
console.log('分成 ' + batches.length + ' 批（每批 ' + PER + ' 个）')
for (let i = 0; i < Math.min(3, batches.length); i++) {
  console.log('  batch' + (i + 1) + ': ' + batches[i].map((x) => x[0] + '行 ' + x[1]).join(', '))
}
