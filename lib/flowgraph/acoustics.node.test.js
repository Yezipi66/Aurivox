'use strict'

//  acoustics — 纯函数与 WAV fixture 测试
// 测 decodeWav / measureBasic / measureSimilarity / mfccProfile / pitchTrack 等。
// 用 Buffer 构造 WAV fixture，不依赖真实文件系统或 engines/。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  decodeWav,
  measureBasic,
  measureSimilarity,
  mfccProfile,
  longTermSpectrum,
  pitchTrack,
  percentile,
  mean,
  stddev,
  toDb,
} = require('./acoustics')

//  WAV fixture 构造

function makeWav({ sampleRate = 16000, channels = 1, bitsPerSample = 16, samples }) {
  const bytes = bitsPerSample / 8
  const dataSize = samples.length * channels * bytes
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * channels * bytes, 28)
  buf.writeUInt16LE(channels * bytes, 32)
  buf.writeUInt16LE(bitsPerSample, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return buf
}

function sineSamples(freq, sampleRate, durationSec, amplitude = 0.5) {
  const n = Math.floor(sampleRate * durationSec)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(2 * Math.PI * freq * i / sampleRate)
  return out
}

//  mean / stddev / percentile / toDb — 纯数学函数

test('mean: 计算均值', () => {
  assert.equal(mean([1, 2, 3, 4, 5]), 3)
  assert.equal(mean([10]), 10)
  assert.equal(mean([]), 0)
})

test('stddev: 计算标准差', () => {
  assert.equal(stddev([1]), 0)
  assert.equal(stddev([]), 0)
  const v = [2, 4, 4, 4, 5, 5, 7, 9]
  const m = mean(v)
  const expected = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1))
  assert.ok(Math.abs(stddev(v) - expected) < 1e-10)
})

test('percentile: 计算百分位数', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3)
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1)
  assert.equal(percentile([1, 2, 3, 4, 5], 1), 5)
  assert.equal(percentile([], 0.5), 0)
})

test('toDb: 振幅转 dB', () => {
  assert.equal(toDb(1), 0)
  assert.ok(Math.abs(toDb(0.5) - (-6.02)) < 0.01)
  assert.ok(toDb(0) < -100) // 极小值返回很大负数
})

//  decodeWav — WAV 解析

test('decodeWav: 正确解析 PCM16 单声道', () => {
  const samples = sineSamples(440, 16000, 0.1, 0.5)
  const wav = makeWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, samples })
  const { samples: decoded, sampleRate, channels, bitsPerSample, duration } = decodeWav(wav)
  assert.equal(sampleRate, 16000)
  assert.equal(channels, 1)
  assert.equal(bitsPerSample, 16)
  assert.ok(Math.abs(duration - 0.1) < 0.001)
  assert.equal(decoded.length, samples.length)
})

test('decodeWav: 立体声混音为单声道', () => {
  const left = sineSamples(440, 16000, 0.05, 0.5)
  const right = sineSamples(880, 16000, 0.05, 0.3)
  const samples = new Float32Array(left.length)
  for (let i = 0; i < samples.length; i++) samples[i] = (left[i] + right[i]) / 2
  const bytes = 2
  const dataSize = samples.length * 2 * bytes
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(16000, 24)
  buf.writeUInt32LE(16000 * 2 * bytes, 28)
  buf.writeUInt16LE(2 * bytes, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.round(left[i] * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(right[i] * 32767), 44 + i * 4 + 2)
  }
  const { samples: decoded, channels } = decodeWav(buf)
  assert.equal(channels, 2)
  assert.equal(decoded.length, samples.length)
})

test('decodeWav: 非 WAV 文件抛错', () => {
  assert.throws(() => decodeWav(Buffer.from('not a wav file')), /不是一个 WAV 文件/)
})

test('decodeWav: 缺 fmt 或 data 段抛错', () => {
  const buf = Buffer.alloc(44)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36, 4)
  buf.write('WAVE', 8)
  // 无 fmt/data
  assert.throws(() => decodeWav(buf), /缺了必要的段/)
})

//  measureBasic — 基础测量

test('measureBasic: 正弦波测量', () => {
  const samples = sineSamples(440, 16000, 0.5, 0.5)
  const wav = makeWav({ sampleRate: 16000, samples })
  const m = measureBasic(wav, { text: '你好世界' })
  assert.equal(m.tier, 1)
  assert.equal(m.kind, 'metrics')
  assert.ok(Math.abs(m.duration_sec - 0.5) < 0.01)
  assert.ok(m.sample_rate === 16000)
  assert.ok(m.peak_dbfs < 0)
  assert.ok(m.peak_dbfs > -10)
  assert.ok(m.clipping_ratio === 0)
  assert.equal(m.chars, 4)
  assert.ok(m.chars_per_sec > 0)
})

test('measureBasic: 空采样抛错', () => {
  const wav = makeWav({ sampleRate: 16000, samples: new Float32Array(0) })
  assert.throws(() => measureBasic(wav), /一个采样点都没有/)
})

test('measureBasic: 全静音 silence_ratio 接近 1', () => {
  const samples = new Float32Array(16000) // 1 秒全零
  const wav = makeWav({ sampleRate: 16000, samples })
  const m = measureBasic(wav, { text: null })
  assert.ok(m.silence_ratio > 0.9)
  assert.equal(m.chars, null)
})

test('measureBasic: 削波检测', () => {
  const samples = new Float32Array(16000).fill(0.9995)
  const wav = makeWav({ sampleRate: 16000, samples })
  const m = measureBasic(wav)
  assert.ok(m.clipping_ratio > 0.5)
})

//  mfccProfile / longTermSpectrum / pitchTrack

test('mfccProfile: 返回指定长度的向量', () => {
  const samples = sineSamples(440, 16000, 0.5)
  const mfcc = mfccProfile(samples, 16000, { coefficients: 13 })
  assert.equal(mfcc.length, 13)
  assert.ok(mfcc.every(v => Number.isFinite(v)))
})

test('mfccProfile: 不同频率的 MFCC 不同', () => {
  const low = sineSamples(200, 16000, 0.5)
  const high = sineSamples(2000, 16000, 0.5)
  const m1 = mfccProfile(low, 16000)
  const m2 = mfccProfile(high, 16000)
  let diff = 0
  for (let i = 0; i < m1.length; i++) diff += Math.abs(m1[i] - m2[i])
  assert.ok(diff > 0.01)
})

test('longTermSpectrum: 返回指定 band 数量', () => {
  const samples = sineSamples(440, 16000, 0.5)
  const spec = longTermSpectrum(samples, 16000, 24)
  assert.equal(spec.length, 24)
  assert.ok(spec.every(v => Number.isFinite(v)))
})

test('pitchTrack: 正弦波能测出基频', () => {
  const samples = sineSamples(440, 16000, 1.0)
  const pitches = pitchTrack(samples, 16000, { fmin: 70, fmax: 500 })
  assert.ok(pitches.length > 0)
  const med = percentile(pitches, 0.5)
  // 自相关方法对纯正弦波有取整误差，允许 ±15% 偏差
  assert.ok(Math.abs(med - 440) / 440 < 0.15, `expected ~440Hz, got ${med}`)
})

test('pitchTrack: 静音返回空数组', () => {
  const samples = new Float32Array(16000)
  const pitches = pitchTrack(samples, 16000)
  assert.deepEqual(pitches, [])
})

//  measureSimilarity — 相似度测量

test('measureSimilarity: 相同音频距离接近 0', () => {
  const samples = sineSamples(440, 16000, 0.5)
  const wav = makeWav({ sampleRate: 16000, samples })
  const m = measureSimilarity(wav, wav)
  assert.equal(m.tier, 2)
  assert.ok(m.mfcc_distance < 0.01)
  assert.ok(m.mfcc_cosine_distance < 0.01)
  assert.ok(Math.abs(m.pitch_median_ratio - 1) < 0.01)
})

test('measureSimilarity: 不同频率音频有距离', () => {
  const low = makeWav({ sampleRate: 16000, samples: sineSamples(200, 16000, 0.5) })
  const high = makeWav({ sampleRate: 16000, samples: sineSamples(2000, 16000, 0.5) })
  const m = measureSimilarity(low, high)
  assert.ok(m.mfcc_distance > 0.1)
  assert.ok(m.mfcc_cosine_distance > 0.01)
})

test('measureSimilarity: 空音频返回零值指标', () => {
  const wav = makeWav({ sampleRate: 16000, samples: new Float32Array(0) })
  const m = measureSimilarity(wav, wav)
  assert.equal(m.tier, 2)
  assert.equal(m.mfcc_distance, 0)
  assert.equal(m.pitch_median_hz, 0)
})
