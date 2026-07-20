const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const http = require("http");
const { execSync, spawn, execFileSync } = require("child_process");
const os = require("os");
const multer = require("multer");

const { ASSETS_ROOT, ASSETS_ROOT_SOURCE, CONFIG_FILE, readConfig, writeConfig } = require('./lib/paths');
const { getPythonPath, getCleanEnv } = require('./lib/training/python_helper');

const app = express();
// Environment-driven config with backward-compatible defaults
const PORT = parseInt(process.env.BROKER_PORT || process.env.PORT || "9886", 10);
const HOST = process.env.BROKER_HOST || process.env.HOST || "127.0.0.1";
const API_KEY = process.env.API_KEY || process.env.BROKER_API_KEY || "";
const GPT_SOVITS_BASE_URL = process.env.GPT_SOVITS_BASE_URL || "http://127.0.0.1:9880";

const APP_DIR = __dirname;
const VOICES_JSON = path.join(APP_DIR, "voices.json");
const OUTPUT_DIR = path.join(APP_DIR, "outputs");
// Per-source output roots. Only "generate" is written this round; the
// compare/broker folders are reserved for later assetization work.
const GENERATE_DIR = path.join(OUTPUT_DIR, "generate");
// Per-source output roots are physically separated so generate / compare-refs /
// broker histories never mix (locked 2026-07-07).
const COMPARE_DIR = path.join(OUTPUT_DIR, "comparerefs");
const BROKER_DIR = path.join(OUTPUT_DIR, "broker");
const VOICES_DIR = path.join(APP_DIR, "voices");
const BACKUP_DIR = path.join(APP_DIR, "backups");
// Recipes are first-class reusable presets stored in one flat folder as
// recipe_{voiceId}_{name}.json (source of truth = JSON content).
const RECIPES_DIR = path.join(APP_DIR, "recipes");
const WEB_DIST = path.join(APP_DIR, "web", "dist");
const ASSETS_DIR = ASSETS_ROOT;

for (const d of [OUTPUT_DIR, GENERATE_DIR, COMPARE_DIR, BROKER_DIR, VOICES_DIR, BACKUP_DIR, RECIPES_DIR, ASSETS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const { createRecipeStore } = require("./lib/recipeStore");
const recipeStore = createRecipeStore(RECIPES_DIR);

// Asset scanner
const assetScanner = require("./lib/assetScanner");
// Canonical voice-id generation/reservation (Option A: display/id decoupling)
// and version-aware managed-path resolver (recipe schema v3 portability).
const assetId = require("./lib/assetId");
const pathResolver = require("./lib/pathResolver");
// Explicit, assisted v2→v3 recipe path migration (never runs at startup/scan).
const { createMigrator } = require("./lib/recipeMigration");
const recipeMigrator = createMigrator({ recipesDir: RECIPES_DIR, appDir: APP_DIR, assetsRoot: ASSETS_ROOT });
// In-place ASR kernel (shared with the training pipeline) + training defaults, used
// by the lightweight Assets "generate reference text" recovery (does NOT promote).
const { runAsr } = require("./lib/training/steps/asr");
const { loadTrainingConfig } = require("./lib/training/config");
// voiceId → { status, startedAt, finishedAt, sources, done, error, logs } for the
// in-place transcribe jobs. In-memory only (best-effort progress, like training).
const transcribeJobs = new Map();

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

// Cross-platform "custom reference audio" picker: an arbitrary clip uploaded from
// the browser (no native OS dialog needed) and stored under voices/custom_refs so
// it can serve as ref_audio for ANY voice. Kept separate from `storage` because
// that names files by req.params.id, which custom refs don't have.
const CUSTOM_REF_DIR = path.join(VOICES_DIR, "custom_refs");
try { fs.mkdirSync(CUSTOM_REF_DIR, { recursive: true }); } catch (_) {}
const customRefStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CUSTOM_REF_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "ref";
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});
const customRefUpload = multer({
  storage: customRefStorage,
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

// ---- Static: voices/ for reference-audio playback (uploaded + custom refs) ----
app.use("/voices", (req, res, next) => {
  const rel = decodeURIComponent(req.path).replace(/^[\/]+/, "").replace(/\.\.[\\/]/g, "");
  const decoded = path.join(VOICES_DIR, rel);
  if (!decoded.startsWith(VOICES_DIR + path.sep) && decoded !== VOICES_DIR) {
    return res.status(404).end();
  }
  express.static(VOICES_DIR)(req, res, next);
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
  // Absolute paths (POSIX "/…", Windows "X:\…" or forward-slashed "X:/…") are
  // returned as-is; only project-relative paths are joined to APP_DIR.
  if (raw.startsWith("/") || raw.includes(":\\") || /^[a-zA-Z]:\//.test(raw)) return raw;
  return path.join(APP_DIR, raw).replace(/\\/g, "/");
}

// Inverse of resolveRefPath: turn an absolute (browsed) path into a project-
// relative, forward-slash path. Returns null when the path escapes the project
// root (APP_DIR) so the Broker page can reject non-portable model picks (PC-3).
function toProjectRelative(abs) {
  if (!abs) return null;
  let rel = path.relative(APP_DIR, path.resolve(abs));
  rel = rel.replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return null;
  return rel;
}

// Normalize a model path picked for a recipe (gpt_ckpt / sovits_pth). Already-
// relative paths are kept; absolute paths INSIDE the project are converted to a
// project-relative form (portable). Absolute paths OUTSIDE the project are only
// allowed when the caller explicitly confirms (PC-3, allowExternal): they are
// stored verbatim as an absolute path, which pins the recipe to this machine —
// the original file must not be moved and the recipe is no longer self-portable
// (the user must ship those model files alongside the recipe).
function normalizeModelPath(raw, opts) {
  if (!raw) return { ok: true, value: "", external: false };
  const allowExternal = !!(opts && opts.allowExternal);
  const s = String(raw).replace(/\\/g, "/");
  const isAbs = s.startsWith("/") || /^[a-zA-Z]:\//.test(s) || raw.includes(":\\");
  if (!isAbs) {
    if (s.includes("..")) return { ok: false, code: "invalid", error: "model path must not contain '..'" };
    return { ok: true, value: s, external: false };
  }
  const rel = toProjectRelative(raw);
  if (rel) return { ok: true, value: rel, external: false };
  // Outside the project.
  if (!allowExternal) {
    return {
      ok: false,
      code: "external",
      error: "model file is outside the project — it will be pinned as an absolute path (not portable). Confirm to proceed, or copy it under assets/ first.",
    };
  }
  return { ok: true, value: s, external: true };
}

// Patch #11 (R3): a "custom" reference upload lands in APP_DIR/voices/custom_refs
// (a temp area OUTSIDE ASSETS_ROOT). Persisting that raw path into a v3 recipe
// would be mislabeled as an ASSETS_ROOT asset (classifyManagedPath treats a bare
// relative path as asset-relative) → the recipe resolves to a non-existent file
// and is non-portable. When saving a v3 recipe we therefore IMPORT the temp file
// into the voice's managed assets (ASSETS_ROOT/<role>/custom_refs/<fn>) and
// return an assets-relative path, so it becomes a genuine { base:'asset' } ref.
// Non-custom paths (this-voice slices/raw, cross-voice, already-imported, v3
// objects) pass through unchanged.
function importCustomRefToAsset(rawPath, role) {
  if (rawPath == null || typeof rawPath !== "string" || rawPath === "" || !role) return rawPath;
  const norm = rawPath.replace(/\\/g, "/").replace(/^\.?\//, "");
  let abs = null;
  if (/^voices\/custom_refs\//.test(norm)) {
    abs = path.join(APP_DIR, norm);
  } else if (rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath)) {
    const resolved = path.resolve(rawPath);
    const rel = path.relative(CUSTOM_REF_DIR, resolved).replace(/\\/g, "/");
    if (rel && !rel.startsWith("../") && rel !== ".." && !path.isAbsolute(rel)) abs = resolved;
  }
  if (!abs || !fs.existsSync(abs)) return rawPath; // not a temp custom ref (or gone) — leave as-is
  const fn = path.basename(abs);
  const destDir = path.join(ASSETS_ROOT, role, "custom_refs");
  fs.mkdirSync(destDir, { recursive: true });
  let destName = fn;
  let dest = path.join(destDir, destName);
  // Collision-safe: reuse an identical existing import; otherwise disambiguate.
  if (fs.existsSync(dest) && fs.statSync(dest).size !== fs.statSync(abs).size) {
    const ext = path.extname(fn);
    destName = `${path.basename(fn, ext)}_${Date.now().toString(36)}${ext}`;
    dest = path.join(destDir, destName);
  }
  if (!fs.existsSync(dest)) fs.copyFileSync(abs, dest);
  return `${role}/custom_refs/${destName}`; // assets-root-relative → classified as {base:'asset'}
}

// v3 recipe path classification. Rewrites the four managed fields on a recipe
// create/update body into structured { base, path } objects with field-aware
// external permissions (models honour allow_external_models; reference/aux audio
// honour a SEPARATE allow_external_audio, default OFF — models never authorize
// external audio). Legacy (v2) targets keep string paths so a v2 recipe is never
// silently migrated to v3 on a plain edit/rebind. `targetV3` decides which.
function classifyRecipeManagedFields(body, { targetV3, allowExternalModels, allowExternalAudio, role }) {
  if (!targetV3) {
    // Legacy string handling (unchanged): only models are normalized; audio
    // strings are left for recipeStore's project-relative guard.
    for (const key of ["gpt_ckpt", "sovits_pth"]) {
      if (body[key] != null && body[key] !== "") {
        const n = normalizeModelPath(body[key], { allowExternal: allowExternalModels });
        if (!n.ok) return { ok: false, error: `${key}: ${n.error}`, code: n.code, field: key };
        body[key] = n.value;
      }
    }
    return { ok: true };
  }
  const model = { field: "model", allowExternalModels, allowExternalAudio };
  const audio = { field: "audio", allowExternalModels, allowExternalAudio };
  // R3: import any temp custom-ref uploads into the voice's managed assets before
  // classifying, so they persist as portable { base:'asset' } references rather
  // than mislabeled non-portable paths. Applies to the main reference and aux.
  if (role) {
    if (typeof body.reference_audio === "string") {
      body.reference_audio = importCustomRefToAsset(body.reference_audio, role);
    }
    if (body.params && Array.isArray(body.params.aux_ref_audio_paths)) {
      body.params.aux_ref_audio_paths = body.params.aux_ref_audio_paths
        .map((p) => (typeof p === "string" ? importCustomRefToAsset(p, role) : p));
    }
  }
  for (const [key, opts] of [["gpt_ckpt", model], ["sovits_pth", model], ["reference_audio", audio]]) {
    if (body[key] != null && body[key] !== "") {
      const c = pathResolver.classifyManagedPath(body[key], opts);
      if (!c.ok) return { ok: false, error: `${key}: ${c.error}`, code: c.code, field: key };
      body[key] = c.value;
    }
  }
  // Auxiliary reference audio array (lives under params).
  const aux = body.params && Array.isArray(body.params.aux_ref_audio_paths)
    ? body.params.aux_ref_audio_paths : null;
  if (aux) {
    const out = [];
    for (const p of aux) {
      if (p == null || p === "") continue;
      const c = pathResolver.classifyManagedPath(p, audio);
      if (!c.ok) return { ok: false, error: `aux_ref_audio_paths: ${c.error}`, code: c.code, field: "aux_ref_audio_paths" };
      out.push(c.value);
    }
    body.params.aux_ref_audio_paths = out;
  }
  return { ok: true };
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
let _ffmpegPath = "ffmpeg";

// Resolve the ffmpeg executable, preferring a project-local static build
// provisioned by download_ffmpeg.py (vendor/ffmpeg/<platform>/ffmpeg[.exe]).
// This keeps ffmpeg self-contained per project — no PATH / global install
// required. Falls back to a system ffmpeg on PATH when no vendored copy exists.
function vendoredFfmpegPath() {
  const isWin = process.platform === "win32";
  const arch = process.arch; // "x64" | "arm64" | ...
  const bin = isWin ? "ffmpeg.exe" : "ffmpeg";
  const keys = [];
  if (isWin) {
    keys.push("windows-x86_64");
  } else if (process.platform === "linux") {
    keys.push(arch === "arm64" ? "linux-aarch64" : "linux-x86_64");
  } else if (process.platform === "darwin") {
    keys.push(arch === "arm64" ? "darwin-arm64" : "darwin-x86_64");
  }
  for (const k of keys) {
    const p = path.join(APP_DIR, "vendor", "ffmpeg", k, bin);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The absolute (or PATH) command used to invoke ffmpeg. Callers should use this
// instead of a hardcoded "ffmpeg" so the vendored binary is honored.
function ffmpegCmd() {
  checkFfmpeg();
  return _ffmpegPath;
}

function checkFfmpeg() {
  if (_ffmpegChecked) return _ffmpegAvailable;
  _ffmpegChecked = true;
  const vendored = vendoredFfmpegPath();
  const candidate = vendored || "ffmpeg";
  try {
    execFileSync(candidate, ["-version"], { stdio: "ignore", timeout: 5000 });
    _ffmpegAvailable = true;
    _ffmpegPath = candidate;
    if (vendored) console.log(`[ffmpeg] using project-local build: ${vendored}`);
  } catch {
    _ffmpegAvailable = false;
  }
  return _ffmpegAvailable;
}

// ===========================
//  CUDA / GPU DETECTION
// ===========================
// Probes the project venv's torch ONCE (asynchronously) for CUDA availability +
// device info and caches the result. Powers the right-hand-corner status light
// and the training pre-flight warnings (no-GPU block / low-VRAM notice). We do
// NOT auto-tune any training params from this — it is advisory only.
//
// The probe runs via async spawn (never execFileSync) so importing torch — which
// can take several seconds — does not block Node's event loop / other requests.
// `ready:false` until the probe resolves; callers should treat "not ready" as
// "unknown" (don't gate on it). Any failure (no venv yet, torch missing, timeout)
// degrades to "CUDA unavailable" so /api/health always answers.
let _cudaProbeStarted = false;
let _cudaInfo = { ready: false, available: false, device_name: null, vram_gb: null };

function startCudaProbe() {
  if (_cudaProbeStarted) return;
  _cudaProbeStarted = true;
  let py;
  try { py = getPythonPath(); } catch { py = "python"; }
  // Emit a single JSON line so parsing is unaffected by any torch warnings.
  const probe = [
    "import json",
    "o={'available':False,'device_name':None,'vram_gb':None}",
    "try:",
    "    import torch",
    "    if torch.cuda.is_available():",
    "        p=torch.cuda.get_device_properties(0)",
    "        o['available']=True",
    "        o['device_name']=p.name",
    "        o['vram_gb']=round(p.total_memory/(1024**3),1)",
    "except Exception:",
    "    pass",
    "print('CUDA_PROBE='+json.dumps(o))",
  ].join("\n");

  let child;
  try {
    child = spawn(py, ["-c", probe], { env: getCleanEnv() });
  } catch {
    _cudaInfo = { ready: true, available: false, device_name: null, vram_gb: null };
    return;
  }
  let buf = "";
  const finish = (info) => {
    _cudaInfo = { ready: true, ...info };
    if (_cudaInfo.available) {
      console.log(`[cuda] ${_cudaInfo.device_name} (${_cudaInfo.vram_gb}GB)`);
    } else {
      console.log("[cuda] not available — inference will run on CPU; fine-tuning is not recommended");
    }
  };
  const kill = setTimeout(() => { try { child.kill(); } catch {} }, 30000);
  child.stdout.on("data", (d) => { buf += d.toString(); });
  child.on("error", () => { clearTimeout(kill); finish({ available: false, device_name: null, vram_gb: null }); });
  child.on("close", () => {
    clearTimeout(kill);
    try {
      const m = /CUDA_PROBE=(\{.*\})/.exec(buf);
      if (m) {
        const p = JSON.parse(m[1]);
        return finish({ available: !!p.available, device_name: p.device_name || null, vram_gb: p.vram_gb ?? null });
      }
    } catch {}
    finish({ available: false, device_name: null, vram_gb: null });
  });
}

function detectCuda() {
  startCudaProbe();
  return _cudaInfo;
}

// PH: OpenAI /v1/audio/speech response formats. WAV is the lossless default and
// needs no ffmpeg (the engine already emits WAV). The others are produced by
// transcoding the engine's WAV bytes through the system ffmpeg; when ffmpeg is
// absent the broker strictly rejects non-WAV requests (see /v1/audio/speech)
// rather than silently shipping WAV under a mismatched Content-Type.
const AUDIO_FORMATS = {
  wav:  { ext: "wav",  mime: "audio/wav",  ffmpeg: null },
  mp3:  { ext: "mp3",  mime: "audio/mpeg", ffmpeg: ["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"] },
  opus: { ext: "opus", mime: "audio/opus", ffmpeg: ["-c:a", "libopus", "-b:a", "64k", "-f", "opus"] },
  aac:  { ext: "aac",  mime: "audio/aac",  ffmpeg: ["-c:a", "aac", "-b:a", "192k", "-f", "adts"] },
  flac: { ext: "flac", mime: "audio/flac", ffmpeg: ["-c:a", "flac", "-f", "flac"] },
};

// Transcode WAV bytes to a target format via system ffmpeg. Returns the encoded
// Buffer. Uses a temp working directory (some ffmpeg muxers can't stream to a
// pipe). Throws on failure so callers can decide how to degrade.
function transcodeAudio(wavBuffer, targetFmt) {
  const spec = AUDIO_FORMATS[targetFmt];
  if (!spec || !spec.ffmpeg) return wavBuffer; // wav or unknown → passthrough
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-xcode-"));
  const inPath = path.join(tmpDir, "in.wav");
  const outPath = path.join(tmpDir, `out.${spec.ext}`);
  try {
    fs.writeFileSync(inPath, wavBuffer);
    execFileSync(ffmpegCmd(), ["-hide_banner", "-loglevel", "error", "-y", "-i", inPath, ...spec.ffmpeg, outPath], { timeout: 30000 });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
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

    const child = spawn(ffmpegCmd(), ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", outputPath], { stdio: "pipe" });
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
  "pron_overrides",
  "auto_base_lang",
  "lang_overrides",
];

// Reproducibility: turn a random-seed request (-1 / empty / null / invalid) into a
// CONCRETE seed in the engine's range [0, 2^32-1]. Resolving here — before the engine
// call AND before writing meta.json — means the exact seed used is recorded, so a later
// Rerun replays the identical value and reproduces the same audio. A valid non-negative
// integer is passed through unchanged. Mirrors the engine's set_seed(-1) randomisation
// range, so behaviour is unchanged except the value is now captured instead of lost.
function resolveSeed(seed) {
  const n = typeof seed === "number" ? seed : parseInt(seed, 10);
  return (Number.isInteger(n) && n >= 0) ? n : Math.floor(Math.random() * 0x100000000);
}

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

  // Auxiliary references → absolute paths (Patch #11): resolve each aux entry the
  // SAME way as the main reference so live generate no longer relies on the
  // engine's cwd coinciding with APP_DIR. Accepts legacy strings and v3
  // { base, path } objects; drops anything missing on this machine.
  if (Array.isArray(payload.aux_ref_audio_paths) && payload.aux_ref_audio_paths.length) {
    payload.aux_ref_audio_paths = payload.aux_ref_audio_paths
      .map((p) => {
        if (p && typeof p === "object") {
          const r = pathResolver.resolveManagedRef(p, {});
          return r.ok ? r.path : "";
        }
        return resolveRefPath(p);
      })
      .filter((p) => p && fs.existsSync(p));
    if (payload.aux_ref_audio_paths.length === 0) delete payload.aux_ref_audio_paths;
  }

  return payload;
}

// ===========================
//  GENERATION CORE
// ===========================

async function switchModels(cfg) {
  // 切权重必须成功后才推理: 失败则抛错, 避免静默地用旧/半加载模型合成 (错声音/异常)。
  if (cfg.gpt_model) {
    const r = await gsvGet("/set_gpt_weights", { weights_path: cfg.gpt_model });
    if (r.statusCode >= 400) {
      const msg = r.body ? r.body.toString() : "";
      console.error("set_gpt_weights failed:", msg);
      throw new Error(`set_gpt_weights failed (${r.statusCode}): ${msg}`);
    }
  }
  if (cfg.sovits_model) {
    const r = await gsvGet("/set_sovits_weights", { weights_path: cfg.sovits_model });
    if (r.statusCode >= 400) {
      const msg = r.body ? r.body.toString() : "";
      console.error("set_sovits_weights failed:", msg);
      throw new Error(`set_sovits_weights failed (${r.statusCode}): ${msg}`);
    }
  }
}

async function generateOneSegment(segmentText, cfg) {
  const payload = buildTtsPayload(segmentText, cfg);
  // aux_ref_audio_paths is resolved (to absolute, existence-filtered) inside
  // buildTtsPayload (Patch #11); do NOT re-inject the raw cfg value here or the
  // resolved paths would be clobbered back to project-relative on live generate.
  for (const key of ["sample_steps", "if_sr"]) {
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
    cuda: detectCuda(),
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

// ============================================================
// 读音校对 / Pronunciation proofing (task6)
// 词典 = 用户运行时资产，不入 git（见 .gitignore: data/pron_lexicon/）
// ============================================================
const PRON_LEXICON_DIR = path.join(APP_DIR, "data", "pron_lexicon");

function pronLexiconPath(lang) {
  const safe = String(lang || "zh").toLowerCase().replace(/[^a-z_]/g, "") || "zh";
  return path.join(PRON_LEXICON_DIR, safe + ".json");
}

function loadPronLexicon(lang) {
  try {
    const p = pronLexiconPath(lang);
    if (!fs.existsSync(p)) return {};
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return (data && typeof data === "object" && !Array.isArray(data)) ? data : {};
  } catch (e) {
    console.error("[pron] load lexicon failed:", e.message);
    return {};
  }
}

function savePronLexicon(lang, data) {
  fs.mkdirSync(PRON_LEXICON_DIR, { recursive: true });
  const p = pronLexiconPath(lang);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
  return data;
}

// 预览：文本 -> 逐词逐字读音 + 候选（代理到引擎 /pron/preview，复用已加载 g2pW）
app.post("/api/pron/preview", async (req, res) => {
  const body = req.body || {};
  const text = (body.text || "").toString();
  const lang = (body.lang || "zh").toString();
  if (!text) return res.json({ lang, norm_text: "", tokens: [] });
  try {
    const r = await gsvPost("/pron/preview", { text, lang });
    let payload;
    try { payload = JSON.parse(r.body.toString("utf-8")); }
    catch (e) { payload = { message: "bad preview response" }; }
    return res.status(r.statusCode || 200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: clientError(e, "pron preview failed (engine offline?)") });
  }
});

// 读词典
app.get("/api/pron/lexicon", (req, res) => {
  const lang = (req.query.lang || "zh").toString();
  return res.json({ lang, entries: loadPronLexicon(lang) });
});

// 写/更新一条词典项 {lang, word, pinyins:[...]}
app.post("/api/pron/lexicon", requireApiKey, (req, res) => {
  const body = req.body || {};
  const lang = (body.lang || "zh").toString();
  const word = (body.word || "").toString().trim();
  const pinyins = Array.isArray(body.pinyins) ? body.pinyins.map(String) : null;
  if (!word) return res.status(400).json({ error: "Missing 'word'" });
  if (!pinyins || !pinyins.length) return res.status(400).json({ error: "Missing 'pinyins'" });
  try {
    const data = loadPronLexicon(lang);
    data[word] = pinyins;
    savePronLexicon(lang, data);
    return res.json({ ok: true, lang, word, pinyins, entries: data });
  } catch (e) {
    return res.status(500).json({ error: clientError(e, "save lexicon failed") });
  }
});

// 删除一条词典项（word/lang 支持 query 或 body）
app.delete("/api/pron/lexicon", requireApiKey, (req, res) => {
  const body = req.body || {};
  const lang = ((req.query.lang || body.lang) || "zh").toString();
  const word = ((req.query.word || body.word) || "").toString().trim();
  if (!word) return res.status(400).json({ error: "Missing 'word'" });
  try {
    const data = loadPronLexicon(lang);
    delete data[word];
    savePronLexicon(lang, data);
    return res.json({ ok: true, lang, word, entries: data });
  } catch (e) {
    return res.status(500).json({ error: clientError(e, "delete lexicon failed") });
  }
});

app.get("/api/voices", (req, res) => {
  try {
    const data = loadVoices();
    const voices = Object.entries(data).map(([id, cfg]) => ({
      id, display_name: cfg.display_name || id,
      language: cfg.language || cfg.text_lang || "unknown",
    }));
    // Surface the built-in Base model voice (default) alongside the disk roster.
    voices.unshift({ id: BASE_VOICE_ID, display_name: BASE_VOICE_DISPLAY, language: "auto", builtin: true });
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
    source, voice_label,
    pron_overrides, auto_base_lang, lang_overrides,
  } = req.body || {};
  if (!voice) return res.status(400).json({ error: "Missing 'voice' field" });
  if (!text) return res.status(400).json({ error: "Missing 'text' field" });
  if (text.length > 5000) return res.status(400).json({ error: "Text too long (max 5000 chars)" });

  // Validate voice exists (registration check only)
  let voices;
  try { voices = loadVoices(); } catch (err) { return res.status(500).json({ error: clientError(err, "voices.json error") }); }
  // The built-in Base model voice is not in voices.json; resolve it in-memory so
  // zero-shot inference on the pretrained weights works without a fine-tuned asset.
  const voiceReg = voices[voice] || (isBaseVoice(voice) ? baseVoiceReg() : null);
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
    seed: resolveSeed(seed),
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
    // 读音校对（task6）：本次合成的词粒度读音覆盖，仅在非空对象时透传给引擎
    pron_overrides: (pron_overrides && typeof pron_overrides === "object" && !Array.isArray(pron_overrides) && Object.keys(pron_overrides).length) ? pron_overrides : undefined,
    // Auto (Multilingual): kana-free CJK fallback language (voice metadata language).
    auto_base_lang: auto_base_lang || undefined,
    // Per-character language overrides for shared Han characters ({substring -> lang}).
    lang_overrides: (lang_overrides && typeof lang_overrides === "object" && !Array.isArray(lang_overrides) && Object.keys(lang_overrides).length) ? lang_overrides : undefined,
  };

  const shouldSplit = split !== false;
  const shouldConcat = concat !== false;
  const softLimit = Math.max(10, parseInt(max_chars, 10) || 45);
  const silenceMs = Math.min(2000, Math.max(0, parseInt(silence_ms, 10) || 300));
  // Engine only returns WAV; format param is accepted for API compatibility but always produces wav
  const mediaType = "wav";
  const genId = newGenId();
  const genSource = normSource(source);
  const genDir = genAssetDir(genId, genSource);
  fs.mkdirSync(genDir, { recursive: true });
  const genUrlBase = `/outputs/${genSource}/${genId}`;
  // Optional association back to a saved recipe (P3): the OpenAI endpoint and any
  // recipe-driven generation stamp `recipe_id` so the Broker page + history can
  // link an output to the recipe that produced it.
  const genRecipeId = (req.body && typeof req.body.recipe_id === "string") ? req.body.recipe_id : null;
  // Batch grouping: Compare Refs (and any future multi-output run) tags every
  // member generation with a shared batch id, so a single "Generate All" is
  // recorded as ONE comparison batch — you can see how many audios it produced
  // and which reference each used, instead of a flat pile indistinguishable from
  // one-off inference. Batches are reconstructed by grouping member meta.json
  // (see GET /api/outputs/batches); no separate manifest file to drift out of sync.
  const genBatch = (() => {
    const b = req.body || {};
    const id = (typeof b.batch_id === "string" && b.batch_id.trim()) ? b.batch_id.trim().slice(0, 80) : null;
    if (!id) return null;
    const toInt = (v) => (Number.isInteger(v) ? v : (parseInt(v, 10) || 0));
    return { id, seq: toInt(b.batch_seq), total: toInt(b.batch_total),
      label: (typeof b.batch_label === "string") ? b.batch_label.slice(0, 200) : "" };
  })();
  // The captured recipe (for Rerun) must NOT carry batch fields, or a rerun would
  // silently re-join a stale batch. Strip them; batch lives only under meta.batch.
  const { batch_id: _bid, batch_seq: _bseq, batch_total: _btot, batch_label: _blbl,
    ...recipeBody } = (req.body || {});
  // Shared audit fields; each branch adds split/concat/segments/audio_url/files.
  const metaBase = {
    id: genId, source: genSource, createdAt: Date.now(),
    voice, voiceLabel: voice_label || voice, text, lang: cfg.text_lang,
    gpt: genBaseName(cfg.gpt_model) || "—", sovits: genBaseName(cfg.sovits_model) || "—",
    gpt_model: cfg.gpt_model, sovits_model: cfg.sovits_model,
    ref_audio: cfg.reference_audio, ref_text: cfg.reference_text,
    recipe_id: genRecipeId,
    // Batch membership (null for ordinary one-off generations).
    batch: genBatch,
    // Reproducibility: stamp the RESOLVED seed (never -1) into both the top-level audit
    // field and the captured recipe, so Rerun (which replays meta.recipe) reproduces the
    // exact audio instead of re-randomising.
    seed: cfg.seed,
    recipe: { ...recipeBody, seed: cfg.seed }, status: "ok",
  };

  try {
    await withGenerationLock(async () => {
      await switchModels(cfg);

      // Short text or split disabled: single generation
      if (!shouldSplit || text.length <= softLimit) {
        const audioBytes = toPcm16Wav(await generateOneSegment(text, cfg));
        fs.writeFileSync(path.join(genDir, "audio.wav"), audioBytes);
        const audioUrl = `${genUrlBase}/audio.wav`;
        writeGenMeta(genId, { ...metaBase, split: false, concat: false, segments: 1,
          audio_url: audioUrl,
          files: [{ role: "single", name: "audio.wav", url: audioUrl }] });
        console.log(`[OK] Generated: ${genId}/audio.wav (${audioBytes.length} bytes)`);
        return res.json({ ok: true, id: genId, voice, split: false, concat: false, audio_url: audioUrl, seed: cfg.seed });
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
          const audioBytes = toPcm16Wav(await generateOneSegment(segText, cfg));
          const segName = `seg${String(i).padStart(3, "0")}.${mediaType}`;
          const segPath = path.join(genDir, segName);
          fs.writeFileSync(segPath, audioBytes);
          segFiles.push(segPath);
          segResults.push({ index: i, text: segText, audio_url: `${genUrlBase}/${segName}` });
          console.log(`[OK] Segment ${i}: ${genId}/${segName} (${audioBytes.length} bytes)`);
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
        writeGenMeta(genId, { ...metaBase, split: true, concat: false, segments: segResults.length,
          audio_url: first.audio_url,
          files: segResults.map(s => ({ role: "segment", index: s.index, name: genBaseName(s.audio_url), url: s.audio_url })) });
        return res.json({
          ok: true, id: genId, voice, split: true, concat: false,
          audio_url: first.audio_url,
          seed: cfg.seed,
          segments: segResults,
          warning: segFiles.length === 1 ? "Text fit in one segment; no concatenation needed" : undefined,
        });
      }

      // Concatenate
      const combinedName = `combined.${mediaType}`;
      const combinedPath = path.join(genDir, combinedName);

      try {
        const concatResult = await concatWavFiles(segFiles, combinedPath, silenceMs);
        const combinedSize = fs.statSync(combinedPath).size;
        console.log(`[OK] Combined: ${genId}/${combinedName} (${combinedSize} bytes, method: ${concatResult.method})`);

        const combinedUrl = `${genUrlBase}/${combinedName}`;
        // Segment-boundary offsets for the waveform preview's dividers.
        const { bounds: segBounds, duration: segDuration } = computeSegmentBounds(segFiles, silenceMs);
        const segResultsBounded = segResults.map((s, i) => ({ ...s, start: segBounds[i]?.start, end: segBounds[i]?.end }));
        writeGenMeta(genId, { ...metaBase, split: true, concat: true, segments: segResults.length,
          audio_url: combinedUrl, duration: segDuration, segment_bounds: segBounds,
          files: [{ role: "combined", name: combinedName, url: combinedUrl },
            ...segResults.map(s => ({ role: "segment", index: s.index, name: genBaseName(s.audio_url), url: s.audio_url }))] });

        return res.json({
          ok: true, id: genId, voice, split: true, concat: true,
          audio_url: combinedUrl,
          seed: cfg.seed,
          silence_ms: silenceMs,
          concat_method: concatResult.method,
          duration: segDuration,
          segment_bounds: segBounds,
          segments: segResultsBounded,
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

// POST /api/custom-ref-audio — upload an arbitrary reference clip (cross-platform
// custom picker). Not tied to a voice; stored under voices/custom_refs and usable
// as ref_audio for any voice. Returns an engine-resolvable path + a playback URL.
app.post("/api/custom-ref-audio", requireApiKey, (req, res) => {
  customRefUpload.single("audio")(req, res, (err) => {
    if (err) return res.status(400).json({ error: clientError(err, "Upload failed") });
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });
    res.json({
      ok: true,
      path: `voices/custom_refs/${req.file.filename}`,
      url: `/voices/custom_refs/${encodeURIComponent(req.file.filename)}`,
      name: req.file.originalname,
      size: req.file.size,
    });
  });
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

// ===========================
//  GENERATION ASSETS — folder + meta.json per generation (Generate page)
// ===========================
// One /api/generate call = one folder outputs/<source>/<genId>/ holding audio +
// meta.json (audit + recipe for Rerun + source). Management operates by id, so
// Delete removes the whole folder (all segments), not just the combined file.
//
// Outputs are physically separated by source so generate / compare-refs / broker
// histories never mix (locked 2026-07-07). `normSource` maps client-supplied
// source labels to a canonical folder key; unknown values fall back to generate.
const OUTPUT_ROOTS = { generate: GENERATE_DIR, comparerefs: COMPARE_DIR, broker: BROKER_DIR };
function normSource(source) {
  const s = String(source || "generate").toLowerCase();
  if (s === "compare" || s === "comparerefs" || s === "compare_refs") return "comparerefs";
  if (s === "broker" || s === "openai" || s === "speech") return "broker";
  return "generate";
}
function outputRoot(source) { return OUTPUT_ROOTS[normSource(source)]; }

function genAssetDir(genId, source) { return path.join(outputRoot(source), genId); }

function newGenId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${ts}_${rand}`;
}

function genBaseName(p) {
  if (!p || typeof p !== "string") return "";
  return p.replace(/\\/g, "/").split("/").pop();
}

function writeGenMeta(genId, meta, source) {
  const dir = genAssetDir(genId, source || (meta && meta.source));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

// Resolve a client-supplied generation id to its asset folder within the given
// source root, defending against traversal (basename collapse + containment
// re-check). `source` defaults to generate for backward compatibility.
function resolveGenDir(id, source) {
  if (typeof id !== "string" || !id.trim()) return null;
  const base = path.basename(id.replace(/\\/g, "/"));
  if (!base || base === "." || base === "..") return null;
  const root = outputRoot(source);
  const full = path.join(root, base);
  if (!full.startsWith(root + path.sep)) return null;
  return { id: base, full, source: normSource(source) };
}

// Shape a stored meta.json into the client-facing Recent Generations item.
function genItemFromMeta(meta) {
  return {
    id: meta.id,
    source: meta.source || "generate",
    text: meta.text || "",
    voice: meta.voiceLabel || meta.voice || "",
    lang: meta.lang || "",
    gpt: meta.gpt || "\u2014",
    sovits: meta.sovits || "\u2014",
    segments: meta.segments || 1,
    createdAt: meta.createdAt || 0,
    audio_url: meta.audio_url || "",
    recipe_id: meta.recipe_id || null,
    // Batch membership (Compare Refs "Generate All"); null for one-off runs.
    batch: meta.batch || null,
    ref_audio: meta.ref_audio || "",
    // Waveform preview: combined duration + per-segment [start,end] boundary offsets
    // (seconds) so history/reloaded items can also render segment dividers. Null for
    // single-segment or non-concatenated generations.
    duration: (typeof meta.duration === "number") ? meta.duration : null,
    segment_bounds: Array.isArray(meta.segment_bounds) ? meta.segment_bounds : null,
    // Resolved (never -1) seed used for this generation, surfaced so the UI can
    // display and copy it for reproduction. Falls back to the captured recipe.
    seed: (typeof meta.seed === "number") ? meta.seed
        : (meta.recipe && typeof meta.recipe.seed === "number" ? meta.recipe.seed : null),
    params: meta.recipe || null,
  };
}

// GET /api/outputs — list every generation (newest first), read from meta.json.
// `?source=` scopes to generate | comparerefs | broker (default generate, so the
// existing Generate page Recent list is unchanged).
app.get("/api/outputs", requireApiKey, (req, res) => {
  try {
    const src = normSource(req.query.source);
    const root = OUTPUT_ROOTS[src];
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) {}
    const items = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const metaPath = path.join(root, d.name, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        items.push(genItemFromMeta(meta));
      } catch (e) {
        console.error(`[OUTPUTS] bad meta ${d.name}: ${e.message}`);
      }
    }
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// GET /api/outputs/batches — group generations into the batches they were
// produced in. One "Generate All" in Compare Refs = one batch, so this answers
// "how many audios did this comparison produce, and which reference did each
// use". Reconstructed live from member meta.json (meta.batch), so it stays
// correct as members are added or deleted — no manifest to keep in sync.
// One-off generations (no meta.batch) are ignored. `?source=` scopes the root.
app.get("/api/outputs/batches", requireApiKey, (req, res) => {
  try {
    const src = normSource(req.query.source);
    const root = OUTPUT_ROOTS[src];
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) {}
    const byId = new Map();
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const metaPath = path.join(root, d.name, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch (_) { continue; }
      if (!meta.batch || !meta.batch.id) continue;
      const bid = meta.batch.id;
      if (!byId.has(bid)) {
        byId.set(bid, {
          batch_id: bid, source: meta.source || src,
          label: meta.batch.label || "",
          total: meta.batch.total || 0,   // intended size (rows submitted)
          createdAt: meta.createdAt || 0,
          members: [],
        });
      }
      const grp = byId.get(bid);
      // Batch label/total taken from the freshest member that carries them.
      if (meta.batch.label && !grp.label) grp.label = meta.batch.label;
      if ((meta.batch.total || 0) > grp.total) grp.total = meta.batch.total;
      if ((meta.createdAt || 0) && (!grp.createdAt || meta.createdAt < grp.createdAt)) grp.createdAt = meta.createdAt;
      grp.members.push({ ...genItemFromMeta(meta), batch_seq: (meta.batch.seq ?? null) });
    }
    const batches = Array.from(byId.values()).map(b => {
      b.members.sort((x, y) => (x.batch_seq ?? 0) - (y.batch_seq ?? 0));
      b.count = b.members.length;   // actually-present members (may be < total after deletes)
      return b;
    });
    batches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ ok: true, batches });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// POST /api/outputs/reveal — highlight the generation folder (or its primary file).
app.post("/api/outputs/reveal", requireApiKey, (req, res) => {
  const g = resolveGenDir(req.body && (req.body.id || req.body.name), req.body && req.body.source);
  if (!g) return res.status(400).json({ error: "Invalid generation id" });
  if (!fs.existsSync(g.full)) {
    return res.status(404).json({ error: "Generation not found (it may have been cleaned)" });
  }
  let target = g.full;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(g.full, "meta.json"), "utf-8"));
    const primary = genBaseName(meta.audio_url || "");
    if (primary && fs.existsSync(path.join(g.full, primary))) target = path.join(g.full, primary);
  } catch (_) {}
  try {
    if (process.platform === "win32") {
      spawn("explorer", [`/select,${target}`], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      spawn("open", ["-R", target], { stdio: "ignore" });
    } else {
      spawn("xdg-open", [g.full], { stdio: "ignore" });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// DELETE /api/outputs/:id — permanently delete the WHOLE generation folder.
// `?source=` scopes to the right root (default generate).
app.delete("/api/outputs/:id", requireApiKey, (req, res) => {
  const g = resolveGenDir(req.params.id, req.query.source);
  if (!g) return res.status(400).json({ error: "Invalid generation id" });
  try {
    // Windows frequently holds a transient lock (EPERM/EBUSY) on a just-generated
    // or currently-loaded audio file (browser range stream, AV scanner, indexer),
    // which made a plain rmSync fail with a generic 500. Let rmSync retry, and on a
    // real failure log the errno + return an actionable message instead of masking it.
    if (fs.existsSync(g.full)) {
      fs.rmSync(g.full, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
    res.json({ ok: true, id: g.id });
  } catch (err) {
    console.error(`[OUTPUTS] delete failed ${g.full}: ${err.code || ""} ${err.message}`);
    const locked = err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "ENOTEMPTY");
    res.status(500).json({
      error: locked
        ? `Failed to delete audio (${err.code}) — the file is in use (likely still playing, or held by antivirus/Explorer). Stop playback and try again.`
        : `Failed to delete audio (${err.code || "error"})`,
    });
  }
});

// POST /api/outputs/clear-all — delete every generation folder under a source
// root (default generate). Body/query `source` scopes it.
app.post("/api/outputs/clear-all", requireApiKey, (req, res) => {
  try {
    let removed = 0, bytes = 0;
    const root = outputRoot((req.body && req.body.source) || req.query.source);
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const p = path.join(root, entry.name);
      try {
        for (const f of fs.readdirSync(p)) {
          try { bytes += fs.statSync(path.join(p, f)).size; } catch (_) {}
        }
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      } catch (e) {
        console.error(`[OUTPUTS] delete failed ${p}: ${e.message}`);
      }
    }
    console.log(`[OUTPUTS] clear-all removed ${removed} generation(s), freed ${bytes} bytes`);
    res.json({ ok: true, removed, bytes });
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

// PATCH /api/assets/:id/rename — DISPLAY-ONLY rename (Option A).
//
// The canonical id (= folder name) is IMMUTABLE. Rename updates display_name
// only; it never moves the folder, never re-derives the id, and never enforces
// display-name uniqueness (duplicate display names are allowed because ids stay
// unique). Training/publish/rebuild/delete/recipe-binding/Broker resolution all
// key off the immutable folder id, so a display rename is inert to identity.
//
// This removes the old "display must equal sanitize(id)" clobber trap entirely:
// with ids allocated once at creation (assetId.allocateVoiceId) and never
// re-derived from display, drift is impossible.
app.patch("/api/assets/:id/rename", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const newName = ((req.body && req.body.display_name) || "").trim();
  if (!newName) return res.status(400).json({ error: "display_name is required" });
  if (newName.length > 80) return res.status(400).json({ error: "display_name too long (max 80)" });

  const dir = path.join(ASSETS_DIR, id);
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: `Voice '${id}' not found` });

  try {
    // Non-blocking duplicate-name advisory (NOT an identity constraint): report
    // any OTHER voice already showing this display name so the UI can surface the
    // internal id for disambiguation. Never rejects.
    const duplicates = [];
    const lname = newName.toLowerCase();
    try {
      for (const e of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === id) continue;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, e.name, "meta.json"), "utf-8"));
          if (m && String(m.display_name || "").trim().toLowerCase() === lname) duplicates.push(e.name);
        } catch (_) { /* ignore unreadable meta */ }
      }
    } catch (_) { /* assets dir unreadable */ }

    await withVoicesLock(async () => {
      // meta.json is authoritative for display_name; folder name stays the id.
      const meta0 = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      meta0.display_name = newName;
      meta0.id = id; // mirror only
      fs.writeFileSync(metaPath, JSON.stringify(meta0, null, 2));

      const voices2 = loadVoices();
      if (voices2[id]) {
        voices2[id] = { ...voices2[id], display_name: newName };
        saveVoices(voices2);
      }
    });

    res.json({ ok: true, id, previousId: id, idChanged: false, display_name: newName, duplicates });
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

    // Optional file-picking mode (PC): `?files=.ckpt,.pth` also lists files whose
    // extension matches, so the Broker page can pick a model file (not just a
    // folder). Absent → folder-only (unchanged, backward compatible).
    const fileExts = (req.query.files || "").toString().trim()
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
      .map(e => (e.startsWith(".") ? e : "." + e));

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
    const files = [];
    const resolved = await Promise.all(entries.map(async (entry) => {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) return { name: entry.name, path: full };
      // A symlink/junction may point at a directory — resolve it, but never pay
      // for an extra stat on plain files (the common case, always skipped).
      if (entry.isSymbolicLink()) {
        try { if ((await fsp.stat(full)).isDirectory()) return { name: entry.name, path: full }; } catch (_) {}
      }
      // File-picking mode: collect files matching the requested extensions.
      if (fileExts.length > 0 && (entry.isFile() || entry.isSymbolicLink())) {
        const ext = path.extname(entry.name).toLowerCase();
        if (fileExts.includes(ext)) files.push({ name: entry.name, path: full.replace(/\\/g, "/") });
      }
      return null;
    }));
    const dirs = resolved.filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    // parent: null when at a drive root (Windows) or filesystem root (POSIX),
    // in which case the frontend offers "up to drives" on Windows.
    const parentDir = path.dirname(target);
    const atRoot = parentDir === target;
    const parent = atRoot ? (isWin ? "" : null) : parentDir;

    res.json({ ok: true, path: target, parent, isDriveList: false, drives: [], dirs, files });
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
  // Built-in Base model: synthesize meta (checkpoints + empty roster) — it has no
  // folder on disk, so populate the Generate dropdowns from the pretrained weights.
  if (isBaseVoice(id)) return res.json({ ok: true, meta: baseVoiceMeta() });
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
  // Base model has no slices — return an empty segment set (Slices count = 0).
  if (isBaseVoice(id)) return res.json({ ok: true, segments: { segments: [], live_matched: 0 } });
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
// so deleted files never appear. Each entry is enriched with:
//   - text:     aligned reference transcript from asr_opt/raw_opt.list (by basename)
//   - duration: WAV header duration in seconds (0 when unknown, e.g. mp3 — the
//               client then measures it via the <audio> element for the 3–10s guard)
app.get("/api/assets/:id/raw-list", (req, res) => {
  const id = req.params.id;
  // Base model has no raw audio — return an empty list (Raw count = 0).
  if (isBaseVoice(id)) return res.json({ ok: true, raw: [] });
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const rawDir = path.join(ASSETS_DIR, id, "raw");
  if (!fs.existsSync(rawDir)) return res.json({ ok: true, raw: [] });
  try {
    // Build basename -> reference text map from raw_opt.list (if present).
    const textByName = {};
    const listFile = path.join(ASSETS_DIR, id, "asr_opt", "raw_opt.list");
    if (fs.existsSync(listFile)) {
      try {
        for (const entry of assetScanner.parseSlicerOptList(fs.readFileSync(listFile, "utf-8"))) {
          if (entry.origName && entry.text) textByName[entry.origName] = entry.text;
        }
      } catch { /* unreadable list → no texts, non-fatal */ }
    }
    const files = fs.readdirSync(rawDir)
      .filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f))
      .map(f => {
        const dur = /\.wav$/i.test(f)
          ? Math.round(assetScanner.getWavDuration(path.join(rawDir, f)) * 100) / 100
          : 0;
        return {
          filename: f,
          url: `/assets/${id}/raw/${encodeURIComponent(f)}`,
          text: textByName[f] || "",
          duration: dur,
        };
      });
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

// ── Patch #13: reference-transcript proofing (edit existing text, no ASR) ─────
// The asset's reference transcript lives in asr_opt/<kind>.list as lines shaped
// "<kind>/<file>|<speaker>|<LANG>|<text>". These endpoints let the Assets page
// read and hand-edit that TEXT in place, reusing the existing Proofing UI. They
// deliberately DO NOT run ASR, touch checkpoints, or start a pipeline.
//
// Pronunciation-level proofing is intentionally out of scope here: the .list can
// only carry text, and pronunciation corrections persist in the global personal
// lexicon (see /api/pron/lexicon), applied at inference time — not per-asset.
const TRANSCRIPT_KINDS = [
  { kind: "slicer_opt", listName: "slicer_opt.list", audioSub: "slicer_opt" },
  { kind: "raw", listName: "raw_opt.list", audioSub: "raw" },
];

// Parse a .list file into editable rows, preserving every column so a later save
// can round-trip path/speaker/lang untouched and only rewrite text.
function readTranscriptListRows(listPath) {
  const rows = [];
  let content = "";
  try { content = fs.readFileSync(listPath, "utf-8"); } catch { return rows; }
  content.split("\n").forEach((line, i) => {
    const t = line.replace(/\r$/, "");
    if (!t.trim()) return;
    const parts = t.split("|");
    if (parts.length < 4) return;
    rows.push({
      index: i,
      audio_path: parts[0] || "",
      audio_filename: String(parts[0] || "").replace(/\\/g, "/").split("/").pop(),
      speaker: parts[1] || "",
      lang: parts[2] || "",
      text: parts.slice(3).join("|"),
    });
  });
  return rows;
}

// GET /api/assets/:id/transcript — return the asset's existing reference transcript
// (one bucket per present .list) plus its provenance. No ASR, purely a read.
app.get("/api/assets/:id/transcript", requireApiKey, (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const voiceDir = path.join(ASSETS_DIR, id);
  if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });
  try {
    const buckets = [];
    for (const k of TRANSCRIPT_KINDS) {
      const listPath = path.join(voiceDir, "asr_opt", k.listName);
      if (!fs.existsSync(listPath)) continue;
      const audioDir = path.join(voiceDir, k.audioSub);
      // Patch #23：置信度旁车 <kind>.conf.json（键为片段文件名），有则逐行附带。
      let confMap = {};
      try {
        const confPath = path.join(voiceDir, "asr_opt", k.listName.replace(/\.list$/i, ".conf.json"));
        if (fs.existsSync(confPath)) {
          const parsed = JSON.parse(fs.readFileSync(confPath, "utf-8"));
          if (parsed && typeof parsed === "object") confMap = parsed;
        }
      } catch (_) {}
      const rows = readTranscriptListRows(listPath).map((r) => {
        const c = confMap[r.audio_filename] || null;
        return {
          ...r,
          exists: !!(r.audio_filename && fs.existsSync(path.join(audioDir, r.audio_filename))),
          url: r.audio_filename ? `/assets/${id}/${k.audioSub}/${encodeURIComponent(r.audio_filename)}` : null,
          confidence: c && typeof c.confidence === "number" ? c.confidence : null,
          words: c && Array.isArray(c.words) ? c.words : null,
        };
      });
      buckets.push({ kind: k.kind, listName: k.listName, rows });
    }
    // Language + provenance from meta (transcript source/verification, if any).
    let language = "ja";
    let transcript = null;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(voiceDir, "meta.json"), "utf-8"));
      if (m.language) language = m.language;
      if (m.transcript && typeof m.transcript === "object") transcript = m.transcript;
    } catch (_) {}
    res.json({ ok: true, buckets, language, transcript, hasTranscript: buckets.length > 0 });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// POST /api/assets/:id/transcript — persist hand-edited reference TEXT back to the
// asset's .list, resync segments.json, and mark provenance as human-edited. Does
// NOT run ASR or training. body: { kind, rows:[{audio_filename|audio_path, text}], verified? }
app.post("/api/assets/:id/transcript", requireApiKey, (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const voiceDir = path.join(ASSETS_DIR, id);
  if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });

  const kind = (req.body && req.body.kind) || "slicer_opt";
  const kindDef = TRANSCRIPT_KINDS.find((k) => k.kind === kind);
  if (!kindDef) return res.status(400).json({ error: `Invalid transcript kind '${kind}'` });
  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows)) return res.status(400).json({ error: "rows must be an array" });

  const listPath = path.join(voiceDir, "asr_opt", kindDef.listName);
  if (!fs.existsSync(listPath)) {
    return res.status(404).json({ error: `No ${kindDef.listName} for '${id}'. Run ASR to create one first.` });
  }

  try {
    // Merge edited text onto the existing list by audio filename (basename), so
    // path/speaker/lang columns round-trip exactly and unknown rows are untouched.
    const existing = readTranscriptListRows(listPath);
    const textByName = {};
    for (const r of rows) {
      const fname = String(r.audio_filename || r.audio_path || "").replace(/\\/g, "/").split("/").pop();
      if (fname) textByName[fname] = r.text == null ? "" : String(r.text);
    }
    let changed = 0;
    const changedNames = [];
    const lines = existing.map((r) => {
      const fname = r.audio_filename;
      const text = (fname in textByName) ? textByName[fname] : r.text;
      if (fname in textByName && textByName[fname] !== r.text) { changed += 1; changedNames.push(fname); }
      return `${r.audio_path}|${r.speaker}|${r.lang}|${text}`;
    });
    const tmp = listPath + ".tmp." + process.pid + "." + Date.now();
    fs.writeFileSync(tmp, lines.join("\n") + "\n", "utf-8");
    fs.renameSync(tmp, listPath);

    // Patch #23：人工改过的行，其机器置信度已失真，从旁车剔除避免误导着色。
    if (changedNames.length) {
      try {
        const confPath = path.join(voiceDir, "asr_opt", kindDef.listName.replace(/\.list$/i, ".conf.json"));
        if (fs.existsSync(confPath)) {
          const cm = JSON.parse(fs.readFileSync(confPath, "utf-8"));
          if (cm && typeof cm === "object") {
            let dirty = false;
            for (const n of changedNames) { if (n in cm) { delete cm[n]; dirty = true; } }
            if (dirty) fs.writeFileSync(confPath, JSON.stringify(cm), "utf-8");
          }
        }
      } catch (e) { console.error(`[TRANSCRIPT ${id}] conf prune warning:`, e.message); }
    }

    // Rebuild segments.json from the updated list (its text is what inference reads).
    try { assetScanner.generateSegments(id); } catch (e) { console.error(`[TRANSCRIPT ${id}] segments rebuild warning:`, e.message); }

    // Provenance: mark human-edited (or human-verified when the user confirms).
    try {
      const metaPath = path.join(voiceDir, "meta.json");
      const m = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf-8")) : {};
      const verified = !!(req.body && req.body.verified);
      m.transcript = {
        ...(m.transcript || {}),
        source: verified ? "human_verified" : "human_edited",
        revised_at: new Date().toISOString(),
        revision: (Number((m.transcript && m.transcript.revision) || 0) || 0) + 1,
      };
      fs.writeFileSync(metaPath, JSON.stringify(m, null, 2));
    } catch (e) { console.error(`[TRANSCRIPT ${id}] meta update warning:`, e.message); }

    res.json({ ok: true, kind, changed, total: lines.length });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// POST /api/assets/:id/transcribe — lightweight IN-PLACE ASR recovery.
// One-click "generate reference text": runs the shared ASR kernel over the asset's
// own raw/ and/or slicer_opt/ audio, writing asr_opt/<kind>.list + regenerating
// segments.json + rescanning meta. It does NOT go through the training pipeline or
// promote — the asset is edited in place. Reference TEXT is advisory (inference
// works without it); this just makes recovery a single button.
//   body.source: 'raw' | 'slices' | 'both' | 'missing'(default, fills absent lists)
app.post("/api/assets/:id/transcribe", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const voiceDir = path.join(ASSETS_DIR, id);
  if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });

  const existing = transcribeJobs.get(id);
  if (existing && existing.status === "running") {
    const { _child, _cancelled, ...pub } = existing;
    return res.status(409).json({ error: "A transcription job is already running.", job: pub });
  }

  // Resolve language from voices.json, then meta.json, else default.
  let language = "ja";
  try { const vs = loadVoices(); if (vs[id] && vs[id].language) language = vs[id].language; } catch (_) {}
  try {
    const m = JSON.parse(fs.readFileSync(path.join(voiceDir, "meta.json"), "utf-8"));
    if ((!language || language === "ja") && m.language) language = m.language;
  } catch (_) {}

  const AUDIO = /\.(wav|mp3|flac|m4a|ogg)$/i;
  const hasAudio = (sub) => {
    const d = path.join(voiceDir, sub);
    try { return fs.existsSync(d) && fs.readdirSync(d).some(f => AUDIO.test(f)); } catch { return false; }
  };
  const hasList = (name) => fs.existsSync(path.join(voiceDir, "asr_opt", name));
  const hasRaw = hasAudio("raw");
  const hasSlices = hasAudio("slicer_opt");

  const sel = (req.body && req.body.source) || "missing";
  const sources = [];
  const add = (kind, sub) => { if (!sources.find(s => s.kind === kind)) sources.push({ kind, sub }); };
  if (sel === "raw") { if (hasRaw) add("raw", "raw"); }
  else if (sel === "slices") { if (hasSlices) add("slicer_opt", "slicer_opt"); }
  else if (sel === "both") { if (hasRaw) add("raw", "raw"); if (hasSlices) add("slicer_opt", "slicer_opt"); }
  else { // 'missing': only transcribe available audio whose list is absent
    if (hasRaw && !hasList("raw_opt.list")) add("raw", "raw");
    if (hasSlices && !hasList("slicer_opt.list")) add("slicer_opt", "slicer_opt");
  }
  if (sources.length === 0) {
    return res.status(400).json({
      error: "No audio to transcribe (the selected source has no audio, or in “Fill missing” mode a transcript already exists).",
      hasRaw, hasSlices,
    });
  }

  const config = loadTrainingConfig();
  const outDir = path.join(voiceDir, "asr_opt");
  const job = {
    status: "running", startedAt: Date.now(), finishedAt: null,
    sources: sources.map(s => s.kind), done: [], error: null, logs: [],
    _child: null, _cancelled: false,
  };
  transcribeJobs.set(id, job);
  const log = (m) => {
    job.logs.push(`[${new Date().toISOString()}] ${m}`);
    if (job.logs.length > 500) job.logs.shift();
    console.log(`[TRANSCRIBE ${id}] ${m}`);
  };

  // Respond immediately; ASR runs in the background and is polled via -status.
  res.json({ ok: true, started: true, sources: job.sources, language });

  (async () => {
    const backups = [];
    try {
      for (const s of sources) {
        if (job._cancelled) throw new Error("cancelled");
        // Patch #13: back up any existing transcript before ASR replaces it, so a
        // hand-edited/verified list is never silently destroyed by re-running ASR.
        const listName = s.kind === "raw" ? "raw_opt.list" : "slicer_opt.list";
        const existingList = path.join(outDir, listName);
        if (fs.existsSync(existingList)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const bak = path.join(outDir, `${listName}.bak.${stamp}`);
          try { fs.copyFileSync(existingList, bak); backups.push(path.basename(bak)); log(`backed up ${listName} → ${path.basename(bak)}`); }
          catch (e) { log(`backup warning for ${listName}: ${e.message}`); }
        }
        log(`ASR start: ${s.kind}`);
        await runAsr({
          srcDir: path.join(voiceDir, s.sub), sourceKind: s.kind, language,
          voiceId: id, outDir, config,
          setChild: (child) => { job._child = child; },
        }, log);
        job.done.push(s.kind);
      }
      // In-place: regenerate segments.json + rescan meta. No promote.
      try { assetScanner.generateSegments(id); } catch (e) { log(`segments rebuild warning: ${e.message}`); }
      try {
        const m = assetScanner.scanVoiceDir(id, voiceDir);
        // The transcript is now machine-generated; record provenance + backups.
        m.transcript = {
          source: "machine_generated",
          revised_at: new Date().toISOString(),
          revision: (Number((m.transcript && m.transcript.revision) || 0) || 0) + 1,
          backups: backups.length ? backups : undefined,
        };
        fs.writeFileSync(path.join(voiceDir, "meta.json"), JSON.stringify(m, null, 2));
      } catch (e) { log(`meta rescan warning: ${e.message}`); }
      job.status = "done"; job.finishedAt = Date.now(); job.backups = backups; log("done");
    } catch (err) {
      const wasCancelled = job._cancelled || /cancel|killed/i.test(err.message || "");
      job.status = wasCancelled ? "cancelled" : "error";
      job.error = wasCancelled ? null : clientError(err);
      job.finishedAt = Date.now();
      log(wasCancelled ? "cancelled" : `failed: ${err.message}`);
    } finally {
      job._child = null;
    }
  })();
});

// GET /api/assets/:id/transcribe-status — poll the in-place transcribe job.
// requireApiKey for consistency with the rest of the asset API; strip internal
// child/cancel bookkeeping from the response.
app.get("/api/assets/:id/transcribe-status", requireApiKey, (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const job = transcribeJobs.get(id);
  if (!job) return res.json({ ok: true, status: "idle" });
  const { _child, _cancelled, ...pub } = job;
  res.json({ ok: true, ...pub });
});

// GET /api/transcribe-jobs — list ALL non-idle in-place transcribe jobs so the
// Assets UI can re-hydrate after navigating away and back (the AssetsTab component
// unmounts on page switch, losing its local job state, while these jobs keep running
// server-side). Distinct top-level path on purpose: anything under /api/assets/<x>
// is captured by the GET /api/assets/:id route above. Strip internal bookkeeping.
app.get("/api/transcribe-jobs", requireApiKey, (req, res) => {
  const jobs = {};
  for (const [id, job] of transcribeJobs.entries()) {
    if (!job || job.status === "idle") continue;
    const { _child, _cancelled, logs, ...pub } = job;
    jobs[id] = pub;
  }
  res.json({ ok: true, jobs });
});

// DELETE /api/assets/:id/transcribe — cancel a running in-place transcribe job.
app.delete("/api/assets/:id/transcribe", requireApiKey, (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const job = transcribeJobs.get(id);
  if (!job || job.status !== "running") return res.json({ ok: true, status: job ? job.status : "idle" });
  job._cancelled = true;
  try { if (job._child) job._child.kill("SIGTERM"); } catch (_) {}
  res.json({ ok: true, status: "cancelling" });
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
  // Base model: models exist on disk (base weights); reference is always "borrow"
  // (missing until the user picks one from another voice).
  if (isBaseVoice(id)) {
    const cks = baseCheckpoints();
    return res.json({
      ok: true, voice: id,
      checks: {
        gpt_model_exists: cks.gpt.length > 0,
        sovits_model_exists: cks.sovits.length > 0,
        reference_audio_exists: false,
        reference_text_present: false,
        reference_text_placeholder: false,
      },
    });
  }
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

  const advParams = loadAdvancedParams();

  // Resolve the `voice` field into a concrete inference config. Two paths:
  //   1. `voice` = "role/name"  → recipe (P5). Uses the recipe's pinned models,
  //      reference audio/text and params. Distribution-stable and reproducible.
  //   2. `voice` = "role"       → whole-voice (legacy). Auto-picks the best
  //      checkpoint + first matched segment. Standard OpenAI clients keep working.
  let role = voice;
  let refAudio = "";
  let refText = "";
  let gptModel = "";
  let sovitsModel = "";
  let recipeId = null;
  let textLang = "";
  let promptLang = "";
  let recParams = null;
  let recipeSchemaVersion = 1; // set on the recipe path; aux paths resolve with it.

  if (typeof voice === "string" && voice.includes("/")) {
    // --- Recipe path ---
    const recipe = recipeStore.resolveVoice(voice);
    if (!recipe) return res.status(404).json({ error: `Unknown recipe voice: ${voice}` });
    role = recipe.role;
    recipeId = recipe.id;
    const voiceReg = voices[role];
    if (!voiceReg) return res.status(404).json({ error: `Recipe '${voice}' references unknown voice '${role}'` });

    // v3 version-aware resolution. Legacy (v<=2) string paths resolve against
    // APP_DIR exactly as before; v3 { base, path } objects resolve asset-relative
    // (ASSETS_ROOT, containment-checked) or as an explicit external absolute path.
    // A managed-path escape (traversal / symlink) is a hard 400, not a not-found.
    const schemaVersion = recipe.schema_version || 1;
    recipeSchemaVersion = schemaVersion;
    const rref = pathResolver.resolveManagedRef(recipe.reference_audio, { schemaVersion });
    if (!rref.ok) return res.status(400).json({ error: `Recipe '${voice}' reference_audio rejected: ${rref.error}`, code: rref.code });
    refAudio = rref.path;
    refText = recipe.reference_text || "";
    if (!refAudio || !fs.existsSync(refAudio)) {
      return res.status(400).json({ error: `Recipe '${voice}' reference_audio not found: ${JSON.stringify(recipe.reference_audio)}` });
    }
    if (!refText) return res.status(400).json({ error: `Recipe '${voice}' has no reference_text` });

    // Pinned models. A missing pinned file means the voice was retrained/pruned —
    // the Broker page re-binds it.
    for (const [label, field] of [["gpt_ckpt", "gpt_ckpt"], ["sovits_pth", "sovits_pth"]]) {
      const val = recipe[field];
      if (!val) continue;
      const rm = pathResolver.resolveManagedRef(val, { schemaVersion });
      if (!rm.ok) return res.status(400).json({ error: `Recipe '${voice}' ${label} rejected: ${rm.error}`, code: rm.code });
      if (rm.path && !fs.existsSync(rm.path)) {
        return res.status(400).json({ error: `Recipe '${voice}' pinned ${label} is missing (re-bind it in the Broker page): ${rm.path}` });
      }
      if (label === "gpt_ckpt") gptModel = rm.path; else sovitsModel = rm.path;
    }
    textLang = recipe.language || voiceReg.text_lang || voiceReg.language || "ja";
    promptLang = recipe.language || voiceReg.prompt_lang || voiceReg.language || "ja";
    recParams = recipe.params || {};
  } else {
    // --- Whole-voice path (legacy, unchanged behavior) ---
    const voiceReg = voices[voice];
    if (!voiceReg) return res.status(404).json({ error: `Unknown voice: ${voice}` });

    const segPath = path.join(ASSETS_DIR, voice, "segments.json");
    if (!fs.existsSync(segPath)) return res.status(400).json({ error: `Voice '${voice}' has no segments.json. Scan assets first.` });
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

    const metaPath = path.join(ASSETS_DIR, voice, "meta.json");
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const ckpts = meta?.assets?.checkpoints || {};
      if ((ckpts.gpt || []).length > 0) gptModel = (pickBestCkpt(ckpts.gpt) || {}).path || "";
      if ((ckpts.sovits || []).length > 0) sovitsModel = (pickBestCkpt(ckpts.sovits) || {}).path || "";
    }
    textLang = voiceReg.text_lang || voiceReg.language || "ja";
    promptLang = voiceReg.prompt_lang || voiceReg.language || "ja";
  }

  try {
    await withGenerationLock(async () => {
        // Recipe params take precedence over the global advanced-params defaults;
        // missing fields (older v1 recipes) fall back to advParams (PA-3).
        const rp = recParams || {};
        const pick = (k, adv) => (rp[k] != null ? rp[k] : adv);

        // Auxiliary references (PA): use the SAME schema-aware managed-path
        // resolver as the main reference (Patch #11 R1/R2 fix). A recipe's aux
        // entries may be legacy strings OR v3 { base, path } objects; the old
        // resolveRefPath() only handled strings and threw on objects, so a v3
        // recipe carrying aux refs would 500 at distribution. Resolve each and
        // keep only the ones that still exist on this machine.
        let auxResolved = [];
        if (Array.isArray(rp.aux_ref_audio_paths)) {
          auxResolved = rp.aux_ref_audio_paths
            .map((p) => {
              const r = pathResolver.resolveManagedRef(p, { schemaVersion: recipeSchemaVersion });
              return r.ok ? r.path : "";
            })
            .filter((p) => p && fs.existsSync(p));
        }

        const cfg = {
          gpt_model: gptModel,
          sovits_model: sovitsModel,
          reference_audio: refAudio,
          reference_text: refText,
          text_lang: textLang,
          prompt_lang: promptLang,
          temperature: pick("temperature", advParams.temperature),
          top_k: pick("top_k", advParams.top_k),
          top_p: pick("top_p", advParams.top_p),
          repetition_penalty: pick("repetition_penalty", advParams.repetition_penalty),
          text_split_method: rp.text_split_method || advParams.text_split_method,
          speed_factor: (rp.speed != null ? rp.speed : (speed || 1.0)),
          // Reproducibility: resolve -1/random into a concrete seed so the engine uses a
          // known value and the archived meta records it (audit + reproducibility).
          seed: resolveSeed(pick("seed", advParams.seed)),
          // Advanced group — pinned by the recipe when present (PA).
          sample_steps: pick("sample_steps", advParams.sample_steps),
          if_sr: rp.if_sr != null ? rp.if_sr : advParams.if_sr,
          batch_size: pick("batch_size", advParams.batch_size),
          batch_threshold: pick("batch_threshold", advParams.batch_threshold),
          split_bucket: rp.split_bucket != null ? rp.split_bucket : advParams.split_bucket,
          fragment_interval: pick("fragment_interval", advParams.fragment_interval),
          parallel_infer: rp.parallel_infer != null ? rp.parallel_infer : advParams.parallel_infer,
        };
        if (auxResolved.length > 0) cfg.aux_ref_audio_paths = auxResolved;
        // Auto (Multilingual): kana-free CJK fallback = voice metadata language.
        if (cfg.text_lang === "auto_zh_ja") {
          cfg.auto_base_lang = rp.auto_base_lang || voiceReg.language || voiceReg.text_lang || "zh";
        }
        // Pinned pronunciation overrides ride along (PA-1). When the recipe also
        // pins reverse-language readings for forced Han characters (#4), merge them
        // into the nested {lang:{word:[readings]}} form the engine understands.
        {
          const base = (rp.pron_overrides && typeof rp.pron_overrides === "object" &&
            !Array.isArray(rp.pron_overrides) && Object.keys(rp.pron_overrides).length > 0)
            ? rp.pron_overrides : null;
          const langOv = (rp.lang_overrides && typeof rp.lang_overrides === "object") ? rp.lang_overrides : {};
          const readings = (rp.han_readings && typeof rp.han_readings === "object") ? rp.han_readings : {};
          const reverse = {};
          for (const ch of Object.keys(readings)) {
            const r = String(readings[ch] == null ? "" : readings[ch]).trim();
            const lng = langOv[ch];
            if (r && lng) { (reverse[lng] = reverse[lng] || {})[ch] = [r]; }
          }
          const hasReverse = Object.keys(reverse).length > 0;
          if (hasReverse) {
            const baseLang = String(cfg.text_lang === "auto_zh_ja"
              ? (cfg.auto_base_lang || "zh")
              : (cfg.text_lang || "zh")).toLowerCase()
              .replace("all_", "").replace("auto_", "").replace("auto", "zh") || "zh";
            const merged = { ...reverse };
            if (base) merged[baseLang] = { ...(merged[baseLang] || {}), ...base };
            cfg.pron_overrides = merged;
          } else if (base) {
            cfg.pron_overrides = base;
          }
        }
        // Per-character language overrides ride along verbatim when pinned.
        if (rp.lang_overrides && typeof rp.lang_overrides === "object" &&
            Object.keys(rp.lang_overrides).length > 0) {
          cfg.lang_overrides = rp.lang_overrides;
        }

        await switchModels(cfg);
        // PH: resolve the requested response_format. The engine always renders
        // WAV; non-wav formats are transcoded below via ffmpeg. Unknown formats
        // are rejected (OpenAI does the same).
        const reqFmt = (typeof response_format === "string" ? response_format.toLowerCase().trim() : "") || "wav";
        if (!AUDIO_FORMATS[reqFmt]) {
          return res.status(400).json({ error: `Unsupported response_format '${response_format}'. Supported: ${Object.keys(AUDIO_FORMATS).join(", ")}.` });
        }
        let fmt = reqFmt;
        let formatNotice = null;
        // Strictly honor the caller's format contract. A non-WAV format requires
        // transcoding the engine's WAV through ffmpeg; if ffmpeg isn't installed
        // we must NOT silently ship WAV under a different Content-Type — that
        // breaks the contract the upstream explicitly requested. Reject instead,
        // and point the caller at the bundled ffmpeg provisioner.
        if (fmt !== "wav" && !checkFfmpeg()) {
          return res.status(400).json({
            error: {
              message: `This broker cannot deliver '${reqFmt}' audio: ffmpeg is not installed on the server, and '${reqFmt}' requires transcoding from WAV. ` +
                `Provision the bundled ffmpeg by running tools/deploy/download_ffmpeg.py (installs vendor/ffmpeg/<platform>/), then restart the broker. ` +
                `Otherwise request response_format="wav", which needs no ffmpeg.`,
              type: "invalid_request_error",
              code: "ffmpeg_unavailable",
              param: "response_format",
              requested_format: reqFmt,
              supported_without_ffmpeg: ["wav"],
            },
          });
        }

        const payload = buildTtsPayload(input, cfg);
        // aux resolved inside buildTtsPayload (Patch #11) — not re-injected here.
        for (const key of ["sample_steps", "if_sr"]) {
          if (cfg[key] !== undefined) payload[key] = cfg[key];
        }
        payload.speed_factor = cfg.speed_factor;
        // The engine only speaks WAV; transcoding happens broker-side.
        payload.media_type = "wav";

        const ttsRes = await gsvPost("/tts", payload);
        if (ttsRes.statusCode >= 400) return res.status(502).json({ error: `GPT-SoVITS /tts failed (${ttsRes.statusCode}): ${ttsRes.body.toString()}` });

        const wavBytes = ttsRes.body;
        if (!wavBytes || wavBytes.length === 0) return res.status(502).json({ error: "GPT-SoVITS returned empty audio" });

        // Transcode WAV → requested format when needed (ffmpeg confirmed above).
        // If transcoding fails we do NOT silently downgrade to WAV — that would
        // violate the format contract the caller requested. Surface the failure.
        let audioBytes = wavBytes;
        if (fmt !== "wav") {
          try {
            audioBytes = transcodeAudio(wavBytes, fmt);
          } catch (e) {
            console.error(`[broker] transcode to ${fmt} failed:`, e.message);
            return res.status(500).json({
              error: {
                message: `Failed to transcode the generated audio to '${fmt}' via ffmpeg: ${e.message}. ` +
                  `Verify the bundled ffmpeg build supports the '${fmt}' encoder (reinstall via tools/deploy/download_ffmpeg.py), ` +
                  `or request response_format="wav".`,
                type: "server_error",
                code: "transcode_failed",
                param: "response_format",
                requested_format: fmt,
              },
            });
          }
        }
        const mediaType = AUDIO_FORMATS[fmt].mime;

        // Persist to the broker output root (P3): every distributed call is
        // archived as a genId folder with meta.json (source=broker, recipe_id).
        const genId = newGenId();
        const ext = AUDIO_FORMATS[fmt].ext;
        const audioName = `audio.${ext}`;
        const audioUrl = `/outputs/broker/${genId}/${audioName}`;
        try {
          const dir = genAssetDir(genId, "broker");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, audioName), audioBytes);
          writeGenMeta(genId, {
            id: genId, source: "broker", createdAt: Date.now(),
            voice: role, voiceLabel: recipeId || voice, text: input, lang: cfg.text_lang,
            gpt: genBaseName(cfg.gpt_model) || "\u2014", sovits: genBaseName(cfg.sovits_model) || "\u2014",
            gpt_model: cfg.gpt_model, sovits_model: cfg.sovits_model,
            ref_audio: cfg.reference_audio, ref_text: cfg.reference_text,
            recipe_id: recipeId, model: model || null,
            seed: cfg.seed,
            segments: 1, audio_url: audioUrl,
            files: [{ role: "single", name: audioName, url: audioUrl }],
            status: "ok",
          }, "broker");
        } catch (e) { console.error("[broker] failed to archive output:", e.message); }

        const filename = `${(recipeId || role).replace(/[^a-zA-Z0-9_-]/g, "_")}_${genId}.${ext}`;
        res.set("Content-Type", mediaType);
        res.set("Content-Disposition", `attachment; filename="${filename}"`);
        res.set("X-Voice-Id", role);
        res.set("X-Audio-Format", fmt);
        // (Retained for forward-compat; the broker no longer degrades formats,
        // so formatNotice is normally null and no notice header is emitted.)
        if (formatNotice) res.set("X-Audio-Format-Notice", formatNotice);
        if (recipeId) res.set("X-Recipe-Id", recipeId);
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

const ALLOWED_LANGUAGES = new Set(["zh", "yue", "ja", "en", "ko", "auto"]);

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
    // 训练目标版本（v2 / v2Pro / v2ProPlus）——前端可在 customParams.training.version 覆盖
    oneOf(s, 'version', t.version, ['v2', 'v2Pro', 'v2ProPlus']);
    // 多版本并行训练（读法 B）：versions[] 白名单，每项 ∈ v2/v2Pro/v2ProPlus，去重保序。
    if (Array.isArray(t.versions)) {
      const _allowedV = ['v2', 'v2Pro', 'v2ProPlus'];
      const _vs = [];
      for (const v of t.versions) if (_allowedV.includes(v) && !_vs.includes(v)) _vs.push(v);
      if (_vs.length) s.versions = _vs;
    }
    // S1 advanced / expert
    intNum(s, 'seed', t.seed, 0, 999999);
    intNum(s, 'save_every_n_epoch', t.save_every_n_epoch, 1, 50);
    // Patch #10: split S1/S2 checkpoint save intervals (legacy save_every_n_epoch
    // still honoured as a fallback in train.js). S1 default 4 (epoch 8 lands on a
    // save), S2 default 5 (epoch 25 lands on a save).
    intNum(s, 's1_save_every_n_epoch', t.s1_save_every_n_epoch, 1, 50);
    intNum(s, 's2_save_every_n_epoch', t.s2_save_every_n_epoch, 1, 50);
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
      bool(ap, 'force_simplified_chinese', p.force_simplified_chinese);
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

// ===== task3 底模门禁：基础模型体检（与 download_models.py 布局对齐） =====
const GSV_PRETRAINED_DIR = path.join(__dirname, 'lib', 'training', 'gsv-tools', 'pretrained');
function _mvFirstExisting(cands) {
  for (const rel of cands) { const fp = path.join(GSV_PRETRAINED_DIR, rel); try { if (fs.existsSync(fp)) return fp; } catch (_) {} }
  return null;
}
function normModelVersion(v) {
  const s = String(v || '').toLowerCase().replace(/[\s_-]/g, '');
  if (s === 'v2proplus') return 'v2ProPlus';
  if (s === 'v2pro') return 'v2Pro';
  return 'v2';
}
const _MV_BASE_REQ = {
  v2: [
    { label: 's2G', cands: ['gsv-v2final/s2G2333k.pth', 'gsv-v2final-pretrained/s2G2333k.pth', 's2G2333k.pth', 'v2Pro/s2G488k.pth', 's2G488k.pth', 'gsv-v2final/s2G488k.pth'] },
    { label: 's2D', cands: ['gsv-v2final/s2D2333k.pth', 'gsv-v2final-pretrained/s2D2333k.pth', 's2D2333k.pth', 'v2Pro/s2D488k.pth', 's2D488k.pth', 'gsv-v2final/s2D488k.pth'] },
  ],
  v2Pro: [
    { label: 's2G', cands: ['v2Pro/s2Gv2Pro.pth'] },
    { label: 's2D', cands: ['v2Pro/s2Dv2Pro.pth'] },
    { label: 'sv', cands: ['sv/pretrained_eres2netv2w24s4ep4.ckpt'] },
  ],
  v2ProPlus: [
    { label: 's2G', cands: ['v2Pro/s2Gv2ProPlus.pth'] },
    { label: 's2D', cands: ['v2Pro/s2Dv2ProPlus.pth'] },
    { label: 'sv', cands: ['sv/pretrained_eres2netv2w24s4ep4.ckpt'] },
  ],
};
// hard 版本(v2Pro/v2ProPlus)缺关键底模(s2G/s2D) → 训练必产电流声，属产品事故，必须拦。
// v2 可回退(shape-safe)，永不拦，仅前端警告。sv 缺失仅退化(零向量)，警告不拦。
const _MV_HARD = new Set(['v2Pro', 'v2ProPlus']);
function checkBaseModelsForVersion(v) {
  const version = normModelVersion(v);
  const reqs = _MV_BASE_REQ[version] || _MV_BASE_REQ.v2;
  const present = [], missing = [];
  for (const r of reqs) { (_mvFirstExisting(r.cands) ? present : missing).push(r.label); }
  const criticalMissing = missing.filter((m) => m === 's2G' || m === 's2D');
  const hard = _MV_HARD.has(version);
  const blocking = hard && criticalMissing.length > 0;
  const degraded = !blocking && missing.includes('sv');
  return { version, hard, ok: missing.length === 0, missing, present, criticalMissing, blocking, degraded };
}
// 前端管线在开训前调用它显示底模体检 / 警告（?version=v2Pro 或 ?versions=v2,v2Pro,v2ProPlus）。
app.get("/api/models/status", (req, res) => {
  const raw = req.query.versions != null ? String(req.query.versions)
            : (req.query.version != null ? String(req.query.version) : 'v2');
  const seen = new Set(); const versions = [];
  for (const tok of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const nv = normModelVersion(tok);
    if (!seen.has(nv)) { seen.add(nv); versions.push(checkBaseModelsForVersion(nv)); }
  }
  if (!versions.length) versions.push(checkBaseModelsForVersion('v2'));
  const anyBlocking = versions.some((v) => v.blocking);
  const anyDegraded = versions.some((v) => v.degraded);
  // 顶层铺开首个版本字段，兼容旧前端单版本读法。
  res.json({ versions, anyBlocking, anyDegraded, ...versions[0] });
});

// ===========================
//  BASE MODEL (底模) — virtual builtin voice for zero-shot inference
// ===========================
// A single reserved, in-memory "voice" that lets users synthesize directly on the
// pretrained base weights WITHOUT fine-tuning first. Key properties:
//   • NEVER written to voices.json and has NO asset dir on disk → it shows in the
//     Generate voice dropdown (default) but NOT in the Assets management page
//     (which only scans real folders under ASSETS_DIR).
//   • GPT column: 1 entry (shared s1 base). SoVITS column: v2 / v2Pro (default) /
//     v2ProPlus, each resolved from GSV_PRETRAINED_DIR — a version missing on disk
//     is simply omitted so the dropdown only offers usable weights.
//   • Reference audio: NONE. Users borrow one via the existing "Use reference from
//     another voice" flow (base's own Slices/Raw are 0).
// All mutation endpoints (delete/scan/rebuild/refine/transcribe/…) already gate on
// fs.existsSync(voiceDir) or voices[id], so the dir-less base id is rejected there
// automatically — no extra guards needed.
const BASE_VOICE_ID = "__base__";
const BASE_VOICE_DISPLAY = "Base model";
function isBaseVoice(id) { return id === BASE_VOICE_ID; }

// Absolute s1 (GPT) base checkpoint, or null when absent.
function _baseS1Path() {
  return _mvFirstExisting([
    "gsv-v2final/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
    "gsv-v2final/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt",
    "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
  ]);
}
// SoVITS base weights per version. Order = dropdown order; `default` = pre-selected.
const _BASE_SOVITS_DEFS = [
  { version: "v2",        cands: ["gsv-v2final/s2G2333k.pth", "gsv-v2final/s2G488k.pth", "s2G2333k.pth"] },
  { version: "v2Pro",     cands: ["v2Pro/s2Gv2Pro.pth"], default: true },
  { version: "v2ProPlus", cands: ["v2Pro/s2Gv2ProPlus.pth"] },
];
// Build the { gpt:[], sovits:[] } checkpoint inventory the Generate dropdowns read.
function baseCheckpoints() {
  const s1 = _baseS1Path();
  const gpt = s1
    ? [{ name: `${BASE_VOICE_DISPLAY}_s1`, path: s1.replace(/\\/g, "/"), steps: null, builtin: true, default: true }]
    : [];
  const sovits = [];
  for (const d of _BASE_SOVITS_DEFS) {
    const fp = _mvFirstExisting(d.cands);
    if (fp) sovits.push({ name: `${BASE_VOICE_DISPLAY}_${d.version}`, path: fp.replace(/\\/g, "/"), version: d.version, builtin: true, default: !!d.default });
  }
  return { gpt, sovits };
}
// Synthetic asset meta for the base voice: empty roster (0 slices / 0 raw / no
// reference) + injected checkpoints so GET /api/assets/:id populates the dropdowns.
function baseVoiceMeta() {
  return {
    id: BASE_VOICE_ID,
    display_name: BASE_VOICE_DISPLAY,
    language: "auto", text_lang: "auto", prompt_lang: "auto",
    builtin: true,
    assets: { checkpoints: baseCheckpoints(), references: [] },
    segment_total: 0, segment_matched: 0,
  };
}
// voices.json-shaped registration record for voiceReg lookups (generate/validate).
function baseVoiceReg() {
  return { display_name: BASE_VOICE_DISPLAY, language: "auto", prompt_lang: "auto", text_lang: "auto", builtin: true };
}

// Collect every id that must be considered "taken" when allocating a new
// canonical voice id: asset folders ∪ voices.json ∪ retained tasks ∪ pending
// reservations. Also opportunistically prunes reservations already backed by a
// folder/task so the registry can't grow unbounded.
function collectTakenVoiceIds() {
  const taken = new Set();
  const backed = new Set();
  // Reserve the built-in Base model id so no fine-tuned voice can ever collide with it.
  taken.add(BASE_VOICE_ID);
  try {
    for (const e of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
      if (e.isDirectory()) { taken.add(e.name); backed.add(e.name); }
    }
  } catch (_) {}
  try { for (const k of Object.keys(loadVoices())) { taken.add(k); backed.add(k); } } catch (_) {}
  try {
    for (const t of (trainingPipeline.getAllTasks() || [])) {
      if (t && t.voiceId) { taken.add(t.voiceId); backed.add(t.voiceId); }
    }
  } catch (_) {}
  try { for (const id of assetId.listReservations()) taken.add(id); } catch (_) {}
  try { assetId.prune(backed); } catch (_) {}
  return taken;
}

// POST /api/assets/derive-id — return a PROPOSED (non-reserved) canonical id for
// a display name, for live preview in the create form. NOT authoritative: the
// final id is allocated atomically at task creation and may differ. The UI must
// label this as "proposed".
app.post("/api/assets/derive-id", requireApiKey, (req, res) => {
  const displayName = String((req.body && req.body.display_name) || "").trim();
  if (!displayName) return res.status(400).json({ error: "display_name is required" });
  const { base, proposed } = assetId.proposeVoiceId(displayName);
  // Surface whether the illustrative proposal currently collides so the UI can
  // hint that the final id will differ.
  let collides = false;
  try { collides = collectTakenVoiceIds().has(proposed); } catch (_) {}
  res.json({ proposed_id: proposed, base, reserved: false, collides });
});

app.post("/api/train/start", requireApiKey, async (req, res) => {
  try {
    const { voiceId: rawVoiceId, displayName: rawDisplayName, targetVoiceId,
            language, inputDir, steps: stepOptions, customParams, overwrite,
            resumeTaskId, forkFromTaskId, restartFailedStep } = req.body || {};
    // Option A: the create form now sends a human-facing display name. Legacy
    // clients that still send `voiceId` as free text are tolerated — it is
    // treated as the display name for id derivation (never as the id itself).
    const displayName = String((rawDisplayName != null ? rawDisplayName : rawVoiceId) || "").trim();
    if (!displayName && !(resumeTaskId || forkFromTaskId) && !targetVoiceId) {
      return res.status(400).json({ error: "Missing 'displayName'" });
    }
    if (!language) return res.status(400).json({ error: "Missing 'language'" });

    // Resume/断点恢复：续跑(resumeTaskId) 复用同 taskId+workDir，改参(forkFromTaskId)
    // 分叉出新任务复用上游产物。恢复模式下若不从 denoise/slice 起跑，原始 inputDir
    // 可能已不存在，允许其缺省；真正需要 inputDir 的早期步由下方门控拦截。
    const isRecovery = !!(resumeTaskId || forkFromTaskId);
    // 计算重跑起点：STEP_ORDER 中第一个 enabled 的步骤。
    const RESUME_STEP_ORDER = ['denoise', 'slice', 'asr', 'preprocess', 'train_s1', 'train_s2', 'finalize', 'promote'];
    const stepEnabled = (k) => {
      const so = stepOptions || {};
      const dflt = { denoise: false, slice: true, asr: true, preprocess: true, train_s1: true, train_s2: true, finalize: true, promote: true };
      if (k === 'train_s1' || k === 'train_s2') return (so[k] ?? so.train ?? dflt[k]) !== false;
      return (so[k] ?? dflt[k]) !== false;
    };
    const rerunStart = RESUME_STEP_ORDER.find(stepEnabled) || null;
    const needsInputDir = !isRecovery || rerunStart === 'denoise' || rerunStart === 'slice';
    if (!inputDir && needsInputDir) {
      return res.status(400).json({
        error: isRecovery
          ? "Input folder is required to resume from denoise/slice. Please re-select the original audio folder."
          : "Missing 'inputDir'",
        code: isRecovery ? "INPUT_DIR_REQUIRED" : undefined,
      });
    }

    // ── Canonical voice-id lifecycle (Option A) ───────────────────────────────
    // The id is IMMUTABLE and resolved exactly once here, atomically:
    //   * resume/fork  → reuse the source task's stored voiceId (never re-derived).
    //   * targetVoiceId→ explicit retrain/overwrite of an EXISTING voice (separate,
    //                    deliberate op; requires overwrite:true confirmation).
    //   * otherwise     → a BRAND-NEW voice: allocate a fresh ASCII id from the
    //                    display name under a critical section + reserve it.
    // A slug collision or a matching display name NEVER implies overwrite.
    let publishId = null;              // final canonical id
    let publishDisplayName = displayName || null;
    let reservedThisRequest = false;

    if (resumeTaskId || forkFromTaskId) {
      const srcId = resumeTaskId || forkFromTaskId;
      let j = null;
      try { j = trainingPipeline.readTaskJournal(srcId); } catch (_) {}
      if (!j || !j.voiceId) {
        return res.status(400).json({
          error: `Cannot resume: source task '${srcId}' has no stored voice id.`,
          code: "RESUME_NO_VOICEID",
        });
      }
      publishId = j.voiceId;
      publishDisplayName = publishDisplayName || j.displayName || publishId;
    } else if (targetVoiceId) {
      if (!safeId(targetVoiceId)) return res.status(400).json({ error: "Invalid targetVoiceId" });
      const existDir = path.join(ASSETS_DIR, targetVoiceId);
      let existingDisplay = null;
      if (fs.existsSync(path.join(existDir, "meta.json"))) {
        try { existingDisplay = JSON.parse(fs.readFileSync(path.join(existDir, "meta.json"), "utf-8")).display_name || targetVoiceId; }
        catch (_) { existingDisplay = targetVoiceId; }
      } else {
        try { const vs = loadVoices(); if (vs[targetVoiceId]) existingDisplay = vs[targetVoiceId].display_name || targetVoiceId; } catch (_) {}
      }
      if (!existingDisplay) {
        return res.status(404).json({ error: `Target voice '${targetVoiceId}' does not exist.`, code: "TARGET_NOT_FOUND" });
      }
      if (!overwrite) {
        return res.status(409).json({
          error: `Retraining will overwrite the existing voice "${existingDisplay}" (id: ${targetVoiceId}). Confirm to proceed.`,
          code: "VOICE_EXISTS",
          existingId: targetVoiceId,
          existingDisplay,
        });
      }
      publishId = targetVoiceId;
      publishDisplayName = publishDisplayName || existingDisplay;
    } else {
      // Brand-new voice: allocate + reserve atomically so two concurrent creations
      // can never receive the same id.
      publishId = await withVoicesLock(async () => {
        const taken = collectTakenVoiceIds();
        const id = assetId.allocateVoiceId(displayName, taken);
        assetId.reserve(id);
        return id;
      });
      reservedThisRequest = true;
    }

    // Invariant #5: an asset MUST end up with at least one kind of reference audio.
    // If the user neither slices (→ slicer_opt/) nor copies raw into the asset
    // (→ raw/), the published asset would have ZERO reference audio — a project-level
    // accident. Reject the impossible quadrant up front. copyRaw defaults to true.
    const willSlice = stepOptions?.slice !== false;
    const willCopyRaw = (stepOptions?.copyRaw ?? true) !== false;
    if (!willSlice && !willCopyRaw) {
      return res.status(400).json({
        error: "At least one kind of reference audio is required: enable Slicing, or turn on “Copy raw into the asset”. Disabling both would publish an asset with no reference audio at all.",
        code: "NO_REFERENCE_AUDIO",
      });
    }

    // 白名单校验 customParams
    const safeCustom = sanitizeCustomParams(customParams);

    // 底模门禁：若将训练 S2(SoVITS)，逐一体检所有目标版本；任一 hard 版本(v2Pro/
    // v2ProPlus)关键底模缺失 → 拒绝(否则产出电流声，属产品事故)。v2 可回退，仅警告。
    {
      const s2Enabled = ((stepOptions?.train_s2 ?? stepOptions?.train ?? true) !== false);
      if (s2Enabled) {
        const tv = safeCustom.training || {};
        const selVersions = (Array.isArray(tv.versions) && tv.versions.length) ? tv.versions
                          : (tv.version ? [tv.version] : ['v2']);
        const blocked = selVersions.map(checkBaseModelsForVersion).filter((r) => r.blocking);
        if (blocked.length) {
          return res.status(412).json({
            error: `Base models missing for: ${blocked.map((b) => `${b.version} (${b.criticalMissing.join('+')})`).join(', ')}. `
                 + `Download them with download_models.py before training these versions.`,
            code: "BASE_MODELS_MISSING",
            versions: blocked,
          });
        }
      }
    }

    // Validate language
    if (!ALLOWED_LANGUAGES.has(language)) {
      return res.status(400).json({ error: `Invalid language: ${language}. Allowed: ${[...ALLOWED_LANGUAGES].join(", ")}` });
    }

    // Validate inputDir. If TRAIN_DATA_ROOT is configured (distribution/hardened
    // mode) the directory must live under it; otherwise (local workbench) any
    // existing directory is allowed.
    if (inputDir) {
      const resolved = path.resolve(inputDir);
      if (TRAIN_DATA_ROOT) {
        const root = path.resolve(TRAIN_DATA_ROOT);
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
          return res.status(400).json({ error: "inputDir must be under TRAIN_DATA_ROOT" });
        }
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        // 恢复时若从需要 inputDir 的早期步起跑，缺失即拦下（英文门控）。
        if (needsInputDir) {
          return res.status(400).json({
            error: isRecovery
              ? "The original audio folder no longer exists. Resuming from denoise/slice needs it — please re-select the source folder."
              : "inputDir does not exist or is not a directory",
            code: isRecovery ? "INPUT_DIR_MISSING" : undefined,
          });
        }
      }
    }

    console.log(`[TRAIN] Creating pipeline: voiceId=${publishId}, display=${publishDisplayName}, lang=${language}`);
    let pipeline;
    try {
      pipeline = trainingPipeline.createPipeline({
        voiceId: publishId,
        displayName: publishDisplayName,
        language,
        inputDir,
        stepOptions: stepOptions || {},
        customParams: safeCustom,
        resumeTaskId: resumeTaskId || null,
        forkFromTaskId: forkFromTaskId || null,
        restartFailedStep: !!restartFailedStep,
      });
    } catch (createErr) {
      // Allocation succeeded but pipeline creation failed → release the reservation
      // so the id isn't leaked (it isn't yet backed by a task/folder).
      if (reservedThisRequest) { try { assetId.release(publishId); } catch (_) {} }
      throw createErr;
    }
    console.log(`[TRAIN] Pipeline created: ${pipeline.id}${isRecovery ? ` (recovery of ${resumeTaskId || forkFromTaskId})` : ''}`);

    // 异步启动，不等待完成
    pipeline.start().catch(err => console.error("[TRAINING] Pipeline error:", err));
    console.log(`[TRAIN] Pipeline started, sending response`);

    // NOTE (reservation lifetime): we intentionally do NOT release the reservation
    // here. The id must remain reserved for the full lifetime of the resumable
    // task. The reservation is now redundant with the task journal (getAllTasks
    // covers it), so collectTakenVoiceIds().prune() will lazily drop the
    // placeholder the next time an id is allocated — but only because the task
    // then backs the id. It is truly freed only on explicit delete / publish
    // (folder owns it) / loss of recovery eligibility.

    res.json({ ok: true, taskId: pipeline.id, voiceId: publishId, displayName: publishDisplayName });
    console.log(`[TRAIN] Response sent`);
  } catch (err) {
    console.error("[TRAIN] Error:", err);
    res.status(500).json({ error: clientError(err) });
  }
});

// ── Patch #12: Voice Refinement — derive a NEW voice from a parent ───────────
// Continues training from an existing asset's checkpoints and publishes the result
// as a brand-new derived Voice. The parent is NEVER modified or overwritten.
//   * S1 (GPT) and S2 (SoVITS) are independent — refine s1 | s2 | s1+s2.
//   * The refined step warm-starts from the parent's published checkpoint; the
//     un-refined step is reused verbatim (seeded under the new id + carried forward).
//   * A new canonical id is allocated via allocateVoiceId() (never the parent id).
//   * Pipeline: preprocess → [train_s1] → [train_s2] → finalize → promote.
const { versionFromName, normalizeVersion } = require("./lib/training/version");

function pickLatestByEpoch(files, re) {
  let best = null, bestE = -1;
  for (const f of files) {
    const m = f.match(re);
    if (!m) continue;
    const e = parseInt(m[1], 10);
    if (e > bestE) { bestE = e; best = f; }
  }
  return best ? { file: best, epoch: bestE } : null;
}

app.post("/api/assets/:id/refine", requireApiKey, async (req, res) => {
  const parentId = req.params.id;
  if (!safeId(parentId)) return res.status(400).json({ error: "Invalid id" });
  const parentDir = path.join(ASSETS_DIR, parentId);
  if (!fs.existsSync(parentDir)) return res.status(404).json({ error: `Voice '${parentId}' not found` });

  try {
    // Refinement mode. S1 (GPT) and S2 (SoVITS) are independent steps, so the user can
    // refine either or both — exactly like the Restore flow's independent train toggles.
    // Canonical types: 's1' | 's2' | 's1+s2'. The refined step continues training from
    // the parent's published checkpoint; the un-refined step is reused verbatim.
    const rawType = String((req.body && req.body.refinement_type) || "s2").toLowerCase().replace(/\s+/g, "");
    const wantS1 = rawType === "both" || rawType.includes("s1");
    const wantS2 = rawType === "both" || rawType.includes("s2");
    if (!wantS1 && !wantS2) {
      return res.status(400).json({
        error: "Select at least one model to refine (S1, S2, or both).",
        code: "REFINE_TYPE_EMPTY",
      });
    }
    const refinementType = wantS1 && wantS2 ? "s1+s2" : wantS1 ? "s1" : "s2";

    // Two-mode refine:
    //   reuse (default) — continue from the parent's frozen dataset (slice/ASR reused).
    //   own  — user brings a NEW audio folder; run the FULL pipeline on it, still
    //          warm-starting from the parent's checkpoints. New data only; no merge.
    const useOwnData = !!(req.body && req.body.use_own_data);
    const rawInputDir = String((req.body && req.body.input_dir) || "").trim().replace(/^["']|["']$/g, "");
    // Explicit warm-start checkpoint filenames (optional; default = latest by epoch).
    const reqS1File = String((req.body && req.body.base_s1_file) || "").trim();
    const reqS2File = String((req.body && req.body.base_s2_file) || "").trim();

    // Own-data mode: validate the new audio folder up front (same rules as train/start).
    if (useOwnData) {
      if (!rawInputDir) {
        return res.status(400).json({ error: "input_dir is required when use_own_data is set.", code: "INPUT_DIR_REQUIRED" });
      }
      const resolved = path.resolve(rawInputDir);
      if (TRAIN_DATA_ROOT) {
        const root = path.resolve(TRAIN_DATA_ROOT);
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
          return res.status(400).json({ error: "input_dir must be under TRAIN_DATA_ROOT" });
        }
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return res.status(400).json({ error: "input_dir does not exist or is not a directory", code: "INPUT_DIR_MISSING" });
      }
    }

    // Parent metadata: display name, language, version, lineage, transcript source.
    let pMeta = {};
    try { pMeta = JSON.parse(fs.readFileSync(path.join(parentDir, "meta.json"), "utf-8")); } catch (_) {}
    const parentDisplay = pMeta.display_name || parentId;
    // Language resolution (lineage-as-derivation model): the derived Voice inherits the
    // parent's language by default. Own-data refinement may explicitly declare a DIFFERENT
    // language for the new corpus (e.g. annealing a Japanese model on Chinese data → a
    // Chinese derivative) — that is just another branch in the refinement tree, so we
    // honour the client's language when provided. "auto" stays "auto" (never silently
    // coerced to a concrete language). No hard "ja" fallback anywhere.
    const VALID_LANGS = new Set(["auto", "ja", "zh", "en"]);
    const reqLang = String((req.body && req.body.language) || "").trim().toLowerCase();
    const language = (useOwnData && VALID_LANGS.has(reqLang))
      ? reqLang
      : (pMeta.language || "auto");
    const parentVersion = normalizeVersion(pMeta.base_version || "v2");

    // Locate the parent's published checkpoints. Both are required for S2 refinement:
    // the S1 checkpoint is reused verbatim, the S2 checkpoint is the warm-start point.
    const gptDir = path.join(parentDir, "gpt_checkpoints");
    const sovDir = path.join(parentDir, "sovits_models");
    const gptFiles = fs.existsSync(gptDir) ? fs.readdirSync(gptDir).filter(f => f.endsWith(".ckpt")) : [];
    const sovFiles = fs.existsSync(sovDir) ? fs.readdirSync(sovDir).filter(f => f.endsWith(".pth")) : [];
    if (gptFiles.length === 0 || sovFiles.length === 0) {
      return res.status(400).json({
        error: "The selected Voice has no published S1/S2 checkpoints to refine from.",
        code: "NO_CHECKPOINTS",
      });
    }
    // Warm-start selection. Honor an explicit filename when the user picked one in the
    // modal (must exist in the parent's checkpoint dir); otherwise default to latest epoch.
    let s1Pick;
    if (reqS1File && gptFiles.includes(reqS1File)) {
      s1Pick = { file: reqS1File, epoch: Number((reqS1File.match(/-e(\d+)\.ckpt$/i) || [])[1]) || null };
    } else if (reqS1File) {
      return res.status(400).json({ error: `S1 checkpoint not found: ${reqS1File}`, code: "CKPT_NOT_FOUND" });
    } else {
      s1Pick = pickLatestByEpoch(gptFiles, /-e(\d+)\.ckpt$/i);
    }
    // Prefer an S2 model matching the parent version so the warm-start shape matches.
    const sovSameVersion = sovFiles.filter(f => normalizeVersion(versionFromName(f) || "") === parentVersion);
    const s2Pool = sovSameVersion.length ? sovSameVersion : sovFiles;
    let s2Pick;
    if (reqS2File && sovFiles.includes(reqS2File)) {
      const sm = reqS2File.match(/_e(\d+)_s\d+\.pth$/i);
      s2Pick = { file: reqS2File, epoch: sm ? Number(sm[1]) : null };
    } else if (reqS2File) {
      return res.status(400).json({ error: `S2 checkpoint not found: ${reqS2File}`, code: "CKPT_NOT_FOUND" });
    } else {
      s2Pick = pickLatestByEpoch(s2Pool, /_e(\d+)_s\d+\.pth$/i) || { file: s2Pool[0], epoch: null };
    }
    if (!s1Pick || !s2Pick || !s2Pick.file) {
      return res.status(400).json({ error: "Could not resolve parent S1/S2 checkpoint filenames.", code: "CKPT_RESOLVE_FAILED" });
    }
    const baseS1Abs = path.join(gptDir, s1Pick.file);
    const baseS2Abs = path.join(sovDir, s2Pick.file);

    // Hyper-parameters (validated). Accept the shared training-form shape (params.training,
    // produced by buildTrainingParams) so the refine flow exposes the same fields as the
    // Training/Restore panels; fall back to the legacy flat additional_epochs/learning_rate.
    const bodyParams = (req.body && req.body.params && typeof req.body.params === "object") ? req.body.params : {};
    const bt = (bodyParams.training && typeof bodyParams.training === "object") ? bodyParams.training : {};
    // Clamp to [1,100] to match sanitizeCustomParams' epoch bounds, so the recorded
    // refinement.additional_*_epochs never diverges from what actually gets trained.
    const clampEpochs = (v, dflt) => {
      const e = Math.round(Number(v));
      return (Number.isFinite(e) && e >= 1 && e <= 100) ? e : dflt;
    };
    // "Additional epochs" per step == the epochs to run this warm-started session.
    const s1Epochs = clampEpochs(bt.gpt_epochs, 8);
    const s2Epochs = clampEpochs(bt.sovits_epochs != null ? bt.sovits_epochs : (req.body && req.body.additional_epochs), 8);
    let learningRate = Number(
      (bt.learning_rate != null && bt.learning_rate !== "default") ? bt.learning_rate
        : (req.body && req.body.learning_rate)
    );
    if (!Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1) learningRate = 0.0001;
    // The value surfaced as the singular refinement.additional_epochs (back-compat):
    // the primary refined step's epoch count.
    const additionalEpochs = wantS2 ? s2Epochs : s1Epochs;

    // Lineage: original voice = generation 0 (no refinement field); each refinement
    // increments generation and preserves the ORIGINAL root across chains.
    const parentGen = Number(pMeta.refinement && pMeta.refinement.generation) || 0;
    const generation = parentGen + 1;
    const rootVoiceId = (pMeta.refinement && pMeta.refinement.root_voice_id) || parentId;

    // Default derived display name: "<parent> · <S1|S2|S1+S2> Refined <n>" (NEVER a
    // "v2" suffix, which collides with GPT-SoVITS model versions). <n> counts existing
    // children of THIS parent that share the same refinement_type.
    const typeLabel = refinementType === "s1+s2" ? "S1+S2" : refinementType === "s1" ? "S1" : "S2";
    let n = 1;
    try {
      for (const e of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, e.name, "meta.json"), "utf-8"));
          if (m.refinement && m.refinement.parent_voice_id === parentId && m.refinement.refinement_type === refinementType) n += 1;
        } catch (_) {}
      }
    } catch (_) {}
    const defaultName = `${parentDisplay} · ${typeLabel} Refined ${n}`;
    const displayName = String((req.body && req.body.display_name) || "").trim() || defaultName;

    // Freeze the training-data source (transcript provenance) at creation time so a
    // later edit to the parent's transcript can't retroactively change this run.
    let transcriptSnapshot = null;
    try {
      const listPath = path.join(parentDir, "asr_opt", "slicer_opt.list");
      const rawListPath = path.join(parentDir, "asr_opt", "raw_opt.list");
      const usedList = fs.existsSync(listPath) ? listPath : (fs.existsSync(rawListPath) ? rawListPath : null);
      const prov = (pMeta.transcript && typeof pMeta.transcript === "object") ? pMeta.transcript : {};
      let contentHash = null;
      if (usedList) {
        contentHash = crypto.createHash("sha256").update(fs.readFileSync(usedList)).digest("hex").slice(0, 16);
      }
      transcriptSnapshot = {
        source: prov.source || (usedList ? "machine_generated" : "unknown"),
        revision: prov.revision != null ? prov.revision : null,
        revised_at: prov.revised_at || null,
        content_hash: contentHash,
        list: usedList ? path.basename(usedList) : null,
        frozen_at: new Date().toISOString(),
      };
    } catch (_) {}

    // Allocate + reserve a fresh id atomically, then seed the new asset directory.
    const newId = await withVoicesLock(async () => {
      const taken = collectTakenVoiceIds();
      const id = assetId.allocateVoiceId(displayName, taken);
      assetId.reserve(id);
      return id;
    });

    const newDir = path.join(ASSETS_DIR, newId);
    // Only tag the checkpoint stem with a CONCRETE language ("auto" is not a real
    // language and must not leak into filenames).
    const stemLang = language && language !== "auto" ? language : "";
    const newStem = (!stemLang || new RegExp(`_${stemLang}$`, "i").test(newId)) ? newId : `${newId}_${stemLang}`;
    try {
      // Seed reference material from the parent so preprocess (audio) + finalize
      // (carry-forward) can build the derived asset without re-slicing/re-ASR.
      fs.mkdirSync(newDir, { recursive: true });
      const copyDir = (sub) => {
        const src = path.join(parentDir, sub);
        if (fs.existsSync(src)) fs.cpSync(src, path.join(newDir, sub), { recursive: true });
      };
      // Reuse mode only: seed the parent's frozen dataset so preprocess can run without
      // re-slicing/re-ASR. Own-data mode brings a NEW folder → full pipeline builds these.
      if (!useOwnData) {
        copyDir("slicer_opt");
        copyDir("raw");
        copyDir("asr_opt");
        const segSrc = path.join(parentDir, "segments.json");
        if (fs.existsSync(segSrc)) fs.copyFileSync(segSrc, path.join(newDir, "segments.json"));
      }

      // Seed REUSED checkpoints under the NEW id stem (metadata rebuild is filename
      // driven — the derived asset's model files MUST carry the new id, not the parent).
      // finalize's carry-forward will publish whichever step is NOT retrained this run.
      // A refined step is intentionally NOT seeded — it produces a fresh checkpoint.
      if (!wantS1) {
        // S2-only mode: reuse the parent S1 verbatim.
        const s1EpochTok = (s1Pick.file.match(/-e(\d+)\.ckpt$/i) || [null, s1Pick.epoch])[1];
        const newGptDir = path.join(newDir, "gpt_checkpoints");
        fs.mkdirSync(newGptDir, { recursive: true });
        fs.copyFileSync(baseS1Abs, path.join(newGptDir, `${newStem}-e${s1EpochTok}.ckpt`));
      }
      if (!wantS2) {
        // S1-only mode: reuse the parent S2 verbatim. Rebuild the filename under the
        // new stem so it matches finalize's mkSovitsName (<stem>_<ver>_e<n>_s<k>.pth).
        const sm = s2Pick.file.match(/_e(\d+)_s(\d+)\.pth$/i);
        const verTag = normalizeVersion(versionFromName(s2Pick.file) || parentVersion) || parentVersion;
        const newSov = sm
          ? `${newStem}${verTag ? "_" + verTag : ""}_e${sm[1]}_s${sm[2]}.pth`
          : `${newStem}${verTag ? "_" + verTag : ""}.pth`;
        const newSovDir = path.join(newDir, "sovits_models");
        fs.mkdirSync(newSovDir, { recursive: true });
        fs.copyFileSync(baseS2Abs, path.join(newSovDir, newSov));
      }
    } catch (seedErr) {
      try { assetId.release(newId); } catch (_) {}
      try { fs.rmSync(newDir, { recursive: true, force: true }); } catch (_) {}
      throw seedErr;
    }

    // base_s1/base_s2 are ABSOLUTE paths so the warm-start loader (train.js) can read
    // them directly; they also record the exact lineage on the derived asset's meta.
    const refinement = {
      refinement_type: refinementType,
      parent_voice_id: parentId,
      root_voice_id: rootVoiceId,
      generation,
      base_s1_checkpoint: baseS1Abs,
      base_s2_checkpoint: baseS2Abs,
      additional_epochs: additionalEpochs,
      additional_s1_epochs: wantS1 ? s1Epochs : null,
      additional_s2_epochs: wantS2 ? s2Epochs : null,
      learning_rate: learningRate,
      created_at: new Date().toISOString(),
      // reuse = continue from parent's frozen dataset; own = user's new audio folder.
      data_mode: useOwnData ? "own" : "reuse",
      input_dir: useOwnData ? path.resolve(rawInputDir) : null,
      base_s1_file: s1Pick.file,
      base_s2_file: s2Pick.file,
      transcript_source: useOwnData ? "own_data" : (transcriptSnapshot ? transcriptSnapshot.source : null),
      transcript: useOwnData ? null : transcriptSnapshot,
    };

    // Own-data mode may carry slice/asr/denoise params (params.steps.{slice|asr|denoise}.params).
    const bodySteps = (bodyParams.steps && typeof bodyParams.steps === "object") ? bodyParams.steps : {};
    // Force the version to the parent's so warm-start checkpoint shapes match. All other
    // training fields flow through from the shared form (params.training).
    const safeCustom = sanitizeCustomParams({
      training: {
        ...bt,
        version: parentVersion,
        versions: [parentVersion],
        gpt_epochs: s1Epochs,
        sovits_epochs: s2Epochs,
        learning_rate: learningRate,
      },
      ...(useOwnData ? { steps: bodySteps } : {}),
    });

    // Step plan:
    //   reuse → preprocess → [train] → finalize → promote (slice/ASR reused from parent).
    //   own   → (denoise) → slice → ASR → preprocess → [train] → finalize → promote,
    //           warm-started from the parent checkpoints. New data only, no merge.
    const rt = (req.body && req.body.steps && typeof req.body.steps === "object") ? req.body.steps : {};
    const stepOptions = useOwnData
      ? {
          denoise: !!rt.denoise,
          slice: rt.slice !== false,
          asr: rt.asr !== false,
          preprocess: true,
          train_s1: wantS1, train_s2: wantS2, finalize: true, promote: true,
          copyRaw: rt.copyRaw !== false,
          pauseAfterAsr: !!rt.pauseAfterAsr,
          ...(rt.asrGraceSec != null ? { asrGraceSec: rt.asrGraceSec } : {}),
        }
      : {
          denoise: false, slice: false, asr: false, preprocess: true,
          train_s1: wantS1, train_s2: wantS2, finalize: true, promote: true,
          copyRaw: false,
        };

    let pipeline;
    try {
      pipeline = trainingPipeline.createPipeline({
        voiceId: newId,
        displayName,
        language,
        inputDir: useOwnData ? path.resolve(rawInputDir) : parentDir,
        stepOptions,
        customParams: safeCustom,
        refinement,
      });
    } catch (createErr) {
      try { assetId.release(newId); } catch (_) {}
      try { fs.rmSync(newDir, { recursive: true, force: true }); } catch (_) {}
      throw createErr;
    }

    pipeline.start().catch(err => console.error("[REFINE] Pipeline error:", err));
    console.log(`[REFINE] ${parentId} → ${newId} (${refinementType}${wantS1 ? " S1+" + s1Epochs + "ep" : ""}${wantS2 ? " S2+" + s2Epochs + "ep" : ""} lr=${learningRate}, gen ${generation})`);
    res.json({
      ok: true, taskId: pipeline.id, voiceId: newId, displayName,
      refinementType, parentVoiceId: parentId, rootVoiceId, generation,
      additionalS1Epochs: wantS1 ? s1Epochs : null,
      additionalS2Epochs: wantS2 ? s2Epochs : null,
      learningRate,
      baseS1Checkpoint: s1Pick.file, baseS2Checkpoint: s2Pick.file,
      dataMode: useOwnData ? "own" : "reuse",
    });
  } catch (err) {
    console.error("[REFINE] Error:", err);
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

// ── P6: 人工校对（ASR 后暂停）───────────────────────────────────────────────
// GET  读取当前可校对的 .list（awaiting_review 时有效，其它状态也可只读预览）
app.get("/api/train/review/:id", (req, res) => {
  const task = trainingPipeline.getTask(req.params.id);
  if (!task || typeof task.getReviewList !== "function") return res.status(404).json({ error: "Task not found" });
  const data = task.getReviewList();
  if (!data) return res.status(404).json({ error: "No review list available (ASR not produced yet)" });
  res.json(data);
});

// GET 试听校对片段音频（Range 支持，供校对面板的播放/暂停按钮用）。
// path 为 .list 里的资产内相对路径；解析与目录穿越防护由 task.resolveReviewAudioPath 负责。
app.get("/api/train/review/:id/audio", (req, res) => {
  const task = trainingPipeline.getTask(req.params.id);
  if (!task || typeof task.resolveReviewAudioPath !== "function") return res.status(404).end();
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const filePath = task.resolveReviewAudioPath(rel);
  if (!filePath) return res.status(404).end();
  let stat;
  try { stat = fs.statSync(filePath); } catch { return res.status(404).end(); }
  const ext = path.extname(filePath).toLowerCase();
  const mime = { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".ogg": "audio/ogg" }[ext] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    if (isNaN(start) || start >= stat.size || end >= stat.size) {
      return res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": stat.size, "Accept-Ranges": "bytes", "Content-Type": mime });
    fs.createReadStream(filePath).pipe(res);
  }
});

// POST 保存用户校对后的文本（写回 .list + segments.json）。可在 awaiting_review 期间反复保存。
app.post("/api/train/review/:id", requireApiKey, (req, res) => {
  const task = trainingPipeline.getTask(req.params.id);
  if (!task || typeof task.saveReviewList !== "function") return res.status(404).json({ error: "Task not found" });
  try {
    const rows = (req.body && req.body.rows) || [];
    const result = task.saveReviewList(rows);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: clientError(err) });
  }
});

// POST 结束校对，放行管线继续（preprocess→train→…）。
app.post("/api/train/resume/:id", requireApiKey, (req, res) => {
  const task = trainingPipeline.getTask(req.params.id);
  if (!task || typeof task.resume !== "function") return res.status(404).json({ error: "Task not found" });
  // 若同时带了 rows，则先保存再放行，省一次往返。
  try {
    if (req.body && Array.isArray(req.body.rows) && typeof task.saveReviewList === "function") {
      task.saveReviewList(req.body.rows);
    }
  } catch (err) {
    return res.status(400).json({ error: clientError(err) });
  }
  const ok = task.resume();
  if (!ok) return res.status(409).json({ error: "Task is not awaiting review" });
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

// GET /api/train/recoverable — 缓存里所有可恢复(failed + interrupted)的微调任务，
// 含失败步、英文原因、原始参数，供"恢复训练"面板列出并回填。
app.get("/api/train/recoverable", (req, res) => {
  try {
    const list = typeof trainingPipeline.listRecoverable === "function"
      ? trainingPipeline.listRecoverable() : [];
    res.json({ tasks: list });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
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
        console.error(`[CLEAR-STAGING] failed to remove ${dir}:`, e.message);
      }
    }

    console.log(`[CLEAR-STAGING] removed ${removed} staging dir(s), freed ${bytes} byte(s), skipped ${skipped}`);
    res.json({ ok: true, removed, bytes, skipped });
  } catch (err) {
    console.error("[CLEAR-STAGING] Error:", err);
    res.status(500).json({ error: clientError(err) });
  }
});

// ===========================
//  RECIPES API (P0 keystone)
// ===========================
//
// Recipes are role-scoped, reusable inference presets. CRUD operates by
// (role, name); the OpenAI /v1/audio/speech endpoint resolves them via the
// `voice` field ("role/name"). Storage + validation live in lib/recipeStore.js.

// Reject a recipe whose role is not a known voice — keeps recipes anchored to
// real assets and blocks typos from creating orphan presets.
function knownVoice(role) {
  try { return Object.prototype.hasOwnProperty.call(loadVoices(), role); }
  catch (_) { return false; }
}

// GET /api/recipes — list all, or ?role= to scope to one voice.
app.get("/api/recipes", requireApiKey, (req, res) => {
  try {
    const role = req.query.role ? String(req.query.role) : null;
    res.json({ recipes: recipeStore.list(role ? { role } : undefined) });
  } catch (err) {
    res.status(500).json({ error: clientError(err, "failed to list recipes") });
  }
});

// GET /api/recipes/:role/:name — fetch one.
app.get("/api/recipes/:role/:name", requireApiKey, (req, res) => {
  const rec = recipeStore.get(req.params.role, req.params.name);
  if (!rec) return res.status(404).json({ error: "recipe not found" });
  res.json({ recipe: rec });
});

// POST /api/recipes — create. Body carries the full recipe payload. Duplicate
// (role,name) is rejected with 409 unless { force:true } (overwrite, keeps
// created_at). The frontend uses 409 to raise the "already exists, overwrite?"
// confirmation.
app.post("/api/recipes", requireApiKey, (req, res) => {
  const body = req.body || {};
  const role = body.role != null ? body.role : body.voiceId;
  if (!knownVoice(role)) {
    return res.status(400).json({ error: `unknown voice: ${role}` });
  }
  // v3: pin managed paths as ASSETS_ROOT-relative { base, path } objects. Files
  // outside ASSETS_ROOT are external/non-portable: models require
  // allow_external_models, reference/aux audio require the SEPARATE
  // allow_external_audio (default OFF — model permission never authorizes audio).
  // A force-overwrite of a legacy v2 recipe keeps v2 string semantics (no silent
  // migration); only a genuinely new recipe mints v3.
  const nameV = recipeStore.validateName(body.name);
  const existingRec = nameV.ok ? recipeStore.get(role, nameV.value) : null;
  const targetV3 = !(existingRec && (existingRec.schema_version || 1) < 3);
  const cls = classifyRecipeManagedFields(body, {
    targetV3,
    allowExternalModels: !!body.allow_external_models,
    allowExternalAudio: !!body.allow_external_audio,
    role,
  });
  if (!cls.ok) return res.status(400).json({ error: cls.error, code: cls.code, field: cls.field });
  const force = !!body.force;
  const r = recipeStore.create(body, { force });
  if (!r.ok) {
    if (r.code === "exists") return res.status(409).json({ error: r.error, code: "exists" });
    return res.status(400).json({ error: r.error });
  }
  res.status(201).json({ recipe: r.recipe });
});

// PUT /api/recipes/:role/:name — merge-update (Broker model re-bind + edits).
app.put("/api/recipes/:role/:name", requireApiKey, (req, res) => {
  const body = req.body || {};
  // Same field-aware guard on the Broker re-bind path. Schema is PRESERVED: a v2
  // recipe keeps v2 string model paths (no silent migration to v3); a v3 recipe
  // gets v3 { base, path } objects. Migration to v3 is a separate explicit flow.
  const existingRec = recipeStore.get(req.params.role, req.params.name);
  const targetV3 = !!(existingRec && (existingRec.schema_version || 1) >= 3);
  const cls = classifyRecipeManagedFields(body, {
    targetV3,
    allowExternalModels: !!body.allow_external_models,
    allowExternalAudio: !!body.allow_external_audio,
    role: req.params.role,
  });
  if (!cls.ok) return res.status(400).json({ error: cls.error, code: cls.code, field: cls.field });
  const r = recipeStore.update(req.params.role, req.params.name, body);
  if (!r.ok) {
    if (r.code === "not_found") return res.status(404).json({ error: r.error });
    return res.status(400).json({ error: r.error });
  }
  res.json({ recipe: r.recipe });
});

// DELETE /api/recipes/:role/:name — remove one.
app.delete("/api/recipes/:role/:name", requireApiKey, (req, res) => {
  const ok = recipeStore.remove(req.params.role, req.params.name);
  if (!ok) return res.status(404).json({ error: "recipe not found" });
  res.json({ ok: true });
});

// ── Recipe v2→v3 path migration (explicit, assisted; never auto/startup) ──────
// GET preview — READ-ONLY. Classifies every v<3 recipe's managed paths into
// convertible/external/missing/ambiguous. Writes nothing.
app.get("/api/recipes/migration/preview", requireApiKey, (req, res) => {
  try {
    res.json({ assets_root: ASSETS_ROOT, app_dir: APP_DIR, recipes: recipeMigrator.preview() });
  } catch (err) {
    res.status(500).json({ error: clientError(err, "migration preview failed") });
  }
});

// POST apply — backs up then rewrites ONE recipe to v3. Refuses when any field is
// ambiguous/missing unless the body supplies explicit `resolutions`
// (field → { base, path }). Ambiguous/missing are NEVER auto-selected.
app.post("/api/recipes/migration/apply", requireApiKey, (req, res) => {
  const body = req.body || {};
  const file = String(body.file || "");
  if (!file || !/^recipe_.+\.json$/.test(file) || file.includes("/") || file.includes("\\")) {
    return res.status(400).json({ error: "invalid recipe file name" });
  }
  try {
    const r = recipeMigrator.apply(file, { resolutions: body.resolutions || {} });
    if (!r.ok) return res.status(409).json({ error: r.error, field: r.field, status: r.status });
    res.json({ ok: true, backup: r.backup, recipe: r.recipe });
  } catch (err) {
    res.status(500).json({ error: clientError(err, "migration apply failed") });
  }
});

// POST revert — restore a recipe from its most recent (or named) backup.
app.post("/api/recipes/migration/revert", requireApiKey, (req, res) => {
  const body = req.body || {};
  const file = String(body.file || "");
  if (!file || !/^recipe_.+\.json$/.test(file) || file.includes("/") || file.includes("\\")) {
    return res.status(400).json({ error: "invalid recipe file name" });
  }
  try {
    const r = recipeMigrator.revert(file, { backup: body.backup });
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json({ ok: true, restored_from: r.restored_from });
  } catch (err) {
    res.status(500).json({ error: clientError(err, "migration revert failed") });
  }
});

// GET /api/assets/voices-with-models — the first-level picker for the Broker
// re-bind (PC). Lists every voice that owns at least one GPT ckpt or SoVITS pth,
// with per-type flags so the GPT box only offers voices that have GPT models and
// the SoVITS box only those with SoVITS models (PC-1).
app.get("/api/assets/voices-with-models", requireApiKey, (req, res) => {
  let voices;
  try { voices = loadVoices(); } catch (err) { return res.status(500).json({ error: clientError(err, "voices.json error") }); }
  const out = [];
  for (const [voiceId, reg] of Object.entries(voices)) {
    const metaPath = path.join(ASSETS_DIR, voiceId, "meta.json");
    let gptCount = 0, sovitsCount = 0;
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        const ck = (meta && meta.assets && meta.assets.checkpoints) || {};
        gptCount = (ck.gpt || []).length;
        sovitsCount = (ck.sovits || []).length;
      }
    } catch (_) { /* skip unreadable meta */ }
    if (gptCount === 0 && sovitsCount === 0) continue;
    out.push({
      voiceId,
      displayName: (reg && (reg.display_name || reg.name)) || voiceId,
      hasGpt: gptCount > 0,
      hasSovits: sovitsCount > 0,
      gptCount, sovitsCount,
    });
  }
  out.sort((a, b) => a.voiceId.localeCompare(b.voiceId));
  res.json({ voices: out });
});

// GET /api/recipes-models/:role — list a voice's available GPT/SoVITS
// checkpoints (from meta.json) for the Broker page "project query" model
// re-bind path. Returns project-relative paths so recipes stay portable.
app.get("/api/recipes-models/:role", requireApiKey, (req, res) => {
  const role = req.params.role;
  if (!knownVoice(role)) return res.status(404).json({ error: `unknown voice: ${role}` });
  const metaPath = path.join(ASSETS_DIR, role, "meta.json");
  const toRel = (p) => {
    if (!p) return "";
    const norm = String(p).replace(/\\/g, "/");
    const marker = `/assets/${role}/`;
    const i = norm.indexOf(marker);
    return i >= 0 ? norm.slice(i + 1) : norm; // strip up to "assets/<role>/..."
  };
  let gpt = [], sovits = [];
  try {
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const ck = (meta && meta.assets && meta.assets.checkpoints) || {};
      gpt = (ck.gpt || []).map(x => ({ name: x.name, path: toRel(x.path), steps: x.steps }));
      sovits = (ck.sovits || []).map(x => ({ name: x.name, path: toRel(x.path), version: x.version }));
    }
  } catch (err) {
    return res.status(500).json({ error: clientError(err, "failed to read checkpoints") });
  }
  res.json({ role, gpt, sovits });
});

// ===========================
//  SERVE REACT FRONTEND
// ===========================

app.use(express.static(WEB_DIST));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/outputs/") || req.path.startsWith("/v1/")) {
    return res.status(404).json({ error: "Not found" });
  }
  // A request that looks like a static file (has a real extension, e.g. .js/.css/
  // .map/.png) but reached this catch-all means express.static did NOT find it.
  // Returning index.html (text/html) here makes browsers reject module scripts
  // with a MIME error and shows a blank page. Return a clean 404 instead so a
  // stale/mismatched web/dist surfaces as an obvious missing asset rather than a
  // white screen. Only genuine SPA client routes (no file extension) get index.html.
  if (/\.[a-zA-Z0-9]+$/.test(req.path)) {
    return res.status(404).send("Not found: " + req.path);
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
          console.log(`[RECOVERY] task ${data.id} (${data.voiceId}) marked as interrupted`);
        }
      } catch (e) {
        // ignore corrupt task.json
      }
    }
  } catch (e) {
    console.error('[RECOVERY] failed to scan staging directory:', e.message);
  }
}

// ---- Start ----
app.listen(PORT, HOST, () => {
  console.log(`\n========================================`);
  console.log(`  TTS Voice Asset Manager`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  ffmpeg: ${checkFfmpeg() ? "available" : "not found (using pure-Node concat)"}`);
  // Warm the CUDA probe in the background so /api/health has a ready answer.
  startCudaProbe();
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
        console.log("[ASSETS] some voices are missing meta.json/segments.json; auto-scanning at startup...");
        const results = await runFullAssetScan();
        console.log(`[ASSETS] auto-scan complete: ${Object.keys(results).length} voice(s) ready`);
      } else {
        console.log("[ASSETS] asset metadata is ready; skipping auto-scan");
      }
    } catch (e) {
      console.error("[ASSETS] startup auto-scan failed:", e.message);
    }
  })();
});
