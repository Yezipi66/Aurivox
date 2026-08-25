#!/usr/bin/env node
/**
 * measure_manifest_reads —— 量一张名片上，平台**真的读**了哪些键。
 *
 * ⛔ 为什么不用 grep：`grep -c upstream lib/` 报 60 —— 里面全是
 *    `upstreamResponse`、注释、别的模块的同名局部变量。用它当判据，
 *    「这个键有人读」和「这个串在别处出现过」会长得一模一样。
 *
 * ⭐ 量法：把名片包成一层记录用的 Proxy（递归到每个子对象），塞回
 *    registry.requireEngine，然后推着平台把 5 个阶段全走一遍，
 *    记下每一次 get。读到的 = 活键；没读到的 = 死数据。
 *
 * ⚠ 这是**下界不是上界**：只覆盖本脚本走过的这几条路。某个键可能在
 *    安装脚本或界面里被读。所以判「死」之前还要人看一眼 —— 但判「活」
 *    是确凿的（真被读了）。
 *
 * 只读：不写任何产品文件；临时引擎目录跑完即删。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const TEMPLATE = path.join(ROOT, 'engines', '_TEMPLATE', 'manifest.json')
const PROBE_ID = 'readprobe'
const PROBE_DIR = path.join(ROOT, 'engines', PROBE_ID)

const seen = new Set()

function record(prefix, key) {
  if (typeof key !== 'string') return
  if (key.startsWith('_')) return            // 注释键，注册表已剥
  seen.add(prefix ? prefix + '.' + key : key)
}

function wrap(obj, prefix) {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj
  return new Proxy(obj, {
    get(t, k, r) {
      if (typeof k === 'string') record(prefix, k)
      const v = Reflect.get(t, k, r)
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof k === 'string') {
        return wrap(v, prefix ? prefix + '.' + k : k)
      }
      return v
    },
    has(t, k) {
      if (typeof k === 'string') record(prefix, k)   // 'x' in caps 也算读
      return Reflect.has(t, k)
    },
  })
}

// ---- 造一张「平台不会中途抛」的完整名片 -----------------------------------
// 中途抛 = 后面的键一个都读不到 = 量出来的清单是残缺的。
// 这里的值全是占位值，只求走通，不求正确。
function stripComments(o) {
  if (Array.isArray(o)) return o.map(stripComments)
  if (o && typeof o === 'object') {
    const out = {}
    for (const k of Object.keys(o)) {
      if (k.startsWith('_')) continue
      out[k] = stripComments(o[k])
    }
    return out
  }
  return o
}

const m = stripComments(JSON.parse(fs.readFileSync(TEMPLATE, 'utf8')))
m.id = PROBE_ID
// ⛔⛔ 只补**模板没给**的，绝不覆盖模板给了的。
//    这里原本写死 `m.maps = { text: 'text' }` —— 模板里另外 9 个 map 键
//    于是从头到尾没进过被测对象：既不在「活」里也不在「死」里，**凭空消失**。
//    量法把被测对象改掉，量出来的就不是被测对象的账。
m.runtime = m.runtime || {}
if (!m.runtime.entry) m.runtime.entry = 'shim.py'
if (!m.runtime.ready_endpoint) m.runtime.ready_endpoint = '/ready'
if (!m.maps || !m.maps.text) m.maps = Object.assign({ text: 'text' }, m.maps || {})

fs.mkdirSync(PROBE_DIR, { recursive: true })
fs.writeFileSync(path.join(PROBE_DIR, 'manifest.json'),
  JSON.stringify(m, null, 2), 'utf8')

let failed = false
try {
  // ⭐ 顺序要紧：profile.js:23 是**载入时解构** requireEngine，
  //   所以必须在 require('./profile') 之前把 registry 换掉。
  const registry = require(path.join(ROOT, 'lib', 'engines', 'registry.js'))
  const realRequire = registry.requireEngine
  const realList = registry.listEngines
  registry.requireEngine = id => wrap(realRequire(id), '')
  registry.listEngines = () => realList().map(x => wrap(x, ''))

  const { resolveEngineProfile } = require(path.join(ROOT, 'lib', 'engines', 'profile.js'))
  const { assembleEnginePayload } = require(path.join(ROOT, 'lib', 'engines', 'payload.js'))
  const { engineUiSchema } = require(path.join(ROOT, 'lib', 'engines', 'paramTable.js'))
  const { checkEngineEnvShallow } = require(path.join(ROOT, 'lib', 'engines', 'envCheck.js'))
  const { findLegacyDefaultId } = require(path.join(ROOT, 'lib', 'engines', 'legacyDefault.js'))

  const stages = []
  const step = (name, fn) => {
    try { fn(); stages.push(['ok', name, '']) }
    catch (e) { stages.push(['ERR', name, (e && e.code) + ' | ' + (e && e.message)]); failed = true }
  }

  let profile = null
  step('名片解析 resolveEngineProfile', () => { profile = resolveEngineProfile(PROBE_ID) })
  step('界面格子 engineUiSchema', () => engineUiSchema(PROBE_ID))
  step('拼请求体 assembleEnginePayload', () => assembleEnginePayload({
    profile, canonical: { text: 'x' }, cfg: {}, engineParams: {},
  }))
  step('环境体检 checkEngineEnvShallow', () => checkEngineEnvShallow(profile))
  step('老路兜底 findLegacyDefaultId', () => findLegacyDefaultId())

  // ---- 报告 ---------------------------------------------------------------
  const line = '='.repeat(74)
  console.log('measure_manifest_reads —— 平台真的读了名片上的哪些键')
  console.log('项目根：' + ROOT)
  console.log(line)
  console.log('')
  console.log('[阶段]')
  for (const [st, name, why] of stages) {
    console.log('   ' + (st === 'ok' ? '✅ ' : '⛔ ') + name + (why ? '\n        ' + why : ''))
  }
  console.log('')

  // 名片上所有叶子/枝键
  const all = new Set()
  ;(function walk(o, p) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return
    for (const k of Object.keys(o)) {
      if (k.startsWith('_')) continue
      const kp = p ? p + '.' + k : k
      all.add(kp)
      walk(o[k], kp)
    }
  })(m, '')

  const live = [...all].filter(k => seen.has(k)).sort()
  // ⭐ 第三桶：自己没被单独读，但**父块被整个取走了**（例如
  //   `out.help = d.help` —— 平台拿走整个 help 对象交给界面，
  //   从此再没碰过 help.zh）。这种键**不是死数据**，只是这套量法
  //   看不见它。混进「死」里会虚报，然后有人照着删掉真在用的东西。
  const opaque = [...all].filter(k => !seen.has(k) && k.includes('.')
    && seen.has(k.slice(0, k.lastIndexOf('.')))).sort()
  const dead = [...all].filter(k => !seen.has(k) && !opaque.includes(k)).sort()

  console.log('[活键] 平台在上面 5 条路上真的读到过：' + live.length + ' 个')
  for (const k of live) console.log('   ✅ ' + k)
  console.log('')
  console.log('[整块被取走] 父块被读了，子键判不了 —— 不算死数据：' + opaque.length + ' 个')
  for (const k of opaque) console.log('   ◻ ' + k)
  console.log('')
  console.log('[死数据] 模板写了、这 5 条路上一次都没读：' + dead.length + ' 个')
  for (const k of dead) console.log('   ⛔ ' + k)
  console.log('')
  // ⛔⛔ 这一桶原来是**猜**的：「平台读过 ∧ 模板没有 ⇒ 作者会漏掉」。
  //    那个推理有一整类反例 —— 平台读它，是为了判断你**有没有写它**，
  //    而正确答案恰恰是「别写」：
  //      · params.schema.<键>.default 与 defaults.<键> 是**二选一**
  //        （profile.js:376-391，两处都写当场抛 ENGINE_MANIFEST_INVALID_VALUE）
  //      · legacy_default 全平台**有且只有一张**名片能认领
  //        （legacyDefault.js:37-53，第二张出现抛 ..._AMBIGUOUS）
  //    照着「⭐ 你漏了」去补，名片直接炸。
  // ⇒ 不猜了：**把它加进去，看平台抛不抛**。加了还能跑 = 真该补；
  //    加了就抛 = 别写，并把平台自己的错误码原样贴出来。
  const candidates = [...seen].filter(k => !all.has(k))
    .filter(k => !['dir', 'id'].includes(k))
    .sort()

  const CHILD = path.join(PROBE_DIR, '_try.cjs')
  fs.writeFileSync(CHILD, [
    "const path=require('path');const R=process.argv[2],I=process.argv[3];",
    "try{",
    "const {resolveEngineProfile}=require(path.join(R,'lib','engines','profile.js'));",
    "const {engineUiSchema}=require(path.join(R,'lib','engines','paramTable.js'));",
    "const {assembleEnginePayload}=require(path.join(R,'lib','engines','payload.js'));",
    "const {findLegacyDefaultId}=require(path.join(R,'lib','engines','legacyDefault.js'));",
    "const p=resolveEngineProfile(I);engineUiSchema(I);",
    "assembleEnginePayload({profile:p,canonical:{text:'x'},cfg:{},engineParams:{}});",
    "findLegacyDefaultId();console.log('OK');",
    "}catch(e){console.log('THROW|'+(e&&e.code)+'|'+String(e&&e.message).split('\\n')[0]);}",
  ].join('\n'), 'utf8')

  const setPath = (o, kp, v) => {
    const parts = kp.split('.')
    let cur = o
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
      cur = cur[parts[i]]
    }
    cur[parts[parts.length - 1]] = v
  }
  const guess = kp => {
    if (kp === 'legacy_default') return true
    if (kp.endsWith('.default')) {
      const name = kp.split('.').slice(-2)[0]
      if (m.defaults && name in m.defaults) return m.defaults[name]
      return 0
    }
    if (/_ms$|_seconds$|^max_|_rate$/.test(kp)) return 1
    return 'x'
  }

  const MANI = path.join(PROBE_DIR, 'manifest.json')
  const pristine = fs.readFileSync(MANI, 'utf8')
  const verdicts = []
  for (const k of candidates) {
    const trial = JSON.parse(pristine)
    setPath(trial, k, guess(k))
    fs.writeFileSync(MANI, JSON.stringify(trial, null, 2), 'utf8')
    let out = ''
    try {
      out = String(cp.execFileSync(process.execPath, [CHILD, ROOT, PROBE_ID],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim()
    } catch (e) { out = 'THROW|<子进程崩了>|' + String(e && e.message).split('\n')[0] }
    verdicts.push([k, out])
  }
  fs.writeFileSync(MANI, pristine, 'utf8')

  const shouldAdd = verdicts.filter(v => v[1].startsWith('OK'))
  const mustNot = verdicts.filter(v => !v[1].startsWith('OK'))

  console.log('[平台读过、但模板里没有] —— 逐个加进去实测，不是猜：'
    + candidates.length + ' 个')
  console.log('')
  console.log('   ⭐ 真该补（加上去平台照跑不误）：' + shouldAdd.length + ' 个')
  for (const [k] of shouldAdd) console.log('      ⭐ ' + k)
  if (!shouldAdd.length) console.log('      （没有）')
  console.log('')
  console.log('   ⛔ 别写（加上去平台当场抛）：' + mustNot.length + ' 个')
  for (const [k, out] of mustNot) {
    const parts = out.split('|')
    console.log('      ⛔ ' + k)
    console.log('           ' + (parts[1] || '?') + ' | ' + (parts[2] || '').slice(0, 90))
  }
  if (!mustNot.length) console.log('      （没有）')
  console.log('')
  console.log(line)
  console.log('⚠ 「活」是确凿的（真被读了）；「死」只是**这 5 条路上**没读到，')
  console.log('  判它该删之前还要看一眼安装脚本和界面。')
  console.log('⚠ 「别写」也是确凿的（平台真抛了）；「真该补」只说明加了不抛，')
  console.log('  不代表它对 —— 值是本脚本瞎猜的占位值。')
} finally {
  fs.rmSync(PROBE_DIR, { recursive: true, force: true })
  if (fs.existsSync(PROBE_DIR)) {
    console.error('⛔⛔ 清理失败：' + PROBE_DIR + ' 还在盘上，它会被注册表当成真引擎。')
    process.exit(2)
  }
  console.log('临时引擎目录已清理。')
}
process.exit(failed ? 1 : 0)
