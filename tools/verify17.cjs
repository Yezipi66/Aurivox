#!/usr/bin/env node
// =====================================================================
//  verify17 —— 17 号包（A1 + A2 + D1 + 前端 engine_id 接线）端到端验收
// =====================================================================
//
//   用法（在仓库根跑）：  node tools\verify17.cjs
//   退出码 0 = 全绿；非 0 = 有项没过，屏幕上会写清是哪一项。
//
// ⭐ 这个脚本只验**装完之后仓库长什么样**，⛔ 它不启动引擎、不发一次合成请求。
//    真机上还必须人肉走一遍 README 里那三条「行为真的变了」。
// ⛔ 它红了不许改它。红了说明装漏了文件，或者装完又被别的东西改回去了。

const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
let pass = 0
const fails = []

function read(rel) {
  const p = path.join(root, rel.split('/').join(path.sep))
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
}
function check(name, fn) {
  let ok = false, why = ''
  try { const r = fn(); ok = r === true; if (typeof r === 'string') why = r } catch (e) { why = e.message }
  if (ok) { pass++; console.log('  ✔ ' + name) }
  else { fails.push(name + (why ? ' —— ' + why : '')); console.log('  ✘ ' + name + (why ? ' —— ' + why : '')) }
}
function has(rel, s) {
  const t = read(rel)
  if (t === null) return `文件不存在: ${rel}`
  return t.includes(s) ? true : `${rel} 里找不到: ${s}`
}
function hasnt(rel, s) {
  const t = read(rel)
  if (t === null) return `文件不存在: ${rel}`
  return !t.includes(s) ? true : `${rel} 里仍然有: ${s}`
}

// ---------------------------------------------------------------- A1
console.log('\n[A1] 删掉 legacyDefault —— 平台不再替用户猜引擎')
check('A1-1 lib/engines/legacyDefault.js 已删除', () =>
  read('lib/engines/legacyDefault.js') === null || '这个文件还在')
check('A1-2 它的测试也删了', () =>
  read('lib/engines/legacyDefault.node.test.js') === null || '这个文件还在')
// ⭐⭐ 这一条第一版写成"文件里出现 legacyDefault 这个词就算红"，结果 29 个文件全红 ——
//   因为**注释和测试名里到处在说"这里过去是 legacyDefault，已删"**。
//   ⇒ 判据必须说清楚禁的是**哪一种形状**：`require(...)` / `import ... from`。
//   ⛔ 禁令：不许为了让它绿而把那些注释删掉 —— 一条被推翻的做法只有连着
//     "它错在哪"一起留着，才不会三个月后被原样重新写回来。
check('A1-3 全仓库没有一处 require / import legacyDefault', () => {
  const bad = []
  for (const f of walk()) {
    if (!/\.(js|cjs|mjs|jsx)$/.test(f)) continue
    const t = stripComments(fs.readFileSync(f, 'utf8'))
    if (/(require\s*\(\s*['"`][^'"`]*legacy[_D]?[dD]efault|from\s+['"`][^'"`]*legacy[_D]?[dD]efault)/i.test(t)) bad.push(rel(f))
  }
  return bad.length === 0 || '还有引用: ' + bad.join(', ')
})
check('A1-4 合成路由：没有 engine_id 就 400 RECIPE_NO_ENGINE', () =>
  has('lib/routes/synthesis.js', 'RECIPE_NO_ENGINE'))
check('A1-5 读音路由：engine_id 必传，缺了 400', () =>
  has('lib/routes/pron.js', 'PRON_ENGINE_ID_MISSING'))
check('A1-6 recipeStore 不再往盘上写"没值的键"', () =>
  has('lib/recipeStore.js', 'undefined'))

// ---------------------------------------------------------------- A2
console.log('\n[A2] 引擎名字：合成路径从名片读，训练管线收进一处')
check('A2-1 lib/assets/slotPicks.js 存在', () => read('lib/assets/slotPicks.js') !== null || '缺文件')
check('A2-2 lib/training/pipelineIdentity.js 存在', () => read('lib/training/pipelineIdentity.js') !== null || '缺文件')
check('A2-3 pipelineIdentity 导出 TRAINING_ENGINE_ID', () =>
  has('lib/training/pipelineIdentity.js', 'TRAINING_ENGINE_ID'))
check('A2-4 pipelineIdentity 导出 TRAINING_SLOTS', () =>
  has('lib/training/pipelineIdentity.js', 'TRAINING_SLOTS'))
check('A2-5 finalize.js 从 pipelineIdentity 拿身份，⛔ 不自己写死', () =>
  has('lib/training/steps/finalize.js', 'pipelineIdentity'))
check('A2-6 ⛔ 禁令：slotPicks 不许 require pipelineIdentity', () =>
  hasnt('lib/assets/slotPicks.js', 'pipelineIdentity'))
check('A2-7 ⛔ 禁令：synthesis.js 不许 require pipelineIdentity', () =>
  hasnt('lib/routes/synthesis.js', 'pipelineIdentity'))
check('A2-8 ⛔ 禁令：synthesisService.js 不许 require pipelineIdentity', () =>
  hasnt('lib/services/synthesisService.js', 'pipelineIdentity'))
check('A2-9 slotPicks 的守卫测试在', () => read('lib/assets/slotPicks.node.test.js') !== null || '缺文件')
check('A2-10 pipelineIdentity 的守卫测试在', () => read('lib/training/pipelineIdentity.node.test.js') !== null || '缺文件')

// ---------------------------------------------------------------- D1
console.log('\n[D1] 上游报错：正则锚定 + 常量不再抄第二遍')
check('D1-1 failureDetail.js 有 UPSTREAM_SHELL', () =>
  has('lib/services/failureDetail.js', 'UPSTREAM_SHELL'))
check('D1-2 FAILED 常量从 upstreamError 取，⛔ 不在这里再写一遍', () =>
  has('lib/services/failureDetail.js', 'upstreamError'))
check('D1-3 正则是锚定的（^），⛔ 不许在整段日志里乱捞', () => {
  const t = read('lib/services/failureDetail.js')
  return /\^/.test(t) || '没看到 ^ 锚'
})
check('D1-4 failureDetail 的测试在', () => read('lib/services/failureDetail.node.test.js') !== null || '缺文件')

// ------------------------------------------------------ 前端 engine_id
console.log('\n[前端] engine_id 一路穿到每一个读音校对的渲染点')
const SIGN = [
  ['web/src/components/pron/PronProofing.jsx', 'PronPanel'],
  ['web/src/components/pron/PronProofing.jsx', 'HanReadingReview'],
  ['web/src/components/pron/PronProofing.jsx', 'HanLangPicker'],
  ['web/src/components/pron/PronProofing.jsx', 'TextPrepModal'],
  ['web/src/components/train/TrainingTab.jsx', 'AsrReviewPanel'],
  ['web/src/components/train/TrainingTab.jsx', 'AsrRowProof'],
  ['web/src/components/compare/ReferenceCompareTab.jsx', 'CompareRow'],
  ['web/src/components/assets/ReferenceTranscriptProofing.jsx', 'ReferenceTranscriptProofing'],
]
for (const [f, comp] of SIGN) {
  check(`FE 签名 ${comp} 收 engineId (${f.split('/').pop()})`, () => {
    const t = read(f)
    if (t === null) return '文件不存在'
    const re = new RegExp(`function\\s+${comp}\\s*\\(\\s*\\{[^}]*engineId`, 's')
    return re.test(t) || `${comp} 的签名里没有 engineId`
  })
}
check('FE App.jsx 把 engine 传给 AssetsTab', () => has('web/src/App.jsx', '<AssetsTab'))
check('FE App.jsx 把 engine 传给 TrainingTab', () => has('web/src/App.jsx', '<TrainingTab'))
// ⚠ 只禁**读**（GET）。写（POST）那一处是对的：`saveAdvancedParams`
//   （`lib\routes\pron.js:25-32`）存的是**一份全局文件、不分引擎**，它压根不收
//   engine_id。⭐ 不对称的原因：读要"名片默认值"所以必须知道是哪台，写只存
//   "用户亲手拧过的格子"。⚠ 这份全局文件本身是不是该分引擎 —— 归 **A5** 管，
//   ⛔ 不在这一刀里。
check('FE ⛔ 全 web/src 没有一处裸的 /api/advanced-params 读（写不算）', () => {
  const bad = []
  for (const f of walk()) {
    if (!/web[\\/]src[\\/].+\.jsx?$/.test(f)) continue
    if (/\.node\.test\.js$/.test(f)) continue
    const t = stripComments(fs.readFileSync(f, 'utf8'))
    const re = /['"`]\/api\/advanced-params(?![?a-zA-Z])['"`]([\s\S]{0,80})/g
    let m
    while ((m = re.exec(t))) {
      if (!/method:\s*['"`]POST/i.test(m[1])) { bad.push(rel(f)); break }
    }
  }
  return bad.length === 0 || '裸读: ' + bad.join(', ')
})
check('FE ⛔ 全 web/src 没有一处裸的 /api/pron/preview', () => {
  const bad = []
  for (const f of walk()) {
    if (!/web[\\/]src[\\/].+\.jsx?$/.test(f)) continue
    if (/\.node\.test\.js$/.test(f)) continue
    const t = stripComments(fs.readFileSync(f, 'utf8'))
    let i = 0
    while ((i = t.indexOf('/api/pron/preview', i)) !== -1) {
      const seg = t.slice(i, i + 400)
      if (!seg.includes('engine_id')) { bad.push(rel(f)); break }
      i += 10
    }
  }
  return bad.length === 0 || '没带 engine_id: ' + bad.join(', ')
})
check('FE 换引擎让建议读音作废（engineId 进了 selectionSignature）', () => {
  const t = read('web/src/components/pron/PronProofing.jsx')
  const i = t.indexOf('selectionSignature')
  return t.slice(i, i + 600).includes('engineId') || 'engineId 不在签名里'
})
check('FE 没选引擎时给的是"未选引擎"，⛔ 不是静默', () =>
  has('web/src/components/pron/PronProofing.jsx', 'NO_ENGINE_MSG'))
check('FE 全链守卫测试在（26 条）', () =>
  read('web/src/components/pron/pronEngineId.node.test.js') !== null || '缺文件')

// ------------------------------------------------------------- 进度纵轴
console.log('\n[纵轴] 钉子数必须能当场量出来，⛔ 不是文档里一句话')
check('N-1 tools/count_nails.cjs 在', () => read('tools/count_nails.cjs') !== null || '缺文件')
check('N-2 tools/count_nails.node.test.js 在', () => read('tools/count_nails.node.test.js') !== null || '缺文件')
check('N-3 量法扫了 web/src（第三条腿）', () =>
  has('tools/count_nails.cjs', 'web'))
check('N-4 契约里有机器可读的 NAILS 标记', () =>
  has('docs/ENGINE_CONTRACT.md', '<!-- NAILS:'))
check('N-5 ⭐ 契约上的数 == 脚本当场量出来的数', () => {
  const { countNails } = require(path.join(root, 'tools', 'count_nails.cjs'))
  const got = countNails(root)
  const gotFiles = got.files.length   // ⚠ files 是**文件名数组**不是数字
  const m = read('docs/ENGINE_CONTRACT.md').match(/<!--\s*NAILS:\s*code=(\d+)\s+files=(\d+)\s*-->/)
  if (!m) return '契约里没有 NAILS 标记'
  const want = { code: Number(m[1]), files: Number(m[2]) }
  return (got.code === want.code && gotFiles === want.files) ||
    `契约写 ${want.code}/${want.files}，实际量出 ${got.code}/${gotFiles}`
})
check('N-6 ⭐⭐⭐ run_tests 会喊出"没被跑到的测试文件"', () =>
  has('tools/run_tests.cjs', '一条都不会跑'))
check('N-7 run_tests 扫 tools/', () => has('tools/run_tests.cjs', "collect(path.join(root, 'tools'))"))

// ------------------------------------------------------------- 契约本身
console.log('\n[契约] 裁决必须落在 docs/，⛔ 不是聊天记录')
check('C-1 §12.11 在（A2 分流裁决的正文）', () =>
  has('docs/ENGINE_CONTRACT.md', '§12.11'))
check('C-2 §0 修订记录有修订 10 那一行', () =>
  has('docs/ENGINE_CONTRACT.md', '2（修订 10）'))
check('C-3 66/20/58 那三个数已被明确作废', () =>
  has('docs/ENGINE_CONTRACT.md', '不可复算'))
check('C-4 台账 A5 已登记（gpt_sovits_url）', () =>
  has('docs/ENGINE_CONTRACT.md', 'A5'))

// ----------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(62))
console.log(`verify17: ${pass} 项过 / ${fails.length} 项没过 （共 ${pass + fails.length} 项）`)
if (fails.length) {
  console.log('\n没过的：')
  for (const f of fails) console.log('  ✘ ' + f)
  process.exit(1)
}
console.log('全绿。')
console.log('\n⚠ 这个脚本验不了的（必须真机人肉走）：')
console.log('  · 前端能不能 build（沙箱里 npm run build 一次都没跑过）')
console.log('  · 那 5 个页面在浏览器里点开是不是真的显示"未选引擎"')
console.log('  · 存量 v3 配方重新选引擎并保存之后，是不是真的能打通')
process.exit(0)

// ------------------------------------------------------------- helpers
function rel(f) { return path.relative(root, f).split(path.sep).join('/') }
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n')
}
// ⚠ 必须是 var 不是 let：下面这些 check() 在模块体里**立刻执行**，
//   而 let 的声明在文件末尾 ⇒ 暂时性死区，报 "Cannot access '_walked' before initialization"。
//   ⭐ 这条踩过一次：报错文字跟"文件找不到"长得完全不一样，但结果都是 ✘ 一个红。
var _walked = null
function walk() {
  if (_walked) return _walked
  // ⚠ 'cache' / 'dist' 是 2026-08-31 真机上抓到的：`cache/patch-backup/20260803-*/web/src/...`
  //   里躺着三周前的旧副本，被 FE 那两条"全 web/src 没有一处裸读"当成了活代码 ⇒ 假红。
  //   ⭐ 判据：**"全仓库"的单位是"会被跑到的文件"，⛔ 不是"盘上的文件"**。
  //   `cache/` 是补丁备份、`dist/` 是 vite 产物 —— 两者 vite 不编译、server.js 不 require。
  //   ⛔ 禁令：⛔ 不许因为沙箱树里没有这两个目录就以为这条 SKIP 是多余的
  //     —— 沙箱恒绿正是它被漏写的原因。
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'pretrained',
    'pretrained_models', 'uvr5_weights', 'models', 'ja_userdic',
    'cache', 'dist'])
  const out = []
  const rec = (d) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || e.name.startsWith('faster-whisper-')) continue
        rec(full)
      } else if (e.isFile()) out.push(full)
    }
  }
  rec(root)
  _walked = out
  return out
}
