'use strict'
// 测试用的编译工具从哪儿解析：先根 node_modules（版本由根 package.json 钉住），再 web/node_modules。
// 选根那份：web 那份是 Vite 的传递依赖，跟着 Vite 升级漂；两份版本不同会解析出不同行为。

const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..')

/** 从根 node_modules 解析一个包，根那份没有就退回 web 那份；都没有则返回 null。 */
function resolveFromRoot (name) {
  const candidates = [
    ROOT,
    path.join(ROOT, 'web'),
  ]
  for (const base of candidates) {
    try {
      return require.resolve(name, { paths: [base] })
    } catch (e) { /* 换下一个 */ }
  }
  return null
}

/**
 * @babel/parser 的 parse 函数。拿不到就抛，不返回 null：调用方的 try/catch 会把 null
 * 变成后面一句 parse(...) 的 TypeError，报错说的是「parse 不是函数」而不是「依赖没装」。
 */
function babelParse () {
  const p = resolveFromRoot('@babel/parser')
  if (!p) {
    throw new Error('拿不到 @babel/parser：根与 web/ 的 node_modules 里都没有它')
  }
  return require(p).parse
}

/** esbuild 模块。拿不到就抛，理由同 babelParse。 */
function esbuild () {
  const p = resolveFromRoot('esbuild')
  if (!p) {
    throw new Error('拿不到 esbuild：根与 web/ 的 node_modules 里都没有它')
  }
  return require(p)
}

// ---- 前端规范提醒 + 自动检测（供各守卫在失败时引用） ----
//
// 单一来源的规范清单：守卫失败时在 stderr 末尾打印，让开发者自查，
// 不用再回来找人逐条解释。前 5 条是样式规范，后 2 条是文案/注释纪律，
// 覆盖四道守卫各自守的边界。

const FRONTEND_NORMS = [
  '样式 token / 类只从 web/src/styles.css 单一来源取，不要自己发明一套（—warning / —danger / .btn-* / .badge-* / chip 体系）',
  '危险/不可逆动作不要弱化：提示就写在底色上（实心危险色），不去掉边框、不纯文字',
  '不把互不相干的命令塞进分段控件（segmented 只用于一组同类/互斥选项）',
  '没人要求的视觉改动不要顺手加；要加先问',
  '徽标/状态用语义类名（如 badge-norefs），不要用数字后缀（badge-danger2）',
  '警示色统一 var(--warning)，硬错误用 var(--danger)；不写死颜色字面量、不引用未定义的 CSS 变量',
  '界面文案/注释纪律：口语禁词、破折号解释腔、归属叙述、现场经过、幽灵类、emoji 一律不许',
]

let __normsReminderShown = false

// 进程退出时若本次测试有失败（exitCode 非 0），打印规范提醒一次。
// 绿的时候不出声，失败时才提醒，不刷屏。各守卫文件末尾挂 process.on('exit', ...) 调本函数。
function printFrontendNormsReminder () {
  if (__normsReminderShown) return
  __normsReminderShown = true
  if (!process.exitCode) return
  const lines = [
    '',
    '──────── 前端规范提醒（本次守卫有失败，逐条对照）────────',
    ...FRONTEND_NORMS.map((n, i) => `  ${i + 1}. ${n}`),
    '───────────────────────────────────────────────────────',
    '',
  ]
  try { process.stderr.write(lines.join('\n')) } catch { /* 忽略写入失败 */ }
}

const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.staging', '.venv', '.git'])

function walkCode (dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SCAN_SKIP_DIRS.has(e.name)) walkCode(p, exts, out) }
    else if (exts.has(path.extname(e.name))) out.push(p)
  }
  return out
}

// 项目里所有 .css（web/src + 向导 editor.css）定义的 --变量 名。
// editor.css 自己定义了一批 wz-* 布局变量，必须算进「已定义」，否则会误报。
function definedCssVars (root) {
  const set = new Set()
  const dirs = [path.join(root, 'web', 'src'), path.join(root, 'tools', 'engine-wizard', 'editor')]
  for (const dir of dirs) {
    for (const f of walkCode(dir, new Set(['.css']))) {
      const css = fs.readFileSync(f, 'utf8')
      for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) set.add(m[1])
    }
  }
  return set
}

// 扫描 web/src（jsx/js）与向导 editor.css 里引用的 var(--x)，返回在 web/src / editor.css 都未定义的变量名。
function scanUndefinedCssVars (root) {
  const defined = definedCssVars(root)
  const refs = new Set()
  for (const dir of [path.join(root, 'web', 'src'), path.join(root, 'tools', 'engine-wizard', 'editor')]) {
    for (const f of walkCode(dir, new Set(['.jsx', '.js', '.css']))) {
      // 排除测试文件：守卫源码里本就会写 var(--x 示例串/注释，不是真实样式决策，不应被查。
      if (/\.test\./.test(f)) continue
      const src = fs.readFileSync(f, 'utf8')
      for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) refs.add(m[1])
    }
  }
  return [...refs].filter((v) => !defined.has(v)).sort()
}

// 扫描 web/src 与向导 editor.css 里定义的「徽标 + 字母 + 数字」类（badge-danger2 这类），返回类名。
function scanNumericSuffixBadges (root) {
  const bad = new Set()
  for (const dir of [path.join(root, 'web', 'src'), path.join(root, 'tools', 'engine-wizard', 'editor')]) {
    for (const f of walkCode(dir, new Set(['.css']))) {
      const css = fs.readFileSync(f, 'utf8')
      for (const m of css.matchAll(/\.(badge-[a-z]+)(\d+)/g)) bad.add(m[1] + m[2])
    }
  }
  return [...bad].sort()
}

// 已知存量（本仓库既有的、非本次引入的）未定义变量与数字后缀徽标。
// 守卫只拦「新增」：这些存量留作单独清理，不在本次范围（见对话记录）。
// 清理掉其中任一项时，把对应条目从这份表里删掉即可，守卫随即开始盯着它。
const BASELINE_UNDEFINED_CSS_VARS = new Set([
  '--hover', '--radius', '--surface-2', '--panel-2',
  '--wz-drawer-w', '--wz-drawer-w-narrow', '--wz-rail-w',
])
const BASELINE_NUMERIC_BADGES = new Set(['badge-ok2'])

// 去掉已知存量后，返回本次新增的违规，供守卫断言。
function freshUndefinedCssVars (root) {
  return scanUndefinedCssVars(root).filter((v) => !BASELINE_UNDEFINED_CSS_VARS.has(v))
}
function freshNumericSuffixBadges (root) {
  return scanNumericSuffixBadges(root).filter((v) => !BASELINE_NUMERIC_BADGES.has(v))
}

module.exports = {
  resolveFromRoot, babelParse, esbuild, ROOT,
  FRONTEND_NORMS, printFrontendNormsReminder,
  scanUndefinedCssVars, scanNumericSuffixBadges,
  BASELINE_UNDEFINED_CSS_VARS, BASELINE_NUMERIC_BADGES,
  freshUndefinedCssVars, freshNumericSuffixBadges,
}
