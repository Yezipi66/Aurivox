'use strict'

// 合成服务的测试夹具：只把「向宿主发请求」换成记录 cfg 与 payload，其余按真实链路跑
// （真实的 buildTtsPayload、applyEngineKnobs、参数归一与切段）。
// 只给 *.node.test.js 用，不参与运行时。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createSynthesisModule } = require('./server/synthesis')
const { applyEngineKnobs } = require('./engines/paramTable')
const { toPcm16Wav, computeSegmentBounds, wavDurationSec } = require('./audio/wav')

/** n 采样的静音 WAV（16-bit 单声道），时长可被 wavDurationSec 读出。 */
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

function splitJapaneseText (text, opts) {
  const out = []
  for (let i = 0; i < text.length; i += opts.softLimit) out.push(text.slice(i, i + opts.softLimit))
  return out
}

/**
 * engines 给出按 id 查名片的替身；要换成真实的引擎名片查询，走 ctx 覆盖。
 * 参考音频总是写在临时目录里，refPath 指向的文件真实存在。
 * ctx 最后合并，单条用例可以只换掉其中一两个依赖。
 */
function createSynthesisHarness ({
  prefix = 'aurivox-harness-',
  genId = 'GENID',
  assetSubdir = '',
  engines = null,
  ctx: ctxOverrides = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const refPath = path.join(root, 'ref.wav')
  fs.writeFileSync(refPath, makeWav(16000 * 5))

  const calls = { root, refPath, cfgs: [], payloads: [], engines: [], metas: [], switched: 0 }
  const synth = createSynthesisModule({
    _modelSwitcher: { ensure: async () => ({}) },
    segmentCache: { get: () => null, put: () => false, fingerprint: () => '' },
  })
  const ctx = {
    fs,
    path,
    switchModels: async () => { calls.switched++ },
    generateOneSegment: async (text, cfg, engine) => {
      const payload = synth.buildTtsPayload(text, cfg, engine)
      applyEngineKnobs(payload, engine, cfg)
      calls.cfgs.push(cfg)
      calls.payloads.push(payload)
      calls.engines.push(engine)
      return makeWav(1600)
    },
    toPcm16Wav,
    computeSegmentBounds,
    wavDurationSec,
    concatWavFiles: (files, out) => { fs.writeFileSync(out, makeWav(3200)); return { method: 'stub' } },
    splitJapaneseText,
    loadVoices: () => ({ v1: { language: 'zh' } }),
    isBaseVoice: () => false,
    baseVoiceReg: () => null,
    resolveReference: synth.resolveReference,
    buildTtsPayload: synth.buildTtsPayload,
    newGenId: () => genId,
    normSource: (s) => (s ? String(s) : 'generate'),
    genAssetDir: (id) => path.join(root, assetSubdir, id),
    genBaseName: (p) => (p && typeof p === 'string' ? p.replace(/\\/g, '/').split('/').pop() : ''),
    writeGenMeta: (id, meta) => { calls.metas.push(meta) },
    resolveSeed: synth.resolveSeed,
    clientError: (err, fallback) => String((err && err.message) || fallback),
    withGenerationLock: (fn) => fn(),
  }
  // 输出根目录指向本次的临时目录：真的那三个根装着用户自己的生成记录，
  // 测试里查「这台引擎上一次成功调用填了什么」绝不能读到真机上的东西。
  ctx.outputRoots = {
    generate: path.join(root, 'outputs/generate'),
    comparerefs: path.join(root, 'outputs/comparerefs'),
    broker: path.join(root, 'outputs/broker'),
  }
  if (engines) {
    ctx.resolveEngineProfile = (id) => {
      if (!engines[id]) { const e = new Error(`ENGINE_NOT_FOUND: ${id}`); throw e }
      return engines[id]
    }
  }
  Object.assign(ctx, ctxOverrides || {})

  return { root, refPath, calls, ctx }
}

module.exports = { makeWav, createSynthesisHarness }
