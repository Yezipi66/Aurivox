'use strict'
// 从文档与打包声明里提取作者自己写的入口，用来定位推理入口。
//
// 三路来源，按可信度从高到低：
//   打包声明（pyproject / setup.py 的 scripts）写的是「装好之后敲哪条命令」，
//     由打包工具读取，写错了装不上，比文档硬；
//   README 里的示例命令是给人看的用法，写法随人而异；
//   都没有才回退到按参数打分（entryPick.js）。
//
// 三者都只给候选：是不是推理由调用方对照扫描结果决定（只认确实出现在参数表里的文件）。
//   README 里同时写着训练、下载、webui 的启动方式很常见，光看命令分不出来。

/** python 可执行名的前缀：python / python3 / python3.10 / python3.12 都认。 */
const PY = '\\bpython(?:[\\d.]+)?\\s+'

/**
 * README 里的一行命令 -> 候选。
 * 同一行里出现 `cd 子目录 &&` 时，后面那些相对路径要按那个子目录算：
 *   作者常站在子目录里写用法，而扫描出来的路径是相对引擎根的。
 * @param {string} line
 * @returns {{modules: string[], files: string[]}}
 */
function fromCommandLine (line) {
  const modules = []
  const files = []
  const cd = /(?:^|[;&|]\s*)cd\s+([^\s;&|]+)\s*&&/.exec(line)
  const prefix = cd
    ? cd[1].replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') + '/'
    : ''

  // python -m pkg.mod
  const reMod = new RegExp(PY + '-m\\s+([A-Za-z_][\\w.]*)', 'g')
  let m = reMod.exec(line)
  while (m) { modules.push(m[1]); m = reMod.exec(line) }

  // python path/to/file.py
  const reFile = new RegExp(PY + '(?:\\.\\/)?([A-Za-z_][\\w./-]*\\.py)\\b', 'g')
  m = reFile.exec(line)
  while (m) {
    const rel = m[1].replace(/^\.\//, '')
    if (!prefix || rel.startsWith(prefix)) files.push(rel)
    else files.push(prefix + rel)
    m = reFile.exec(line)
  }
  return { modules, files }
}

/**
 * @param {string} text README 原文
 * @returns {{modules: string[], files: string[]}} modules 是 `python -m x.y` 的形式，
 *   files 是相对路径的 .py。两者都已去重，顺序按出现先后。
 */
function entriesFromReadme (text) {
  const modules = []
  const files = []
  if (!text || typeof text !== 'string') return { modules, files }

  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line.indexOf('python') < 0) continue
    const got = fromCommandLine(line)
    for (const m of got.modules) modules.push(m)
    for (const f of got.files) files.push(f)
  }

  return { modules: [...new Set(modules)], files: [...new Set(files)] }
}

/** 打包声明里的一个值是 `模块:函数` 或 `模块.子模块`，只取模块那一段。 */
function moduleOfEntryValue (value) {
  const s = String(value || '').trim().replace(/^['"]|['"]$/g, '')
  if (!s) return null
  const mod = s.split(':')[0].trim()
  if (!/^[A-Za-z_][\w.]*$/.test(mod)) return null
  // 允许 `pkg.mod` 这种不带函数的写法；带空格/路径的一律不认，那不是模块名。
  return mod
}

const PACKAGING_SECTIONS = Object.freeze([
  'project.scripts',
  'project.entry-points.console_scripts',
  'tool.poetry.scripts',
  'tool.pdm.scripts',
])

/**
 * pyproject.toml 里的入口。只认上面那几段，不做完整 TOML 解析：
 *   这一段的结构固定是 `名字 = "模块:函数"`，按行读足够，而且不会因为 TOML
 *   的其它语法（多行数组、内联表）把整份文件读错。
 * @param {string} text
 * @returns {{modules: string[], files: string[], commands: string[]}}
 */
function entriesFromPyproject (text) {
  const modules = []
  const files = []
  const commands = []
  if (!text || typeof text !== 'string') return { modules, files, commands }

  let section = ''
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const hdr = /^\[([^\]]+)\]$/.exec(line)
    if (hdr) { section = hdr[1].trim(); continue }
    if (!PACKAGING_SECTIONS.includes(section)) continue
    // TOML 规定键名含连字符时必须加引号（如 "f5-tts_infer-cli" = "..."），
    // 而 CLI 工具的 console_scripts 命令名几乎都带连字符，所以这里允许键名两端带引号。
    const kv = /^["']?([A-Za-z0-9_.-]+)["']?\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    const mod = moduleOfEntryValue(kv[2])
    if (!mod) continue
    modules.push(mod)
    commands.push(kv[1])
  }
  return { modules: [...new Set(modules)], files, commands: [...new Set(commands)] }
}

/**
 * setup.py 的 console_scripts。这里不做语法解析，只按 `名字=模块:函数` 的字符串取，
 *   取不到就算了：这条是兜底，pyproject 才是主流。
 * @param {string} text
 * @returns {{modules: string[], files: string[], commands: string[]}}
 */
function entriesFromSetupPy (text) {
  const modules = []
  const commands = []
  if (!text || typeof text !== 'string') return { modules, files: [], commands }
  const re = /['"]([A-Za-z0-9_.-]+)\s*=\s*([A-Za-z_][\w.]*)\s*:\s*[A-Za-z_][\w.]*\s*['"]/g
  let m = re.exec(String(text))
  while (m) {
    modules.push(m[2])
    commands.push(m[1])
    m = re.exec(String(text))
  }
  return { modules: [...new Set(modules)], files: [], commands: [...new Set(commands)] }
}

/** 把几路候选并成一份，保序去重。 */
function mergeEntries (...lists) {
  const modules = []
  const files = []
  const commands = []
  for (const it of lists) {
    if (!it) continue
    for (const m of (it.modules || [])) modules.push(m)
    for (const f of (it.files || [])) files.push(f)
    for (const c of (it.commands || [])) commands.push(c)
  }
  return {
    modules: [...new Set(modules)],
    files: [...new Set(files)],
    commands: [...new Set(commands)],
  }
}

/**
 * 把 `python -m a.b.c` 翻成可能的源文件路径：a/b/c.py、a/b/c/__main__.py，
 * 以及 src 布局下的同一组。
 *
 * src 布局（源码放在 src/ 下、安装时把 src 加进路径）在 Python 项目里很常见，
 *   扫描出来的路径是 `src/a/b/c.py`，而声明与用法里写的是模块名 `a.b.c`。
 *   不补这一组，声明命中会全部落空，只能退回参数打分。
 * 扁平布局排在前面：同名文件两处都有时，优先按工程根的写法解释。
 *
 * @param {string} mod
 * @returns {string[]}
 */
function moduleToFiles (mod) {
  const p = String(mod || '').replace(/\./g, '/')
  if (!p) return []
  const flat = [p + '.py', p + '/__main__.py']
  return [...flat, ...flat.map((f) => 'src/' + f)]
}

module.exports = {
  entriesFromReadme,
  entriesFromPyproject,
  entriesFromSetupPy,
  mergeEntries,
  moduleToFiles,
}
