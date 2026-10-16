#!/usr/bin/env node
'use strict'
// 清理指定文件注释与字符串里的符号语气与破折号。
//
//  关键口径：
//   -  /  /   → 删除符号（保留文字）
//   -  /         → 保留（警告图标前缀 / 推荐标记），不许删
//   - ：            → 解释关系改冒号；行尾装饰改逗号；单 — 伴随中文改逗号
//
// 用 @babel/parser 精确定位注释与字符串字面量区间，只在这些区间内替换，
// 避免误伤代码（如变量名里的 dash、正则里的 —）。
//
// 用法：node scrub_tone_safe.cjs [--apply] <file> [...]
//       不带 --apply 时只打印将要改的行（dry-run）。

const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const files = argv.filter((a) => !a.startsWith('--'))
if (!files.length) { console.error('用法: node scrub_tone_safe.cjs [--apply] <file> [...]'); process.exit(2) }

const WEB = path.resolve(__dirname, '..', '..', 'web')
let parse
try {
  parse = require(require.resolve('@babel/parser', { paths: [WEB] })).parse
} catch (e) {
  console.error('拿不到 @babel/parser:', e.message); process.exit(2)
}

//  只删这三个；(26A0) (2605) 不在其中
const DEL_SYM = /[\u{26D4}\u{2B50}\u{2705}]\u{FE0F}?[ \t]?/gu
const DASH2 = /[ \t]*—{2,}[ \t]*/gu
const DASH1_CN = /(?<=[\u4e00-\u9fff])[ \t]*—[ \t]*(?=[\u4e00-\u9fff])/gu

function scrubText (text) {
  let s = text
  s = s.replace(DEL_SYM, '')
  // 行尾/孤立破折号 → 逗号；其余 → 冒号
  s = s.replace(/[ \t]*—{2,}[ \t]*(?=\n|$)/gu, '，')
  s = s.replace(DASH2, '：')
  s = s.replace(DASH1_CN, '，')
  return s
}

/** 收集注释区间 + 字符串字面量区间 */
function collectRanges (src) {
  const out = []
  let ast
  try {
    ast = parse(src, { sourceType: 'unambiguous', errorRecovery: false, plugins: ['jsx'] })
  } catch (e) {
    return null
  }
  for (const c of ast.comments || []) out.push([c.start, c.end, 'comment'])
  ;(function walk (node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const n of node) walk(n); return }
    if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') {
      if (typeof node.start === 'number' && typeof node.end === 'number') out.push([node.start, node.end, 'string'])
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue
      walk(node[k])
    }
  })(ast)
  // 从后往前，避免位移
  return out.sort((a, b) => b[0] - a[0])
}

let totalFiles = 0, totalChanges = 0
for (const f of files) {
  const p = path.resolve(f)
  if (!fs.existsSync(p)) { console.error('缺文件:', f); continue }
  const src = fs.readFileSync(p, 'utf8')
  const ranges = collectRanges(src)
  if (!ranges) { console.error('解析失败，跳过:', f); continue }

  let out = src
  let changed = 0
  for (const [s, e] of ranges) {
    const before = out.slice(s, e)
    const after = scrubText(before)
    if (after !== before) {
      out = out.slice(0, s) + after + out.slice(e)
      changed++
      if (!APPLY) {
        const line = src.slice(0, s).split('\n').length
        console.log(`${path.basename(f)}:${line}\n  - ${before.slice(0, 110).replace(/\n/g, '\\n')}\n  + ${after.slice(0, 110).replace(/\n/g, '\\n')}`)
      }
    }
  }
  if (changed) {
    totalFiles++
    totalChanges += changed
    if (APPLY) fs.writeFileSync(p, out)
    console.log(`${APPLY ? '已改' : '将改'} ${path.basename(f)}: ${changed} 处`)
  }
}
console.log(`\n合计: ${totalFiles} 文件 / ${totalChanges} 处${APPLY ? '（已写盘）' : '（dry-run，未写盘）'}`)
