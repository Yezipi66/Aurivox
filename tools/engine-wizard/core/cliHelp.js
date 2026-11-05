'use strict'

// 上游 CLI 原话的提取与比对：在引擎源码里找 argparse 文件，跑 Python 提取器取 flag
// 与官方 help，再把「签名参数名」与「上游 dest」逐个比对。
// 判据是逐字相同的 dest（连字符归一成下划线后）：同名即认为已对上，不同名的一律不猜。
// 只读源码，不装环境、不起引擎。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { findPyFiles } = require('./pyFiles')

const EXTRACTOR = path.join(__dirname, 'cli_help_extract.py')

// 常见的入口文件名，只用于排序：这些名字排在其余文件之前。
// 它们不再是「找到就停止扫描」的清单，别处的 .py 一并进入候选。
const CLI_CANDIDATES = Object.freeze([
  'cli.py', 'cli_v2.py', 'cli2.py', 'main.py',
  'cli', 'infer.py', 'inference.py',
])

// 命令行框架的声明特征：argparse、click、typer、fire 都算。
// 只用它筛「要不要交给 Python 解析」，不用它判断哪一个是推理入口。
const CLI_MARKERS = /(?:add_argument\s*\(|ArgumentParser\s*\(|click\.|typer\.|fire\.Fire|@(?:app|cli)\.command)/
// 判「像不像 argparse CLI」读多少字节。只读文件头 4KB 会漏掉把 parser 写在文件后半段的
//   CLI（有的上游 CLI 把 add_argument 写在文件靠后位置），
//   漏掉之后扫到的只剩 scripts/ 下的测试脚本，参数池里全是别的脚本的开关。
//   256KB 盖得住正常的 CLI 源文件，又不至于去读一个巨大的生成文件。
//   与 cli_help_extract.py 的 SNIFF_BYTES 同值（两处判据不能分叉）。
const SNIFF_BYTES = 256 * 1024

// spec 走临时文件而不是命令行参数：路径里出现引号/中文时，命令行在 Windows 上
//   解析不了。
function runExtractor (dir, candidates, python, files) {
  if (!fs.existsSync(EXTRACTOR)) {
    return { ok: false, error: `提取器不存在：${EXTRACTOR}`, sources: [], flags: [], by_dest: {} }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-clihelp-'))
  const specFile = path.join(tmpDir, 'spec.json')
  try {
    fs.writeFileSync(specFile, JSON.stringify({
      dir: path.resolve(dir),
      candidates: candidates || CLI_CANDIDATES,
      // 文件清单由 Node 侧统一给出，Python 侧不再自己找一遍：
      //   两处各有一份发现逻辑时，界面上的候选与实际解析的源码会悄悄分叉。
      files: Array.isArray(files) ? files.map((f) => String(f).replace(/\\/g, '/')) : null,
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
 * 文件头里有没有命令行框架的声明。只作过滤，不作入口判断。
 * 读文件头而不整份读：大文件里的注释与数据段没有声明，读满会拖慢扫描。
 */
function looksLikeCli (full) {
  let head = ''
  try {
    const fd = fs.openSync(full, 'r')
    const buf = Buffer.alloc(SNIFF_BYTES)
    const bytes = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0)
    head = buf.slice(0, bytes).toString('utf8')
    fs.closeSync(fd)
  } catch { return false }
  return CLI_MARKERS.test(head)
}

/**
 * 在引擎源码目录里找声明了命令行参数的文件。
 * 全目录的 .py 都过一遍，不设深度上限；只把含框架声明的那些交给解析器。
 *
 * @param {string} dir 引擎源码根目录
 * @returns {string[]} 相对 dir 的路径列表，常见入口名排在前
 */
function findCliFiles (dir, opts = {}) {
  if (!dir || !fs.existsSync(dir)) return []
  const cand = opts.candidates || CLI_CANDIDATES
  const priority = new Set(cand)
  const rels = findPyFiles(dir).filter((rel) => looksLikeCli(path.join(dir, ...rel.split('/'))))
  const rank = (rel) => {
    const posix = rel.replace(/\\/g, '/')
    if (priority.has(posix)) return 0
    if (priority.has(posix.split('/').pop())) return 1
    return 2
  }
  return rels.map((rel) => path.normalize(rel))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/**
 * 从引擎目录抓上游 CLI 的官方原话，整份摊开。
 *
 *    它只回答「上游在 CLI 上给了哪些 flag」以及每个 flag 的官方说明文字。
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
  const r = runExtractor(abs, spec.candidates || CLI_CANDIDATES, spec.python, rels)
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
  CLI_MARKERS,
}
