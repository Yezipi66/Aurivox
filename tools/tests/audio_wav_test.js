// Minimal, dependency-free smoke test for the Stage-0 audio extraction.
// Run:  node tools/tests/audio_wav_test.js
// Exits non-zero on failure. This is the seed for a real test suite.

const os = require("os");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const w = require("../../lib/audio/wav");
const f = require("../../lib/audio/ffmpeg");
const g = require("../../lib/gsv/client");
const cu = require("../../lib/system/cuda");

let failed = 0;
function check(name, fn) {
  try { const r = fn(); if (r && r.then) return r.then(() => console.log("  ok   " + name)).catch(e => { failed++; console.error("  FAIL " + name + " :: " + e.message); }); console.log("  ok   " + name); }
  catch (e) { failed++; console.error("  FAIL " + name + " :: " + e.message); }
}

// --- module surface ---
check("exports present", () => {
  for (const k of ["gsvRequest", "gsvPost", "gsvGet"]) assert.equal(typeof g[k], "function");
  for (const k of ["generateSilenceWav", "findWavDataChunk", "toPcm16Wav", "wavDurationSec", "computeSegmentBounds", "concatWavPureNode"]) assert.equal(typeof w[k], "function");
  for (const k of ["vendoredFfmpegPath", "ffmpegCmd", "checkFfmpeg", "transcodeAudio"]) assert.equal(typeof f[k], "function");
  assert.deepEqual(Object.keys(f.AUDIO_FORMATS).sort(), ["aac", "flac", "mp3", "opus", "wav"]);
  for (const k of ["startCudaProbe", "detectCuda"]) assert.equal(typeof cu[k], "function");
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wavtest-"));
const a = path.join(tmp, "a.wav");
const b = path.join(tmp, "b.wav");

check("generateSilenceWav + wavDurationSec", () => {
  w.generateSilenceWav(500, 22050, a);
  w.generateSilenceWav(1000, 22050, b);
  assert.ok(Math.abs(w.wavDurationSec(a) - 0.5) < 1e-6, "0.5s");
  assert.ok(Math.abs(w.wavDurationSec(b) - 1.0) < 1e-6, "1.0s");
});

check("computeSegmentBounds accounts for silence gap", () => {
  const sb = w.computeSegmentBounds([a, b], 300);
  assert.equal(sb.bounds[0].end, 0.5);
  assert.equal(sb.bounds[1].start, 0.8); // 0.5 + 0.3 gap
  assert.equal(sb.bounds[1].end, 1.8);
  assert.equal(sb.duration, 1.8);
});

check("toPcm16Wav passthrough on canonical 16-bit", () => {
  const raw = fs.readFileSync(a);
  assert.ok(w.toPcm16Wav(raw) === raw, "same buffer reference");
});

check("toPcm16Wav converts 32-bit float to 16-bit PCM", () => {
  const n = 2205, sr = 22050;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) data.writeFloatLE(Math.sin(i / 20) * 0.5, i * 4);
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write("WAVE", 8);
  hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(3, 20); // IEEE float
  hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 4, 28);
  hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(32, 34);
  hdr.write("data", 36); hdr.writeUInt32LE(data.length, 40);
  const floatWav = Buffer.concat([hdr, data]);
  const conv = w.toPcm16Wav(floatWav);
  assert.ok(conv !== floatWav, "converted to a new buffer");
  assert.equal(conv.readUInt16LE(34), 16, "16 bits per sample");
  assert.equal(conv.readUInt16LE(20), 1, "PCM tag");
});

// async concat test, then final tally
check("concatWavPureNode joins durations", () => {
  const out = path.join(tmp, "out.wav");
  return w.concatWavPureNode([a, b], out).then(r => {
    assert.equal(r.method, "node");
    assert.ok(Math.abs(w.wavDurationSec(out) - 1.5) < 1e-6, "1.5s");
  });
}).then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`\n${failed} test(s) FAILED`); process.exit(1); }
  console.log("\nall audio/gsv/cuda extraction tests passed");
});
