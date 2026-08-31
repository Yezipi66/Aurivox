#!/usr/bin/env node
/**
 * ============================================================
 *  count_nails.cjs —— 「还差多少」这个数的**唯一**量法
 * ============================================================
 *
 * ⭐⭐⭐ 这个脚本存在的理由（2026-08-31，值得记住的一次翻车）：
 *
 *   `docs/ENGINE_CONTRACT.md §12.10` 第 0 步把「钉子数」称为
 *   **唯一的进度纵轴**，并写下基线「66 行 / 20 文件，真钉子 58」，
 *   量法给的是一行 grep：
 *
 *       grep -rn "gpt-sovits|gpt_sovits|9880|legacyDefault|legacy_default" lib/ server.js
 *
 *   ⛔ 这一行原样跑出来是 **355 行 / 77 文件** —— 和 66/20 差了五倍。
 *   我试了 10 种排除组合（只 .js / 加 .cjs / 加 .py / 加 json+yaml ×
 *   排不排测试 × 去不去注释），**没有一种能复现 66/20 或 58**。
 *
 *   ⇒ **结论：那三个数是量出来的，但量法没留下来，所以它不可复算。**
 *     一个不可复算的数字当"唯一的进度纵轴"，比没有纵轴更坏 ——
 *     它会让每一次重量都变成"我是不是数错了"的自我怀疑，
 *     而不是"这一刀拔掉了几根"的事实。
 *
 *   ⭐ **判据：凡是被称作"唯一真相"的数字，量法必须是仓库里一个能跑的东西，
 *     ⛔ 不是文档里一句话、⛔ 不是某次会话里的一条命令。**
 *
 * ⛔ 禁令：不许在文档里再写"跑这条 grep"。要报数就跑这个脚本，
 *   要改规则就改这个文件（并在 §12.10 记一行为什么）。
 *
 * 预言（可证伪）：如果不把量法钉死在这里，下一个接手的人（还是我）
 *   会再量出第三个对不上的数，然后花半小时怀疑自己改坏了代码。
 *
 * ------------------------------------------------------------
 *  规则（改这里 = 改纵轴的定义，必须同步 §12.10）
 * ------------------------------------------------------------
 *
 * 找什么：五个词。前两个是引擎 id 的两种写法，`9880` 是那个被抄进名片的
 *   端口号（§5.9 五），后两个是已经删掉的 `legacyDefault` 的残迹。
 *
 * 在哪找：`lib/` + `server.js` + `web/src/`。
 *   ⭐ `web/src/` 是 2026-08-31 新加进纵轴的：`docs/SCOPE_r12c.md §1` 的
 *     验收原文是「`lib\`、`server.js`、**`web\`** 一个字都不用改」——
 *     纵轴少一条腿，就会出现"lib 归零了但前端还写死着引擎名"的假完工。
 *
 * 不算什么，以及为什么（⛔ 每一条都要有理由，不许"看着不像"就排掉）：
 *   ① **测试文件**（`*.test.*` / `__testsupport__` / `*.integration.*`）——
 *      测试里出现引擎名是**对的**：守卫必须点名具体引擎才守得住。
 *      ⛔ 把它们算进钉子 ⇒ 纵轴永远归不了零，因为归零意味着删掉守卫。
 *   ② **纯注释行** —— 注释里提到 `gpt-sovits` 通常是在解释"这里为什么
 *      不该写死它"。⭐ 那是**反钉子**，算成钉子会鼓励人删掉解释。
 *   ③ **数据/配置文件**（`.json` / `.yaml` / `.example`）——
 *      `lib/training/model_paths.json`、`lib/inference/tts_infer.yaml` 是
 *      **GPT-SoVITS 这台引擎自己的东西**，它们里面出现自己的名字天经地义。
 *      ⚠ 它们该不该待在 `lib/` 下是**另一个问题**（归刀 A4），⛔ 不是这里的题目。
 *
 * 输出：两个数 —— `代码行`（真钉子）和 `含注释行`。⭐ 报数时报前者。
 */
const fs = require('fs')
const path = require('path')

const PATTERN = /gpt-sovits|gpt_sovits|9880|legacyDefault|legacy_default/
const CODE_EXTS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.py'])
const ROOTS = ['lib', 'web/src']
const EXTRA_FILES = ['server.js']

const isTest = (rel) =>
  /\.test\./.test(rel) || /\.integration\./.test(rel) || rel.includes('__testsupport__')

const isCommentLine = (line) => {
  const s = line.trim()
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*') || s.startsWith('#')
}

function walk(dir, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** @returns {{code:number, withComments:number, files:string[], hits:Array}} */
function countNails(repoRoot) {
  const targets = []
  for (const r of ROOTS) walk(path.join(repoRoot, r), targets)
  for (const f of EXTRA_FILES) targets.push(path.join(repoRoot, f))

  let code = 0, withComments = 0
  const files = new Set()
  const hits = []

  for (const p of targets) {
    const rel = path.relative(repoRoot, p).split(path.sep).join('/')
    if (!CODE_EXTS.has(path.extname(p))) continue
    if (isTest(rel)) continue
    let txt
    try { txt = fs.readFileSync(p, 'utf8') } catch { continue }
    if (!PATTERN.test(txt)) continue
    txt.split(/\r?\n/).forEach((line, i) => {
      if (!PATTERN.test(line)) return
      withComments++
      if (isCommentLine(line)) return
      code++
      files.add(rel)
      hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120) })
    })
  }
  return { code, withComments, files: [...files].sort(), hits }
}

module.exports = { countNails, PATTERN, ROOTS, EXTRA_FILES, CODE_EXTS, isTest, isCommentLine }

if (require.main === module) {
  const repoRoot = process.argv[2] || path.join(__dirname, '..')
  const r = countNails(path.resolve(repoRoot))
  console.log(`钉子（代码行，报这个数）: ${r.code} 行 / ${r.files.length} 文件`)
  console.log(`含注释行             : ${r.withComments} 行`)
  console.log('')
  for (const f of r.files) {
    const n = r.hits.filter(h => h.file === f).length
    console.log(`  ${String(n).padStart(3)}  ${f}`)
  }
  if (process.argv.includes('--verbose')) {
    console.log('')
    for (const h of r.hits) console.log(`${h.file}:${h.line}: ${h.text}`)
  }
}
