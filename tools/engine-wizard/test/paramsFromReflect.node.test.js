'use strict'
// ============================================================================
//  反射 → parameters[] 草稿 + 平台词候选 —— 真行为测试
//
//  ⭐ 判据来自 7 条验收（docs/ENGINE_ONBOARDING_IMPLEMENTATION_PLAN.md 第 1 步）：
//    1. 对签名型引擎 A 反射 → 草稿 ≥17 条
//    2. 对多方法引擎 B 反射 → 草稿 ≥13 条
//    3. ⭐ 映射候选拿人手写好的 10 条 maps 当考题，命中 ≥8 条
//    4. 真参数一个都不能少（含「类型反射不出」的必填参数）
//    5. 不自动落盘：按钮只填表单
//    6. ⭐ 变异测试：把映射启发式去掉 ⇒ 第 3 条必须变红
//    7. npm test 不退化
//
//  ⚠ 为什么用**冻结的反射夹具**而不是真跑 venv：
//    理由与 lib/engines/scaffold.node.test.js:9-11 相同 —— 真跑要 import
//    几个 GB 的 torch，34 秒起，换台机器就红。夹具是从
//    lib/engines/reflect_params.py **实跑**得到的原始输出，未经手工编辑
//    （见各 JSON 文件头）。
// ============================================================================

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const {
  buildDraftPackage, mergeReflections, reflectAndBuild, candidatesFor, mapCandidatesFor,
  isPlatformCanonical,
  PLATFORM_KEYS, EXCLUDE, exclusionReason,
} = require('../core/paramsFromReflect')

// ⭐ 核心实现只允许**一份**：本文件不许有第二套排除名单 / 类型推断 / 草稿组装。
const SCAFFOLD = require(path.join(__dirname, '..', '..', '..', 'tools', 'scaffold-params.cjs'))

// ---------------------------------------------------------------------------
//  夹具
// ---------------------------------------------------------------------------
const loadFixture = (name) => JSON.parse(
  fs.readFileSync(path.join(__dirname, name), 'utf8'))

const REFLECT_INDEXTTS = loadFixture('reflect_indextts2.json')
const REFLECT_COSYVOICE = loadFixture('reflect_cosyvoice2.json')
const REFLECT_COSYVOICE_METHODS = loadFixture('reflect_cosyvoice2_methods.json')
const ANSWER_SHEET = loadFixture('fixture_gsv_answer_sheet.json')

// ---------------------------------------------------------------------------
//  验收 1 / 2：草稿条数
// ---------------------------------------------------------------------------
test('⭐ 验收1：index-tts 反射 → 草稿 ≥17 条', () => {
  const d = buildDraftPackage(REFLECT_INDEXTTS, { existing: [] })
  assert.strictEqual(d.ok, true)
  assert.strictEqual(d.partial, false,
    '⛔ 反射结果不完整 —— 草稿会少整整一段调用期参数，且不报错')
  assert.ok(d.counts.parameters >= 17,
    `⛔ 草稿只有 ${d.counts.parameters} 条，要求 ≥17`
    + `（反射到 ${d.counts.reflected} 个具名参数）`)
})

test('⭐ 验收2：cosyvoice2 反射 → 草稿 ≥13 条', () => {
  // ⭐ 这台引擎的 call.methods 里声明了 **5 个**推理方法（每方法 4~7 个参数）。
  //   ⇒「反射这台引擎」= 逐个方法反射 + 按参数名合并（见 mergeReflections）。
  //   单方法只有 7 个具名参数，合并后 16 个 —— 计划里的 ≥13 就是按全方法算的。
  const d = buildDraftPackage(mergeReflections(REFLECT_COSYVOICE_METHODS), { existing: [] })
  assert.strictEqual(d.ok, true)
  assert.strictEqual(d.partial, false,
    '⛔ 反射结果不完整 —— 草稿会少整整一段调用期参数，且不报错')
  assert.ok(d.counts.parameters >= 13,
    `⛔ 草稿只有 ${d.counts.parameters} 条，要求 ≥13`
    + `（合并 ${d.counts.reflected} 个具名参数，排除了 ${d.counts.excluded} 条）`)
  // ⭐ 五个方法独有的参数必须都在：sft 的 spk_id、instruct2 的 instruct_text、
  //   vc 的 source_wav —— 漏掉任何一个 = 界面上少一个真实存在的旋钮，且不报错。
  for (const n of ['spk_id', 'instruct_text', 'source_wav', 'prompt_wav', 'prompt_text']) {
    assert.ok(d.parameters.some((p) => p.name === n),
      `⛔ 草稿里没有 ${n} —— 某个推理方法的参数被合并丢了`)
  }
})

test('⭐ 验收2（单方法基线）：只反射 zero_shot 一个方法时是 12 条，⛔ 不许靠重复计数凑数', () => {
  // ⚠ 这一条是**反作弊**的：合并必须按参数名去重。五个方法都有
  //   tts_text / stream / speed / text_frontend ⇒ 不去重就会凭空多出十几条。
  const d = buildDraftPackage(REFLECT_COSYVOICE, { existing: [] })
  assert.strictEqual(d.counts.reflected, 13, '单方法夹具变了？')
  assert.strictEqual(d.counts.parameters, 12, '单方法草稿条数变了（model_dir 应被排除）')
  const names = d.parameters.map((p) => p.name)
  assert.strictEqual(new Set(names).size, names.length, '⛔ 草稿里有重名参数')
})

// ---------------------------------------------------------------------------
//  草稿形状
// ---------------------------------------------------------------------------
test('⭐ 草稿每条都有 name/type/phase/label/help（可直接并进 manifest.parameters）', () => {
  for (const fx of [REFLECT_INDEXTTS, REFLECT_COSYVOICE]) {
    const d = buildDraftPackage(fx, { existing: [] })
    for (const p of d.parameters) {
      assert.ok(typeof p.name === 'string' && p.name, `缺 name：${JSON.stringify(p)}`)
      assert.ok(typeof p.type === 'string' && p.type, `${p.name} 缺 type`)
      assert.ok(p.phase === 'load' || p.phase === 'call', `${p.name} 的 phase 不对：${p.phase}`)
      assert.ok(p.label && p.label.en && p.label.zh, `${p.name} 缺双语 label`)
      assert.ok(p.help && p.help.en && p.help.zh, `${p.name} 缺双语 help`)
    }
  }
})

test('⭐ ⭐ 反射拿不到的东西一律写成 REPLACE_ME（⛔ 不许填一个看着合理的假值）', () => {
  for (const fx of [REFLECT_INDEXTTS, REFLECT_COSYVOICE]) {
    for (const p of buildDraftPackage(fx, { existing: [] }).parameters) {
      assert.strictEqual(p.label.zh, 'REPLACE_ME', `${p.name} 的 zh 标签不是 REPLACE_ME`)
      assert.strictEqual(p.help.zh, 'REPLACE_ME', `${p.name} 的 zh 说明不是 REPLACE_ME`)
      // ⚠ min/max/step 反射拿不到 ⇒ 不许出现（出现就是平台替人定了范围）
      assert.ok(p.min === undefined && p.max === undefined && p.step === undefined,
        `⛔ ${p.name} 出现了 min/max/step —— 那是平台替名片作者定的取值范围`)
    }
  }
})

test('⭐⭐ 按名字猜出来的类型必须标 _needs_review（名字线索是弱证据）', () => {
  // [实测] 16 个 call 参数里 8 个默认值是 None ⇒ 类型只能靠名字猜，
  //       而那 8 个每一条都必须带着「请人工确认」的标记出去。
  const d = buildDraftPackage(REFLECT_INDEXTTS, { existing: [] })
  const byName = Object.fromEntries(d.parameters.map((p) => [p.name, p]))
  const guessed = ['use_cuda_kernel', 'spk_audio_prompt', 'emo_audio_prompt',
    'emo_vector', 'emo_text']
  for (const n of guessed) {
    assert.ok(byName[n], `⛔ 反射结果里没有 ${n} —— 夹具变了？`)
    assert.strictEqual(byName[n]._needs_review, true,
      `⛔ ${n} 的类型是按名字猜的，却没标 _needs_review`
      + ' —— 人会以为那是反射得来的事实')
  }
})

test('⭐⭐ 必填但类型反射不出的参数不许被静默丢掉 —— 出现在 excluded 并标 needs_human', () => {
  // ⭐ 判据来自计划 §1.1 验收第 4 条（v2 改过的版本）：
  //   「反射读到的每个真参数都必须出现在草稿里，必填参数即使类型反射不出
  //    也要留，标 _needs_review」。
  //   ⚠ 落点在 excluded 而不是 parameters：平台强制 type ∈ 五种
  //     （lib/engines/profile.js:944-951），填一个假类型 = 整台引擎解析失败；
  //     type 留空同样过不了那道校验。⇒ 认不出的**只能**进 excluded，
  //     但⛔ 不许静默：必须标 needs_human 并说清「必填，请你确认这是什么类型」。
  const d = buildDraftPackage(REFLECT_INDEXTTS, { existing: [] })
  const lang = d.excluded.find((e) => e.name === 'lang')
  assert.ok(lang, '⛔ lang（必填、无默认值、无名字线索）没出现在 excluded 里 —— 真参数被丢了')
  assert.strictEqual(lang.needs_human, true,
    '⛔ 类型猜不出来的必须标 needs_human —— 不然用户以为这个参数不存在')
  assert.strictEqual(lang._needs_review, true,
    '⛔ 落点在 excluded 也要带 _needs_review —— 否则「哪几条要人复核」只在草稿那一半成立')
  assert.strictEqual(lang.required, true,
    '⛔ 没标出这是**必填**参数 —— 必填认不出的要人优先填')
  assert.ok(String(lang.reason).includes('必填'),
    `⛔ 没说明这是**必填**参数：${lang.reason} —— 必填认不出的要人优先填`)
  assert.ok(String(lang.reason).length > 8, '⛔ 排除理由太短，说不清要人确认什么')
  // ⛔ 不许同时出现在两处（那等于说两件事，界面无从判断它到底存不存在）
  assert.ok(!d.parameters.some((p) => p.name === 'lang'),
    '⛔ lang 同时进了草稿和排除清单 —— 它到底存不存在？')
})

test('⭐⭐ 必填认不出的参数，排除理由要说清「请你确认类型」（⛔ 不许只说「类型反射不出」）', () => {
  // ⚠ 上一条查「在不在、标没标」，这一条查**理由能不能指导人行动**。
  //   「类型反射不出」是内部诊断；用户要看到的是「这个参数必填，但平台看不出
  //   它是什么类型，请你定」。
  const d = buildDraftPackage(REFLECT_INDEXTTS, { existing: [] })
  const lang = d.excluded.find((e) => e.name === 'lang')
  assert.ok(lang)
  const r = String(lang.reason)
  assert.ok(/人工|确认|需要人定|你来定/.test(r),
    `⛔ 理由里没有「要人来定」的动作指引：${r}`)
})

test('⭐ 排除的每条都带理由（⛔ 不许静默丢弃）', () => {
  for (const fx of [REFLECT_INDEXTTS, REFLECT_COSYVOICE]) {
    for (const e of buildDraftPackage(fx, { existing: [] }).excluded) {
      assert.ok(typeof e.reason === 'string' && e.reason.length > 4,
        `⛔ ${e.name} 被排除却没给理由`)
    }
  }
})

// ---------------------------------------------------------------------------
//  验收 3：⭐ 映射候选拿答案卷对
// ---------------------------------------------------------------------------
test('⭐⭐ 验收3：映射候选对人手写好的 10 条 maps 命中 ≥8 条', () => {
  const params = ANSWER_SHEET.engine_params.map((n) => ({ name: n, phase: 'call' }))
  const rows = mapCandidatesFor(params)

  const hits = []
  const misses = []
  for (const [platformKey, expectedEngineParam] of Object.entries(ANSWER_SHEET.expected_maps)) {
    const row = rows.find((r) => r.platform_key === platformKey)
    const ok = row && row.candidates.some((c) => c.engine_param === expectedEngineParam)
    if (ok) hits.push(`${platformKey} ← ${expectedEngineParam}`)
    else misses.push(`${platformKey} ← ${expectedEngineParam}`
      + `（候选：${row ? row.candidates.map((c) => c.engine_param).join(', ') : '无'}）`)
  }

  assert.ok(hits.length >= 8,
    `⛔ 只命中 ${hits.length}/10 条（要求 ≥8）。没命中：${misses.join('；')}`)
})

test('⭐ 映射候选只给候选 —— 绝不返回「已写入」的 maps', () => {
  const d = buildDraftPackage(REFLECT_INDEXTTS, { existing: [] })
  // ⛔ 这一条守的是「人点选后才写 maps」这条硬约束：
  //   产物里任何位置都不许出现一个可以直接当 maps 用的键值表。
  assert.ok(!d.maps, '⛔ 产物里出现了 maps —— 那是自动落盘')
  for (const row of d.map_candidates) {
    assert.ok(!('engine_param' in row), '⛔ 顶层直接给了 engine_param')
    assert.ok(Array.isArray(row.candidates) && row.candidates.length >= 1,
      `${row.platform_key} 没有候选`)
    for (const c of row.candidates) {
      // ⭐ 候选必须说清「为什么猜它」—— 人是在做决定，不是在点确认
      assert.ok(typeof c.why === 'string' && c.why.length > 2, `${row.platform_key} 的候选缺理由`)
    }
  }
})

test('⭐ 已经有人手写映射的词：候选照样列，但标 already_mapped（⛔ 不覆盖）', () => {
  const d = buildDraftPackage(REFLECT_INDEXTTS, {
    existing: [],
    existingMaps: { speed: 'duration_factor' },
  })
  const row = d.map_candidates.find((r) => r.platform_key === 'speed')
  if (row) {
    assert.strictEqual(row.already_mapped, true)
    assert.strictEqual(row.current, 'duration_factor')
  }
  // ⚠ 产物里⛔ 不许出现 speed: duration_factor 这种「已生效」的映射表
  assert.ok(!d.maps)
})

// ---------------------------------------------------------------------------
//  验收 4：⭐⭐ 反射读到的每个真参数都必须出现在草稿里
// ---------------------------------------------------------------------------
test('⭐⭐ 验收4：反射读到的每个真参数都出现在草稿或排除清单里（⛔ 不许凭空消失）', () => {
  // ⭐ 计划 §1.1 验收第 4 条的 v2 判据（原「排除平台词」已作废）：
  //   反射只读签名，压根不会把平台词混进来 —— 所以这里守的是**反向**那条：
  //   反射报上来的每个参数，要么进草稿、要么进 excluded 并说清理由，
  //   ⛔ 不许两条都不在（那是「真参数凭空消失，且不报错」）。
  for (const fx of [REFLECT_INDEXTTS, REFLECT_COSYVOICE]) {
    const d = buildDraftPackage(fx, { existing: [] })
    const seen = new Set([
      ...d.parameters.map((p) => p.name),
      ...d.excluded.map((e) => e.name),
    ])
    for (const phase of ['load', 'call']) {
      for (const entry of (fx[phase] || [])) {
        if (entry.skipped) continue
        assert.ok(seen.has(entry.name),
          `⛔ ${phase} 期的 ${entry.name} 反射报上来了，草稿和排除清单里都没有`)
      }
    }
  }
})

test('⭐ 平台核心词的同名变体只标记不排除（⛔ 硬排除会连带干掉映射候选）', () => {
  // ⚠ speed / seed / media_type 这类**是平台的词**，但也**就是某台引擎的参数名**：
  //   人手写的 maps 里 speed←speed_factor、media_type←media_type 全是这种。
  //   硬排除它们 = 验收 3 永远拿不到候选。
  assert.strictEqual(isPlatformCanonical('speed'), true)
  assert.strictEqual(isPlatformCanonical('media_type'), true)
  // 并且草稿里出现时挂 _platform_key 提醒，⛔ 不删
  const d = buildDraftPackage(REFLECT_COSYVOICE, { existing: [] })
  const speed = d.parameters.find((p) => p.name === 'speed')
  assert.ok(speed, '⛔ 这台引擎的 speed 参数被丢了 —— 它真实存在')
  assert.strictEqual(speed._platform_key, true)
})

// ---------------------------------------------------------------------------
//  验收 5：不自动落盘
// ---------------------------------------------------------------------------
test('⭐⭐ 验收5：本模块不写盘 —— 产物是纯数据，没有任何 fs 调用', () => {
  // ⭐ 判据不是「看代码里有没有写盘的注释」，而是**真跑一遍然后查盘**：
  //   跑之前记下 engines/ 下每个 manifest.json 的 mtime 与内容 hash，
  //   跑完之后逐一比对。有一个变了就是自动落盘。
  const enginesDir = path.join(__dirname, '..', '..', '..', 'engines')
  const before = new Map()
  for (const id of fs.readdirSync(enginesDir)) {
    const f = path.join(enginesDir, id, 'manifest.json')
    if (!fs.existsSync(f)) continue
    const st = fs.statSync(f)
    before.set(f, `${st.mtimeMs}|${st.size}|${fs.readFileSync(f).length}`)
  }

  // 把两台引擎都跑一遍（含已有的 maps / parameters，覆盖最常见的输入）
  buildDraftPackage(REFLECT_INDEXTTS, { existing: ['emo_alpha'] })
  buildDraftPackage(REFLECT_COSYVOICE, { existing: [], existingMaps: { text: 'tts_text' } })

  for (const [f, sig] of before) {
    const st = fs.statSync(f)
    const now = `${st.mtimeMs}|${st.size}|${fs.readFileSync(f).length}`
    assert.strictEqual(now, sig,
      `⛔ ${f} 被改了 —— 反射 → 草稿这一步不许写 manifest.json`)
  }
})

test('⭐ 端到端：真跑反射 → 草稿（默认跳过，⛔ 不假装通过）', () => {
  // ⚠ 这一条真跑要 import 两台引擎的 venv（各几十秒、几个 GB 依赖）。
  //   它**不进** npm test 的默认路径 —— 默认跑会把全量测试从 ~40s 拖到 ~2min。
  //   ⭐ 要真跑：`AURIVOX_REFLECT_E2E=1 npm test`
  //
  // ⛔⛔ 跳过时**必须**打印「未执行」，⛔ 不许静默通过。
  //    理由（tools/run_tests.cjs:57-66 的原话）：一条"守卫"存在、被 review、
  //    被写进契约，却从不执行，是最坏的一种失败 —— 它给人安全感。
  if (process.env.AURIVOX_REFLECT_E2E !== '1') {
    console.log('  … 未执行：本机真反射耗时 ~80s（import 两个 venv），'
      + '默认不进 npm test。要跑：AURIVOX_REFLECT_E2E=1 npm test')
    return
  }
  const enginesDir = path.join(__dirname, '..', '..', '..', 'engines')
  const cases = [
    { id: 'index-tts', py: path.join(enginesDir, 'index-tts', '.venv', 'Scripts', 'python.exe'),
      spec: { module: 'indextts.infer_v2_5', class: 'IndexTTS2', method: 'infer' }, min: 17 },
    // ⭐ 这台声明了 5 个推理方法 ⇒ 真跑就要逐个反射再合并（与验收 2 同一条路）
    { id: 'cosyvoice2', py: path.join(enginesDir, 'cosyvoice2', '.venv', 'Scripts', 'python.exe'),
      spec: { module: 'cosyvoice.cli.cosyvoice', class: 'CosyVoice2' },
      methods: ['inference_sft', 'inference_zero_shot', 'inference_cross_lingual',
        'inference_instruct2', 'inference_vc'],
      min: 13 },
  ]
  let ran = 0
  for (const c of cases) {
    if (!fs.existsSync(c.py)) {
      console.log(`  … 跳过 ${c.id}：没有 ${path.relative(enginesDir, c.py)}`)
      continue
    }
    const d = reflectAndBuild({
      python: c.py,
      cwd: path.join(enginesDir, c.id),
      sys_path: [path.join(enginesDir, c.id)],
      ...c.spec,
      skip: [],
    }, { methods: c.methods, timeoutMs: 180000 })
    if (!d.ok) {
      // ⛔ 反射失败是一个**答案**，不是测试通过 ⇒ 这条测试照样要红
      assert.fail(`反射 ${c.id} 失败（${d.stage}）：${d.error}`)
    }
    assert.strictEqual(d.partial, false,
      `⛔ ${c.id} 反射结果不完整 —— 有方法名对不上上游`)
    assert.ok(d.counts.parameters >= c.min,
      `⛔ 真跑 ${c.id} 只得 ${d.counts.parameters} 条，要求 ≥${c.min}`)
    ran += 1
    console.log(`  真跑 ${c.id}：反射 ${d.counts.reflected} 个具名参数 → 草稿 ${d.counts.parameters} 条`
      + `，排除 ${d.counts.excluded} 条，映射候选 ${d.counts.map_candidates} 组`)
  }
  if (ran === 0) console.log('  … 本机没有引擎 venv，本条未执行真反射（不是通过）')
})

// ---------------------------------------------------------------------------
//  复用纪律：⛔ 不许另起一套
// ---------------------------------------------------------------------------
test('⭐⭐ 排除名单就是 scaffold-params.cjs 那一份（⛔ 不许复制成第二份）', () => {
  assert.strictEqual(EXCLUDE, SCAFFOLD.EXCLUDE,
    '⛔ EXCLUDE 不是同一个对象 —— 复制了一份名单，它会漂移且漂了不报错')
  assert.strictEqual(exclusionReason, SCAFFOLD.exclusionReason,
    '⛔ exclusionReason 不是同一个函数')
  for (const name of ['cfg_path', 'model_dir', 'device', 'text', 'emo_alpha']) {
    assert.strictEqual(exclusionReason(name), SCAFFOLD.exclusionReason(name),
      `⛔ ${name} 的排除判定与 scaffold-params.cjs 不一致`)
  }
})

test('⭐⭐ 平台词表与 lib/engines/payload.js 的 CANONICAL_KEYS 逐字一致', () => {
  // ⚠ 这份表在向导里**故意**复制了一份（向导不 require 产品侧 lib/）。
  //   代价是会漂 ⇒ 这条比对就是那个代价的护栏。漂了当场红。
  const payloadSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'lib', 'engines', 'payload.js'), 'utf8')
  const core = (payloadSrc.match(/const CORE_KEYS = \[([^\]]*)\]/) || [])[1] || ''
  const opt = (payloadSrc.match(/const OPTIONAL_KEYS = \[([^\]]*)\]/) || [])[1] || ''
  const quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1])
  const canonical = [...quoted(core), ...quoted(opt)]
  assert.deepStrictEqual([...PLATFORM_KEYS], canonical,
    '⛔ 平台词表与 payload.js 漂了 —— 加词只改一份，另一份要跟着改')
})

// ---------------------------------------------------------------------------
//  验收 6：⭐ 变异测试 —— 启发式拿掉，第 3 条必须变红
// ---------------------------------------------------------------------------
test('⭐⭐ 验收6（变异）：把映射启发式去掉 ⇒ 验收3 的判据必须红', () => {
  // ⭐ 这一条守的是「验收 3 真的在测映射启发式」。
  //   做法：用**空规则表**重建一套候选（等价于把启发式删掉），
  //   然后跑与验收 3 完全相同的判据 —— 它必须失败。
  const MAP_RULES_PATH = path.join(__dirname, '..', 'core', 'paramsFromReflect.js')
  const src = fs.readFileSync(MAP_RULES_PATH, 'utf8')

  // 变异：把规则表清空（这是「去掉启发式」最直接的等价物）
  const mutated = src.replace(/const MAP_RULES = \[[\s\S]*?\n\]/, 'const MAP_RULES = []')
  assert.notStrictEqual(mutated, src, '⛔ 变异没生效 —— 源码里找不到 MAP_RULES 表')

  // 把变异后的源码加载成一个独立模块（⛔ 不动盘上的真文件）
  const vm = require('node:vm')
  const Module = require('node:module')
  const m = new Module(MAP_RULES_PATH, null)
  m.filename = MAP_RULES_PATH
  m.paths = Module._nodeModulePaths(path.dirname(MAP_RULES_PATH))
  // ⚠ 变异体里 require('../scaffold-params.cjs') 必须仍指向真文件 ⇒ 保持 __dirname 语义
  const wrapper = Module.wrap(mutated)
  const compiled = vm.runInThisContext(wrapper, { filename: MAP_RULES_PATH })
  compiled.call(m.exports, m.exports, require, m, MAP_RULES_PATH,
    path.dirname(MAP_RULES_PATH))
  const mutatedApi = m.exports

  // 用与验收 3 **完全相同**的输入和判据
  const params = ANSWER_SHEET.engine_params.map((n) => ({ name: n, phase: 'call' }))
  const rows = mutatedApi.mapCandidatesFor(params)
  let hits = 0
  for (const [, expectedEngineParam] of Object.entries(ANSWER_SHEET.expected_maps)) {
    if (rows.some((r) => r.candidates.some((c) => c.engine_param === expectedEngineParam))) hits += 1
  }

  assert.ok(hits < 8,
    `⛔⛔ 变异测试失败：把映射启发式去掉之后仍然命中 ${hits}/10 条\n`
    + '   ⇒ 说明验收 3 测的不是映射启发式（可能只是字面相同碰巧对上），'
    + '     那条验收形同虚设。')
  console.log(`  变异后命中 ${hits}/10 条（<8）⇒ 验收 3 确实在测映射启发式`)
})

test('⭐⭐ 变异（对照）：同一条判据在**未变异**的模块上必须 ≥8', () => {
  // ⚠ 只有红过再绿，才证明红的理由是「启发式没了」而不是「判据本身写错」。
  const params = ANSWER_SHEET.engine_params.map((n) => ({ name: n, phase: 'call' }))
  const rows = mapCandidatesFor(params)
  let hits = 0
  for (const [, expectedEngineParam] of Object.entries(ANSWER_SHEET.expected_maps)) {
    if (rows.some((r) => r.candidates.some((c) => c.engine_param === expectedEngineParam))) hits += 1
  }
  assert.ok(hits >= 8, `⛔ 未变异只命中 ${hits}/10 —— 验收 3 的判据本身有问题`)
})

// ---------------------------------------------------------------------------
//  杂项：几个容易写错的边角
// ---------------------------------------------------------------------------
test('⭐ partial=true 必须一路传出去（⛔ 不许静默当完整结果）', () => {
  const partialFixture = JSON.parse(JSON.stringify(REFLECT_INDEXTTS))
  partialFixture.partial = true
  partialFixture.partial_reason = '方法 infer 在 IndexTTS2 上不存在'
  partialFixture.call = []
  const d = buildDraftPackage(partialFixture, { existing: [] })
  assert.strictEqual(d.partial, true)
  assert.ok(String(d.partial_reason).includes('infer'))
})

// ---------------------------------------------------------------------------
//  多方法合并的纪律
// ---------------------------------------------------------------------------
test('⭐⭐ 合并按参数名去重（⛔ 不许把五个方法共有的 tts_text 数成五条）', () => {
  const merged = mergeReflections(REFLECT_COSYVOICE_METHODS)
  assert.deepStrictEqual(merged.methods,
    ['inference_sft', 'inference_zero_shot', 'inference_cross_lingual',
      'inference_instruct2', 'inference_vc'])
  // 五个方法**都有**的四个参数只该出现一次
  for (const n of ['tts_text', 'stream', 'speed', 'text_frontend']) {
    const cnt = merged.call.filter((e) => e.name === n).length
    assert.strictEqual(cnt, 1, `⛔ ${n} 在合并结果里出现了 ${cnt} 次`)
  }
  // 而各自独有的必须都在
  for (const n of ['spk_id', 'instruct_text', 'source_wav', 'zero_shot_spk_id']) {
    assert.ok(merged.call.some((e) => e.name === n),
      `⛔ 合并丢了 ${n} —— 那等于界面上少一个真实存在的旋钮，且不报错`)
  }
  // 构造期五个方法都一样 ⇒ 也该去重成 6 条
  assert.strictEqual(merged.load.length, 6)
})

test('⭐ 合并时有一个方法反射失败：⛔ 不许假装成功（partial 必须立起来）', () => {
  const withFailure = [...REFLECT_COSYVOICE_METHODS,
    { ok: false, stage: 'get-class', error: '方法名对不上上游' }]
  // ⚠ 失败的那一条 partial=true，合并结果必须带着这个标记出去 ——
  //   少了它，草稿会「安静地」少一个方法的参数。
  const broken = JSON.parse(JSON.stringify(REFLECT_COSYVOICE_METHODS[0]))
  broken.partial = true
  broken.partial_reason = '方法 vc 在 CosyVoice2 上不存在'
  const merged = mergeReflections([...REFLECT_COSYVOICE_METHODS, broken])
  assert.strictEqual(merged.partial, true)
  assert.ok(String(merged.partial_reason).includes('vc'),
    '⛔ 哪个方法没反射到没说出来')
  assert.ok(withFailure.length > 0)   // 只说明 fixture 里有失败那条
})

test('⭐ 合并全失败 ⇒ ok:false（⛔ 不返回空草稿）', () => {
  const d = mergeReflections([{ ok: false, stage: 'spawn', error: '起不动解释器' }])
  assert.strictEqual(d.ok, false)
  assert.strictEqual(d.stage, 'spawn')
})

test('⭐ ok:false 的反射结果：如实返回失败，⛔ 不返回空草稿', () => {
  const d = buildDraftPackage({ ok: false, stage: 'import-module', error: 'import X 失败' })
  assert.strictEqual(d.ok, false)
  assert.strictEqual(d.stage, 'import-module')
  assert.ok(!d.parameters, '⛔ 失败时还给了 parameters —— 那是假绿灯')
})

test('⛔ 本文件（core/）活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + '-tts', 'cosy' + 'voice',
    'indextts', 'vox' + 'cpm', 'fish' + '-speech']
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'core', 'paramsFromReflect.js'), 'utf8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

test('⭐ 平台词表全表只该有 payload.js 那 10 个（⛔ 不在这里扩词）', () => {
  // ⚠ 扩充平台词是**契约变更**（计划 §4.1 明确「未定」）⇒ 这一条盯着
  //   有人在向导里偷偷加词。
  assert.deepStrictEqual([...PLATFORM_KEYS], [
    'text', 'text_lang', 'reference_audio', 'reference_text', 'reference_lang',
    'aux_reference_audio', 'speed', 'seed', 'media_type', 'streaming',
  ])
})

// ---------------------------------------------------------------------------
//  端点：POST /wizard/params
// ---------------------------------------------------------------------------
// ⭐ 真起一个 http server、真发一次请求 —— ⛔ 不 mock 业务逻辑。
//   理由：端点要验的是「路由 + 读盘 + 反射 + 组装」这一整条链，
//   而这条链上最容易错的地方（前缀没匹配上、buildSpec 读错了名片、
//   反射结果被静默吞掉）只有真发请求才暴露得出来。
const BRIDGE = require('../core/wizardbridge')

/** 起一个只挂 wizardbridge 全部 handler 的临时 server */
function withServer (fn) {
  const http = require('node:http')
  // ⚠ 按 web/wizard.vite.config.mjs 里 HANDLERS 的顺序逐个试 ——
  //   ⛔ 不能简单遍历导出表：那张表是**有顺序的**（长前缀在前），
  //      导出表的顺序与之无关。顺序错了长前缀永远匹配不上。
  const ORDER = ['handleState', 'handleResolve',
    'handleProbe', 'handleDeps', 'handleHardware', 'handleClone', 'handleEnv',
    'handleModels', 'handleVerifyChecks', 'handleVerify', 'handleProfile',
    'handleParams']
  for (const name of ORDER) {
    assert.strictEqual(typeof BRIDGE[name], 'function', `⛔ wizardbridge 没有导出 ${name}`)
  }
  // ⭐ 另两个 handler 不在 wizardbridge 里（specbridge / savebridge），
  //   但它们排在 HANDLERS 最前面 —— 不挂上就验不到「前缀会不会被它们吃掉」。
  const specbridge = require('../core/specbridge')
  const savebridge = require('../core/savebridge')
  const handlers = [
    specbridge.handleSpec, savebridge.handleRead,
    ...ORDER.map((n) => BRIDGE[n]),
    savebridge.handleInstalled, savebridge.handleSave,
  ]

  // ⚠⚠ 兜底超时：本文件第一版在这里挂死过（一个 async handler 返回
  //   Promise<false> 而 Promise 是 truthy ⇒ 请求永远不 next 不响应）。
  //   ⛔ 挂死的表现是 `node --test` 整个文件不退出，比断言失败更难查。
  // ⚠ deep 模式（AURIVOX_REFLECT_E2E=1）会真跑反射：5 个方法要 import 5 次
  //   torch，实测 150s+ ⇒ 超时要跟着放大，⛔ 不能拿默认档去判它挂死。
  const deep = process.env.AURIVOX_REFLECT_E2E === '1'
  const budgetMs = deep ? 300000 : 20000
  const timer = new Promise((_, rej) => setTimeout(
    () => rej(new Error(`测试 server ${budgetMs / 1000}s 没结束 —— 有 handler 把请求吞了`)), budgetMs))
  const work = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let i = 0
      const next = () => {
        if (i >= handlers.length) { res.writeHead(404).end('not found'); return }
        const h = handlers[i++]
        const r = h(req, res)
        if (r === true) return
        if (r && typeof r.then === 'function') {
          // ⚠⚠ 与 vite 中间件同一条纪律（web/wizard.vite.config.mjs:71-88）：
          //   async handler 即使返回 false，返回的也是 Promise<false>，
          //   Promise 是 truthy。必须等它 resolve 才知道有没有接管。
          r.then((ok) => { if (!ok) next() }).catch(() => next())
          return
        }
        next()
      }
      next()
    })
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`
      try { await fn(base) } catch (e) { reject(e) } finally { server.close() }
      resolve()
    })
    server.on('error', reject)
  })
  return Promise.race([work, timer])
}

const post = async (base, pathName, body) => {
  const r = await fetch(base + pathName, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() }
}

test('⭐⭐ 验收5（端点层）：POST /wizard/params 只回草稿，盘上的 manifest.json 一个字没动', () => {
  const enginesDir = path.join(__dirname, '..', '..', '..', 'engines')
  const before = new Map()
  for (const id of fs.readdirSync(enginesDir)) {
    const f = path.join(enginesDir, id, 'manifest.json')
    if (!fs.existsSync(f)) continue
    before.set(f, `${fs.statSync(f).mtimeMs}|${fs.statSync(f).size}`)
  }
  const deep = process.env.AURIVOX_REFLECT_E2E === '1'
  return withServer(async (base) => {
    if (deep) {
      // 真反射：这一台有 call 段和 runtime.python ⇒ spec 建得起来
      const r = await post(base, '/wizard/params', {
        id: 'cosyvoice2',
        methods: ['inference_sft', 'inference_zero_shot', 'inference_cross_lingual',
          'inference_instruct2', 'inference_vc'],
      })
      // 反射成功或失败都是 200（反射器 ok:false 是一个答案，不是端点出错）
      assert.strictEqual(r.status, 200, `HTTP ${r.status}`)
      assert.strictEqual(r.json.ok, true, `反射没成功：${r.json.error}`)
      assert.ok(r.json.parameters && r.json.counts, '响应里缺 parameters/counts')
      assert.ok(!r.json.maps, '⛔ 响应里出现了 maps —— 那是自动落盘')
      assert.ok(r.json.counts.parameters >= 13,
        `端点只给出 ${r.json.counts.parameters} 条，要求 ≥13`)
      console.log(`  POST /wizard/params {id:cosyvoice2, 5 方法} → ${r.json.counts.parameters} 条草稿，`
        + `${r.json.counts.map_candidates} 组映射候选`)
    } else {
      console.log('  … 端点的**真反射**分支未执行（AURIVOX_REFLECT_E2E=1 才跑，'
        + '真 import 要几十秒）。下面只验错误分支与「不接管」。')
    }
  }).then(() => {
    for (const [f, sig] of before) {
      assert.strictEqual(`${fs.statSync(f).mtimeMs}|${fs.statSync(f).size}`, sig,
        `⛔ ${f} 被改了 —— /wizard/params 不许写盘`)
    }
  })
})

test('⭐ 端点：缺 id / 目录不存在 / 名片没 call 段 ⇒ 各自说各自的原因（⛔ 不猜）', () => {
  return withServer(async (base) => {
    const noId = await post(base, '/wizard/params', {})
    assert.strictEqual(noId.json.ok, false)
    assert.strictEqual(noId.json.code, 'BAD_SPEC')
    assert.match(noId.json.error, /id is required/)
    console.log(`  · {} → ${noId.json.code}: ${noId.json.error}`)

    const noDir = await post(base, '/wizard/params', { id: 'definitely-not-an-engine' })
    assert.strictEqual(noDir.json.ok, false)
    assert.match(noDir.json.error, /不存在/)
    console.log(`  · 目录不存在 → ${noDir.json.error}`)

    // ⚠ 这台引擎克隆了源码但还没写名片 ⇒ 正确行为是「说清缺 call 段」，
    //   ⛔ 不许自己猜 module/class（猜错的表现是反射一堆别的东西）。
    const noCall = await post(base, '/wizard/params', { id: 'index-tts' })
    if (!noCall.json.ok) {
      assert.match(noCall.json.error, /call\.module|runtime\.python/)
      console.log(`  · 名片缺 call 段 → ${noCall.json.error}`)
    } else {
      console.log('  · 名片缺 call 段：这台现在有 call 段了 ⇒ 反射直接跑通')
    }
    console.log('  端点错误分支：id 缺失 / 目录缺失 / 缺 call 段 均如实报告')
  })
})

test('⭐ 端点：非 POST / 路径不对 ⇒ 不接管（⛔ 别把别的请求吃掉）', async () => {
  // ⚠ handleParams 是 async（2026-10-09 修的浏览器 404 bug）：它返回的是
  //   Promise<false>，⛔ 不能再断言同步返回值 —— 那永远不成立。
  //   本意没变：路径/方法不对时，它必须 resolve 成 false（=不接管），
  //   让请求继续走下一个 handler。await 后判值才对。
  const fake = { method: 'GET', url: '/wizard/params', on () {}, destroy () {} }
  assert.strictEqual(await BRIDGE.handleParams(fake, { writeHead () {}, end () {} }), false,
    '⛔ GET 请求被接管了 —— handleParams 只该处理 POST /wizard/params')
  const post2 = { method: 'POST', url: '/wizard/paramsxyz', on () {}, destroy () {} }
  assert.strictEqual(await BRIDGE.handleParams(post2, { writeHead () {}, end () {} }), false,
    '⛔ /wizard/paramsxyz 被接管了 —— 前缀没锚定，会吃掉别的请求')
})

test('⭐ 端点已注册：handleParams 是函数且已进 wizardbridge 的导出表', () => {
  assert.strictEqual(typeof BRIDGE.handleParams, 'function')
  // ⚠ HANDLERS 表在 web/wizard.vite.config.mjs 里（bridge.node.test.js 已经
  //   在那里查过顺序），这里只确认 wizardbridge 确实把它导出了。
  assert.ok(Object.keys(BRIDGE).includes('handleParams'))
})

test('⭐⭐ buildSpec 把 runtime.python 的**目录**补成真能起的可执行文件（Windows 实测踩过）', () => {
  const { buildSpec } = require('../core/paramsFromReflect')
  const s = buildSpec({ id: 'cosyvoice2' })
  assert.strictEqual(s.ok, true)
  // ⛔ 名片里写的是 `engines/<id>/.venv`（一个目录），不是可执行文件。
  //   直接 spawn 那个路径 = ENOENT，而报错说的是「起不动解释器」——
  //   把「路径少了一截」说成「解释器坏了」，是最难查的一类误导。
  assert.ok(fs.existsSync(s.value.python), `解释器路径不存在：${s.value.python}`)
  assert.ok(/python(\.exe)?$/i.test(s.value.python),
    `python 不该是目录：${s.value.python}`)
  assert.ok(fs.existsSync(s.value.sys_path[0]), `sys_path 不存在：${s.value.sys_path[0]}`)
  assert.strictEqual(s.value.cwd, path.join(__dirname, '..', '..', '..'),
    'cwd 该是项目根（名片里 runtime.cwd = "."）')
  console.log(`  buildSpec(cosyvoice2) → python=${path.basename(path.dirname(path.dirname(s.value.python)))}`
    + `/${path.basename(path.dirname(s.value.python))}/${path.basename(s.value.python)}`)
})
