// 生成「按规范重写注释」的任务书。
//
// 用法：
//   node tools/dev/make-tasks.cjs <输出目录> <模式> [清单文件...]
//
// 模式：
//   rewrite ⇒ 按「注释量」重写：文件清单 + 判据 + 六件事
//   clean   ⇒ 清「验收器报出的未清项」：文件清单 + 具体线索 + 两道闸
//
// 这个脚本存在的原因（本项目踩过三次坑）：
//   ① 拿「已生成好的任务书」当模板用 ⇒ 里面的 {FILES} 占位符早被替换掉，
//      替换不生效 ⇒ 任务书里没有文件清单 ⇒ 子 Agent 跑偏改了别的文件。
//   ② 「按注释量」与「验收器报问题」两个集合有交集 ⇒ 同一批文件被派两遍。
//   ③ 文件清单与「具体线索」段可能对不上（换了底但没换线索）。
//
// ⇒ 下面每次生成后都自检：清单与线索必须一致、清单必须非空、文件必须存在。
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const OUT = process.argv[2]
const MODE = process.argv[3] || 'rewrite'

const SKILL = 'C:/Users/User/AppData/Local/hermes/profiles/aurivox/skills/software-development/comment-only-rewrite/SKILL.md'

const REWRITE_BODY = `## 你的任务

把下面这些文件的注释按规范重写。**只改注释，代码一个字都不能动。**

## 要改的文件（只改这些，别的一律不碰）

{FILES}

## 判据：四样东西，全部读完再动手

### ① 规范文档

{WT}/docs/COMMENT_GUIDELINE.md

八条规则 + 改前改后示例。**这是内容判据。**

### ② 五个示范文件（这就是目标样子）

- {WT}/lib/engines/residency.js
- {WT}/lib/engines/launchPlan.js
- {WT}/web/src/lib/modelPickers.pure.js
- {WT}/web/src/lib/engines.js
- {WT}/lib/inference/alias_fold.py   ← 第五个：Python 侧的示范

**它们定形态**：文件头几行、函数注释几行、哪些该留哪些该删。

 只看结果看不到刀法。**看示范的同时看它的 diff**：

\`\`\`bash
cd {WT}
git show b8cf142~1:lib/engines/residency.js > /tmp/before.js
diff /tmp/before.js lib/engines/residency.js | head -120
git show 2b269a6~1:lib/inference/alias_fold.py > /tmp/af_before.py
diff /tmp/af_before.py lib/inference/alias_fold.py
\`\`\`

逐段问自己「这一刀砍的是什么」。

### ③ 一份真实的反面评价（重点）

下面是别人读完我们代码后的评价，原文。**它骂的每一条都是你要避免的。**

\`\`\`
这份代码的注释就是典型的反面教材，你看不懂是正常的，因为它根本就没做到注释最基本的职责：让人看懂。

1. 文件头就是灾难，第一行就把人劝退

   // 合成页与对比页共用的纯函数：参考音频时长、语种、配方命名与路径归一。

   这是文件头？这叫甩了一堆名词的垃圾桶。
   语法都不通顺：参考音频时长、语种、配方命名与路径归一 — 前面三个是名词，最后一个「归一」是动词缩写，病句。
   职责不清：这个文件叫 format.jsx，里面装的是时长校验、语种检测、错误拼装、徽章组件、文件名截取、配方校验… 这叫 format？这叫 utils 垃圾场。
   没有规范的文件头：正经前端的文件头至少要说明「是什么、给谁用、导出什么」。

2. 全篇都是口水话、小学生作文，没有一句是技术文档

   // 从文本猜语种。汉字数多于拉丁字母时按字符集细分，否则算英文。
   「猜」「算」，你是算命吗？技术文档用「检测」「识别」「推断」。

   // 给 /api/outputs/* 的调用拼一条能指路的错误。
   「能指路的错误」是什么黑话？

   // 布尔型后端检查的结果徽章（如 /api/voices/:id/validate）
   主语呢？谓语呢？应该是「渲染后端布尔检查结果的状态徽章」。

   // 参考路径的身份。托管的参考音频按认定...
   「身份」是什么？专业术语叫「唯一标识」。

   所有注释的通病：把实现过程的碎碎念当注释写，而不是写意图和契约。
   注释里还在写「404 几乎总是因为后端跑的是旧构建」，这是你的 git commit message，不是给下一个接盘的人看的文档。

3. 关于「它由作者自己起」

   「起」是胡同口大妈说的。技术语境里的动词是「命名」「定义」「指定」「自定义」「创建」。
   「起」语义模糊：起名？起草？发起？技术写作第一原则就是消除歧义。

4. 不负责：没有参数说明、没有返回值，纯函数却不写纯函数的契约。
   pickDefaultRef(segs) 的 segs 是什么结构？看了注释你知道吗？你不知道。
\`\`\`

**「让人看懂」是唯一标准。**

### ④ 本项目的经验

- {SKILL}
- 同目录 references/comment-quality-review.md（**八条质量标准**）
- 同目录 references/rewrite-cuts.md（**五刀**）

## 要做的六件事

### ① 文件头：让人读完就知道这文件干什么

写清三件：**这文件负责什么、它凭什么这么判断、边界在哪**。2 至 5 行。

 不要写成纪律宣告（「这里不许出现任何引擎名」⇒ 改成「不写具体引擎名」）。

### ② 句子要通顺、完整、用书面语

名词堆末尾挂动词缩写是病句；主谓宾要齐；猜→推断、算→判定、起→定义、
指路→带诊断信息、身份→唯一标识。

### ③ 删掉「实现过程的碎碎念」

commit message（「404 几乎总是因为后端跑的是旧构建」）、历史叙事、
实测读数、假想场景（「一台 2 秒起来的引擎」）——全删。

### ④ 补上契约

每个导出的纯函数都要能回答：**参数是什么形状、返回什么、边界行为是什么**。

\`\`\`js
// 选出默认参考音频。segs 是候选参考的数组，每项有 exists / audio / audio_path /
// audio_filename / duration 字段。取第一条时长合规的；没有则取第一条存在的；都没有返回 null。
const pickDefaultRef = (segs) => {
\`\`\`

### ⑤ 删掉与代码重复的注释

函数名已经说清楚的事就别写。
但**「改错会静默出错」的地方一定要留**——那是代码表达不出来的。

### ⑥ 逐条核对注释与代码的事实

 **注释说的与代码做的相反时，代码赢。**

 **注释里的死链要清。** 注释引用的文件/函数可能早就不存在了，
先 \`find . -name "<名字>" -not -path "*/node_modules/*"\` 核实，
再用 \`git log --all --oneline --diff-filter=A -- "*<名字>*"\` 查历史。
死链改成描述当前行为。

## 硬约束

1. **只改注释，代码一个字都不能动。**
   改完必须自证：

   \`\`\`bash
   node tools/dev/verify-comment-only.cjs HEAD {FILESLINE}
   \`\`\`

   每个文件都必须报 \`same\`。报 \`DIFF\` 说明你动了代码，必须改回去。

    token 比对**不保证空白没变**。改完再跑一次 \`git diff\` 逐行看，
   确认非注释行没被动过。

2. **不要 commit、不要 push、不要建分支，不要改别的文件。**
3. **不要改代码逻辑**——发现文件本身的问题（上帝文件、文件名与内容不符、
   注释挂错常量）**只报告出来**。
4. **测试标题与断言字符串是 token**，别碰。
5. **保留真正值得留的注释**：改错会静默出错的地方，
   两个看似等价写法之间的取舍，和别的文件必须一致的约定。
6. 注释里不许出现：用户原话、现场经过、日期、行号引用、中文双破折号、
   emoji、markdown 加粗、装饰性分隔线横幅。

## 环境

- Windows 机器，shell 是 git-bash。原生工具（node、git、python）不认 MSYS 路径。
- **先 cd 到任务书指定的工作目录，之后每条命令都在那个目录下跑。**
- git 报「stdin is not a tty」是 pager 的事，加 \`--no-pager\` 或 \`GIT_PAGER=cat\`。
- worktree 里没有 venv，且 run_tests.cjs 是旧版（非交互时静默跑 0 条测试）。
  ⇒ 判改动好坏看 token 比对。全量测试由主会话在主工作区跑。

## 报告

用中文报告：
1. 每个文件改前的注释行数 → 改后的
2. \`verify-comment-only.cjs\` 的完整输出（必须全是 same）
3. \`git diff\` 里非注释行有没有被动过（应该没有）
4. **逐句列出你改的注释：原来是什么 → 改后是什么 → 属于哪一类问题**
5. **逐条列出你保留的注释与原因**（为什么改错了会静默出错）
6. 你发现的文件本身的问题（不改，只报）
`

const CLEAN_BODY = `## 你的任务

下面这些文件的注释，验收器报出了还没清干净的地方。**逐个清掉。**

## 要改的文件（只改这些，别的一律不碰）

{FILES}

## 验收器报出的具体线索

{DETAIL}

## 怎么开始

先 cd 到工作目录，逐个文件读原文、按上面每条线索改。改完跑这两道闸：

\`\`\`bash
node tools/dev/verify-comment-only.cjs HEAD {FILESLINE}     # 必须全报 same
node tools/dev/audit-comment-quality.cjs {FILESLINE}       # 必须全报 OK
\`\`\`

第二道是本项目新加的验收器，它查的就是上面那几类。改到它报「全部文件：机械可判的禁项清零」为止。

## 四类未清项各怎么改

### ① 纪律宣告（「本文件里不许出现任何引擎名」）

这是给未来修改者的**禁令**，不是「这个文件现在做什么」。
Hark 的示范文件把这类改成了正面说法。

  改前：本文件里不许出现任何引擎名、任何下载器名：命令是名片写的，平台只填占位符。
  改后：命令是名片写的，平台只填占位符；本文件不写具体引擎名与下载器名。

 **但不是所有「不许」都要改。** 判据（skill 的 references/rewrite-cuts.md）：

- 句子描述的是**代码里真实存在的一次取舍** ⇒ 保留（例：「不许发成空串：空串会被滤掉」）
- 句子是**给未来人的行为规范** ⇒ 改成事实陈述（例：「本文件里不许出现引擎名」）

### ② 缺文件头

前 8 行内没有注释。补一个 2 至 5 行的文件头，写清三件：
**这文件负责什么、它凭什么这么判断、边界在哪**。

### ③ 文件头过短

第一行太短，撑不起「这文件干什么」。同样按「做什么/凭什么/边界」写全。

### ④ 口语动词（看着办 / 指路 / 跑完 / 栽过 / 一眼看出 / 扛下来）

换成书面语：看着办 → 按规则处理；指路 → 带诊断信息；跑完 → 执行完；
一眼看出 → 看得出来；扛下来 → 承担。

 「猜」在「猜错」这种语境里是正当的技术说法（推断错），**不要改**。

## 硬约束

1. **只改注释，代码一个字都不能动。**
   第一道闸必须全报 \`same\`。
   token 比对不保证空白没变，改完再跑一次 \`git diff\` 逐行看，
   确认非注释行没被动过。
2. **不要 commit、不要 push、不要建分支，不要改别的文件。**
3. **不要顺手重写注释。** 这一轮只清上面那几类，其余保持原样。
4. **测试标题与断言字符串是 token**，别碰。
5. **保留真正值得留的注释**：改错会静默出错的地方，
   两个看似等价写法之间的取舍，和别的文件必须一致的约定。

## 环境

- Windows 机器，shell 是 git-bash。原生工具不认 MSYS 路径。
- **先 cd 到任务书指定的工作目录，之后每条命令都在那个目录下跑。**
- git 报「stdin is not a tty」加 \`--no-pager\`。
- worktree 里没 venv ⇒ 判改动好坏看 token 比对。

## 报告

用中文报告：
1. 每个文件清了几处、清前是什么、清后是什么
2. 两道闸的完整输出（verify 全 same、audit 全 OK）
3. 拿不准因而保留的（说明为什么）
4. 遇到的意外
`

// ---- 取线索（验收器报出的） ----
function auditDetails (files) {
  // 验收器发现未清项时退出码是 1（那是正常结果，不是错误）⇒ 不能让它把生成器带崩。
  let out = ''
  try {
    // env 里关掉 git pager：非交互环境下 git 启 pager 会失败并报
    // 「stdin is not a tty」，把整个生成器带崩。
    out = execFileSync('node', [path.join(ROOT, 'tools/dev/audit-comment-quality.cjs'), ...files],
      { cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' } })
  } catch (e) {
    out = e.stdout || ''
  }
  const rows = []
  let cur = null
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\t(\d+) 处未清$/)
    if (m) { cur = { file: m[1], n: Number(m[2]), lines: [] }; rows.push(cur); continue }
    if (cur && line.startsWith('    ')) cur.lines.push(line.trim())
  }
  return rows
}

function buildDetails (rows) {
  const parts = []
  for (const r of rows) {
    parts.push(`== ${r.file}（${r.n} 处）`)
    for (const l of r.lines) parts.push('   ' + l)
  }
  return parts.join('\n')
}

// ---- 自检 ----
function selfCheck (files, rows, tag) {
  const errs = []
  if (!files.length) errs.push('文件清单是空的')
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) errs.push('文件不存在：' + f)
  }
  if (rows) {
    const a = new Set(files)
    const b = new Set(rows.map((r) => r.file))
    // 线索是清单的子集：有些文件可能已被别的批次改好了，验收器不再报它。
    for (const f of b) if (!a.has(f)) errs.push('线索里有清单外的文件：' + f)
    // 清单里有、但验收器不报的文件：说明它已经合格（别的批次改过），
    // 从这一批里去掉，别让子 Agent 在已合格的文件上重复劳动。
    const noClue = files.filter((f) => !b.has(f))
    if (noClue.length) {
      console.log('  · 这几个已合格，从本批去掉：' + noClue.join(', '))
      for (const f of noClue) files.splice(files.indexOf(f), 1)
    }
  }
  if (errs.length) {
    console.error(`✗ ${tag} 自检没过：`)
    for (const e of errs) console.error('   ' + e)
    process.exit(1)
  }
  console.log(`✓ ${tag} 自检过：${files.length} 个文件`)
}

// ---- 主流程 ----
fs.mkdirSync(OUT, { recursive: true })
for (const f of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, f))

const inputs = process.argv.slice(4)
const allFiles = []
for (const inp of inputs) {
  const p = path.isAbsolute(inp) ? inp : path.join(ROOT, inp)
  for (const l of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (l.trim()) allFiles.push(l.trim())
  }
}
const files = [...new Set(allFiles)]
if (!files.length) { console.error('没读到任何文件'); process.exit(1) }

const rows = MODE === 'clean' ? auditDetails(files) : null
selfCheck(files, rows, MODE)

const PER = MODE === 'clean' ? 6 : 8
const batches = []
for (let i = 0; i < files.length; i += PER) batches.push(files.slice(i, i + PER))

const template = MODE === 'clean' ? CLEAN_BODY : REWRITE_BODY
batches.forEach((b, i) => {
  const wt = `D:/tmp/g${String(i + 1).padStart(2, '0')}`
  //  顺序要紧：{FILESLINE} 必须先替换。
  // 否则 .replace('{FILES}', ...) 会把 '{FILESLINE}' 里的 '{FILES}' 一并吃掉，
  // 剩下 'LINE'，命令变成「audit-comment-quality.cjs LINE」。
  //  必须用 replaceAll：模板里同一个占位符出现多次，
  // 用 replace 只换第一处 ⇒ 任务书里残留 {FILESLINE}，子 Agent 照着敲命令必错。
  const body = template
    .replaceAll('{FILESLINE}', b.join(' '))
    .replaceAll('{FILES}', b.map((x) => '- ' + x).join('\n'))
    .replaceAll('{DETAIL}', rows ? buildDetails(rows.filter((r) => b.includes(r.file))) : '')
    .replaceAll('{WT}', wt)
    .replaceAll('{SKILL}', SKILL)
  const out = path.join(OUT, `batch${String(i + 1).padStart(2, '0')}.md`)
  fs.writeFileSync(out, body)
  console.log(`${out}  (${b.length} 个文件, worktree ${wt})`)
})
console.log(`\n共 ${batches.length} 批`)
