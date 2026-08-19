// Static guard: every call to normalizeAssignments() / buildLangOverrides()
// must pass the body of text the @N indices refer to.
//
// Why a static guard and not a runtime assertion: the third argument is
// optional at runtime on purpose, because refusing to work without it would
// turn a stale-override bug into a crash in front of the user. That makes
// forgetting it silent -- exactly the failure mode this whole fix is about
// (an override that is invisible in the picker yet still counted, previewed
// and sent to the engine). So the enforcement lives here, at check time.
//
// Usage:  node tools/guard_han_text_arg.cjs
// Exit 0 = every call site passes the text. Exit 1 = offending sites listed.

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SCAN_DIR = path.join(ROOT, 'web', 'src')
const GUARDED = ['normalizeAssignments', 'buildLangOverrides']
// Definition and re-export lines are not call sites.
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

// Split the argument list of a call that starts at `open` (index of "(").
// Returns null when the parentheses are unbalanced (truncated file etc).
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
