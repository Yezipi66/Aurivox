#!/usr/bin/env node
'use strict'
// 清理 web/src 下**注释**里的符号语气（⛔/⭐/✅/⚠）与破折号（——）。
//
// 用 @babel/parser（项目 Vite 依赖的同一个）精确取出注释区间，只在这区间内替换。
// CSS 用 /* ... */ 块注释扫描。
//
// 规则：
//   1. 符号语气（含 U+FE0F 变体选择符）删除，并吞掉紧随其后的一个空格。
//   2. 破折号 —— 换成中文逗号「，」，并吞掉两侧紧邻的空格。
//
// 不碰：代码字符串里的产品 UI 符号（如 `⚠ 缺 2 项` 这种下拉标签）。
//
// 用法：node clean_marks.cjs            → dry-run
//       node clean_marks.cjs --apply    → 真正写盘
const fs = require('fs')
const path = require('path')

const APPLY = process.argv.includes('--apply')
const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'web', 'src')
const WEB = path.join(ROOT, 'web')

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.(jsx?|css)$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) && !/\.bak$/.test(e.name)) out.push(p)
  }
  return out
}

function scrub (text) {
  let s = text
  s = s.replace(/([\u{26D4}\u{2B50}\u{2705}\u{26A0}])\u{FE0F}?[ \t]?/gu, '')
  s = s.replace(/[ \t]*——[ \t]*/g, '，')
  return s
}

let parse = null
try {
  parse = require(require.resolve('@babel/parser', { paths: [WEB] })).parse
} catch (e) {
  console.error('拿不到 @babel/parser，无法安全处理 JS/JSX')
  process.exit(1)
}

function commentRangesJS (src) {
  const ast = parse(src, { sourceType: 'module', plugins: ['jsx'], errorRecovery: false })
  return (ast.comments || []).map((c) => [c.start, c.end])
}

function commentRangesCSS (src) {
  const out = []
  const re = /\/\*[\s\S]*?\*\//g
  let m
  while ((m = re.exec(src)) !== null) out.push([m.index, m.index + m[0].length])
  return out
}

function applyRanges (src, ranges) {
  let out = src
  let hits = 0
  for (const [s, e] of ranges.slice().sort((a, b) => b[0] - a[0])) {
    const before = out.slice(s, e)
    const after = scrub(before)
    if (after !== before) {
      hits += (before.match(/\n/g) || []).length + 1
      out = out.slice(0, s) + after + out.slice(e)
    }
  }
  return { out, hits }
}

const files = walk(SRC)
let changedFiles = 0, changedLines = 0
const report = []
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  let ranges
  try {
    ranges = f.endsWith('.css') ? commentRangesCSS(src) : commentRangesJS(src)
  } catch (e) {
    report.push(`SKIP ${path.relative(ROOT, f)}: ${e.message.split('\n')[0]}`)
    continue
  }
  const { out, hits } = applyRanges(src, ranges)
  if (hits > 0) {
    changedFiles++
    changedLines += hits
    report.push(`${path.relative(ROOT, f)}  ${hits} 行`)
    if (APPLY) fs.writeFileSync(f, out)
  }
}
console.log(report.join('\n'))
console.log(`\n${APPLY ? '已写盘' : 'dry-run'}: ${changedFiles} 个文件, ${changedLines} 行`)
