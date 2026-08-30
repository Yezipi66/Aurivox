'use strict'

// ---------------------------------------------------------------------------
//  守卫：任何测试都不许往真的 engines/ 目录里写东西
// ---------------------------------------------------------------------------
// 为什么要有这条（2026-08-30 真机事故，一次读数 1093 tests / 65 fail）：
//
//   lib/engines/launchPlan.node.test.js 为了验「一张名片坏了不连累其他引擎」，
//   在**真的** engines/ 目录下现造了一台 zzbrokenprobe。而 `node --test`
//   是多文件并行的：别的测试文件在另外的进程里同时扫这个目录，扫到
//   **刚建好、还没写进内容的 0 字节 manifest.json** ⇒ registry.js:52 抛
//   ENGINE_MANIFEST_INVALID（Unexpected end of JSON input）⇒
//   /api/engines 500、配方存不进、合成 500、Flow 停不到 Gate……
//   65 条失败里 18 条直接点名 zzbrokenprobe，其余是它的级联。
//
// ⭐ 这类 bug 的特征：**弄脏目录的那个文件自己全绿**，红的全是别人，
//   而且换台机器、换个核数就换一批 —— 靠「再跑一次」永远查不出来。
//   所以判据不能是「跑一遍看看红不红」（那是运气），必须是**静态的**：
//   测试源码里就不许出现「往 engines/ 写」这个动作。
//
// 逃生口不是特例而是设计：lib/paths.js 的 ENGINES_DIR 可由同名环境变量覆盖，
// 需要造假引擎的测试请造在 os.tmpdir() 里，再把 ENGINES_DIR 指过去。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const SCAN_DIRS = ['lib', 'tools', 'pipeline', 'engines']
const SELF = path.basename(__filename)

// 写盘动作。⚠ 只列**会在目录里留下东西**的那些；readdirSync/readFileSync 不算。
const WRITE_CALLS = [
  'mkdirSync', 'mkdir',
  'writeFileSync', 'writeFile',
  'copyFileSync', 'copyFile',
  'appendFileSync', 'appendFile',
  'cpSync', 'cp',
  'renameSync', 'rename',
  'symlinkSync', 'symlink',
  'createWriteStream',
]

// --- 剥注释 ----------------------------------------------------------------
// ⛔ 不能直接 grep 源码：这个仓库的注释里到处写着「往 engines/ 写」这件事
//   本身（包括本文件），不剥注释的话守卫会被自己的说明文字点着。
function stripCommentsAndKeepStrings(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i++
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue }
        out += src[i]
        if (src[i] === quote) { i++; break }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

function listTestFiles() {
  const found = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        walk(full)
        continue
      }
      if (!e.name.endsWith('.test.js') && !e.name.endsWith('.test.cjs')) continue
      if (e.name === SELF) continue
      found.push(full)
    }
  }
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d))
  return found
}

// 一处「可疑的写」= 写调用的实参文本里提到了 engines 目录，且没有任何
// 临时目录的痕迹。临时目录的痕迹只认这两个词，别的都当成真目录。
const TEMP_HINT = /mkdtemp|tmpdir|TMPDIR|os\.tmp/i
const ENGINES_HINT = /ENGINES_DIR|['"`]engines['"`]/

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

function offenders(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const code = stripCommentsAndKeepStrings(raw)
  const hits = []

  // ① 先收「名字里绑着真 engines 目录」的变量：
  //      const dir = path.join(ROOT, 'engines', 'zzbrokenprobe')
  const bound = new Set()
  const assign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]*)/g
  let m
  while ((m = assign.exec(code))) {
    const [, name, expr] = m
    if (ENGINES_HINT.test(expr) && !TEMP_HINT.test(expr)) bound.add(name)
  }

  // ② 再看每一次写调用的实参。
  const call = new RegExp('\\b(?:fs|fsp|fs\\.promises)?\\.?(' + WRITE_CALLS.join('|') + ')\\s*\\(', 'g')
  while ((m = call.exec(code))) {
    // 取到本次调用的第一个实参（到逗号或右括号为止，够判断了）。
    const tail = code.slice(m.index + m[0].length, m.index + m[0].length + 240)
    const arg = tail.split(/,(?![^(]*\))|\)/)[0]
    if (TEMP_HINT.test(arg)) continue
    const mentionsEngines = ENGINES_HINT.test(arg)
    const usesBound = [...bound].some((name) =>
      new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b').test(arg))
    if (!mentionsEngines && !usesBound) continue
    hits.push({
      line: lineOf(code, m.index),
      call: m[1],
      arg: arg.trim().slice(0, 120),
    })
  }
  return hits
}

test('⛔⛔ 没有任何测试往真的 engines/ 目录里写东西（并行跑会污染别的测试文件）', () => {
  const files = listTestFiles()
  // ⚠ 读数陷阱：扫不到文件时，下面的循环恒真通过。先把总数钉住。
  assert.ok(files.length >= 40,
    `只扫到 ${files.length} 个测试文件，太少了 —— 是不是扫错目录了？`)

  const bad = []
  for (const f of files) {
    for (const hit of offenders(f)) {
      bad.push(`${path.relative(ROOT, f)}:${hit.line}  fs.${hit.call}(${hit.arg})`)
    }
  }
  assert.deepEqual(bad, [],
    '这些地方在往真的 engines/ 目录写东西。\n' +
    'node --test 是多文件并行的，别的进程会读到半成品名片 ⇒ ENGINE_MANIFEST_INVALID。\n' +
    '改法：造在 os.tmpdir() 里，然后把 ENGINES_DIR 指过去（lib/paths.js:222 的逃生口）。\n' +
    bad.join('\n'))
})

test('⭐ 守卫自己是活的 —— 认得出「往真 engines/ 写」这个写法', () => {
  // 反证：把出事那天的原始写法原样喂给检测函数，它必须点出来。
  // ⛔ 不落盘 —— 守卫自己更没有资格弄脏那个目录。
  const sample = [
    "const path = require('node:path')",
    "const dir = path.join(ROOT, 'engines', 'zzbrokenprobe')",
    'fs.mkdirSync(dir, { recursive: true })',
    "fs.writeFileSync(path.join(dir, 'manifest.json'), '{}', 'utf8')",
  ].join('\n')
  const tmp = path.join(require('node:os').tmpdir(),
    `engines-guard-selftest-${process.pid}.test.js`)
  fs.writeFileSync(tmp, sample, 'utf8')
  try {
    const hits = offenders(tmp)
    assert.ok(hits.length >= 2,
      `守卫没认出那两处写（只认出 ${hits.length} 处）—— 它现在是个摆设`)
    assert.ok(hits.some((h) => h.call === 'mkdirSync'))
    assert.ok(hits.some((h) => h.call === 'writeFileSync'))
  } finally {
    fs.rmSync(tmp, { force: true })
  }
})

test('⭐ 守卫不冤枉人 —— 造在临时目录里的假引擎必须放行', () => {
  const sample = [
    "const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-engines-'))",
    "fs.mkdirSync(path.join(sandbox, 'zzbrokenprobe'), { recursive: true })",
    "fs.writeFileSync(path.join(sandbox, 'zzbrokenprobe', 'manifest.json'), '{}', 'utf8')",
  ].join('\n')
  const tmp = path.join(require('node:os').tmpdir(),
    `engines-guard-clean-${process.pid}.test.js`)
  fs.writeFileSync(tmp, sample, 'utf8')
  try {
    assert.deepEqual(offenders(tmp), [],
      '临时目录里的假引擎被误判成污染真目录了 —— 这条守卫会逼人绕开它')
  } finally {
    fs.rmSync(tmp, { force: true })
  }
})
