// 验收一批注释重写：除了 token 比对，再查「注释内容是否真的变好」。
//
// token 比对只能证明「没动代码」，证明不了「注释合格」。
// 这份工具查机械可判的几条：
//   ① 文件头存在且不是空话（「这文件是干什么的」）
//   ② 装饰性分隔线横幅清零
//   ③ 中文双破折号清零
//   ④ markdown 加粗清零
//   ⑤ emoji/装饰符号清零
//   ⑥ 行号引用清零
//   ⑦ 日期体清零
//   ⑧ 纪律宣告句式（「本文件里不许…」）清零
//   ⑨ 口语动词（猜/算/跑完/指路/身份）清零
//
// 用法：node tools/dev/audit-comment-quality.cjs <文件...>
// 退出码 0 = 全过；1 = 有未清的
const { parse } = require('@babel/parser')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')

// ① 文件头：前 8 行内要有注释，且不能是空话
const VAGUE = /^(这|那)?(个|些)?(文件|模块|脚本|工具)$/

// ② 装饰横幅
// 尾部可能还带一个 //（形如「// ------ //」），两种都要认。
const RE_BANNER = /^\s*[-─═=]{8,}\s*(\/\/\s*)?(\/\/\s*)?$|^-{8,}\s*$/
// ③ 双破折号
const RE_DASH = /——/
// ④ 加粗
const RE_BOLD = /\*\*[^*\n]+\*\*/
// ⑤ emoji / 装饰符号
const RE_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u
// ⑥ 行号引用
const RE_LINENO = /[a-zA-Z_][a-zA-Z0-9_./-]*\.(js|jsx|py|cjs|mjs):[0-9]+|第\s*[0-9]+\s*[-–—]?\s*[0-9]*\s*行/
// ⑦ 日期体
const RE_DATE = /\b(19|20)\d{2}-\d{2}-\d{2}\b/
// ⑧ 纪律宣告：只抓「对文本本身的要求」那种。
//    「不许发成空串」「不许悄悄发一个没人读的键」这类是在描述代码的真实约束，
//    该留（Hark 的 rewrite-cuts.md 明确说了这个边界）。
//    ⇒ 只判主语指向「文件/代码/注释里出现什么」的那些。
// 只判「对文本本身的要求」：不许在文件/代码/注释里出现某个名字。
// 「不许少一行」「不许漏抽」这类是在描述守卫的判据准确性，不是纪律宣告。
const RE_DECREE = /(文件|代码|注释|活代码|源码|这一带|这里)[^。；\n]{0,10}(里|中|内)?[^。；\n]{0,8}(不许|不允许|不得|禁止|只许|严禁)[^。；\n]{0,12}(出现|写|写死|写上|加|引入|留|用)[^。；\n]{0,16}(引擎|引擎名|引擎 id|位名|权重位|键名|参数名|名字|具体)/
// ⑨ 口语动词
// 「猜」在「猜错」这类语境里是正当的技术说法（推断错），
// 只有「看着办」「不猜」这种才是口语。⇒ 挑出真正口语的组合。
const RE_COLLOQ = /(看着办|指路|跑完|栽过|一眼看出|扛下来)/

const RULES = [
  { name: '装饰横幅', re: RE_BANNER, kind: 'line' },
  { name: '中文双破折号', re: RE_DASH, kind: 'text' },
  { name: 'markdown加粗', re: RE_BOLD, kind: 'text' },
  { name: 'emoji符号', re: RE_EMOJI, kind: 'text' },
  { name: '行号引用', re: RE_LINENO, kind: 'text' },
  { name: '日期体', re: RE_DATE, kind: 'text' },
  { name: '纪律宣告', re: RE_DECREE, kind: 'text' },
  { name: '口语动词', re: RE_COLLOQ, kind: 'text' },
]

const isC = (t) => typeof t.type === 'string'

let bad = 0
for (const rel of process.argv.slice(2)) {
  const abs = path.join(ROOT, rel)
  let src
  try { src = fs.readFileSync(abs, 'utf-8') } catch (e) {
    console.log(`${rel}\t读不到`)
    bad++
    continue
  }
  // Python 文件：@babel/parser 不认，用 Python 侧的脚本查。
  if (rel.endsWith('.py')) {
    try {
      const out = execFileSync('python',
        [path.join(ROOT, 'tools/dev/audit-comment-quality-py.py'), rel],
        { cwd: ROOT, encoding: 'utf-8' })
      const line = out.trim().split('\n').pop() || ''
      if (line.includes('OK')) {
        console.log(`${rel}\tOK`)
      } else {
        bad++
        console.log(`${rel}\t${out.trim()}`)
      }
    } catch (e) {
      bad++
      console.log(`${rel}\t检查失败\t${String(e.stdout || e.message).slice(0, 200)}`)
    }
    continue
  }

  let ast
  try { ast = parse(src, { sourceType: 'unambiguous', plugins: ['jsx'], tokens: true }) } catch (e) {
    console.log(`${rel}\t解析失败\t${e}`)
    bad++
    continue
  }

  const hits = []
  const comments = ast.comments || []

  // ① 文件头：前 8 行里必须有注释
  const headHasComment = comments.some((c) => c.loc.start.line <= 8)
  if (!headHasComment) hits.push({ name: '缺文件头', line: 1, body: '' })
  // 文件头若是空话也要报
  const headComment = comments.find((c) => c.loc.start.line <= 8)
  if (headComment) {
    const first = String(headComment.value || '').trim().split('\n')[0].trim()
    if (first.length < 12 && !VAGUE.test(first)) {
      hits.push({ name: '文件头过短', line: headComment.loc.start.line, body: first })
    }
  }

  for (const c of comments) {
    const body = String(c.value || '')
    for (const line of body.split('\n')) {
      for (const r of RULES) {
        if (r.kind === 'line' && !r.re.test(line)) continue
        if (r.kind === 'text' && !r.re.test(body)) continue
        hits.push({ name: r.name, line: c.loc.start.line, body: line.trim().slice(0, 70) })
        break
      }
    }
  }

  if (hits.length) {
    bad++
    console.log(`${rel}\t${hits.length} 处未清`)
    for (const h of hits.slice(0, 8)) {
      console.log(`    ${h.line}  [${h.name}]  ${h.body}`)
    }
  } else {
    console.log(`${rel}\tOK`)
  }
}

console.log(bad ? `\n${bad} 个文件还有未清的地方` : '\n全部文件：机械可判的禁项清零')
process.exit(bad ? 1 : 0)
