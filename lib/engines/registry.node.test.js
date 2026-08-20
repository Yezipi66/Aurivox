'use strict'

// ---------------------------------------------------------------------------
//  引擎注册表 + 顶层目录角色的守卫（r12c）
// ---------------------------------------------------------------------------
// 这些断言存在的原因，是 2026-08-19 那次方向搞反：当时提议把 vendor/ 整体
// 改名成 engines/，会给 ffmpeg / micromamba 这类**我们一行没改过的成品**
// 贴上「我方维护的引擎源码」的标签。人会记错，测试不会。
//
// 判据（docs/ENGINE_CONTRACT.md §2）：
//   engines/   换 TTS 引擎时跟着换；一个目录一个引擎
//   pipeline/  换引擎时不换的第三方工具（打标 / 分离 / 切片）
//   vendor/    第三方成品，我们没改过一行
//   models/    权重
//   data/      用户编辑过、删了要不回来的东西

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const registry = require('./registry')
const P = require('../paths')

const ROOT = P.APP_DIR

function dirsUnder(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

// --- 注册表本身 ------------------------------------------------------------

test('注册表认得盘上的引擎，且 id 与目录名一致', () => {
  const ids = registry.listEngineIds()
  assert.ok(ids.includes('gpt-sovits'),
    `engines/ 下应能发现 gpt-sovits，实际发现：${ids.join('、') || '（空）'}`)
  for (const m of registry.listEngines()) {
    assert.equal(path.basename(m.dir), m.id,
      '引擎目录名必须等于 manifest 里的 id')
  }
})

test('_ 开头的目录是脚手架，不算引擎', () => {
  const ids = registry.listEngineIds()
  assert.ok(!ids.some((id) => id.startsWith('_')),
    `_TEMPLATE 这类脚手架不得被当成可用引擎，实际：${ids.join('、')}`)
  // 反例守卫：模板目录确实在盘上，所以上面那条不是因为「没东西可跳过」才过的。
  assert.ok(dirsUnder(P.ENGINES_DIR).includes('_TEMPLATE'),
    'engines/_TEMPLATE/ 应当存在；它不在了的话，上面那条断言就成了恒真')
})

test('没有 manifest.json 的目录 = 没装（而不是装了一半）', () => {
  // indextts2 目前只有 setup.bat，还没接上。它必须表现为「没装」。
  const onDisk = dirsUnder(P.ENGINES_DIR)
  const ids = registry.listEngineIds()
  for (const name of onDisk) {
    if (name.startsWith('_')) continue
    const hasManifest = fs.existsSync(
      path.join(P.ENGINES_DIR, name, 'manifest.json'))
    assert.equal(ids.includes(name), hasManifest,
      `engines/${name}/ 的可见性必须完全取决于 manifest.json 在不在`)
  }
})

test('要一个没装的引擎，报错里要说清楚装了哪些', () => {
  let caught = null
  try {
    registry.requireEngine('definitely-not-installed')
  } catch (err) {
    caught = err
  }
  assert.ok(caught, '要一个不存在的引擎必须抛错，不能返回 null 让调用方裸奔')
  assert.equal(caught.code, 'FG_ENGINE_UNSUPPORTED')
  assert.ok(Array.isArray(caught.available) && caught.available.length,
    '错误里要带上这台机器上已装的引擎清单，否则排查还得再问一次')
})

test('注册表自己不许写死任何引擎名', () => {
  // 这条是整套设计的命门：一旦有人为图快在 registry.js 里写
  // if (id === 'gpt-sovits')，「加引擎不用改 lib/」当场失效。
  const src = fs.readFileSync(path.join(__dirname, 'registry.js'), 'utf8')
  const code = src
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  for (const name of registry.listEngineIds()) {
    assert.ok(!code.includes(name),
      `registry.js 的代码里出现了具体引擎名 "${name}" —— ` +
      '注册表必须只按目录发现，不得认识任何一个引擎')
  }
})

// --- 参数白名单的归属 -------------------------------------------------------

test('引擎参数白名单归 manifest，adapter 不再自带一份', () => {
  const adapter = fs.readFileSync(
    path.join(__dirname, '..', 'flowgraph', 'adapter.js'), 'utf8')
  // r12c 之前这里硬编码着 GPT-SoVITS 专有的 34 个参数名。抽查其中三个
  // 最不可能出现在别处的，它们若回到 adapter.js，说明白名单又分了家。
  for (const gsvOnly of ['sample_steps', 'split_bucket', 'if_sr']) {
    assert.ok(!adapter.includes(`'${gsvOnly}'`) && !adapter.includes(`"${gsvOnly}"`),
      `adapter.js 里又出现了 GPT-SoVITS 专有参数 ${gsvOnly} —— ` +
      '参数白名单只能有一处，就是 engines/<id>/manifest.json')
  }
  const manifest = registry.requireEngine('gpt-sovits')
  for (const gsvOnly of ['sample_steps', 'split_bucket', 'if_sr']) {
    assert.ok(manifest.param_keys.includes(gsvOnly),
      `manifest 的 param_keys 里少了 ${gsvOnly}；` +
      '上面那条断言会因此变成恒真，正好互为对照')
  }
})

// --- 顶层目录的角色 ---------------------------------------------------------

test('vendor/ 只放成品：改过上游的东西不许待在这', () => {
  // LOCAL-CHANGES.md = 「我们改过上游」的物证。它出现在 vendor/ 下，
  // 就说明那棵树需要我们维护，归 engines/ 或 pipeline/。
  const offenders = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '__pycache__') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name === 'LOCAL-CHANGES.md') {
        offenders.push(path.relative(ROOT, full))
      }
    }
  }
  walk(P.VENDOR_DIR, 0)
  assert.deepEqual(offenders, [],
    'vendor/ 下发现 LOCAL-CHANGES.md —— 我们改过的上游代码归 engines/ 或 pipeline/，' +
    ` vendor/ 只放原封不动的成品。命中：${offenders.join('、')}`)
})

// 上游整包豁免清单。
//
// 有些权重是上游以**整包**分发的，包里除了权重还带着自己的配置代码。
// 那些文件跟着权重一起下载、一起删除、能重新下载 —— 完全符合 models/ 的
// 判据，不是"我们的代码漂进了 models/"。
//
// 豁免必须逐条写明**出处**，并且下面有守卫盯着：豁免的目录若不在盘上，
// 这条清单就该清理了 —— 否则清单会慢慢腐烂成"反正加进去就不红"的垃圾场。
const MODELS_UPSTREAM_BUNDLES = [
  {
    dir: 'models/tts/gpt-sovits/G2PWModel',
    why: 'G2PW 官方以整包 zip 分发（tools/deploy/download_models.py:104-106：' +
      '"官方以整包 zip 分发(含 g2pW.onnx + 配套字典/字表)"）。' +
      '包里的 config.py 是上游的模型配置，不是我们写的代码。',
  },
]

test('models/ 只放权重：我们的代码不许混进去', (t) => {
  // models/ 不进 git，助手侧的裁剪树上没有它。那种情况下遍历会得到空集，
  // 这条断言就变成「恒真通过」—— 与「真的检查过并且干净」长得一模一样。
  // 所以先显式确认目标存在，不存在就 skip，让读数如实反映「没测」。
  if (!fs.existsSync(P.MODELS_DIR)) {
    t.skip(`models/ 不在盘上（${P.MODELS_DIR}）—— 这条只在真机有意义`)
    return
  }
  // 路径一律归一化成正斜杠再比对。Windows 上 path.relative 给的是反斜杠，
  // 拿去和清单里的正斜杠比会**静默失配**，豁免看起来"没生效"。
  const norm = (p) => p.split(path.sep).join('/')
  const exempt = MODELS_UPSTREAM_BUNDLES.map((b) => b.dir)

  const offenders = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    const relDir = norm(path.relative(ROOT, dir))
    if (exempt.some((x) => relDir === x || relDir.startsWith(x + '/'))) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === '__pycache__' || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (/\.(py|js|cjs|mjs)$/.test(e.name)) {
        offenders.push(norm(path.relative(ROOT, full)))
      }
    }
  }
  walk(P.MODELS_DIR, 0)
  assert.deepEqual(offenders, [],
    `models/ 下发现代码文件：${offenders.join('、')} —— ` +
    'models/ 只放权重。若这是上游整包自带的文件，把它的目录登记进 ' +
    '本文件的 MODELS_UPSTREAM_BUNDLES 并写明出处；' +
    '若是我们自己的代码，它归 engines/ / pipeline/ / lib/')
})

test('上游整包豁免清单不许腐烂', (t) => {
  // 豁免清单最容易的死法是：目录早就没了，条目还留着，于是它豁免的是
  // 一个不存在的东西 —— 既不报错也不起作用，下次真出问题时没人发现。
  if (!fs.existsSync(P.MODELS_DIR)) {
    t.skip('models/ 不在盘上 —— 这条只在真机有意义')
    return
  }
  const stale = MODELS_UPSTREAM_BUNDLES
    .filter((b) => !fs.existsSync(path.join(ROOT, b.dir.split('/').join(path.sep))))
    .map((b) => b.dir)
  assert.deepEqual(stale, [],
    `豁免清单里这些目录已经不在盘上：${stale.join('、')} —— ` +
    '请从 MODELS_UPSTREAM_BUNDLES 里删掉，别让清单变成垃圾场')
  for (const b of MODELS_UPSTREAM_BUNDLES) {
    assert.ok(b.why && b.why.length > 20,
      `豁免 ${b.dir} 没写明出处。豁免必须能追溯到上游，否则下一个人无从判断`)
  }
})

test('pipeline/ 是引擎无关的：它不该认识任何一个引擎', () => {
  // asr / uvr5 / slicer 是训练任何引擎都要用的工具。它们一旦提到某个具体
  // 引擎，就说明「换引擎时不换」这条判据破了，该重新归类。
  const ids = registry.listEngineIds()
  const offenders = []
  const walk = (dir, depth) => {
    if (depth > 2) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === '__pycache__' || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!/\.(py|js)$/.test(e.name)) continue
      let src
      try {
        src = fs.readFileSync(full, 'utf8')
      } catch {
        continue
      }
      // 只看代码行，注释里提到引擎名（说明来历）是允许的。
      const code = src.split(/\r?\n/)
        .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
        .join('\n')
      for (const id of ids) {
        if (code.includes(id)) offenders.push(`${path.relative(ROOT, full)} -> ${id}`)
      }
    }
  }
  walk(P.PIPELINE_DIR, 0)
  assert.deepEqual(offenders, [],
    `pipeline/ 的代码里提到了具体引擎：${offenders.join('、')} —— ` +
    'pipeline/ 装的是所有引擎共用的工具，认识某个引擎就说明它放错地方了')
})

test('没有分段拼出来的旧路径（字符串替换看不见这种写法）', () => {
  // r12c 搬家时，全仓做了 "vendor/tts/gpt-sovits" -> "engines/gpt-sovits"
  // 的文本替换。但有几处写的是分段形式 —— 把目录名拆成一个个独立的字符串
  // 参数传给 os.path.join / path.join（infer_server.py、download_models.py、
  // paths.node.test.js 都中过招）。
  //
  // 注：这里不照抄那种写法当例子，因为 lib/paths.node.test.js 的路径权威守卫
  // 连注释一起扫，照抄会被它判成越权 —— 那条守卫是对的，别为了写注释去
  // 给它加豁免。
  //
  // 源码里根本不存在 "vendor/tts" 这个子串，替换扫不到，于是它们静静地
  // 指向搬走后的空位置。其中 infer_server.py 那处不在任何 JS 测试的覆盖面内
  // ——「测试全绿但服务起不来」正是这么来的。
  const MOVED = [
    ['vendor', 'tts'],
    ['vendor', 'asr'],
    ['vendor', 'uvr5'],
    ['vendor', 'slicer'],
  ]
  const offenders = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (['node_modules', '__pycache__', '.git', 'venv', 'models',
        'engines', 'pipeline', 'vendor'].includes(e.name)) continue
      // 补丁脚本（apply-*.py）里存着"搬家前的原文"作为替换锚点，那是
      // 它的工作内容，不是活代码里的路径引用。备份件同理。这两类跳过的
      // 理由与 apply-r12c-batch12.py 的 SWEEP_SKIP_PREFIX 是同一条。
      if (/^apply-.*\.py$/.test(e.name)) continue
      if (/\.bak$|\.orig$|\.r12c-.*\.bak$/.test(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!/\.(py|js|cjs|mjs)$/.test(e.name)) continue
      let src
      try {
        src = fs.readFileSync(full, 'utf8')
      } catch {
        continue
      }
      for (const [a, b] of MOVED) {
        // 匹配 "vendor", "tts"  /  'vendor', 'tts'（允许中间有空白）
        const re = new RegExp(`['"]${a}['"]\\s*,\\s*['"]${b}['"]`)
        if (re.test(src)) {
          offenders.push(`${path.relative(ROOT, full)} -> ${a}/${b}`)
        }
      }
    }
  }
  walk(ROOT, 0)
  assert.deepEqual(offenders, [],
    `发现分段拼接的旧路径：${offenders.join('、')} —— ` +
    '这些位置已在 r12c 搬走。分段写法躲得过字符串替换，只能靠这条断言抓。' +
    '正确写法是从 lib/paths.js 取常量，别自己拼')
})

test('搬家没留旧落点：vendor/ 下不再有 tts / asr / uvr5 / slicer', () => {
  for (const dead of ['tts', 'asr', 'uvr5', 'slicer']) {
    assert.ok(!fs.existsSync(path.join(P.VENDOR_DIR, dead)),
      `vendor/${dead}/ 仍在盘上 —— r12c 之后它应分别位于 engines/ 或 pipeline/。` +
      '两处都有内容时，改哪边生效取决于调用方，会出极难查的问题')
  }
})
