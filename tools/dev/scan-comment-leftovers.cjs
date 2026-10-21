// 扫注释里还剩哪些规范禁项。
// 口径与 tools/dev/audit-comments.cjs 一致：用 AST 取注释，不用正则猜注释边界。
const { parse } = require('@babel/parser')
const fs = require('fs')
const path = require('path')

const SKIP_NAMES = new Set(['node_modules', '__pycache__', 'dist', '.git', '.venv', '.staging', 'venv'])
const ROOTS = ['lib', 'web/src', 'tools']
const EXTRA = ['server.js']

function walk (p, out) {
  let st
  try { st = fs.statSync(p) } catch (e) { return out }
  if (st.isFile()) {
    if (/\.(js|jsx|cjs|mjs)$/.test(p)) out.push(p)
    return out
  }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (SKIP_NAMES.has(e.name)) continue
    if (e.name === 'dev' || e.name === 'runtime') continue
    const f = path.join(p, e.name)
    if (e.isDirectory()) walk(f, out)
    else if (/\.(js|jsx|cjs|mjs)$/.test(e.name)) out.push(f)
  }
  return out
}

const files = []
for (const r of ROOTS) walk(r, files)
for (const e of EXTRA) if (fs.existsSync(e)) files.push(e)

// 各类禁项。规范出处：docs/COMMENT_GUIDELINE.md
const RULES = [
  { name: '行号引用', re: /[a-zA-Z_][a-zA-Z0-9_./-]*\.(js|jsx|py|cjs|mjs):[0-9]+/ },
  { name: '行号引用', re: /第\s*[0-9]+\s*[-–—]?\s*[0-9]*\s*行/ },
  { name: '中文双破折号', re: /——/ },
  { name: 'markdown加粗', re: /\*\*[^*\n]+\*\*/ },
  { name: '日期体', re: /\b(19|20)\d{2}-\d{2}-\d{2}\b/ },
  { name: '装饰横幅', re: /^\s*[-─═=]{8,}\s*(\/\/\s*)?$/ },
  { name: '用户原话', re: /原话是|Owner (说|裁决|拍板)|用户反馈|使用者反馈/ },
  { name: '现场经过', re: /实测|试错|踩过|栽过|当场/ },
]

const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u

const counts = {}
const samples = {}
for (const f of files) {
  let src
  try { src = fs.readFileSync(f, 'utf8') } catch (e) { continue }
  let ast
  try { ast = parse(src, { sourceType: 'unambiguous', plugins: ['jsx'], tokens: true }) } catch (e) { continue }
  for (const c of ast.comments || []) {
    const body = c.value || ''
    const hits = []
    for (const r of RULES) {
      if (r.re.test(body)) hits.push(r.name)
    }
    if (emoji.test(body)) hits.push('emoji')
    if (!hits.length) continue
    for (const h of new Set(hits)) {
      counts[h] = (counts[h] || 0) + 1
      if (!samples[h]) samples[h] = []
      if (samples[h].length < 6) {
        samples[h].push(f.split(path.sep).join('/') + ':' + c.loc.start.line + '  ' + body.trim().slice(0, 78))
      }
    }
  }
}

console.log('扫了 ' + files.length + ' 个文件。注释里还剩的禁项：')
if (!Object.keys(counts).length) {
  console.log('  （零）')
} else {
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log('\n' + k + '：' + v + ' 处')
    for (const s of samples[k]) console.log('  ' + s)
  }
}
