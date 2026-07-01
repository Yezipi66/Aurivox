const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const http = require("http");
const { execSync, spawn } = require("child_process");
const multer = require("multer");

const { ASSETS_ROOT, ASSETS_ROOT_SOURCE, CONFIG_FILE, readConfig, writeConfig } = require('./lib/paths');

const app = express();
// Environment-driven config with backward-compatible defaults
const PORT = parseInt(process.env.BROKER_PORT || process.env.PORT || "9886", 10);
const HOST = process.env.BROKER_HOST || process.env.HOST || "127.0.0.1";
const API_KEY = process.env.API_KEY || process.env.BROKER_API_KEY || "";
const GPT_SOVITS_BASE_URL = process.env.GPT_SOVITS_BASE_URL || "http://127.0.0.1:9880";

const APP_DIR = __dirname;
const VOICES_JSON = path.join(APP_DIR, "voices.json");
const OUTPUT_DIR = path.join(APP_DIR, "outputs");
const VOICES_DIR = path.join(APP_DIR, "voices");
const BACKUP_DIR = path.join(APP_DIR, "backups");
const WEB_DIST = path.join(APP_DIR, "web", "dist");
const ASSETS_DIR = ASSETS_ROOT;

for (const d of [OUTPUT_DIR, VOICES_DIR, BACKUP_DIR, ASSETS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Asset scanner
const assetScanner = require("./lib/assetScanner");

// ---- Multer ----
const ALLOWED_EXT = new Set([".wav", ".mp3", ".flac", ".m4a", ".ogg", ".webm"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VOICES_DIR),
  filename: (req, file, cb) => {
    const id = req.params.id;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}`));
  },
});

const crypto = require("crypto");

function isLoopback(req) {
  const ip = req.ip || req.connection?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function validateHost(req, res, next) {
  const host = req.headers.host || "";
  const hostname = host.split(":")[0];
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && !isLoopback(req)) {
    return res.status(403).json({ error: "Forbidden: Invalid Host header" });
  }
  next();
}

const REQUIRE_KEY_FOR_DESTRUCTIVE = process.env.REQUIRE_KEY_FOR_DESTRUCTIVE === "1";

function requireApiKey(req, res, next) {
  // Local workstation (training/inference/asset management) — always allow loopback, never need key.
  // Only external (distribution) calls require key.
  if (isLoopback(req) && !REQUIRE_KEY_FOR_DESTRUCTIVE) {
    return next();
  }
  if (!API_KEY) {
    return res.status(401).json({ error: "API_KEY not configured for remote access." });
  }
  
  // Support both 'x-api-key' and 'Authorization: Bearer ***'
  let key = req.headers["x-api-key"] || "";
  const authHeader = req.headers["authorization"] || "";
  if (!key && authHeader.startsWith("Bearer ")) {
    key = authHeader.slice(7).trim();
  }

  // Timing-safe comparison to prevent side-channel attacks
  const a = Buffer.from(key);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * Sanitize error for client response.
 * Logs the full error server-side; returns a safe generic message to the client.
 * @param {Error|string} err - The error object or message
 * @param {string} [fallback] - Optional context about what failed (e.g. "voices.json error")
 */
function clientError(err, fallback) {
  if (fallback === undefined) fallback = "Internal server error";
  // Always log full error server-side
  const errMsg = (err && err.message) || (err && err.toString()) || String(err);
  console.error("[clientError]", errMsg, err && err.stack ? "\n" + err.stack : "");
  // Return only the generic fallback to the client — never raw error details
  return fallback;
}

// Like clientError but RETURNS THE REAL MESSAGE to the client. Use only for
// local-workbench management endpoints (loopback-only: rename, config, fs browse)
// where a meaningful message ("folder locked by X", "path not writable") is
// essential for the user to act — the generic mask makes those unusable.
function localError(err) {
  const errMsg = (err && err.message) || (err && err.toString()) || String(err);
  console.error("[localError]", errMsg, err && err.stack ? "\n" + err.stack : "");
  return errMsg;
}

// In-memory store of background assets-directory copy/move jobs, keyed by jobId.
// Ephemeral by design: a server restart drops them (the UI degrades to a "job no
// longer available" message), which is fine for a local single-user tool.
const migrationJobs = new Map();

// Recursively verify that every file under `src` exists under `dst` with an
// identical byte size (integrity check for the copy→verify→delete move flow).
// Returns the first relative path that is missing or size-mismatched, or null
// when the trees match. Size comparison avoids hashing huge model files while
// still catching truncated/incomplete copies.
async function firstMismatch(src, dst, rel = "") {
  let sStat;
  try { sStat = await fsp.lstat(src); } catch (e) { return rel || src; }
  let dStat;
  try { dStat = await fsp.lstat(dst); } catch (e) { return rel || path.basename(src); }
  if (sStat.isDirectory()) {
    if (!dStat.isDirectory()) return rel || path.basename(src);
    const entries = await fsp.readdir(src);
    for (const name of entries) {
      const bad = await firstMismatch(path.join(src, name), path.join(dst, name), rel ? `${rel}/${name}` : name);
      if (bad) return bad;
    }
    return null;
  }
  // regular file (or symlink): sizes must match
  if (sStat.size !== dStat.size) return rel || path.basename(src);
  return null;
}

// 从 checkpoint 列表里挑"训练量最大"的那个（避免字母序选到 e5/e4 这种最弱模型）
function pickBestCkpt(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const score = (item) => {
    if (typeof item.steps === 'number') return item.steps;           // GPT: assetScanner 已解析
    const name = item.name || item.path || '';
    const s = name.match(/_s(\d+)/);   if (s) return parseInt(s[1], 10);  // SoVITS: _s288
    const e = name.match(/[-_]e(\d+)/); if (e) return parseInt(e[1], 10);  // 退而用 epoch
    return 0;
  };
  return list.slice().sort((a, b) => score(a) - score(b)).pop();
}

app.use(cors({ origin: "http://127.0.0.1:5173" }));
app.use(express.json({ limit: "10mb" }));
app.use(validateHost);


// ---- Static: assets/ for audio playback ----
app.use("/assets", (req, res, next) => {
  const rel = decodeURIComponent(req.path).replace(/^[\/]+/, "").replace(/\.\.[\\/]/g, "");
  const decoded = path.join(ASSETS_DIR, rel);
  if (!decoded.startsWith(ASSETS_DIR + path.sep) && decoded !== ASSETS_DIR) {
    return res.status(404).end();
  }
  express.static(ASSETS_DIR)(req, res, next);
});

// ---- Static: outputs/ with Range support ----
app.use("/outputs", (req, res, next) => {
  const rel = decodeURIComponent(req.path).replace(/^[\/]+/, "").replace(/\.\.[\\/]/g, "");
  const filePath = path.join(OUTPUT_DIR, rel);
  if (!filePath.startsWith(OUTPUT_DIR + path.sep) && filePath !== OUTPUT_DIR) {
    return res.status(404).end();
  }
  if (!fs.existsSync(filePath)) return next();
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;
    if (start >= stat.size || end >= stat.size) {
      res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
      return;
    }
    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "audio/wav",
    });
    stream.pipe(res);
  } else {
    next();
  }
}, express.static(OUTPUT_DIR));

// ===========================
//  HELPERS
// ===========================

function loadVoices() {
  try { return JSON.parse(fs.readFileSync(VOICES_JSON, "utf-8")); }
  catch (e) { return {}; }
}

function saveVoices(data) {
  fs.writeFileSync(VOICES_JSON, JSON.stringify(data, null, 2), "utf-8");
}

// Simple mutex to prevent concurrent writes to voices.json
let _voicesLock = Promise.resolve();
async function withVoicesLock(fn) {
  const prev = _voicesLock;
  let resolve;
  _voicesLock = new Promise(r => { resolve = r; });
  await prev;
  try { return await fn(); }
  finally { resolve(); }
}

// Simple mutex to prevent concurrent generation requests
let _generationLock = Promise.resolve();
async function withGenerationLock(fn) {
  const prev = _generationLock;
  let resolve;
  _generationLock = new Promise(r => { resolve = r; });
  await prev;
  try { return await fn(); }
  finally { resolve(); }
}

const MAX_BACKUPS = 20;

/**
 * Internal backup logic. 
 * ASSUMPTION: Caller already holds withVoicesLock.
 */
async function _backupVoicesUnlocked() {
  if (!fs.existsSync(VOICES_JSON)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const name = `voices.${ts}.json`;
  const dest = path.join(BACKUP_DIR, name);
  fs.copyFileSync(VOICES_JSON, dest);
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.match(/^voices\.\d{15}\.json$/))
      .sort();
    while (files.length > MAX_BACKUPS) {
      const old = files.shift();
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    }
  } catch {}
  return name;
}

async function backupVoices() {
  return withVoicesLock(async () => {
    return await _backupVoicesUnlocked();
  });
}

// ===========================
//  HTTP HELPERS
// ===========================

function gsvRequest(method, pathStr, payload, reqTimeout = 300000) {
  return new Promise((resolve, reject) => {
    let url;
    const headers = {};
    let body = null;
    if (method === "GET" && payload) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(payload)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      url = new URL(`${GPT_SOVITS_BASE_URL}${pathStr}?${params.toString()}`);
    } else {
      url = new URL(`${GPT_SOVITS_BASE_URL}${pathStr}`);
      if (payload) {
        body = JSON.stringify(payload);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(body);
      }
    }
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method, headers,
      timeout: reqTimeout || 300000,
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}

function gsvPost(pathStr, payload) { return gsvRequest("POST", pathStr, payload); }
function gsvGet(pathStr, params) { return gsvRequest("GET", pathStr, params); }

function resolveRefPath(raw) {
  if (!raw) return "";
  if (raw.includes(":\\") || raw.startsWith("/")) return raw;
  return path.join(APP_DIR, raw).replace(/\\/g, "/");
}

function safeId(id) { return /^[a-zA-Z0-9_-]+$/.test(id); }

function isPlaceholder(text) {
  if (!text) return true;
  const s = text.toLowerCase();
  return (
    s.includes("这里填写") || s.includes("todo") || s.includes("placeholder") ||
    s.includes("参照音声") || s.includes("reference") || s.includes("完全一致")
  );
}

// ===========================
//  JAPANESE TEXT SPLITTER
// ===========================
//
// Strategy: length-first with punctuation as preferred break points.
//
// 1. Accumulate sentences (split by sentence-ending punctuation).
// 2. Greedily pack sentences into segments up to softLimit chars.
//    When adding the next sentence would exceed softLimit, close the
//    current segment and start a new one.
// 3. If a single sentence exceeds hardLimit, force-split it at
//    soft-punctuation (、，) boundaries, or by character count as
//    last resort.
//
// This ensures segments are naturally bounded by sentence boundaries
// while staying within the target length.

function splitJapaneseText(text, options = {}) {
  const { softLimit = 30, hardLimit = 60 } = options;
  if (!text || !text.trim()) return [];

  // Normalize
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // Split into sentences by sentence-ending punctuation.
  // Keep the punctuation attached to the sentence it ends.
  const sentenceRegex = /[^。！？…♪!?]*[。！？…♪!?]+/g;
  const sentences = [];
  let match;
  let lastIndex = 0;

  while ((match = sentenceRegex.exec(normalized)) !== null) {
    sentences.push(match[0]);
    lastIndex = sentenceRegex.lastIndex;
  }
  // Capture any remaining text after the last sentence-ending punctuation
  if (lastIndex < normalized.length) {
    const remaining = normalized.slice(lastIndex).trim();
    if (remaining) sentences.push(remaining);
  }

  // If no sentence-ending punctuation found, treat the whole text as one sentence
  if (sentences.length === 0) {
    sentences.push(normalized);
  }

  // Greedily pack sentences into segments up to softLimit
  const segments = [];
  let current = "";

  for (const sentence of sentences) {
    if (!current) {
      // Start a new segment
      if (sentence.length <= softLimit) {
        current = sentence;
      } else {
        // Single sentence exceeds softLimit — force-split it
        segments.push(...forceSplitLong(sentence, softLimit, hardLimit));
      }
    } else {
      // Check if adding this sentence would exceed softLimit
      if ((current + sentence).length <= softLimit) {
        current += sentence;
      } else {
        // Close current segment, start new one
        segments.push(current);
        if (sentence.length <= softLimit) {
          current = sentence;
        } else {
          segments.push(...forceSplitLong(sentence, softLimit, hardLimit));
          current = "";
        }
      }
    }
  }

  // Flush remaining
  if (current) segments.push(current);

  return segments.filter(s => s.trim().length > 0);
}

// Force-split a long sentence at soft-punctuation or by character count
function forceSplitLong(text, softLimit, hardLimit) {
  const chunks = [];

  // Try splitting by soft punctuation (、 ，)
  const parts = text.split(/(?<=[、，])/);

  let current = "";
  for (const part of parts) {
    if (!current) {
      current = part;
    } else if ((current + part).length <= hardLimit) {
      current += part;
    } else {
      if (current) chunks.push(current);
      current = part;
    }
  }
  if (current) chunks.push(current);

  // Final pass: anything still exceeding hardLimit gets character-split
  const result = [];
  for (const chunk of chunks) {
    if (chunk.length <= hardLimit) {
      result.push(chunk);
    } else {
      let remaining = chunk;
      while (remaining.length > 0) {
        const slice = remaining.slice(0, softLimit);
        remaining = remaining.slice(softLimit);
        if (slice.trim()) result.push(slice);
      }
    }
  }

  return result;
}

// ===========================
//  FFMPEG DETECTION
// ===========================

let _ffmpegChecked = false;
let _ffmpegAvailable = false;

function checkFfmpeg() {
  if (_ffmpegChecked) return _ffmpegAvailable;
  _ffmpegChecked = true;
  try {
    execSync("ffmpeg -version", { stdio: "ignore", timeout: 5000 });
    _ffmpegAvailable = true;
  } catch {
    _ffmpegAvailable = false;
  }
  return _ffmpegAvailable;
}

// ===========================
//  AUDIO CONCATENATION
// ===========================

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

function concatWavFiles(inputPaths, outputPath, silenceMs = 300) {
  return new Promise((resolve, reject) => {
    const ffmpegOk = checkFfmpeg();

    if (ffmpegOk && silenceMs >= 0) {
      // ffmpeg concat with silence insertion
      concatWithFfmpeg(inputPaths, outputPath, silenceMs).then(resolve).catch(reject);
    } else {
      // Pure Node.js WAV concatenation (no silence insertion)
      concatWavPureNode(inputPaths, outputPath).then(resolve).catch(reject);
    }
  });
}

function concatWithFfmpeg(inputPaths, outputPath, silenceMs) {
  return new Promise((resolve, reject) => {
    // Create a temp silence file
    const silencePath = path.join(OUTPUT_DIR, `_silence_${Date.now()}.wav`);
    generateSilenceWav(silenceMs, 22050, silencePath);

    // Build ffmpeg concat list
    const concatList = path.join(OUTPUT_DIR, `_concat_${Date.now()}.txt`);
    const files = [];
    for (let i = 0; i < inputPaths.length; i++) {
      const escaped = inputPaths[i].replace(/'/g, "'\\''");
      files.push(`file '${escaped}'`);
      if (silenceMs > 0 && i < inputPaths.length - 1) {
        const silenceEscaped = silencePath.replace(/'/g, "'\\''");
        files.push(`file '${silenceEscaped}'`);
      }
    }
    fs.writeFileSync(concatList, files.join("\n"));

    const child = spawn("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", outputPath], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", d => { stderr += d; });

    const cleanup = () => {
      try { fs.unlinkSync(silencePath); } catch {}
      try { fs.unlinkSync(concatList); } catch {}
    };

    child.on("close", code => {
      cleanup();
      if (code !== 0) {
        console.error("[WARN] ffmpeg concat failed, falling back to pure Node:", stderr);
        concatWavPureNode(inputPaths, outputPath).then(r => resolve({ ...r, method: "node-fallback" })).catch(reject);
      } else {
        resolve({ method: "ffmpeg" });
      }
    });
    child.on("error", err => {
      cleanup();
      console.error("[WARN] ffmpeg concat error, falling back to pure Node:", err.message);
      concatWavPureNode(inputPaths, outputPath).then(r => resolve({ ...r, method: "node-fallback" })).catch(reject);
    });
  });
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

// ===========================
//  TTS PAYLOAD BUILDER
// ===========================

// TTS 推理参数白名单 — 前端 cfg 中存在即透传给 9880 引擎
const TTS_PASS_THROUGH_KEYS = [
  "text", "text_lang", "ref_audio_path", "aux_ref_audio_paths",
  "prompt_text", "prompt_lang",
  "top_k", "top_p", "temperature", "repetition_penalty", "seed",
  "speed_factor", "text_split_method",
  "batch_size", "batch_threshold", "split_bucket",
  "fragment_interval", "parallel_infer",
  "sample_steps", "if_sr", "super_sampling",
  "media_type", "streaming_mode",
  "overlap_length", "min_chunk_length",
];

function buildTtsPayload(text, cfg) {
  let refAudio = cfg.reference_audio || "";
  let refText = cfg.reference_text || "";

  // If no reference audio configured, auto-pick first matched segment from assets
  if (!refAudio) {
    try {
      const segFile = path.join(ASSETS_DIR, cfg.id || cfg.voiceId || "", "segments.json");
      if (fs.existsSync(segFile)) {
        const segData = JSON.parse(fs.readFileSync(segFile, "utf-8"));
        const first = (segData.segments || []).find(s => s.matched && (s.audio || s.audio_path || s.audio_filename));
        if (first) {
          const raw = first.audio || first.audio_path || first.audio_filename;
          if (raw) {
            refAudio = resolveRefPath(raw);
          }
          if (first.text) refText = first.text;
        }
      }
    } catch (e) { console.error("[TTS] Failed to auto-ref:", e.message); }
  }

  // Convert relative paths to absolute for GPT-SoVITS engine
  if (refAudio && !refAudio.includes(":\\") && !refAudio.startsWith("/")) {
    refAudio = resolveRefPath(refAudio);
  }

  // 基础字段
  const payload = {
    text,
    text_lang: cfg.text_lang || cfg.language || "ja",
    ref_audio_path: refAudio,
    prompt_text: refText,
    prompt_lang: cfg.prompt_lang || cfg.language || "ja",
  };

  // 白名单透传：cfg 中有值就传给引擎（引擎自有默认值兜底）
  for (const key of TTS_PASS_THROUGH_KEYS) {
    if (cfg[key] !== undefined && cfg[key] !== null && cfg[key] !== "") {
      payload[key] = cfg[key];
    }
  }

  // 默认值兜底（仅在 cfg 完全没传时补）
  if (payload.top_k === undefined) payload.top_k = 15;
  if (payload.top_p === undefined) payload.top_p = 1.0;
  if (payload.temperature === undefined) payload.temperature = 1.0;
  if (payload.text_split_method === undefined) payload.text_split_method = "cut5";
  if (payload.batch_size === undefined) payload.batch_size = 1;
  if (payload.batch_threshold === undefined) payload.batch_threshold = 0.75;
  if (payload.split_bucket === undefined) payload.split_bucket = true;
  if (payload.speed_factor === undefined) payload.speed_factor = 1.0;
  if (payload.fragment_interval === undefined) payload.fragment_interval = 0.3;
  if (payload.media_type === undefined) payload.media_type = "wav";
  if (payload.streaming_mode === undefined) payload.streaming_mode = false;
  if (payload.parallel_infer === undefined) payload.parallel_infer = true;
  if (payload.repetition_penalty === undefined) payload.repetition_penalty = 1.35;
  if (payload.seed === undefined) payload.seed = -1;

  return payload;
}

// ===========================
//  GENERATION CORE
// ===========================

async function switchModels(cfg) {
  if (cfg.gpt_model) {
    const r = await gsvGet("/set_gpt_weights", { weights_path: cfg.gpt_model });
    if (r.statusCode >= 400) console.error("set_gpt_weights failed:", r.body.toString());
  }
  if (cfg.sovits_model) {
    const r = await gsvGet("/set_sovits_weights", { weights_path: cfg.sovits_model });
    if (r.statusCode >= 400) console.error("set_sovits_weights failed:", r.body.toString());
  }
}

async function generateOneSegment(segmentText, cfg) {
  const payload = buildTtsPayload(segmentText, cfg);
  for (const key of ["sample_steps", "if_sr", "aux_ref_audio_paths"]) {
    if (cfg[key] !== undefined) payload[key] = cfg[key];
  }
  const ttsRes = await gsvPost("/tts", payload);
  if (ttsRes.statusCode >= 400) {
    throw new Error(`GPT-SoVITS /tts failed (${ttsRes.statusCode}): ${ttsRes.body.toString()}`);
  }
  const audioBytes = ttsRes.body;
  if (!audioBytes || audioBytes.length === 0) {
    throw new Error("GPT-SoVITS returned empty audio");
  }
  return audioBytes;
}

// ===========================
//  API ROUTES
// ===========================

app.get("/api/health", async (req, res) => {
  let engine_online = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch("http://127.0.0.1:9880/", { signal: ctrl.signal });
    clearTimeout(t);
    engine_online = r.ok;
  } catch { engine_online = false; }
  res.json({
    ok: true,
    engine_online,
    gpt_sovits_url: "http://127.0.0.1:9880",
    ffmpeg_available: checkFfmpeg(),
  });
});

// ===========================
//  ADVANCED PARAMS (advanced_params.json)
// ===========================

const ADVANCED_PARAMS_FILE = path.join(APP_DIR, "advanced_params.json");

const DEFAULT_ADVANCED_PARAMS = {
  // Common
  temperature: 1.0,
  top_k: 15,
  top_p: 1.0,
  repetition_penalty: 1.35,
  text_split_method: "cut5",
  speed_factor: 1.0,
  seed: -1,
  // Advanced inference
  batch_size: 1,
  batch_threshold: 0.75,
  split_bucket: true,
  fragment_interval: 0.3,
  parallel_infer: true,
  sample_steps: 32,
  if_sr: false,
  media_type: "wav",
  streaming_mode: false,
  overlap_length: 2,
  min_chunk_length: 16,
  // Engine-level (require engine restart)
  version: "v2Pro",
  is_half: true,
  device: "cuda",
};

function loadAdvancedParams() {
  try {
    if (!fs.existsSync(ADVANCED_PARAMS_FILE)) return { ...DEFAULT_ADVANCED_PARAMS };
    const data = JSON.parse(fs.readFileSync(ADVANCED_PARAMS_FILE, "utf-8"));
    return { ...DEFAULT_ADVANCED_PARAMS, ...data };
  } catch (e) {
    console.error("[ADVANCED_PARAMS] Failed to read:", e.message);
    return { ...DEFAULT_ADVANCED_PARAMS };
  }
}

function saveAdvancedParams(params) {
  const merged = { ...loadAdvancedParams(), ...params, updated_at: new Date().toISOString() };
  fs.writeFileSync(ADVANCED_PARAMS_FILE, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

app.get("/api/advanced-params", (req, res) => {
  res.json(loadAdvancedParams());
});

app.post("/api/advanced-params", requireApiKey, (req, res) => {
  try {
    const merged = saveAdvancedParams(req.body || {});
    res.json({ ok: true, params: merged });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

app.get("/api/voices", (req, res) => {
  try {
    const data = loadVoices();
    const voices = Object.entries(data).map(([id, cfg]) => ({
      id, display_name: cfg.display_name || id,
      language: cfg.language || cfg.text_lang || "unknown",
    }));
    res.json({ voices });
  } catch (err) {
    res.status(500).json({ error: clientError(err, "Failed to read voices.json") });
  }
});

app.post("/api/generate", requireApiKey, async (req, res) => {
  const {
    voice, text, format, split, max_chars, concat, silence_ms,
    ref_audio, reference_text, aux_ref_audio_paths,
    temperature, top_k, top_p, repetition_penalty,
    text_split_method, speed_factor, seed,
    gpt_model, sovits_model, text_lang, prompt_lang,
    batch_size, batch_threshold, split_bucket,
    fragment_interval, parallel_infer,
    sample_steps, if_sr, super_sampling,
    media_type, streaming_mode,
    overlap_length, min_chunk_length,
  } = req.body || {};
  if (!voice) return res.status(400).json({ error: "Missing 'voice' field" });
  if (!text) return res.status(400).json({ error: "Missing 'text' field" });
  if (text.length > 5000) return res.status(400).json({ error: "Text too long (max 5000 chars)" });

  // Validate voice exists (registration check only)
  let voices;
  try { voices = loadVoices(); } catch (err) { return res.status(500).json({ error: clientError(err, "voices.json error") }); }
  const voiceReg = voices[voice];
  if (!voiceReg) return res.status(404).json({ error: `Unknown voice: ${voice}` });

  // Build config from frontend-passed values (not from voices.json)
  const cfg = {
    id: voice,
    voiceId: voice,
    gpt_model: gpt_model || "",
    sovits_model: sovits_model || "",
    reference_audio: ref_audio || "",
    reference_text: reference_text || "",
    aux_ref_audio_paths: aux_ref_audio_paths || [],
    text_lang: text_lang || voiceReg.text_lang || voiceReg.language || "ja",
    prompt_lang: prompt_lang || voiceReg.prompt_lang || voiceReg.language || "ja",
    temperature: temperature !== undefined ? parseFloat(temperature) : 1.0,
    top_k: top_k !== undefined ? parseInt(top_k, 10) : 15,
    top_p: top_p !== undefined ? parseFloat(top_p) : 1.0,
    repetition_penalty: repetition_penalty !== undefined ? parseFloat(repetition_penalty) : 1.35,
    text_split_method: text_split_method || "cut5",
    speed_factor: speed_factor !== undefined ? parseFloat(speed_factor) : 1.0,
    seed: seed !== undefined ? parseInt(seed, 10) : -1,
    batch_size: batch_size !== undefined ? parseInt(batch_size, 10) : undefined,
    batch_threshold: batch_threshold !== undefined ? parseFloat(batch_threshold) : undefined,
    split_bucket: split_bucket !== undefined ? !!split_bucket : undefined,
    fragment_interval: fragment_interval !== undefined ? parseFloat(fragment_interval) : undefined,
    parallel_infer: parallel_infer !== undefined ? !!parallel_infer : undefined,
    sample_steps: sample_steps !== undefined ? parseInt(sample_steps, 10) : undefined,
    if_sr: if_sr !== undefined ? !!if_sr : undefined,
    media_type: media_type || undefined,
    streaming_mode: streaming_mode !== undefined ? !!streaming_mode : undefined,
    overlap_length: overlap_length !== undefined ? parseInt(overlap_length, 10) : undefined,
    min_chunk_length: min_chunk_length !== undefined ? parseInt(min_chunk_length, 10) : undefined,
  };

  const shouldSplit = split !== false;
  const shouldConcat = concat !== false;
  const softLimit = Math.max(10, parseInt(max_chars, 10) || 45);
  const silenceMs = Math.min(2000, Math.max(0, parseInt(silence_ms, 10) || 300));
  // Engine only returns WAV; format param is accepted for API compatibility but always produces wav
  const mediaType = "wav";
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  const safeVoice = voice.replace(/[^a-zA-Z0-9_-]/g, "_");

  try {
    await withGenerationLock(async () => {
      await switchModels(cfg);

      // Short text or split disabled: single generation
      if (!shouldSplit || text.length <= softLimit) {
        const audioBytes = await generateOneSegment(text, cfg);
        const filename = `${safeVoice}_${ts}_${rand}.${mediaType}`;
        fs.writeFileSync(path.join(OUTPUT_DIR, filename), audioBytes);
        console.log(`[OK] Generated: ${filename} (${audioBytes.length} bytes)`);
        return res.json({ ok: true, voice, split: false, concat: false, audio_url: `/outputs/${filename}` });
      }

      // Split + generate
      const segments = splitJapaneseText(text, { softLimit, hardLimit: softLimit * 2 });
      console.log(`[SPLIT] ${text.length} chars -> ${segments.length} segments`);

      const segFiles = [];
      const segResults = [];

      for (let i = 0; i < segments.length; i++) {
        const segText = segments[i];
        console.log(`[SEG ${i}/${segments.length - 1}] "${segText.slice(0, 30)}..." (${segText.length} chars)`);
        try {
          const audioBytes = await generateOneSegment(segText, cfg);
          const segFilename = `${safeVoice}_${ts}_${rand}_seg${String(i).padStart(3, "0")}.${mediaType}`;
          const segPath = path.join(OUTPUT_DIR, segFilename);
          fs.writeFileSync(segPath, audioBytes);
          segFiles.push(segPath);
          segResults.push({ index: i, text: segText, audio_url: `/outputs/${segFilename}` });
          console.log(`[OK] Segment ${i}: ${segFilename} (${audioBytes.length} bytes)`);
        } catch (err) {
          console.error(`[FAIL] Segment ${i} failed: ${err.message}`);
          return res.status(502).json({
            ok: false, error: clientError(err, `Segment ${i} failed`),
            segments: segResults,
          });
        }
      }

      if (!shouldConcat || segFiles.length === 1) {
        // No concatenation requested or only one segment
        const first = segResults[0];
        return res.json({
          ok: true, voice, split: true, concat: false,
          audio_url: first.audio_url,
          segments: segResults,
          warning: segFiles.length === 1 ? "Text fit in one segment; no concatenation needed" : undefined,
        });
      }

      // Concatenate
      const combinedFilename = `${safeVoice}_${ts}_${rand}_combined.${mediaType}`;
      const combinedPath = path.join(OUTPUT_DIR, combinedFilename);

      try {
        const concatResult = await concatWavFiles(segFiles, combinedPath, silenceMs);
        const combinedSize = fs.statSync(combinedPath).size;
        console.log(`[OK] Combined: ${combinedFilename} (${combinedSize} bytes, method: ${concatResult.method})`);

        return res.json({
          ok: true, voice, split: true, concat: true,
          audio_url: `/outputs/${combinedFilename}`,
          silence_ms: silenceMs,
          concat_method: concatResult.method,
          segments: segResults,
        });
      } catch (err) {
        console.error(`[FAIL] Concatenation failed: ${err.message}`);
        return res.json({
          ok: false, error: clientError(err, "Audio concatenation failed"),
          segments: segResults,
          warning: "Segment files are still available for manual playback.",
        });
      }
    });
  } catch (err) {
    console.error("[ERROR] Generate failed:", err.message);
    res.status(500).json({ error: clientError(err) });
  }
});

// ===========================
//  VOICE ASSET MANAGER APIs
// ===========================

app.get("/api/voices/full", (req, res) => {
  const voices = loadVoices();
  res.json({ voices });
});

app.post("/api/voices", requireApiKey, async (req, res) => {
  const entry = req.body || {};
  const id = (entry.id || "").trim();
  if (!id) return res.status(400).json({ error: "Missing 'id' field" });
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id: only letters, numbers, underscore, hyphen allowed" });

  let result, errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (voices[id]) {
      errStatus = 409;
      errBody = { error: `Voice '${id}' already exists` };
      return;
    }
    await _backupVoicesUnlocked();
    voices[id] = {
      display_name: entry.display_name || id, language: entry.language || "ja",
      prompt_lang: entry.prompt_lang || entry.language || "ja",
      text_lang: entry.text_lang || entry.language || "ja",
      gpt_model: entry.gpt_model || "", sovits_model: entry.sovits_model || "",
      reference_audio: entry.reference_audio || "", reference_text: entry.reference_text || "",
      text_split_method: entry.text_split_method || "cut5",
      top_k: entry.top_k || 15, top_p: entry.top_p || 1.0, temperature: entry.temperature || 1.0,
      repetition_penalty: entry.repetition_penalty || 1.35,
    };
    saveVoices(voices);
    result = voices[id];
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id, voice: result });
});

app.put("/api/voices/:id", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });

  let result, errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (!voices[id]) {
      errStatus = 404;
      errBody = { error: `Voice '${id}' not found` };
      return;
    }
    await _backupVoicesUnlocked();
    const existing = voices[id];
    const e = req.body || {};
    voices[id] = {
      display_name: e.display_name ?? existing.display_name,
      language: e.language ?? existing.language,
      prompt_lang: e.prompt_lang ?? existing.prompt_lang,
      text_lang: e.text_lang ?? existing.text_lang,
      gpt_model: e.gpt_model ?? existing.gpt_model,
      sovits_model: e.sovits_model ?? existing.sovits_model,
      reference_audio: e.reference_audio ?? existing.reference_audio,
      reference_text: e.reference_text ?? existing.reference_text,
      text_split_method: e.text_split_method ?? existing.text_split_method,
      top_k: e.top_k ?? existing.top_k, top_p: e.top_p ?? existing.top_p,
      temperature: e.temperature ?? existing.temperature,
      repetition_penalty: e.repetition_penalty ?? existing.repetition_penalty,
    };
    for (const key of ["sample_steps", "if_sr", "aux_ref_audio_paths", "batch_size", "batch_threshold", "split_bucket", "fragment_interval", "parallel_infer", "seed", "speed_factor"]) {
      if (existing[key] !== undefined && e[key] === undefined) voices[id][key] = existing[key];
    }
    saveVoices(voices);
    result = voices[id];
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id, voice: result });
});

app.delete("/api/voices/:id", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });

  let errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (!voices[id]) {
      errStatus = 404;
      errBody = { error: `Voice '${id}' not found` };
      return;
    }
    await _backupVoicesUnlocked();
    delete voices[id];
    saveVoices(voices);
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id });
});

app.post("/api/voices/:id/reference-audio", requireApiKey, upload.single("audio"), async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });

  let result, errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (!voices[id]) {
      errStatus = 404;
      errBody = { error: `Voice '${id}' not found` };
      return;
    }
    await _backupVoicesUnlocked();
    const filePath = path.join(VOICES_DIR, req.file.filename).replace(/\\/g, "/");
    voices[id].reference_audio = filePath;
    saveVoices(voices);
    result = filePath;
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id, reference_audio: result });
});

// POST /api/voices/:id/aux-ref-audio — upload auxiliary reference audio
app.post("/api/voices/:id/aux-ref-audio", requireApiKey, upload.array("audio", 10), async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No audio files uploaded" });

  let result, errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (!voices[id]) {
      errStatus = 404;
      errBody = { error: `Voice '${id}' not found` };
      return;
    }
    await _backupVoicesUnlocked();
    const auxPaths = voices[id].aux_ref_audio_paths || [];
    for (const file of req.files) {
      const filePath = path.join(VOICES_DIR, file.filename).replace(/\\/g, "/");
      auxPaths.push(filePath);
    }
    voices[id].aux_ref_audio_paths = auxPaths;
    saveVoices(voices);
    result = auxPaths;
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id, aux_ref_audio_paths: result });
});

// DELETE /api/voices/:id/aux-ref-audio/:index — remove an auxiliary reference
app.delete("/api/voices/:id/aux-ref-audio/:index", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const idx = parseInt(req.params.index, 10);

  let result, errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (!voices[id]) {
      errStatus = 404;
      errBody = { error: `Voice '${id}' not found` };
      return;
    }
    const auxPaths = voices[id].aux_ref_audio_paths || [];
    if (idx < 0 || idx >= auxPaths.length) {
      errStatus = 400;
      errBody = { error: "Invalid index" };
      return;
    }
    await _backupVoicesUnlocked();
    const removed = auxPaths.splice(idx, 1);
    voices[id].aux_ref_audio_paths = auxPaths;
    saveVoices(voices);
    result = { removed: removed[0], aux_ref_audio_paths: auxPaths };
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id, ...result });
});

// GET /api/audio-files — list available audio files for reference selection
app.get("/api/audio-files", (req, res) => {
  const dir = req.query.dir || "voices";
  const baseDir = dir === "no_slice" ? (process.env.NO_SLICE_DIR || "") : VOICES_DIR;
  if (!baseDir) return res.status(400).json({ error: "NO_SLICE_DIR not configured" });
  try {
    const files = fs.readdirSync(baseDir)
      .filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f))
      .map(f => {
        const full = path.join(baseDir, f);
        const stat = fs.statSync(full);
        let dur = 0;
        try {
          const fd = fs.openSync(full, 'r');
          const buf = Buffer.alloc(64);
          fs.readSync(fd, buf, 0, 64, 0);
          fs.closeSync(fd);
          if (buf.length >= 44 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
            const sr = buf.readUInt32LE(24);
            let off = 0;
            for (let i = 12; i < buf.length - 8; i++) {
              if (buf[i]===0x64&&buf[i+1]===0x61&&buf[i+2]===0x74&&buf[i+3]===0x61) { off=i+8; break; }
            }
            if (off) dur = buf.readUInt32LE(off-4) / (sr * 2);
          }
        } catch {}
        return { name: f, path: full.replace(/\\/g, "/"), size: stat.size, duration: Math.round(dur * 100) / 100 };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ files, dir });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// ===========================
//  ASSET API
// ===========================

// GET /api/assets — list all voice asset directories with meta
app.get("/api/assets", (req, res) => {
  try {
    const assets = assetScanner.listVoiceAssets();
    res.json({ ok: true, assets });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// ---- 共享:全量资产扫描 + 同步 voices.json ----
async function runFullAssetScan() {
  const results = assetScanner.fullScan();
  await withVoicesLock(async () => {
    const voices = loadVoices();
    const scannedIds = new Set(Object.keys(results));
    for (const oldId of Object.keys(voices)) {
      if (!scannedIds.has(oldId)) delete voices[oldId];
    }
    for (const [id, meta] of Object.entries(results)) {
      voices[id] = {
        display_name: meta?.display_name || id,
        language: meta?.language || "ja",
        prompt_lang: meta?.prompt_lang || meta?.language || "ja",
        text_lang: meta?.text_lang || meta?.language || "ja",
      };
    }
    saveVoices(voices);
  });
  return results;
}

// 是否存在任何声音目录缺少 meta.json / segments.json(需要扫描)
function assetsNeedScan() {
  try {
    if (!fs.existsSync(ASSETS_DIR)) return false;
    const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaPath = path.join(ASSETS_DIR, e.name, "meta.json");
      const segPath = path.join(ASSETS_DIR, e.name, "segments.json");
      if (!fs.existsSync(metaPath) || !fs.existsSync(segPath)) return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

// POST /api/assets/scan — trigger full directory scan
app.post("/api/assets/scan", requireApiKey, async (req, res) => {
  try {
    const results = await runFullAssetScan();
    res.json({ ok: true, scanned: Object.keys(results).length, assets: results });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// POST /api/assets/:id/open — open asset folder in system explorer
app.post("/api/assets/:id/open", requireApiKey, (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const voiceDir = path.join(ASSETS_DIR, id);
  if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });
  try {
    if (process.platform === "win32") {
      spawn("explorer", [voiceDir], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      spawn("open", [voiceDir], { stdio: "ignore" });
    } else {
      spawn("xdg-open", [voiceDir], { stdio: "ignore" });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// Windows file locks (model loaded in the inference server, an open Explorer
// window from the Browse button, file watcher, AV, indexer) make a directory
// rename fail with these transient codes. Retry a few times with backoff.
const RENAME_LOCK_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"]);
function sleepSyncMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {}
}
function renameDirWithRetry(src, dst, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(src, dst); return; }
    catch (e) {
      lastErr = e;
      if (!RENAME_LOCK_CODES.has(e.code)) throw e; // EXDEV / ENOENT / etc — fail fast
      sleepSyncMs(200 * Math.pow(2, i));           // 200/400/800/1600/3200ms
    }
  }
  throw lastErr;
}

// Robust voice-folder rename. Fast path is an atomic whole-directory rename.
// If that is blocked by a lock on the CONTAINER directory (common on Windows
// when an Explorer window is open on the folder itself), fall back to creating
// the new folder and MOVING each entry individually — a viewer looking at the
// PARENT usually does not lock individual child files, so per-file moves still
// succeed. Returns { mode, locked } where locked lists any files that could not
// be moved (so the caller can report exactly what to close).
function renameVoiceFolder(oldDir, newDir) {
  try {
    renameDirWithRetry(oldDir, newDir);
    return { mode: "atomic", locked: [] };
  } catch (e) {
    if (e.code === "EXDEV") throw e;                 // caller handles cross-device
    if (!RENAME_LOCK_CODES.has(e.code)) throw e;     // genuine error — propagate
  }
  // --- per-file fallback ---
  fs.mkdirSync(newDir, { recursive: true });
  const locked = [];
  const moveEntry = (name) => {
    const from = path.join(oldDir, name);
    const to = path.join(newDir, name);
    for (let i = 0; i < 4; i++) {
      try { fs.renameSync(from, to); return true; }
      catch (err) {
        if (!RENAME_LOCK_CODES.has(err.code)) throw err;
        sleepSyncMs(150 * Math.pow(2, i));
      }
    }
    // Last resort: copy then best-effort delete (leaves original if still locked).
    try {
      fs.cpSync(from, to, { recursive: true, force: true });
      try { fs.rmSync(from, { recursive: true, force: true }); } catch (_) {}
      return true;
    } catch (_) { locked.push(name); return false; }
  };
  for (const entry of fs.readdirSync(oldDir)) moveEntry(entry);
  // Try to remove the now-(hopefully)-empty old container.
  try { fs.rmdirSync(oldDir); } catch (_) { /* left behind if still locked/nonempty */ }
  return { mode: "per-file", locked };
}

// PATCH /api/assets/:id/rename — rename a voice's DISPLAY NAME **and** its
// internal id / on-disk folder together, so display and id never diverge.
//
// Why rename the id too (not display only): training publishes into
// ASSETS_ROOT/<id> and overwrites unconditionally. If display could drift from
// id (e.g. show "A_en" while the folder is still "A"), a later "train A" would
// silently clobber the hidden asset. Keeping id == sanitize(display) removes
// that trap entirely. Because meta.json is regenerated on scan, the folder can
// be renamed safely and stays self-consistent after a re-scan.
//
// Guards (defense in depth):
//  - target id must be a valid safeId and must NOT already exist (409)
//  - new display name must be unique (case-insensitive) vs every OTHER voice
//  - NO active/interrupted training or rebuild task may touch the old or new id
//  - folder rename uses EPERM/EBUSY retry+backoff; on persistent lock we ABORT
//    cleanly (no half-rename) and tell the user to stop training / close players
app.patch("/api/assets/:id/rename", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const newName = ((req.body && req.body.display_name) || "").trim();
  if (!newName) return res.status(400).json({ error: "display_name is required" });
  if (newName.length > 80) return res.status(400).json({ error: "display_name too long (max 80)" });

  // Derive the new id the same way training does, so what you see is what
  // training would target.
  const newId = newName.replace(/[^a-zA-Z0-9_\-]/g, "_");
  if (!safeId(newId)) {
    return res.status(400).json({ error: "Name must contain at least one letter, number, underscore or hyphen." });
  }

  const oldDir = path.join(ASSETS_DIR, id);
  const oldMetaPath = path.join(oldDir, "meta.json");
  if (!fs.existsSync(oldMetaPath)) return res.status(404).json({ error: `Voice '${id}' not found` });

  const idChanged = newId !== id;
  const newDir = path.join(ASSETS_DIR, newId);

  try {
    // --- Guard: no active/interrupted task on the old or new id -------------
    const activeStates = new Set(["pending", "running", "interrupted"]);
    let tasks = [];
    try { tasks = trainingPipeline.getAllTasks() || []; } catch (_) {}
    const blocking = tasks.find(t => activeStates.has(t.status) && (t.voiceId === id || t.voiceId === newId));
    if (blocking) {
      return res.status(409).json({ error: `Cannot rename while a training/rebuild task (${blocking.status}) is using this voice. Wait for it to finish or clear it first.` });
    }

    // --- Guard: new display name unique vs OTHER voices --------------------
    const taken = new Set();
    const addName = (s) => { if (s) taken.add(String(s).trim().toLowerCase()); };
    try {
      for (const e of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === id) continue;
        addName(e.name);
        try {
          const m = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, e.name, "meta.json"), "utf-8"));
          addName(m.display_name);
        } catch (_) { /* no/invalid meta — id already added */ }
      }
    } catch (_) { /* assets dir unreadable — fall through to voices.json */ }
    const allVoices = loadVoices();
    for (const [vid, v] of Object.entries(allVoices)) {
      if (vid === id) continue;
      addName(vid);
      addName(v && v.display_name);
    }
    if (taken.has(newName.toLowerCase())) {
      return res.status(409).json({ error: `The name "${newName}" is already used by another voice. Pick a different name.` });
    }

    // --- Guard: target folder / id must not already exist ------------------
    if (idChanged && (fs.existsSync(newDir) || allVoices[newId])) {
      return res.status(409).json({ error: `A voice with id "${newId}" already exists. Renaming would overwrite it — pick a different name.` });
    }

    // --- Rename the folder (robust), then meta.json + voices.json ----------
    await withVoicesLock(async () => {
      if (idChanged) {
        let result;
        try {
          result = renameVoiceFolder(oldDir, newDir);
        } catch (e) {
          if (e.code === "EXDEV") {
            throw Object.assign(new Error("Rename crossed a device boundary; aborted to avoid corruption."), { httpStatus: 500 });
          }
          throw Object.assign(new Error(`Could not rename the asset folder (${e.code || "error"}): ${e.message}`), { httpStatus: 423 });
        }
        if (result.locked.length) {
          // Some files could not be moved → roll back what we did move so we
          // never leave a split asset, then tell the user exactly what to close.
          try {
            for (const f of fs.readdirSync(newDir)) {
              try { fs.renameSync(path.join(newDir, f), path.join(oldDir, f)); } catch (_) {}
            }
            fs.rmdirSync(newDir);
          } catch (_) {}
          throw Object.assign(
            new Error(`These files are locked and could not be moved: ${result.locked.join(", ")}. They are likely held by a loaded model (stop generation) or an open Explorer/audio player window on this voice. Close them and retry.`),
            { httpStatus: 423 }
          );
        }
      }

      const targetDir = idChanged ? newDir : oldDir;
      const targetMetaPath = path.join(targetDir, "meta.json");
      try {
        // First set the new display_name/id, then regenerate the asset inventory
        // via scanVoiceDir so all checkpoint/reference `path`s (which embed the
        // folder path) are rewritten for the new id. This is exactly why meta is
        // scan-generated: renaming stays self-consistent.
        const meta0 = JSON.parse(fs.readFileSync(targetMetaPath, "utf-8"));
        meta0.display_name = newName;
        meta0.id = newId;
        fs.writeFileSync(targetMetaPath, JSON.stringify(meta0, null, 2));
        const fresh = assetScanner.scanVoiceDir(newId, targetDir);
        fresh.display_name = newName; // scanVoiceDir inherits from prev, keep explicit
        fresh.id = newId;
        fs.writeFileSync(targetMetaPath, JSON.stringify(fresh, null, 2));
      } catch (metaErr) {
        // meta rewrite failed AFTER folder move — roll the folder back so we
        // don't leave a mismatched id/folder.
        if (idChanged) { try { renameDirWithRetry(newDir, oldDir); } catch (_) {} }
        throw metaErr;
      }

      const voices2 = loadVoices();
      const prev = voices2[id] || {};
      delete voices2[id];
      voices2[newId] = { ...prev, display_name: newName };
      saveVoices(voices2);
    });

    res.json({ ok: true, id: newId, previousId: id, idChanged, display_name: newName });
  } catch (err) {
    const status = err && err.httpStatus ? err.httpStatus : 500;
    res.status(status).json({ error: localError(err) });
  }
});

// GET /api/config — current app config surfaced to the UI (assets directory etc).
app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    assetsRoot: ASSETS_ROOT,
    assetsRootSource: ASSETS_ROOT_SOURCE, // 'env' | 'config' | 'default'
    configFile: CONFIG_FILE,
    envOverride: ASSETS_ROOT_SOURCE === "env",
    platform: process.platform,
  });
});

// POST /api/config/assets-root { path, migration } — persist a new assets
// directory to app-config.json. `migration` decides what happens to data that
// already lives in the CURRENT assets directory:
//   'switch' — just point at the new dir, leave old data where it is (default)
//   'copy'   — copy existing voices into the new dir, keep the originals
//   'move'   — copy existing voices into the new dir, then delete the originals
// The new root takes effect after a server restart (paths.js resolves once at
// startup); the migration itself is done here so the data is already in place.
app.post("/api/config/assets-root", requireApiKey, async (req, res) => {
  const p = ((req.body && req.body.path) || "").trim();
  const migration = ((req.body && req.body.migration) || "switch").toLowerCase();
  if (!p) return res.status(400).json({ error: "path is required" });
  if (!path.isAbsolute(p)) return res.status(400).json({ error: "path must be absolute" });
  if (!["switch", "copy", "move"].includes(migration)) {
    return res.status(400).json({ error: "invalid migration mode" });
  }
  const target = path.resolve(p);
  if (target === path.resolve(ASSETS_DIR)) {
    return res.status(400).json({ error: "That is already the current assets directory." });
  }
  // Refuse copy/move into a directory nested under the current one (would recurse).
  const rel = path.relative(ASSETS_DIR, target);
  const targetInsideSource = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (targetInsideSource && migration !== "switch") {
    return res.status(400).json({ error: "Target is inside the current assets directory; choose a separate location." });
  }
  try {
    await fsp.mkdir(target, { recursive: true });
    await fsp.access(target, fs.constants.W_OK);
  } catch (err) {
    return res.status(400).json({ error: `Directory is not writable: ${localError(err)}` });
  }

  const verb = migration === "copy" ? "copied" : migration === "move" ? "moved" : "switched";
  const envOverride = ASSETS_ROOT_SOURCE === "env";
  const doneNote = envOverride
    ? `Data ${verb}, but the ASSETS_ROOT environment variable overrides the saved path. Unset it for the new directory to take effect.`
    : `Data ${verb}. Restart the server for the new assets directory to take effect.`;

  // "switch" is instant (no data movement) → stay synchronous.
  if (migration === "switch") {
    try {
      writeConfig({ assetsRoot: target });
      return res.json({ ok: true, assetsRoot: target, migration, needsRestart: true, envOverride, note: doneNote });
    } catch (err) {
      return res.status(500).json({ error: localError(err) });
    }
  }

  // copy/move can be slow and may stall on locked files → run as a background job
  // and expose a simple copy → verify → delete pipeline the UI can poll.
  let entries;
  try {
    entries = (await fsp.readdir(ASSETS_DIR, { withFileTypes: true }))
      .filter(e => e.name !== ".staging"); // never migrate transient staging
  } catch (err) {
    return res.status(500).json({ error: localError(err) });
  }

  const jobId = crypto.randomBytes(6).toString("hex");
  const job = {
    id: jobId, migration, target, phase: "copying",
    total: entries.length, current: 0, currentName: "",
    steps: { copy: "running", verify: migration === "move" ? "pending" : "skipped", delete: migration === "move" ? "pending" : "skipped" },
    error: null, done: false, assetsRoot: target, envOverride, note: null,
    startedAt: Date.now(),
  };
  migrationJobs.set(jobId, job);
  runMigrationJob(job, entries, doneNote); // fire-and-forget; polled via status endpoint

  res.json({ ok: true, async: true, jobId, migration, total: entries.length });
});

// Background copy/move runner. Updates the in-memory job so the UI pipeline can
// show progress. Order is strictly copy → verify → delete; the config is only
// written after data movement fully succeeds, so any failure leaves the source
// and the active assets directory untouched.
async function runMigrationJob(job, entries, doneNote) {
  const sameName = (n) => n; // readability alias for entry name
  try {
    // Step 1: copy
    for (const e of entries) {
      job.currentName = sameName(e.name);
      await fsp.cp(path.join(ASSETS_DIR, e.name), path.join(job.target, e.name), { recursive: true, force: true });
      job.current += 1;
    }
    job.steps.copy = "done";

    if (job.migration === "move") {
      // Step 2: verify integrity before deleting anything
      job.phase = "verifying"; job.steps.verify = "running"; job.current = 0; job.currentName = "";
      for (const e of entries) {
        job.currentName = e.name;
        const bad = await firstMismatch(path.join(ASSETS_DIR, e.name), path.join(job.target, e.name));
        if (bad) throw new Error(`integrity check failed for "${bad}" — source left intact, nothing deleted`);
        job.current += 1;
      }
      job.steps.verify = "done";

      // Step 3: delete sources (only now that the copy is verified complete)
      job.phase = "deleting"; job.steps.delete = "running"; job.current = 0; job.currentName = "";
      for (const e of entries) {
        job.currentName = e.name;
        await fsp.rm(path.join(ASSETS_DIR, e.name), { recursive: true, force: true });
        job.current += 1;
      }
      job.steps.delete = "done";
    }

    writeConfig({ assetsRoot: job.target });
    job.phase = "done"; job.done = true; job.note = doneNote; job.finishedAt = Date.now();
  } catch (err) {
    job.phase = "error"; job.done = true; job.error = localError(err); job.finishedAt = Date.now();
    if (job.steps.copy === "running") job.steps.copy = "failed";
    else if (job.steps.verify === "running") job.steps.verify = "failed";
    else if (job.steps.delete === "running") job.steps.delete = "failed";
  }
}

// GET /api/config/migrate-status/:id — poll a copy/move migration job.
app.get("/api/config/migrate-status/:id", requireApiKey, (req, res) => {
  const job = migrationJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Migration job not found (server may have restarted)." });
  res.json({ ok: true, ...job });
  // Reap finished jobs a little after they complete so status is still pollable.
  if (job.done && job.finishedAt && Date.now() - job.finishedAt > 60000) migrationJobs.delete(job.id);
});

// GET /api/fs/browse?path=<abs> — server-side directory listing that powers an
// IN-APP folder browser. Spawning a native OS dialog from this (headless, non-
// interactive) server process is unreliable — it opens behind the browser or
// not at all — so instead we list directories over HTTP and let the frontend
// render a reliable, cross-platform, testable picker.
//   - empty/absent path on Windows → returns the drive list (C:\, D:\, …)
//   - otherwise → returns { path, parent, dirs:[{name, path}] }
// Only directories are listed; unreadable entries are skipped.
app.get("/api/fs/browse", requireApiKey, async (req, res) => {
  try {
    let target = (req.query.path || "").toString().trim();
    const isWin = process.platform === "win32";

    // Windows with no path → enumerate drive letters (async access probes so a
    // slow/absent removable drive can't block the event loop).
    if (!target && isWin) {
      const letters = [];
      for (let c = 67; c <= 90; c++) letters.push(String.fromCharCode(c) + ":\\"); // C..Z
      const probes = await Promise.all(letters.map(root =>
        fsp.access(root).then(() => root).catch(() => null)
      ));
      const drives = probes.filter(Boolean).map(root => ({ name: root, path: root }));
      return res.json({ ok: true, path: "", parent: null, isDriveList: true, drives, dirs: [] });
    }
    if (!target) target = "/"; // POSIX root

    target = path.resolve(target);
    let stat;
    try { stat = await fsp.stat(target); } catch (e) {
      return res.status(400).json({ error: `Cannot open "${target}": ${localError(e)}` });
    }
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: `Not a directory: ${target}` });
    }

    // Fully async + parallel so the event loop stays responsive. On Windows the
    // user profile is full of junctions (reparse points) whose per-entry stat can
    // throw EPERM; doing those in parallel (and only when the dirent type is
    // unknown/symlink) avoids the serial-exception stall that made this lag.
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const resolved = await Promise.all(entries.map(async (entry) => {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) return { name: entry.name, path: full };
      // A symlink/junction may point at a directory — resolve it, but never pay
      // for an extra stat on plain files (the common case, always skipped).
      if (entry.isSymbolicLink()) {
        try { if ((await fsp.stat(full)).isDirectory()) return { name: entry.name, path: full }; } catch (_) {}
      }
      return null;
    }));
    const dirs = resolved.filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    // parent: null when at a drive root (Windows) or filesystem root (POSIX),
    // in which case the frontend offers "up to drives" on Windows.
    const parentDir = path.dirname(target);
    const atRoot = parentDir === target;
    const parent = atRoot ? (isWin ? "" : null) : parentDir;

    res.json({ ok: true, path: target, parent, isDriveList: false, drives: [], dirs });
  } catch (err) {
    res.status(500).json({ error: localError(err) });
  }
});

// POST /api/fs/mkdir { path } — create a directory (recursively) so the in-app
// folder browser can make a new destination on the fly. Returns the resolved
// absolute path; the frontend then navigates into it.
app.post("/api/fs/mkdir", requireApiKey, async (req, res) => {
  try {
    const raw = ((req.body && req.body.path) || "").toString().trim();
    if (!raw) return res.status(400).json({ error: "path is required" });
    if (!path.isAbsolute(raw)) return res.status(400).json({ error: "path must be absolute" });
    const target = path.resolve(raw);
    await fsp.mkdir(target, { recursive: true });
    res.json({ ok: true, path: target });
  } catch (err) {
    res.status(500).json({ error: localError(err) });
  }
});

// DELETE /api/assets/:id — delete an asset directory and its voice config
app.delete("/api/assets/:id", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const voiceDir = path.join(ASSETS_DIR, id);
  if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });
  try {
    fs.rmSync(voiceDir, { recursive: true, force: true });
    await withVoicesLock(async () => {
      const voices1 = loadVoices();
      if (voices1[id]) { delete voices1[id]; saveVoices(voices1); }
    });
    res.json({ ok: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// POST /api/assets/:id/scan — scan a single voice asset
app.post("/api/assets/:id/scan", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const voiceDir = path.join(ASSETS_DIR, id);
  if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });
  try {
    const meta = assetScanner.scanVoiceDir(id, voiceDir);
    // Persist the freshly-scanned meta first so the refreshed assets inventory
    // is not lost, then regenerate segments and backfill the counts (Bug A).
    const metaPath = path.join(voiceDir, "meta.json");
    const segResult = assetScanner.generateSegments(id);
    if (segResult && typeof segResult.matched === "number") {
      meta.segment_total = segResult.matched;
      meta.segment_matched = segResult.matched;
    }
    try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch (_) {}
    const updatedMeta = meta;
    // Surface a warning when slices are missing so the client can prompt re-slice (Bug C).
    const segWarning = segResult && segResult.ok === false ? segResult.error : null;
    await withVoicesLock(async () => {
      const voices2 = loadVoices();
      voices2[id] = {
        display_name: updatedMeta?.display_name || id,
        language: updatedMeta?.language || "ja",
        prompt_lang: updatedMeta?.prompt_lang || updatedMeta?.language || "ja",
        text_lang: updatedMeta?.text_lang || updatedMeta?.language || "ja",
      };
      saveVoices(voices2);
    });
    res.json({ ok: true, meta: updatedMeta, warning: segWarning });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// POST /api/assets/import — import voice from GPT-SoVITS output using slicer_opt.list
app.post("/api/assets/import", requireApiKey, async (req, res) => {
  const { voiceId, gsvBase } = req.body || {};
  if (!voiceId) return res.status(400).json({ error: "Missing 'voiceId' field" });
  const base = gsvBase || assetScanner.GSV_BASE;
  try {
    const result = assetScanner.importFromList(voiceId, base);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// GET /api/assets/:id — get meta.json for a voice
app.get("/api/assets/:id", (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const metaPath = path.join(ASSETS_DIR, id, "meta.json");
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: `No meta.json for '${id}'` });
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    res.json({ ok: true, meta });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// GET /api/assets/:id/segments — get segments.json for a voice
app.get("/api/assets/:id/segments", (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const segPath = path.join(ASSETS_DIR, id, "segments.json");
  if (!fs.existsSync(segPath)) return res.status(404).json({ error: `No segments.json for '${id}'` });
  try {
    const data = JSON.parse(fs.readFileSync(segPath, "utf-8"));
    // Privacy / correctness: segments.json is a snapshot from scan time. The user
    // may have since deleted slice .wav files (e.g. to keep only models). Re-check
    // each slice's real existence on disk NOW and expose `exists` so the client
    // never lists / offers a reference audio that cannot actually be played or used.
    const slicesDir = path.join(ASSETS_DIR, id, "slicer_opt");
    if (data && Array.isArray(data.segments)) {
      let liveMatched = 0;
      for (const seg of data.segments) {
        const fname = seg.audio_filename || (seg.audio_path ? String(seg.audio_path).replace(/\\/g, "/").split("/").pop() : "");
        const exists = !!(fname && fs.existsSync(path.join(slicesDir, fname)));
        seg.exists = exists;
        if (exists) liveMatched += 1;
      }
      data.live_matched = liveMatched;
    }
    res.json({ ok: true, segments: data });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// GET /api/assets/:id/raw-list — live listing of raw/ audio files (for the
// non-sliced reference-audio column). Reads the directory NOW (not meta.json)
// so deleted files never appear.
app.get("/api/assets/:id/raw-list", (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const rawDir = path.join(ASSETS_DIR, id, "raw");
  if (!fs.existsSync(rawDir)) return res.json({ ok: true, raw: [] });
  try {
    const files = fs.readdirSync(rawDir)
      .filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f))
      .map(f => ({ filename: f, url: `/assets/${id}/raw/${encodeURIComponent(f)}` }));
    res.json({ ok: true, raw: files });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// POST /api/assets/generate-segments — parse name2text and generate segments.json
app.post("/api/assets/:id/generate-segments", requireApiKey, (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const voiceDir = path.join(ASSETS_DIR, id);
  if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });
  try {
    const data = assetScanner.generateSegments(id);
    if (!data) return res.status(400).json({ error: "No slicer_opt.list found" });
    if (data.ok === false) return res.status(400).json({ error: data.error });
    res.json({ ok: true, total: data.total, matched: data.matched, missing: data.missing || 0 });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// POST /api/assets/:id/rebuild — dependency-driven asset repair.
// Computes the SHORTEST set of stages to fill missing artifacts (reusing what
// exists). By default it only returns the PLAN (execute=false). With
// execute=true it performs the repair: lightweight cases (only segments) run
// inline; cases needing training are handed to the existing training pipeline
// with inputDir pointed at the published asset dir and the computed stepOptions.
app.post("/api/assets/:id/rebuild", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const voiceDir = path.join(ASSETS_DIR, id);
  if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });

  const mode = (req.body && req.body.mode) || "safe";
  const reslice = !!(req.body && req.body.reslice);
  const skipAsr = !!(req.body && req.body.skipAsr);
  const execute = !!(req.body && req.body.execute);
  // Optional per-model retrain overrides from the restore modal. undefined = auto
  // (retrain only whichever model is missing); true/false = explicit force/skip.
  const bodyTrainS1 = req.body && req.body.trainS1;
  const bodyTrainS2 = req.body && req.body.trainS2;
  const trainS1 = bodyTrainS1 === undefined ? undefined : !!bodyTrainS1;
  const trainS2 = bodyTrainS2 === undefined ? undefined : !!bodyTrainS2;
  // Optional per-run overrides for slice / asr / training parameters, shaped like
  // the training pipeline's customParams: { training, steps: { slice|asr: { params } } }.
  // Run through the SAME whitelist + clamp as /api/train/start so the rebuild path
  // (a lighter pipeline that skips already-satisfied steps) shares one safety gate.
  const params = sanitizeCustomParams(req.body && req.body.params);

  try {
    const state = assetScanner.detectAssetState(id);
    const plan = assetScanner.planRebuild(state, { mode, reslice, skipAsr, trainS1, trainS2 });

    // Hard errors / nothing to do → report the plan as-is.
    if (plan.error) return res.status(400).json({ ok: false, state, ...plan });
    if (plan.noop) return res.json({ ok: true, state, ...plan });

    // Plan-only (default): caller confirms before any heavy work runs.
    if (!execute) {
      return res.json({ ok: true, state, executed: false, ...plan });
    }

    // No executable stages (e.g. safe mode deferred missing models): there is
    // nothing to run — surface the suggested follow-up instead of training.
    if (!plan.stages || plan.stages.length === 0) {
      return res.json({ ok: true, state, executed: false, ...plan });
    }

    // use_pretrained_base is not yet supported by the backend (Phase 4 backlog).
    if (plan.uses_pretrained_base) {
      return res.status(501).json({
        ok: false, state, ...plan,
        error: "Pretrained-base rebuild (emergency mode) is not implemented yet (backend-pending).",
      });
    }

    // Step 1: if the plan includes a standalone segments rebuild, run it inline
    // first. planRebuild only schedules this when slices+list already exist, so
    // it is always safe; it also provides segments.json as input for a following
    // preprocess/train stage (which reads it from the asset dir).
    let segResult = null;
    if (plan.needs_segments) {
      const seg = assetScanner.generateSegments(id);
      if (!seg || seg.ok === false) {
        return res.status(400).json({ ok: false, state, ...plan, error: (seg && seg.error) || "Failed to rebuild segments" });
      }
      const meta = assetScanner.scanVoiceDir(id, voiceDir);
      meta.segment_total = seg.matched; meta.segment_matched = seg.matched;
      try { fs.writeFileSync(path.join(voiceDir, "meta.json"), JSON.stringify(meta, null, 2)); } catch (_) {}
      segResult = { total: seg.total, matched: seg.matched, missing: seg.missing };
    }

    // Step 2: if there are no pipeline stages, the segments rebuild was the whole
    // job — return now (lightweight, no training touched).
    if (!plan.stepOptions) {
      return res.json({ ok: true, state, executed: true, action: "generateSegments", ...segResult, ...plan });
    }

    // Step 3: hand off to the training pipeline. inputDir depends on whether we
    // are re-deriving slices from raw (needs the flat raw folder) or reusing the
    // existing slices/segments under the asset root. finalize carries forward any
    // core asset not regenerated this run, so existing models survive promote.
    const voices = loadVoices();
    const language = (voices[id] && voices[id].language) || "ja";
    const rawDir = path.join(voiceDir, "raw");
    const inputDir = plan.stepOptions.slice ? rawDir : voiceDir;
    if (plan.stepOptions.slice && !fs.existsSync(rawDir)) {
      return res.status(400).json({ ok: false, state, ...plan, error: "Re-slice requested but raw/ folder is missing." });
    }
    const pipeline = trainingPipeline.createPipeline({
      voiceId: id,
      language,
      inputDir,
      stepOptions: plan.stepOptions,
      customParams: params,
    });
    pipeline.start().catch(err => console.error("[REBUILD] Pipeline error:", err));
    return res.json({ ok: true, state, executed: true, action: "pipeline", taskId: pipeline.id, segments: segResult, ...plan });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

app.get("/api/voices/:id/validate", (req, res) => {
  const id = req.params.id;
  const voices = loadVoices();
  const cfg = voices[id];
  if (!cfg) return res.status(404).json({ error: `Voice '${id}' not found` });

  // Check reference from segments.json (not voices.json)
  const segPath = path.join(ASSETS_DIR, id, "segments.json");
  let refAudioExists = false;
  let refTextPresent = false;
  if (fs.existsSync(segPath)) {
    try {
      const segData = JSON.parse(fs.readFileSync(segPath, "utf-8"));
      const first = (segData.segments || []).find(s => s.matched && (s.audio || s.audio_path || s.audio_filename));
      if (first) {
        const raw = first.audio || first.audio_path || first.audio_filename;
        const absPath = resolveRefPath(raw);
        refAudioExists = fs.existsSync(absPath);
        refTextPresent = !!first.text;
      }
    } catch (e) { /* non-blocking */ }
  }

  // Check models from meta.json (not voices.json)
  const metaPath = path.join(ASSETS_DIR, id, "meta.json");
  let gptModelExists = false;
  let sovitsModelExists = false;
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const ckpts = meta?.assets?.checkpoints || {};
      const gptList = ckpts.gpt || [];
      const sovitsList = ckpts.sovits || [];
      if (gptList.length > 0) { const b = pickBestCkpt(gptList); gptModelExists = !!(b && fs.existsSync(b.path)); }
      if (sovitsList.length > 0) { const b = pickBestCkpt(sovitsList); sovitsModelExists = !!(b && fs.existsSync(b.path)); }
    } catch (e) { /* non-blocking */ }
  }

  res.json({
    ok: true, voice: id,
    checks: {
      gpt_model_exists: gptModelExists,
      sovits_model_exists: sovitsModelExists,
      reference_audio_exists: refAudioExists,
      reference_text_present: refTextPresent,
      reference_text_placeholder: false,
    },
  });
});

// ===========================
//  OPENAI-COMPATIBLE ENDPOINT
// ===========================

app.post("/v1/audio/speech", requireApiKey, async (req, res) => {
  const { model, voice, input, response_format, speed } = req.body || {};
  if (!voice) return res.status(400).json({ error: "Missing 'voice' field" });
  if (!input) return res.status(400).json({ error: "Missing 'input' field" });
  if (input.length > 5000) return res.status(400).json({ error: "Input too long (max 5000 chars)" });

  let voices;
  try { voices = loadVoices(); } catch (err) { return res.status(500).json({ error: clientError(err, "voices.json error") }); }

  const voiceReg = voices[voice];
  if (!voiceReg) return res.status(404).json({ error: `Unknown voice: ${voice}` });

  // Load reference from segments.json (first matched segment)
  const segPath = path.join(ASSETS_DIR, voice, "segments.json");
  if (!fs.existsSync(segPath)) return res.status(400).json({ error: `Voice '${voice}' has no segments.json. Scan assets first.` });

  let refAudio = "";
  let refText = "";
  try {
    const segData = JSON.parse(fs.readFileSync(segPath, "utf-8"));
    const first = (segData.segments || []).find(s => s.matched && (s.audio || s.audio_path || s.audio_filename));
    if (first) {
      const raw = first.audio || first.audio_path || first.audio_filename;
      refAudio = resolveRefPath(raw);
      refText = first.text || "";
    }
  } catch (e) { return res.status(500).json({ error: `Failed to read segments.json: ${e.message}` }); }

  if (!refAudio) return res.status(400).json({ error: `Voice '${voice}' has no matched reference audio in segments.json` });
  if (!fs.existsSync(refAudio)) return res.status(400).json({ error: `reference_audio file not found: ${refAudio}` });
  if (!refText) return res.status(400).json({ error: `Voice '${voice}' has no reference_text in segments.json` });

  // Load advanced params for generation settings
  const advParams = loadAdvancedParams();

  try {
    await withGenerationLock(async () => {
        const voiceDir = path.join(ASSETS_DIR, voice);
        const metaPath = path.join(voiceDir, "meta.json");
        let gptModel = "";
        let sovitsModel = "";
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          const ckpts = meta?.assets?.checkpoints || {};
          const gptList = ckpts.gpt || [];
          const sovitsList = ckpts.sovits || [];
          if (gptList.length > 0) gptModel = (pickBestCkpt(gptList) || {}).path || "";
          if (sovitsList.length > 0) sovitsModel = (pickBestCkpt(sovitsList) || {}).path || "";
        }
    
        const cfg = {
          gpt_model: gptModel,
          sovits_model: sovitsModel,
          reference_audio: refAudio,
          reference_text: refText,
          text_lang: voiceReg.text_lang || voiceReg.language || "ja",
          prompt_lang: voiceReg.prompt_lang || voiceReg.language || "ja",
          temperature: advParams.temperature,
          top_k: advParams.top_k,
          top_p: advParams.top_p,
          repetition_penalty: advParams.repetition_penalty,
          text_split_method: advParams.text_split_method,
          speed_factor: speed || 1.0,
          seed: advParams.seed,
        };
    
        await switchModels(cfg);
        // Engine only returns WAV; response_format accepted for API compatibility
        const fmt = "wav";
        const mediaType = "audio/wav";
    
        const payload = buildTtsPayload(input, cfg);
        for (const key of ["sample_steps", "if_sr", "aux_ref_audio_paths"]) {
          if (cfg[key] !== undefined) payload[key] = cfg[key];
        }
        payload.speed_factor = speed || 1.0;
        payload.media_type = fmt;
    
        const ttsRes = await gsvPost("/tts", payload);
        if (ttsRes.statusCode >= 400) return res.status(502).json({ error: `GPT-SoVITS /tts failed (${ttsRes.statusCode}): ${ttsRes.body.toString()}` });
    
        const audioBytes = ttsRes.body;
        if (!audioBytes || audioBytes.length === 0) return res.status(502).json({ error: "GPT-SoVITS returned empty audio" });
    
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
        const rand = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
        const safeVoice = voice.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filename = `${safeVoice}_${ts}_${rand}.${fmt}`;
        try { fs.writeFileSync(path.join(OUTPUT_DIR, filename), audioBytes); } catch {}
    
        res.set("Content-Type", mediaType);
        res.set("Content-Disposition", `attachment; filename="${filename}"`);
        res.set("X-Voice-Id", voice);
        res.send(audioBytes);
    });
  } catch (err) {
    console.error("[ERROR] /v1/audio/speech failed:", err.message);
    res.status(500).json({ error: clientError(err) });
  }
});

// ===========================
//  TRAINING API
// ===========================

const trainingPipeline = require("./lib/training/pipeline");

const ALLOWED_LANGUAGES = new Set(["zh", "yue", "ja", "en", "ko"]);

// 白名单校验 + clamp customParams，防止脏参数进训练。
// Train 页(/api/train/start)和资产重建(/api/assets/:id/rebuild)共用此函数，
// 因为两者最终都走同一条 createPipeline；重建只是按依赖图跑更少的步骤(轻量
// pipeline)，但参数安检必须完全一致。白名单覆盖前端暴露的全部参数(Advanced +
// Expert + Slice + ASR)；任何不在白名单内、超范围或类型错误的字段一律丢弃。
function sanitizeCustomParams(custom) {
  if (!custom || typeof custom !== 'object') return {};
  const safe = {};

  // helpers — only assign when the value passes validation, otherwise drop it.
  const num = (dst, key, v, min, max) => {
    if (v == null) return;
    const n = Number(v);
    if (Number.isFinite(n) && n >= min && n <= max) dst[key] = n;
  };
  const intNum = (dst, key, v, min, max) => {
    if (v == null) return;
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n >= min && n <= max) dst[key] = n;
  };
  const bool = (dst, key, v) => { if (typeof v === 'boolean') dst[key] = v; };
  const oneOf = (dst, key, v, allowed) => { if (allowed.includes(v)) dst[key] = v; };
  // 'auto'/'default'-or-number fields (batch_size / learning_rate).
  const word = (dst, key, v, keyword, min, max) => {
    if (v == null) return;
    if (v === keyword) { dst[key] = keyword; return; }
    const n = Number(v);
    if (Number.isFinite(n) && n >= min && n <= max) dst[key] = n;
  };

  if (custom.training) {
    const t = custom.training;
    const s = (safe.training = {});
    // common
    intNum(s, 'gpt_epochs', t.gpt_epochs, 1, 100);
    intNum(s, 'sovits_epochs', t.sovits_epochs, 1, 100);
    word(s, 'batch_size', t.batch_size, 'auto', 1, 16);
    word(s, 'learning_rate', t.learning_rate, 'default', 1e-7, 1);
    // S1 advanced / expert
    intNum(s, 'seed', t.seed, 0, 999999);
    intNum(s, 'save_every_n_epoch', t.save_every_n_epoch, 1, 50);
    oneOf(s, 'precision', t.precision, ['16-mixed', '16-true', 'bf16-mixed', 'bf16-true', '32-true', '32']);
    num(s, 'gradient_clip', t.gradient_clip, 0.1, 10);
    num(s, 'lr', t.lr, 1e-7, 1);
    num(s, 'lr_init', t.lr_init, 1e-7, 0.1);
    num(s, 'lr_end', t.lr_end, 1e-7, 0.1);
    intNum(s, 'warmup_steps', t.warmup_steps, 0, 100000);
    intNum(s, 'decay_steps', t.decay_steps, 1, 200000);
    num(s, 'max_sec', t.max_sec, 1, 300);
    intNum(s, 'num_workers', t.num_workers, 0, 16);
    intNum(s, 'max_eval_sample', t.max_eval_sample, 1, 100);
    // S2 advanced / expert
    intNum(s, 's2_seed', t.s2_seed, 0, 999999);
    intNum(s, 'log_interval', t.log_interval, 1, 10000);
    intNum(s, 'eval_interval', t.eval_interval, 1, 10000);
    bool(s, 'fp16_run', t.fp16_run);
    num(s, 'lr_decay', t.lr_decay, 0.9, 1);
    intNum(s, 'segment_size', t.segment_size, 1024, 65536);
    num(s, 'c_mel', t.c_mel, 1, 100);
    num(s, 'c_kl', t.c_kl, 0.1, 10);
    num(s, 'text_low_lr_rate', t.text_low_lr_rate, 0.01, 1);
    bool(s, 'grad_ckpt', t.grad_ckpt);
  }
  if (custom.steps) {
    safe.steps = {};
    if (custom.steps.slice && custom.steps.slice.params) {
      const p = custom.steps.slice.params;
      const sp = (safe.steps.slice = { params: {} }).params;
      num(sp, 'min_duration_sec', p.min_duration_sec, 1, 30);
      num(sp, 'max_duration_sec', p.max_duration_sec, 1, 60);
      num(sp, 'silence_threshold_db', p.silence_threshold_db, -60, 0);
      num(sp, 'min_silence_sec', p.min_silence_sec, 0.1, 5);
    }
    if (custom.steps.asr && custom.steps.asr.params) {
      const p = custom.steps.asr.params;
      const ap = (safe.steps.asr = { params: {} }).params;
      oneOf(ap, 'engine', p.engine, ['auto', 'funasr', 'faster-whisper']);
      oneOf(ap, 'model_size', p.model_size,
        ['large-v3-turbo', 'large-v3', 'large', 'medium', 'small', 'tiny', 'distil-large-v3']);
      oneOf(ap, 'precision', p.precision, ['float16', 'float32', 'int8']);
    }
    if (custom.steps.denoise && custom.steps.denoise.params) {
      safe.steps.denoise = { params: {} };
      const m = custom.steps.denoise.params.model;
      if (typeof m === 'string' && m.length < 50) safe.steps.denoise.params.model = m;
    }
  }
  return safe;
}

// Training data must live under this root (absolute path)
// Must be configured in production — requests without it are rejected
const TRAIN_DATA_ROOT = process.env.TRAIN_DATA_ROOT || "";

app.post("/api/train/start", requireApiKey, (req, res) => {
  try {
    const { voiceId: rawVoiceId, language, inputDir, steps: stepOptions, customParams, overwrite } = req.body || {};
    if (!rawVoiceId) return res.status(400).json({ error: "Missing 'voiceId'" });
    if (!language) return res.status(400).json({ error: "Missing 'language'" });
    if (!inputDir) return res.status(400).json({ error: "Missing 'inputDir'" });

    // Overwrite guard: publishing goes to ASSETS_ROOT/<sanitized id> and clobbers
    // whatever is there. If that id already belongs to an existing voice and the
    // caller did not explicitly confirm, refuse — surfacing the DISPLAY NAME so
    // the user recognises what they'd be destroying (e.g. hidden "A_en" behind id
    // "A"). This is the second safety layer behind id-syncing rename.
    const publishId = rawVoiceId.trim().replace(/[^a-zA-Z0-9_\-]/g, "_");
    if (!overwrite) {
      let existingDisplay = null;
      const existDir = path.join(ASSETS_DIR, publishId);
      if (fs.existsSync(existDir)) {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(existDir, "meta.json"), "utf-8"));
          existingDisplay = m.display_name || publishId;
        } catch (_) { existingDisplay = publishId; }
      } else {
        try { const vs = loadVoices(); if (vs[publishId]) existingDisplay = vs[publishId].display_name || publishId; } catch (_) {}
      }
      if (existingDisplay) {
        return res.status(409).json({
          error: `Voice id "${publishId}" already belongs to "${existingDisplay}". Training will overwrite it.`,
          code: "VOICE_EXISTS",
          existingId: publishId,
          existingDisplay,
        });
      }
    }

    // 白名单校验 customParams
    const safeCustom = sanitizeCustomParams(customParams);

    // Validate language
    if (!ALLOWED_LANGUAGES.has(language)) {
      return res.status(400).json({ error: `Invalid language: ${language}. Allowed: ${[...ALLOWED_LANGUAGES].join(", ")}` });
    }

    // Validate inputDir. If TRAIN_DATA_ROOT is configured (distribution/hardened
    // mode) the directory must live under it; otherwise (local workbench) any
    // existing directory is allowed.
    const resolved = path.resolve(inputDir);
    if (TRAIN_DATA_ROOT) {
      const root = path.resolve(TRAIN_DATA_ROOT);
      if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        return res.status(400).json({ error: "inputDir must be under TRAIN_DATA_ROOT" });
      }
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.status(400).json({ error: "inputDir does not exist or is not a directory" });
    }

    console.log(`[TRAIN] Creating pipeline: voiceId=${rawVoiceId}, lang=${language}`);
    const pipeline = trainingPipeline.createPipeline({
      voiceId: rawVoiceId.trim().replace(/[^a-zA-Z0-9_\-]/g, '_'),
      language,
      inputDir,
      stepOptions: stepOptions || {},
      customParams: safeCustom,
    });
    console.log(`[TRAIN] Pipeline created: ${pipeline.id}`);

    // 异步启动，不等待完成
    pipeline.start().catch(err => console.error("[TRAINING] Pipeline error:", err));
    console.log(`[TRAIN] Pipeline started, sending response`);

    res.json({ ok: true, taskId: pipeline.id });
    console.log(`[TRAIN] Response sent`);
  } catch (err) {
    console.error("[TRAIN] Error:", err);
    res.status(500).json({ error: clientError(err) });
  }
});

app.get("/api/train/status/:id", (req, res) => {
  const st = trainingPipeline.getStatusById(req.params.id);
  if (!st) return res.status(404).json({ error: "Task not found" });
  res.json(st);
});

app.post("/api/train/cancel/:id", requireApiKey, (req, res) => {
  const task = trainingPipeline.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  task.cancel();
  res.json({ ok: true });
});

app.get("/api/train/logs/:id", (req, res) => {
  const logs = trainingPipeline.getLogsById(req.params.id);
  if (logs === null) return res.status(404).json({ error: "Task not found" });
  res.json({ logs });
});

app.get("/api/train/tasks", (req, res) => {
  res.json({ tasks: trainingPipeline.getAllTasks() });
});

// POST /api/train/clear-staging — 清除训练暂存目录 (.staging) 中已结束的任务工作区。
// 只删除非运行中的任务：内存里活跃的任务 + task.json 标记为 running/pending 的都会被保护。
app.post("/api/train/clear-staging", requireApiKey, (req, res) => {
  try {
    const STAGING_ROOT = trainingPipeline.STAGING_ROOT;
    if (!STAGING_ROOT || !fs.existsSync(STAGING_ROOT)) {
      return res.json({ ok: true, removed: 0, bytes: 0, skipped: 0 });
    }

    // 收集受保护的任务 id：内存中处于 running/pending 状态的任务。
    const protectedIds = new Set();
    for (const t of trainingPipeline.getAllTasks()) {
      if (t && (t.status === 'running' || t.status === 'pending')) protectedIds.add(t.id);
    }

    const dirSize = (dir) => {
      let total = 0;
      const stack = [dir];
      while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const p = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(p);
          else { try { total += fs.statSync(p).size; } catch (_) {} }
        }
      }
      return total;
    };

    let removed = 0, bytes = 0, skipped = 0;
    for (const entry of fs.readdirSync(STAGING_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(STAGING_ROOT, entry.name);
      if (protectedIds.has(entry.name)) { skipped++; continue; }

      // 二级保护：task.json 标记为运行中/待处理的目录不删。
      const taskJson = path.join(dir, 'task.json');
      if (fs.existsSync(taskJson)) {
        try {
          const data = JSON.parse(fs.readFileSync(taskJson, 'utf-8'));
          if (data.status === 'running' || data.status === 'pending') { skipped++; continue; }
        } catch (_) { /* 损坏的 task.json 视为可清理 */ }
      }

      try {
        bytes += dirSize(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch (e) {
        skipped++;
        console.error(`[CLEAR-STAGING] 删除失败 ${dir}:`, e.message);
      }
    }

    console.log(`[CLEAR-STAGING] 清除 ${removed} 个暂存目录, 释放 ${bytes} 字节, 跳过 ${skipped}`);
    res.json({ ok: true, removed, bytes, skipped });
  } catch (err) {
    console.error("[CLEAR-STAGING] Error:", err);
    res.status(500).json({ error: clientError(err) });
  }
});

// ===========================
//  SERVE REACT FRONTEND
// ===========================

app.use(express.static(WEB_DIST));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/outputs/") || req.path.startsWith("/v1/")) {
    return res.status(404).json({ error: "Not found" });
  }
  const indexHtml = path.join(WEB_DIST, "index.html");
  if (fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml);
  } else {
    res.status(404).send("Frontend not built. Run: cd web && npm install && npm run build");
  }
});

// ---- 断电恢复：扫描暂存目录中的未完成任务 ----
function scanStagingTasks() {
  const { STAGING_ROOT } = require('./lib/paths');
  if (!fs.existsSync(STAGING_ROOT)) return;
  try {
    const entries = fs.readdirSync(STAGING_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskJson = path.join(STAGING_ROOT, entry.name, 'task.json');
      if (!fs.existsSync(taskJson)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(taskJson, 'utf-8'));
        if (data.status === 'running' || data.status === 'pending') {
          data.status = 'interrupted';
          data.finishedAt = new Date().toISOString();
          fs.writeFileSync(taskJson, JSON.stringify(data, null, 2), 'utf-8');
          console.log(`[RECOVERY] 任务 ${data.id} (${data.voiceId}) 标记为 interrupted`);
        }
      } catch (e) {
        // 忽略损坏的 task.json
      }
    }
  } catch (e) {
    console.error('[RECOVERY] 扫描暂存目录失败:', e.message);
  }
}

// ---- Start ----
app.listen(PORT, HOST, () => {
  console.log(`\n========================================`);
  console.log(`  TTS Voice Asset Manager`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  ffmpeg: ${checkFfmpeg() ? "available" : "not found (using pure-Node concat)"}`);
  if (!API_KEY) {
    console.log(`\n  ⚠️  WARNING: API_KEY not configured. All write/delete/execute endpoints are BLOCKED.`);
    console.log(`  Set environment variable API_KEY to enable write operations.`);
  }
  console.log(`========================================\n`);

  // 扫描暂存目录中的未完成任务（断电恢复）
  scanStagingTasks();

  // 自动扫描资产:首次启动/缺少 meta.json 时生成元数据,
  // 避免侧边栏 GPT/SoVITS 红叉与 "voice not found"(无需手动 scan all)。
  (async () => {
    try {
      if (assetsNeedScan()) {
        console.log("[ASSETS] 检测到声音缺少 meta.json/segments.json,启动时自动扫描...");
        const results = await runFullAssetScan();
        console.log(`[ASSETS] 自动扫描完成:${Object.keys(results).length} 个声音已就绪`);
      } else {
        console.log("[ASSETS] 资产元数据已就绪,跳过自动扫描");
      }
    } catch (e) {
      console.error("[ASSETS] 启动自动扫描失败:", e.message);
    }
  })();
});
