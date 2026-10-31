'use strict'

// Flow 引擎节点 → 真实 generateService。
// 适配器把参数平铺一份、按引擎分格一份，两条路都必须到达引擎：
// 画布上改了一个参数而引擎收到的请求体里没有它，就是这里的回归。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { useFixtureEngines } = require('../testEngines')
// registry 在模块加载时读 AURIVOX_EXTRA_ENGINES_DIR，所以这行必须排在
// require 任何引擎模块之前。
useFixtureEngines()

const { createSynthesizeAdapter } = require('./adapter')
const createSynthesisService = require('../services/synthesisService')
const { createSynthesisModule } = require('../server/synthesis')
const { applyEngineKnobs } = require('../engines/paramTable')
const { toPcm16Wav, computeSegmentBounds, wavDurationSec } = require('../audio/wav')

// fixture-beta：不要求参考音频，调用参数是 emo_alpha / interval_silence。
const ENGINE = 'fixture-beta'

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

// 真实 buildTtsPayload + applyEngineKnobs，只把「发网络」换成记录 + 一段静音 WAV。
function makeHarness () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-flow-'))
  const calls = { cfgs: [], payloads: [] }
  const synth = createSynthesisModule({
    _weightSwitch: { ensure: async () => ({}) },
    segmentCache: { get: () => null, put: () => false, fingerprint: () => '' },
  })
  const ctx = {
    fs,
    path,
    switchModels: async () => {},
    generateOneSegment: async (text, cfg, engine) => {
      const payload = synth.buildTtsPayload(text, cfg, engine)
      applyEngineKnobs(payload, engine, cfg)
      calls.cfgs.push(cfg)
      calls.payloads.push(payload)
      return makeWav(1600)
    },
    toPcm16Wav,
    computeSegmentBounds,
    wavDurationSec,
    concatWavFiles: (files, out) => { fs.writeFileSync(out, makeWav(3200)); return { method: 'stub' } },
    splitJapaneseText: (text, opts) => {
      const out = []
      for (let i = 0; i < text.length; i += opts.softLimit) out.push(text.slice(i, i + opts.softLimit))
      return out
    },
    loadVoices: () => ({ v1: { language: 'zh' } }),
    isBaseVoice: () => false,
    baseVoiceReg: () => null,
    resolveReference: synth.resolveReference,
    buildTtsPayload: synth.buildTtsPayload,
    newGenId: () => 'FLOWGEN',
    normSource: (s) => (s ? String(s) : 'generate'),
    genAssetDir: (genId) => path.join(root, 'generate', genId),
    genBaseName: (p) => (p && typeof p === 'string' ? p.replace(/\\/g, '/').split('/').pop() : ''),
    writeGenMeta: () => {},
    resolveSeed: synth.resolveSeed,
    clientError: (err, fallback) => String((err && err.message) || fallback),
    withGenerationLock: (fn) => fn(),
  }
  return { root, ctx, calls }
}

test('⭐ Flow 引擎节点的参数（平铺 + 分格）都到达非 GSV 引擎', async () => {
  const { root, ctx, calls } = makeHarness()
  const { generateService } = createSynthesisService(ctx)
  const synthesize = createSynthesizeAdapter(generateService, {
    outputRoot: root,
    defaultVoice: 'v1',
  })

  const result = await synthesize({
    text: '你好',
    engine: { engine_id: ENGINE, voice: 'v1' },
    engine_params: { emo_alpha: 0.7, interval_silence: 0.2 },
  })

  assert.equal(calls.payloads.length, 1)
  assert.equal(calls.cfgs[0].emo_alpha, 0.7, '平铺那一路必须进 cfg')
  assert.deepEqual(calls.cfgs[0].engine_params,
    { emo_alpha: 0.7, interval_silence: 0.2 }, '分格那一路必须进 cfg.engine_params')
  assert.equal(calls.payloads[0].emo_alpha, 0.7, '参数必须真的拼进发往引擎的请求体')
  assert.equal(calls.payloads[0].interval_silence, 0.2)

  assert.equal(result.kind, 'audio')
  assert.ok(fs.existsSync(result.path), '适配器返回的路径必须真的存在')
  assert.deepEqual(result.recipe.params, { emo_alpha: 0.7, interval_silence: 0.2 })
})
