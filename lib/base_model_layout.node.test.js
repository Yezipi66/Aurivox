// 底模布局与下载器落点的守卫。
//
// 这两件事此前各写各的：lib/paths.js 说权重在 models/ 下、按版本分目录，而
// tools/deploy/download_models.py 还把文件下到 r12a 之前的 vendor/gsv-tools/ 下。
// 两边都"正常工作"——下载全部成功、校验全部通过——只是下完的文件没有任何代码
// 会去读。这类分叉不会自己暴露，只能靠守卫钉住。
//
// 因此本文件断言的是"两份声明相等"，不是"某个字符串出现过"：
//   1. 四个版本目录各自只装本版本的权重；
//   2. 下载器的四个落点根 == paths.js 的对应常量；
//   3. 下载器里每一条底模落点 == BASE_WEIGHTS 里的某一条；
//   4. 分离权重的落点带上了 uvr5_models.js 要求的架构目录；
//   5. MODEL_SOURCES.json 的 artifact 全部在 models/ 下。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PATHS = require('./paths')
const UVR5 = require(path.join(PATHS.UVR5_DIR, 'uvr5_models.js'))

const DL = fs.readFileSync(
  path.join(ROOT, 'tools', 'deploy', 'download_models.py'), 'utf8')

// 把 os.path.join("a", "b", ...) 的实参抠出来，拼成 posix 相对路径。
function joinArgs(src) {
  const m = /^os\.path\.join\((.*)\)$/s.exec(src.trim())
  if (!m) return null
  return m[1].split(',').map((x) => {
    const s = /^\s*"([^"]*)"\s*$/.exec(x)
    return s ? s[1] : null
  }).filter(Boolean).join('/')
}

// 下载器里 PRE / ASR / UVR / FUNASR_DIR / LANGDETECT_DIR 的赋值。
function constOf(name) {
  const re = new RegExp('^' + name + ' = (os\\.path\\.join\\([^\\n]*\\))', 'm')
  const m = re.exec(DL)
  assert.ok(m, `download_models.py 里找不到常量 ${name}`)
  return joinArgs(m[1])
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

test('底模一版一目录：每个版本目录只放本版本的权重', () => {
  // 断言的是布局表 BASE_WEIGHTS_CANONICAL，不是运行期解析结果 BASE_WEIGHTS ——
  // 后者在还没搬家的机器上会回退到旧路径，用它当判据等于让守卫随盘上状态变化。
  const W = PATHS.BASE_WEIGHTS_CANONICAL
  const D = PATHS.BASE_DIRS
  assert.deepStrictEqual(Object.keys(D).sort(),
    ['v1', 'v2', 'v2Pro', 'v2ProPlus'])

  // <权重键> -> 它应该落在哪个版本目录。s1_v2 归 v2/：GPT 侧上游只有两份底模，
  // v2 / v2Pro / v2ProPlus 共用 v2 的那一份，所以 v2Pro/ 与 v2ProPlus/ 下不该有 s1。
  const EXPECT = {
    s1_v1: 'v1', s2G_v1: 'v1', s2D_v1: 'v1',
    s1_v2: 'v2', s2G_v2: 'v2', s2D_v2: 'v2',
    s2G_v2Pro: 'v2Pro', s2D_v2Pro: 'v2Pro',
    s2G_v2ProPlus: 'v2ProPlus', s2D_v2ProPlus: 'v2ProPlus',
  }
  assert.deepStrictEqual(Object.keys(W).sort(), Object.keys(EXPECT).sort(),
    'BASE_WEIGHTS 的键集合变了；改动底模集合时必须同步本表')

  for (const [key, ver] of Object.entries(EXPECT)) {
    assert.strictEqual(path.dirname(W[key]), D[ver],
      `${key} 应落在 ${ver}/ 下，实际是 ${rel(W[key])}`)
  }

  // 运行期解析出来的路径，只允许是"新位置"或"该键登记的旧位置"这两者之一。
  // 这条才是回退逻辑的守卫：它允许没搬家的机器读旧文件，但不允许回退到别的地方。
  for (const [key, p] of Object.entries(PATHS.BASE_WEIGHTS)) {
    const allowed = [W[key], PATHS.BASE_WEIGHTS_LEGACY[key]].filter(Boolean)
    assert.ok(allowed.includes(p),
      `${key} 解析成了 ${rel(p)}，既不是新位置也不是登记在案的旧位置`)
  }

  // v2Pro / v2ProPlus 目录下不得出现 GPT 权重。
  for (const [key, p] of Object.entries(W)) {
    if (!key.startsWith('s1_')) continue
    const dir = path.dirname(p)
    assert.notStrictEqual(dir, D.v2Pro, 's1 不属于 v2Pro/')
    assert.notStrictEqual(dir, D.v2ProPlus, 's1 不属于 v2ProPlus/')
  }
})

test('下载器的落点根与 lib/paths.js 一致', () => {
  const EXPECT = {
    PRE: rel(PATHS.GSV_PRETRAINED_DIR),
    ASR: rel(path.join(PATHS.FASTER_WHISPER_DIR, 'large-v3-turbo')),
    UVR: rel(PATHS.UVR5_WEIGHTS_DIR),
    FUNASR_DIR: rel(PATHS.FUNASR_MODELS_DIR),
    LANGDETECT_DIR: rel(PATHS.PRETRAINED.langdetect),
  }
  for (const [name, want] of Object.entries(EXPECT)) {
    assert.strictEqual(constOf(name), want,
      `download_models.py 的 ${name} 与 paths.js 分叉了`)
  }
})

test('下载器里不得再出现已废弃的 vendor/gsv-tools 落点', () => {
  // 只看落点常量所在的那一段（文件头的历史说明里允许提到这个名字）。
  const seg = DL.slice(DL.indexOf('GSV_CODE = '), DL.indexOf('MANIFEST = '))
  const bad = seg.split('\n').filter((l) =>
    /os\.path\.join\(/.test(l) && /"gsv-tools"/.test(l))
  assert.deepStrictEqual(bad, [],
    '落点仍指向 vendor/gsv-tools/：那里从 r12b 起就没有权重了，下载会全部落空')
})

test('下载器的底模落点逐条等于底模布局表', () => {
  // MANIFEST 里出现的 os.path.join(PRE, ...) 里，凡是落到版本目录的，都必须
  // 在 BASE_WEIGHTS 里找得到同一条路径。这里断言的是"几条、分别是哪条"，
  // 而不是"某个名字出现过"——后者对多调用点无效。
  // 用布局表比，不用运行期解析结果比：下载器要把文件下到"应该在的地方"，
  // 这跟这台机器现在搬没搬家无关。
  const want = new Set(Object.values(PATHS.BASE_WEIGHTS_CANONICAL).map(rel))
  const VER = new Set(['v1', 'v2', 'v2Pro', 'v2ProPlus'])
  const got = []
  const re = /os\.path\.join\(PRE,\s*"([^"]+)",\s*"([^"]+)"\)/g
  let m
  while ((m = re.exec(DL))) {
    if (!VER.has(m[1])) continue
    got.push(`${rel(PATHS.GSV_PRETRAINED_DIR)}/${m[1]}/${m[2]}`)
  }
  assert.strictEqual(got.length, 10,
    `下载器里应有 10 条底模落点，实际 ${got.length} 条`)
  assert.deepStrictEqual([...got].sort(), [...want].sort(),
    '下载器的底模落点与 BASE_WEIGHTS_CANONICAL 对不上（多一条、少一条或指错目录）')
  // 反向：v1 的两个 SoVITS 权重必须下到 v1/，这是原布局错得最狠的一处。
  assert.ok(DL.includes('os.path.join(PRE, "v1", "s2G488k.pth")'))
  assert.ok(DL.includes('os.path.join(PRE, "v1", "s2D488k.pth")'))
})

test('分离权重的落点带上了架构目录', () => {
  // uvr5_models.js 只在 <weightsDir>/<arch>/ 下认权重，扁平放一律算未安装。
  const byFile = new Map()
  for (const m of UVR5.listModels ? UVR5.listModels() : UVR5.MODELS || []) {
    for (const f of m.files) byFile.set(f.split('/').pop(), m.arch)
  }
  assert.ok(byFile.size >= 9, `分离模型注册表只解析出 ${byFile.size} 个权重`)

  const re = /os\.path\.join\(UVR,\s*"([^"]+)"(?:,\s*"([^"]+)")?(?:,\s*"([^"]+)")?\)/g
  let m
  let n = 0
  while ((m = re.exec(DL))) {
    const parts = [m[1], m[2], m[3]].filter(Boolean)
    const arch = parts[0]
    const file = parts[parts.length - 1]
    assert.ok(['vr', 'mdx', 'roformer'].includes(arch),
      `分离权重落点第一段应是架构目录，实际是 ${arch}`)
    const want = byFile.get(file)
    if (want) {
      assert.strictEqual(arch, want,
        `${file} 属于 ${want}，却下到了 ${arch}/`)
    }
    n++
  }
  assert.ok(n >= 9, `下载器里的分离权重落点只有 ${n} 条`)
})

test('训练与服务端的底模候选表：新路径必须排在旧路径之前', () => {
  // train.js 的 resolvePretrained() 与 server.js 的 _mvFirstExisting() 都是
  // 「取第一个存在的候选」。旧路径留着是为了让还没搬文件的机器继续能跑，但一旦
  // 旧路径排到前面，已经搬完家的机器就会去找一个空目录，然后报「底模缺失」。
  const FILES = [
    path.join(ROOT, 'lib', 'training', 'steps', 'train.js'),
    path.join(ROOT, 'server.js'),
  ]
  // [新, 旧]
  const ORDER = [
    ['v2/s2G2333k.pth', 'gsv-v2final/s2G2333k.pth'],
    ['v2/s2D2333k.pth', 'gsv-v2final/s2D2333k.pth'],
    ['v1/s2G488k.pth', 'v2Pro/s2G488k.pth'],
    ['v1/s2D488k.pth', 'v2Pro/s2D488k.pth'],
    ['v2ProPlus/s2Gv2ProPlus.pth', 'v2Pro/s2Gv2ProPlus.pth'],
    ['v2ProPlus/s2Dv2ProPlus.pth', 'v2Pro/s2Dv2ProPlus.pth'],
  ]
  let checked = 0
  for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8')
    for (const [neu, old] of ORDER) {
      const iOld = src.indexOf(`'${old}'`) >= 0
        ? src.indexOf(`'${old}'`) : src.indexOf(`"${old}"`)
      if (iOld < 0) continue // 该文件没有这一条候选
      const iNew = src.indexOf(`'${neu}'`) >= 0
        ? src.indexOf(`'${neu}'`) : src.indexOf(`"${neu}"`)
      assert.ok(iNew >= 0,
        `${path.basename(f)} 里有旧候选 ${old} 却没有新候选 ${neu}`)
      assert.ok(iNew < iOld,
        `${path.basename(f)} 里 ${neu} 必须排在 ${old} 之前，否则搬完家的机器找不到底模`)
      checked++
    }
  }
  assert.ok(checked >= 10,
    `只核对到 ${checked} 组候选顺序，少于预期；候选表是不是被挪走了`)
})

test('底模下拉与训练体检的 v2 候选表必须一致', () => {
  // server.js 里有两张 v2 底模候选表：_MV_BASE_REQ.v2 供开训前的底模体检用，
  // _BASE_SOVITS_DEFS 供 Generate 页的底模下拉用。两张表若收录的文件不同，
  // 同一台机器上体检会说"底模齐全"而下拉里根本没有这个版本可选。
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')

  const cut = (marker, endMarker) => {
    const i = src.indexOf(marker)
    assert.ok(i >= 0, `server.js 里找不到 ${marker}`)
    const j = src.indexOf(endMarker, i)
    assert.ok(j > i, `server.js 里 ${marker} 之后找不到 ${endMarker}`)
    return src.slice(i, j)
  }
  const list = (block, label) => {
    const m = block.match(new RegExp(`${label}[\\s\\S]*?cands:\\s*\\[([^\\]]*)\\]`))
    assert.ok(m, `取不到 ${label} 的候选表`)
    return m[1].match(/'[^']+'|"[^"]+"/g).map((s) => s.slice(1, -1))
  }

  const req = list(cut('const _MV_BASE_REQ', 'v2Pro: ['), "label: 's2G'")
  const defs = list(cut('const _BASE_SOVITS_DEFS', 'version: "v2Pro"'), 'version: "v2"')

  assert.deepStrictEqual(new Set(defs), new Set(req),
    '底模下拉的 v2 候选与训练体检的 v2 s2G 候选收录的文件不一致：\n' +
    `  体检有下拉没有：${req.filter((x) => !defs.includes(x)).join(', ') || '（无）'}\n` +
    `  下拉有体检没有：${defs.filter((x) => !req.includes(x)).join(', ') || '（无）'}`)

  // 两张表都必须把新位置排在旧位置之前。
  for (const [label, arr] of [['体检', req], ['下拉', defs]]) {
    for (const [neu, old] of [['v2/s2G2333k.pth', 'gsv-v2final/s2G2333k.pth'],
      ['v1/s2G488k.pth', 'v2Pro/s2G488k.pth'],
      ['v1/s2G488k.pth', 'gsv-v2final/s2G488k.pth']]) {
      const iOld = arr.indexOf(old)
      if (iOld < 0) continue
      const iNew = arr.indexOf(neu)
      assert.ok(iNew >= 0 && iNew < iOld,
        `${label}的候选表里 ${neu} 必须排在 ${old} 之前`)
    }
  }
})

test('MODEL_SOURCES.json 的 artifact 全部在 models/ 下', () => {
  const src = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'THIRD_PARTY_LICENSES', 'models', 'MODEL_SOURCES.json'), 'utf8'))
  const arts = src.components.map((c) => c.artifact).filter(Boolean)
  assert.ok(arts.length >= 20, `artifact 只有 ${arts.length} 条`)
  for (const a of arts) {
    assert.ok(a.startsWith('models/'),
      `artifact 路径 ${a} 不在 models/ 下；它应当是项目根相对路径`)
    assert.ok(!a.includes('gsv-v2final'),
      `artifact 路径 ${a} 仍是旧布局`)
  }
})

test('发行包不会把 models/ 下的权重打进去', () => {
  const pack = fs.readFileSync(
    path.join(ROOT, 'tools', 'build', '04_pack_release.py'), 'utf8')
  const seg = pack.slice(pack.indexOf('PATH_EXCLUDE = {'),
    pack.indexOf('EXCLUDE_EXT = {'))
  // 权重目录整个排除；G2PWModel 例外，它的字典要随包发。
  for (const d of [['models', 'asr'], ['models', 'separation'],
    ['models', 'tts', 'gpt-sovits', 'v2Pro'], ['models', 'lang']]) {
    const lit = 'os.path.join(' + d.map((x) => `"${x}"`).join(', ') + ')'
    assert.ok(seg.includes(lit), `发行包排除表里缺 ${d.join('/')}`)
  }
  assert.ok(!seg.includes('os.path.join("models")'),
    'models/ 不该整棵排除：G2PWModel 的字典不会重新下载，必须随包发')
})
