#!/usr/bin/env node
'use strict'
// 注释里的口语词替换（口径见 docs/COPY_TONE_GUIDELINE.md）：
//   这台机器 → 本机
//   那台机器 → 该机 / 目标机器
//   其实   → （删）
//   跟着走 → 随…变化 / 取决于
//
// 只处理注释行（// /* * # 开头），不碰代码与字符串。
// 用法：node scrub_oral.js [--apply] <file> [...]

const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const files = argv.filter((a) => !a.startsWith('--'))
if (!files.length) { console.error('用法: node scrub_oral.js [--apply] <file> [...]'); process.exit(2) }

// 「这台机器」→ 本机；「那台机器」→「该机器」；「其实」→「」
const RULES = [
  [ /这台机器/g, '本机' ],
  [ /那台机器/g, '该机器' ],
  [ /跟着走/g, '随之变化' ],
  // 「其实」只在「其实」独立成词时删，保留「其实体」这类正常用法
  [ /其实(?!体)/g, '' ],
]

function isCommentLine (s) {
  const t = s.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')
}

let totalFiles = 0, totalChanges = 0
for (const f of files) {
  const p = path.resolve(f)
  if (!fs.existsSync(p)) continue
  const src = fs.readFileSync(p, 'utf8')
  const lines = src.split('\n')
  let changed = 0
  const next = lines.map((l) => {
    if (!isCommentLine(l)) return l
    let s = l
    for (const [re, rep] of RULES) s = s.replace(re, rep)
    if (s !== l) changed++
    return s
  })
  if (changed) {
    totalFiles++
    totalChanges += changed
    if (APPLY) fs.writeFileSync(p, next.join('\n'))
    console.log(`${APPLY ? '已改' : '将改'} ${path.basename(f)}: ${changed} 行`)
  }
}
console.log(`\n合计: ${totalFiles} 文件 / ${totalChanges} 行${APPLY ? '（已写盘）' : '（dry-run）'}`)
