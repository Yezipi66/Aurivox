// 证明一批文件只改了注释：去掉注释后的 token 序列必须与改前逐个一致。
//
// 用法：
//   node tools/dev/verify-comment-only.cjs <baseRef> <file...>
//   node tools/dev/verify-comment-only.cjs HEAD~1 lib/engines/residency.js ...
//
// 判据来自 docs/COMMENT_GUIDELINE.md 末尾那一节：
//   JSX 里的 {/* */} 注释会产生花括号 token，删掉它会让比较报 DIFF，
//   所以 JSX 文件要人工确认那几处差异。
//
// 退出码：0 = 全部一致；1 = 有文件代码变了；2 = 用法错误或文件读不到。
const { parse } = require('@babel/parser')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')

// Babel 里注释 token 的 type 是字符串，代码 token 的 type 是带 label 的对象。
const isComment = (t) => typeof t.type === 'string'

function codeTokens (src) {
  const ast = parse(src, { sourceType: 'unambiguous', plugins: ['jsx'], tokens: true, errorRecovery: false })
  return ast.tokens
    .filter((t) => !isComment(t))
    .map((t) => (t.type.label || t.type) + ':' + JSON.stringify(t.value))
}

function readAt (ref, rel) {
  return execFileSync('git', ['show', ref + ':' + rel], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  })
}

function firstDiff (a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return {
        at: i,
        before: a[i],
        after: b[i],
      }
    }
  }
  return null
}

function main () {
  const args = process.argv.slice(2)
  if (args.length < 2) {
    console.error('用法：node tools/dev/verify-comment-only.cjs <baseRef> <file...>')
    process.exit(2)
  }
  const [baseRef, ...files] = args

  let bad = 0
  for (const rel of files) {
    let beforeSrc, afterSrc
    try {
      beforeSrc = readAt(baseRef, rel)
      afterSrc = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    } catch (e) {
      console.log('读不到 ' + rel + '：' + String(e.message).split('\n')[0])
      bad++
      continue
    }
    let a, b
    try {
      a = codeTokens(beforeSrc)
      b = codeTokens(afterSrc)
    } catch (e) {
      console.log(rel + '\t解析失败\t' + String(e.message).split('\n')[0])
      bad++
      continue
    }
    if (JSON.stringify(a) === JSON.stringify(b)) {
      console.log(rel + '\tsame\t只改了注释')
      continue
    }
    const d = firstDiff(a, b)
    // JSX 的 {/* */} 注释会留下花括号 token，这类差异要人工确认。
    const onlyBrace = d && (String(d.before).includes('}') || String(d.after).includes('{')
      || String(d.before).includes('{') || String(d.after).includes('}'))
    console.log(rel + '\tDIFF\t第 ' + d.at + ' 个 token 不同：'
      + String(d.before) + ' => ' + String(d.after)
      + (onlyBrace ? '（可能是 JSX 注释的花括号，需人工确认）' : ''))
    bad++
  }

  if (bad) {
    console.log('\n有 ' + bad + ' 个文件没能证明只改了注释')
    process.exit(1)
  }
  console.log('\n全部文件：去掉注释后的 token 序列逐个一致')
}

main()
