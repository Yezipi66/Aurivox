'use strict'

// ---------------------------------------------------------------------------
//  根目录布局守卫（r12c batch13）
// ---------------------------------------------------------------------------
// 根目录是最容易腻掉的地方：每次排查都会落一个探针、每次改动都会
// 落一个补丁，积到一定程度就看不出哪些是产品、哪些是垃圾。
// 让测试盯着，不靠记性。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const P = require('./paths')

const ROOT = P.APP_DIR

// ---------------------------------------------------------------------------
//  准入表 = docs/ROOT_LAYOUT.md，不是这个文件
// ---------------------------------------------------------------------------
// batch13 的第一版守卫是**反过来**写的：列出坏名字的形状
// （apply-* / probe_* / collect_* / sources_*.zip）去抓。
// 2026-08-20 当场失效一次 —— 助手换了个 precheck_ 前缀，守卫一声没响，
// 读数仍是「助手产出物：无 ✅」。**按坏名字认目标 = 只抓我想得到的那几种。**
//
// 改成反向白名单：根目录只允许出现准入表里登记过的条目，多出来的一律红。
// 准入表写在 docs/ROOT_LAYOUT.md（一张 Markdown 表），因为它要给人读；
// 这里只负责解析它。**新增根目录条目的唯一途径是去那张表里登记并写明理由。**

const LAYOUT_DOC = path.join(ROOT, 'docs', 'ROOT_LAYOUT.md')

function parseRootLayout(md) {
  // | `名字` | 类型 | 归属 / 判据 | 必须存在 |
  const rows = []
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 6) continue
    const m = cells[1].match(/^`([^`]+)`$/)
    if (!m) continue
    rows.push({ name: m[1], kind: cells[2], why: cells[3], must: cells[4] === '是' })
  }
  return rows
}

test('根目录准入表本身可解析（防守卫恒真）', () => {
  assert.ok(fs.existsSync(LAYOUT_DOC),
    'docs/ROOT_LAYOUT.md 不在盘上 —— 准入表没了，下面那条守卫会变成恒真')
  const rows = parseRootLayout(fs.readFileSync(LAYOUT_DOC, 'utf8'))
  assert.ok(rows.length >= 20,
    `准入表只解析出 ${rows.length} 条 —— 表格写法多半变了，` +
    '解析不到会让「根目录很干净」和「根本没检查」读数相同')
  for (const anchor of ['server.js', 'lib', 'engines', 'package.json']) {
    assert.ok(rows.some((r) => r.name === anchor),
      `准入表里没有 ${anchor} —— 解析结果不可信`)
  }
})

test('根目录只允许出现准入表登记过的条目', () => {
  const rows = parseRootLayout(fs.readFileSync(LAYOUT_DOC, 'utf8'))
  const allowed = new Set(rows.map((r) => r.name))
  const offenders = fs.readdirSync(ROOT).filter((n) => !allowed.has(n))
  assert.deepEqual(offenders, [],
    `项目根出现未登记条目：${offenders.join('、')} —— ` +
    '要么把它放到该去的地方（助手产出物归 tools/dev/、缓存归 cache/），' +
    '要么去 docs/ROOT_LAYOUT.md 登记并写明「它是什么、丢了会怎样」。' +
    '不写理由的登记等于没有规则')
})

test('准入表里标了「必须存在」的条目必须真在盘上（防表烂掉）', () => {
  const rows = parseRootLayout(fs.readFileSync(LAYOUT_DOC, 'utf8'))
  const missing = rows.filter((r) => r.must && !fs.existsSync(path.join(ROOT, r.name)))
  assert.deepEqual(missing.map((r) => r.name), [],
    '准入表登记了但盘上没有的条目 —— 清单腐烂成「加进去就不红」的垃圾场了')
})

test('根目录不得残留 .bak', () => {
  const offenders = fs.readdirSync(ROOT).filter((n) => n.endsWith('.bak'))
  assert.deepEqual(offenders, [],
    `项目根残留补丁备份：${offenders.join('、')} —— ` +
    '确认不再回滚后归档到 cache/patch-backup/。' +
    '留在根目录会被当成活代码读，读了就会照错的改')
})

test('numba 缓存不得再落在项目根', () => {
  // 落点权威是 lib/paths.js 的 CACHE.numba。infer_server.py 曾经自己硬编码
  // PROJECT_ROOT/.numba_cache，而它是 start.ps1 直接拉起的，不经过 python_helper。
  assert.ok(!fs.existsSync(path.join(ROOT, '.numba_cache')),
    '项目根又出现了 .numba_cache/ —— 有人绕过了 lib/paths.js 的 CACHE.numba，' +
    '去查谁在 setdefault("NUMBA_CACHE_DIR", ...) 里写了自己的落点')
})

test('dump_tree.ps1 引用的目录必须存在（防诊断工具静默失明）', (t) => {
  // 自伤 #17：batch12 把这个脚本改成引用已不存在的 vendor\\uvr5。
  // Dump-Tree 对不存在的目录**不报错、只输出空**，于是
  // 「这棵树是空的」和「这棵树根本没扫」读数一模一样。
  const ps1 = path.join(ROOT, 'tools', 'scripts', 'dump_tree.ps1')
  if (!fs.existsSync(ps1)) {
    t.skip('tools/scripts/dump_tree.ps1 不在盘上')
    return
  }
  const src = fs.readFileSync(ps1, 'utf8')
  const re = /Dump-Tree \(Join-Path \$root '([^']+)'\)\s*'([^']*)'/g
  const missing = []
  let m
  let seen = 0
  while ((m = re.exec(src)) !== null) {
    seen += 1
    const rel = m[1]
    const label = m[2]
    // 标了 (if any) 的是可选目录，不在盘上是正常的。
    if (label.includes('if any')) continue
    const full = path.join(ROOT, rel.split('\\').join(path.sep))
    if (!fs.existsSync(full)) missing.push(rel)
  }
  assert.ok(seen > 0, 'dump_tree.ps1 里一条 Dump-Tree 调用都没解析出来 —— ' +
    '正则跟脚本写法对不上了，这条断言已经变成恒真')
  assert.deepEqual(missing, [],
    `dump_tree.ps1 引用了不存在的目录：${missing.join('、')} —— ` +
    '它是认识盘面的诊断工具，引用失准时输出看起来只是「那里是空的」')
})

// ---------------------------------------------------------------------------
//  GPT_SoVITS：准入表放行的是**空壳**，不是权重树
// ---------------------------------------------------------------------------
// 上游 engines/gpt-sovits/infer/TTS.py 的 TTS_Config.__init__ 里有一句
// 无条件的 os.makedirs("GPT_SoVITS/configs/")，而它是**相对当前工作目录**的，
// 引擎的 CWD 就是项目根（infer_server.py:62 显式 chdir 到根，
// _aurivox_relativise_paths 依赖这个基准，不能动）。
// 于是每次起引擎都会在根上新造一个空目录。它从不被读写：本项目走的是
// lib\inference\tts_infer.yaml 这条绝对路径，"用默认配置" 那个分支永远不进。
//
// ⭐ 为什么不去改上游那一行：那是零功能价值的改动，却要在每次升级上游时
//   重新施加（见 engines/gpt-sovits/infer/LOCAL-CHANGES.md 的维护成本）。
//   所以选择登记 + 锁死：**放行空壳，一旦里面出现文件就红**。
//   否则登记就退化成「把垃圾合法化」，准入表少一道防线。
test('GPT_SoVITS 只准是空壳（准入表放行的是空目录，不是权重树）', (t) => {
  const dir = path.join(ROOT, 'GPT_SoVITS')
  if (!fs.existsSync(dir)) {
    t.skip('根目录没有 GPT_SoVITS —— 引擎还没起过，正常')
    return
  }
  const files = filesUnder(dir)
  assert.deepEqual(files, [],
    `GPT_SoVITS/ 里出现了文件：${files.slice(0, 5).join('、')} —— ` +
    '准入表放行它，放行的只是上游 TTS.py 每次启动无条件造的**空壳**。' +
    '顶层这棵权重树已于 batch14 移出项目：权重归 models/，' +
    '引擎配置归 lib/inference/tts_infer.yaml。' +
    '里面一旦有文件，说明有人把旧布局搬回来了')
})

// 上面那条在盘面干净时是「空 == 空」，天然恒真。
// ⭐ 凡是靠盘面状态说话的守卫，都必须另有一条**拿假盘面验它真能红**的测试，
//   否则「目录是空的」和「这条检查根本没在数东西」读数一模一样。
test('「只准是空壳」这条守卫自己能红（拿假目录验）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-guard-'))
  try {
    assert.deepEqual(filesUnder(tmp), [], '空目录应该数出 0 个文件')
    fs.mkdirSync(path.join(tmp, 'configs'))
    assert.deepEqual(filesUnder(tmp), [], '只有空子目录时仍然算空壳')
    // 权重树的典型形状：藏在子目录里的大文件。守卫必须递归下去才数得到。
    fs.writeFileSync(path.join(tmp, 'configs', 's2G488k.pth'), 'x')
    assert.deepEqual(filesUnder(tmp), [path.join('configs', 's2G488k.pth')],
      '子目录里的文件没被数到 —— 守卫没有递归，权重树塞进去也不会红')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// 空壳能被准入表放行，但它压根不该留在盘上 —— 引擎起来之后会自己把它收掉。
// 这块盯着那段收尾代码还在、且顺序没被挪错。
// ⭐ 先断言三个锚点都还在，再比顺序 —— 否则「整段被删掉」会让 -1 < 任何下标
//   恒成立，守卫变成摆设。
test('引擎起来后会自己收掉那个空壳，且只收空的', () => {
  const py = path.join(ROOT, 'lib', 'inference', 'infer_server.py')
  const src = fs.readFileSync(py, 'utf8')

  // ⛔ 锚点必须写全（带 (): ）。只写前缀 `def _sweep_upstream_shell_dir` 的话，
  //   把函数改名成 _sweep_upstream_shell_dir_x 仍然是它的前缀 —— 定义找得到、
  //   调用处却还指着老名字（起引擎时 NameError），守卫却一声不响。
  //   2026-08-24 突变验证当场抓到这一条。
  const def = src.indexOf('def _sweep_upstream_shell_dir():')
  const tts = src.indexOf('tts_pipeline = TTS(tts_config)')
  const call = src.indexOf('\n_sweep_upstream_shell_dir()')
  assert.ok(def !== -1, 'infer_server.py 里没有 _sweep_upstream_shell_dir —— ' +
    '收尾没了，项目根每次起引擎都会多出一个 GPT_SoVITS/ 空壳')
  assert.ok(tts !== -1, '抓不到 tts_pipeline = TTS(tts_config) —— 锚点漂了，这条断言不可信')
  assert.ok(call !== -1, '_sweep_upstream_shell_dir 定义了却没人调用')

  assert.ok(call > tts,
    '收尾被挪到了 TTS_Config/TTS 构造之前 —— 空壳是 TTS_Config.__init__ 造的，' +
    '提前删会被它随后重新造出来，删了等于没删')

  // ⛔ 只收空的：底下有文件说明有人把旧权重树搬回来了，那是上面那条守卫的活，
  //   轮不到这里悄悄删掉别人的东西。
  const body = src.slice(def, call)
  assert.ok(body.includes('os.walk(shell)'),
    '收尾没有递归查里面有没有文件 —— 会把塞了权重的目录一起删掉')
  assert.match(body, /if files:[\s\S]{0,200}?\n\s+return\n/,
    '收尾少了「有文件就原样留着」这道闸 —— 它会变成一个无差别删目录的东西')
})

// ---------------------------------------------------------------------------
//  .gitignore 不许吞掉产品代码
// ---------------------------------------------------------------------------
// 2026-08-24 差点出事：`.gitignore` 里那条 `cache/` 没有前导斜杠，在 git 里是
// **任意深度**匹配 —— 于是新写的 `lib/cache/` 整个被吞掉。`git add -A` 不报错、
// `git status` 里一个字都不显示，提交完成后 clone 出来的树在
// `server.js` 的 `require("./lib/cache/segmentCache")` 这一行当场崩。
//
// ⭐ 本仓库的打包器早就把这条道理写成明文了（tools/build/04_pack_release.py
//   第 117-119 行）：**通用词只能锚定到顶层**（TOP_EXCLUDE），任意深度那一档
//   （NAME_EXCLUDE）只放 `.venv` / `__pycache__` 这种约定名。`.gitignore` 的
//   文件头也自称「Mirrors pack_sources.py exclusions」，只是这一条漏了锚。
//
// 这块守卫盯的不是「有没有 cache 这个词」，也不是「规则写成了哪种风格」，
// 而是那个**唯一要紧的事实**：产品代码 require 得到的文件，一个都不许被忽略。
// ⭐ 风格（锚定 `/cache/` 还是反选 `!lib/cache/`）是人的偏好；
//   守卫必须照 **git 的语义**判，否则它会把一个能用的修法误判成红。
//   2026-08-24 就是这么被抓到的：第一版守卫不认 `!` 反选，当场误伤。

// 把 .gitignore 解析成 git 认得的三类规则（其余写法一律不认，宁可漏判不误判）：
//   1. 裸目录名  `cache/`      —— **任意深度**匹配目录（事故就出在这一类）
//   2. 锚定目录  `/cache/`     —— 只匹配仓库顶层的那一个
//   3. 反选      `!lib/cache/` —— 把前面某条规则排除掉的东西再收回来
function parseIgnoreRules(text) {
  const rules = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const neg = line.startsWith('!')
    const body = neg ? line.slice(1) : line
    if (!body || body.includes('*') || body.includes('?')) continue
    const dirOnly = body.endsWith('/')
    const p = dirOnly ? body.slice(0, -1) : body
    if (!p) continue
    if (p.startsWith('/')) {
      rules.push({ neg, kind: 'anchored', path: p.slice(1), dirOnly })
    } else if (p.includes('/')) {
      // 带路径分隔符的多段规则，git 同样按仓库根锚定
      rules.push({ neg, kind: 'anchored', path: p, dirOnly })
    } else {
      rules.push({ neg, kind: 'bare', path: p, dirOnly })
    }
  }
  return rules
}

function ruleMatches(rule, prefix, isDir) {
  if (rule.dirOnly && !isDir) return false
  if (rule.kind === 'bare') return prefix.split('/').pop() === rule.path
  return prefix === rule.path
}

// git 的判法：从仓库根一层层往下走，每一层「最后一条命中的规则」说了算；
// 某一层被排除掉且没在**那一层**被反选回来，底下就整个不再下探。
function isIgnored(relPath, rules) {
  const segs = relPath.split('/')
  let ignored = false
  let prefix = ''
  for (let i = 0; i < segs.length; i++) {
    prefix = prefix ? prefix + '/' + segs[i] : segs[i]
    const isDir = i < segs.length - 1
    if (ignored) return true // 父目录已经死了，git 不会再下探
    for (const r of rules) {
      if (ruleMatches(r, prefix, isDir)) ignored = !r.neg
    }
  }
  return ignored
}

// 收集 files 里所有**相对** require 的落点（解析成相对 ROOT 的 posix 路径）。
function localRequireTargets(rootDir, files) {
  const out = []
  for (const abs of files) {
    const src = fs.readFileSync(abs, 'utf8')
    const re = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g
    let m
    while ((m = re.exec(src)) !== null) {
      const spec = m[1]
      const base = path.resolve(path.dirname(abs), spec)
      let hit = null
      for (const cand of [base, base + '.js', base + '.cjs', base + '.json',
        path.join(base, 'index.js')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { hit = cand; break }
      }
      if (!hit) continue // 解析不到的交给别的守卫，这里只管「被吞」
      out.push({
        from: path.relative(rootDir, abs).split(path.sep).join('/'),
        spec,
        target: path.relative(rootDir, hit).split(path.sep).join('/'),
      })
    }
  }
  return out
}

function swallowedRequires(edges, rules) {
  return edges
    .filter((e) => isIgnored(e.target, rules))
    .map((e) => `${e.from} → ${e.spec}（落在 ${e.target}）`)
    .sort()
}

// 只走我们自己写的那几处 node 源码，不下 node_modules / engines / venv。
function ownNodeSources(rootDir) {
  const out = []
  // ⛔ 这里**不能**把 cache / dist 这些名字列进来：被吞掉的目录本身也得走一遍，
  //   否则「唯一 require 它的人就住在它里面」这种情况会被自己漏掉。
  //   起点已经限定在 lib/ 与 server.js，顶层那些重目录压根不会走到。
  const skip = new Set(['node_modules', '.git', '.venv', '__pycache__'])
  const walk = (cur) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      if (skip.has(e.name)) continue
      const next = path.join(cur, e.name)
      if (e.isDirectory()) walk(next)
      else if (/\.(js|cjs)$/.test(e.name)) out.push(next)
    }
  }
  walk(path.join(rootDir, 'lib'))
  const server = path.join(rootDir, 'server.js')
  if (fs.existsSync(server)) out.push(server)
  return out
}

test('.gitignore 不许吞掉产品代码 require 得到的文件', () => {
  const rules = parseIgnoreRules(
    fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'))
  // ⭐ 防恒真：规则一条没解析出来的话，下面的检查等于没检查。
  assert.ok(rules.length >= 10,
    `.gitignore 只解析出 ${rules.length} 条规则 —— ` +
    '要么文件没读到，要么写法变了，这条守卫已经变成摆设')
  assert.ok(rules.some((r) => r.kind === 'bare'),
    '一条「裸目录名」规则都没解析出来 —— 事故就出在这一类，认不出它等于没查')

  const files = ownNodeSources(ROOT)
  const edges = localRequireTargets(ROOT, files)
  // ⭐ 同样防恒真：require 图空的话，「没有一条被吞」是必然成立的废话。
  assert.ok(edges.length >= 50,
    `只解析出 ${edges.length} 条相对 require —— 正常是几百条，正则或目录范围坏了`)

  assert.deepEqual(swallowedRequires(edges, rules), [],
    '这些 require 的落点被 .gitignore 忽略了：git add 会静默跳过它们，' +
    '提交后 clone 出来的树在第一次 require 时就崩。' +
    '⭐ 两种修法都行：把那条通用词规则**锚定到顶层**（写成 /名字/，' +
    '与 tools/build/04_pack_release.py 第 117-119 行同款），' +
    '或者补一条 !路径/ 的反选。改完拿 `git check-ignore -v <文件>` 复核一遍')
})

// 上面那条在盘面干净时是「空 == 空」，天然恒真。这条拿假仓库验它真能红。
test('「不许吞掉产品代码」这条守卫自己能红（拿假仓库验）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ignore-guard-'))
  try {
    // ⭐ 假仓库必须**照着真事故的形状**搭：被吞的目录在 lib/ 底下，不在顶层。
    //   摆在顶层的话，「锚定成 /sub/」那条用例就退化成「它本来就该被忽略」，
    //   验不出「锚定能不能救回来」这件事（第一版就是这么写错的，当场被自己抓到）。
    fs.mkdirSync(path.join(tmp, 'lib', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'lib', 'sub', 'b.js'), 'module.exports = 1\n')
    fs.writeFileSync(path.join(tmp, 'a.js'), "require('./lib/sub/b')\n")
    const edges = localRequireTargets(tmp, [path.join(tmp, 'a.js')])
    assert.deepEqual(edges.map((e) => e.target), ['lib/sub/b.js'],
      'require 落点没解析出来 —— 无后缀的 ./lib/sub/b 必须补出 .js')

    const hit = ['a.js → ./lib/sub/b（落在 lib/sub/b.js）']
    const R = parseIgnoreRules
    // 每一条都写成「.gitignore 原文 → 应不应该红」，跟 git 的行为对齐。
    assert.deepEqual(swallowedRequires(edges, R('sub/\n')), hit,
      '裸目录名没抓出来 —— 这正是 2026-08-24 那次事故的形状，抓不到就是摆设')
    assert.deepEqual(swallowedRequires(edges, R('# sub/\n')), [],
      '注释行被当成了生效规则')
    assert.deepEqual(swallowedRequires(edges, R('!sub/\n')), [],
      '单独一条 ! 反选被当成了「忽略」—— 含义正好反过来')
    assert.deepEqual(swallowedRequires(edges, R('other/\n')), [],
      '不相干的规则也报红 —— 这条守卫会天天误伤')
    // ⛔ 必须按**整段路径名**比，不能按子串：按子串的话规则 `env` 会命中
    //   lib/environment.js 这种无辜文件，守卫会变成天天误伤的噪音。
    assert.deepEqual(swallowedRequires(edges, R('b/\n')), [],
      '按子串匹配了 —— 规则 b 不该命中 sub/b.js 里的 b.js')

    // ⭐⭐ 两种能用的修法都必须判成绿 —— 守卫照 git 的语义判，不照谁的偏好判。
    //   （第一版守卫不认 ! 反选，把一个 git check-ignore 已证明可用的修法误伤成红。）
    assert.deepEqual(swallowedRequires(edges, R('/sub/\n')), [],
      '锚定成 /sub/ 之后仍报红 —— /sub/ 在 git 里只匹配顶层的 sub/，' +
      '够不着 lib/sub/，这是误伤')
    assert.deepEqual(swallowedRequires(edges, R('sub/\n!lib/sub/\n')), [],
      '补了 !lib/sub/ 反选之后仍报红 —— 这是误伤' +
      '（git check-ignore 会说它没被忽略）')
    // 反选必须指得准：反选到别处救不了它
    assert.deepEqual(swallowedRequires(edges, R('sub/\n!other/\n')), hit,
      '反选指到了不相干的路径，却把 lib/sub/ 也一起救了 —— 判反选时没看路径')
    // 顺序也得对：git 是「最后一条命中的说了算」
    assert.deepEqual(swallowedRequires(edges, R('!lib/sub/\nsub/\n')), hit,
      '反选写在忽略规则**前面**时仍判成没忽略 —— git 是后来者居上')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// 递归列出 dir 底下所有**文件**的相对路径（空目录不算）。
function filesUnder(dir) {
  const out = []
  const walk = (cur, rel) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const next = path.join(cur, e.name)
      const nextRel = rel ? path.join(rel, e.name) : e.name
      if (e.isDirectory()) walk(next, nextRel)
      else out.push(nextRel)
    }
  }
  walk(dir, '')
  return out.sort()
}
