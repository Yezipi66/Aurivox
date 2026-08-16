'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const acoustics = require('./acoustics')
const { FlowEngine, RUN_STATES } = require('./engine')
const { createSynthesizeAdapter, createConcatAdapter } = require('./adapter')

// ---------------------------------------------------------------------------
//  helpers — hand-built WAVs, so the numbers below are known, not guessed
// ---------------------------------------------------------------------------

function writeWav(samples, sampleRate = 16000) {
  const n = samples.length
  const buffer = Buffer.alloc(44 + n * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + n * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i += 1) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2)
  }
  return buffer
}

function tone(hz, { seconds = 1, sampleRate = 16000, amplitude = 0.3, lead = 0.1, trail = 0.1 } = {}) {
  const n = Math.round(seconds * sampleRate)
  const s = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate
    if (t < lead || t > seconds - trail) continue
    s[i] = amplitude * (Math.sin(2 * Math.PI * hz * t)
      + 0.4 * Math.sin(2 * Math.PI * 2 * hz * t)
      + 0.2 * Math.sin(2 * Math.PI * 3 * hz * t))
  }
  return writeWav(s, sampleRate)
}

function clippedTone(hz) {
  const sampleRate = 16000
  const n = sampleRate
  const s = new Float32Array(n)
  for (let i = 0; i < n; i += 1) s[i] = Math.max(-1, Math.min(1, 3 * Math.sin((2 * Math.PI * hz * i) / sampleRate)))
  return writeWav(s, sampleRate)
}

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `flowq-${label}-`))
}

function fileWith(buffer, name = 'clip.wav') {
  const dir = tmpdir('audio')
  const p = path.join(dir, name)
  fs.writeFileSync(p, buffer)
  return p
}

const node = (id, type, extra = {}) => Object.assign({ id, type, inputs: {}, params: {} }, extra)
const graph = nodes => ({ schema_version: 1, name: 'q', nodes, groups: [], blocks: [] })

// ---------------------------------------------------------------------------
//  tier 1 — the clip on its own
// ---------------------------------------------------------------------------

test('basic measurement reports duration, silence and loudness that match the file', () => {
  const m = acoustics.measureBasic(tone(150, { seconds: 2, lead: 0.5, trail: 0.25 }), { text: '一二三四五六' })
  assert.equal(m.tier, 1)
  assert.ok(Math.abs(m.duration_sec - 2) < 0.01)
  assert.ok(Math.abs(m.lead_silence_sec - 0.5) < 0.05, `开头静音应该 ~0.5s，量到 ${m.lead_silence_sec}`)
  assert.ok(Math.abs(m.trail_silence_sec - 0.25) < 0.05)
  assert.ok(Math.abs(m.silence_ratio - 0.375) < 0.03)
  assert.ok(m.rms_dbfs < 0 && m.rms_dbfs > -30)
  assert.equal(m.chars, 6)
  assert.ok(m.chars_per_sec > 0)
})

test('clipping is caught — this is the "声音炸了" check', () => {
  const clean = acoustics.measureBasic(tone(150))
  const broken = acoustics.measureBasic(clippedTone(150))
  assert.equal(clean.clipping_ratio, 0)
  assert.ok(broken.clipping_ratio > 0.3, `削顶比例应该很高，量到 ${broken.clipping_ratio}`)
  assert.ok(broken.peak_dbfs > -0.2)
})

test('a wildly wrong file is refused instead of producing junk numbers', () => {
  assert.throws(() => acoustics.measureBasic(Buffer.from('this is not audio at all')),
    err => err.code === 'FG_WAV_NOT_WAV')
})

// ---------------------------------------------------------------------------
//  tier 2 — against the reference
// ---------------------------------------------------------------------------

test('a clip compared with itself scores zero distance', () => {
  const clip = tone(150)
  const m = acoustics.measureSimilarity(clip, clip)
  assert.equal(m.tier, 2)
  assert.equal(m.mfcc_distance, 0)
  assert.equal(m.spectral_distance_db, 0)
  assert.equal(m.pitch_median_ratio, 1)
})

test('a further-away voice really does measure as further away', () => {
  const reference = tone(150)
  const near = acoustics.measureSimilarity(tone(160), reference)
  const far = acoustics.measureSimilarity(tone(300), reference)
  assert.ok(far.mfcc_distance > near.mfcc_distance,
    `远的应该距离更大：近 ${near.mfcc_distance} vs 远 ${far.mfcc_distance}`)
  assert.ok(far.spectral_distance_db > near.spectral_distance_db)
})

test('pitch is measured without the usual octave mistake', () => {
  const m = acoustics.measureSimilarity(tone(220), tone(150))
  assert.ok(Math.abs(m.pitch_median_hz - 220) < 15, `应该量到 ~220Hz，量到 ${m.pitch_median_hz}`)
  assert.ok(Math.abs(m.reference_pitch_median_hz - 150) < 15)
  assert.ok(m.pitch_median_ratio > 1.2)
})

// ---------------------------------------------------------------------------
//  measurement nodes only produce numbers
// ---------------------------------------------------------------------------

test('the measuring node hands out numbers and no verdict at all', async () => {
  const clip = fileWith(tone(150))
  const g = graph([
    node('audio', 'io.reference_audio', { params: { path: clip } }),
    node('measure', 'quality.measure_basic', { inputs: { audio: { node: 'audio', port: 'audio' } } }),
    node('view', 'out.preview', { inputs: { value: { node: 'measure', port: 'metrics' } } }),
  ])
  const report = await new FlowEngine({}).start(g)
  const metrics = report.events.find(e => e.type === 'preview').value
  assert.equal(metrics.tier, 1)
  // The whole design rests on this: no pass/fail/ok/good anywhere in a measurement.
  for (const forbidden of ['pass', 'ok', 'good', 'verdict', 'quality']) {
    assert.equal(metrics[forbidden], undefined, `测量结果里不该出现「${forbidden}」这种判断`)
  }
})

test('picking a metric that was never measured says so instead of returning zero', async () => {
  const clip = fileWith(tone(150))
  const g = graph([
    node('audio', 'io.reference_audio', { params: { path: clip } }),
    node('measure', 'quality.measure_basic', { inputs: { audio: { node: 'audio', port: 'audio' } } }),
    node('read', 'quality.read_metric', { inputs: { metrics: { node: 'measure', port: 'metrics' } }, params: { name: '响不响' } }),
  ])
  await assert.rejects(() => new FlowEngine({}).start(g), err => err.code === 'FG_METRIC_UNKNOWN')
})

// ---------------------------------------------------------------------------
//  scoring, weighting, thresholds
// ---------------------------------------------------------------------------

test('normalising works in both directions, including "smaller is better"', async () => {
  const run = async (value, good, bad) => {
    const g = graph([
      node('v', 'io.number', { params: { value } }),
      node('n', 'quality.normalize', { inputs: { value: { node: 'v', port: 'value' } }, params: { good, bad } }),
      node('view', 'out.preview', { inputs: { value: { node: 'n', port: 'score' } } }),
    ])
    const report = await new FlowEngine({}).start(g)
    return report.events.find(e => e.type === 'preview').value
  }
  assert.equal(await run(0.5, 1, 0), 50)
  // 距离越小越好：把满分值填在零分值下面就行，不需要另一个方向开关
  assert.equal(await run(0.25, 0, 1), 75)
  assert.equal(await run(5, 0, 1), 0, '超出范围要夹到 0，不能给负分')
  assert.equal(await run(-5, 0, 1), 100, '超出范围要夹到 100')
})

test('weights are the user taste and they actually change the total', async () => {
  const run = async weights => {
    const g = graph([
      node('a', 'io.number', { params: { value: 100 } }),
      node('b', 'io.number', { params: { value: 0 } }),
      node('na', 'quality.normalize', { inputs: { value: { node: 'a', port: 'value' } }, params: { good: 100, bad: 0 } }),
      node('nb', 'quality.normalize', { inputs: { value: { node: 'b', port: 'value' } }, params: { good: 100, bad: 0 } }),
      node('sum', 'quality.weighted_score', {
        inputs: { scores: [{ node: 'na', port: 'score' }, { node: 'nb', port: 'score' }] },
        params: { weights },
      }),
      node('view', 'out.preview', { inputs: { value: { node: 'sum', port: 'score' } } }),
    ])
    const report = await new FlowEngine({}).start(g)
    return report.events.find(e => e.type === 'preview').value
  }
  assert.equal(await run([1, 1]), 50)
  assert.equal(await run([3, 1]), 75)
  assert.equal(await run([1, 3]), 25)
})

test('a weight list that does not match the number of scores is refused', async () => {
  const g = graph([
    node('a', 'io.number', { params: { value: 1 } }),
    node('na', 'quality.normalize', { inputs: { value: { node: 'a', port: 'value' } }, params: { good: 1, bad: 0 } }),
    node('sum', 'quality.weighted_score', {
      inputs: { scores: [{ node: 'na', port: 'score' }] },
      params: { weights: [1, 2, 3] },
    }),
  ])
  await assert.rejects(() => new FlowEngine({}).start(g), err => err.code === 'FG_WEIGHTED_LENGTH_MISMATCH')
})

test('the threshold puts out a 0 or a 1 and decides nothing else', async () => {
  const run = async (value, line) => {
    const g = graph([
      node('v', 'io.number', { params: { value } }),
      node('n', 'quality.normalize', { inputs: { value: { node: 'v', port: 'value' } }, params: { good: 100, bad: 0 } }),
      node('gate', 'quality.threshold', { inputs: { score: { node: 'n', port: 'score' } }, params: { pass_score: line } }),
      node('view', 'out.preview', { inputs: { value: { node: 'gate', port: 'pass' } } }),
    ])
    const report = await new FlowEngine({}).start(g)
    return report.events.find(e => e.type === 'preview').value
  }
  assert.equal(await run(85, 80), 1)
  assert.equal(await run(75, 80), 0)
  assert.equal(await run(80, 80), 1, '刚好压线算过')
})

test('a saved quality standard overrides the number typed on the node', async () => {
  const g = graph([
    node('std', 'quality.standard', { params: { name: '严一点', pass_score: 95 } }),
    node('v', 'io.number', { params: { value: 90 } }),
    node('n', 'quality.normalize', { inputs: { value: { node: 'v', port: 'value' } }, params: { good: 100, bad: 0 } }),
    node('gate', 'quality.threshold', {
      inputs: { score: { node: 'n', port: 'score' }, standard: { node: 'std', port: 'standard' } },
      params: { pass_score: 50 },
    }),
    node('view', 'out.preview', { inputs: { value: { node: 'gate', port: 'pass' } } }),
  ])
  const report = await new FlowEngine({}).start(g)
  assert.equal(report.events.find(e => e.type === 'preview').value, 0, '标准说 95，节点上写的 50 不算数')
})

// ---------------------------------------------------------------------------
//  the failing branch is the user's to wire — including to release
// ---------------------------------------------------------------------------

test('failing the threshold does nothing by itself; wiring the 0 to release ends that line', async () => {
  const g = graph([
    node('v', 'io.number', { params: { value: 10 } }),
    node('n', 'quality.normalize', { inputs: { value: { node: 'v', port: 'value' } }, params: { good: 100, bad: 0 } }),
    node('gate', 'quality.threshold', { inputs: { score: { node: 'n', port: 'score' } }, params: { pass_score: 80 } }),
    node('keep', 'out.preview', {
      inputs: { value: { node: 'n', port: 'score' }, enable: { node: 'gate', port: 'pass' } },
    }),
    node('give_up', 'sys.release', { inputs: { value: { node: 'n', port: 'score' } } }),
  ])
  const report = await new FlowEngine({}).start(g)
  assert.equal(report.status, RUN_STATES.SUCCEEDED)
  assert.equal(Object.fromEntries(report.nodes.map(n => [n.node_id, n.status])).keep, 'skipped')
  assert.ok(report.events.some(e => e.type === 'released'))
})

// ---------------------------------------------------------------------------
//  batch: filter a whole list, then let a person make the last cut
// ---------------------------------------------------------------------------

test('list filtering keeps the ones above the line and hands back the dropped ones too', async () => {
  const g = graph([
    node('items', 'io.text', { params: { text: 'unused' } }),
    node('start', 'flow.loop_start', { params: { times: 5 } }),
    node('bag', 'flow.append', { inputs: { value: { node: 'start', port: 'index' } } }),
    node('score', 'quality.normalize', {
      inputs: { value: { node: 'start', port: 'index' } }, params: { good: 4, bad: 0 },
    }),
    node('scorebag', 'flow.append', { inputs: { value: { node: 'score', port: 'score' } } }),
    node('end', 'flow.loop_end', {
      inputs: { body: [{ node: 'bag', port: 'list' }, { node: 'scorebag', port: 'list' }] },
      params: { loop: 'start' },
    }),
    node('filter', 'quality.filter_list', {
      inputs: { items: { node: 'bag', port: 'list' }, scores: { node: 'scorebag', port: 'list' } },
      params: { pass_score: 50 },
    }),
    node('kept', 'out.preview', { inputs: { value: { node: 'filter', port: 'kept' } }, params: { label: '留下的' } }),
    node('dropped', 'out.preview', { inputs: { value: { node: 'filter', port: 'dropped' } }, params: { label: '淘汰的' } }),
  ])
  const report = await new FlowEngine({}).start(g)
  // scores are 0, 25, 50, 75, 100 → the line at 50 keeps indices 2, 3, 4
  const kept = report.events.find(e => e.type === 'preview' && e.label === '留下的').value
  const dropped = report.events.find(e => e.type === 'preview' && e.label === '淘汰的').value
  assert.deepEqual(kept, [2, 3, 4])
  assert.deepEqual(dropped, [0, 1], '被淘汰的也要交出来，用户想看想放都行')
})

test('items and scores that do not line up are refused with the likely cause', async () => {
  const g = graph([
    node('start', 'flow.loop_start', { params: { times: 3 } }),
    node('bag', 'flow.append', { inputs: { value: { node: 'start', port: 'index' } } }),
    node('end', 'flow.loop_end', { inputs: { body: { node: 'bag', port: 'list' } }, params: { loop: 'start' } }),
    node('one', 'io.number', { params: { value: 90 } }),
    node('filter', 'quality.filter_list', {
      inputs: { items: { node: 'bag', port: 'list' }, scores: { node: 'one', port: 'value' } },
    }),
  ])
  await assert.rejects(() => new FlowEngine({}).start(g), err => err.code === 'FG_FILTER_LENGTH_MISMATCH')
})

test('the whole 10-to-6 shape: measure, score, threshold, then a person picks', async () => {
  const clips = [tone(150), tone(155), tone(300), tone(150, { amplitude: 0.05 })].map((b, i) => fileWith(b, `c${i}.wav`))
  const reference = fileWith(tone(150), 'ref.wav')

  const nodes = [node('ref', 'io.reference_audio', { params: { path: reference } })]
  clips.forEach((p, i) => {
    nodes.push(node(`a${i}`, 'io.reference_audio', { params: { path: p } }))
    nodes.push(node(`m${i}`, 'quality.measure_similarity', {
      inputs: { audio: { node: `a${i}`, port: 'audio' }, reference: { node: 'ref', port: 'audio' } },
    }))
    nodes.push(node(`d${i}`, 'quality.read_metric', {
      inputs: { metrics: { node: `m${i}`, port: 'metrics' } }, params: { name: 'mfcc_cosine_distance' },
    }))
    nodes.push(node(`s${i}`, 'quality.normalize', {
      inputs: { value: { node: `d${i}`, port: 'value' } }, params: { good: 0, bad: 0.2 },
    }))
  })
  nodes.push(node('table', 'quality.score_table', {
    inputs: {
      metrics: clips.map((_, i) => ({ node: `m${i}`, port: 'metrics' })),
      scores: clips.map((_, i) => ({ node: `s${i}`, port: 'score' })),
    },
    params: { columns: ['mfcc_cosine_distance', 'pitch_median_hz'], pass_score: 60 },
  }))
  const g = graph(nodes)

  const report = await new FlowEngine({}).start(g)
  assert.equal(report.status, RUN_STATES.SUCCEEDED)
  const table = report.events.find(e => e.type === 'table').table
  assert.equal(table.rows.length, 4)
  assert.ok(table.columns.includes('总分') && table.columns.includes('结果'))
  // The clip cloned from the same tone must score better than the 300Hz one:
  // that is the entire premise of tier-2 measurement being worth anything.
  assert.ok(table.rows[0]['总分'] > table.rows[2]['总分'],
    `同源的应该分更高：${table.rows[0]['总分']} vs ${table.rows[2]['总分']}`)
  // And the reason for a low score is visible in the row, not hidden.
  assert.ok(String(table.rows[2]['结果']).length > 0)
})

test('the score table refuses to be a black box: every row says why', async () => {
  const g = graph([
    node('v', 'io.number', { params: { value: 30 } }),
    node('n', 'quality.normalize', { inputs: { value: { node: 'v', port: 'value' } }, params: { good: 100, bad: 0 } }),
    node('m', 'io.number', { params: { value: 1 } }),
    node('table', 'quality.score_table', {
      inputs: { metrics: { node: 'm', port: 'value' }, scores: { node: 'n', port: 'score' } },
      params: { pass_score: 80 },
    }),
  ])
  const report = await new FlowEngine({}).start(g)
  const table = report.events.find(e => e.type === 'table').table
  assert.match(String(table.rows[0]['结果']), /未通过（低于及格线 50 分）/)
})

test('top-k exists but is optional, and it ranks the way you would expect', async () => {
  const g = graph([
    node('start', 'flow.loop_start', { params: { times: 5 } }),
    node('bag', 'flow.append', { inputs: { value: { node: 'start', port: 'index' } } }),
    node('sc', 'quality.normalize', { inputs: { value: { node: 'start', port: 'index' } }, params: { good: 4, bad: 0 } }),
    node('scbag', 'flow.append', { inputs: { value: { node: 'sc', port: 'score' } } }),
    node('end', 'flow.loop_end', {
      inputs: { body: [{ node: 'bag', port: 'list' }, { node: 'scbag', port: 'list' }] },
      params: { loop: 'start' },
    }),
    node('top', 'quality.top_k', {
      inputs: { items: { node: 'bag', port: 'list' }, scores: { node: 'scbag', port: 'list' } },
      params: { k: 2 },
    }),
    node('view', 'out.preview', { inputs: { value: { node: 'top', port: 'top' } } }),
  ])
  const report = await new FlowEngine({}).start(g)
  assert.deepEqual(report.events.find(e => e.type === 'preview').value, [4, 3])
})

// ---------------------------------------------------------------------------
//  the recipe travels with the audio
// ---------------------------------------------------------------------------

test('a clip made by this graph can always say what made it', async () => {
  const g = graph([
    node('text', 'io.text', { params: { text: '一句话' } }),
    node('engine', 'io.engine', { params: { engine_id: 'gpt-sovits', voice: '阿伟' } }),
    node('tts', 'tts.synthesize', {
      inputs: { text: { node: 'text', port: 'text' }, engine: { node: 'engine', port: 'engine' } },
    }),
    node('check', 'quality.check_recipe', { inputs: { audio: { node: 'tts', port: 'audio' } } }),
  ])
  const engine = new FlowEngine({
    synthesize: async req => ({
      kind: 'audio',
      path: '/tmp/x.wav',
      recipe: { voice: req.engine.voice, text: req.text, seed: 42, params: { temperature: 0.8 } },
    }),
  })
  const report = await engine.start(g)
  const recipe = report.events.find(e => e.type === 'recipe').recipe
  assert.equal(recipe.voice, '阿伟')
  assert.equal(recipe.seed, 42)
  assert.equal(recipe.params.temperature, 0.8)
})

test('a clip read in from outside admits it has no recipe rather than inventing one', async () => {
  const clip = fileWith(tone(150))
  const g = graph([
    node('a', 'io.reference_audio', { params: { path: clip } }),
    node('check', 'quality.check_recipe', { inputs: { audio: { node: 'a', port: 'audio' } } }),
  ])
  await assert.rejects(() => new FlowEngine({}).start(g), err => err.code === 'FG_RECIPE_MISSING')
})

// ---------------------------------------------------------------------------
//  adapter — the real synthesis service, wired the way the server will wire it
// ---------------------------------------------------------------------------

test('the adapter calls the real service one line at a time and never lets it re-split', async () => {
  const outputRoot = tmpdir('outroot')
  const seen = []
  const generateService = async req => {
    seen.push(req.body)
    const dir = path.join(outputRoot, 'flow', 'gen1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'audio.wav'), tone(150))
    return { ok: true, id: 'gen1', audio_url: '/outputs/flow/gen1/audio.wav', seed: 7 }
  }
  const synthesize = createSynthesizeAdapter(generateService, { outputRoot })
  const audio = await synthesize({
    text: '一句话',
    engine: { engine_id: 'gpt-sovits', voice: '阿伟' },
    engine_params: { temperature: 0.7 },
    seed: 7,
  })
  assert.equal(seen[0].split, false, '图已经拆好句了，服务端不能自作主张再拆一次')
  assert.equal(seen[0].concat, false)
  assert.equal(seen[0].voice, '阿伟')
  assert.equal(seen[0].temperature, 0.7)
  assert.ok(fs.existsSync(audio.path), 'url 要能换算成真的文件路径')
  assert.equal(audio.recipe.voice, '阿伟')
  assert.equal(audio.recipe.seed, 7)
})

test('a mistyped engine parameter is stopped, not silently ignored', async () => {
  const synthesize = createSynthesizeAdapter(async () => ({ audio_url: '/outputs/a/b/audio.wav' }))
  await assert.rejects(() => synthesize({
    text: 'x',
    engine: { voice: 'v' },
    engine_params: { temperatuer: 0.7 },
  }), err => err.code === 'FG_ENGINE_PARAM_UNKNOWN' && /temperatuer/.test(err.message))
})

test('another engine is refused clearly, since only one is wired here today', async () => {
  const synthesize = createSynthesizeAdapter(async () => ({}))
  await assert.rejects(() => synthesize({ text: 'x', engine: { engine_id: 'some-other-tts', voice: 'v' } }),
    err => err.code === 'FG_ENGINE_UNSUPPORTED')
})

test('a service that says it saved a file which is not there is caught', async () => {
  const outputRoot = tmpdir('outroot2')
  const synthesize = createSynthesizeAdapter(async () => ({ audio_url: '/outputs/gone/x/audio.wav' }), { outputRoot })
  await assert.rejects(() => synthesize({ text: 'x', engine: { voice: 'v' } }),
    err => err.code === 'FG_SYNTHESIZE_FILE_MISSING')
})

test('the concat adapter reuses the broker join and names the missing segment', async () => {
  const dir = tmpdir('concat')
  const a = fileWith(tone(150), 'a.wav')
  const concatAudio = createConcatAdapter(async (paths, target) => {
    fs.writeFileSync(target, Buffer.concat(paths.map(p => fs.readFileSync(p))))
    return { method: 'test' }
  }, { outputDir: dir })

  const joined = await concatAudio([{ path: a }, { path: a }], { silence_ms: 100 })
  assert.ok(fs.existsSync(joined.path))
  assert.equal(joined.recipe.silence_ms, 100)

  await assert.rejects(() => concatAudio([{ path: a }, { path: '/nope/b.wav' }]),
    err => err.code === 'FG_CONCAT_FILE_MISSING' && /第 2 段/.test(err.message))
})
