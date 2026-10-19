// 音频容器时长解析：WAV / FLAC / MP3 / MP4 / Ogg，纯读文件头，不依赖 ffmpeg。
const fs = require("fs");
const path = require("path");

/**
 * Find the "data" chunk offset in a WAV buffer using proper RIFF chunk traversal.
 * Returns the offset of the data chunk's data field, or 0 if not found.
 */
function findWavDataOffset(buf) {
 let offset = 12;
 while (offset + 8 <= buf.length) {
 const chunkId = buf.slice(offset, offset + 4).toString();
 const chunkSize = buf.readUInt32LE(offset + 4);
 if (chunkId === "data") {
 return offset + 8;
 }
 // Move to next chunk (pad to even boundary per RIFF spec)
 offset += 8 + chunkSize + (chunkSize % 2);
 }
 return 0;
}

/**
 * Get WAV duration in seconds by parsing the file header.
 */
function getWavDuration(filePath) {
 try {
 const buf = fs.readFileSync(filePath);
 if (buf.length < 44) return 0;
 // Verify RIFF/WAVE header
 if (buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46) return 0;
 // Find "data" chunk using proper RIFF traversal
 const dataOffset = findWavDataOffset(buf);
 if (!dataOffset) return 0;
 const sampleRate = buf.readUInt32LE(24);
 const bitsPerSample = buf.readUInt16LE(34);
 const channels = buf.readUInt16LE(22);
 // byteRate guards all of sampleRate / channels / bitsPerSample being zero,
 // preventing a divide-by-zero that would yield Infinity/NaN.
 const byteRate = sampleRate * channels * (bitsPerSample / 8);
 if (!byteRate) return 0;
 // The header's declared data-chunk size can be unreliable: some encoders
 // (streaming / piped writers) leave it 0 or a placeholder (e.g.
 // 0xFFFFFFFF), which made whole voices report "0.0s". Fall back to — or
 // clamp against — the bytes actually present in the file.
 const declared = buf.readUInt32LE(dataOffset - 4);
 const available = buf.length - dataOffset;
 const dataSize = (!declared || declared > available) ? available : declared;
 return dataSize / byteRate;
 } catch {
 return 0;
 }
}

/**
 * FLAC duration from the STREAMINFO metadata block (exact — total samples and
 * sample rate are stored in the header). Returns 0 if not a FLAC / unreadable.
 */
function getFlacDuration(buf) {
 // "fLaC" magic + first metadata block must be STREAMINFO (type 0).
 if (buf.length < 42) return 0;
 if (buf[0] !== 0x66 || buf[1] !== 0x4c || buf[2] !== 0x61 || buf[3] !== 0x43) return 0;
 // STREAMINFO data begins at byte 8; the packed 64-bit field
 // [sampleRate:20][channels:3][bps:5][totalSamples:36] starts at offset 18.
 const p = 18;
 const sampleRate = (buf[p] << 12) | (buf[p + 1] << 4) | (buf[p + 2] >> 4);
 if (!sampleRate) return 0;
 const totalSamples =
 (buf[p + 3] & 0x0f) * 4294967296 + // top 4 bits << 32
 ((buf[p + 4] << 24) >>> 0) +
 (buf[p + 5] << 16) +
 (buf[p + 6] << 8) +
 buf[p + 7];
 return totalSamples / sampleRate;
}

// MP3 header lookup tables (MPEG1/2/2.5, Layer III is what matters here but the
// bitrate/sample-rate tables are indexed generically).
const MP3_BITRATES = {
 // [versionBits][layerBits] -> bitrate table (kbps), index by bitrate_index
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

/**
 * Parse an MPEG audio frame header at `off`. Returns
 * { bitrate, sampleRate, samplesPerFrame, frameLen } for a valid frame, else null.
 */
function parseMp3FrameHeader(buf, off) {
 if (off + 4 > buf.length) return null;
 if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) return null;
 const b1 = buf[off + 1], b2 = buf[off + 2];
 const versionBits = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5 (1=reserved)
 const layerBits = (b1 >> 1) & 0x03; // 3=L1, 2=L2, 1=L3 (0=reserved)
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

 // Samples per frame: L1=384; L2=1152; L3 = 1152 (MPEG1) / 576 (MPEG2/2.5).
 const samplesPerFrame = layerBits === 3 ? 384 : (layerBits === 2 ? 1152 : (mpeg1 ? 1152 : 576));
 // Frame length in bytes (L1 padding is 4-byte slots, L2/L3 is 1 byte).
 const frameLen = layerBits === 3
 ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
 : Math.floor((samplesPerFrame / 8 * bitrate) / sampleRate) + padding;
 if (frameLen < 4) return null;
 return { bitrate, sampleRate, samplesPerFrame, frameLen, mpeg1,
 channelMode: (buf[off + 3] >> 6) & 0x03 };
}

/**
 * MP3 duration. Robust against large ID3v2 tags (album art is full of 0xFF
 * bytes that look like frame syncs): the first frame is confirmed only when a
 * second valid frame follows at the computed offset. Then prefers the exact
 * VBR (Xing/Info/VBRI) frame count; otherwise walks every frame and sums their
 * individual durations (exact for CBR *and* headerless VBR). Returns 0 on failure.
 */
function getMp3Duration(buf) {
 let start = 0;
 // Skip an ID3v2 tag ("ID3" + ver(2) + flags(1) + syncsafe size(4)); +10 footer if present.
 if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
 const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
 const footer = (buf[5] & 0x10) ? 10 : 0;
 start = 10 + size + footer;
 }
 if (start >= buf.length) start = 0; // bad tag size → scan from top

 // Locate the first *confirmed* frame: a valid header whose successor frame is
 // also valid (or which reaches EOF). Scans forward to skip false syncs.
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

 // Xing / Info header (after side info): MPEG1 mono=17/stereo=32, MPEG2 mono=9/stereo=17.
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

 // No VBR header → walk every frame, summing each frame's own duration. This is
 // exact for CBR and for VBR files that lack a Xing/VBRI header.
 let end = buf.length;
 if (end - start >= 128 && buf.slice(end - 128, end - 125).toString('latin1') === 'TAG') end -= 128;
 let pos = first, dur = 0, frames = 0;
 while (pos + 4 <= end) {
 const h = parseMp3FrameHeader(buf, pos);
 if (!h) { // desync — try to resync forward a little before giving up
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

/**
 * MP4 / M4A duration from the mvhd atom inside moov (exact: duration/timescale).
 * Returns 0 if the atoms are absent / unreadable.
 */
function getMp4Duration(buf) {
 const len = buf.length;
 // Walk top-level atoms to find "moov", then its child "mvhd".
 function findAtom(type, from, to) {
 let off = from;
 while (off + 8 <= to) {
 let size = buf.readUInt32BE(off);
 const atomType = buf.slice(off + 4, off + 8).toString('latin1');
 let header = 8;
 if (size === 1) { // 64-bit extended size
 if (off + 16 > to) break;
 size = buf.readUInt32BE(off + 8) * 4294967296 + buf.readUInt32BE(off + 12);
 header = 16;
 } else if (size === 0) {
 size = to - off; // extends to end
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
 * Ogg (Vorbis / Opus) duration. Sample rate comes from the identification
 * header on the first page; total samples from the last page's granule
 * position. Returns 0 if unreadable.
 */
function getOggDuration(buf) {
 if (buf.length < 4 || buf.slice(0, 4).toString('latin1') !== 'OggS') return 0;
 // Identification header lives in the first page's packet body (after the
 // 27-byte page header + segment table).
 const segCount = buf[26];
 const bodyStart = 27 + segCount;
 const id = buf.slice(bodyStart, bodyStart + 8).toString('latin1');
 let sampleRate = 0, preSkip = 0, isOpus = false;
 if (id.startsWith('\x01vorbis')) {
 // vorbis id header: type(1)+"vorbis"(6)+version(4)+channels(1)+rate(4 LE)@12
 sampleRate = buf.readUInt32LE(bodyStart + 12);
 } else if (id === 'OpusHead') {
 isOpus = true;
 sampleRate = 48000; // Opus granule is always at 48 kHz
 preSkip = buf.readUInt16LE(bodyStart + 10);
 } else {
 return 0;
 }
 if (!sampleRate) return 0;
 // Find the LAST "OggS" page and read its 64-bit LE granule position (offset 6).
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

/**
 * Detect the actual audio container from the file's magic bytes, ignoring the
 * filename extension. This matters because downloaded / re-saved audio is often
 * mislabelled (e.g. an Ogg/Opus stream saved as ".mp3"), and trusting the
 * extension makes the wrong parser return garbage / 0. Returns a format key or
 * null if unrecognised.
 */
function sniffAudioFormat(buf) {
 if (buf.length >= 12 &&
 buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // "RIFF"
 buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) return 'wav'; // "WAVE"
 if (buf.length >= 4) {
 if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg'; // "OggS"
 if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return 'flac'; // "fLaC"
 }
 // ISO-BMFF: a "ftyp" box at offset 4 → mp4 / m4a / aac-in-mp4.
 if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'mp4';
 // MP3: ID3v2 tag or a raw MPEG-audio frame sync.
 if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3'; // "ID3"
 if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
 return null;
}

/**
 * Duration in seconds for any supported audio file. Format is detected from the
 * file's *magic bytes* (not the extension — mislabelled files are common), with
 * the extension used only as a last-resort hint. All parsers are pure header
 * reads (no ffmpeg), matching this project's decoupled-ffmpeg design.
 */
function getAudioDuration(filePath) {
 try {
 const buf = fs.readFileSync(filePath);
 let fmt = sniffAudioFormat(buf);
 if (!fmt) {
 // Fall back to the extension when the header is unrecognised.
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
