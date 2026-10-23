'use strict'

// audioDuration.js 的测试：音频容器时长解析（WAV / FLAC / MP3 / MP4 / Ogg）。
// 全部解析器都是「纯读文件头」，不依赖 ffmpeg。测试按各容器的字节规范手工搭 buffer
// （见下面的 build* 助手），再断言解析结果。每条用例都直接钉住一个真实的字节布局，
// 而不是 mock 掉整个模块。
// 覆盖点：
//   findWavDataOffset   : RIFF chunk 遍历、奇数字节 padding、找不到 data
//   getWavDuration      : 正常 PCM / 声明长度不可信（0 或 0xFFFFFFFF）时的回退
//   getFlacDuration     : STREAMINFO 打包字段、sampleRate 为 0、样本数为 0
//   parseMp3FrameHeader : MPEG1/2、L1/L3、padding、各种非法头
//   getMp3Duration      : CBR 逐帧累加 / Xing / VBRI / ID3v2 跳过 / ID3v1 尾巴
//   getMp4Duration      : mvhd v0 / v1 / 缺 moov / 缺 mvhd / timescale 为 0
//   getOggDuration      : Vorbis / Opus（含 preSkip）/ 非 Ogg
//   sniffAudioFormat    : 按魔术字节识别、认不出来返回 null
//   getAudioDuration    : 端到端、错扩展名按魔术字节纠正、异常路径返回 0

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  findWavDataOffset,
  getWavDuration,
  getFlacDuration,
  parseMp3FrameHeader,
  getMp3Duration,
  getMp4Duration,
  getOggDuration,
  sniffAudioFormat,
  getAudioDuration,
} = require('./audioDuration')

// buffer 构造助手

/**
 * 搭一个 RIFF/WAVE buffer。
 * fmt chunk 里 channels@22 / sampleRate@24 / bitsPerSample@34 的偏移与实现一致。
 */
function buildWav(opts = {}) {
  const {
    sampleRate = 44100,
    channels = 2,
    bits = 16,
    dataLen = 4000,
    declaredSize = null, // 显式指定 data chunk 头里的长度（测「不可信」分支）
    extraChunks = [], // 形如 [['LIST', 9]]，插在 fmt 与 data 之间
  } = opts
  const blockAlign = channels * (bits / 8)
  const byteRate = sampleRate * blockAlign

  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'latin1')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8) // PCM
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(sampleRate, 12)
  fmt.writeUInt32LE(byteRate, 16)
  fmt.writeUInt16LE(blockAlign, 20)
  fmt.writeUInt16LE(bits, 22)

  const extras = []
  for (const [id, size] of extraChunks) {
    const c = Buffer.alloc(8 + size)
    c.write(id, 0, 'latin1')
    c.writeUInt32LE(size, 4)
    if (size > 0) c.fill(0x41, 8, 8 + size)
    extras.push(c)
  }

  const data = Buffer.alloc(dataLen, 0x80)
  const dataHdr = Buffer.alloc(8)
  dataHdr.write('data', 0, 'latin1')
  dataHdr.writeUInt32LE(declaredSize === null ? data.length : declaredSize, 4)

  const body = Buffer.concat([fmt, ...extras, dataHdr, data])
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(4 + body.length, 4)
  riff.write('WAVE', 8, 'latin1')
  return Buffer.concat([riff, body])
}

/**
 * 搭一个最小 FLAC：'fLaC' + STREAMINFO(0)。
 * 打包字段 [sampleRate:20][channels:3][bps:5][totalSamples:36] 位于偏移 18。
 */
function buildFlac(opts = {}) {
  const { sampleRate = 44100, channels = 2, bits = 16, totalSamples = 88200 } = opts
  const b = Buffer.alloc(42, 0)
  b.write('fLaC', 0, 'latin1')
  b[4] = 0x00 // metadata block type 0 = STREAMINFO
  b[5] = 0x00
  b[6] = 0x00
  b[7] = 34 // STREAMINFO 长度
  b[18] = (sampleRate >> 12) & 0xff
  b[19] = (sampleRate >> 4) & 0xff
  b[20] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | ((bits >> 4) & 0x01)
  b[21] = ((bits & 0x01) << 4) | 0 // bps 低 4 位
  const hi = Math.floor(totalSamples / 4294967296)
  const lo = totalSamples % 4294967296
  b[21] = ((bits & 0x01) << 4) | (hi & 0x0f)
  b.writeUInt32BE(lo >>> 0, 22)
  b.writeUInt32BE(0, 26) // MD5 区
  return b
}

/**
 * 搭一个 MPEG 音频帧。默认 MPEG1 Layer III、128kbps、44100Hz。
 */
function buildMp3Frame(opts = {}) {
  const {
    versionBits = 3, // 3=MPEG1 2=MPEG2 0=MPEG2.5
    layerBits = 1, // 3=L1 2=L2 1=L3
    bitrateIdx = 9,
    sampleRateIdx = 0,
    padding = 0,
    channelMode = 0, // 0=stereo 3=mono
  } = opts
  const b0 = 0xff
  const b1 = 0xe0 | (versionBits << 3) | (layerBits << 1) | 0x01
  const b2 = (bitrateIdx << 4) | (sampleRateIdx << 2) | (padding << 1)
  const b3 = (channelMode << 6)
  const mpeg1 = versionBits === 3
  const brTables = {
    '1-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '1-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '2-1': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  }
  const srTables = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }
  const key = (mpeg1 ? '1' : '2') + '-' + layerBits
  const bitrate = brTables[key][bitrateIdx] * 1000
  const sampleRate = srTables[versionBits][sampleRateIdx]
  const samplesPerFrame = layerBits === 3 ? 384 : (layerBits === 2 ? 1152 : (mpeg1 ? 1152 : 576))
  const frameLen = layerBits === 3
    ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
    : Math.floor((samplesPerFrame / 8 * bitrate) / sampleRate) + padding
  const frame = Buffer.alloc(frameLen, 0)
  frame[0] = b0
  frame[1] = b1
  frame[2] = b2
  frame[3] = b3
  return frame
}

/** ID3v2 头 + payload（size 用 syncsafe 编码）。 */
function buildId3v2(payload, opts = {}) {
  const { flags = 0x00, sizeOverride = null } = opts
  const size = sizeOverride === null ? payload.length : sizeOverride
  const head = Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, flags,
    (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
  ])
  return Buffer.concat([head, payload])
}

/** 在首帧里塞一个 Xing/Info 头（MPEG1 stereo side info = 32 字节）。 */
function buildXingFile(frames, sampleRate = 44100) {
  const frame = buildMp3Frame()
  frame.write('Xing', 36, 'latin1')
  frame.writeUInt32BE(0x01, 40) // flags: frames present
  frame.writeUInt32BE(frames, 44)
  return { buf: frame, perFrame: 1152 / sampleRate }
}

/** 在首帧里塞一个 VBRI 头（固定位于帧偏移 36）。 */
function buildVbriFile(frames, sampleRate = 44100) {
  const frame = buildMp3Frame()
  frame.write('VBRI', 36, 'latin1')
  frame.writeUInt32BE(frames, 50)
  return { buf: frame, perFrame: 1152 / sampleRate }
}

/**
 * 搭一个 ISO-BMFF（mp4/m4a）文件：ftyp + moov(mvhd)。
 * v0: timescale@d+12 / duration@d+16；v1: timescale@d+20 / duration@d+24(64bit)。
 */
function buildMp4(opts = {}) {
  const { version = 0, timescale = 1000, duration = 3000, withMoov = true, withMvhd = true } = opts
  const ftyp = Buffer.alloc(16)
  ftyp.writeUInt32BE(16, 0)
  ftyp.write('ftyp', 4, 'latin1')
  ftyp.write('M4A ', 8, 'latin1')

  const mvhdLen = version === 1 ? 120 : 108
  const mvhd = Buffer.alloc(mvhdLen)
  mvhd.writeUInt32BE(mvhdLen, 0)
  mvhd.write('mvhd', 4, 'latin1')
  mvhd[8] = version
  if (version === 1) {
    mvhd.writeUInt32BE(timescale, 8 + 20)
    mvhd.writeUInt32BE(Math.floor(duration / 4294967296), 8 + 24)
    mvhd.writeUInt32BE(duration % 4294967296, 8 + 28)
  } else {
    mvhd.writeUInt32BE(timescale, 8 + 12)
    mvhd.writeUInt32BE(duration, 8 + 16)
  }

  const parts = [ftyp]
  if (withMoov) {
    const inner = withMvhd ? [mvhd] : []
    const moovBody = Buffer.concat(inner)
    const moov = Buffer.alloc(8)
    moov.writeUInt32BE(8 + moovBody.length, 0)
    moov.write('moov', 4, 'latin1')
    parts.push(moov, ...inner)
  }
  return Buffer.concat(parts)
}

/** 搭一个 Ogg page（27 字节页头 + segment table + body，body ≤ 255 字节）。 */
function buildOggPage(opts = {}) {
  const { granule = 0, serial = 1, seq = 0, body = Buffer.alloc(0), type = 0 } = opts
  const page = Buffer.alloc(27 + 1 + body.length)
  page.write('OggS', 0, 'latin1')
  page[4] = 0 // stream structure version
  page[5] = type
  page.writeUInt32LE(Number(granule) % 4294967296, 6)
  page.writeUInt32LE(Math.floor(Number(granule) / 4294967296), 10)
  page.writeUInt32LE(serial, 14)
  page.writeUInt32LE(seq, 18)
  page.writeUInt32LE(0, 22) // CRC
  page[26] = 1 // segment count
  page[27] = body.length
  Buffer.from(body).copy(page, 28)
  return page
}

function buildVorbisIdHeader(sampleRate, channels = 2) {
  const p = Buffer.alloc(16, 0)
  p[0] = 0x01
  p.write('vorbis', 1, 'latin1')
  p.writeUInt32LE(0, 7) // vorbis version
  p[11] = channels
  p.writeUInt32LE(sampleRate, 12)
  return p
}

function buildOpusIdHeader(preSkip = 0, channels = 2) {
  const p = Buffer.alloc(19, 0)
  p.write('OpusHead', 0, 'latin1')
  p[8] = 1 // version
  p[9] = channels
  p.writeUInt16LE(preSkip, 10)
  p.writeUInt32LE(48000, 12) // input sample rate
  return p
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioDuration-test-'))
let tmpSeq = 0
function writeTmp(buf, ext) {
  const p = path.join(tmpDir, `case-${tmpSeq++}${ext}`)
  fs.writeFileSync(p, buf)
  return p
}

// findWavDataOffset

test('findWavDataOffset: 标准 fmt+data 布局返回 data 字段偏移 44', () => {
  assert.strictEqual(findWavDataOffset(buildWav()), 44)
})

test('findWavDataOffset: 遇到奇数字节的 chunk 后按偶数边界跳到 data', () => {
  // fmt(24) 后插一个 size=9 的 LIST chunk。实现按 `8 + size + (size % 2)`
  //   = 8+9+1 = 18 前进，即从 36 跳到 54；我们的构造里 data 的 4 字节 id
  //   在 53（原始 9 字节 body 后紧跟），于是在 54 处读不到 "data"，返回 0。
  //   这条钉住「补齐字节是按规范加的，构造器本身并不物化那个补齐字节」。
  const buf = buildWav({ extraChunks: [['LIST', 9]] })
  assert.strictEqual(buf.indexOf('data', 12, 'binary'), 53)
  assert.strictEqual(findWavDataOffset(buf), 0)
})

test('findWavDataOffset: 偶数字节的 chunk 不需要补齐也能跳到 data', () => {
  // size=8（偶数，不补 1）：8+8+0=16，36+16=52 处正是 data id，应找到 60
  const buf = buildWav({ extraChunks: [['LIST', 8]] })
  assert.strictEqual(buf.indexOf('data', 12, 'binary'), 52)
  assert.strictEqual(findWavDataOffset(buf), 60)
})

test('findWavDataOffset: 多个前导 chunk 也能正确遍历', () => {
  const buf = buildWav({ extraChunks: [['LIST', 10], ['fact', 4]] })
  assert.strictEqual(findWavDataOffset(buf), 44 + 18 + 12)
})

test('findWavDataOffset: 没有 data chunk 返回 0', () => {
  const buf = Buffer.from(buildWav())
  buf.write('LIST', 36, 'latin1') // data 头改掉
  assert.strictEqual(findWavDataOffset(buf), 0)
})

test('findWavDataOffset: buffer 太短（不足一个 chunk 头）返回 0', () => {
  assert.strictEqual(findWavDataOffset(Buffer.alloc(12)), 0)
  assert.strictEqual(findWavDataOffset(Buffer.alloc(0)), 0)
})

// getWavDuration

test('getWavDuration: 标准 44100Hz/16bit/立体声 PCM 时长正确', () => {
  const p = writeTmp(buildWav({ sampleRate: 44100, channels: 2, bits: 16, dataLen: 44100 * 4 }), '.wav')
  assert.strictEqual(getWavDuration(p), 1)
})

test('getWavDuration: 8bit 单声道也走 byteRate = rate*channels*bits/8', () => {
  const p = writeTmp(buildWav({ sampleRate: 8000, channels: 1, bits: 8, dataLen: 8000 }), '.wav')
  assert.strictEqual(getWavDuration(p), 1)
})

test('getWavDuration: 声明 data 长度为 0 时回退到文件实际字节数', () => {
  const p = writeTmp(buildWav({ dataLen: 88200, declaredSize: 0 }), '.wav')
  assert.strictEqual(getWavDuration(p), 88200 / (44100 * 4))
})

test('getWavDuration: 声明 data 长度超过实际字节（0xFFFFFFFF）时按实际字节数截断', () => {
  const p = writeTmp(buildWav({ dataLen: 88200, declaredSize: 0xffffffff }), '.wav')
  assert.strictEqual(getWavDuration(p), 88200 / (44100 * 4))
})

test('getWavDuration: 声明长度小于实际字节时以声明值为准', () => {
  const p = writeTmp(buildWav({ dataLen: 44100 * 8, declaredSize: 44100 * 4 }), '.wav')
  assert.strictEqual(getWavDuration(p), 1)
})

test('getWavDuration: 非 RIFF/WAVE 返回 0', () => {
  const p = writeTmp(Buffer.alloc(200, 0x11), '.wav')
  assert.strictEqual(getWavDuration(p), 0)
})

test('getWavDuration: sampleRate 为 0（byteRate 为 0）不除零，返回 0', () => {
  const p = writeTmp(buildWav({ sampleRate: 0, dataLen: 1000 }), '.wav')
  assert.strictEqual(getWavDuration(p), 0)
})

test('getWavDuration: 文件短于 44 字节返回 0', () => {
  const p = writeTmp(Buffer.alloc(43, 0), '.wav')
  assert.strictEqual(getWavDuration(p), 0)
})

test('getWavDuration: 文件不存在返回 0', () => {
  assert.strictEqual(getWavDuration(path.join(tmpDir, 'nope.wav')), 0)
})

test('getWavDuration: 传目录（读文件抛错）返回 0', () => {
  assert.strictEqual(getWavDuration(tmpDir), 0)
})

// getFlacDuration

test('getFlacDuration: STREAMINFO 的 totalSamples/sampleRate 给出精确时长', () => {
  assert.strictEqual(getFlacDuration(buildFlac({ sampleRate: 44100, totalSamples: 132300 })), 3)
})

test('getFlacDuration: 采样率不是整数倍时按浮点相除', () => {
  const d = getFlacDuration(buildFlac({ sampleRate: 48000, totalSamples: 24001 }))
  assert.ok(Math.abs(d - 24001 / 48000) < 1e-9)
})

test('getFlacDuration: 超过 32 位的总样本数按 36 位解析', () => {
  // 36 位打包：高 4 位放在 buf[21] 低 4 位
  const totalSamples = 5 * 4294967296 + 12345
  assert.strictEqual(getFlacDuration(buildFlac({ sampleRate: 44100, totalSamples })), totalSamples / 44100)
})

test('getFlacDuration: 魔术字节不是 fLaC 返回 0', () => {
  assert.strictEqual(getFlacDuration(Buffer.alloc(64, 0)), 0)
})

test('getFlacDuration: buffer 不足 42 字节返回 0', () => {
  const buf = buildFlac()
  assert.strictEqual(getFlacDuration(buf.subarray(0, 41)), 0)
})

test('getFlacDuration: sampleRate 为 0 返回 0', () => {
  assert.strictEqual(getFlacDuration(buildFlac({ sampleRate: 0, totalSamples: 44100 })), 0)
})

test('getFlacDuration: totalSamples 为 0 返回 0', () => {
  assert.strictEqual(getFlacDuration(buildFlac({ sampleRate: 44100, totalSamples: 0 })), 0)
})

// parseMp3FrameHeader

test('parseMp3FrameHeader: MPEG1 Layer III 头部字段与帧长', () => {
  const h = parseMp3FrameHeader(buildMp3Frame(), 0)
  assert.ok(h)
  assert.strictEqual(h.mpeg1, true)
  assert.strictEqual(h.bitrate, 128000)
  assert.strictEqual(h.sampleRate, 44100)
  assert.strictEqual(h.samplesPerFrame, 1152)
  assert.strictEqual(h.frameLen, 417) // floor(144*128000/44100)
})

test('parseMp3FrameHeader: padding 位让 L3 帧长 +1', () => {
  assert.strictEqual(parseMp3FrameHeader(buildMp3Frame({ padding: 1 }), 0).frameLen, 418)
})

test('parseMp3FrameHeader: MPEG2 Layer III 每帧 576 样本', () => {
  const h = parseMp3FrameHeader(buildMp3Frame({ versionBits: 2, bitrateIdx: 8, sampleRateIdx: 0 }), 0)
  assert.ok(h)
  assert.strictEqual(h.mpeg1, false)
  assert.strictEqual(h.sampleRate, 22050)
  assert.strictEqual(h.samplesPerFrame, 576)
  assert.strictEqual(h.frameLen, 208) // floor(72*64000/22050)
})

test('parseMp3FrameHeader: Layer I 每帧 384 样本、帧长按 4 字节槽对齐', () => {
  const h = parseMp3FrameHeader(buildMp3Frame({ layerBits: 3, bitrateIdx: 3 }), 0)
  assert.ok(h)
  assert.strictEqual(h.samplesPerFrame, 384)
  assert.strictEqual(h.frameLen, (Math.floor((12 * 96000) / 44100)) * 4)
})

test('parseMp3FrameHeader: mono（channelMode 3）被记录', () => {
  assert.strictEqual(parseMp3FrameHeader(buildMp3Frame({ channelMode: 3 }), 0).channelMode, 3)
})

test('parseMp3FrameHeader: 非法头一律返回 null', () => {
  const good = buildMp3Frame()
  // 不同步
  const noSync = Buffer.from(good); noSync[0] = 0x00
  assert.strictEqual(parseMp3FrameHeader(noSync, 0), null)
  // version 位保留值 1
  const badVer = Buffer.from(good); badVer[1] = 0xe0 | (1 << 3) | (1 << 1) | 1
  assert.strictEqual(parseMp3FrameHeader(badVer, 0), null)
  // bitrate index 0（free）
  const br0 = Buffer.from(good); br0[2] = (0 << 4) | (0 << 2)
  assert.strictEqual(parseMp3FrameHeader(br0, 0), null)
  // bitrate index 15（bad）
  const br15 = Buffer.from(good); br15[2] = (15 << 4)
  assert.strictEqual(parseMp3FrameHeader(br15, 0), null)
  // sampleRate index 3（保留）
  const sr3 = Buffer.from(good); sr3[2] = (9 << 4) | (3 << 2)
  assert.strictEqual(parseMp3FrameHeader(sr3, 0), null)
  // 偏移越界
  assert.strictEqual(parseMp3FrameHeader(good, good.length - 2), null)
  assert.strictEqual(parseMp3FrameHeader(Buffer.alloc(3, 0xff), 0), null)
})

// getMp3Duration

test('getMp3Duration: CBR 逐帧累加得到精确时长', () => {
  const frames = 50
  const buf = Buffer.concat(Array.from({ length: frames }, () => buildMp3Frame()))
  // 实现按帧累加 1152/44100，逐帧累加会有末位浮点差，所以用绝对值小于 1e-12 比断言
  assert.ok(Math.abs(getMp3Duration(buf) - (frames * 1152) / 44100) < 1e-12)
})

test('getMp3Duration: 单个帧也能定时长（EOF 处也算确认）', () => {
  assert.strictEqual(getMp3Duration(buildMp3Frame()), 1152 / 44100)
})

test('getMp3Duration: 优先使用 Xing 帧数', () => {
  const { buf, perFrame } = buildXingFile(200)
  // 单次乘法也有末位浮点差，所以用绝对值小于 1e-12 比断言
  assert.ok(Math.abs(getMp3Duration(buf) - 200 * perFrame) < 1e-12)
})

test('getMp3Duration: Info 头同样按 Xing 处理', () => {
  const { buf } = buildXingFile(100)
  buf.write('Info', 36, 'latin1')
  assert.ok(Math.abs(getMp3Duration(buf) - (100 * 1152) / 44100) < 1e-12)
})

test('getMp3Duration: 没有 Xing 时用 VBRI 帧数', () => {
  const { buf, perFrame } = buildVbriFile(150)
  assert.ok(Math.abs(getMp3Duration(buf) - 150 * perFrame) < 1e-12)
})

test('getMp3Duration: 跳过 ID3v2 标签（内含 0xFF 伪同步）', () => {
  const frames = 40
  const payload = Buffer.alloc(100, 0xff) // 全是 0xFF：若不跳过会被当成帧同步
  const buf = Buffer.concat([buildId3v2(payload), ...Array.from({ length: frames }, () => buildMp3Frame())])
  const expected = (frames * 1152) / 44100
  assert.ok(Math.abs(getMp3Duration(buf) - expected) < 1e-12)
})

test('getMp3Duration: ID3v2 尺寸字段越界时回退为从头扫描', () => {
  const frames = 30
  const payload = Buffer.alloc(100, 0xff)
  const buf = Buffer.concat([
    buildId3v2(payload, { sizeOverride: 0x0fffffff }),
    ...Array.from({ length: frames }, () => buildMp3Frame()),
  ])
  const expected = (frames * 1152) / 44100
  assert.ok(Math.abs(getMp3Duration(buf) - expected) < 1e-12)
})

test('getMp3Duration: 末尾 ID3v1 TAG 不计入时长', () => {
  const frames = 20
  const tag = Buffer.alloc(128, 0)
  tag.write('TAG', 0, 'latin1')
  const buf = Buffer.concat([...Array.from({ length: frames }, () => buildMp3Frame()), tag])
  const expected = (frames * 1152) / 44100
  assert.ok(Math.abs(getMp3Duration(buf) - expected) < 1e-12)
})

test('getMp3Duration: 只有 ID3v2 没有帧返回 0', () => {
  assert.strictEqual(getMp3Duration(buildId3v2(Buffer.alloc(64, 0x55))), 0)
})

test('getMp3Duration: 全零 buffer 找不到帧返回 0', () => {
  assert.strictEqual(getMp3Duration(Buffer.alloc(4096, 0)), 0)
})

// getMp4Duration

test('getMp4Duration: mvhd v0 的 duration/timescale', () => {
  assert.strictEqual(getMp4Duration(buildMp4({ version: 0, timescale: 1000, duration: 3000 })), 3)
})

test('getMp4Duration: mvhd v1 的 64 位 duration', () => {
  assert.strictEqual(getMp4Duration(buildMp4({ version: 1, timescale: 44100, duration: 88200 })), 2)
})

test('getMp4Duration: 缺 moov 返回 0', () => {
  assert.strictEqual(getMp4Duration(buildMp4({ withMoov: false })), 0)
})

test('getMp4Duration: moov 里缺 mvhd 返回 0', () => {
  assert.strictEqual(getMp4Duration(buildMp4({ withMvhd: false })), 0)
})

test('getMp4Duration: timescale 为 0 不除零，返回 0', () => {
  assert.strictEqual(getMp4Duration(buildMp4({ timescale: 0, duration: 3000 })), 0)
})

// getOggDuration

test('getOggDuration: Vorbis 用首页采样率与末页 granule 定位', () => {
  const buf = Buffer.concat([
    buildOggPage({ seq: 0, body: buildVorbisIdHeader(44100) }),
    buildOggPage({ seq: 1, body: Buffer.from('vorbis-data') }),
    buildOggPage({ seq: 2, granule: 132300, body: Buffer.alloc(0) }),
  ])
  assert.strictEqual(getOggDuration(buf), 3)
})

test('getOggDuration: Opus 固定 48kHz 且减去 preSkip', () => {
  const buf = Buffer.concat([
    buildOggPage({ seq: 0, body: buildOpusIdHeader(312) }),
    buildOggPage({ seq: 1, granule: 48000 * 2 + 312, body: Buffer.alloc(0) }),
  ])
  assert.strictEqual(getOggDuration(buf), 2)
})

test('getOggDuration: granule 小于 preSkip 时不为负', () => {
  const buf = Buffer.concat([
    buildOggPage({ seq: 0, body: buildOpusIdHeader(5000) }),
    buildOggPage({ seq: 1, granule: 1000, body: Buffer.alloc(0) }),
  ])
  assert.strictEqual(getOggDuration(buf), 0)
})

test('getOggDuration: 首包不是 Vorbis/Opus 识别头返回 0', () => {
  const buf = Buffer.concat([
    buildOggPage({ seq: 0, body: Buffer.from('garbage!') }),
    buildOggPage({ seq: 1, granule: 48000, body: Buffer.alloc(0) }),
  ])
  assert.strictEqual(getOggDuration(buf), 0)
})

test('getOggDuration: 不是 OggS 魔术返回 0', () => {
  assert.strictEqual(getOggDuration(Buffer.alloc(64, 0x22)), 0)
  assert.strictEqual(getOggDuration(Buffer.alloc(0)), 0)
})

// sniffAudioFormat

test('sniffAudioFormat: 识别五种容器的魔术字节', () => {
  assert.strictEqual(sniffAudioFormat(buildWav()), 'wav')
  assert.strictEqual(sniffAudioFormat(buildFlac()), 'flac')
  assert.strictEqual(sniffAudioFormat(buildMp4()), 'mp4')
  assert.strictEqual(sniffAudioFormat(buildId3v2(Buffer.alloc(20, 0))), 'mp3')
  assert.strictEqual(sniffAudioFormat(buildMp3Frame()), 'mp3')
  const ogg = buildOggPage({ seq: 0, body: buildVorbisIdHeader(44100) })
  assert.strictEqual(sniffAudioFormat(ogg), 'ogg')
})

test('sniffAudioFormat: 认不出来返回 null（空 buffer / 随机字节）', () => {
  assert.strictEqual(sniffAudioFormat(Buffer.alloc(0)), null)
  assert.strictEqual(sniffAudioFormat(Buffer.from('hello world, not audio')), null)
})

test('sniffAudioFormat: RIFF 但后面不是 WAVE 不算 wav', () => {
  const buf = Buffer.alloc(12, 0)
  buf.write('RIFF', 0, 'latin1')
  buf.write('AVI ', 8, 'latin1')
  assert.strictEqual(sniffAudioFormat(buf), null)
})

// getAudioDuration（端到端，含扩展名回退与错标扩展名）

test('getAudioDuration: wav 文件按魔术字节解析', () => {
  const p = writeTmp(buildWav({ dataLen: 44100 * 4 }), '.wav')
  assert.strictEqual(getAudioDuration(p), 1)
})

test('getAudioDuration: 错标扩展名——Ogg 内容存成 .mp3 仍按 Ogg 解析', () => {
  const ogg = Buffer.concat([
    buildOggPage({ seq: 0, body: buildVorbisIdHeader(48000) }),
    buildOggPage({ seq: 1, granule: 48000 * 5, body: Buffer.alloc(0) }),
  ])
  const p = writeTmp(ogg, '.mp3')
  assert.strictEqual(getAudioDuration(p), 5)
})

test('getAudioDuration: 错标扩展名——FLAC 内容存成 .ogg 仍按 FLAC 解析', () => {
  const p = writeTmp(buildFlac({ sampleRate: 44100, totalSamples: 44100 * 2 }), '.ogg')
  assert.strictEqual(getAudioDuration(p), 2)
})

test('getAudioDuration: 无扩展名文件靠魔术字节识别', () => {
  const p = writeTmp(buildMp4({ timescale: 1000, duration: 2500 }), '')
  assert.strictEqual(getAudioDuration(p), 2.5)
})

test('getAudioDuration: 头部不可识别时回退到扩展名提示', () => {
  // 头部是垃圾、扩展名 .wav：回退成 wav 解析器，但 RIFF 校验失败，返回 0
  const p = writeTmp(Buffer.alloc(200, 0x33), '.wav')
  assert.strictEqual(getAudioDuration(p), 0)
  // 同样的垃圾字节配 .mp3 扩展名也一样拿不到时长
  const p2 = writeTmp(Buffer.alloc(200, 0x33), '.mp3')
  assert.strictEqual(getAudioDuration(p2), 0)
})

test('getAudioDuration: 非音频/空文件返回 0', () => {
  const p = writeTmp(Buffer.alloc(0), '.wav')
  assert.strictEqual(getAudioDuration(p), 0)
  const p2 = writeTmp(Buffer.from('just text'), '.txt')
  assert.strictEqual(getAudioDuration(p2), 0)
})

test('getAudioDuration: 文件不存在返回 0', () => {
  assert.strictEqual(getAudioDuration(path.join(tmpDir, 'missing.wav')), 0)
})
