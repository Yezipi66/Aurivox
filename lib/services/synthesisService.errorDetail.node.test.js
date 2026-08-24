'use strict'

// ===========================================================================
//  合成失败时，用户看到的是谁的原话
// ===========================================================================
// 契约 v2 第 3 步（甲）。
//
// webui 这条路径上，用户不该看到 "GPT-SoVITS /tts failed (500): {...}" 这种
// 外壳，而应该看到引擎自己那句话（"CUDA out of memory"）。剥壳这件事过去
// 是靠正则匹配文案里的 "GPT-SoVITS" 四个字做的 —— 也就是**一句人类可读的
// 文案同时充当了机器接口**。
//
// 这个文件钉的是那一刀的两端：
//   ① 新的结构化字段（err.upstreamBody）能剥壳，且和引擎叫什么名字无关；
//   ② ⭐ 老的正则兜底**仍然管用** —— 删掉它，任何还没接过来的抛错点就会
//      静默退化成"整坨原文"，而且没有任何东西会喊一声。
//
// 依赖全部注入，不起服务、不连引擎。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const createSynthesisService = require('./synthesisService')
const { toPcm16Wav, computeSegmentBounds } = require('../audio/wav')
const { upstreamFailure, emptyAudioFailure, transportFailure } = require('../engines/upstreamError')

function makeWav (nSamples = 8000, sampleRate = 16000) {
  const data = Buffer.alloc(nSamples * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8); head.write('fmt ', 12)
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(sampleRate, 24); head.writeUInt32LE(sampleRate * 2, 28)
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

// 只保留跑通一次单段合成所需的零件；失败注入点是 generateOneSegment。
function makeCtx (thrower) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-errdetail-'))
  const refPath = path.join(root, 'ref.wav')
  fs.writeFileSync(refPath, makeWav(16000))
  return {
    fs,
    path,
    switchModels: async () => {},
    generateOneSegment: async () => { throw thrower() },
    toPcm16Wav,
    computeSegmentBounds,
    wavDurationSec: () => 5,
    concatWavFiles: async () => ({ method: 'node' }),
    // 按 softLimit 切块。⚠ 必须真的切出多段：剥壳逻辑只长在分段路径上，
    //    单段路径的异常压根不经过 synthesisFailureDetail（见文件末尾的说明）。
    splitJapaneseText: (t, { softLimit }) => {
      const out = []
      for (let i = 0; i < t.length; i += softLimit) out.push(t.slice(i, i + softLimit))
      return out
    },
    loadVoices: () => ({ v1: { language: 'zh' } }),
    isBaseVoice: () => false,
    baseVoiceReg: () => ({ language: 'zh' }),
    resolveReference: () => ({ reference_audio: refPath, reference_text: '参考文本' }),
    buildTtsPayload: () => ({ ref_audio_path: refPath, prompt_text: '参考文本' }),
    newGenId: () => 'GENID',
    normSource: () => 'generate',
    genAssetDir: (g) => path.join(root, g),
    genBaseName: (p) => String(p || '').split(/[\\/]/).pop(),
    writeGenMeta: () => {},
    resolveSeed: () => 123456,
    clientError: (e, f) => String((e && e.message) || f),
    withGenerationLock: (fn) => fn(),
  }
}

// 跑一次合成，把用户最终看到的那句话取回来。
async function detailOf (thrower) {
  const { generateService } = createSynthesisService(makeCtx(thrower))
  let seen = null
  await assert.rejects(
    () => generateService({ body: { voice: 'v1', text: 'x'.repeat(30), max_chars: 10 } }),
    (e) => { seen = e; return e.status === 502 },
  )
  return seen.message.replace(/^Segment \d+ failed: /, '')
}

// --------------------------------------------------------------------------
//  ① 结构化字段这条新路
// --------------------------------------------------------------------------

test('⭐⭐ 甲: 走属性剥壳 —— 用户看到引擎的原话，不是外壳', async () => {
  const detail = await detailOf(() =>
    upstreamFailure({ id: 'indextts2', label: 'IndexTTS2' }, 500, '{"detail":"CUDA out of memory"}'))
  assert.equal(detail, 'CUDA out of memory')
  assert.doesNotMatch(detail, /IndexTTS2|\/tts failed/, '外壳漏到用户眼前了')
})

test('⭐⭐ 甲: 剥壳与引擎叫什么名字无关（过去改个名字就静默失配）', async () => {
  for (const label of ['FishTTS', 'Some Engine (v2)', '语音合成器']) {
    const detail = await detailOf(() =>
      upstreamFailure({ id: 'x', label }, 400, '{"detail":"bad param"}'))
    assert.equal(detail, 'bad param', `引擎叫「${label}」时剥壳失效了`)
  }
})

test('甲: 上游正文不是 JSON 时原样给出，不吞', async () => {
  const detail = await detailOf(() => upstreamFailure({ id: 'x', label: 'X' }, 500, 'Internal Server Error'))
  assert.equal(detail, 'Internal Server Error')
})

test('甲: message / error 两个键也认（不同引擎写法不一样）', async () => {
  assert.equal(await detailOf(() => upstreamFailure({ id: 'x', label: 'X' }, 400, '{"message":"m"}')), 'm')
  assert.equal(await detailOf(() => upstreamFailure({ id: 'x', label: 'X' }, 400, '{"error":"e"}')), 'e')
})

test('甲: 空音频那条照旧点名，且不会被当成"有上游正文"', async () => {
  const detail = await detailOf(() => emptyAudioFailure({ id: 'indextts2', label: 'IndexTTS2' }))
  assert.equal(detail, 'IndexTTS2 returned empty audio')
})

// --------------------------------------------------------------------------
//  ② 老正则兜底 —— 删了它会静默退化
// --------------------------------------------------------------------------

test('⭐⭐ 甲: 只抛字符串的老抛错点仍然被剥壳（兜底正则不许删）', async () => {
  // 这正是 nails:508 那条钉子的形状：没有任何结构化字段，只有一句话。
  const detail = await detailOf(() =>
    new Error('GPT-SoVITS /tts failed (500): {"detail":"CUDA out of memory"}'))
  assert.equal(detail, 'CUDA out of memory',
    '兜底正则没了 = 还没接过来的抛错点静默退化成整坨原文，而且不会有人发现')
})

test('甲: 与上游无关的普通异常照旧原样透出', async () => {
  const detail = await detailOf(() => new Error('ffmpeg not found'))
  assert.equal(detail, 'ffmpeg not found')
})

test('甲: 绝对路径仍被抹成 [path]、仍截到 600（第 3 步没碰这两条）', async () => {
  const detail = await detailOf(() =>
    upstreamFailure({ id: 'x', label: 'X' }, 500, `boom D:\\Project\\secret\\a.py ${'z'.repeat(900)}`))
  assert.doesNotMatch(detail, /secret/, '机器上的绝对路径漏出去了')
  assert.match(detail, /\[path\]/)
  assert.ok(detail.length <= 600, `长度 ${detail.length} 超了 600`)
})

// --------------------------------------------------------------------------
//  ✅ 那个不对称已经补上了（Owner 2026-08-23 拍板）
// --------------------------------------------------------------------------
//
// 上一版这里钉的是**洞本身**：synthesisService 的「整段合成」路径
// （split=false、engine_batch、或文本短于 softLimit —— webui 上敲一句短话
// 就是走它）没有 try/catch，异常直接飞到路由的 500 兜底，被 clientError
// 换成 "Internal server error"。剥壳、抹路径、截长度三件事只长在分段路径上。
//
// ⭐ 为什么现在必须补：短句是**最常见的试用场景**，这个洞的暴露面比分段
//    那支还大。而且传输层点名引擎那一刀（transportFailure）如果撞上这条
//    路径，精心写好的 "Cannot reach X at http://..." 会被整个吞掉 —— 修了
//    上游不修这里，等于没修。
//
// 下面这条测试从「钉住洞」改成「钉住补丁」：两条路径的失败表述必须一致。

test('✅ 不分段的那条路径现在也剥壳（与分段路径表述一致）', async () => {
  const { generateService } = createSynthesisService(makeCtx(() =>
    upstreamFailure({ id: 'indextts2', label: 'IndexTTS2' }, 500, '{"detail":"CUDA out of memory"}')))
  await assert.rejects(
    () => generateService({ body: { voice: 'v1', text: '你好', split: false } }),
    (e) => {
      assert.equal(e.status, 502, '要和分段路径一样是 HttpError 502，而不是路由的 500 兜底')
      assert.equal(e.message, 'CUDA out of memory', '外壳必须剥掉，只留上游原话')
      return true
    },
  )
})

test('✅ 单段路径的传输层失败也点名引擎，且地址没被脱敏吃掉', async () => {
  // 这条是上一条的真正动机：引擎没启动时，webui 上敲一句短话必须告诉用户
  // 是哪台引擎、哪个地址连不上，而不是 "Internal server error"。
  const boom = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9880'), { code: 'ECONNREFUSED' })
  const { generateService } = createSynthesisService(makeCtx(() =>
    transportFailure({ id: 'gpt-sovits', label: 'GPT-SoVITS', base_url: 'http://127.0.0.1:9880' },
      boom, { baseUrl: 'http://127.0.0.1:9880' })))
  await assert.rejects(
    () => generateService({ body: { voice: 'v1', text: '你好', split: false } }),
    (e) => {
      assert.equal(e.status, 502)
      assert.match(e.message, /GPT-SoVITS/, '必须点名引擎')
      assert.match(e.message, /http:\/\/127\.0\.0\.1:9880/, '⛔ 地址被脱敏正则吃掉了')
      assert.match(e.message, /ECONNREFUSED/)
      return true
    },
  )
})
