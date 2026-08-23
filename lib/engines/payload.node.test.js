'use strict'

// ---------------------------------------------------------------------------
//  第 1c 步：名片驱动的请求体组装
// ---------------------------------------------------------------------------
// 这一刀把「请求体长什么样」从平台代码搬到了名片上。搬家最怕的两件事：
//
//   ① 老引擎悄悄变了行为   → 黄金样本测试（下面第一组）：拿真名片过一遍，
//                            断言产物与**搬家前的算法**深度相等。
//   ② 新引擎还是收到脏键   → IndexTTS2 形状测试（第二组）：断言产物里
//                            一个 GPT-SoVITS 的键都没有。
//
// ⚠ 黄金样本比的是**深度相等**，不是"逐字节相同"：键的插入顺序变了
//   （speed/seed/media_type 现在在映射阶段就写进去，比过去早）。JSON 对象
//   的键序对 HTTP 请求没有语义，但这里必须说清楚，免得下次有人拿字符串比。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const {
  assembleEnginePayload, engineKey, acceptsKey,
  CORE_KEYS, OPTIONAL_KEYS, CANONICAL_KEYS,
} = require('./payload')
const { resolveEngineProfile } = require('./profile')

const ROOT = path.resolve(__dirname, '..', '..')

// ===========================================================================
//  搬家前的算法，逐行照抄（server.js @6abe760 :709-722 + :776-806）
// ===========================================================================
// ⛔ 不要"顺手整理"这段代码。它存在的唯一意义就是**留住搬家前的行为**，
//   一旦被改写成"看起来更干净的等价物"，它就不再是独立的真值来源了。
const LEGACY_PASS_THROUGH_KEYS = [
  'text', 'text_lang', 'ref_audio_path', 'aux_ref_audio_paths',
  'prompt_text', 'prompt_lang',
  'top_k', 'top_p', 'temperature', 'repetition_penalty', 'seed',
  'speed_factor', 'text_split_method',
  'batch_size', 'batch_threshold', 'split_bucket',
  'fragment_interval', 'parallel_infer',
  'sample_steps', 'if_sr', 'super_sampling',
  'media_type', 'streaming_mode',
  'overlap_length', 'min_chunk_length',
  'pron_overrides',
  'auto_base_lang',
  'lang_overrides',
]

// 搬家前 buildTtsPayload 的后半段（参考音频已解析好，从"基础字段"那一行起）。
function legacyBuildPayload(text, cfg, refAudio, refText, defaultBatchSize = 4) {
  const payload = {
    text,
    text_lang: cfg.text_lang || cfg.language || 'ja',
    ref_audio_path: refAudio,
    prompt_text: refText,
    prompt_lang: cfg.prompt_lang || cfg.language || 'ja',
  }
  for (const key of LEGACY_PASS_THROUGH_KEYS) {
    if (cfg[key] !== undefined && cfg[key] !== null && cfg[key] !== '') {
      payload[key] = cfg[key]
    }
  }
  if (payload.top_k === undefined) payload.top_k = 15
  if (payload.top_p === undefined) payload.top_p = 1.0
  if (payload.temperature === undefined) payload.temperature = 1.0
  if (payload.text_split_method === undefined) payload.text_split_method = 'cut5'
  if (payload.batch_size === undefined) payload.batch_size = defaultBatchSize
  if (payload.batch_threshold === undefined) payload.batch_threshold = 0.75
  if (payload.split_bucket === undefined) payload.split_bucket = true
  if (payload.speed_factor === undefined) payload.speed_factor = 1.0
  if (payload.fragment_interval === undefined) payload.fragment_interval = 0.3
  if (payload.media_type === undefined) payload.media_type = 'wav'
  if (payload.streaming_mode === undefined) payload.streaming_mode = false
  if (payload.parallel_infer === undefined) payload.parallel_infer = true
  if (payload.repetition_penalty === undefined) payload.repetition_penalty = 1.35
  if (payload.seed === undefined) payload.seed = -1
  return payload
}

// 新算法：等价于 server.js 的 buildTtsPayload（参考音频解析那半段除外，
// 那一半已经拆成 resolveReference，与引擎无关）。
function newBuildPayload(profile, text, cfg, refAudio, refText) {
  return assembleEnginePayload({
    profile,
    canonical: {
      text,
      text_lang: cfg.text_lang || cfg.language || 'ja',
      reference_audio: refAudio,
      reference_text: refText,
      reference_lang: cfg.prompt_lang || cfg.language || 'ja',
      speed: cfg.speed_factor,
      seed: cfg.seed,
      media_type: cfg.media_type,
      aux_reference_audio: cfg.aux_ref_audio_paths,
    },
    cfg,
    engineParams: cfg.engine_params,
  })
}

function gsvProfile() {
  return resolveEngineProfile('gpt-sovits', {})
}

// ===========================================================================
//  第一组：黄金样本 —— 真名片过一遍，与搬家前的算法深度相等
// ===========================================================================

// 六组 cfg，覆盖搬家最容易走样的每一类取值。
const GOLDEN_CASES = [
  {
    name: 'webui 老路径最常见的一次调用（大部分参数走默认值）',
    text: 'こんにちは',
    refAudio: 'D:\\assets\\ref.wav',
    refText: '参考テキスト',
    cfg: { language: 'ja' },
  },
  {
    name: '配方把该调的都调了（白名单里的键全部有值）',
    text: 'テスト',
    refAudio: '/data/ref.wav',
    refText: '参考',
    cfg: {
      text_lang: 'ja', prompt_lang: 'ja',
      top_k: 20, top_p: 0.9, temperature: 0.8, repetition_penalty: 1.2,
      speed_factor: 1.15, text_split_method: 'cut3',
      batch_size: 8, batch_threshold: 0.8, fragment_interval: 0.5,
      seed: 12345, media_type: 'wav',
    },
  },
  {
    name: '⚠ 假值必须发出去：split_bucket=false / seed=0 / parallel_infer=false',
    text: 'x',
    refAudio: '/a.wav',
    refText: 'r',
    cfg: { language: 'zh', split_bucket: false, parallel_infer: false, seed: 0, if_sr: false },
  },
  {
    name: '⚠ 没有参考文本时 prompt_text 是空串 —— 空串也要发（这是 CORE 的意义）',
    text: 'x',
    refAudio: '/a.wav',
    refText: '',
    cfg: { language: 'zh' },
  },
  {
    name: '空串 / null 的可选参数被丢掉（与搬家前的过滤条件一致）',
    text: 'x',
    refAudio: '/a.wav',
    refText: 'r',
    cfg: { language: 'ja', top_k: '', temperature: null, text_split_method: '', speed_factor: '' },
  },
  {
    name: '读音覆盖等结构化参数原样透传',
    text: 'x',
    refAudio: '/a.wav',
    refText: 'r',
    cfg: {
      language: 'ja',
      pron_overrides: { '東京': 'とうきょう' },
      lang_overrides: [{ at: 2, lang: 'en' }],
      auto_base_lang: 'zh',
      aux_ref_audio_paths: ['/b.wav', '/c.wav'],
    },
  },
]

for (const c of GOLDEN_CASES) {
  test(`⭐ 黄金样本：${c.name}`, () => {
    const profile = gsvProfile()
    const before = legacyBuildPayload(c.text, c.cfg, c.refAudio, c.refText)
    const after = newBuildPayload(profile, c.text, c.cfg, c.refAudio, c.refText)
    assert.deepStrictEqual(after, before,
      '名片驱动的产物与搬家前的算法不一致 —— GPT-SoVITS 的行为被改了。\n' +
      `搬家前: ${JSON.stringify(before, null, 2)}\n` +
      `搬家后: ${JSON.stringify(after, null, 2)}`)
  })
}

test('⭐ 黄金样本的比法是"深度相等"；键序在什么情况下会变，这里量出来', () => {
  const profile = gsvProfile()

  // ① webui 老路径最常见的那一次调用：键序**一模一样**。
  //    （我一开始以为键序一定会变，实测不是 —— cfg 没显式给 speed/seed/media_type
  //    时，它们仍然是在最后的 defaults 阶段才落进去的，位置没动。）
  const cfgA = { language: 'ja' }
  assert.deepStrictEqual(
    Object.keys(newBuildPayload(profile, 'x', cfgA, '/a.wav', 'r')),
    Object.keys(legacyBuildPayload('x', cfgA, '/a.wav', 'r')),
    '默认那一路的键序不该动')

  // ② cfg 里显式给了 speed_factor / seed / media_type 时，键序会变：
  //    这三个键从"白名单透传"阶段提前到了"映射"阶段。JSON 对象的键序对 HTTP
  //    没有语义，所以这是可以接受的；写在这里是为了让"我们知道它变了、
  //    也知道只有这一种情况会变"是量出来的，而不是嘴上说的。
  const cfgB = { text_lang: 'ja', prompt_lang: 'ja', top_k: 20, speed_factor: 1.15, seed: 12345, media_type: 'wav' }
  const before = legacyBuildPayload('x', cfgB, '/a.wav', 'r')
  const after = newBuildPayload(profile, 'x', cfgB, '/a.wav', 'r')
  assert.deepStrictEqual(after, before, '值必须一样')
  assert.notDeepStrictEqual(Object.keys(after), Object.keys(before))
  assert.deepStrictEqual(Object.keys(after).sort(), Object.keys(before).sort())
  assert.deepStrictEqual(Object.keys(after).slice(0, 8),
    ['text', 'text_lang', 'ref_audio_path', 'prompt_text', 'prompt_lang', 'speed_factor', 'seed', 'media_type'])
  assert.deepStrictEqual(Object.keys(before).slice(0, 8),
    ['text', 'text_lang', 'ref_audio_path', 'prompt_text', 'prompt_lang', 'top_k', 'seed', 'speed_factor'])
})

test('⭐ batch_size 的默认值来自名片，而且它不是引擎自己的默认值（是我们的调优决策）', () => {
  const profile = gsvProfile()
  assert.strictEqual(profile.defaults.batch_size, 4,
    'GPT-SoVITS 自己默认 batch_size=1；4 是平台为了缩短一次多句请求的墙钟时间定的。' +
    '这条要是没了，生成会悄悄变慢，而且不报错')
})

test('defaults_env：名片自己声明哪个环境变量能顶掉默认值（低显存显卡降回 1）', () => {
  assert.strictEqual(resolveEngineProfile('gpt-sovits', { AURIVOX_TTS_BATCH_SIZE: '1' }).defaults.batch_size, 1)
  assert.strictEqual(resolveEngineProfile('gpt-sovits', { AURIVOX_TTS_BATCH_SIZE: '16' }).defaults.batch_size, 16)
  // 非整数 / 越界 / 空 → 回落名片上的值，与搬家前 _DEFAULT_TTS_BATCH_SIZE 的
  // parseInt + [1,16] 范围检查逐条一致。
  for (const bad of ['0', '17', 'abc', '', '-3']) {
    assert.strictEqual(resolveEngineProfile('gpt-sovits', { AURIVOX_TTS_BATCH_SIZE: bad }).defaults.batch_size, 4,
      `AURIVOX_TTS_BATCH_SIZE=${JSON.stringify(bad)} 应该被判为非法并回落到名片上的 4`)
  }
  // ⚠ parseInt 的既有宽松行为：'2.5x' 会被读成 2，不是被判非法。
  //   搬家前 server.js 的 _DEFAULT_TTS_BATCH_SIZE 也是这么算的，所以这里
  //   照抄，不"顺手改严" —— 搬家这一刀不改行为，要改另开一刀。
  assert.strictEqual(resolveEngineProfile('gpt-sovits', { AURIVOX_TTS_BATCH_SIZE: '2.5x' }).defaults.batch_size, 2)
})

// ===========================================================================
//  第二组：IndexTTS2 形状 —— 这一条直接对应 shim.py 的 400
// ===========================================================================

test('⭐⭐ IndexTTS2 只收到它认识的键 —— 一个 GPT-SoVITS 的键都没有', () => {
  const profile = resolveEngineProfile('indextts2', {})
  // 故意喂一份 GPT-SoVITS 形状的 cfg：这正是搬家前发过去的东西。
  const cfg = {
    language: 'zh', text_lang: 'zh', prompt_lang: 'zh',
    top_k: 15, top_p: 1.0, temperature: 1.0, text_split_method: 'cut5',
    batch_size: 4, batch_threshold: 0.75, split_bucket: true,
    fragment_interval: 0.3, parallel_infer: true, repetition_penalty: 1.35,
    speed_factor: 1.0, sample_steps: 32, if_sr: false, super_sampling: false,
    streaming_mode: false, seed: 7, media_type: 'wav',
    engine_params: { emo_alpha: 0.8, interval_silence: 200 },
  }
  const payload = assembleEnginePayload({
    profile,
    canonical: {
      text: '你好', text_lang: 'zh',
      reference_audio: '/a.wav', reference_text: '参考',
      reference_lang: 'zh', speed: 1.0, seed: 7, media_type: 'wav',
    },
    cfg,
    engineParams: cfg.engine_params,
  })

  assert.deepStrictEqual(payload, {
    text: '你好',
    ref_audio_path: '/a.wav',
    seed: 7,
    media_type: 'wav',
    emo_alpha: 0.8,
    interval_silence: 200,
  })

  // 逐个点名 shim.py:382-392 会拦下来的键，把"必然 400"钉死。
  for (const leaked of [
    'text_lang', 'prompt_text', 'prompt_lang', 'top_k', 'top_p', 'temperature',
    'text_split_method', 'batch_size', 'batch_threshold', 'split_bucket',
    'fragment_interval', 'parallel_infer', 'repetition_penalty', 'speed_factor',
    'sample_steps', 'if_sr', 'super_sampling', 'streaming_mode',
    'aux_ref_audio_paths', 'pron_overrides', 'lang_overrides',
  ]) {
    assert.ok(!(leaked in payload),
      `${leaked} 漏进了 IndexTTS2 的请求体 —— 它的 shim 对未知键直接 400` +
      '（engines/indextts2/shim.py:382-392），这次调用会整个失败')
  }
})

test('⛔ 加载期参数（use_fp16 之类）不在 payload_keys 上 —— 按次发过去会被引擎明确拒绝', () => {
  const profile = resolveEngineProfile('indextts2', {})
  for (const loadTimeKey of ['use_fp16', 'use_cuda_kernel', 'use_deepspeed', 'use_accel', 'use_torch_compile']) {
    assert.ok(!acceptsKey(profile, loadTimeKey),
      `${loadTimeKey} 是 IndexTTS2 的**加载期**参数（shim.py:115-118），` +
      '它属于起进程的时候，不属于每一次调用')
  }
})

test('IndexTTS2 没有的概念就是没有 —— maps 里查不到，不是回落成某个默认键名', () => {
  const profile = resolveEngineProfile('indextts2', {})
  assert.strictEqual(engineKey(profile, 'text'), 'text')
  assert.strictEqual(engineKey(profile, 'reference_audio'), 'ref_audio_path')
  for (const noSuchConcept of ['text_lang', 'reference_text', 'reference_lang', 'speed', 'aux_reference_audio', 'streaming']) {
    assert.strictEqual(engineKey(profile, noSuchConcept), '',
      `IndexTTS2 没有「${noSuchConcept}」这个概念，engineKey 必须返回空串让调用方整段跳过`)
  }
})

// ===========================================================================
//  第三组：组装规则本身
// ===========================================================================

const TOY = {
  id: 'toy',
  dir: '/tmp/toy',
  maps: {
    text: 'T', text_lang: 'TL', reference_audio: 'RA', reference_text: 'RT',
    reference_lang: 'RL', speed: 'SP', seed: 'SD', media_type: 'MT',
  },
  payload_keys: ['a', 'b', 'SD'],
  defaults: { a: 'default-a', z: 'default-z' },
}

test('CORE 的空串照发，OPTIONAL 的空串不发', () => {
  const payload = assembleEnginePayload({
    profile: TOY,
    canonical: { text: 'x', reference_text: '', media_type: '' },
  })
  assert.strictEqual(payload.RT, '', 'reference_text 是 CORE：空串是一个有意义的值，要发')
  assert.ok(!('MT' in payload), 'media_type 是 OPTIONAL：空串等于没填，不发')
})

test('⚠ false 和 0 必须发出去（这一步最容易被写成 `if (v)` 而悄悄丢掉）', () => {
  const payload = assembleEnginePayload({
    profile: TOY,
    canonical: { text: 'x', seed: 0 },
    cfg: { a: false, b: 0 },
  })
  assert.strictEqual(payload.SD, 0, 'seed=0 是一个具体的种子，不是"没填"')
  assert.strictEqual(payload.a, false)
  assert.strictEqual(payload.b, 0)
})

test('undefined / null 不发', () => {
  const payload = assembleEnginePayload({
    profile: TOY,
    canonical: { text: 'x', speed: undefined, seed: null },
    cfg: { b: null },
  })
  assert.ok(!('SP' in payload))
  assert.ok(!('SD' in payload))
  assert.ok(!('b' in payload))
})

test('名片没映射的平台词，一个键都不发（不是发一个同名键过去）', () => {
  const profile = { ...TOY, maps: { text: 'T' } }
  const payload = assembleEnginePayload({
    profile,
    canonical: { text: 'x', text_lang: 'ja', reference_audio: '/a.wav', speed: 1.2 },
  })
  assert.deepStrictEqual(Object.keys(payload).sort(), ['T', 'a', 'z'])
  for (const k of ['text_lang', 'reference_audio', 'speed', 'TL', 'RA', 'SP']) {
    assert.ok(!(k in payload), `${k} 不该出现：名片没说这台引擎有这个概念`)
  }
})

test('cfg 透传只走白名单 —— 白名单外的键碰都不碰', () => {
  const payload = assembleEnginePayload({
    profile: TOY,
    canonical: { text: 'x' },
    cfg: { a: 1, b: 2, c: 3, top_k: 15, ref_audio_path: '/hack.wav' },
  })
  assert.strictEqual(payload.a, 1)
  assert.strictEqual(payload.b, 2)
  for (const k of ['c', 'top_k', 'ref_audio_path']) {
    assert.ok(!(k in payload), `${k} 不在 payload_keys 上，不该被透传`)
  }
})

test('⭐ 叠加顺序：engine_params 盖 cfg 透传，defaults 只填空', () => {
  const payload = assembleEnginePayload({
    profile: TOY,
    canonical: { text: 'x' },
    cfg: { a: 'from-cfg', b: 'from-cfg' },
    engineParams: { a: 'from-recipe', z: 'from-recipe' },
  })
  assert.strictEqual(payload.a, 'from-recipe', '配方里写的应该盖过 cfg 透传的')
  assert.strictEqual(payload.b, 'from-cfg', '配方没写的，cfg 透传的留着')
  assert.strictEqual(payload.z, 'from-recipe', 'defaults 只填没人填过的键，不许盖掉配方')
})

test('⭐ engine_params 一个键都不过滤 —— 平台是搬运工不是翻译（Owner 2026-08-23 定）', () => {
  const payload = assembleEnginePayload({
    profile: TOY,
    canonical: { text: 'x' },
    engineParams: { 完全没见过的键: 1, emo_alpha: 0.8, nested: { deep: true }, arr: [1, 2] },
  })
  assert.strictEqual(payload['完全没见过的键'], 1,
    '平台只校验这一格非空，不看里面。键名写错了引擎自己会报错，那个报错比我们瞎猜的准')
  assert.deepStrictEqual(payload.nested, { deep: true })
  assert.deepStrictEqual(payload.arr, [1, 2])
})

test('engine_params 不是对象（null / 数组 / 字符串）时安静跳过，不炸', () => {
  for (const junk of [null, undefined, [1, 2], 'nope', 42]) {
    const payload = assembleEnginePayload({ profile: TOY, canonical: { text: 'x' }, engineParams: junk })
    assert.strictEqual(payload.T, 'x')
  }
})

test('⭐ 名片缺 maps.text ⇒ 当场抛 ENGINE_MANIFEST_INCOMPLETE，并指到具体文件', () => {
  const profile = { id: 'broken', dir: '/x/engines/broken', maps: {}, payload_keys: [], defaults: {} }
  assert.throws(
    () => assembleEnginePayload({ profile, canonical: { text: 'x' } }),
    (err) => {
      assert.strictEqual(err.code, 'ENGINE_MANIFEST_INCOMPLETE')
      assert.match(err.message, /maps\.text/)
      assert.match(err.message, /manifest\.json/)
      assert.match(err.message, /broken/)
      return true
    },
    '名片没说"要合成的文本"叫什么键名时，必须在这里报错 —— ' +
    '不能拼一个引擎看不懂的东西发过去，然后收一句模糊的上游 400')
})

test('acceptsKey：不在白名单上就是不收', () => {
  assert.ok(acceptsKey(TOY, 'a'))
  assert.ok(!acceptsKey(TOY, 'nope'))
  assert.ok(!acceptsKey({}, 'a'), '名片没有 payload_keys 时一律不收，不是一律放行')
  assert.ok(!acceptsKey(null, 'a'))
})

test('平台词汇表是封闭的：CORE 与 OPTIONAL 不重叠，且合起来就是 CANONICAL', () => {
  assert.deepStrictEqual(CANONICAL_KEYS, [...CORE_KEYS, ...OPTIONAL_KEYS])
  assert.strictEqual(new Set(CANONICAL_KEYS).size, CANONICAL_KEYS.length, '有重复的平台词')
  for (const k of CORE_KEYS) assert.ok(!OPTIONAL_KEYS.includes(k))
})

// ===========================================================================
//  第四组：割线守卫 —— 抽象层里不许出现任何一台引擎
// ===========================================================================

test('⭐⭐ 割线守卫：lib/engines/*.js 里不许出现引擎名或引擎私有键名', () => {
  const dir = path.join(ROOT, 'lib', 'engines')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.includes('.test.'))
  assert.ok(files.length >= 3, `lib/engines 下只找到 ${files.length} 个实现文件，路径怕是错了`)

  // 引擎的名字和它们的私有键名。抽象层认识这些词 = 割线又长回去了。
  const FORBIDDEN = [
    'indextts', 'index-tts', 'gpt-sovits', 'gpt_sovits', 'gptsovits', 'fishtts', 'fish-speech',
    'ref_audio_path', 'prompt_text', 'prompt_lang', 'text_split_method',
    'split_bucket', 'batch_threshold', 'fragment_interval', 'parallel_infer',
    'repetition_penalty', 'speed_factor', 'emo_alpha', 'sample_steps', 'super_sampling',
  ]
  const offences = []
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    // 注释里点名是允许的 —— 解释"为什么"必须能举出具体的例子。
    // 这里只看去掉注释之后的代码。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    for (const word of FORBIDDEN) {
      if (code.toLowerCase().includes(word)) offences.push(`${f} → ${word}`)
    }
  }
  assert.deepStrictEqual(offences, [],
    '抽象层的代码里出现了具体引擎的名字或私有键名：\n' + offences.join('\n') +
    '\n这些东西的唯一去处是 engines/<id>/manifest.json。' +
    '一旦它们回到这里，"加引擎不改代码"就又不成立了')
})

// ===========================================================================
//  第五组：平台侧还没搬完的泄漏点 —— 清单不许腐烂
// ===========================================================================

test('⚠ 平台侧仍在直接说引擎方言的地方，就这些 —— 只许变少不许变多', () => {
  // 这一刀把「拼请求体」搬到了名片上，但 cfg 这个对象**本身**的字段名还是
  // GPT-SoVITS 的方言（text_lang / speed_factor / top_k …）。那是下一刀。
  // 这条测试不修它，只是不让它继续长大 —— 仓库里已有的"清单不许腐烂"套路。
  const KNOWN_LEAKS = {
    'lib/routes/synthesis.js': [
      // cfg 构造：字段名是 GSV 方言（下一刀：cfg 词汇表去 GSV 化）
      'text_lang', 'prompt_lang', 'speed_factor', 'top_k', 'top_p',
      'temperature', 'repetition_penalty', 'text_split_method',
      'batch_size', 'batch_threshold', 'split_bucket', 'fragment_interval',
      'parallel_infer', 'sample_steps', 'if_sr',
      'overlap_length', 'min_chunk_length', 'aux_ref_audio_paths',
    ],
  }
  for (const [rel, expected] of Object.entries(KNOWN_LEAKS)) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const found = expected.filter((w) => src.includes(w))
    assert.deepStrictEqual(found.sort(), [...expected].sort(),
      `${rel} 的方言清单对不上了。少了 = 好事，把它从 KNOWN_LEAKS 里划掉；` +
      '多了 = 有人又往平台代码里写了一台引擎的私有词')
  }
})
