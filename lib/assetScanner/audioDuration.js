// 音频容器时长解析：WAV / FLAC / MP3 / MP4 / Ogg，纯读文件头，不依赖 ffmpeg。
// 格式按文件头字节判断，不看扩展名：下载或另存过的音频常被贴错标签，
// 认扩展名会让错的解析器返回垃圾值或 0。
const fs = require("fs");
const path = require("path");

/** 用 RIFF chunk 遍历找出 WAV 缓冲区里 "data" chunk 的数据起点，找不到返回 0。 */
function findWavDataOffset(buf) {
 let offset = 12;
 while (offset + 8 <= buf.length) {
 const chunkId = buf.slice(offset, offset + 4).toString();
 const chunkSize = buf.readUInt32LE(offset + 4);
 if (chunkId === "data") {
 return offset + 8;
 }
 // 跳到下一个 chunk（按 RIFF 规范补齐到偶数边界）
 offset += 8 + chunkSize + (chunkSize % 2);
 }
 return 0;
}

/** 解析文件头算 WAV 时长（秒）。 */
function getWavDuration(filePath) {
 try {
 const buf = fs.readFileSync(filePath);
 if (buf.length < 44) return 0;
 if (buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46) return 0;
 const dataOffset = findWavDataOffset(buf);
 if (!dataOffset) return 0;
 const sampleRate = buf.readUInt32LE(24);
 const bitsPerSample = buf.readUInt16LE(34);
 const channels = buf.readUInt16LE(22);
 // byteRate 兜住 sampleRate / channels / bitsPerSample 为 0 的情况，否则会除出 Infinity/NaN。
 const byteRate = sampleRate * channels * (bitsPerSample / 8);
 if (!byteRate) return 0;
 // 头部声明的 data chunk 长度不可靠：有些编码器（流式写入、管道写入）留 0 或占位值，
 // 那样整个角色会显示「0.0s」。改为取文件里实际存在的字节数。
 const declared = buf.readUInt32LE(dataOffset - 4);
 const available = buf.length - dataOffset;
 const dataSize = (!declared || declared > available) ? available : declared;
 return dataSize / byteRate;
 } catch {
 return 0;
 }
}

/** FLAC 时长取自 STREAMINFO 元数据块（精确）。不是 FLAC 或元数据缺失时返回 0。 */
function getFlacDuration(buf) {
 // "fLaC" magic 之后第一个元数据块必须是 STREAMINFO（type 0）。
 if (buf.length < 42) return 0;
 if (buf[0] !== 0x66 || buf[1] !== 0x4c || buf[2] !== 0x61 || buf[3] !== 0x43) return 0;
 // STREAMINFO 数据从第 8 字节开始，打包的 64 位域
 // [sampleRate:20][channels:3][bps:5][totalSamples:36] 从第 18 字节起。
 const p = 18;
 const sampleRate = (buf[p] << 12) | (buf[p + 1] << 4) | (buf[p + 2] >> 4);
 if (!sampleRate) return 0;
 const totalSamples =
 (buf[p + 3] & 0x0f) * 4294967296 + // 高 4 位 << 32
 ((buf[p + 4] << 24) >>> 0) +
 (buf[p + 5] << 16) +
 (buf[p + 6] << 8) +
 buf[p + 7];
 return totalSamples / sampleRate;
}

// MP3 帧头查表（MPEG1/2/2.5，实际只用 Layer III，但表是按通用方式索引的）。
const MP3_BITRATES = {
 // [versionBits][layerBits] -> 码率表（kbps）
 '1-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // MPEG1 L1
 '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // MPEG1 L2
 '1-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG1 L3
 '2-3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], // MPEG2/2.5 L1
 '2-1': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG2/2.5 L2/L3
};
const MP3_SAMPLE_RATES = {
 3: [44100, 48000, 32000], // MPEG1
 2: [22050, 24000, 16000], // MPEG2
 0: [11025, 12000, 8000], // MPEG2.5
};

/** 解析 off 处的 MPEG 音频帧头，不是合法帧返回 null。 */
function parseMp3FrameHeader(buf, off) {
 if (off + 4 > buf.length) return null;
 if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) return null;
 const b1 = buf[off + 1], b2 = buf[off + 2];
 const versionBits = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5 (1=保留)
 const layerBits = (b1 >> 1) & 0x03; // 3=L1, 2=L2, 1=L3 (0=保留)
 const bitrateIdx = (b2 >> 4) & 0x0f;
 const sampleRateIdx = (b2 >> 2) & 0x03;
 const padding = (b2 >> 1) & 0x01;
 if (versionBits === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || sampleRateIdx === 3) return null;

 const mpeg1 = versionBits === 3;
 const brTable = MP3_BITRATES[(mpeg1 ? '1' : '2') + '-' + layerBits];
 const srTable = MP3_SAMPLE_RATES[versionBits];
 if (!brTable || !srTable) return null;
 const bitrate = brTable[bitrateIdx] * 1000; // bps
 const sampleRate = srTable[sampleRateIdx];
 if (!bitrate || !sampleRate) return null;

 // 每帧采样数：L1=384；L2=1152；L3 = 1152（MPEG1）/ 576（MPEG2/2.5）。
 const samplesPerFrame = layerBits === 3 ? 384 : (layerBits === 2 ? 1152 : (mpeg1 ? 1152 : 576));
 // 帧长（字节）：L1 补齐到 4 字节槽，L2/L3 补 1 字节。
 const frameLen = layerBits === 3
 ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
 : Math.floor((samplesPerFrame / 8 * bitrate) / sampleRate) + padding;
 if (frameLen < 4) return null;
 return { bitrate, sampleRate, samplesPerFrame, frameLen, mpeg1,
 channelMode: (buf[off + 3] >> 6) & 0x03 };
}

/**
 * MP3 时长。对大 ID3v2 标签稳健（封面图里全是 0xFF 字节，看着像帧同步）：
 * 只有当计算出的偏移处还跟一个合法帧时，首帧才被确认。
 * 之后优先用精确的 VBR（Xing/Info/VBRI）帧数；没有就逐帧累加各自时长。
 */
function getMp3Duration(buf) {
 let start = 0;
 // 跳过 ID3v2 标签（"ID3" + 版本(2) + 标志(1) + syncsafe 长度(4)）；有页脚再加 10。
 if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
 const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
 const footer = (buf[5] & 0x10) ? 10 : 0;
 start = 10 + size + footer;
 }
 if (start >= buf.length) start = 0; // 标签长度不对就从头扫

 // 找第一个被确认的帧：合法帧头，且按帧长算出的后继位置也是合法帧（或已到文件尾）。
 let first = -1, hdr = null;
 const scanLimit = buf.length - 4;
 for (let i = start; i <= scanLimit; i++) {
 if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
 const h = parseMp3FrameHeader(buf, i);
 if (!h) continue;
 const next = i + h.frameLen;
 if (next + 2 > buf.length || parseMp3FrameHeader(buf, next)) { first = i; hdr = h; break; }
 }
 if (first < 0) return 0;

 const tagAt = (o) => o + 4 <= buf.length ? buf.slice(o, o + 4).toString('latin1') : '';

 // Xing / Info 头（side info 之后）：MPEG1 单声道=17/立体声=32，MPEG2 单声道=9/立体声=17。
 const mono = hdr.channelMode === 3;
 const sideInfo = hdr.mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
 const xingOff = first + 4 + sideInfo;
 if (tagAt(xingOff) === 'Xing' || tagAt(xingOff) === 'Info') {
 const flags = buf.readUInt32BE(xingOff + 4);
 if (flags & 0x01) {
 const frames = buf.readUInt32BE(xingOff + 8);
 if (frames > 0) return (frames * hdr.samplesPerFrame) / hdr.sampleRate;
 }
 }
 if (tagAt(first + 4 + 32) === 'VBRI') {
 const frames = buf.readUInt32BE(first + 4 + 32 + 14);
 if (frames > 0) return (frames * hdr.samplesPerFrame) / hdr.sampleRate;
 }

 // 没有 VBR 头：逐帧累加每帧自己的时长。对 CBR 和缺 Xing/VBRI 头的 VBR 都精确。
 let end = buf.length;
 if (end - start >= 128 && buf.slice(end - 128, end - 125).toString('latin1') === 'TAG') end -= 128;
 let pos = first, dur = 0, frames = 0;
 while (pos + 4 <= end) {
 const h = parseMp3FrameHeader(buf, pos);
 if (!h) { // 失步：先往前试着重新同步，找不到才放弃
 let j = pos + 1;
 while (j + 4 <= end && !(buf[j] === 0xff && (buf[j + 1] & 0xe0) === 0xe0 && parseMp3FrameHeader(buf, j))) j++;
 if (j + 4 > end) break;
 pos = j; continue;
 }
 dur += h.samplesPerFrame / h.sampleRate;
 frames++;
 pos += h.frameLen;
 }
 if (frames === 0) return 0;
 return dur;
}

/** MP4 / M4A 时长取自 moov 里的 mvhd atom（精确）。atom 缺失或元数据不完整时返回 0。 */
function getMp4Duration(buf) {
 const len = buf.length;
 function findAtom(type, from, to) {
 let off = from;
 while (off + 8 <= to) {
 let size = buf.readUInt32BE(off);
 const atomType = buf.slice(off + 4, off + 8).toString('latin1');
 let header = 8;
 if (size === 1) { // 64 位扩展长度
 if (off + 16 > to) break;
 size = buf.readUInt32BE(off + 8) * 4294967296 + buf.readUInt32BE(off + 12);
 header = 16;
 } else if (size === 0) {
 size = to - off; // 一直到结尾
 }
 if (atomType === type) return { off, size, dataOff: off + header };
 if (size < header) break;
 off += size;
 }
 return null;
 }
 const moov = findAtom('moov', 0, len);
 if (!moov) return 0;
 const moovEnd = Math.min(len, moov.off + moov.size);
 const mvhd = findAtom('mvhd', moov.dataOff, moovEnd);
 if (!mvhd) return 0;
 const d = mvhd.dataOff;
 const version = buf[d];
 let timescale, duration;
 if (version === 1) {
 timescale = buf.readUInt32BE(d + 20);
 duration = buf.readUInt32BE(d + 24) * 4294967296 + buf.readUInt32BE(d + 28);
 } else {
 timescale = buf.readUInt32BE(d + 12);
 duration = buf.readUInt32BE(d + 16);
 }
 if (!timescale) return 0;
 return duration / timescale;
}

/**
 * Ogg（Vorbis / Opus）时长。采样率取自首页的 identification 头，
 * 总采样数取自最后一页的 granule position。
 */
function getOggDuration(buf) {
 if (buf.length < 4 || buf.slice(0, 4).toString('latin1') !== 'OggS') return 0;
 // identification 头在首页的数据区里（27 字节页头 + 段表之后）。
 const segCount = buf[26];
 const bodyStart = 27 + segCount;
 const id = buf.slice(bodyStart, bodyStart + 8).toString('latin1');
 let sampleRate = 0, preSkip = 0, isOpus = false;
 if (id.startsWith('\x01vorbis')) {
 // vorbis id 头：type(1)+"vorbis"(6)+版本(4)+声道(1)+采样率(4 LE)@12
 sampleRate = buf.readUInt32LE(bodyStart + 12);
 } else if (id === 'OpusHead') {
 isOpus = true;
 sampleRate = 48000; // Opus 的 granule 恒为 48 kHz
 preSkip = buf.readUInt16LE(bodyStart + 10);
 } else {
 return 0;
 }
 if (!sampleRate) return 0;
 // 找最后一个 "OggS" 页，读它的 64 位 LE granule position（偏移 6）。
 let last = -1;
 for (let o = buf.length - 4; o >= 0; o--) {
 if (buf[o] === 0x4f && buf[o + 1] === 0x67 && buf[o + 2] === 0x67 && buf[o + 3] === 0x53) { last = o; break; }
 }
 if (last < 0 || last + 14 > buf.length) return 0;
 const lo = buf.readUInt32LE(last + 6);
 const hi = buf.readUInt32LE(last + 10);
 const granule = hi * 4294967296 + lo;
 const samples = isOpus ? Math.max(0, granule - preSkip) : granule;
 return samples / sampleRate;
}

/** 按文件头字节判断实际容器格式，不看扩展名。认不出返回 null。 */
function sniffAudioFormat(buf) {
 if (buf.length >= 12 &&
 buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // "RIFF"
 buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) return 'wav'; // "WAVE"
 if (buf.length >= 4) {
 if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg'; // "OggS"
 if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return 'flac'; // "fLaC"
 }
 // ISO-BMFF：偏移 4 处有 "ftyp" box 就是 mp4 / m4a / mp4 里的 aac。
 if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'mp4';
 // MP3：ID3v2 标签，或裸的 MPEG 音频帧同步。
 if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3'; // "ID3"
 if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
 return null;
}

/** 任意受支持音频文件的时长（秒）。 */
function getAudioDuration(filePath) {
 try {
 const buf = fs.readFileSync(filePath);
 let fmt = sniffAudioFormat(buf);
 if (!fmt) {
 const ext = path.extname(filePath).toLowerCase();
 if (ext === '.wav') fmt = 'wav';
 else if (ext === '.flac') fmt = 'flac';
 else if (ext === '.mp3') fmt = 'mp3';
 else if (ext === '.m4a' || ext === '.mp4' || ext === '.aac') fmt = 'mp4';
 else if (ext === '.ogg' || ext === '.oga' || ext === '.opus') fmt = 'ogg';
 }
 let dur = 0;
 if (fmt === 'wav') dur = getWavDuration(filePath);
 else if (fmt === 'flac') dur = getFlacDuration(buf);
 else if (fmt === 'mp3') dur = getMp3Duration(buf);
 else if (fmt === 'mp4') dur = getMp4Duration(buf);
 else if (fmt === 'ogg') dur = getOggDuration(buf);
 return Number.isFinite(dur) && dur > 0 ? dur : 0;
 } catch {
 return 0;
 }
}

module.exports = { findWavDataOffset, getWavDuration, getFlacDuration, parseMp3FrameHeader, getMp3Duration, getMp4Duration, getOggDuration, sniffAudioFormat, getAudioDuration };
