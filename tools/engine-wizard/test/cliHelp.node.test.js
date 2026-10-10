'use strict'
// ============================================================================
//  cliHelp —— 上游官方原话抓取（第 2 步 · 事 1 / 事 3 的测试）
//
//  ⭐ 判据来自 docs/ENGINE_ONBOARDING_IMPLEMENTATION_PLAN.md 第 2 步的验收：
//    3. ⭐ 官方解释是上游原话 —— 能抓到 --emotion-vector 的
//       "Comma-separated 8-dimensional emotion vector"、--voice 的
//       "Path to the speaker reference audio"
//    4. ⛔ 不做名字匹配 —— emo_alpha 不许被配到 --emotion-weight 的说明上
//    5. 直接同名的（text/device/verbose）被自动贴上官方 help
//    另加：三块分区不许丢参数（organizeDraft 的守恒律）
//
//  ⚠ 为什么这些测试**真读盘**（不用夹具）：
//    本模块的职责是「读上游 Python 源码」。用夹具就等于把「读得对不对」
//    这件事测没了 —— 夹具是抄来的，源码才是事实。读 2 个文件 + 起 1 次
//    Python 实测 < 1 秒，没有性能理由用夹具。
//    （这与 paramsFromReflect.node.test.js 用冻结夹具不矛盾：那一条测的是
//      「反射出几十 GB torch」那条链，⛔ 不能每次跑；这一条读的是纯文本。）
// ============================================================================

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const {
  collectCliHelp, runExtractor, findCliFiles, exactMatchFor, organizeDraft, destFor,
  CLI_CANDIDATES,
} = require('../core/cliHelp')

const ROOT = path.join(__dirname, '..', '..', '..')

// ---------------------------------------------------------------------------
//  真 CLI 源码路径
// ---------------------------------------------------------------------------
// ⭐ fixture 数据里可以有具体引擎名（那是**要验证的输入**），
//   ⛔ 但注释里不许写（styleguard 盯着）。⇒ 路径从常量拼，不写进注释。
// ⚠ 同一套代码的两个 clone，类所在文件名可能不同（一个在 infer_v2_5.py、
//   一个在 infer_v2.py）⇒ 路径靠 existsSync 探，⛔ 不凭记忆写死。
function firstExisting (...rels) {
  for (const r of rels) {
    const p = path.join(ROOT, r)
    if (fs.existsSync(p)) return p
  }
  return null
}

const CLI_DIR_A = firstExisting(
  path.join('engines', 'indextts2', 'indextts'),
  path.join('engines', 'index-tts', 'indextts'),
)

/** 抓一份真 CLI 原话。拿不到就跳过（换台机器上没克隆源码时不该红）。 */
function loadReal () {
  if (!CLI_DIR_A) return null
  return collectCliHelp({ dir: CLI_DIR_A })
}

// ---------------------------------------------------------------------------
//  验收 3：官方解释是上游原话
// ---------------------------------------------------------------------------
test('⭐⭐ 验收3：能抓到 --emotion-vector / --voice 的官方原话（逐字，⛔ 不改写）', () => {
  const r = loadReal()
  if (!r) { console.log('  … 跳过：这台引擎的源码不在盘上'); return }
  assert.strictEqual(r.ok, true, `collectCliHelp 失败：${r.error}`)
  assert.ok(r.flags.length >= 20,
    `⛔ 只抓到 ${r.flags.length} 个 flag，上游那份 CLI 明显不止这些 —— 解析器漏了`)

  // ⭐ 判据是**原话逐字**，不是「含关键字」。含关键字的话，平台自己编一句
  //   「8 维情绪向量」也能过 —— 那测的就不是「上游原话」了。
  const ev = r.by_dest.emotion_vector || []
  assert.ok(ev.length > 0, '⛔ 没抓到 --emotion-vector')
  assert.ok(ev.some((f) => f.help === 'Comma-separated 8-dimensional emotion vector'),
    `⛔ --emotion-vector 的官方原话不对：${JSON.stringify(ev.map((f) => f.help))}\n`
    + '   要求逐字是 "Comma-separated 8-dimensional emotion vector"')

  const voice = r.by_dest.voice || []
  assert.ok(voice.length > 0, '⛔ 没抓到 --voice')
  assert.ok(voice.some((f) => f.help === 'Path to the speaker reference audio'),
    `⛔ --voice 的官方原话不对：${JSON.stringify(voice.map((f) => f.help))}\n`
    + '   要求逐字是 "Path to the speaker reference audio"')
  console.log(`  --emotion-vector = ${JSON.stringify(ev[0].help)}`)
  console.log(`  --voice          = ${JSON.stringify(voice[0].help)}`)
})

test('⭐⭐ 验收3（补）：required=True 也如实抓出来（cli.py 的 -v/--voice）', () => {
  const r = loadReal()
  if (!r) { console.log('  … 跳过：源码不在盘上'); return }
  const voice = r.by_dest.voice || []
  const req = voice.find((f) => f.required === true)
  assert.ok(req, '⛔ 上游有一个 required=True 的 --voice，没抓到 —— required 丢了')
  assert.deepStrictEqual(req.flags, ['-v', '--voice'],
    `短 flag 与长 flag 都要原样留着：${JSON.stringify(req.flags)}`)
  assert.strictEqual(req.is_option, true, '带 - 前缀的是选项参数')
  console.log(`  ${req.flags.join(' ')} required=${req.required} → ${JSON.stringify(req.help)}`)
})

test('⭐⭐ 官方原话带 subcommand 名（同一个 flag 在不同子命令下 help 不同）', () => {
  const r = loadReal()
  if (!r) { console.log('  … 跳过：源码不在盘上'); return }
  // ⭐ 上游一个 CLI 底下挂着好几个子命令，摊开时必须带上名字，否则用户
  //   不知道照哪条敲。⛔ 不许把它们合并成一条。
  const withSub = r.flags.filter((f) => f.subcommand)
  assert.ok(withSub.length > 0, '⛔ 一条 flag 都没带 subcommand —— 子命令名丢了')
  // 同一个 dest 出现在多个子命令下是正常的（上游就这么写的）
  const devices = r.by_dest.device || []
  if (devices.length > 1) {
    const helps = new Set(devices.map((f) => f.help))
    assert.ok(helps.size >= 1, '⛔ 同一 dest 的多条原话被抹平成一条了')
    console.log(`  --device 在 ${devices.length} 个子命令下：`
      + `${[...new Set(devices.map((f) => f.subcommand))].join(' / ')}`)
  }
})

test('⭐ 每个 flag 都记着来自哪个文件（多个 CLI 并存时不许合并）', () => {
  const r = loadReal()
  if (!r) { console.log('  … 跳过：源码不在盘上'); return }
  for (const f of r.flags) {
    assert.ok(typeof f.source_file === 'string' && f.source_file,
      `⛔ flag ${f.dest} 没记 source_file —— 两份 CLI 的原话分不开了`)
  }
  assert.ok(r.sources.length >= 1, '⛔ sources 是空的')
  assert.ok(r.sources.every((s) => typeof s.ok === 'boolean'),
    '⛔ 每份源码都要报「解析成功/失败」，不许默默当成功')
})

// ---------------------------------------------------------------------------
//  验收 4：⛔ 不做名字匹配
// ---------------------------------------------------------------------------
test('⛔⛔ 验收4：emo_alpha 不许被配到 --emotion-weight 的说明上', () => {
  const r = loadReal()
  if (!r) { console.log('  … 跳过：源码不在盘上'); return }
  // ⭐ 上游的 help 原话里确实写着 \"mapped to <Engine> emo_alpha\" ——
  //   那是**上游自己声明的对应**，⛔ 不是平台猜的。但平台这一层仍然不许
  //   把 emo_alpha 和 --emotion-weight 接起来：接了就等于平台在维护
  //   名字对应表，换一台引擎又没有。
  const m = exactMatchFor('emo_alpha', r)
  assert.strictEqual(m, null,
    '⛔⛔ emo_alpha 被自动贴上了 CLI 说明 —— 那就是名字匹配，'
    + '会把 --emotion-weight 的意思错安到 emo_alpha 上，静默误导用户')
  console.log('  exactMatchFor("emo_alpha") → null（原话摊开，⛔ 不配对）')
})

test('⛔⛔ 验收4（全表）：反射出来的参数名，只有直接同名的才被贴', () => {
  const r = loadReal()
  if (!r) { console.log('  … 跳过：源码不在盘上'); return }
  // ⭐ 拿真反射结果的参数名当输入（⛔ 不手工编一张表 —— 那会漏掉真名）。
  const fixture = path.join(__dirname, 'reflect_indextts2.json')
  if (!fs.existsSync(fixture)) { console.log('  … 跳过：反射夹具不在'); return }
  const refl = JSON.parse(fs.readFileSync(fixture, 'utf8'))
  const names = [
    ...(refl.load || []).map((e) => e.name),
    ...(refl.call || []).map((e) => e.name),
  ].filter(Boolean)

  const MUST_NOT_MATCH = [
    'emo_vector', 'emo_alpha', 'spk_audio_prompt', 'emo_audio_prompt',
    'emo_text', 'use_emo_text', 'use_random', 'interval_silence',
    'max_text_tokens_per_segment', 'stream_return', 'more_segment_before',
    'duration_factor', 'text_normalization',
    'use_qwen_emo', 'use_cuda_kernel', 'use_deepspeed', 'use_accel',
    'use_torch_compile', 'use_bf16',
  ]
  for (const n of MUST_NOT_MATCH) {
    if (!names.includes(n)) continue
    assert.strictEqual(exactMatchFor(n, r), null,
      `⛔⛔ ${n} 被自动贴上了 CLI 说明 —— 那是名字匹配，不是直接同名`)
  }
  const matched = names.filter((n) => exactMatchFor(n, r) !== null)
  console.log(`  ${names.length} 个反射参数里，只有 ${matched.length} 个直接同名被贴：`
    + `${matched.join(', ') || '（无）'}`)
  // ⭐ 反作弊：如果「同名的」一个都没有，说明这条测试的判据本身失效了
  //   （比如 by_dest 建错了），红一下逼人查，而不是安静地全绿。
  assert.ok(matched.length >= 2,
    `⛔ 只有 ${matched.length} 个同名命中 —— by_dest 索引大概建错了，`
    + '这条验收会变成永真（什么都能过）')
})

test('⛔⛔ 归一化（连字符转下划线）之后仍然不许跨词匹配', () => {
  // ⭐ 直接同名只算「同一个词」：--output-path 的 dest 是 output_path，
  //   与签名 output_path 是同一个词 ⇒ 允许。
  //   但 emo_vector 与 emotion_vector 是**两个词** ⇒ ⛔ 不许。
  const r = loadReal()
  if (!r) { console.log('  … 跳过：源码不在盘上'); return }
  // 上游有 --text-file（dest text_file），签名里没有 text_file ⇒ 不该命中
  assert.strictEqual(exactMatchFor('text_file_x', r), null)
  // 而 output_path 在 cli.py 里真的有（-o/--output_path）
  const op = exactMatchFor('output_path', r)
  if (op) {
    assert.strictEqual(op.dest, 'output_path')
    console.log(`  output_path → ${op.flag}（归一化后同一词，允许）`)
  } else {
    console.log('  output_path 未命中（这台上游没这个 flag）')
  }
})

// ---------------------------------------------------------------------------
//  验收 5（数据侧）：直接同名的被自动贴上官方 help
// ---------------------------------------------------------------------------
test('⭐⭐ 验收5：text / device / verbose 被自动贴上官方 help', () => {
  const r = loadReal()
  if (!r) { console.log('  … 跳过：源码不在盘上'); return }
  for (const n of ['text', 'device', 'verbose']) {
    const m = exactMatchFor(n, r)
    assert.ok(m, `⛔ ${n} 在上游 CLI 里是同名的，却没被贴上 —— 直接同名这条规则没生效`)
    assert.ok(typeof m.help === 'string' && m.help.length > 0,
      `⛔ ${n} 贴上了但 help 是空的`)
    assert.strictEqual(m.kind, 'exact_name', '⛔ 标记不是 exact_name')
    assert.strictEqual(m.dest, n, `⛔ ${n} 的 dest 不对：${m.dest}`)
    console.log(`  ${n} → ${m.flag}  "${m.help}"`)
  }
})

test('⭐ dest 推导规则（argparse 官方规则，逐字照搬）', () => {
  // ⭐ 这一条测的是**规则本身**，喂字符串就能验，⛔ 不依赖上游源码长什么样。
  assert.strictEqual(destFor(['-v', '--voice'], true), 'voice', '有 long option ⇒ 取它')
  assert.strictEqual(destFor(['-o', '--output_path'], true), 'output_path')
  assert.strictEqual(destFor(['--emotion-vector'], true), 'emotion_vector')
  assert.strictEqual(destFor(['--text-file'], true), 'text_file')
  assert.strictEqual(destFor(['-d'], true), 'd', '只有短 option ⇒ argparse 取短字母')
  assert.strictEqual(destFor(['--no-foo'], true), 'foo',
    'BooleanOptionalAction 的 --no-foo dest 仍是 foo')
  assert.strictEqual(destFor(['text'], false), 'text', '位置参数 ⇒ 名字本身')
  assert.strictEqual(destFor(['my-arg'], false), 'my_arg', '位置参数连字符转下划线')
})

// ---------------------------------------------------------------------------
//  三块分区：一条参数都不许丢
// ---------------------------------------------------------------------------
/** 造一份草稿包（形状与 buildDraftPackage 的返回值一致，⛔ 不改它） */
function fakeDraft (names) {
  return {
    ok: true,
    parameters: names.map((n) => ({ name: n, type: 'text', phase: 'call',
      ...(REQUIRED.has(n) ? { required: true } : {}) })),
    excluded: [],
    map_candidates: [],
    counts: { parameters: names.length, excluded: 0, map_candidates: 0, reflected: names.length },
  }
}
const REQUIRED = new Set(['lang', 'spk_audio_prompt'])

test('⭐⭐ 三块分区：must + may === parameters.length（一条都不许丢）', () => {
  const names = ['text', 'lang', 'spk_audio_prompt', 'emo_alpha', 'verbose', 'speed']
  const d = fakeDraft(names)
  const o = organizeDraft(d, null)
  assert.strictEqual(o.ok, true, `分区失败：${o.error}`)
  assert.deepStrictEqual(o.blocks.map((b) => b.key), ['auto', 'must', 'may'],
    '⛔ 三块的键不是 auto/must/may —— 界面按这三个键取值，改了就对不上')
  const must = o.blocks.find((b) => b.key === 'must').items
  const may = o.blocks.find((b) => b.key === 'may').items
  assert.strictEqual(must.length + may.length, names.length,
    `⛔ 分区丢参数：${names.length} 条进去，${must.length + may.length} 条出来`)
  // ⭐ 必填的必须全在 must 里，选填的全在 may 里
  assert.deepStrictEqual(must.map((p) => p.name).sort(), ['lang', 'spk_audio_prompt'])
  assert.strictEqual(may.length, names.length - 2)
  console.log(`  must=${must.length} may=${may.length} 合计=${must.length + may.length}`
    + ` = 草稿 ${names.length} 条`)
})

test('⭐⭐ 分区守恒律：must + may 必须等于 parameters.length（反作弊）', () => {
  // ⚠ 这一条是**反作弊**的：把守恒律的校验去掉之后，正常路径也看不出异常
  //   —— 它会「安静地」少显示一条，而用户永远看不到那个旋钮且不报错。
  //   ⇒ 判据必须钉住总数，⛔ 不许只查「must 里有那几个」。
  const names = ['text', 'lang', 'spk_audio_prompt', 'emo_alpha', 'verbose', 'speed', 'seed']
  const d = fakeDraft(names)
  const o = organizeDraft(d, null)
  assert.strictEqual(o.ok, true, `分区失败：${o.error}`)
  const must = o.blocks.find((b) => b.key === 'must').items
  const may = o.blocks.find((b) => b.key === 'may').items
  assert.strictEqual(must.length + may.length, names.length,
    `⛔ 守恒律破了：${names.length} 条进去，${must.length + may.length} 条出来`)
  assert.strictEqual(o.counts.must, must.length)
  assert.strictEqual(o.counts.may, may.length)
  console.log(`  守恒律：${must.length} + ${may.length} = ${must.length + may.length}`
    + ` = 草稿 ${names.length} 条`)
})

test('⭐⭐ 坏数据不许把整个分区搞失败（一条 null 也不许变成「一条都不显示」）', () => {
  // ⚠ 判据：parameters 里混进 null / 缺 required 的行时，分区**仍然成功**，
  //   那条坏行如实落到「选填」那一块 —— 而不是抛错让三块全空。
  //   后果对比：抛错 = 用户一条参数都看不到（最坏的一类失败）；
  //             落进 may = 用户看得到，只是那条标成了选填。
  const bad = {
    ok: true,
    parameters: [{ name: 'a' }, { name: 'b', required: 'yes' }, null, undefined],
    excluded: [],
    map_candidates: [],
  }
  const o = organizeDraft(bad, null)
  assert.strictEqual(o.ok, true,
    `⛔ 一条坏数据把整个分区搞失败了 —— 那等于用户一条参数都看不到：${o.error}`)
  const must = o.blocks.find((b) => b.key === 'must').items
  const may = o.blocks.find((b) => b.key === 'may').items
  assert.strictEqual(must.length, 0, '⛔ required:"yes"（字符串）被当成必填了 —— 那是自己判的')
  assert.strictEqual(may.length, 4, '⛔ 坏行没落进「选填」那一块')
  // ⭐ 坏行要带标记，界面才能显示「这一行有问题」而不是空白一格
  const malformed = may.filter((x) => x._malformed === true)
  assert.strictEqual(malformed.length, 2, '⛔ 坏行没标 _malformed —— 界面会显示成空白一格')
  console.log('  坏数据 → ok:true，4 条全在「可以不管」那一块，其中 2 条标了 _malformed')
})

test('⭐ 分区不新增校验：required 只来自反射结果，平台不自己判', () => {
  // ⚠ 判据：参数名里带 lang / audio 这种「看着必填」的词，平台也**不许**
  //   把它挪进 must —— 必填只有反射说了才算。
  const names = ['audio_path', 'lang_x', 'prompt_wav']
  const d = fakeDraft(names)
  const o = organizeDraft(d, null)
  assert.strictEqual(o.blocks.find((b) => b.key === 'must').items.length, 0,
    '⛔ 平台自己判了必填 —— 那是新增校验逻辑，违反「平台是传话筒」')
})

test('⭐ 平台已映射的词进 ① 块，且带上中文人话要用的 platform_key', () => {
  const d = {
    ok: true,
    parameters: [{ name: 'lang', type: 'text', phase: 'call', required: true }],
    excluded: [],
    map_candidates: [
      { platform_key: 'text', already_mapped: true, current: 'tts_text',
        candidates: [{ engine_param: 'tts_text', phase: 'call', score: 130, why: '同名' }] },
      { platform_key: 'speed', already_mapped: false, current: null,
        candidates: [{ engine_param: 'speed_factor', phase: 'call', score: 80, why: '像语速' }] },
    ],
  }
  const o = organizeDraft(d, null)
  const auto = o.blocks.find((b) => b.key === 'auto').items
  assert.strictEqual(auto.length, 1, '⛔ 已映射的词没进 ① 块')
  assert.strictEqual(auto[0].name, 'text')
  assert.strictEqual(auto[0]._mapped_to, 'tts_text')
  // ⛔ 没映射的候选**不许**进 ① 块 —— 那是「还没定的事」，标成已做好是骗人
  assert.ok(!auto.some((x) => x.name === 'speed'), '⛔ 未勾选的候选被算进「已自动填好」')
})

test('⛔ ok:false 的草稿：如实报错，⛔ 不返回空三块', () => {
  const o = organizeDraft({ ok: false, stage: 'import-module', error: 'import 失败' }, null)
  assert.strictEqual(o.ok, false)
  assert.deepStrictEqual(o.blocks, [], '⛔ 失败时还给了 blocks —— 那是假绿灯')
})

// ---------------------------------------------------------------------------
//  文件发现
// ---------------------------------------------------------------------------
test('⭐ findCliFiles 在真目录里找得到 CLI 源码', () => {
  if (!CLI_DIR_A) { console.log('  … 跳过：源码不在盘上'); return }
  const rels = findCliFiles(CLI_DIR_A)
  assert.ok(rels.length >= 1, '⛔ 一份 CLI 都没找到')
  assert.ok(rels.every((r) => /\.py$/.test(r)), `⛔ 找到了非 .py 的文件：${JSON.stringify(rels)}`)
  console.log(`  找到：${rels.join(', ')}`)
})

test('⛔ 目录不存在 / 没给 dir ⇒ 如实说，⛔ 不返回空结果冒充成功', () => {
  const noDir = collectCliHelp({ dir: path.join(ROOT, 'definitely-not-an-engine-xyz') })
  assert.strictEqual(noDir.ok, false)
  assert.ok(noDir.error && noDir.error.length > 0, '⛔ 失败了没给原因')
  const noArg = collectCliHelp({})
  assert.strictEqual(noArg.ok, false)
  assert.match(noArg.error, /dir is required/)
  console.log(`  目录不存在 → ${noDir.error}`)
})

test('⭐ 没有 CLI 的目录 ⇒ ok:true + 空 flags + note（抓不到是一个答案）', () => {
  // ⚠ 找一个**真没有 argparse CLI** 的目录。⛔ 不用 core/ 自己 ——
  //   里面躺着一个 cli_help_extract.py，它自己就在用 add_argument（探测用），
  //   拿它当「没有 CLI」的样本会假红。
  const emptyDir = fs.mkdtempSync(path.join(ROOT, '.clihelp-empty-'))
  try {
    fs.writeFileSync(path.join(emptyDir, 'not_a_cli.py'),
      'def hello():\n    return 1\n', 'utf8')
    const empty = collectCliHelp({ dir: emptyDir })
    assert.strictEqual(empty.ok, true,
      `⛔ 没找到 CLI 应该是 ok:true（那是一个答案），现在报错：${empty.error}`)
    assert.strictEqual(empty.flags.length, 0, '⛔ 不该有 flag')
    assert.ok(empty.note, '⛔ 没给 note —— 界面不知道该跟用户说什么')
    console.log(`  空目录 → ok:true, flags=0, note=${empty.noteZh}`)
  } finally {
    try { fs.rmSync(emptyDir, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  }
})

test('⭐ 候选清单：⛔ 不许把 infer.py 之外的东西写死成唯一入口', () => {
  // ⚠ 上游把 CLI 放哪没有统一约定。清单 + 递归兜底两段都要在。
  assert.ok(CLI_CANDIDATES.includes('cli.py'), '⛔ 清单里没有最常见的 cli.py')
  assert.ok(CLI_CANDIDATES.length >= 3, '⛔ 候选清单太短 —— 上游换个别名就抓不到')
  // ⛔ 不许有具体引擎名（styleguard 那条纪律的同一件事，只是这里是数据）
  for (const bad of ['indextts', 'cosyvoice', 'gpt-sovits', 'voxcpm', 'fish-speech']) {
    for (const c of CLI_CANDIDATES) {
      assert.ok(!c.toLowerCase().includes(bad), `⛔ 候选清单里出现了「${bad}」`)
    }
  }
})

// ---------------------------------------------------------------------------
//  ⛔ 纪律：活代码里不许出现具体引擎名
// ---------------------------------------------------------------------------
test('⛔⛔ core/cliHelp.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + '-tts', 'cosy' + 'voice',
    'indextts', 'vox' + 'cpm', 'fish' + '-speech']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'cliHelp.js'), 'utf8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
  // ⭐ Python 侧那份也要查（它同样是活代码）
  const py = fs.readFileSync(path.join(__dirname, '..', 'core', 'cli_help_extract.py'), 'utf8')
  for (const bad of FORBIDDEN) {
    assert.ok(!py.toLowerCase().includes(bad), `Python 提取器里出现了「${bad}」`)
  }
})

test('⛔⛔ 不做名字匹配：核心文件里不许出现启发式配对的代码', () => {
  // ⚠ 这条是**结构性**守卫：靠 grep 抓「有人又加了一套相似度匹配」。
  //   判据：不许有 editDistance / similarity / scoreFor / bestMatch 这类词。
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'cliHelp.js'), 'utf8')
  const py = fs.readFileSync(path.join(__dirname, '..', 'core', 'cli_help_extract.py'), 'utf8')
  for (const pat of ['editDistance', 'levenshtein', 'similarity', 'bestMatch', 'scoreFor']) {
    assert.ok(!src.includes(pat), `⛔ cliHelp.js 里出现了 ${pat} —— 那就是名字匹配`
      + '，会把 --emotion-weight 的说明错贴到 emo_alpha 上')
    assert.ok(!py.includes(pat), `⛔ Python 提取器里出现了 ${pat}`)
  }
})

// ---------------------------------------------------------------------------
//  Python 侧提取器的契约
// ---------------------------------------------------------------------------
test('⭐ Python 提取器存在且导出了 main（⛔ 不许 Node 侧自己解析 Python）', () => {
  const pyPath = path.join(__dirname, '..', 'core', 'cli_help_extract.py')
  assert.ok(fs.existsSync(pyPath), `⛔ 找不到 ${pyPath}`)
  const src = fs.readFileSync(pyPath, 'utf8')
  // ⚠ `^def main\(` 只匹配行首 —— shebang 与 -*- coding -*- 在前面，
  //   所以用 m 标志逐行找，⛔ 不用整个文件开头匹配。
  assert.match(src, /^def main\(/m, '⛔ 提取器没有 main() 入口')
  assert.match(src, /^if __name__/m, '⛔ 提取器没有 __main__ 守卫')
  // ⭐ 必须用 ast，⛔ 不许正则硬抓
  assert.match(src, /^import ast$/m, '⛔ 提取器没用 ast —— 正则抓 help= 会漏换行的情况')
})

test('⭐⭐ 提取器真跑一遍：真 CLI 源码 → 官方原话（⛔ 不 mock Python）', () => {
  if (!CLI_DIR_A) { console.log('  … 跳过：源码不在盘上'); return }
  // ⚠ 直接调 runExtractor（绕过 collectCliHelp 的文件发现）——
  //   这样测的是「Python 那一半」本身，而不是文件发现那一半。
  const r = runExtractor(CLI_DIR_A, CLI_CANDIDATES)
  assert.strictEqual(r.ok, true, `Python 提取器失败：${r.error}\n${r.detail || ''}`)
  assert.ok(r.sources.length >= 1, '⛔ sources 是空的')
  assert.ok(r.sources.every((s) => s.ok === true),
    `⛔ 有源码解析失败：${JSON.stringify(r.sources.filter((s) => !s.ok))}`)
  assert.ok(r.flags.length >= 20, `⛔ 只抓到 ${r.flags.length} 个 flag`)
  // ⭐ 用 some 而不是 find：同一个 flag 在多个子命令下的 help 不同
  //   （上游就是这么写的），⛔ 不许只认第一条就当成唯一答案。
  const ev = r.flags.find((f) => f.dest === 'emotion_vector')
  assert.ok(ev, '⛔ 没抓到 --emotion-vector')
  assert.ok(r.flags.some((f) => f.dest === 'emotion_vector'
    && f.help === 'Comma-separated 8-dimensional emotion vector'),
    `⛔ synth 子命令下的官方原话不对：${
      JSON.stringify(r.flags.filter((f) => f.dest === 'emotion_vector')
        .map((f) => [f.subcommand, f.help]))}`)
  console.log(`  Python 提取器：${r.sources.length} 份源码，${r.flags.length} 个 flag，`
    + `emotion_vector 的原话 = ${JSON.stringify(ev.help)}`)
})

test('⭐⭐ dest 是 argparse 的 dest（连字符转下划线），⛔ 不是 flag 原样', () => {
  // ⚠⚠ 这一条是 2026-10-09 实测踩过的坑，判据必须钉住：
  //   `--emotion-vector` 的 dest 是 `emotion_vector`（下划线），
  //   ⛔ 不是 `emotion-vector`（连字符）。
  //   漏掉这一步的后果不是报错，而是**静默错配**：反射出来的签名参数
  //   `emo_vector` 与 `emotion-vector` 归一化后永远对不上，于是「直接同名」
  //   那条唯一允许的自动贴一条都不生效，而看输出像是「上游没给同名的」。
  if (!CLI_DIR_A) { console.log('  … 跳过：源码不在盘上'); return }
  const r = runExtractor(CLI_DIR_A, CLI_CANDIDATES)
  assert.ok(r.ok, `提取器失败：${r.error}`)
  const dests = r.flags.map((f) => f.dest)
  for (const d of dests) {
    assert.ok(!d.includes('-'),
      `⛔ dest "${d}" 里还有连字符 —— argparse 的 dest 一律转成下划线，`
      + '漏了它「直接同名」那条规则会静默失效')
  }
  assert.ok(dests.includes('emotion_vector'), '⛔ 没有 emotion_vector（连字符没转）')
  assert.ok(dests.includes('model_dir'), '⛔ 没有 model_dir')
  console.log(`  连字符已转下划线：emotion_vector / model_dir / batch_file …`)
})

test('⛔ 提取器拿不到 Python 时报「起不动」，⛔ 不许假装抓到了 0 个 flag', () => {
  // ⚠ 这一条防的是最坏的那类失败：spawn 失败被吞成「这台引擎没 CLI」。
  const r = runExtractor(CLI_DIR_A || __dirname, CLI_CANDIDATES, 'definitely-not-python-xyz')
  assert.strictEqual(r.ok, false, '⛔ 起不动解释器却返回 ok:true —— 把故障说成「没 CLI」')
  assert.match(r.error, /起不动|非零|不是 JSON/)
  console.log(`  假解释器 → ok:false，原因：${r.error}`)
})

// ---------------------------------------------------------------------------
//  ⭐ 第 2 步的接线：required 一路带到界面上
// ---------------------------------------------------------------------------
test('⭐⭐ 反射的 required 一路带到草稿上（否则「必须你填」那一块永远是空的）', () => {
  // ⚠⚠ 这一条是 2026-10-09 实测踩过的坑：buildDraftPackage 只把 required
  //   写到 excluded（认不出类型的那批），**parameters[] 里一条都没有**。
  //   后果不是报错，而是第 2 步的「必须你填的」那一块**永远显示 0 条** ——
  //   用户以为这台引擎没有必填参数，而它明明有一个（参考音频）。
  const fx = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'reflect_indextts2.json'), 'utf8'))
  const { buildDraftPackage } = require('../core/paramsFromReflect')
  const d = buildDraftPackage(fx, { existing: [] })
  const reqInParams = d.parameters.filter((p) => p.required === true).map((p) => p.name)
  assert.ok(reqInParams.length > 0,
    '⛔ parameters[] 里一条 required 都没有 —— 界面「必须你填」那一块会永远空着，'
    + '而用户以为这台引擎没有必填参数')
  console.log(`  parameters[] 里带 required=true 的：${reqInParams.join(', ')}`)

  // ⭐ 接上 organizeDraft：那一条必须落进 ② 块
  const o = organizeDraft(d, null)
  const must = o.blocks.find((b) => b.key === 'must').items.map((p) => p.name)
  for (const n of reqInParams) {
    assert.ok(must.includes(n), `⛔ ${n} 是必填的，却没进「必须你填」那一块`)
  }
  console.log(`  ② 必须你填的 = ${must.join(', ') || '（空）'}`)
})

test('⛔ 分区不许新增校验：required 只认 true（⛔ 不认 "yes"/1 这种）', () => {
  // ⚠ reflect_params.py 给的是 JSON 布尔。字符串 "yes" 一律当选填 ——
  //   平台自己判「这算不算必填」就是新增校验逻辑。
  const d = {
    ok: true,
    parameters: [
      { name: 'a', type: 'text', phase: 'call', required: 'yes' },
      { name: 'b', type: 'text', phase: 'call', required: 1 },
      { name: 'c', type: 'text', phase: 'call', required: true },
    ],
    excluded: [],
    map_candidates: [],
  }
  const o = organizeDraft(d, null)
  assert.deepStrictEqual(o.blocks.find((b) => b.key === 'must').items.map((p) => p.name), ['c'],
    '⛔ "yes" / 1 被当成必填了 —— 平台在自己判断布尔值')
})

// ---------------------------------------------------------------------------
//  事 2：平台认识的字段给中文人话（fieldmeta 的 PLATFORM_WORDS）
// ---------------------------------------------------------------------------
test('⭐⭐ 事2：fieldmeta 的 PLATFORM_WORDS 就是 payload.js 那 10 个词（逐字相同）', () => {
  // ⚠ 为什么逐字比对而不是「≥10 条」：这 10 个词是平台**唯一**认识的一组概念
  //   （payload.js 的 CANONICAL_KEYS）。多一个 = 平台凭空发明了一个概念；
  //   少一个 = 有个概念界面显示不出来。两种情况都不报错。
  const { PLATFORM_WORDS } = require('../core/fieldmeta')
  assert.deepStrictEqual(PLATFORM_WORDS.map((w) => w.key), [
    'text', 'text_lang', 'reference_audio', 'reference_text', 'reference_lang',
    'aux_reference_audio', 'speed', 'seed', 'media_type', 'streaming',
  ], '⛔ PLATFORM_WORDS 与 payload.js 的 CANONICAL_KEYS 不一致')
})

test('⭐⭐ 事2：10 个词每一个都有中文人话（label + help，⛔ 不许空）', () => {
  const { PLATFORM_WORDS } = require('../core/fieldmeta')
  for (const w of PLATFORM_WORDS) {
    assert.ok(typeof w.label === 'string' && w.label.length > 0,
      `⛔ ${w.key} 没有中文 label —— 界面上这一格只有英文键名`)
    assert.ok(typeof w.help === 'string' && w.help.length > 0,
      `⛔ ${w.key} 没有中文 help —— 用户不知道这一格是干什么的`)
    assert.ok(['block', 'silent', 'info'].includes(w.danger),
      `⛔ ${w.key} 的 danger 不在三档里：${w.danger}`)
  }
  // ⭐ 静默失效那一档必须真的有内容：那正是「填错不报错」的词，
  //   最需要一句提醒（fieldmeta 头注的原话）。
  const silent = PLATFORM_WORDS.filter((w) => w.danger === 'silent')
  assert.ok(silent.length > 0, '⛔ 一档 silent 都没有 —— 那说明「填错不报错」这个词没被提醒')
  for (const w of silent) {
    assert.ok(w.warn, `⛔ ${w.key} 是 silent 档却没有 warn —— 那正是最该提醒的一类`)
  }
  console.log(`  10 个词全有中文人话；silent 档 ${silent.length} 个（均带 warn）`)
})

test('⭐⭐ 事2：specbridge 把 platformWords 送出去（界面拿得到才用得上）', () => {
  const { buildSpec } = require('../core/specbridge')
  const spec = buildSpec()
  assert.ok(Array.isArray(spec.platformWords), '⛔ spec 里没有 platformWords')
  assert.strictEqual(spec.platformWords.length, 10, '⛔ 不是 10 个')
  for (const w of spec.platformWords) {
    assert.ok(w.key && w.label && w.help, `⛔ spec 里 ${JSON.stringify(w)} 缺字段`)
    assert.ok(w.danger, `⛔ spec 里 ${w.key} 缺 danger —— 界面没法挂「填错不报错」徽标`)
  }
})
