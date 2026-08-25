#!/usr/bin/env node
'use strict'

// ---------------------------------------------------------------------------
//  probe_new_engine — 造一台什么都不会的假引擎，看平台在第几步倒下
// ---------------------------------------------------------------------------
// 为什么要有这个脚本：
//
// 平台的终局是「加一台 TTS 引擎 = 新建 engines/<id>/ + 写 manifest.json，
// lib/ / server.js / web/ / 启动脚本一个字不改」。这句话一直**没有判据** ——
// 833 个测试全绿只证明老引擎没坏，证明不了新引擎变好进了。
//
// 这个脚本就是那个判据。它造一台叫 smoketest 的引擎，**只有名片、没有一行
// 代码**，然后推着平台一路往前走，记录它在第几步倒下、报什么错。
//
// ⭐ 它不是一次性脚本。拆 lib/gsv/ 那个「房东的房间」之前跑一遍存成基线，
//   拆完再跑一遍 —— **两次墙清单之差，就是「铺路铺了多少」的量化读数**。
//
// ⭐⭐ 关键设计：**必填字段清单是问出来的，不是我抄文档抄来的。**
//    做法是循环：解析名片 → 平台喊「缺 X」→ 填上 X → 再解析。
//    平台不喊了，那张填出来的表就是「上游作者必须写的全部字段」，
//    而且它永远跟代码同步 —— 文档会过期，这个循环不会。
//
// ⛔ 本脚本会**临时创建 engines/smoketest/**，跑完在 finally 里删掉。
//    留在盘上是有代价的：它会被 registry 当成真引擎列进下拉框，还会
//    进发行包（data/ 那个洞刚修完，别在 engines/ 上再开一个）。
//    所以清理失败必须**喊**，见文件末尾的 assertGone()。
//
// 用法：
//    node tools/dev/probe_new_engine.cjs
//    node tools/dev/probe_new_engine.cjs --keep     跑完不删（排查用，会警告）
//    node tools/dev/probe_new_engine.cjs --selftest 只跑守卫自检

const fs = require('fs')
const path = require('path')

// 仓库根 = 本脚本所在目录（tools/dev/）往上两级 ⇒ 换机器不用改常量。
const ROOT = path.resolve(__dirname, '..', '..')
const ENGINES_DIR = path.join(ROOT, 'engines')
const SMOKE_ID = 'smoketest'
const SMOKE_DIR = path.join(ENGINES_DIR, SMOKE_ID)
const TEMPLATE_MANIFEST = path.join(ENGINES_DIR, '_TEMPLATE', 'manifest.json')

const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const SELFTEST_ONLY = argv.includes('--selftest')

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------
function line(s) { process.stdout.write(s + '\n') }

function rmrf(p) {
  // Node 14 没有 fs.rmSync 的 force/recursive 组合，这里两种都试。
  try { fs.rmSync(p, { recursive: true, force: true }); return } catch (e) { /* fall through */ }
  try { fs.rmdirSync(p, { recursive: true }) } catch (e) { /* already gone */ }
}

// 名片里 `_comment_*` 是写给人看的，平台一个都不读。带着它们跑不影响结果，
// 但会让「填出来的那张表」混进一堆噪声，所以先剥掉。
function stripComments(obj) {
  if (Array.isArray(obj)) return obj.map(stripComments)
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const k of Object.keys(obj)) {
    if (k.startsWith('_comment')) continue
    out[k] = stripComments(obj[k])
  }
  return out
}

function getPath(obj, keyPath) {
  let cur = obj
  for (const seg of keyPath.split('.')) {
    if (cur === undefined || cur === null) return undefined
    cur = cur[seg]
  }
  return cur
}

function setPath(obj, keyPath, value) {
  const segs = keyPath.split('.')
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    // 路径里出现纯数字 ⇒ 上一层该是数组（runtime.verify.imports.0.module）
    const nextIsIndex = /^\d+$/.test(segs[i + 1])
    if (cur[seg] === undefined || cur[seg] === null || typeof cur[seg] !== 'object') {
      cur[seg] = nextIsIndex ? [] : {}
    }
    cur = cur[seg]
  }
  cur[segs[segs.length - 1]] = value
}

// ---------------------------------------------------------------------------
//  猜一个「像样的值」填进去
// ---------------------------------------------------------------------------
// ⚠ 这里猜的值**不是建议值**，只是为了让循环能往下走一步。
//   脚本最后打印的是**键名清单**，不是这些值 —— 别把占位值当成推荐配置。
function guessValue(keyPath, wantNumber) {
  const leaf = keyPath.split('.').pop()
  if (wantNumber || /_ms$/.test(leaf)) {
    if (/timeout/.test(leaf)) return 60000
    if (/sample_rate/.test(leaf)) return 22050
    if (/max_chars/.test(leaf)) return 200
    return 1
  }
  if (leaf === 'max_chars') return 200
  if (/sample_rate/.test(leaf)) return 22050
  // maps.<平台的词> 要的是「这台引擎管这个概念叫什么键名」。拿平台自己的词
  // 当占位是安全的：它一定是个合法键名，且一眼能看出没改过。
  if (keyPath.startsWith('maps.')) return leaf
  if (keyPath.startsWith('capabilities.')) return false
  if (leaf === 'python') return '.venv/Scripts/python.exe'
  if (leaf === 'entry') return 'shim.py'
  if (leaf === 'ready_endpoint') return '/health'
  if (leaf === 'module') return 'os'
  if (/base_url/.test(leaf)) return 'http://127.0.0.1:19999'
  return 'PLACEHOLDER'
}

// ---------------------------------------------------------------------------
//  写名片
// ---------------------------------------------------------------------------
function writeManifest(manifest) {
  fs.mkdirSync(SMOKE_DIR, { recursive: true })
  fs.writeFileSync(path.join(SMOKE_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2), 'utf8')
}

// 每次都重新 require，避免平台内部对名片做了缓存导致我们量到的是旧值。
function freshRequire(rel) {
  const full = require.resolve(path.join(ROOT, rel))
  delete require.cache[full]
  return require(full)
}

// ---------------------------------------------------------------------------
//  第一问：照着 _TEMPLATE 抄，平台要喊多少次「你还少写了一行」
// ---------------------------------------------------------------------------
const MAX_ROUNDS = 60

// ⭐⭐ 循环必须**跨越所有阶段**，不能只问名片解析那一关。
//    实测教训：`maps.text` 在 resolveEngineProfile 阶段一声不吭，直到拼请求体
//    才喊出来。只问第一关的话，「上游作者必须写什么」这张表是残缺的 ——
//    作者会以为名片写完了，等到真去合成才发现还差一段。
//    所以这里的规矩是：**任何一个阶段喊「缺一行」，都算平台在开口要**，
//    填上以后从头再走一遍，直到从头到尾没人再开口。
function fillableFrom(err) {
  const code = err && err.code
  if (code === 'ENGINE_MANIFEST_INCOMPLETE' && err.missing) {
    return { key: err.missing, why: 'required', code, wantNumber: false }
  }
  if (code === 'ENGINE_MANIFEST_INVALID_VALUE' && err.key) {
    return { key: err.key, why: 'invalid', code, wantNumber: true }
  }
  return null
}

function interrogate(startManifest) {
  const manifest = JSON.parse(JSON.stringify(startManifest))
  manifest.id = SMOKE_ID
  const asked = []          // 平台开口要过的字段，按被要的顺序
  let rounds = 0
  let profile = null
  let fatal = null
  let stages = []

  while (rounds < MAX_ROUNDS) {
    rounds++
    writeManifest(manifest)

    // ── 第一关：名片本身能不能解析 ──
    let err = null
    try {
      const { resolveEngineProfile } = freshRequire('lib/engines/profile.js')
      profile = resolveEngineProfile(SMOKE_ID)
    } catch (e) { err = e; profile = null }

    if (err) {
      const fill = fillableFrom(err)
      if (!fill) {
        fatal = { code: err.code || '(无 code)', message: err.message || String(err), at: '名片解析' }
        break
      }
      asked.push(Object.assign({ at: '名片解析' }, fill))
      setPath(manifest, fill.key, guessValue(fill.key, fill.wantNumber))
      continue
    }

    // ── 后面几关：名片过了，看平台还要什么 ──
    stages = walkStages(profile, manifest)
    const asking = stages.find((s) => !s.ok && s.fill)
    if (asking) {
      asked.push(Object.assign({ at: asking.name }, asking.fill))
      setPath(manifest, asking.fill.key, guessValue(asking.fill.key, asking.fill.wantNumber))
      continue
    }
    break     // 从头到尾没人再开口 ⇒ 问完了
  }

  if (rounds >= MAX_ROUNDS && !fatal) {
    fatal = { code: 'PROBE_LOOP_LIMIT', at: '循环',
      message: '填了 ' + MAX_ROUNDS + ' 轮平台还在要字段 —— 要么名片确实这么长，要么我猜的值一直不被接受。' }
  }

  return { manifest, asked, rounds, profile, fatal, stages }
}

// ---------------------------------------------------------------------------
//  第二问：名片过了之后，平台还有哪几堵墙
// ---------------------------------------------------------------------------
function walkStages(profile, manifest) {
  const stages = []
  const add = (name, fn) => {
    try {
      const detail = fn()
      stages.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
    } catch (e) {
      stages.push({
        name,
        ok: false,
        detail: (e && e.code ? e.code + ' | ' : '') + ((e && e.message) || String(e)),
        fill: fillableFrom(e),   // 非 null ⇒ 这堵墙是「少写一行」，能填了继续走
      })
    }
  }

  add('注册表认得它（listEngineIds 里有 smoketest）', () => {
    const { listEngineIds } = freshRequire('lib/engines/registry.js')
    const ids = listEngineIds()
    if (!ids.includes(SMOKE_ID)) throw new Error('不在清单里：' + ids.join(', '))
    return '同台机器上共 ' + ids.length + ' 台：' + ids.join(', ')
  })

  add('界面参数格子（engineUiSchema）', () => {
    const { engineUiSchema } = freshRequire('lib/engines/paramTable.js')
    const schema = engineUiSchema(SMOKE_ID)
    const n = Array.isArray(schema) ? schema.length : Object.keys(schema || {}).length
    return n + ' 个格子'
  })

  add('拼请求体（assembleEnginePayload）', () => {
    const { assembleEnginePayload } = freshRequire('lib/engines/payload.js')
    const body = assembleEnginePayload({
      profile,
      canonical: {
        text: '铺路探针',
        text_lang: 'zh',
        reference_audio: 'ref.wav',
        reference_text: '',
        reference_lang: 'zh',
      },
      cfg: {},
      engineParams: {},
    })
    return Object.keys(body || {}).length + ' 个键：' + Object.keys(body || {}).join(', ')
  })

  add('环境体检（checkEngineEnvShallow）', () => {
    const { checkEngineEnvShallow } = freshRequire('lib/engines/envCheck.js')
    const r = checkEngineEnvShallow(profile)
    // 假引擎没装环境，**报「没装」是正确答案**，不是墙。
    return JSON.stringify(r).slice(0, 160)
  })

  add('老路兜底（findLegacyDefaultId）', () => {
    const { findLegacyDefaultId } = freshRequire('lib/engines/legacyDefault.js')
    return '老路默认引擎 = ' + String(findLegacyDefaultId())
  })

  return stages
}

// ---------------------------------------------------------------------------
//  守卫自检 —— 判据自己得先立得住
// ---------------------------------------------------------------------------
function selftest() {
  const checks = []
  const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, detail: detail || '' })

  ok('setPath 能建嵌套路径',
    (() => { const o = {}; setPath(o, 'a.b.c', 1); return o.a && o.b === undefined && o.a.b && o.a.b.c === 1 })(),
    '')
  ok('setPath 遇到数字段建数组',
    (() => { const o = {}; setPath(o, 'r.imports.0.module', 'os'); return Array.isArray(o.r.imports) && o.r.imports[0].module === 'os' })(),
    '')
  ok('stripComments 剥掉 _comment_* 且保留其余',
    (() => { const o = stripComments({ _comment_x: 1, a: { _comment_y: 2, b: 3 } }); return o._comment_x === undefined && o.a.b === 3 && o.a._comment_y === undefined })(),
    '')
  ok('guessValue 对 *_ms 给数字',
    typeof guessValue('runtime.ready_timeout_ms', false) === 'number', '')
  ok('guessValue 对 capabilities.* 给布尔',
    typeof guessValue('capabilities.streaming', false) === 'boolean', '')
  ok('_ 开头的目录被注册表跳过（所以假引擎不能叫 _smoke）',
    (() => {
      const { listEngineIds } = freshRequire('lib/engines/registry.js')
      return !listEngineIds().some((x) => x.startsWith('_'))
    })(), '')
  ok('模板名片文件存在', fs.existsSync(TEMPLATE_MANIFEST), TEMPLATE_MANIFEST)
  ok('探针目录此刻不存在（不然是上次没清理干净）',
    !fs.existsSync(SMOKE_DIR), SMOKE_DIR)

  return checks
}

// ---------------------------------------------------------------------------
//  清理必须验得出来
// ---------------------------------------------------------------------------
function assertGone() {
  if (fs.existsSync(SMOKE_DIR)) {
    line('')
    line('⛔⛔ 清理失败：' + SMOKE_DIR + ' 还在盘上。')
    line('    它会被注册表当成真引擎列进下拉框，还会跟着进发行包。')
    line('    请手动删掉：Remove-Item .\\engines\\' + SMOKE_ID + ' -Recurse -Force')
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
//  主流程
// ---------------------------------------------------------------------------
function main() {
  line('probe_new_engine   —— 造一台只有名片的假引擎，看平台在第几步倒下')
  line('项目根：' + ROOT)
  line('='.repeat(74))
  line('')

  line('[自检]')
  const checks = selftest()
  for (const c of checks) {
    line('   ' + (c.ok ? 'ok  ' : 'FAIL') + '  ' + c.name + (c.detail ? '   ' + c.detail : ''))
  }
  const failed = checks.filter((c) => !c.ok).length
  line('')
  line('   自检：' + (checks.length - failed) + ' ok / ' + failed + ' FAIL')
  if (failed) {
    line('')
    line('⛔ 自检没过，后面的读数不可信，就此打住。')
    return 1
  }
  if (SELFTEST_ONLY) return 0

  let exitCode = 0
  try {
    const template = stripComments(JSON.parse(fs.readFileSync(TEMPLATE_MANIFEST, 'utf8')))

    line('')
    line('[1] 照着 engines/_TEMPLATE 抄一份，平台会喊几次「你还少写了一行」')
    const r = interrogate(template)
    if (r.asked.length === 0) {
      line('   ✅ 一次没喊 —— 模板名片直接就能用。')
    } else {
      line('   ⛔ 平台开口要了 ' + r.asked.length + ' 个字段（共 ' + r.rounds + ' 轮），模板里一个都没有：')
      let lastAt = null
      for (const a of r.asked) {
        if (a.at !== lastAt) { line('     ── 在「' + a.at + '」这一关 ──'); lastAt = a.at }
        line('        ' + (a.why === 'required' ? '缺  ' : '值错') + '  ' + a.key)
      }
      line('')
      line('   ⇒ 上游作者照模板抄出来的名片，**平台直接抛**。')
      line('     这是 onboarding 的第一堵墙，而且是我们自己砌的。')
      line('   ⭐ 注意有几关是**过了第一关才喊**的 —— 作者会以为名片写完了，')
      line('     等到真去合成才发现还差一段。这也算墙。')
    }
    if (r.fatal) {
      line('')
      line('   ⛔ 在「' + r.fatal.at + '」撞上一个填不动的错（第 ' + r.rounds + ' 轮）：')
      line('        ' + r.fatal.code + ' | ' + r.fatal.message)
    }

    line('')
    line('[2] 把平台要的都填满之后，它还有哪几堵墙')
    if (!r.profile) {
      line('   （名片还没能加载，走不到这一步）')
    } else {
      for (const s of r.stages) {
        line('   ' + (s.ok ? '✅' : '⛔') + '  ' + s.name)
        if (s.detail) line('        ' + s.detail)
      }
      line('')
      const walls = r.stages.filter((s) => !s.ok)
      line('   墙：' + walls.length + ' 堵 / 共 ' + r.stages.length + ' 步')
      if (walls.length === 0) {
        line('   ⇒ 一台**只有名片、没有一行代码**的引擎，能一路走到「环境没装」')
        line('     这个正确结论。平台侧的路是通的。')
      }
    }

    line('')
    line('[3] 这台假引擎最终需要的完整名片（键名清单，不是推荐值）')
    const keys = []
    const walk = (obj, prefix) => {
      for (const k of Object.keys(obj)) {
        const kp = prefix ? prefix + '.' + k : k
        const v = obj[k]
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, kp)
        else keys.push(kp)
      }
    }
    walk(r.manifest, '')
    line('   共 ' + keys.length + ' 个叶子键。平台开口要过的 ' + r.asked.length + ' 个已在 [1] 列出。')
  } finally {
    if (KEEP) {
      line('')
      line('⚠ --keep：' + SMOKE_DIR + ' 留在盘上了，记得自己删。')
    } else {
      rmrf(SMOKE_DIR)
      if (!assertGone()) exitCode = 2
      else {
        line('')
        line('探针目录已清理，engines/ 恢复原样。本脚本没有改过任何产品代码。')
      }
    }
  }
  return exitCode
}

process.exitCode = main()
