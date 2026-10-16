// 注释与文案纪律的全树体检。
// 口径：JS/JSX 用 @babel/parser 的 ast.comments，Python 用 tokenize 的 COMMENT token，
//       不用正则猜（正则分不清「注释里的符号」与「用户可见字符串里的符号」，
//       而基准一允许后者在产品位置保留符号）。
//
// 用法：node tools/dev/audit-comments.cjs [项目根] [输出文件]
//   例：  node tools/dev/audit-comments.cjs > tmp/comments.txt
//
// 排除 cache/（gitignored 本机归档）与 engines/（第三方引擎源码）。
// 注释纪律精确体检：只统计注释里的违规，区分开用户可见文案。
//
// 为什么不用正则：正则分不清「注释里的符号」与「用户可见字符串里的符号」。
// 按基准一，后者在产品符号位置是允许的（只改文字），只有注释里全禁。
// 所以必须用 AST 精确取注释：
//   JS/JSX  babel 的 ast.comments
//   Python  tokenize 的 COMMENT token + AST 的 docstring
const fs = require('node:fs')
const path = require('node:path')
const { parse } = require('@babel/parser')
const { execFileSync } = require('node:child_process')

const ROOT = process.argv[2] || process.cwd()
const OUT = process.argv[3] || 'tmp/audit_precise.txt'

// cache/ 整个被 .gitignore 忽略（.gitignore:56），是本机归档区，不是仓库代码。
// engines/ 下是本机安装的第三方引擎源码，不是我们的代码。
// 这两个目录不进清理范围，否则会把本机噪声算成项目债务。
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'venv', '.venv', 'dist', 'build',
  'pretrained', 'pretrained_models', 'uvr5_weights', 'models', 'ja_userdic',
  'tmp', 'attachments', 'cache', 'engines',
])

// ── 注释里的禁项（四类归属性内容 + 破折号 + 加粗）──────────────────
const COMMENT_BAN = [
  { name: '强调符号', re: /[⛔⭐✅⚠★🔥🚀🎉❌⬇]/g },
  { name: '日期体', re: /\b(19|20)\d{2}-\d{2}-\d{2}\b/g },
  { name: '归属叙述', re: /(Owner\s*裁决|Owner|裁决|拍板|真机|实测踩过|主\s*Agent|子\s*Agent|独立验收子\s*Agent)/g },
  { name: '中文破折号', re: /——/g },
  { name: 'markdown加粗', re: /\*\*[^*\n]+\*\*/g },
  { name: '变更历史标记', re: /(刀\s*[A-Z]\d|事\d|Patch\s*#\d+|r\d+c-batch\d+|Delegation\s+ID)/gi },
]

// ── 用户可见文案里的禁项（符号在产品位置允许，所以只查这些）─────────
const COPY_BAN = [
  { name: '中文破折号', re: /——/g },
  { name: '第二人称', re: /你/g },
  { name: '口语', re: /(干活|搞定|开跑|跑完|跑不了|试跑|跑一遍|多半|大概|反正|其实|几只|一堆)/g },
]

function walk (dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      if (e.name.startsWith('faster-whisper-')) continue
      walk(full, out)
    } else if (e.isFile()) {
      const ext = path.extname(e.name)
      if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py'].includes(ext)) out.push(full)
    }
  }
  return out
}

const files = walk(ROOT)
const rows = []
const stat = { comment: {}, copy: {} }
let commentFiles = new Set()

for (const f of files) {
  const ext = path.extname(f)
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  let src
  try { src = fs.readFileSync(f, 'utf8') } catch { continue }

  const lines = src.split('\n')
  // 标记哪些行是注释行（用于排除：JSX 文本里的符号不算注释违规）
  const commentLineNums = new Set()
  const commentTexts = []

  if (ext === '.py') {
    // 用 tokenize 精确取 COMMENT
    try {
      const py = `
import tokenize, io, sys, ast, json
src = open(sys.argv[1], encoding='utf-8').read()
out = []
try:
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type == tokenize.COMMENT:
            out.append([tok.start[0], tok.string])
except Exception as e:
    pass
# docstring 也算（它是模块/函数/类的说明文字）
try:
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            d = ast.get_docstring(node, clean=False)
            if d:
                out.append([node.body[0].lineno, '# ' + d.split(chr(10))[0]])
except Exception:
    pass
print(json.dumps(out, ensure_ascii=False))
`
      const r = execFileSync('python', ['-c', py, f], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      for (const [ln, text] of JSON.parse(r)) {
        commentLineNums.add(ln)
        commentTexts.push({ line: ln, text })
      }
    } catch { /* 解析不了就跳过该文件 */ }
  } else {
    let ast
    try {
      ast = parse(src, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: ['jsx', 'typescript', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport', 'topLevelAwait'],
      })
    } catch { continue }
    for (const c of (ast.comments || [])) {
      for (let ln = c.loc.start.line; ln <= c.loc.end.line; ln++) commentLineNums.add(ln)
      // 注释内容按行拆开，多行注释每行单独判
      const val = c.value || ''
      const start = c.loc.start.line
      val.split('\n').forEach((t, i) => commentTexts.push({ line: start + i, text: t }))
    }
  }

  for (const { line, text } of commentTexts) {
    for (const r of COMMENT_BAN) {
      r.re.lastIndex = 0
      const m = text.match(r.re)
      if (m) {
        stat.comment[r.name] = (stat.comment[r.name] || 0) + m.length
        commentFiles.add(rel)
        rows.push({ kind: '注释', rel, line, rule: r.name, hit: [...new Set(m)].join(' '), text: text.trim().slice(0, 90) })
      }
    }
  }

  // 文案违规：只查非注释行里的中文字符串与 JSX 文本
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1
    if (commentLineNums.has(ln)) continue
    const line = lines[i]
    // 粗筛：行内含中文或 emoji 才可能是用户可见文案
    if (!/[一-鿿]/.test(line) && !/[⛔⭐✅⚠★🔥🚀🎉❌⬇]/.test(line)) continue
    for (const r of COPY_BAN) {
      r.re.lastIndex = 0
      const m = line.match(r.re)
      if (m) {
        stat.copy[r.name] = (stat.copy[r.name] || 0) + m.length
        rows.push({ kind: '文案', rel, line, rule: r.name, hit: [...new Set(m)].join(' '), text: line.trim().slice(0, 90) })
      }
    }
  }
}

const out = []
out.push('扫描文件数: ' + files.length)
out.push('注释违规总数: ' + rows.filter((r) => r.kind === '注释').length)
out.push('涉及文件数(注释): ' + commentFiles.size)
out.push('注释违规按类目: ' + JSON.stringify(stat.comment))
out.push('文案违规总数: ' + rows.filter((r) => r.kind === '文案').length)
out.push('文案违规按类目: ' + JSON.stringify(stat.copy))
out.push('---- 明细 ----')
for (const r of rows) out.push(`${r.kind}\t${r.rel}:${r.line}\t[${r.rule}]\t${r.hit}\t${r.text}`)

fs.writeFileSync(OUT, out.join('\n'), 'utf8')
console.log(out.slice(0, 6).join('\n'))
