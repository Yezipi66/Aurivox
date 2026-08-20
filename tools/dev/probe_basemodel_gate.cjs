#!/usr/bin/env node
'use strict'

// ---------------------------------------------------------------------------
//  probe_basemodel_gate — 底模门禁为什么说 v2ProPlus 缺失
// ---------------------------------------------------------------------------
// 背景：真机 models/tts/gpt-sovits/v2ProPlus/ 下 s2Gv2ProPlus.pth (200MB) 和
// s2Dv2ProPlus.pth (126MB) 都在盘上，文件名与 server.js:1499-1500 要求的候选
// 完全一致，但训练页仍报「底模缺失 (s2G + s2D)，该版本已被阻止」。
//
// 助手侧已排除的（tree2 搬家前快照 vs tree3 搬家后，逐字节比对）：
//   - server.js 全文只差 1 行（uvr5 的 require），底模门禁一个字没动
//   - lib/paths.js 的 MODELS_DIR -> TTS_MODELS_DIR -> GSV_PRETRAINED_DIR
//     三级链条一字未改，行号变了而已
//   - models/ 从未参与 r12c 搬家（DIR_MOVES 里全是代码目录）
//
// 所以问题只可能出在**运行时实际解析出来的路径**上，而那个值取决于这台机器的
// 环境变量 / .env，助手侧看不见。这个探针把它打出来。
//
// 只读。不写任何文件，不改任何东西。
//
//   node probe_basemodel_gate.cjs
//
// 把完整输出贴回即可。

const fs = require('node:fs')
const path = require('node:path')

// 上溯找 server.js 定位项目根（C7）。原先写的是 __dirname —— 探针当时
// 就在项目根，恰好相等；r12c batch13 把它搬进 tools/dev/ 后就不相等了。
function findProjectRoot(start) {
  let d = start
  for (;;) {
    if (fs.existsSync(path.join(d, 'server.js'))) return d
    const parent = path.dirname(d)
    if (parent === d) {
      throw new Error(
        `\u627e\u4e0d\u5230\u9879\u76ee\u6839\uff1a\u4ece ${start} \u4e00\u8def\u4e0a\u6eaf\u90fd\u6ca1\u770b\u89c1 server.js`)
    }
    d = parent
  }
}

const ROOT = process.env.AURIVOX_ROOT || findProjectRoot(__dirname)
const line = (c) => console.log(c.repeat(74))

console.log('')
line('=')
console.log('  probe_basemodel_gate   [2026-08-20]')
console.log('  项目根：' + ROOT)
line('=')

// --- 0. .env 有没有覆盖路径 -------------------------------------------------
// envDir(name, fallback) 的规则是：环境变量一旦有值就 path.resolve(它)，
// 完全不看默认值。所以 .env 里一行陈旧的配置足以让门禁去错误的地方找权重，
// 而且不会有任何报错 —— 表现就是「文件明明在，却说缺失」。
console.log('')
console.log('== 0. 环境变量 / .env 是否覆盖了路径 ==')

const PATH_VARS = [
  'APP_DIR', 'MODELS_DIR', 'TTS_MODELS_DIR', 'GSV_PRETRAINED_DIR',
  'GSV_DIR', 'ENGINES_DIR', 'PIPELINE_DIR',
]

let anyEnv = false
for (const k of PATH_VARS) {
  if (process.env[k]) {
    console.log(`   [进程环境] ${k} = ${process.env[k]}`)
    anyEnv = true
  }
}
if (!anyEnv) console.log('   进程环境里没有设置任何路径变量')

const envFile = path.join(ROOT, '.env')
if (!fs.existsSync(envFile)) {
  console.log('   .env 不存在')
} else {
  const hits = fs.readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => PATH_VARS.some((k) => new RegExp('^\\s*' + k + '\\s*=').test(l)))
  if (!hits.length) {
    console.log('   .env 存在，但没有设置上面这些路径变量')
  } else {
    console.log('   ⚠ .env 里设置了路径变量：')
    for (const h of hits) console.log('        ' + h.trim())
    console.log('     注意：server.js 启动时会加载 .env，本探针不会 —— 所以下面')
    console.log('     第 1 节打印的是「没有 .env 时」的值。若这里有条目，服务端')
    console.log('     实际用的是 .env 里那个，两者可能不同，这正是要找的东西。')
  }
}

// --- 1. paths.js 实际算出来的值 --------------------------------------------
console.log('')
console.log('== 1. lib/paths.js 实际解析结果 ==')

let P = null
try {
  P = require(path.join(ROOT, 'lib', 'paths.js'))
} catch (err) {
  console.log('   ✖ 无法加载 lib/paths.js：' + err.message)
  console.log('     这本身就是结论：门禁拿不到路径。')
  process.exit(1)
}

for (const k of ['APP_DIR', 'MODELS_DIR', 'TTS_MODELS_DIR', 'GSV_PRETRAINED_DIR']) {
  const v = P[k]
  const mark = v ? (fs.existsSync(v) ? 'ok  ' : '✖ 不存在') : '（未导出）'
  console.log(`   ${mark}  ${k}`)
  console.log(`          ${v}`)
}

const PRE = P.GSV_PRETRAINED_DIR

// --- 2. 门禁真正要找的那几个文件 --------------------------------------------
// 与 server.js:1488-1503 的 _MV_BASE_REQ 一字不差地照抄，避免探针和产品代码
// 判据不一致 —— 那样探针绿了也说明不了服务端会绿。
console.log('')
console.log('== 2. 逐个候选文件的 existsSync（照抄 server.js:1488-1503）==')

const MV_BASE_REQ = {
  v2: [
    { label: 's2G', cands: ['v2/s2G2333k.pth', 'gsv-v2final/s2G2333k.pth', 'gsv-v2final-pretrained/s2G2333k.pth', 's2G2333k.pth', 'v1/s2G488k.pth', 'v2Pro/s2G488k.pth', 's2G488k.pth', 'gsv-v2final/s2G488k.pth'] },
    { label: 's2D', cands: ['v2/s2D2333k.pth', 'gsv-v2final/s2D2333k.pth', 'gsv-v2final-pretrained/s2D2333k.pth', 's2D2333k.pth', 'v1/s2D488k.pth', 'v2Pro/s2D488k.pth', 's2D488k.pth', 'gsv-v2final/s2D488k.pth'] },
  ],
  v2Pro: [
    { label: 's2G', cands: ['v2Pro/s2Gv2Pro.pth'] },
    { label: 's2D', cands: ['v2Pro/s2Dv2Pro.pth'] },
    { label: 'sv', cands: ['sv/pretrained_eres2netv2w24s4ep4.ckpt'] },
  ],
  v2ProPlus: [
    { label: 's2G', cands: ['v2ProPlus/s2Gv2ProPlus.pth', 'v2Pro/s2Gv2ProPlus.pth'] },
    { label: 's2D', cands: ['v2ProPlus/s2Dv2ProPlus.pth', 'v2Pro/s2Dv2ProPlus.pth'] },
    { label: 'sv', cands: ['sv/pretrained_eres2netv2w24s4ep4.ckpt'] },
  ],
}

const HARD = new Set(['v2Pro', 'v2ProPlus'])

function mb(n) { return (n / 1024 / 1024).toFixed(1) + 'MB' }

for (const version of ['v2', 'v2Pro', 'v2ProPlus']) {
  console.log('')
  console.log(`   --- ${version} ---`)
  const missing = []
  for (const r of MV_BASE_REQ[version]) {
    let found = null
    for (const rel of r.cands) {
      const fp = path.join(PRE, rel)
      let ex = false
      let size = ''
      try {
        const st = fs.statSync(fp)
        ex = st.isFile()
        size = ex ? '  ' + mb(st.size) : ''
      } catch (_) { ex = false }
      console.log(`      ${ex ? '命中' : '  - '}  ${rel}${size}`)
      if (ex && !found) found = fp
    }
    if (!found) missing.push(r.label)
    console.log(`      => ${r.label}: ${found ? '有' : '缺'}`)
  }
  const critical = missing.filter((m) => m === 's2G' || m === 's2D')
  const blocking = HARD.has(version) && critical.length > 0
  console.log(`      结论：missing=[${missing.join(',')}] blocking=${blocking}`)
}

// --- 3. 盘上到底有什么 ------------------------------------------------------
// 上面按候选名逐个 stat 只能回答「我要的在不在」，回答不了「那实际有什么」。
// 大小写、多余空格、.pth.tmp 这类下载残留，都只有列目录才看得见。
console.log('')
console.log('== 3. GSV_PRETRAINED_DIR 下的实际内容 ==')

if (!fs.existsSync(PRE)) {
  console.log('   ✖ 这个目录根本不存在 —— 这就是全部原因')
} else {
  const walk = (dir, depth, prefix) => {
    if (depth > 1) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      console.log(prefix + '（读不了：' + err.message + '）')
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        console.log(prefix + e.name + '/')
        walk(full, depth + 1, prefix + '   ')
      } else {
        let size = ''
        try { size = '  ' + mb(fs.statSync(full).size) } catch (_) {}
        console.log(prefix + e.name + size)
      }
    }
  }
  walk(PRE, 0, '   ')
}

// --- 4. 前端跑的是不是新的 --------------------------------------------------
// web/ 是打包产物驱动的：改了 web/src 不 npm run build，页面不会变。反过来
// 也一样 —— 页面上的报错文案可能来自一个很旧的 dist，与当前后端读数不同源。
console.log('')
console.log('== 4. web/dist 与 web/src 的新旧 ==')

function newest(dir) {
  let t = 0
  const walk = (d, depth) => {
    if (depth > 6) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      if (e.name === 'node_modules') continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      try {
        const m = fs.statSync(full).mtimeMs
        if (m > t) t = m
      } catch (_) {}
    }
  }
  walk(dir, 0)
  return t
}

const srcT = newest(path.join(ROOT, 'web', 'src'))
const distT = newest(path.join(ROOT, 'web', 'dist'))
const fmt = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '（没有文件）')
console.log('   web/src  最新改动：' + fmt(srcT))
console.log('   web/dist 最新构建：' + fmt(distT))
if (srcT && distT && srcT > distT) {
  console.log('   ⚠ dist 比 src 旧 —— 页面上看到的是旧构建，需 npm run build')
} else if (distT) {
  console.log('   ok  dist 不比 src 旧')
}

console.log('')
line('=')
console.log('  探针结束。只读，没有改动任何东西。')
line('=')
console.log('')
