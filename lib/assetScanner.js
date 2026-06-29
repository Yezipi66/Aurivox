// lib/assetScanner.js
// Scans GPT-SoVITS directory structure and generates meta.json for voice assets

const fs = require("fs");
const path = require("path");
const { ASSETS_ROOT } = require('./paths');

const ASSETS_DIR = ASSETS_ROOT;

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
    if (!sampleRate || !bitsPerSample) return 0;
    const dataSize = buf.readUInt32LE(dataOffset - 4);
    return dataSize / (sampleRate * channels * (bitsPerSample / 8));
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
 * Scan a single voice directory and build meta.json.
 */
function scanVoiceDir(voiceId, voiceDir) {
  const meta = {
    id: voiceId,
    display_name: voiceId,
    mode: "internal",
    language: "ja",
    prompt_lang: "ja",
    text_lang: "ja",
    created_at: new Date().toISOString(),
    assets: {},
  };

  // 扫描 _publish/ 目录结构（唯一入库来源）
  // 不再自动从 GSV 输出目录导入 —— 训练流程通过 promote 步骤写入

  // --- raw/ ---
  const rawDir = path.join(voiceDir, "raw");
  if (fs.existsSync(rawDir)) {
    const files = fs.readdirSync(rawDir).filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f));
    let totalDur = 0;
    for (const f of files) {
      totalDur += getWavDuration(path.join(rawDir, f));
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
    // Auto-generate segments.json if slicer_opt/ exists but segments.json doesn't
    if (!fs.existsSync(segmentsFile) && fs.existsSync(slicesDir)) {
      const listFile = path.join(voiceDir, "asr_opt", "slicer_opt.list");
      if (fs.existsSync(listFile)) {
        try {
          // generateSegments reads from ASSETS_DIR, so we call it with the
          // voiceDir's parent as a hint — but generateSegments uses ASSETS_DIR
          // internally. Instead, we inline a lightweight segment generation here.
          const listContent = fs.readFileSync(listFile, "utf-8");
          const listEntries = parseSlicerOptList(listContent);
          const wavMap = {};
          for (const f of fs.readdirSync(slicesDir)) {
            if (!f.endsWith(".wav")) continue;
            wavMap[f] = f;
          }
          const segs = listEntries.map((e, i) => {
            const actualFile = wavMap[e.origName] || null;
            const isMatched = !!actualFile;
            const audioPath = isMatched
              ? `assets/${voiceId}/slicer_opt/${actualFile}`
              : null;
            const dur = isMatched
              ? Math.round(getWavDuration(path.join(slicesDir, actualFile)) * 100) / 100
              : 0;
            return {
              scene: (actualFile || e.sliceFile).replace(/_\d{10}_\d{10}\.wav$/i, "").replace(/\.wav$/i, ""),
              index: i,
              text: e.text,
              phoneme: "",
              audio_filename: actualFile || e.sliceFile,
              audio_path: audioPath,
              duration: dur,
              matched: isMatched,
            };
          });
          const segData = {
            voice: voiceId,
            source_file: listFile.replace(/\\/g, "/"),
            generated_at: new Date().toISOString(),
            total: segs.filter(s => s.matched).length,
            matched: segs.filter(s => s.matched).length,
            segments: segs,
          };
          atomicWriteFile(segmentsFile, JSON.stringify(segData, null, 2));
          meta.segment_total = segData.total;
          meta.segment_matched = segData.matched;
          meta.assets.slices.segments_file = segmentsFile.replace(/\\/g, "/");
        } catch (segErr) {
          console.error(`[ASSETS] Auto-generate segments failed for ${voiceId}:`, segErr.message);
        }
      }
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
    const files = fs.readdirSync(sovitsDir).filter(f => /\.pth$/i.test(f));
    meta.assets.checkpoints = meta.assets.checkpoints || {};
    meta.assets.checkpoints.sovits = files.map(f => {
      const stat = fs.statSync(path.join(sovitsDir, f));
      return {
        name: f,
        path: path.join(sovitsDir, f).replace(/\\/g, "/"),
        size_mb: Math.round(stat.size / (1024 * 1024)),
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

  return meta;
}

/**
 * Parse 2-name2text.txt and return structured segments.
 * Format: filename\tphoneme\ttext
 * filename pattern: "交谈1.wav_0000000000_0000152640.wav"
 * => scene: "交谈1", index derived from order within scene
 */
/**
 * Generate segments.json for a voice by parsing its slicer_opt.list
 * and matching to slicer_opt wav files.
 */
function generateSegments(voiceId) {
  const voiceDir = path.join(ASSETS_DIR, voiceId);
  const metaPath = path.join(voiceDir, "meta.json");
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf-8")) : null;

  // Only source of text mapping: slicer_opt.list in our own assets directory
  const listFile = path.join(voiceDir, "asr_opt", "slicer_opt.list");
  if (!fs.existsSync(listFile)) {
    console.log(`[ASSETS] No slicer_opt.list found for ${voiceId}`);
    return null;
  }

  const listContent = fs.readFileSync(listFile, "utf-8");
  const listEntries = parseSlicerOptList(listContent);
  const slicesDir = path.join(voiceDir, "slicer_opt");

  // Build a map: exact filename -> filename from slicer_opt directory
  const wavMap = {};
  if (fs.existsSync(slicesDir)) {
    for (const f of fs.readdirSync(slicesDir)) {
      if (!f.endsWith(".wav")) continue;
      wavMap[f] = f;
    }
  }

  const segments = listEntries.map((e, i) => {
    const actualFile = wavMap[e.origName] || null;
    const isMatched = !!actualFile;
    const audioPath = isMatched
      ? `assets/${voiceId}/slicer_opt/${actualFile}`
      : null;
    const dur = isMatched
      ? Math.round(getWavDuration(path.join(slicesDir, actualFile)) * 100) / 100
      : 0;
    return {
      scene: (actualFile || e.sliceFile).replace(/_\d{10}_\d{10}\.wav$/i, "").replace(/\.wav$/i, ""),
      index: i,
      text: e.text,
      phoneme: "",
      audio_filename: actualFile || e.sliceFile,
      audio_path: audioPath,
      duration: dur,
      matched: isMatched,
    };
  });

  // Save segments.json atomically
  const segmentsFile = path.join(voiceDir, "segments.json");
  const matchedSegments = segments.filter(s => s.matched);
  const segmentsData = {
    voice: voiceId,
    source_file: listFile.replace(/\\/g, "/"),
    generated_at: new Date().toISOString(),
    total: matchedSegments.length,
    matched: matchedSegments.length,
    segments,
  };
  atomicWriteFile(segmentsFile, JSON.stringify(segmentsData, null, 2));
  console.log(`[ASSETS] Generated segments.json for ${voiceId}: ${segments.length} segments (${segmentsData.matched} matched)`);

  // Update meta.json with segment summary only
  if (meta) {
    meta.segment_total = matchedSegments.length;
    meta.segment_matched = matchedSegments.length;
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
    const meta = scanVoiceDir(e.name, voiceDir);
    results[e.name] = meta;
    // Regenerate segments.json atomically via generateSegments
    generateSegments(e.name);
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
  getWavDuration,
  formatSize,
};

// If run directly, do a full scan
if (require.main === module) {
  fullScan();
}
