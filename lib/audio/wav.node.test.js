// WAV 工具（lib/audio/wav.js）的单元测试，用 Node 内置的测试运行器。
// 这些是字节级的工具，边界多（RIFF 分块遍历、float32 转 pcm16、时长换算、
// 拼接时的格式校验），所以要有确定性的单元覆盖。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const wav = require("./wav");

// 辅助：在内存里合成 WAV 缓冲区

function pcm16Wav(samples, sampleRate = 8000, channels = 1) {
  const dataSize = samples.length * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write("RIFF", 0); b.writeUInt32LE(36 + dataSize, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], 44 + i * 2);
  return b;
}

function float32Wav(floats, sampleRate = 8000) {
  const dataSize = floats.length * 4;
  const b = Buffer.alloc(44 + dataSize);
  b.write("RIFF", 0); b.writeUInt32LE(36 + dataSize, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); // fmt=3 表示浮点
  b.writeUInt16LE(1, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 4, 28); b.writeUInt16LE(4, 32);
  b.writeUInt16LE(32, 34); b.write("data", 36); b.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < floats.length; i++) b.writeFloatLE(floats[i], 44 + i * 4);
  return b;
}

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wavtest-")), name);

// findWavDataChunk

test("findWavDataChunk locates the data chunk offset+size", () => {
  const b = pcm16Wav([0, 1, -1, 2]);
  const dc = wav.findWavDataChunk(b);
  assert.deepEqual(dc, { offset: 44, size: 8 });
});

test("findWavDataChunk skips a non-data chunk before data (RIFF traversal)", () => {
  // 造一个 data 之前带 LIST 块（大小 4）的 RIFF。
  const list = Buffer.alloc(12); list.write("LIST", 0); list.writeUInt32LE(4, 4);
  const data = pcm16Wav([5, 6]);
  const head = data.slice(0, 12);            // RIFF 与 WAVE 两段
  const fmtAndData = data.slice(12);          // fmt 块与 data 块
  const b = Buffer.concat([head, list, fmtAndData]);
  const dc = wav.findWavDataChunk(b);
  assert.ok(dc && dc.size === 4, `expected data size 4, got ${JSON.stringify(dc)}`);
});

test("findWavDataChunk returns null when there is no data chunk", () => {
  const b = Buffer.alloc(12); b.write("RIFF", 0); b.write("WAVE", 8);
  assert.equal(wav.findWavDataChunk(b), null);
});

// toPcm16Wav

test("toPcm16Wav returns already-canonical 16-bit PCM unchanged (same buffer)", () => {
  const b = pcm16Wav([100, -100, 200]);
  assert.equal(wav.toPcm16Wav(b), b); // 同一个缓冲区，不重新编码
});

test("toPcm16Wav passes non-WAV / too-short buffers through untouched", () => {
  const junk = Buffer.from("not a wav at all");
  assert.equal(wav.toPcm16Wav(junk), junk);
});

test("toPcm16Wav converts float32 WAV to 16-bit PCM with correct header + clamped samples", () => {
  const b = float32Wav([0, 1.0, -1.0, 0.5, 2.0 /* 超过 1，夹到上限 */]);
  const out = wav.toPcm16Wav(b);
  assert.equal(out.slice(0, 4).toString(), "RIFF");
  assert.equal(out.readUInt16LE(20), 1);   // PCM
  assert.equal(out.readUInt16LE(34), 16);  // 16 位
  const dc = wav.findWavDataChunk(out);
  assert.equal(dc.size, 5 * 2);            // 5 个样本，每个 2 字节
  // 1.0 映射成 0x7fff，-1.0 映射成 -0x8000，超过 1 的 2.0 夹到 0x7fff
  assert.equal(out.readInt16LE(dc.offset + 2), 0x7fff);
  assert.equal(out.readInt16LE(dc.offset + 4), -0x8000);
  assert.equal(out.readInt16LE(dc.offset + 8), 0x7fff);
});

// wavDurationSec

test("wavDurationSec computes seconds from header (8000 samples @ 8kHz = 1.0s)", () => {
  const p = tmp("dur.wav");
  fs.writeFileSync(p, pcm16Wav(new Array(8000).fill(0), 8000, 1));
  assert.ok(Math.abs(wav.wavDurationSec(p) - 1.0) < 1e-6);
});

test("wavDurationSec returns 0 for a non-WAV file", () => {
  const p = tmp("bad.bin");
  fs.writeFileSync(p, Buffer.from("xxxxxxxxxxxxxxxx"));
  assert.equal(wav.wavDurationSec(p), 0);
});

// computeSegmentBounds

test("computeSegmentBounds lays out segments with inter-segment silence", () => {
  const a = tmp("a.wav"), b = tmp("b.wav");
  fs.writeFileSync(a, pcm16Wav(new Array(8000).fill(0), 8000)); // 1.0 秒
  fs.writeFileSync(b, pcm16Wav(new Array(4000).fill(0), 8000)); // 0.5 秒
  const { bounds, duration } = wav.computeSegmentBounds([a, b], 200); // 段间静音 0.2 秒
  assert.deepEqual(bounds[0], { index: 0, start: 0, end: 1.0 });
  assert.deepEqual(bounds[1], { index: 1, start: 1.2, end: 1.7 }); // 1.0 加 0.2 的段间静音
  assert.equal(duration, 1.7); // 最后一段之后不留段间静音
});

// generateSilenceWav

test("generateSilenceWav writes a valid silent WAV of the requested duration", () => {
  const p = tmp("silence.wav");
  wav.generateSilenceWav(500, 8000, p); // 0.5 秒，采样率 8 kHz
  const b = fs.readFileSync(p);
  assert.equal(b.slice(0, 4).toString(), "RIFF");
  const dc = wav.findWavDataChunk(b);
  assert.equal(dc.size, 4000 * 2);      // 4000 个样本，每个 2 字节
  assert.ok(b.slice(dc.offset).every(byte => byte === 0)); // 全是零，确实是静音
});

// concatWavPureNode

test("concatWavPureNode joins matching-format WAVs and sums their data", async () => {
  const a = tmp("c1.wav"), b = tmp("c2.wav"), out = tmp("joined.wav");
  fs.writeFileSync(a, pcm16Wav([1, 2, 3], 8000));
  fs.writeFileSync(b, pcm16Wav([4, 5], 8000));
  const res = await wav.concatWavPureNode([a, b], out);
  assert.equal(res.method, "node");
  const dc = wav.findWavDataChunk(fs.readFileSync(out));
  assert.equal(dc.size, (3 + 2) * 2);
});

test("concatWavPureNode rejects on sample-rate / format mismatch", async () => {
  const a = tmp("m1.wav"), b = tmp("m2.wav"), out = tmp("m.wav");
  fs.writeFileSync(a, pcm16Wav([1], 8000));
  fs.writeFileSync(b, pcm16Wav([1], 16000)); // 采样率不同
  await assert.rejects(wav.concatWavPureNode([a, b], out), /format mismatch/);
});
