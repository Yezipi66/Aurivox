'use strict'

// ===========================================================================
//  钉子测试 · 合成服务（generateService）
// ===========================================================================
// 契约 §12 第 0 步。**不改一行行为代码**，只把今天 GPT-SoVITS 路径的实际
// 表现钉死，作为后面每一刀的安全网。
//
// 这个文件覆盖的是「服务怎么用它的零件」，纯函数本身在
// textSplit.nails.node.test.js 里单独钉。两者合起来才是完整的网。
//
// ⚠ 全部依赖都是注入的（createSynthesisService(ctx)），所以这里不起服务、
//   不连引擎、不碰真实资产目录。跑得快，才会有人真的去跑。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const createSynthesisService = require('./synthesisService')
const { toPcm16Wav, computeSegmentBounds, wavDurationSec } = require('../audio/wav')

// --------------------------------------------------------------------------
//  夹具
// --------------------------------------------------------------------------

// 一个结构合法的 16 位单声道 PCM WAV。nSamples 决定时长。
function makeWav (nSamples = 16000, sampleRate = 16000) {
  const data = Buffer.alloc(nSamples * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aurivox-nail-${tag}-`))
}

// 建一个完整的 ctx，所有对外副作用都被记录下来供断言。
// overrides 只覆盖需要变化的那几个键。
function makeCtx (overrides = {}) {
  const root = tmpDir('gen')
  const refPath = path.join(root, 'ref.wav')
  fs.writeFileSync(refPath, makeWav())

  const calls = {
    root,
    refPath,
    switchModels: [],
    generateOneSegment: [],   // { text, cfg }
    concat: [],               // { files, out, silenceMs }
    meta: [],                 // { genId, meta }
    resolveSeed: 0,
    lockDepth: 0,
    maxLockDepth: 0,
  }

  const ctx = {
    fs,
    path,
    // ---- 引擎侧（全部记录，不真的推理）----
    switchModels: async (cfg) => { calls.switchModels.push({ cfg, afterSegments: calls.generateOneSegment.length }) },
    generateOneSegment: async (text, cfg) => {
      calls.generateOneSegment.push({ text, cfg: JSON.parse(JSON.stringify(cfg)) })
      return makeWav(8000) // 0.5 秒
    },
    toPcm16Wav,                       // 真实现
    computeSegmentBounds,             // 真实现
    wavDurationSec: () => 5,          // 默认参考音频 5 秒（落在 3–10s 内）
    concatWavFiles: async (files, out, silenceMs) => {
      calls.concat.push({ files: [...files], out, silenceMs })
      fs.writeFileSync(out, Buffer.concat(files.map((f) => fs.readFileSync(f))))
      return { method: 'node' }
    },
    // ---- 分段（真算法在 textSplit.nails 里单独钉，这里钉「服务怎么用它」）----
    splitJapaneseText: (text, opts) => {
      calls.split = { text, opts }
      const { softLimit } = opts
      const out = []
      for (let i = 0; i < text.length; i += softLimit) out.push(text.slice(i, i + softLimit))
      return out
    },
    // ---- 资产 / 元数据 ----
    loadVoices: () => ({ v1: { language: 'zh' } }),
    isBaseVoice: () => false,
    baseVoiceReg: () => ({ language: 'zh' }),
    // ⭐ 第 1c 步：这里过去 stub 的是 buildTtsPayload，然后服务去读它返回的
    //   ref_audio_path / prompt_text —— 那是 GPT-SoVITS 的键名。夹具本身
    //   就是这条泄漏的证据。现在服务问的是平台自己的词。
    resolveReference: () => ({ reference_audio: refPath, reference_text: '参考文本' }),
    buildTtsPayload: () => ({ ref_audio_path: refPath, prompt_text: '参考文本' }),
    newGenId: () => 'GENID',
    normSource: (s) => (s ? String(s) : 'generate'),
    genAssetDir: (genId) => path.join(root, genId),
    genBaseName: (p) => (p && typeof p === 'string' ? p.replace(/\\/g, '/').split('/').pop() : ''),
    writeGenMeta: (genId, meta) => { calls.meta.push({ genId, meta: JSON.parse(JSON.stringify(meta)) }) },
    resolveSeed: (seed) => {
      calls.resolveSeed++
      const n = typeof seed === 'number' ? seed : parseInt(seed, 10)
      return (Number.isInteger(n) && n >= 0) ? n : 123456
    },
    clientError: (err, fallback) => String((err && err.message) || fallback),
    // ---- 生成锁：记录嵌套深度，用来验证串行 ----
    withGenerationLock: (() => {
      let tail = Promise.resolve()
      return (fn) => {
        const run = tail.then(async () => {
          calls.lockDepth++
          calls.maxLockDepth = Math.max(calls.maxLockDepth, calls.lockDepth)
          try { return await fn() } finally { calls.lockDepth-- }
        })
        tail = run.catch(() => {})
        return run
      }
    })(),
    ...overrides,
  }
  return { ctx, calls }
}

const body = (extra = {}) => ({ voice: 'v1', text: '你好', ...extra })

// --------------------------------------------------------------------------
//  入口校验（已有覆盖，这里补齐边界）
// --------------------------------------------------------------------------

test('nail: 缺 voice / 缺 text / 超 5000 字分别是 400', async () => {
  const { ctx } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(() => generateService({ body: {} }), (e) => e.status === 400 && /Missing 'voice'/.test(e.message))
  await assert.rejects(() => generateService({ body: { voice: 'v1' } }), (e) => e.status === 400 && /Missing 'text'/.test(e.message))
  await assert.rejects(
    () => generateService({ body: body({ text: 'x'.repeat(5001) }) }),
    (e) => e.status === 400 && /Text too long/.test(e.message),
  )
  // 边界：正好 5000 字放行（不是 400）
  await assert.doesNotReject(() => generateService({ body: body({ text: 'x'.repeat(5000), split: false }) }))
})

// --------------------------------------------------------------------------
//  钉子 6：参考音频 3–10 秒这条校验今天确实拦下什么
//  为什么是它：第 1 步要把它改成读名片，得先知道原样。
// --------------------------------------------------------------------------

test('nail: 参考音频不存在 ⇒ 400，且没有调用过引擎', async () => {
  const { ctx, calls } = makeCtx({ resolveReference: () => ({ reference_audio: '', reference_text: '' }) })
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(() => generateService({ body: body() }), (e) => e.status === 400 && /Reference audio is missing/.test(e.message))
  assert.equal(calls.switchModels.length, 0)
  assert.equal(calls.generateOneSegment.length, 0)
})

test('nail: 参考音频 <3s 或 >10s ⇒ 400，报错文案今天点名 GPT-SoVITS', async () => {
  for (const seconds of [2.9, 10.1]) {
    const { ctx } = makeCtx({ wavDurationSec: () => seconds })
    const { generateService } = createSynthesisService(ctx)
    await assert.rejects(
      () => generateService({ body: body() }),
      (e) => e.status === 400 && /GPT-SoVITS requires a 3–10s reference clip/.test(e.message),
    )
  }
})

test('nail: 边界 3.0s 与 10.0s 放行；测不出时长（返回 0）也放行', async () => {
  for (const seconds of [3, 10, 0]) {
    const { ctx, calls } = makeCtx({ wavDurationSec: () => seconds })
    const { generateService } = createSynthesisService(ctx)
    await generateService({ body: body({ split: false }) })
    assert.equal(calls.generateOneSegment.length, 1, `${seconds}s 时应放行`)
  }
})

// --------------------------------------------------------------------------
//  钉子 4：种子
// --------------------------------------------------------------------------

test('nail: 种子只解析一次，且四处取值完全一致（返回值 / meta / recipe / 引擎入参）', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ seed: -1, split: false }) })

  assert.equal(calls.resolveSeed, 1, '种子解析了不止一次 —— 会出现两个不同的种子')
  const meta = calls.meta[0].meta
  assert.equal(res.seed, 123456)
  assert.equal(meta.seed, 123456)
  assert.equal(meta.recipe.seed, 123456, 'recipe 里必须是解析后的具体值，否则 Rerun 会重新随机')
  assert.equal(calls.generateOneSegment[0].cfg.seed, 123456)
})

test('nail: 多段合成时每段用的是同一个种子', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ text: 'x'.repeat(30), max_chars: 10 }) })
  const seeds = new Set(calls.generateOneSegment.map((c) => c.cfg.seed))
  assert.equal(seeds.size, 1, `各段种子不一致: ${[...seeds]}`)
})

// --------------------------------------------------------------------------
//  钉子 2：生成档案（meta.json）的字段与取值
//  为什么是它：画布、历史、批量都读它，字段名一改就静默断。
// --------------------------------------------------------------------------

test('nail: meta 的字段集合与关键取值', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({
    body: body({
      split: false, voice_label: '小明', gpt_model: 'D:\\m\\GPT_x.ckpt', sovits_model: '/m/SoVITS_y.pth',
      recipe_id: 'r-1', source: 'compare', text_lang: 'zh',
    }),
  })
  const { genId, meta } = calls.meta[0]
  assert.equal(genId, 'GENID')

  // 字段集合本身就是契约的一部分：少一个键，下游就少一块显示。
  assert.deepEqual(Object.keys(meta).sort(), [
    'audio_url', 'batch', 'concat', 'createdAt', 'files', 'gpt', 'gpt_model', 'id', 'lang',
    'recipe', 'recipe_id', 'ref_audio', 'ref_text', 'seed', 'segments', 'sovits', 'sovits_model',
    'source', 'split', 'status', 'text', 'voice', 'voiceLabel',
  ].sort())

  assert.equal(meta.id, 'GENID')
  assert.equal(meta.status, 'ok')
  assert.equal(meta.voice, 'v1')
  assert.equal(meta.voiceLabel, '小明')
  assert.equal(meta.recipe_id, 'r-1')
  assert.equal(meta.batch, null, '非批量生成时 batch 必须是 null，不是 undefined')
  // gpt / sovits 只存文件名（正反斜杠都要吃）
  assert.equal(meta.gpt, 'GPT_x.ckpt')
  assert.equal(meta.sovits, 'SoVITS_y.pth')
  // 完整路径另存，两者都在
  assert.equal(meta.gpt_model, 'D:\\m\\GPT_x.ckpt')
  assert.equal(meta.ref_text, '参考文本')
  assert.ok(Number.isInteger(meta.createdAt))
})

test('nail: 没给权重时 gpt / sovits 记为 "-"，不是空串', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ split: false }) })
  assert.equal(calls.meta[0].meta.gpt, '-')
  assert.equal(calls.meta[0].meta.sovits, '-')
})

// --------------------------------------------------------------------------
//  钉子 3：批次字段
// --------------------------------------------------------------------------

test('nail: 有 batch_id 才有 batch；seq/total 转整数，label 截断 200，id 截断 80', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({
    body: body({
      split: false,
      batch_id: `  ${'b'.repeat(100)}  `, batch_seq: '2', batch_total: 3.9, batch_label: 'L'.repeat(300),
    }),
  })
  const b = calls.meta[0].meta.batch
  assert.equal(b.id.length, 80, 'batch_id 必须先 trim 再截到 80')
  assert.equal(b.seq, 2)
  assert.equal(b.total, 3, '非整数 total 走 parseInt')
  assert.equal(b.label.length, 200)
})

test('nail: 空白 batch_id 视为没有批次', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ split: false, batch_id: '   ' }) })
  assert.equal(calls.meta[0].meta.batch, null)
})

test('nail: ⭐ 存进 recipe 的配方必须剥掉全部 batch_* 字段', async () => {
  // 不剥的话，Rerun 会静默重新加入一个早已结束的旧批次。
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({
    body: body({ split: false, batch_id: 'B', batch_seq: 1, batch_total: 2, batch_label: 'L' }),
  })
  const recipe = calls.meta[0].meta.recipe
  for (const k of ['batch_id', 'batch_seq', 'batch_total', 'batch_label']) {
    assert.ok(!(k in recipe), `recipe 里不该有 ${k}`)
  }
  assert.equal(calls.meta[0].meta.batch.id, 'B', '批次信息只应活在 meta.batch 一处')
})

// --------------------------------------------------------------------------
//  换权重的时机
// --------------------------------------------------------------------------

test('nail: switchModels 在锁内、在任何一次推理之前、每个请求只调一次', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ text: 'x'.repeat(30), max_chars: 10 }) })
  assert.equal(calls.generateOneSegment.length, 3)
  assert.equal(calls.switchModels.length, 1, '⚠ 今天是每个请求一次（不是每段一次）')
  assert.equal(calls.switchModels[0].afterSegments, 0, 'switchModels 必须发生在第一段推理之前')
})

// --------------------------------------------------------------------------
//  钉子 7：生成锁
// --------------------------------------------------------------------------

test('nail: 两个请求同时进来会被串行化（锁内并发深度恒为 1）', async () => {
  const { ctx, calls } = makeCtx({
    generateOneSegment: async (text, cfg) => {
      await new Promise((r) => setTimeout(r, 20))
      return makeWav(8000)
    },
  })
  // 上面覆盖掉了记录，这里单独补一层记录
  const inner = ctx.generateOneSegment
  ctx.generateOneSegment = async (text, cfg) => { calls.generateOneSegment.push({ text, cfg }); return inner(text, cfg) }

  const { generateService } = createSynthesisService(ctx)
  await Promise.all([
    generateService({ body: body({ split: false }) }),
    generateService({ body: body({ split: false }) }),
  ])
  assert.equal(calls.maxLockDepth, 1, '两个请求同时进了锁 —— 单卡会互相踩')
})

// --------------------------------------------------------------------------
//  钉子 1'：服务怎么用分段器（真算法在 textSplit.nails 里钉）
// --------------------------------------------------------------------------

test('nail: hardLimit 恒为 softLimit 的两倍；max_chars 下限 10、默认 45', async () => {
  for (const [maxChars, expected] of [[undefined, 45], [10, 10], [1, 10], ['abc', 45], [120, 120]]) {
    const { ctx, calls } = makeCtx()
    const { generateService } = createSynthesisService(ctx)
    await generateService({ body: body({ text: 'x'.repeat(200), max_chars: maxChars }) })
    assert.equal(calls.split.opts.softLimit, expected, `max_chars=${maxChars}`)
    assert.equal(calls.split.opts.hardLimit, expected * 2)
  }
})

test('nail: 分段文件名是 seg000 起的三位补零，且 meta.files 与返回段一一对应', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ text: 'x'.repeat(25), max_chars: 10 }) })

  assert.equal(res.segments.length, 3)
  assert.deepEqual(res.segments.map((s) => s.audio_url.split('/').pop()), ['seg000.wav', 'seg001.wav', 'seg002.wav'])
  assert.deepEqual(res.segments.map((s) => s.index), [0, 1, 2])
  assert.deepEqual(res.segments.map((s) => s.source_start), [0, 10, 20], 'source_start 是段在全文里的起点')

  const files = calls.meta[0].meta.files
  assert.equal(files[0].role, 'combined')
  assert.deepEqual(files.slice(1).map((f) => f.role), ['segment', 'segment', 'segment'])
  // 盘上真的落了这些文件
  for (const s of res.segments) assert.ok(fs.existsSync(path.join(calls.root, 'GENID', s.audio_url.split('/').pop())))
})

test('nail: 单段路径写 audio.wav，split/concat 均为 false', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ text: '短文本' }) })
  assert.equal(res.split, false)
  assert.equal(res.concat, false)
  assert.equal(res.audio_url, '/outputs/generate/GENID/audio.wav')
  assert.ok(fs.existsSync(path.join(calls.root, 'GENID', 'audio.wav')))
  assert.deepEqual(calls.meta[0].meta.files, [{ role: 'single', name: 'audio.wav', url: '/outputs/generate/GENID/audio.wav' }])
})

test('nail: engine_batch 打开时整段文本一次调用（不分段），"true" 字符串也算开', async () => {
  for (const flag of [true, 'true']) {
    const { ctx, calls } = makeCtx()
    const { generateService } = createSynthesisService(ctx)
    const res = await generateService({ body: body({ text: 'x'.repeat(200), engine_batch: flag }) })
    assert.equal(calls.generateOneSegment.length, 1, 'engine_batch 下必须只有一次 /tts')
    assert.equal(calls.generateOneSegment[0].text.length, 200)
    assert.equal(res.engine_batch, true)
    assert.equal(calls.meta[0].meta.engine_batch, true)
  }
})

test('nail: split=false 时整段一次调用', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ text: 'x'.repeat(200), split: false }) })
  assert.equal(calls.generateOneSegment.length, 1)
})

// --------------------------------------------------------------------------
//  钉子 5：读音重映射的介入时机
//  为什么是它：时机变了，多音字会在段边界上出错。
// --------------------------------------------------------------------------

test('nail: ⭐ 重映射发生在分段之后、逐段进行，@N 位置按段内坐标重编号', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  // 全文 30 字，每 10 字一段；覆盖挂在第 2 段（全文 @12）上。
  await generateService({
    body: body({
      text: '甲'.repeat(12) + '乙' + '丙'.repeat(17),
      max_chars: 10,
      // 形状：{ 语言: { "@绝对位置:字": 读音 } }
      pron_overrides: { zh: { '@12:乙': 'yi3' } },
    }),
  })
  assert.equal(calls.generateOneSegment.length, 3)
  const withOverride = calls.generateOneSegment.filter((c) => c.cfg.pron_overrides)
  assert.equal(withOverride.length, 1, '覆盖应该只落在它所属的那一段上，不该被每段重复套用')
  assert.ok(withOverride[0].text.includes('乙'))
  assert.deepEqual(withOverride[0].cfg.pron_overrides, { zh: { '@2:乙': 'yi3' } }, '段内坐标应重编号为 @2')
})

test('nail: 不带位置的词级读音覆盖每段都要透传（它与分段无关）', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({
    body: body({ text: 'x'.repeat(30), max_chars: 10, pron_overrides: { zh: { 银行: 'yin2 hang2' } } }),
  })
  assert.equal(calls.generateOneSegment.length, 3)
  for (const c of calls.generateOneSegment) {
    assert.deepEqual(c.cfg.pron_overrides, { zh: { 银行: 'yin2 hang2' } })
  }
})

test('nail: 段内没有任何位置覆盖时，不给引擎留一个空壳', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({
    body: body({ text: 'x'.repeat(30), max_chars: 10, pron_overrides: { zh: { '@0:x': 'ex' } } }),
  })
  assert.deepEqual(calls.generateOneSegment[1].cfg.pron_overrides, undefined)
  assert.deepEqual(calls.generateOneSegment[2].cfg.pron_overrides, undefined)
})

test('nail: 空的 pron_overrides / lang_overrides 不透传（不是传空对象）', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ split: false, pron_overrides: {}, lang_overrides: {} }) })
  assert.equal(calls.generateOneSegment[0].cfg.pron_overrides, undefined)
  assert.equal(calls.generateOneSegment[0].cfg.lang_overrides, undefined)
})

// --------------------------------------------------------------------------
//  段边界（波形分隔线的来源）
// --------------------------------------------------------------------------

test('nail: 段边界按 silence_ms 累加，且写进 meta 与返回值', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ text: 'x'.repeat(20), max_chars: 10, silence_ms: 500 }) })

  // 每段 0.5 秒 + 中间 0.5 秒静音
  assert.deepEqual(res.segment_bounds, [{ index: 0, start: 0, end: 0.5 }, { index: 1, start: 1, end: 1.5 }])
  assert.equal(res.duration, 1.5)
  assert.deepEqual(calls.meta[0].meta.segment_bounds, res.segment_bounds)
  assert.equal(res.silence_ms, 500)
  assert.equal(res.concat_method, 'node')
  // 返回的 segments 也带上了 start/end
  assert.deepEqual(res.segments.map((s) => [s.start, s.end]), [[0, 0.5], [1, 1.5]])
})

test('nail: silence_ms 夹在 0–2000；⚠ 0 与非法值回落 300，但负数变 0', async () => {
  // ⚠ 记录实际表现：`parseInt(v,10) || 300` 让 0 和 NaN 都回落 300，
  //   而 -5 是真值 ⇒ 走 Math.max(0,-5) ⇒ 0。
  //   于是「想要没有间隔」得传 -1，传 0 反而得到 300ms。第 0 步只钉不修。
  for (const [given, expected] of [[undefined, 300], [0, 300], [-5, 0], [99999, 2000], [800, 800], ['abc', 300]]) {
    const { ctx, calls } = makeCtx()
    const { generateService } = createSynthesisService(ctx)
    await generateService({ body: body({ text: 'x'.repeat(20), max_chars: 10, silence_ms: given }) })
    assert.equal(calls.concat[0].silenceMs, expected, `silence_ms=${given}`)
  }
})

test('nail: concat=false 时不拼接，audio_url 指向第一段', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ text: 'x'.repeat(20), max_chars: 10, concat: false }) })
  assert.equal(calls.concat.length, 0)
  assert.equal(res.concat, false)
  assert.equal(res.audio_url.split('/').pop(), 'seg000.wav')
})

test('nail: 分段器只切出一段时不拼接，并带 warning', async () => {
  // 文本长于 softLimit（所以走了分段路径），但分段器只给回一段。
  const { ctx, calls } = makeCtx({ splitJapaneseText: (text) => [text] })
  const { generateService } = createSynthesisService(ctx)
  const res = await generateService({ body: body({ text: 'x'.repeat(30), max_chars: 10 }) })
  assert.equal(calls.concat.length, 0)
  assert.match(res.warning, /one segment/)
})

// --------------------------------------------------------------------------
//  失败路径
// --------------------------------------------------------------------------

test('nail: 某段失败 ⇒ 502，带段号、带已完成的段，且不写 meta', async () => {
  const { ctx, calls } = makeCtx()
  let n = 0
  const inner = ctx.generateOneSegment
  ctx.generateOneSegment = async (text, cfg) => {
    if (n++ === 1) throw new Error('GPT-SoVITS /tts failed (500): {"detail":"CUDA out of memory"}')
    return inner(text, cfg)
  }
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(
    () => generateService({ body: body({ text: 'x'.repeat(30), max_chars: 10 }) }),
    (e) => {
      assert.equal(e.status, 502)
      assert.match(e.message, /^Segment 1 failed: /)
      // 上游 JSON 里的 detail 被提出来，不是整坨 JSON
      assert.match(e.message, /CUDA out of memory/)
      assert.equal(e.extra.segments.length, 1, '已完成的段要带回去')
      return true
    },
  )
  assert.equal(calls.meta.length, 0, '失败时不该写 meta')
})

test('nail: 报错文案里的绝对路径被抹成 [path]，且长度截到 600', async () => {
  const { ctx } = makeCtx()
  ctx.generateOneSegment = async () => { throw new Error(`boom D:\\Project\\secret\\a.py and /home/u/x/y/z.py ${'z'.repeat(900)}`) }
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(
    () => generateService({ body: body({ text: 'x'.repeat(30), max_chars: 10 }) }),
    (e) => {
      assert.ok(!/D:\\Project/.test(e.message), '泄露了 Windows 绝对路径')
      assert.ok(!/\/home\/u/.test(e.message), '泄露了 POSIX 绝对路径')
      assert.match(e.message, /\[path\]/)
      assert.ok(e.message.length <= 600 + 'Segment 0 failed: '.length)
      return true
    },
  )
})

test('nail: 拼接失败 ⇒ 500，带 warning 说明段文件仍可播', async () => {
  const { ctx } = makeCtx({ concatWavFiles: async () => { throw new Error('ffmpeg died') } })
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(
    () => generateService({ body: body({ text: 'x'.repeat(20), max_chars: 10 }) }),
    (e) => e.status === 500 && /Segment files are still available/.test(e.extra.warning),
  )
})

test('nail: voices.json 读不出来 ⇒ 500（不是 404，也不是崩）', async () => {
  const { ctx } = makeCtx({ loadVoices: () => { throw new Error('bad json') } })
  const { generateService } = createSynthesisService(ctx)
  await assert.rejects(() => generateService({ body: body() }), (e) => e.status === 500)
})

// --------------------------------------------------------------------------
//  参数默认值（第 1 步会把这批默认值搬去名片，先钉住今天的值）
// --------------------------------------------------------------------------

test('nail: ⚠ 引擎参数默认值今天写死在服务里 —— 这批值就是第 1 步要搬去名片的', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ split: false }) })
  const cfg = calls.generateOneSegment[0].cfg
  assert.equal(cfg.temperature, 1.0)
  assert.equal(cfg.top_k, 15)
  assert.equal(cfg.top_p, 1.0)
  assert.equal(cfg.repetition_penalty, 1.35)
  assert.equal(cfg.text_split_method, 'cut5')
  assert.equal(cfg.speed_factor, 1.0)
  // 未给的高级参数保持 undefined（不能变成 0/false，那会覆盖引擎侧默认）
  for (const k of ['batch_size', 'batch_threshold', 'split_bucket', 'fragment_interval', 'parallel_infer', 'sample_steps', 'if_sr']) {
    assert.equal(cfg[k], undefined, `${k} 不该被填默认值`)
  }
})

test('nail: 语言回落链 —— 显式值 > 音色登记 > "auto"', async () => {
  const { ctx, calls } = makeCtx()
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: body({ split: false, text_lang: 'ja' }) })
  assert.equal(calls.generateOneSegment[0].cfg.text_lang, 'ja')

  const b = makeCtx()
  const svc2 = createSynthesisService(b.ctx)
  await svc2.generateService({ body: body({ split: false }) })
  assert.equal(b.calls.generateOneSegment[0].cfg.text_lang, 'zh', '应回落到音色登记的语言')

  const c = makeCtx({ loadVoices: () => ({ v1: {} }) })
  const svc3 = createSynthesisService(c.ctx)
  await svc3.generateService({ body: body({ split: false }) })
  assert.equal(c.calls.generateOneSegment[0].cfg.text_lang, 'auto')
})

test('nail: auto_zh_ja_yue 的基底语言被收敛到具体集合，非法值回落 zh', async () => {
  for (const [given, expected] of [['ja', 'ja'], ['yue', 'yue'], ['auto', 'zh'], ['xx', 'zh'], [undefined, 'zh']]) {
    const { ctx, calls } = makeCtx({ loadVoices: () => ({ v1: {} }) })
    const { generateService } = createSynthesisService(ctx)
    await generateService({ body: body({ split: false, text_lang: 'auto_zh_ja_yue', auto_base_lang: given }) })
    assert.equal(calls.generateOneSegment[0].cfg.auto_base_lang, expected, `auto_base_lang=${given}`)
    // meta 里存的必须是收敛后的值，不是原始 UI 值
    assert.equal(calls.meta[0].meta.auto_base_lang, expected)
    assert.equal(calls.meta[0].meta.recipe.auto_base_lang, expected)
  }
})
