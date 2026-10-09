'use strict'
// ============================================================================
//  CLI HELP —— 把上游 argparse 的官方原话整份抓出来，摊给用户看
//
//  ⭐⭐ 为什么要有这个文件（2026-10-09 定，Owner 定：乙）
//  反射读的是 **Python 函数的签名**（emo_vector / spk_audio_prompt / emo_alpha），
//  而上游自己写给人看的解释挂在 **CLI 的 argparse help=** 上，用的是**另一套词**
//  （--emotion-vector / --voice / --emotion-weight）。
//  [实测] 两边直接同名只对上 3/14；归一化（去连字符转下划线）之后**还是 3/14** ——
//  差异不是连字符，是**整个词不同**（spk⇔voice、emo⇔emotion、alpha⇔weight）。
//
//  ⇒ ⛔⛔ 不维护名字对应表：今天补完这台，明天接下一台又没有，而且那是在拿
//     平台的猜测当上游的语义，贴错就是**静默误导用户**（emo_alpha 配到
//     --emotion-weight 的说明上，用户照着一填，界面那个旋钮就变成别的意思了）。
//  ⇒ ✅ 把上游全部 `--flag` + 官方 `help=` 原话**整份摊开**，用户自己对照。
//  ⇒ ✅ 例外只有一条：**直接同名**的顺手自动贴上去（`text` / `device` / `verbose`）。
//     这是「上游自己把两个入口写成同一个名字」这个事实，⛔ 不是平台的猜测。
//
//  ⛔⛔ 本文件不做三件事：
//     1. 不猜哪个 CLI 参数对应哪个签名参数（除了直接同名，见 destFor）
//     2. 不翻译、不改写、不缩写上游的 help 原话 —— 原样递出去
//     3. 不删任何 flag（工具层的 --batch-file / --concat / --dry-run 也照实列出，
//        让用户自己判断）
//
//  ⛔⛔ 纪律（与 fieldmeta.js 同一条）：本文件里**不许出现任何具体引擎名**。
//    装一台谁都没见过的引擎，这个文件一个字都不用改。
//    node test/cliHelp.node.test.js 里有一条守着这句。
//
//  ⭐ 用 AST 而不是正则：`help=` 常常换行写到 `add_argument(` 的下一行，
//    单行正则只会看到第一个参数（实测踩过：argparse 的 add_parser /
//    add_subparsers 整行匹配不到 help=）。
// ============================================================================

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

// ⭐ Python 侧提取器 —— 与 lib/engines/reflect_params.py 同一条架构纪律：
//   **Python 源码必须用 Python 自己的 ast 模块解析**。
//   2026-10-09 实测踩过：@babel/parser 是 **JavaScript** 解析器，它把 Python 的
//   `import argparse` 当成 ESM 语句，报 "Unexpected token, expected \"from\""。
//   ⛔ 用 JS AST 解析 Python 永远不可能全对（f-string / walrus / match / 装饰器…）。
const EXTRACTOR = path.join(__dirname, 'cli_help_extract.py')

// ---------------------------------------------------------------------------
//  候选 CLI 文件名
// ---------------------------------------------------------------------------
// ⭐ 为什么是「清单 + 递归兜底」两段（2026-10-09 实测）：上游把 CLI 放在哪没
//   有统一约定 —— 有的在包根目录 `<pkg>/cli.py`，有的在包里 `webui/cli.py`，
//   也有的在仓库根的 `tools/`、`scripts/`、`examples/` 下。固定一条 glob 会漏。
//   ⚠ 兜底只读**文件名**（readdir 只取名字，不读内容，不遍历 vendor 等大目录）。
const CLI_CANDIDATES = Object.freeze([
  'cli.py', 'cli_v2.py', 'cli2.py', 'main.py',
  'cli', 'infer.py', 'inference.py',
])

// ⛔ 不递归进去的目录：依赖、缓存、测试、文档、构建产物。
const SKIP_DIRS = Object.freeze(new Set([
  'node_modules', '__pycache__', '.venv', 'venv', 'env', '.env',
  'build', 'dist', 'docs', 'doc', 'tests', 'test', 'testing',
  'examples', 'notebooks', 'assets', 'static', 'wheels',
  '.git', '.github', '.idea', '.vscode',
]))

// ⚠ 兜底递归的深度上限与文件数上限 —— 有的上游仓库几万个文件，
//   ⛔ 不许为了找一个 cli.py 把整棵树走一遍。
const MAX_DEPTH = 4
const MAX_FILES = 4000

// ---------------------------------------------------------------------------
//  跑 Python 侧提取器
// ---------------------------------------------------------------------------
// ⭐ spec 走临时文件而不是命令行参数：路径里出现引号/中文时，命令行在 Windows 上
//   会被二次解析（与 scaffold-params.cjs / envCheck.js 同一条理由）。
// ⛔ 本函数不写任何引擎文件，只在系统临时目录读写 spec。
function runExtractor (dir, candidates, python) {
  if (!fs.existsSync(EXTRACTOR)) {
    return { ok: false, error: `提取器不存在：${EXTRACTOR}`, sources: [], flags: [], by_dest: {} }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-clihelp-'))
  const specFile = path.join(tmpDir, 'spec.json')
  try {
    fs.writeFileSync(specFile, JSON.stringify({
      dir: path.resolve(dir),
      candidates: candidates || CLI_CANDIDATES,
    }), 'utf8')
    // ⚠ python 可指定；没指定就用系统 PATH 里的 python/python3。
    //   ⛔ 不许为了「一定能跑起来」而退回某个固定版本：上游 CLI 可能用了 3.10+
    //     语法（match / walrus），老版本 ast 解析不了。但那只是**抓不到**，
    //     不是报错 —— Python 侧会把 SyntaxError 如实报回来（见 sources[].error）。
    const exe = python || (process.platform === 'win32' ? 'python' : 'python3')
    const proc = spawnSync(exe, [EXTRACTOR, '--spec-file', specFile], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    if (proc.error) {
      return {
        ok: false,
        error: `起不动 Python（${exe}）：${proc.error.message}`,
        sources: [], flags: [], by_dest: {},
      }
    }
    if (proc.status !== 0) {
      return {
        ok: false,
        error: `Python 提取器非零退出（code=${proc.status}）`,
        detail: (proc.stderr || '').slice(-2000),
        sources: [], flags: [], by_dest: {},
      }
    }
    try {
      return JSON.parse(proc.stdout)
    } catch {
      return {
        ok: false,
        error: 'Python 提取器输出不是 JSON',
        detail: (proc.stdout || '').slice(0, 2000),
        sources: [], flags: [], by_dest: {},
      }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  }
}

// ---------------------------------------------------------------------------
//  dest —— 官方 argparse 的 dest 推导规则（逐字照搬，⛔ 不是平台发明）
// ---------------------------------------------------------------------------
// argparse：dest 取第一个 **long option** 的名字，去 `--` 前缀，连字符转下划线；
//           没有 long option 时才退到 positional 名；都没有才用 dest= 显式给。
//   ['-v', '--voice']           → voice     （有 long option）
//   ['-o', '--output_path']     → output_path
//   ['--emotion-vector']        → emotion_vector
//   ['--text-file']             → text_file
//   ['text']                    → text      （positional）
//   ['-d']                      → d         （只有短 option，argparse 就是这么干的）
// ⚠ `--no-foo` 这种 BooleanOptionalAction 的 dest 仍是 `foo`，`--no-` 是动作
//   生成的反向开关，⛔ 不是另一个 dest（argparse 自己就是这么处理的）。
function destFor (flags, isOption) {
  if (isOption) {
    const long = flags.find((o) => typeof o === 'string' && o.startsWith('--'))
    if (long) {
      const bare = long.slice(2)
      // ⚠⚠ 连字符转下划线：`--emotion-vector` 的 dest 是 `emotion_vector`。
      //   漏了它不是报错，是**静默错配** —— 归一化后与签名参数永远对不上，
      //   于是「直接同名」那条唯一允许的自动贴一条都不生效。
      const name = bare.startsWith('no-') ? bare.slice(3) : bare
      return name.replace(/-/g, '_')
    }
    const short = flags.find((o) => typeof o === 'string' && o.startsWith('-'))
    if (short) return short.slice(1)
  }
  const p = flags[0]
  if (p === undefined) return null
  return String(p).replace(/-/g, '_')
}

/** dest 归一化：去连字符转下划线、小写 —— 只用于「直接同名」那一条判定。 */
function norm (s) {
  return String(s || '').toLowerCase().replace(/-/g, '_')
}

// ---------------------------------------------------------------------------
//  找引擎目录下的 CLI 源
// ---------------------------------------------------------------------------
/**
 * 在引擎源码目录里找 CLI 文件。
 * @param {string} dir 引擎源码根目录（或它下面的包目录）
 * @returns {string[]} 相对 dir 的路径列表（清单命中优先，再补递归兜底）
 */
function findCliFiles (dir, opts = {}) {
  if (!dir || !fs.existsSync(dir)) return []
  const cand = opts.candidates || CLI_CANDIDATES
  const found = []
  const seen = new Set()
  const push = (rel) => {
    const full = path.join(dir, rel)
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return
    if (seen.has(full)) return
    seen.add(full)
    found.push(rel)
  }

  // ① 固定清单：根目录 + 一层子目录（命中即停，⛔ 不递归）
  for (const c of cand) {
    push(c)
    const sub = path.join(dir, c)
    if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
      for (const f of fs.readdirSync(sub)) {
        if (f === c + '.py' || f === 'cli.py') push(path.join(c, f))
      }
    }
  }
  // ② 兜底递归：清单没命中时，在浅层里找
  if (found.length === 0) {
    let count = 0
    const rec = (rel, depth) => {
      if (depth > MAX_DEPTH || count > MAX_FILES) return
      const full = path.join(dir, rel)
      let entries
      try { entries = fs.readdirSync(full, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (count > MAX_FILES) return
        const childRel = rel ? path.join(rel, e.name) : e.name
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
          count += 1
          rec(childRel, depth + 1)
        } else if (e.isFile() && /\.py$/.test(e.name)) {
          count += 1
          // ⚠ 只读**前 4KB** 判「像不像 argparse CLI」—— 读整个文件太贵。
          let head = ''
          try {
            const fd = fs.openSync(path.join(dir, childRel), 'r')
            const buf = Buffer.alloc(4096)
            const bytes = fs.readSync(fd, buf, 0, 4096, 0)
            head = buf.slice(0, bytes).toString('utf8')
            fs.closeSync(fd)
          } catch { continue }
          if (/add_argument\s*\(/.test(head)) push(childRel)
        }
      }
    }
    rec('', 0)
  }
  return found
}

// ---------------------------------------------------------------------------
//  组装：给界面的 CLI 原话包
// ---------------------------------------------------------------------------
/**
 * ⭐ 从引擎目录抓上游 CLI 的官方原话，整份摊开。
 *
 * @param {object} spec
 *   dir        必填。引擎源码目录（或它下面的包目录）。可以是相对/绝对路径。
 *   candidates 可选。自定义 CLI 文件名清单（默认 CLI_CANDIDATES）。
 * @returns {object} { ok, sources: [...], flags: [...], by_dest: {...} }
 *
 * ⛔⛔ 本函数不写盘、不联网、不猜对应关系。
 *    它只回答「上游在 CLI 上给了哪些 flag、官方原话是什么」。
 */
function collectCliHelp (spec = {}) {
  const dir = spec.dir
  if (!dir || typeof dir !== 'string') {
    return { ok: false, error: 'dir is required（要读哪个引擎目录）', sources: [], flags: [], by_dest: {} }
  }
  const abs = path.resolve(dir)
  if (!fs.existsSync(abs)) {
    return { ok: false, error: `目录不存在：${dir}`, sources: [], flags: [], by_dest: {} }
  }
  const rels = findCliFiles(abs, { candidates: spec.candidates })
  if (!rels.length) {
    return {
      ok: true,
      sources: [],
      flags: [],
      by_dest: {},
      note: 'This engine directory has no CLI source (no argparse add_argument found).',
      noteZh: '没找到上游 CLI 源码。反射拿到的参数草稿没有官方原话可以对照。',
    }
  }
  // ⭐ 找到文件后交给 Python 侧解析（Python 源码必须用 Python 的 ast 读）。
  const r = runExtractor(abs, spec.candidates || CLI_CANDIDATES, spec.python)
  if (!r.ok) {
    return { ok: false, error: r.error, detail: r.detail || null, sources: [], flags: [], by_dest: {} }
  }
  const flags = r.flags || []
  // ⭐ by_dest：按 dest 建索引，供「直接同名」那一条判定用。
  //   ⚠ 同一个 dest 出现在多个子命令/多个文件时**不合并** ——
  //     help 原话可能不同，合并就是丢信息。这里存数组，用的人自己挑。
  const byDest = {}
  for (const f of flags) {
    const k = norm(f.dest)
    if (!byDest[k]) byDest[k] = []
    byDest[k].push(f)
  }
  return { ok: true, sources: r.sources || [], flags, by_dest: byDest }
}

// ---------------------------------------------------------------------------
//  直接同名 —— 唯一允许的自动贴
// ---------------------------------------------------------------------------
/**
 * ⭐⭐ 「直接同名」判定：签名参数名与 CLI dest **逐字相同**（去连字符转下划线后）。
 *
 * ⛔⛔ 这是本文件**唯一**允许的「自动贴」：
 *   · 同名 ⇒ 上游自己把两个入口写成同一个名字，贴上去不是平台的猜测，是事实。
 *   · 不同名（emo_vector ⇔ emotion_vector、emo_alpha ⇔ emotion_weight、
 *     spk_audio_prompt ⇔ voice）⇒ ⛔ 一律不贴。整份摊开，用户自己对照。
 *
 * 为什么归一化（连字符转下划线）也算「直接同名」：`--output-path` 的 dest
 * 在 argparse 里就是 `output_path`，两边写的是同一个词，⛔ 不是平台的猜测。
 *
 * @param {string} paramName 反射出来的签名参数名（snake_case）
 * @param {object} cliHelp  collectCliHelp 的返回值
 * @returns {object|null} 命中则返回 { flag, help, required, ... }，否则 null
 */
function exactMatchFor (paramName, cliHelp) {
  if (!cliHelp || !cliHelp.ok || !cliHelp.by_dest) return null
  const key = norm(paramName)
  const list = cliHelp.by_dest[key]
  if (!list || !list.length) return null
  // ⚠ 多个子命令都声明了同名 flag：优先**有官方原话**的那一条，
  //   再优先「必填」的那一条（界面上要标「这个必须你填」）。
  //   ⛔ 这不是猜对应关系，是在同名的几条里挑一条**信息最全**的展示。
  const sorted = [...list].sort((a, b) => {
    if (!!b.help !== !!a.help) return b.help ? 1 : -1
    if (!!b.required !== !!a.required) return b.required ? 1 : -1
    return String(a.source_file).localeCompare(String(b.source_file))
  })
  const f = sorted[0]
  const out = {
    flag: f.is_option ? f.flags.join(' ') : f.flags[0],
    flags: f.flags,
    dest: f.dest,
    subcommand: f.subcommand,
    source_file: f.source_file,
    is_option: f.is_option,
    help: f.help,
    required: f.required === true,
    choices: f.choices,
    default: f.default,
    action: f.action,
    // ⭐ 这条是「直接同名」的自动贴，⛔ 不是名字匹配的产物。
    kind: 'exact_name',
  }
  return out
}

// ---------------------------------------------------------------------------
//  把 CLI 原话按三块分区，接到草稿包上
// ---------------------------------------------------------------------------
/**
 * ⭐⭐ 第 2 步的组装：把上游 CLI 原话按「用户操作流」分成三块，接到草稿包上。
 *
 * 分区口径（Owner 定的用户操作流，⛔ 照这个来）：
 *   ① 平台已自动填好的 —— 映射候选里勾上的（或已映射的）
 *   ② 必须你填的     —— 必填 + 平台认不出的，排最前
 *   ③ 可以不管的     —— 选填 + 平台认不出的，折叠
 *
 * ⛔⛔ 本函数**不做任何判断、不校验、不补默认值**（平台是传话筒）。
 *    它只把已有事实按展示顺序排好，每条带上上游原话（如果直接同名抓到了）。
 *
 * @param {object} draft  buildDraftPackage 的返回值
 * @param {object} [cliHelp]  collectCliHelp 的返回值（可为 null）
 * @returns {object} { ok, blocks: [ {key,title,items:[...]} ], cli: cliHelp }
 */
function organizeDraft (draft, cliHelp) {
  if (!draft || draft.ok !== true) {
    return { ok: false, error: (draft && draft.error) || '没有草稿', blocks: [], cli: cliHelp || null }
  }
  const mappedKeys = new Set()
  for (const row of (draft.map_candidates || [])) {
    if (row.already_mapped) mappedKeys.add(row.platform_key)
  }
  const exact = (name) => exactMatchFor(name, cliHelp)

  const enrich = (p, kind) => {
    // ⚠ p 可能是 null/undefined（草稿里混进坏行时）。⛔ 不许在这里抛错 ——
    //   那会把一条坏数据放大成「三块全空，用户一条参数都看不到」。
    //   如实落到「选填」那一块，界面照显示（名字为空，用户看得见那里有问题）。
    if (!p) return { name: null, _block: kind, _malformed: true }
    const m = exact(p.name)
    return m ? { ...p, _block: kind, _cli: m } : { ...p, _block: kind }
  }

  // ① 平台已自动填好的 —— 映射候选里勾上的
  const auto = []
  for (const row of (draft.map_candidates || [])) {
    if (!row.already_mapped) continue
    auto.push(enrich({ name: row.platform_key, _mapped_to: row.current }, 'auto'))
  }

  // ② 必须你填的 —— 必填 + 平台认不出
  //   ⚠ 判据是反射结果里的 required（reflect_params.py 给的）。
  //     ⛔ 平台不自己判断「这个参数必填」，只如实传。
  //   ⚠ null/undefined 的行如实算进「选填」那一块，⛔ 不许在这里抛错把
  //     整个分区搞失败 —— 那会让一条坏数据变成「一条都不显示」。
  const must = []
  const may = []
  for (const p of draft.parameters) {
    if (p && p.required === true) must.push(enrich(p, 'must'))
    else may.push(enrich(p, 'may'))
  }

  // ⛔⛔ 参数一条都不许丢：三块都是**同一份 parameters[]** 的重排视图。
  //   丢一条 = 界面上少一个真实存在的旋钮（且不报错）。
  const total = must.length + may.length
  if (total !== draft.parameters.length) {
    return {
      ok: false,
      error: `分区丢参数：草稿 ${draft.parameters.length} 条，分区后 ${total} 条`,
      blocks: [],
      cli: cliHelp || null,
    }
  }

  return {
    ok: true,
    cli: cliHelp || null,
    blocks: [
      { key: 'auto', items: auto },
      { key: 'must', items: must },
      { key: 'may', items: may },
    ],
    counts: { auto: auto.length, must: must.length, may: may.length },
  }
}

module.exports = {
  collectCliHelp,
  runExtractor,
  findCliFiles,
  exactMatchFor,
  organizeDraft,
  destFor,
  CLI_CANDIDATES,
}
