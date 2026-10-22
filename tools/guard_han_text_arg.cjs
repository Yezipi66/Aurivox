// 静态守卫：normalizeAssignments() 与 buildLangOverrides() 的每个调用点都必须传入正文。
// 正文就是 @N 下标所指的那段文本。第三个参数在运行时是可选的：缺了它，覆盖项会被
// 计数、预览并发给引擎，而选择器里看不见，失败是静默的。运行时断言挡不住这种静默失效，
// 所以约束在这里检查。
//
// 用法：node tools/guard_han_text_arg.cjs
// 退出码 0 = 全部调用点都传了正文；1 = 列出不合规的调用点。

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SCAN_DIR = path.join(ROOT, 'web', 'src')
const GUARDED = ['normalizeAssignments', 'buildLangOverrides']
// 定义行与转出声明不是调用点。
const NOT_A_CALL = /^\s*(export\s+)?function\s/

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * 拆开从 open（左括号的下标）开始的参数列表。
 * 返回各参数（已去掉首尾空白）；括号不配对时返回 null。
 */
function topLevelArgs(src, open) {
  let depth = 0
  let start = open + 1
  const args = []
  let quote = null
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) {
        args.push(src.slice(start, i).trim())
        return args.filter(a => a.length > 0)
      }
      continue
    }
    if (ch === ',' && depth === 1) {
      args.push(src.slice(start, i).trim())
      start = i + 1
    }
  }
  return null
}

/**
 * 扫出全部不合规的调用点。
 * 每条是「相对路径:行号  说明」，空数组表示没有不合规的调用点。
 */
function scan(dir) {
  const problems = []
  for (const file of walk(dir || SCAN_DIR, [])) {
    const src = fs.readFileSync(file, 'utf8')
    for (const name of GUARDED) {
      const re = new RegExp(name + '\\s*\\(', 'g')
      let m
      while ((m = re.exec(src)) !== null) {
        const lineStart = src.lastIndexOf('\n', m.index) + 1
        const line = src.slice(lineStart, src.indexOf('\n', m.index))
        if (NOT_A_CALL.test(line)) continue
        const args = topLevelArgs(src, m.index + m[0].length - 1)
        const lineNo = src.slice(0, m.index).split('\n').length
        if (args === null) {
          problems.push(`${path.relative(ROOT, file)}:${lineNo}  ${name}(...) unparsable argument list`)
          continue
        }
        if (args.length < 3) {
          problems.push(
            `${path.relative(ROOT, file)}:${lineNo}  ${name}() called with ${args.length} arguments; ` +
            'the text the @N indices refer to must be passed as the third argument'
          )
        }
      }
    }
  }
  return problems
}

if (require.main === module) {
  const problems = scan()
  if (problems.length) {
    console.error('guard_han_text_arg: ' + problems.length + ' offending call site(s)')
    for (const p of problems) console.error('  ' + p)
    process.exit(1)
  }
  console.log('guard_han_text_arg: OK')
}

module.exports = { scan, topLevelArgs }
