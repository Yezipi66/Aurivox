// 注释比例统计器：注释行数 ÷ 非空行数（跨行注释整段计入，单独的右括号行计入分母），
// 只统计本目录下的 js/jsx/cjs/mjs，跳过 .bak 与 node_modules。
const fs = require('node:fs')
const path = require('node:path')

const ROOTS = [__dirname]
const EXTS = new Set(['.js', '.jsx', '.cjs', '.mjs'])
const THRESHOLD = Number(process.argv[2] || 20)

function commentLines(lines) {
  let n = 0
  let inBlock = false
  for (const raw of lines) {
    const s = raw.trim()
    if (inBlock) { n++; if (s.includes('*/')) inBlock = false; continue }
    if (s.startsWith('//')) { n++; continue }
    if (s.startsWith('/*')) { n++; if (!s.includes('*/')) inBlock = true; continue }
    if (s.startsWith('*')) { n++ }
  }
  return n
}

const rows = []
for (const root of ROOTS) {
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue }
      if (!EXTS.has(path.extname(e.name)) || e.name.endsWith('.bak')) continue
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
      const nonblank = lines.filter((l) => l.trim()).length
      rows.push({
        file: path.relative(root, p).replace(/\\/g, '/'),
        nonblank,
        comments: commentLines(lines),
        ratio: nonblank ? Math.round((commentLines(lines) / nonblank) * 100) : 0,
      })
    }
  }
  walk(root)
}

rows.sort((a, b) => b.ratio - a.ratio)
const over = rows.filter((r) => r.ratio > THRESHOLD)
console.log(`files=${rows.length} over_${THRESHOLD}=${over.length}`)
for (const r of over) console.log(`${r.ratio}% ${r.file} (${r.comments}/${r.nonblank})`)

if (process.argv.includes('--all')) {
  console.log('--- all files ---')
  for (const r of rows) console.log(`${r.ratio}% ${r.file} (${r.comments}/${r.nonblank})`)
}
