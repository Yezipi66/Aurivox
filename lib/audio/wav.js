// WAV 读写工具：生成静音、定位数据块、归一化为 16 位 PCM、读时长、算分段边界、拼接。
// 只碰文件系统，不读应用层配置；所有换算按 RIFF 规范逐块遍历，不假设 data 块紧跟 fmt 块。

const fs = require("fs");

// 生成指定时长的静音 WAV（16 位单声道 PCM）并写到 outputPath。
function generateSilenceWav(durationMs, sampleRate = 22050, outputPath) {
  const numSamples = Math.floor(sampleRate * durationMs / 1000);
  const dataSize = numSamples * 2; // 16 位单声道
  const buffer = Buffer.alloc(44 + dataSize);

  // WAV 文件头
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);      // 块长度
  buffer.writeUInt16LE(1, 20);       // PCM
  buffer.writeUInt16LE(1, 22);       // 单声道
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // 字节率
  buffer.writeUInt16LE(2, 32);       // 帧对齐
  buffer.writeUInt16LE(16, 34);      // 每样本位数
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  // 数据段本来就是全零，即静音。

  fs.writeFileSync(outputPath, buffer);
}

// 在 WAV 缓冲区里按 RIFF 逐块遍历找 "data" 块。
// 返回 { offset, size }（offset 指向数据首字节），找不到返回 null。
function findWavDataChunk(buf) {
  let offset = 12; // 跳过 RIFF 头（12 字节）
  while (offset + 8 <= buf.length) {
    const chunkId = buf.slice(offset, offset + 4).toString();
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      return { offset: offset + 8, size: chunkSize };
    }
    // 跳到下一块：按 RIFF 规范补齐到偶数边界
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
}

// 把引擎返回的 WAV 归一化成 16 位 PCM，好让浏览器（AudioContext.decodeAudioData）总能解码。
// 引擎可能吐出 32 位浮点或 WAVE_FORMAT_EXTENSIBLE，部分浏览器拒绝解码，症状是单段合成的
// 波形一片空白（多段输出在拼接时已被重写）。已是 16 位 PCM 或解析失败时原样返回，
// 那种情况播放器会退回进度条。
function toPcm16Wav(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 44) return buf;
    if (buf.slice(0, 4).toString() !== "RIFF" || buf.slice(8, 12).toString() !== "WAVE") return buf;
    // 按 RIFF 遍历定位 fmt 与 data 块。
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
    // WAVE_FORMAT_EXTENSIBLE：真正的格式标记在 SubFormat GUID 里。
    if (audioFormat === 0xFFFE && fmt.size >= 40) audioFormat = buf.readUInt16LE(fmt.off + 24);
    if (audioFormat === 1 && bits === 16) return buf; // 已是规范格式

    const raw = buf.slice(data.off, data.off + data.size);
    let samples = null; // 每样本归一化到 [-1, 1]，多声道交错存放
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
      return buf; // 不认识的子格式：原样返回（播放器的进度条兜底）
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
    out.writeUInt32LE(sampleRate * channels * 2, 28);      // 字节率
    out.writeUInt16LE(channels * 2, 32);                   // 帧对齐
    out.writeUInt16LE(16, 34);                             // 每样本位数
    out.write("data", 36);
    out.writeUInt32LE(outData.length, 40);
    outData.copy(out, 44);
    return out;
  } catch { return buf; }
}

// 从文件头读出 WAV 时长（秒），用来在波形预览上标分段边界。
// 只读文件头（取 data 块长度）；声明的长度读不到时退回（文件大小 - 44）。
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

// 拼接后时间轴上每一段的 [start,end] 偏移（秒）：入参是按顺序排好的各段 WAV 与段间静音长度。
// 界面据此在合并波形上画分段分隔线，并把段间静音涂出来。
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

// 纯 Node 实现的 WAV 拼接（不插静音）：各段的采样率、声道数、每样本位数必须一致，
// 不一致就报错，不做转换。写入 outputPath，返回 { method: 'node' }。
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
        // 读必需的格式字段
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
