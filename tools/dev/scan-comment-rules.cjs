// 按八条规则扫注释里的「历史叙事」，并区分生产代码与测试文件。
// 豁免：代码标识符（legacy_default 等）与技术术语（最初的根资产）。
//
// 「不写过期的测量值」那条不做机械判：规格常量（8 秒轮询、4GB 低显存、
// 3200ms 退避）与实测读数长得一样，区别在「有没有说为什么」⇒ 要人看。
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

const HISTORY = /第一版|原版|原来(?:是|的|那)|以前(?:是|的|那|后)|曾经|一度|上一版|早先|最初(?:是|的)|起初|后来改|已改成|改之前|改前|迁移前|搬家前|拆分前|之前那|旧(?:的)?实现/gi
const IDENTIFIER = /legacy_default|legacyDefault|legacy[A-Z_]|_legacy_|最初的根(?:资产|角色)|最初的根/g
const MEASURE = /[0-9]+(?:\.[0-9]+)?\s*(?:MB|GB|TB|KB)\b|[0-9]+\s*ms\b|[0-9]+\s*秒/gi
const FIXTURE = /占\s*[0-9]|有\s*[0-9]|装\s*[0-9]|剩\s*[0-9]|放\s*[0-9]|用\s*[0-9]|默认\s*[0-9]|最多\s*[0-9]|至少\s*[0-9]|不超\s*[0-9]|不超过\s*[0-9]|个引擎|台引擎|轮询|间隔|退避|超时|硬约束|低显存|防抖|预算|上限|下限|阈值|每\s*[0-9]|每轮/g

// 找出命中位置，但跳过被豁免词覆盖的那些。
function findHits (body, re, exemptRe) {
  const hits = []
  let m
  re.lastIndex = 0
  while ((m = re.exec(body)) !== null) {
    const start = m.index
    const end = start + m[0].length
    let exempt = false
    if (exemptRe) {
      exemptRe.lastIndex = 0
      let e
      while ((e = exemptRe.exec(body)) !== null) {
        if (e.index < end && e.index + e[0].length > start) { exempt = true; break }
        if (e.index > end) break
      }
    }
    if (!exempt) hits.push(m[0])
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return hits
}

const prod = []
const test = []

for (const f of files) {
  let src
  try { src = fs.readFileSync(f, 'utf8') } catch (e) { continue }
  let ast
  try { ast = parse(src, { sourceType: 'unambiguous', plugins: ['jsx'], tokens: true }) } catch (e) { continue }
  const rel = f.split(path.sep).join('/')
  const isTest = /\.test\.jsx?$/.test(rel) || /__testsupport__/.test(rel)
  for (const c of ast.comments || []) {
    const body = c.value || ''
    const h1 = findHits(body, HISTORY, IDENTIFIER)
    const h7 = []
    if (!h1.length && !h7.length) continue
    const row = [
      rel + ':' + c.loc.start.line,
      h1.length ? '历史[' + [...new Set(h1)].join(',') + ']' : '',
      h7.length ? '读数[' + [...new Set(h7)].join(',') + ']' : '',
      body.trim().replace(/\s+/g, ' ').slice(0, 100),
    ]
    ;(isTest ? test : prod).push(row)
  }
}

console.log('=== 生产代码（非测试文件）：' + prod.length + ' 处 ===')
for (const r of prod) console.log(r[0] + '\n    ' + r[1] + ' ' + r[2] + '\n    ' + r[3])
console.log('\n=== 测试文件：' + test.length + ' 处 ===')
for (const r of test) console.log(r[0] + '  ' + r[1] + ' ' + r[2] + '\n    ' + r[3])
