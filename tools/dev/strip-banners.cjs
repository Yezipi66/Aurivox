// 删掉装饰性分隔线横幅，保留它包围的标题行。
// 判据：整行注释里 80% 以上是 ─ 或 = （或形如「--- //」的尾巴）⇒ 这一行是横幅。
// 不要求上下相邻行是注释：横幅常常正好包着标题，上下是空行或代码。
//
// 规范出处：docs/COMMENT_GUIDELINE.md「禁止出现在注释里」一节（装饰分隔线）。
//
// 安全：只删整行注释，不碰任何代码行。删完用 token 比对自证。
const { parse } = require('@babel/parser')
const fs = require('fs')
const path = require('path')

const ROOT = 'D:/Project/tts_broker_openai_compat'
const files = process.argv.slice(2)

function isBanner (line) {
  const t = line.trim()
  if (!t.startsWith('//')) return false
  const body = t.replace(/^\/\/+/, '').replace(/\/+\s*$/, '').trim()
  if (!body) return false
  const banner = body.replace(/[^─=-]/g, '')
  if (banner.length < 10) return false
  return banner.length / body.length >= 0.8
}

const isComment = (t) => typeof t.type === 'string'

function codeTokens (src) {
  const ast = parse(src, { sourceType: 'unambiguous', plugins: ['jsx'], tokens: true, errorRecovery: false })
  return ast.tokens.filter((t) => !isComment(t)).map((t) => (t.type.label || t.type) + ':' + JSON.stringify(t.value))
}

for (const rel of files) {
  const abs = path.join(ROOT, rel)
  const src = fs.readFileSync(abs, 'utf8')
  const lines = src.split('\n')
  const drop = new Set()
  for (let i = 0; i < lines.length; i++) {
    if (isBanner(lines[i])) drop.add(i)
  }
  if (!drop.size) {
    console.log(rel + '\t没有横幅行')
    continue
  }
  const kept = lines.filter((_, i) => !drop.has(i))
  // 横幅删掉后可能留下连续空行，压成一个
  const out = []
  for (const line of kept) {
    if (line.trim() === '' && out.length && out[out.length - 1].trim() === '') continue
    out.push(line)
  }
  const text = out.join('\n')
  const before = JSON.stringify(codeTokens(src))
  const after = JSON.stringify(codeTokens(text))
  if (before !== after) {
    console.log(rel + '\tDIFF\t删横幅时动到了代码，不落盘')
    continue
  }
  fs.writeFileSync(abs, text, 'utf8')
  console.log(rel + '\tsame\t删了 ' + drop.size + ' 行横幅')
}
