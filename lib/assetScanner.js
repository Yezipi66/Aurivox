// lib/assetScanner.js
// Scans GPT-SoVITS directory structure and generates meta.json for voice assets

const fs = require("fs");
const path = require("path");
const { ASSETS_ROOT } = require('./paths');

const ASSETS_DIR = ASSETS_ROOT;

// Default language used only when a voice has no existing meta.json to inherit
// from. Real per-voice language is written by the training pipeline (promote)
// and must be preserved across rescans (see scanVoiceDir).
const DEFAULT_LANGUAGE = "ja";

// Known GPT-SoVITS directory patterns
// base = GPT-SoVITS root (e.g. D:\AI\GPT-SoVITS-v2pro-20250604)
const GSV_BASE = process.env.GSV_BASE || "";
const GSV_PATHS = {
  // Training outputs
  slicerOpt: (base) => path.join(base, "output", "slicer_opt"),
  asrOpt: (base) => path.join(base, "output", "asr_opt"),
  // Models
  gptWeights: (base) => path.join(base, "GPT_weights_v2Pro"),
  sovitsWeights: (base) => path.join(base, "SoVITS_weights_v2Pro"),
  // Training logs (contains name2text)
  logs: (base, voiceName) => path.join(base, "logs", voiceName),
  // Raw audio
  noSlice: process.env.NO_SLICE_DIR || "",
};

/**
 * Atomic file write: write to temp file then rename.
 * Prevents readers from seeing partially-written JSON.
 */
function atomicWriteFile(filePath, content) {
  const tmp = filePath + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

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
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],    // MPEG1 L2
  '1-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],     // MPEG1 L3
  '2-3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],    // MPEG2/2.5 L1
  '2-1': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],         // MPEG2/2.5 L2/L3
};
const MP3_SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000],  // MPEG2.5
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
  const layerBits = (b1 >> 1) & 0x03;   // 3=L1, 2=L2, 1=L3 (0=reserved)
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
    if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg';  // "OggS"
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

/**
 * Format file size for display.
 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + "KB";
  return (bytes / (1024 * 1024)).toFixed(0) + "MB";
}

/**
 * Extract step number from checkpoint filename.
 * e.g. "白金-e15.ckpt" => 15, "D_233333333333.pth" => null
 */
function extractStep(name) {
  const m = name.match(/-e(\d+)\.ckpt$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * Get all voice asset directories.
 */
function listVoiceAssets() {
  const voices = {};
  try {
    const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const voiceDir = path.join(ASSETS_DIR, e.name);
      const metaPath = path.join(voiceDir, "meta.json");
      if (fs.existsSync(metaPath)) {
        try {
          voices[e.name] = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        } catch {
          voices[e.name] = { id: e.name, _metaError: true };
        }
      } else {
        // No meta.json — scan and generate
        voices[e.name] = scanVoiceDir(e.name, voiceDir);
      }
    }
  } catch (err) {
    console.error("[ASSETS] Error listing assets:", err.message);
  }
  return voices;
}

/**
 * Rebuild a voice's language from published model filenames. Models are named
 * `<id>_<lang>-e<epoch>.ckpt` (GPT) and `<id>_<lang>_e<epoch>_s<step>.pth`
 * (SoVITS), so the language token is the segment immediately before the epoch
 * marker. Used ONLY to recover a lost/missing meta.language — a present
 * meta.language always wins (fine-tuned metadata is first-truth).
 * Returns a lang token (e.g. "ja", "en", "zh") or null if none can be parsed.
 */
function deriveLanguageFromModels(voiceDir) {
  const probe = (dir, re) => {
    try {
      if (!fs.existsSync(dir)) return null;
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(re);
        if (m) return m[1].toLowerCase();
      }
    } catch (_) {}
    return null;
  };
  return (
    probe(path.join(voiceDir, "gpt_checkpoints"), /_([a-zA-Z]{2,3})-e\d+\.ckpt$/) ||
    probe(path.join(voiceDir, "sovits_models"), /_([a-zA-Z]{2,3})_e\d+_s\d+\.pth$/) ||
    null
  );
}

/**
 * Scan a single voice directory and build meta.json.
 */
function scanVoiceDir(voiceId, voiceDir) {
  // Preserve user-/pipeline-authored metadata across rescans. A fresh scan must
  // only refresh the `assets` inventory + segment counts — it must NOT reset
  // display_name or language back to defaults (Bug B/E). Read any existing
  // meta.json first and inherit those fields.
  let prev = null;
  try {
    const prevPath = path.join(voiceDir, "meta.json");
    if (fs.existsSync(prevPath)) prev = JSON.parse(fs.readFileSync(prevPath, "utf-8"));
  } catch (e) {
    console.error(`[ASSETS] Could not read existing meta.json for ${voiceId}:`, e.message);
  }

  // Language resolution order (meta is always first-truth):
  //   1. existing meta.language (fine-tuned/pipeline-written value) — never overridden
  //   2. rebuilt from a published model filename (<id>_<lang>-e… / <id>_<lang>_e…_s…)
  //      — used only when meta is missing/lost or the field is absent
  //   3. DEFAULT_LANGUAGE fallback (legacy models with no language token)
  const rebuiltLang = prev?.language ? null : deriveLanguageFromModels(voiceDir);
  const resolvedLang = prev?.language || rebuiltLang || DEFAULT_LANGUAGE;

  const meta = {
    id: voiceId,
    display_name: prev?.display_name || voiceId,
    mode: prev?.mode || "internal",
    language: resolvedLang,
    prompt_lang: prev?.prompt_lang || resolvedLang,
    text_lang: prev?.text_lang || resolvedLang,
    created_at: prev?.created_at || new Date().toISOString(),
    assets: {},
  };

  // Patch #13/#12: preserve transcript provenance across rescans (source +
  // revision + verification). A fresh scan must not silently reset a transcript
  // the user has hand-edited/verified back to an unknown state.
  if (prev && prev.transcript && typeof prev.transcript === "object") {
    meta.transcript = prev.transcript;
  }
  // Preserve refinement lineage (Patch #12) so a rescan never drops it.
  if (prev && prev.refinement && typeof prev.refinement === "object") {
    meta.refinement = prev.refinement;
  }

  // 扫描 _publish/ 目录结构（唯一入库来源）
  // 不再自动从 GSV 输出目录导入 —— 训练流程通过 promote 步骤写入

  // --- raw/ ---
  const rawDir = path.join(voiceDir, "raw");
  if (fs.existsSync(rawDir)) {
    const files = fs.readdirSync(rawDir).filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f));
    let totalDur = 0;
    for (const f of files) {
      totalDur += getAudioDuration(path.join(rawDir, f));
    }
    meta.assets.raw = {
      dir: rawDir.replace(/\\/g, "/"),
      file_count: files.length,
      total_duration: Math.round(totalDur * 100) / 100,
      files: files,
    };
  }

  // --- slicer_opt/ ---
  const slicesDir = path.join(voiceDir, "slicer_opt");
  const segmentsFile = path.join(voiceDir, "segments.json");
  if (fs.existsSync(slicesDir)) {
    const files = fs.readdirSync(slicesDir).filter(f => /\.wav$/i.test(f));
    meta.assets.slices = {
      dir: slicesDir.replace(/\\/g, "/"),
      file_count: files.length,
    };
    if (fs.existsSync(segmentsFile)) {
      meta.assets.slices.segments_file = segmentsFile.replace(/\\/g, "/");
    }
  }

  // --- segments.json (source-aware; works for slice OR raw-only assets) ---
  // Auto-generate when a transcript list exists but segments.json doesn't.
  // buildSegmentsFor picks slicer_opt.list / raw_opt.list appropriately.
  if (!fs.existsSync(segmentsFile)) {
    try {
      const segData = buildSegmentsFor(voiceDir, voiceId);
      if (segData && segData.ok !== false) {
        atomicWriteFile(segmentsFile, JSON.stringify(segData, null, 2));
        meta.segment_total = segData.matched;
        meta.segment_matched = segData.matched;
        if (meta.assets.slices) meta.assets.slices.segments_file = segmentsFile.replace(/\\/g, "/");
      }
    } catch (segErr) {
      console.error(`[ASSETS] Auto-generate segments failed for ${voiceId}:`, segErr.message);
    }
  }

  // --- gpt_checkpoints/ ---
  const gptDir = path.join(voiceDir, "gpt_checkpoints");
  if (fs.existsSync(gptDir)) {
    const files = fs.readdirSync(gptDir).filter(f => /\.ckpt$/i.test(f));
    meta.assets.checkpoints = {
      gpt: files.map(f => {
        const stat = fs.statSync(path.join(gptDir, f));
        return {
          name: f,
          path: path.join(gptDir, f).replace(/\\/g, "/"),
          steps: extractStep(f),
          size_mb: Math.round(stat.size / (1024 * 1024)),
        };
      }),
    };
  }

  // --- sovits_models/ ---
  const sovitsDir = path.join(voiceDir, "sovits_models");
  if (fs.existsSync(sovitsDir)) {
    // 读取 .pth 前 2 字节版本头判断底模版本（与官方 process_ckpt 判定一致）。
    const detectSovitsVersion = (fp) => {
      try {
        const fd = fs.openSync(fp, "r");
        const buf = Buffer.alloc(2);
        fs.readSync(fd, buf, 0, 2, 0);
        fs.closeSync(fd);
        const head = buf.toString("latin1");
        const map = { "00": "v1", "01": "v2", "02": "v3", "03": "v3", "04": "v4", "05": "v2Pro", "06": "v2ProPlus" };
        if (Object.prototype.hasOwnProperty.call(map, head)) return map[head];
        // 补救线（仅当权重头非官方标记时）：从文件名 version token 恢复版本。
        const _bn = path.basename(fp);
        if (/_v2ProPlus_/i.test(_bn)) return "v2ProPlus";
        if (/_v2Pro_/i.test(_bn)) return "v2Pro";
        if (/_v2_/i.test(_bn)) return "v2";
        // 传统 torch.save（zip，头为 'PK'）：按文件大小粗判
        const sz = fs.statSync(fp).size;
        if (sz < 82978 * 1024) return "v1";
        if (sz < 700 * 1024 * 1024) return "v2";
        return "v3";
      } catch (e) { return null; }
    };
    const files = fs.readdirSync(sovitsDir).filter(f => /\.pth$/i.test(f));
    meta.assets.checkpoints = meta.assets.checkpoints || {};
    meta.assets.checkpoints.sovits = files.map(f => {
      const stat = fs.statSync(path.join(sovitsDir, f));
      return {
        name: f,
        path: path.join(sovitsDir, f).replace(/\\/g, "/"),
        size_mb: Math.round(stat.size / (1024 * 1024)),
        version: detectSovitsVersion(path.join(sovitsDir, f)),
      };
    });
  }

  // --- references/ ---
  const refDir = path.join(voiceDir, "references");
  if (fs.existsSync(refDir)) {
    const files = fs.readdirSync(refDir).filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f));
    meta.assets.references = files.map(f => ({
      name: f,
      path: path.join(refDir, f).replace(/\\/g, "/"),
    }));
  }

  // --- reference-text advisory (advisory only — NOT a hard error) ---
  // Reference TEXT is optional: inference works without it. This is a REAL check,
  // not just file existence: a list only counts when its path column is the modern
  // asset-relative form (<sub>/<file>) AND those files actually exist. Legacy/edited
  // lists with dead absolute paths are flagged "invalid → re-transcribe" (we do NOT
  // auto-repair; a normal training run never produces bad paths, so this only trips
  // on hand-edited/legacy data — the fix is simply to re-run ASR).
  const rawStat = inspectTranscriptList(voiceDir, "raw", "raw_opt.list");
  const sliceStat = inspectTranscriptList(voiceDir, "slicer_opt", "slicer_opt.list");
  const anyInvalid = rawStat.status === "invalid" || sliceStat.status === "invalid";
  const rawOk = rawStat.status === "ok";
  const sliceOk = sliceStat.status === "ok";
  // Priority: a HEALTHY source always wins. A good raw (or slices) list must never be
  // masked by a stale/invalid *other* list. Concretely: after the slices are removed
  // but a leftover slicer_opt.list lingers (text lines whose audio is gone → matched=0
  // → "invalid"), running "Generate reference text" on raw produces a valid raw_opt.list
  // ("ok"); we then report "raw" (yellow ◑), NOT "invalid" (red). "invalid" is reserved
  // for when NO source is usable yet SOMETHING is broken (real stale/hand-edited list).
  let state, advisory;
  if (rawOk && sliceOk) { state = "both"; advisory = null; }
  else if (rawOk) {
    state = "raw";
    advisory = sliceStat.status === "invalid"
      ? "Reference text present for raw audio. A leftover slices list is stale — re-slice + ASR to restore slice text."
      : "Reference text present for raw audio only.";
  }
  else if (sliceOk) {
    state = "slices";
    advisory = rawStat.status === "invalid"
      ? "Reference text present for slices. A leftover raw list is stale — re-run ASR on raw to restore raw text."
      : "Reference text present for slices only.";
  }
  else if (anyInvalid) {
    state = "invalid";
    const which = [rawStat.status === "invalid" && "raw", sliceStat.status === "invalid" && "slices"].filter(Boolean).join(" & ");
    advisory = `Reference-text paths look invalid (${which}) — likely legacy or hand-edited. Re-run ASR to regenerate.`;
  }
  else { state = "none"; advisory = "No reference text — inference still works; generating one is recommended."; }
  meta.reference_text = { state, raw: rawStat, slices: sliceStat, advisory };

  return meta;
}

/**
 * Validate a transcript list for real (not just "file exists").
 * A list is "ok" only when its path column uses the modern asset-relative form
 * `<sub>/<file>` AND at least one referenced audio file actually exists in <sub>/.
 * Legacy/edited lists (absolute/dead paths) resolve their basenames but fail the
 * format check → "invalid" (re-transcribe recommended, never auto-repaired).
 * A list with NO usable reference-text lines (empty file, or every line lacks a
 * text column) counts as "none", NOT "invalid": there is simply no reference text
 * for this source — the same, honest state as an absent list. Only lists that DO
 * carry text but with stale/broken paths are "invalid". This prevents a leftover
 * empty list (e.g. a stale slicer_opt.list after the slice step is removed) from
 * permanently poisoning the aggregate reference-text light to red while the other
 * source (raw) still has perfectly valid text.
 * @returns {{status:'none'|'invalid'|'ok', present:boolean, total:number,
 *            modern:number, matched:number}}
 */
function inspectTranscriptList(voiceDir, sub, listName) {
  const listFile = path.join(voiceDir, "asr_opt", listName);
  if (!fs.existsSync(listFile)) return { status: "none", present: false, total: 0, modern: 0, matched: 0 };
  const srcDir = path.join(voiceDir, sub);
  const AUDIO = /\.(wav|mp3|flac|m4a|ogg)$/i;
  let audioSet = null;
  try { audioSet = new Set(fs.readdirSync(srcDir).filter(f => AUDIO.test(f))); }
  catch { audioSet = new Set(); }

  let total = 0, modern = 0, matched = 0;
  const expected = new RegExp(`^${sub}/[^/\\\\]+$`); // exactly "<sub>/<file>", no abs/drive/nesting
  try {
    for (const line of fs.readFileSync(listFile, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split("|");
      if (parts.length < 4) continue;
      const rawPath = parts[0].trim().replace(/\\/g, "/");
      const text = parts.slice(3).join("|").trim();
      if (!text) continue; // no reference text on this line
      total++;
      if (expected.test(rawPath)) modern++;
      if (audioSet.has(path.basename(rawPath))) matched++;
    }
  } catch { /* unreadable → treat as invalid below */ }

  // Empty / text-less list => no reference text for this source (treat as "none",
  // never a red "invalid"). This is the key fix for the stuck text-health light:
  // a leftover empty list must not permanently flag the asset as invalid.
  if (total === 0) return { status: "none", present: true, total: 0, modern: 0, matched: 0 };
  // Modern format on (nearly) every line AND audio present → ok. Otherwise invalid.
  const status = (modern === total && matched > 0) ? "ok" : "invalid";
  return { status, present: true, total, modern, matched };
}

/**
 * Parse 2-name2text.txt and return structured segments.
 * Format: filename\tphoneme\ttext
 * filename pattern: "交谈1.wav_0000000000_0000152640.wav"
 * => scene: "交谈1", index derived from order within scene
 */
/**
 * Resolve which transcript list + audio source a voice should use.
 * Slices take precedence when both a slicer_opt.list and slice .wav files exist;
 * otherwise raw (raw_opt.list + raw/). Returns null if no transcript exists.
 * @returns {{listFile, sourceKind:'slicer_opt'|'raw', srcDir}|null}
 */
function resolveTranscript(voiceDir) {
  const asrDir = path.join(voiceDir, "asr_opt");
  const slicesList = path.join(asrDir, "slicer_opt.list");
  const rawList = path.join(asrDir, "raw_opt.list");
  const slicesDir = path.join(voiceDir, "slicer_opt");
  const rawDir = path.join(voiceDir, "raw");
  const AUDIO = /\.(wav|mp3|flac|m4a|ogg)$/i;
  const dirHasAudio = (d) => {
    try { return fs.existsSync(d) && fs.readdirSync(d).some(f => AUDIO.test(f)); }
    catch { return false; }
  };
  // Prefer whichever list has its audio present; slices win over raw.
  if (fs.existsSync(slicesList) && dirHasAudio(slicesDir)) return { listFile: slicesList, sourceKind: "slicer_opt", srcDir: slicesDir };
  if (fs.existsSync(rawList) && dirHasAudio(rawDir)) return { listFile: rawList, sourceKind: "raw", srcDir: rawDir };
  // List present but its audio was deleted to save space — still report it.
  if (fs.existsSync(slicesList)) return { listFile: slicesList, sourceKind: "slicer_opt", srcDir: slicesDir };
  if (fs.existsSync(rawList)) return { listFile: rawList, sourceKind: "raw", srcDir: rawDir };
  return null;
}

/**
 * Source-aware segments builder (pure): parse the resolved transcript list and
 * match it against the actual audio files in srcDir. Does NOT write anything.
 * audio_path is APP_DIR-relative (assets/<id>/<sourceKind>/<file>) so the TTS
 * engine's resolveRefPath can locate it.
 */
function buildSegmentsFor(voiceDir, voiceId) {
  const t = resolveTranscript(voiceDir);
  if (!t) return null;
  const { listFile, sourceKind, srcDir } = t;
  const listEntries = parseSlicerOptList(fs.readFileSync(listFile, "utf-8"));

  const AUDIO = /\.(wav|mp3|flac|m4a|ogg)$/i;
  const dirExists = fs.existsSync(srcDir);
  const wavMap = {};
  if (dirExists) {
    for (const f of fs.readdirSync(srcDir)) { if (AUDIO.test(f)) wavMap[f] = f; }
  }
  const available = Object.keys(wavMap).length;
  if (!dirExists || available === 0) {
    const reason = !dirExists ? `${sourceKind}/ directory is missing` : `${sourceKind}/ contains no audio files`;
    console.warn(`[ASSETS] ${voiceId}: cannot rebuild segments — ${reason}.`);
    return {
      voice: voiceId, ok: false, source_kind: sourceKind,
      error: `No ${sourceKind} audio available (${reason}); regenerate the source audio before rebuilding segments.`,
      total: listEntries.length, matched: 0, missing: listEntries.length, segments: [],
    };
  }

  const segments = listEntries.map((e, i) => {
    const actualFile = wavMap[e.origName] || null;
    const isMatched = !!actualFile;
    const audioPath = isMatched ? `assets/${voiceId}/${sourceKind}/${actualFile}` : null;
    const dur = isMatched ? Math.round(getWavDuration(path.join(srcDir, actualFile)) * 100) / 100 : 0;
    return {
      scene: (actualFile || e.sliceFile).replace(/_\d{10}_\d{10}\.wav$/i, "").replace(/\.wav$/i, ""),
      index: i, text: e.text, phoneme: "",
      audio_filename: actualFile || e.sliceFile, audio_path: audioPath,
      duration: dur, matched: isMatched,
    };
  });
  const matched = segments.filter(s => s.matched).length;
  return {
    voice: voiceId, ok: true, source_kind: sourceKind,
    source_file: listFile.replace(/\\/g, "/"),
    generated_at: new Date().toISOString(),
    total: segments.length, matched, missing: segments.length - matched, segments,
  };
}

/**
 * Generate segments.json for a voice by parsing its transcript list
 * (slicer_opt.list or raw_opt.list) and matching to its audio files.
 */
function generateSegments(voiceId) {
  const voiceDir = path.join(ASSETS_DIR, voiceId);
  const metaPath = path.join(voiceDir, "meta.json");
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf-8")) : null;

  const segmentsData = buildSegmentsFor(voiceDir, voiceId);
  if (!segmentsData) {
    console.log(`[ASSETS] No transcript list (raw_opt/slicer_opt) found for ${voiceId}`);
    return null;
  }
  if (segmentsData.ok === false) return segmentsData;

  const segmentsFile = path.join(voiceDir, "segments.json");
  atomicWriteFile(segmentsFile, JSON.stringify(segmentsData, null, 2));
  console.log(`[ASSETS] Generated segments.json for ${voiceId} (${segmentsData.source_kind}): ${segmentsData.total} entries (${segmentsData.matched} matched, ${segmentsData.missing} missing)`);

  if (meta) {
    meta.segment_total = segmentsData.matched;
    meta.segment_matched = segmentsData.matched;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  return segmentsData;
}

/**
 * Full scan of all voice assets.
 */
function fullScan() {
  console.log("[ASSETS] Starting full scan...");
  const results = {};

  // Scan internal assets
  const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const voiceDir = path.join(ASSETS_DIR, e.name);

    // Per-voice error isolation (Bug D): a single corrupt/locked voice dir must
    // not abort the whole scan. Record the error and continue.
    try {
      const meta = scanVoiceDir(e.name, voiceDir);

      // Regenerate segments.json and backfill its counts into the in-memory
      // result so the API response matches what is written to disk (Bug A).
      // Previously generateSegments only updated the on-disk meta, leaving the
      // returned object without segment_total → frontend saw "No Segments" for
      // every voice until a manual refresh.
      const segResult = generateSegments(e.name);
      if (segResult && typeof segResult.matched === "number") {
        meta.segment_total = segResult.matched;
        meta.segment_matched = segResult.matched;
      }

      // Persist the corrected meta (display_name/language preserved by
      // scanVoiceDir, assets + segment_total refreshed here).
      try {
        const metaPath = path.join(voiceDir, "meta.json");
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      } catch (e2) { /* non-blocking */ }

      results[e.name] = meta;
    } catch (voiceErr) {
      console.error(`[ASSETS] Scan failed for voice '${e.name}':`, voiceErr.message);
      results[e.name] = { id: e.name, display_name: e.name, _scanError: voiceErr.message };
    }
  }

  console.log(`[ASSETS] Scan complete. Found ${Object.keys(results).length} voices.`);
  return results;
}

/**
 * Parse slicer_opt.list file.
 * Format: "output\slicer_opt\filename.wav_0000..._0000...wav|slicer_opt|lang|text"
 * Returns: [{ sliceFile, origName, speaker, lang, text }]
 */
function parseSlicerOptList(content) {
  const entries = [];
  const lines = content.split("\n").map(l => l.trim()).filter(l => l);
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const sliceFile = parts[0].trim();
    const speaker = parts[1].trim();
    const lang = parts[2].trim();
    const text = parts[3].trim();
    if (!text) continue;
    const basename = path.basename(sliceFile);
    // Keep the full filename as-is for exact matching later
    entries.push({ sliceFile: basename, origName: basename, speaker, lang, text });
  }
  return entries;
}

/**
 * Import voice assets from a GPT-SoVITS output directory using slicer_opt.list.
 * Reads the list file, copies/symlinks raw audio and slices into the assets directory,
 * and generates segments.json.
 *
 * @param {string} voiceId - voice ID (e.g. "platinum")
 * @param {string} gsvBase - GPT-SoVITS root directory
 * @param {object} opts - { rawSrc, slicesSrc, listSrc } optional overrides
 */
function importFromList(voiceId, gsvBase, opts = {}) {
  const voiceDir = path.join(ASSETS_DIR, voiceId);
  if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });

  // Find slicer_opt.list for text mapping
  const listSrc = opts.listSrc || path.join(voiceDir, "asr_opt", "slicer_opt.list");

  // Parse text mapping from slicer_opt.list
  let textMap = {};  // { filename → text }
  if (fs.existsSync(listSrc)) {
    const listContent = fs.readFileSync(listSrc, "utf-8");
    const listEntries = parseSlicerOptList(listContent);
    for (const e of listEntries) {
      textMap[e.sliceFile] = e.text;
    }
    console.log(`[ASSETS] Using slicer_opt.list: ${Object.keys(textMap).length} entries`);
  } else {
    // Fallback: try GPT-SoVITS engine's slicer_opt.list
    const gsvListSrc = path.join(gsvBase, "output", "asr_opt", "slicer_opt.list");
    if (fs.existsSync(gsvListSrc)) {
      const listContent = fs.readFileSync(gsvListSrc, "utf-8");
      const listEntries = parseSlicerOptList(listContent);
      for (const e of listEntries) {
        textMap[e.sliceFile] = e.text;
      }
      // Copy list to assets, rewriting paths
      const newListPath = path.join(voiceDir, "asr_opt", "slicer_opt.list");
      fs.mkdirSync(path.dirname(newListPath), { recursive: true });
      const rewrittenLines = listContent.split("\n").map(line => {
        if (!line.trim()) return line;
        const parts = line.split("|");
        if (parts.length < 4) return line;
        const filename = path.basename(parts[0].trim());
        parts[0] = `assets/${voiceId}/slicer_opt/${filename}`;
        return parts.join("|");
      });
      fs.writeFileSync(newListPath, rewrittenLines.join("\n"), "utf-8");
      console.log(`[ASSETS] Using GPT-SoVITS slicer_opt.list: ${Object.keys(textMap).length} entries (paths rewritten)`);
    } else {
      throw new Error(`No slicer_opt.list found for ${voiceId}`);
    }
  }

  // Determine source directories
  const rawSrc = opts.rawSrc || path.join(GSV_PATHS.noSlice);
  const slicesSrc = opts.slicesSrc || path.join(gsvBase, "output", "slicer_opt");

  // Create asset subdirectories
  const rawDir = path.join(voiceDir, "raw");
  const slicesDir = path.join(voiceDir, "slicer_opt");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(slicesDir, { recursive: true });

  // Scan actual slicer_opt files and copy
  let importedRaw = 0;
  let importedSlices = 0;

  if (fs.existsSync(slicesSrc)) {
    const srcFiles = fs.readdirSync(slicesSrc).filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f));
    for (const f of srcFiles) {
      // Only copy files that belong to this voice (by textMap lookup)
      const origKey = f.replace(/_\d{10}_\d{10}\.wav$/i, ".wav");
      if (!textMap[f] && !textMap[origKey]) continue;

      const srcFile = path.join(slicesSrc, f);
      const dstFile = path.join(slicesDir, f);
      if (!fs.existsSync(dstFile)) {
        fs.copyFileSync(srcFile, dstFile);
        importedSlices++;
      }

      // Copy corresponding raw audio (derive raw name from slice filename)
      const rawName = f.replace(/_\d{10}_\d{10}\.wav$/i, ".wav");
      const rawSrcFile = path.join(rawSrc, rawName);
      const rawDstFile = path.join(rawDir, rawName);
      if (fs.existsSync(rawSrcFile) && !fs.existsSync(rawDstFile)) {
        fs.copyFileSync(rawSrcFile, rawDstFile);
        importedRaw++;
      }
    }
  }

  // Note: GPT/SoVITS model copying is not handled here.
  // Users should place model files manually in gpt_checkpoints/ and sovits_models/.

  // Generate segments.json from actual files + textMap
  const copiedSlices = fs.existsSync(slicesDir) ? fs.readdirSync(slicesDir).filter(f => f.endsWith(".wav")) : [];
  const segmentsArr = copiedSlices.map((f, i) => {
      const origKey = f.replace(/_\d{10}_\d{10}\.wav$/i, ".wav").replace(/\.wav\.wav$/i, ".wav");
      const text = textMap[origKey] || textMap[f] || "";
      const slicePath = path.join(slicesDir, f).replace(/\\/g, "/");
      const dur = Math.round(getWavDuration(path.join(slicesDir, f)) * 100) / 100;
      return {
        scene: f.split(".")[0].replace(/_\d+$/, ""),
        index: i,
        text,
        phoneme: "",
        audio_filename: f,
        audio_path: slicePath,
        duration: dur,
        matched: !!text,
      };
    });
  const segmentsData = {
    voice: voiceId,
    source_file: listSrc.replace(/\\/g, "/"),
    generated_at: new Date().toISOString(),
    total: copiedSlices.length,
    matched: segmentsArr.filter(s => s.matched).length,
    segments: segmentsArr,
  };
  const segFile = path.join(voiceDir, "segments.json");
  atomicWriteFile(segFile, JSON.stringify(segmentsData, null, 2));

  // Build meta.json using scanVoiceDir for consistent schema
  const publishDir = path.dirname(voiceDir);  // assets/
  const tempVoiceId = `_import_${voiceId}`;
  const tempDir = path.join(publishDir, tempVoiceId);
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'segments.json'), JSON.stringify(segmentsData, null, 2));
  const sliceFiles2 = fs.existsSync(slicesDir) ? fs.readdirSync(slicesDir).filter(f => f.endsWith('.wav')) : [];
  const tempSlicesDir = path.join(tempDir, 'slicer_opt');
  fs.mkdirSync(tempSlicesDir, { recursive: true });
  for (const f of sliceFiles2) { fs.copyFileSync(path.join(slicesDir, f), path.join(tempSlicesDir, f)); }
  const tempRawDir = path.join(tempDir, 'raw');
  fs.mkdirSync(tempRawDir, { recursive: true });
  if (fs.existsSync(rawDir)) { for (const f of fs.readdirSync(rawDir)) { fs.copyFileSync(path.join(rawDir, f), path.join(tempRawDir, f)); } }
  const fresh = scanVoiceDir(tempVoiceId, tempDir);
  const meta = { ...fresh, id: voiceId, display_name: voiceId, mode: 'internal', language: 'ja', prompt_lang: 'ja', text_lang: 'ja', created_at: new Date().toISOString() };
  atomicWriteFile(path.join(voiceDir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(`[ASSETS] Imported ${voiceId}: ${importedRaw} raw, ${importedSlices} slices, ${segmentsData.total} segments`);
  return { importedRaw, importedSlices, segments: segmentsData.total, meta };
}

/**
 * Inspect a voice directory and return the boolean presence of each asset
 * artifact used by the rebuild planner.
 *   R   = raw audio present
 *   S   = slices present (slicer_opt/*.wav)
 *   L   = ASR transcript list present (asr_opt/slicer_opt.list)
 *   Seg = usable segments present (segments.json matched > 0)
 *   M   = both GPT and SoVITS models present
 */
function detectAssetState(voiceId) {
  const voiceDir = path.join(ASSETS_DIR, voiceId);
  const countWav = (dir) => {
    try { return fs.readdirSync(dir).filter(f => /\.wav$/i.test(f)).length; }
    catch { return 0; }
  };
  const hasFiles = (dir, re) => {
    try { return fs.readdirSync(dir).some(f => re.test(f)); }
    catch { return false; }
  };

  const R = countWav(path.join(voiceDir, "raw")) > 0
            || hasFiles(path.join(voiceDir, "raw"), /\.(wav|mp3|flac|m4a|ogg)$/i);
  const S = countWav(path.join(voiceDir, "slicer_opt")) > 0;
  const Ls = fs.existsSync(path.join(voiceDir, "asr_opt", "slicer_opt.list"));
  const Lr = fs.existsSync(path.join(voiceDir, "asr_opt", "raw_opt.list"));
  const L = Ls || Lr;
  let Seg = false;
  try {
    const segPath = path.join(voiceDir, "segments.json");
    if (fs.existsSync(segPath)) {
      const data = JSON.parse(fs.readFileSync(segPath, "utf-8"));
      Seg = (data.matched || 0) > 0;
    }
  } catch { Seg = false; }
  const Mg = hasFiles(path.join(voiceDir, "gpt_checkpoints"), /\.ckpt$/i);
  const Ms = hasFiles(path.join(voiceDir, "sovits_models"), /\.pth$/i);
  const M = Mg && Ms;

  return { R, S, L, Ls, Lr, Seg, M, Mg, Ms };
}

/**
 * Dependency-graph-driven repair planner. Returns the SHORTEST set of stages
 * needed to fill missing artifacts, reusing whatever already exists. It only
 * produces a plan — it does NOT execute anything.
 *
 * Hard rules:
 *  - segments and models are independent branches off {slices, list};
 *    rebuilding segments must never trigger training.
 *  - training is high-cost: in "safe" mode it is not scheduled (caller must
 *    confirm / pass mode "full").
 *
 * @param {{R,S,L,Seg,M}} state
 * @param {{mode?: "safe"|"full"|"emergency"}} options
 * @returns {{stages?:string[], stepOptions?:object, warnings:string[],
 *            requires_confirmation?:boolean, error?:string, noop?:string,
 *            health?:string}}
 */
function planRebuild(state, options = {}) {
  const { R, S, L, Seg, M } = state;
  const Ls = state.Ls ?? L; // slicer_opt.list present
  const Lr = state.Lr ?? false; // raw_opt.list present
  const Mg = state.Mg ?? M; // GPT (S1) weights present
  const Ms = state.Ms ?? M; // SoVITS (S2) weights present
  const mode = options.mode || "safe";
  const reslice = !!options.reslice; // force REAL slicing even when not retraining
  const skipAsr = !!options.skipAsr; // user opts out of transcription (reference-text-free)
  const stages = [];
  const warnings = [];

  // 0) No usable source material at all → dead end (no audio to reference).
  if (!R && !S) {
    return { error: "No raw or slices available; re-import audio required", health: "No Refs", warnings };
  }

  // Decide the model branch first — whether we retrain affects whether slices
  // must be REAL slices (training wants clean cut clips) vs raw passthrough.
  // Per-model retrain flags. S1 (GPT) and S2 (SoVITS) are independent steps, so we
  // only retrain the model(s) that are actually missing — or whatever the caller
  // explicitly requests (options.trainS1 / options.trainS2, from the restore modal).
  const wantS1 = options.trainS1; // true | false | undefined(=auto)
  const wantS2 = options.trainS2;
  const anyExplicit = wantS1 !== undefined || wantS2 !== undefined;

  let trainS1 = false;        // run S1 (GPT) training
  let trainS2 = false;        // run S2 (SoVITS) training
  let usePretrained = false;  // emergency placeholder
  let modelsDeferred = false; // safe mode: do not auto-train
  if (!M || anyExplicit) {
    if (mode === "safe" && !anyExplicit) {
      modelsDeferred = true;
      warnings.push("Models missing; training is NOT scheduled in safe mode. Re-run with mode 'full' to retrain.");
    } else if (mode === "emergency") {
      usePretrained = true;
      warnings.push("Using a generic pretrained base model; output quality may be noticeably lower.");
    } else if (mode === "full" || anyExplicit) {
      // Default: retrain only the missing model(s); explicit flags override.
      trainS1 = wantS1 !== undefined ? !!wantS1 : !Mg;
      trainS2 = wantS2 !== undefined ? !!wantS2 : !Ms;
      if (!trainS1 && !trainS2 && !M) {
        warnings.push("No training selected but models are still missing; asset will remain incomplete.");
      }
    } else {
      return { error: `Unsupported repair mode: ${mode}`, warnings };
    }
  }
  const needTrain = trainS1 || trainS2;

  // 1) Slices — two states: skip (already present or not needed) / slice (real).
  //    Passthrough is gone: if we don't slice, raw itself is the reference source.
  //    We only slice when slices are missing AND we must train (training wants clean
  //    cut clips) or the caller explicitly opts into reslicing.
  let sliceMode = null; // 'slice' | null
  if (!S && (needTrain || reslice)) {
    if (!R) return { error: "Missing slices and no raw available; cannot slice", health: "No Refs", warnings };
    sliceMode = "slice";
    stages.push("slice");
  }

  // Which audio source will this asset use downstream? Slices win when they exist or
  // will be produced; otherwise raw is the source. This selects the relevant list.
  const willHaveSlices = S || sliceMode === "slice";
  const relevantList = willHaveSlices ? Ls : Lr;

  // 2) Transcript list — run ASR if the relevant list is missing OR we just (re)sliced
  //    (the old list no longer matches the new clips). The user may opt out (skipAsr)
  //    to keep a reference-text-free asset, but training always needs a matching
  //    transcript so ASR stays forced when retraining.
  const asrForced = needTrain && (!relevantList || !!sliceMode);
  let runAsr = (!relevantList || !!sliceMode);
  if (skipAsr && !asrForced) {
    runAsr = false;
    if (sliceMode) {
      warnings.push("ASR skipped: rebuilt clips will have no transcript (reference-text-free).");
    } else if (!relevantList) {
      warnings.push("ASR skipped: no transcript will be generated (reference-text-free).");
    }
  }
  if (runAsr && !stages.includes("asr")) stages.push("asr");

  // 3) Segments (derived). The ASR step regenerates segments itself; only schedule a
  //    standalone generateSegments when ASR is NOT running (source audio + its list
  //    already present, just segments missing). Without a transcript there is nothing
  //    to match text against, so skip it entirely in reference-text-free runs.
  const asrInPlan = stages.includes("asr");
  if (!Seg && !asrInPlan && relevantList) stages.push("generateSegments");

  // 4) Model branch. preprocess feeds both S1 and S2; each model trains independently.
  if (needTrain) stages.push("preprocess");
  if (trainS1) stages.push("train_s1");
  if (trainS2) stages.push("train_s2");
  if (usePretrained) stages.push("use_pretrained_base");

  if (stages.length === 0) {
    // Models intentionally deferred in safe mode: not a no-op — still missing models.
    if (modelsDeferred) {
      return {
        health: "Missing Models",
        repairable: true,
        requires_confirmation: true,
        suggested_mode: "full",
        suggested_stages: ["preprocess", ...(!Mg ? ["train_s1"] : []), ...(!Ms ? ["train_s2"] : [])],
        warnings,
      };
    }
    return { noop: "already complete", health: "Complete", warnings };
  }

  // Map to pipeline stepOptions. generateSegments + use_pretrained_base are handled
  // outside the pipeline. Any data-producing pipeline step (slice/asr/preprocess/
  // train) MUST be followed by finalize+promote to land changes in assets/<id>;
  // finalize carries forward whatever wasn't regenerated, so models/slices survive.
  const pipelineDataStages = stages.filter(s => ["slice", "asr", "preprocess", "train_s1", "train_s2"].includes(s));
  const stepOptions = pipelineDataStages.length === 0 ? null : {
    denoise: false,
    slice: stages.includes("slice"),
    asr: stages.includes("asr"),
    preprocess: stages.includes("preprocess"),
    train_s1: stages.includes("train_s1"),
    train_s2: stages.includes("train_s2"),
    finalize: true,
    promote: true,
  };

  return {
    stages,
    stepOptions,
    slice_mode: sliceMode,
    needs_segments: stages.includes("generateSegments"),
    uses_pretrained_base: stages.includes("use_pretrained_base"),
    requires_confirmation: stages.includes("train_s1") || stages.includes("train_s2"),
    warnings,
  };
}

module.exports = {
  ASSETS_DIR,
  GSV_BASE,
  GSV_PATHS,
  listVoiceAssets,
  scanVoiceDir,
  generateSegments,
  parseSlicerOptList,
  importFromList,  // @deprecated — kept for backward compat, training pipeline now uses promote → scanVoiceDir
  fullScan,
  detectAssetState,
  planRebuild,
  getWavDuration,
  getAudioDuration,
  sniffAudioFormat,
  getFlacDuration,
  getMp3Duration,
  getMp4Duration,
  getOggDuration,
  formatSize,
};

// If run directly, do a full scan
if (require.main === module) {
  fullScan();
}
