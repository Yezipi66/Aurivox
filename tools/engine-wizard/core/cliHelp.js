'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const EXTRACTOR = path.join(__dirname, 'cli_help_extract.py')

const CLI_CANDIDATES = Object.freeze([
  'cli.py', 'cli_v2.py', 'cli2.py', 'main.py',
  'cli', 'infer.py', 'inference.py',
])

const SKIP_DIRS = Object.freeze(new Set([
  'node_modules', '__pycache__', '.venv', 'venv', 'env', '.env',
  'build', 'dist', 'docs', 'doc', 'tests', 'test', 'testing',
  'examples', 'notebooks', 'assets', 'static', 'wheels',
  '.git', '.github', '.idea', '.vscode',
]))

const MAX_DEPTH = 4
const MAX_FILES = 4000

// spec 走临时文件而不是命令行参数：路径里出现引号/中文时，命令行在 Windows 上
//   解析不了。
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
    // python 可指定；没指定就用系统 PATH 里的 python/python3。
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

// argparse 的 dest 推导规则：dest 取第一个 long option 的名字，去 `--` 前缀，
//   连字符转下划线；没有 long option 时才退到 positional 名；
//   都没有才用 dest= 显式给。
// `--no-foo` 这种 BooleanOptionalAction 的 dest 仍是 `foo`，`--no-` 是动作
function destFor (flags, isOption) {
  if (isOption) {
    const long = flags.find((o) => typeof o === 'string' && o.startsWith('--'))
    if (long) {
      const bare = long.slice(2)
      // 连字符转下划线：`--emotion-vector` 的 dest 是 `emotion_vector`。
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

function norm (s) {
  return String(s || '').toLowerCase().replace(/-/g, '_')
}

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

  for (const c of cand) {
    push(c)
    const sub = path.join(dir, c)
    if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
      for (const f of fs.readdirSync(sub)) {
        if (f === c + '.py' || f === 'cli.py') push(path.join(c, f))
      }
    }
  }
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

/**
 * 从引擎目录抓上游 CLI 的官方原话，整份摊开。
 *
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
  const r = runExtractor(abs, spec.candidates || CLI_CANDIDATES, spec.python)
  if (!r.ok) {
    return { ok: false, error: r.error, detail: r.detail || null, sources: [], flags: [], by_dest: {} }
  }
  const flags = r.flags || []
  // by_dest：按 dest 建索引，供「直接同名」那一条判定用。
  const byDest = {}
  for (const f of flags) {
    const k = norm(f.dest)
    if (!byDest[k]) byDest[k] = []
    byDest[k].push(f)
  }
  return { ok: true, sources: r.sources || [], flags, by_dest: byDest }
}

/**
 * 「直接同名」判定：签名参数名与 CLI dest 逐字相同（去连字符转下划线后）。
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
  // 多个子命令都声明了同名 flag：优先有官方原话的那一条，
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
    kind: 'exact_name',
  }
  return out
}

/**
 * 第 2 步的组装：把上游 CLI 原话按「用户操作流」分成三块，接到草稿包上。
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
    if (!p) return { name: null, _block: kind, _malformed: true }
    const m = exact(p.name)
    return m ? { ...p, _block: kind, _cli: m } : { ...p, _block: kind }
  }

  const auto = []
  for (const row of (draft.map_candidates || [])) {
    if (!row.already_mapped) continue
    auto.push(enrich({ name: row.platform_key, _mapped_to: row.current }, 'auto'))
  }

  // 必须填的：必填 + 平台认不出
  const must = []
  const may = []
  for (const p of draft.parameters) {
    if (p && p.required === true) must.push(enrich(p, 'must'))
    else may.push(enrich(p, 'may'))
  }

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
