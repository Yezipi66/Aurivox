// ===========================
//  WAV UTILITIES (pure)
// ===========================
// Self-contained WAV parsing / synthesis / concatenation helpers extracted
// verbatim from server.js (Stage-0 refactor). No app-level state or config —
// only fs. Behaviour is byte-for-byte identical to the previous inline code.

const fs = require("fs");

function generateSilenceWav(durationMs, sampleRate = 22050, outputPath) {
  // Generate a silent WAV file of the given duration
  const numSamples = Math.floor(sampleRate * durationMs / 1000);
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  // WAV header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);      // chunk size
  buffer.writeUInt16LE(1, 20);       // PCM
  buffer.writeUInt16LE(1, 22);       // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);       // block align
  buffer.writeUInt16LE(16, 34);      // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  // Data is already zero (silent)

  fs.writeFileSync(outputPath, buffer);
}

/**
 * Find the "data" chunk in a WAV buffer using proper RIFF chunk traversal.
 * Returns { offset, size } or null if not found.
 */
function findWavDataChunk(buf) {
  let offset = 12; // Skip RIFF header (12 bytes)
  while (offset + 8 <= buf.length) {
    const chunkId = buf.slice(offset, offset + 4).toString();
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      return { offset: offset + 8, size: chunkSize };
    }
    // Move to next chunk (pad to even boundary per RIFF spec)
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
}

// Normalize an engine-produced WAV buffer to canonical 16-bit PCM so browsers
// (AudioContext.decodeAudioData) can always render it. The inference engine may
// emit 32-bit float or WAVE_FORMAT_EXTENSIBLE WAV, which several browsers refuse
// to decode — that shows up as a blank waveform on single-segment generations
// (multi-segment output already gets rewritten during concatenation). Returns the
// original buffer unchanged if it is already 16-bit PCM or if parsing fails (the
// player UI still falls back to the bar track in that case).
function toPcm16Wav(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 44) return buf;
    if (buf.slice(0, 4).toString() !== "RIFF" || buf.slice(8, 12).toString() !== "WAVE") return buf;
    // Locate the fmt + data chunks via proper RIFF traversal.
    let off = 12, fmt = null, data = null;
    while (off + 8 <= buf.length) {
      const id = buf.slice(off, off + 4).toString();
      const size = buf.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === "fmt ") fmt = { off: body, size };
      else if (id === "data") data = { off: body, size: Math.min(size, buf.length - body) };
      off = body + size + (size % 2);
    }
    if (!fmt || !data) return buf;
    let audioFormat = buf.readUInt16LE(fmt.off + 0);
    const channels = buf.readUInt16LE(fmt.off + 2) || 1;
    const sampleRate = buf.readUInt32LE(fmt.off + 4);
    const bits = buf.readUInt16LE(fmt.off + 14);
    // WAVE_FORMAT_EXTENSIBLE: the real format tag lives in the SubFormat GUID.
    if (audioFormat === 0xFFFE && fmt.size >= 40) audioFormat = buf.readUInt16LE(fmt.off + 24);
    if (audioFormat === 1 && bits === 16) return buf; // already canonical

    const raw = buf.slice(data.off, data.off + data.size);
    let samples = null; // per-sample floats in [-1, 1], interleaved
    if (audioFormat === 3 && bits === 32) {
      const n = Math.floor(raw.length / 4);
      samples = new Float64Array(n);
      for (let i = 0; i < n; i++) samples[i] = raw.readFloatLE(i * 4);
    } else if (audioFormat === 1 && bits === 32) {
      const n = Math.floor(raw.length / 4);
      samples = new Float64Array(n);
      for (let i = 0; i < n; i++) samples[i] = raw.readInt32LE(i * 4) / 2147483648;
    } else if (audioFormat === 1 && bits === 24) {
      const n = Math.floor(raw.length / 3);
      samples = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let v = raw[i * 3] | (raw[i * 3 + 1] << 8) | (raw[i * 3 + 2] << 16);
        if (v & 0x800000) v -= 0x1000000;
        samples[i] = v / 8388608;
      }
    } else if (audioFormat === 1 && bits === 8) {
      const n = raw.length;
      samples = new Float64Array(n);
      for (let i = 0; i < n; i++) samples[i] = (raw[i] - 128) / 128;
    } else {
      return buf; // unknown subtype — leave as-is (UI fallback covers it)
    }

    const outData = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      outData.writeInt16LE(Math.round(s), i * 2);
    }
    const out = Buffer.alloc(44 + outData.length);
    out.write("RIFF", 0);
    out.writeUInt32LE(36 + outData.length, 4);
    out.write("WAVE", 8);
    out.write("fmt ", 12);
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20);                              // PCM
    out.writeUInt16LE(channels, 22);
    out.writeUInt32LE(sampleRate, 24);
    out.writeUInt32LE(sampleRate * channels * 2, 28);      // byte rate
    out.writeUInt16LE(channels * 2, 32);                   // block align
    out.writeUInt16LE(16, 34);                             // bits per sample
    out.write("data", 36);
    out.writeUInt32LE(outData.length, 40);
    outData.copy(out, 44);
    return out;
  } catch { return buf; }
}

// Duration (seconds) of a WAV file from its header — used to place segment-boundary
// markers on the waveform preview. Reads only the header region (data chunk size),
// falling back to (fileSize - 44) if the declared size is unavailable.
function wavDurationSec(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, 4096, 0);
    fs.closeSync(fd);
    if (head.slice(0, 4).toString() !== "RIFF" || head.slice(8, 12).toString() !== "WAVE") return 0;
    const sr = head.readUInt32LE(24);
    const ch = head.readUInt16LE(22);
    const bps = head.readUInt16LE(34);
    const dc = findWavDataChunk(head);
    const dataSize = dc ? dc.size : Math.max(0, fs.statSync(filePath).size - 44);
    const bytesPerFrame = (bps >> 3) * ch;
    if (!sr || !bytesPerFrame) return 0;
    return dataSize / (sr * bytesPerFrame);
  } catch { return 0; }
}

// Per-segment [start,end] offsets (seconds) within the concatenated timeline, given
// the ordered segment WAVs and the silence gap inserted between them. Lets the UI draw
// segment dividers + shade the inter-segment silence on the combined waveform.
function computeSegmentBounds(segFiles, silenceMs) {
  const silenceSec = Math.max(0, silenceMs || 0) / 1000;
  const bounds = [];
  let pos = 0;
  for (let i = 0; i < segFiles.length; i++) {
    const d = wavDurationSec(segFiles[i]);
    const start = pos;
    const end = pos + d;
    bounds.push({ index: i, start: +start.toFixed(3), end: +end.toFixed(3) });
    pos = end + (i < segFiles.length - 1 ? silenceSec : 0);
  }
  return { bounds, duration: +pos.toFixed(3) };
}

function concatWavPureNode(inputPaths, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      let totalData = 0;
      let sampleRate = 0;
      let channels = 0;
      let bitsPerSample = 0;

      for (const p of inputPaths) {
        const buf = fs.readFileSync(p);
        if (buf.slice(0, 4).toString() !== "RIFF" || buf.slice(8, 12).toString() !== "WAVE") {
          throw new Error(`Not a valid WAV file: ${p}`);
        }
        // Read required format fields
        const sr = buf.readUInt32LE(24);
        const ch = buf.readUInt16LE(22);
        const bps = buf.readUInt16LE(34);
        if (sampleRate === 0) { sampleRate = sr; channels = ch; bitsPerSample = bps; }
        else if (sr !== sampleRate || ch !== channels || bps !== bitsPerSample) {
          throw new Error(
            `WAV format mismatch: ${p} has ${sr}Hz/${ch}ch/${bps}bit, expected ${sampleRate}Hz/${channels}ch/${bitsPerSample}bit`
          );
        }
        const dc = findWavDataChunk(buf);
        if (!dc) throw new Error(`No data chunk found in: ${p}`);
        const data = buf.slice(dc.offset, dc.offset + dc.size);
        chunks.push(data);
        totalData += dc.size;
      }

      const outBuf = Buffer.alloc(44 + totalData);
      outBuf.write("RIFF", 0);
      outBuf.writeUInt32LE(36 + totalData, 4);
      outBuf.write("WAVE", 8);
      outBuf.write("fmt ", 12);
      outBuf.writeUInt32LE(16, 16);
      outBuf.writeUInt16LE(1, 20);
      outBuf.writeUInt16LE(channels, 22);
      outBuf.writeUInt32LE(sampleRate, 24);
      outBuf.writeUInt32LE(sampleRate * channels * (bitsPerSample >> 3), 28);
      outBuf.writeUInt16LE(channels * (bitsPerSample >> 3), 32);
      outBuf.writeUInt16LE(bitsPerSample, 34);
      outBuf.write("data", 36);
      outBuf.writeUInt32LE(totalData, 40);

      let offset = 44;
      for (const chunk of chunks) {
        chunk.copy(outBuf, offset);
        offset += chunk.length;
      }

      fs.writeFileSync(outputPath, outBuf);
      resolve({ method: "node" });
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateSilenceWav,
  findWavDataChunk,
  toPcm16Wav,
  wavDurationSec,
  computeSegmentBounds,
  concatWavPureNode,
};
