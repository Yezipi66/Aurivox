#!/usr/bin/env node
// =====================================================================
//  verify18 —— 18 号包（F1 引擎起停的 HTTP 写路 + F2 引擎管理页）端到端验收
// =====================================================================
//
//   用法（在仓库根跑）：  node tools\verify18.cjs
//   退出码 0 = 全绿；非 0 = 有项没过，屏幕上会写清是哪一项。
//
// ⭐ 这个脚本只验**装完之后仓库长什么样**，⛔ 它不起引擎、不点一次按钮。
// ⛔ 它红了不许改它。红了说明装漏了文件，或者装完又被别的东西改回去了。
//
// ⭐⭐⭐ 这一刀的由来（2026-08-31 当场量出来的三行）：
//   · lib/routes/engines.js 只有 1 个路由，且是 GET
//   · supervisor.ensure() 唯一的活调用点在**合成里**
//   · supervisor.stop(id) 活代码 0 个调用点
//   ⇒ **想起一台引擎，唯一的办法是点一次合成。**

const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
let pass = 0
const fails = []

function read (rel) {
  const p = path.join(root, rel.split('/').join(path.sep))
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
}
function check (name, fn) {
  let ok = false; let why = ''
  try { const r = fn(); ok = r === true; if (typeof r === 'string') why = r } catch (e) { why = e.message }
  if (ok) { pass++; console.log('  ✔ ' + name) } else { fails.push(name + (why ? ' —— ' + why : '')); console.log('  ✘ ' + name + (why ? ' —— ' + why : '')) }
}
function has (rel, s) {
  const t = read(rel)
  if (t === null) return `文件不存在: ${rel}`
  return t.includes(s) ? true : `${rel} 里找不到: ${s}`
}
function re (rel, r, why) {
  const t = read(rel)
  if (t === null) return `文件不存在: ${rel}`
  return r.test(t) ? true : (why || `${rel} 不匹配: ${r}`)
}

// ---------------------------------------------------------------- F1
console.log('\n[F1] 引擎的写路 —— 不点合成也能起 / 停')
check('F1-1 lib/routes/engines.js 里有 POST 路由（今天之前是 0 个）', () =>
  re('lib/routes/engines.js', /router\.post\(/))
check('F1-2 起引擎的口 /api/engines/:id/start', () =>
  has('lib/routes/engines.js', '/api/engines/:id/start'))
check('F1-3 停引擎的口 /api/engines/:id/stop', () =>
  has('lib/routes/engines.js', '/api/engines/:id/stop'))
check('F1-4 ⭐⭐⭐ ensure/stop 在 withGenerationLock 里调（supervisor.js:40 那句话靠它继续为真）', () =>
  re('lib/routes/engines.js', /withGenerationLock/))
check('F1-5 ⛔ 没有锁必须 501，不许退化成"不加锁直接调"', () =>
  has('lib/routes/engines.js', 'ENGINE_LOCK_MISSING'))
check('F1-6 ⛔ 没有看管人必须 501', () =>
  has('lib/routes/engines.js', 'ENGINE_SUPERVISOR_MISSING'))
check('F1-7 ⛔ 没有 requireApiKey 必须 501，不许默默放行', () =>
  has('lib/routes/engines.js', 'ENGINE_AUTH_MISSING'))
check('F1-8 两个 POST 都挂了鉴权中间件', () => {
  const t = read('lib/routes/engines.js')
  if (t === null) return '文件不存在'
  const n = (t.match(/router\.post\([^,]+,\s*apiKeyGuard/g) || []).length
  return n === 2 || `挂了鉴权的 POST 只有 ${n} 个，应为 2`
})
check('F1-9 ⭐⭐⭐ confirmed 用"有没有这个键"判，⛔ 不是 !!body.confirmed', () =>
  re('lib/routes/engines.js', /confirmed['"]?\s*\)|confirmed['"]?\s*in\s|!==\s*undefined/,
    '找不到"显式带了这个键才传"的判断 —— 写成 !!body.confirmed 会让每次手动启动都被拒'))
check('F1-10 ⭐⭐ 错误里的 mem 原样透出去（needs_confirm 的弹框除了它没有别的来源）', () =>
  re('lib/routes/engines.js', /mem/))
check('F1-11 错误码→状态码有一张明表', () =>
  has('lib/routes/engines.js', 'ENGINE_NEEDS_CONFIRM'))
check('F1-12 关闭前先查 busy —— 在合成中的引擎不许关', () =>
  has('lib/routes/engines.js', 'ENGINE_BUSY'))
check('F1-13 守卫文件在（16 条，真调 handler，⛔ 不是文本守卫）', () =>
  read('lib/routes/engines.writeRoutes.node.test.js') !== null || '守卫没装上')
check('F1-14 ⛔ 守卫里不许写死任何引擎名（用 listEngineIds()[0]）', () =>
  has('lib/routes/engines.writeRoutes.node.test.js', 'listEngineIds'))

// ---------------------------------------------------------------- F2
console.log('\n[F2] 引擎管理页 —— 界面上够得着那些能力')
check('F2-1 页面文件在', () =>
  read('web/src/components/engines/EnginesTab.jsx') !== null || '文件没装上')
check('F2-2 判断挪进了纯函数（沙箱能真跑的那一半）', () =>
  read('web/src/lib/engineActions.pure.js') !== null || '文件没装上')
check('F2-3 ⭐ 纯函数有 13 条真测试', () =>
  read('web/src/lib/engineActions.node.test.js') !== null || '测试没装上')
check('F2-4 web/src 里真的有人请求那两个写路口（今天之前是 0 次）', () =>
  re('web/src/lib/engines.js', /\/api\/engines\/\$\{[^}]*\}\/(start|stop)/))
check('F2-5 startEngine / stopEngine 都导出了', () => {
  const t = read('web/src/lib/engines.js')
  if (t === null) return '文件不存在'
  return (/export\s+(async\s+)?function\s+startEngine\b/.test(t) && /export\s+(async\s+)?function\s+stopEngine\b/.test(t)) ||
    '缺一个'
})
check('F2-6 ⭐⭐ 前端也不许无脑带 confirmed', () =>
  has('web/src/lib/engines.js', 'confirmed !== undefined'))
check('F2-7 页面被 App.jsx import 了', () =>
  has('web/src/App.jsx', "from './components/engines/EnginesTab'"))
check('F2-8 ⭐⭐⭐ 导航条上点得进去（组件存在 ≠ 用户点得到）', () =>
  has('web/src/App.jsx', "setPage('engines')"))
check('F2-9 真的会被渲染', () =>
  re('web/src/App.jsx', /page === 'engines'[\s\S]{0,120}<EnginesTab/))
check('F2-10 ⭐ 起停成功后立刻重拉，⛔ 不干等那个 8 秒轮询', () =>
  has('web/src/App.jsx', 'onChanged={refreshEngines}'))
check('F2-11 ⭐⭐⭐ phase 先于 running 判（"正在启动"不许显示成"待命"）', () =>
  has('web/src/lib/engineActions.pure.js', 'starting'))
check('F2-12 ⭐ 别人起的引擎（external）关不了 —— 我们没有那个进程的句柄', () =>
  has('web/src/lib/engineActions.pure.js', 'external'))
check('F2-13 ⭐ 平台不管进程（unmanaged）≠ 没在跑', () =>
  has('web/src/lib/engineActions.pure.js', 'unmanaged'))
check('F2-14 ⭐ 名片没写 runtime（not-ours）是合法状态', () =>
  has('web/src/lib/engineActions.pure.js', 'not-ours'))
check('F2-15 needs_confirm 走"问一句"分支，⛔ 不是红字报错', () =>
  has('web/src/lib/engineActions.pure.js', 'confirm'))
check('F2-16 接线守卫在', () =>
  read('web/src/components/engines/enginesTab.wiring.node.test.js') !== null || '守卫没装上')
check('F2-17 ⭐⭐⭐ 页面用到的 CSS 类名 styles.css 里都真有', () => {
  const jsx = read('web/src/components/engines/EnginesTab.jsx')
  const css = read('web/src/styles.css')
  if (jsx === null || css === null) return '文件不存在'
  const used = new Set()
  for (const m of jsx.matchAll(/className="([^"${}]+)"/g)) { for (const c of m[1].split(/\s+/)) if (c) used.add(c) }
  for (const m of jsx.matchAll(/'(badge-[a-z0-9-]+)'/g)) used.add(m[1])
  const missing = [...used].filter((c) => !new RegExp(`\\.${c}\\b`).test(css))
  return missing.length === 0 || 'styles.css 里没有这些类：' + missing.join('、')
})
check('F2-18 ⛔ 页面里不许出现任何一台引擎的名字', () => {
  const src = (read('web/src/components/engines/EnginesTab.jsx') || '') + (read('web/src/lib/engineActions.pure.js') || '')
  const dir = path.join(root, 'engines')
  if (!fs.existsSync(dir)) return '找不到 engines/ 目录'
  const ids = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name)
  if (!ids.length) return '一台引擎都没扫到，这条等于没跑'
  const bad = ids.filter((id) => src.includes(id))
  return bad.length === 0 || '写死了：' + bad.join('、')
})
check('F2-19 ⭐ 顺带接上一直没人渲染的 processBadge()', () =>
  has('web/src/components/engines/EnginesTab.jsx', 'processBadge'))

// ---------------------------------------------------------------- 契约
console.log('\n[契约] 裁决必须落在 docs/，⛔ 不是聊天记录')
check('C-1 §12.13 写路的口进了正文', () =>
  has('docs/ENGINE_CONTRACT.md', '§12.13 引擎写路的口'))
check('C-2 台账里 F1 已改成 ✅（⛔ 做完一刀当场改那一格）', () =>
  re('docs/ENGINE_CONTRACT.md', /\*\*F1\*\*[\s\S]{0,400}?✅ \*\*完成 2026-08-31\*\*/))
check('C-3 台账里 F2 已改成 ✅', () =>
  re('docs/ENGINE_CONTRACT.md', /\*\*F2\*\*[\s\S]{0,400}?✅ \*\*完成 2026-08-31\*\*/))
check('C-4 钉子数那行没被这一刀改动（F1/F2 的钉子是 0）', () =>
  has('docs/ENGINE_CONTRACT.md', '<!-- NAILS: code=22 files=12 -->'))

// ---------------------------------------------------------------- 收尾
console.log('\n' + '='.repeat(62))
console.log(`verify18: ${pass} 项过 / ${fails.length} 项没过 （共 ${pass + fails.length} 项）`)
if (fails.length) {
  console.log('\n没过的：')
  for (const f of fails) console.log('  · ' + f)
  process.exit(1)
}
console.log('全绿。')
console.log('\n⚠ 这个脚本验不了的（必须真机人肉走）：')
console.log('  · web 能不能 build（沙箱没有 npm，JSX 一次都没编译过）')
console.log('  · Engines 页签点开长什么样、按钮按下去引擎起没起来')
console.log('  · 起引擎时那几十秒里徽章是不是"启动中"而不是"待命"')
console.log('  · 内存不够时那句 needs_confirm 弹出来能不能点"仍然启动"')
process.exit(0)
