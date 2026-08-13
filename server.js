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

// ── File logging (1.0.7) ──────────────────────────────────────────
// Tee console.log/info/warn/error to a daily-rotating file under logs/ (or
// AURIVOX_LOG_DIR) so a distributed/headless run leaves an audit trail without
// touching any existing console call site. Disable with AURIVOX_LOG_FILE=0.
(function setupFileLogging() {
  if (process.env.AURIVOX_LOG_FILE === "0") return;
  try {
    const logDir = process.env.AURIVOX_LOG_DIR || path.join(__dirname, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    let day = ""; let stream = null;
    const openFor = (d) => {
      if (stream && day === d) return stream;
      if (stream) { try { stream.end(); } catch (_) {} }
      day = d;
      stream = fs.createWriteStream(path.join(logDir, `aurivox-${d}.log`), { flags: "a" });
      stream.on("error", () => {}); // a log write must never crash the server
      return stream;
    };
    const fmt = (a) => (typeof a === "string" ? a
      : (a instanceof Error ? (a.stack || a.message)
      : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })()));
    const write = (level, args) => {
      try {
        const now = new Date();
        const line = `[${now.toISOString()}] [${level}] ` + args.map(fmt).join(" ") + "\n";
        openFor(now.toISOString().slice(0, 10)).write(line);
      } catch (_) { /* logging must never throw */ }
    };
    for (const level of ["log", "info", "warn", "error"]) {
      const orig = console[level].bind(console);
      console[level] = (...args) => { orig(...args); write(level.toUpperCase(), args); };
    }
    console.log(`[LOG] file logging -> ${logDir} (disable with AURIVOX_LOG_FILE=0)`);
  } catch (e) {
    try { console.error("[LOG] file logging disabled:", e.message); } catch (_) {}
  }
})();

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
// Stage-0 extractions (behaviour-preserving): the local inference HTTP client,
// WAV/ffmpeg audio utilities, audio concatenation, and the CUDA probe were
// moved out of this file verbatim. They are re-imported here so every existing
// call site in server.js keeps working unchanged.
const { gsvRequest, gsvPost, gsvGet, gsvStream } = require("./lib/gsv/client");
const {
  generateSilenceWav, findWavDataChunk, toPcm16Wav,
  wavDurationSec, computeSegmentBounds, concatWavPureNode,
} = require("./lib/audio/wav");
const {
  vendoredFfmpegPath, ffmpegCmd, checkFfmpeg, AUDIO_FORMATS, transcodeAudio,
} = require("./lib/audio/ffmpeg");
const { concatWavFiles, concatWithFfmpeg } = require("./lib/audio/concat");
const { startCudaProbe, detectCuda } = require("./lib/system/cuda");
// Stage-2 extractions: generic async mutex + voices.json store (persistence +
// write lock + rotating backups). These replace the two bare module-level
// `let` locks below with encapsulated instances; same-named wrappers keep all
// existing call sites unchanged.
const { Mutex } = require("./lib/util/mutex");
const { HttpError } = require("./lib/http/http");
const { VoicesStore } = require("./lib/voices/store");
// voiceId → { status, startedAt, finishedAt, sources, done, error, logs } for the
// in-place transcribe jobs. In-memory only (best-effort progress, like training).
const transcribeJobs = new Map();

// ── Graceful-shutdown coordinator (1.0.7) ─────────────────────────
// On SIGINT/SIGTERM we stop accepting NEW connections and, by default, WAIT for
// in-flight synthesis to finish before exiting (no truncated audio). A request
// may OPT IN to being aborted on shutdown by sending `interrupted:true` in its
// body: those are cancelled immediately (client socket closed -> upstream engine
// stream aborted) instead of holding the drain. A second signal, or exceeding
// AURIVOX_SHUTDOWN_GRACE_MS (default 120000), forces exit.
const _inflight = new Set(); // { interruptible:boolean, abort():void } per active request
let _shuttingDown = false;
const shutdownState = {
  get active() { return _inflight.size; },
  get shuttingDown() { return _shuttingDown; },
  register(entry) { _inflight.add(entry); return () => _inflight.delete(entry); },
};

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

// CORS (1.0.7): the browser origin(s) allowed to call this broker cross-origin.
// Default is the Vite dev server (http://127.0.0.1:5173), used ONLY during
// frontend development — in production the UI is served same-origin from
// web/dist and needs no CORS at all. Set AURIVOX_CORS_ORIGIN to a comma-separated
// allow-list (or "*" for any) to let an external OpenAI-compatible client call
// /v1 from a web page.
const CORS_ORIGIN = (process.env.AURIVOX_CORS_ORIGIN || "http://127.0.0.1:5173").trim();
app.use(cors({ origin: CORS_ORIGIN === "*" ? true
  : CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean) }));
app.use(express.json({ limit: "10mb" }));
app.use(validateHost);

// ---- Static: assets/ for audio playback ----
function safeStaticRoot(rootDir) {
  const root = path.resolve(rootDir);
  return (req, res, next) => {
    let rel;
    try {
      // decodeURIComponent can throw on malformed percent sequences; reject them.
      rel = decodeURIComponent(req.path);
    } catch (_) {
      return res.status(400).end();
    }
    // Strip leading separators after URL decoding. Reject NUL bytes and
    // absolute / drive paths before path.join() can interpret them.
    rel = rel.replace(/^[\\/]+/, "");
    if (rel.includes("\0") || path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
      return res.status(404).end();
    }
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return res.status(404).end();
    }
    next();
  };
}

app.use("/assets", safeStaticRoot(ASSETS_DIR), express.static(ASSETS_DIR));

// ---- Static: voices/ for reference-audio playback (uploaded + custom refs) ----
app.use("/voices", safeStaticRoot(VOICES_DIR), express.static(VOICES_DIR));

// ---- Static: outputs/ with Range support ----
app.use("/outputs", safeStaticRoot(OUTPUT_DIR), (req, res, next) => {
  const rel = decodeURIComponent(req.path).replace(/^[\\/]+/, "");
  const filePath = path.resolve(OUTPUT_DIR, rel);
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

// Voices persistence, the write mutex, and rotating backups now live in
// lib/voices/store.js; concurrent generation requests use a standalone Mutex.
// This removes the two bare module-level `let` locks (Stage-2 refactor). The
// same-named wrappers below preserve every existing call site verbatim.
const MAX_BACKUPS = 20;
const voicesStore = new VoicesStore({ voicesJson: VOICES_JSON, backupDir: BACKUP_DIR, maxBackups: MAX_BACKUPS });
// A-2 (bounded admission): cap how many synthesis requests may QUEUE behind the
// single-GPU engine. Beyond this, requests are rejected fast with 503 +
// Retry-After instead of piling up unbounded latency. 0 = unbounded (legacy).
// Tune via AURIVOX_MAX_QUEUE; Retry-After seconds via AURIVOX_RETRY_AFTER.
const _GEN_MAX_QUEUE = (() => {
  const n = parseInt(process.env.AURIVOX_MAX_QUEUE, 10);
  return (Number.isInteger(n) && n >= 0) ? n : 32;
})();
const _GEN_RETRY_AFTER = (() => {
  const n = parseInt(process.env.AURIVOX_RETRY_AFTER, 10);
  return (Number.isInteger(n) && n >= 1) ? n : 3;
})();
const _generationMutex = new Mutex({ maxPending: _GEN_MAX_QUEUE });
// Same-model request coalescing (point 4): remembers the engine's currently
// resident GPT/SoVITS weights and skips the redundant /set_*_weights reload
// when the next request wants the same pair. Safe because every switchModels
// call runs under _generationMutex (serialised) — see lib/gsv/modelState.js.
const { ModelSwitcher } = require("./lib/gsv/modelState");
const _modelSwitcher = new ModelSwitcher(gsvGet);
// Feed engine liveness into the switcher so an engine restart (offline->online)
// invalidates the resident-weights cache; the /api/health route calls this.
function noteEngineHealth(online) { return _modelSwitcher.noteEngineHealth(online); }

function loadVoices() { return voicesStore.load(); }
function saveVoices(data) { return voicesStore.save(data); }
function withVoicesLock(fn) { return voicesStore.withLock(fn); }
// Translate a full-queue rejection (A-2) into an HTTP 503 the route layer
// already serialises (asyncHandler applies err.headers, so Retry-After reaches
// the client). Non-overflow errors propagate verbatim.
async function withGenerationLock(fn) {
  try {
    return await _generationMutex.runExclusive(fn);
  } catch (err) {
    if (err && err.code === "GENERATION_QUEUE_FULL") {
      throw new HttpError(
        503,
        { message: "Server is busy: too many synthesis requests are already queued. Retry shortly.", type: "server_overloaded", code: "generation_queue_full" },
        { pending: err.pending, max_pending: err.maxPending, retry_after: _GEN_RETRY_AFTER },
        { "Retry-After": String(_GEN_RETRY_AFTER) },
      );
    }
    throw err;
  }
}
function _backupVoicesUnlocked() { return voicesStore._backupUnlocked(); }
function backupVoices() { return voicesStore.backup(); }

// ===========================
//  HTTP HELPERS
// ===========================
// gsvRequest / gsvPost / gsvGet moved to ./lib/gsv/client.js (Stage-0 refactor).

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
//  AUDIO / FFMPEG / CUDA (extracted)
// ===========================
// The ffmpeg detection cache, OpenAI-format transcode table, WAV parsing/
// synthesis/concatenation helpers, and the CUDA probe were moved verbatim to
// ./lib/audio/ffmpeg.js, ./lib/audio/wav.js, ./lib/audio/concat.js and
// ./lib/system/cuda.js (Stage-0 refactor). They are required at the top of
// this file, so all call sites below are unchanged.

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

// A-1 (within-request parallelism): batch_size groups the segments one input is
// split into; with parallel_infer they run together, cutting the wall-clock time
// of ONE multi-sentence request. Default raised 1 -> 4. This is the
// throughput/VRAM knob: on a low-VRAM GPU that OOMs on long inputs, set
// AURIVOX_TTS_BATCH_SIZE=1. Recipes / advanced params still override per call.
const _DEFAULT_TTS_BATCH_SIZE = (() => {
  const n = parseInt(process.env.AURIVOX_TTS_BATCH_SIZE, 10);
  return (Number.isInteger(n) && n >= 1 && n <= 16) ? n : 4;
})();

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
  if (payload.batch_size === undefined) payload.batch_size = _DEFAULT_TTS_BATCH_SIZE;
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
  // Point 4 — same-model coalescing: delegate to the shared ModelSwitcher, which
  // skips the /set_*_weights round-trip when the requested weights are already
  // resident. Behaviour on a first/changed request or on failure is identical
  // to the previous inline implementation (same thrown Error messages). Safe
  // because switchModels is only ever called under withGenerationLock.
  return _modelSwitcher.ensure(cfg);
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
  batch_size: _DEFAULT_TTS_BATCH_SIZE,
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

// 读词典

// 写/更新一条词典项 {lang, word, pinyins:[...]}

// 删除一条词典项（word/lang 支持 query 或 body）

// ===========================
//  VOICE ASSET MANAGER APIs
// ===========================

// POST /api/custom-ref-audio — upload an arbitrary reference clip (cross-platform
// custom picker). Not tied to a voice; stored under voices/custom_refs and usable
// as ref_audio for any voice. Returns an engine-resolvable path + a playback URL.

// POST /api/voices/:id/aux-ref-audio — upload auxiliary reference audio

// DELETE /api/voices/:id/aux-ref-audio/:index — remove an auxiliary reference

// GET /api/audio-files — list available audio files for reference selection

// ===========================
//  ASSET API
// ===========================

// GET /api/assets — list all voice asset directories with meta

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

// POST /api/assets/:id/open — open asset folder in system explorer

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

// GET /api/outputs/batches — group generations into the batches they were
// produced in. One "Generate All" in Compare Refs = one batch, so this answers
// "how many audios did this comparison produce, and which reference did each
// use". Reconstructed live from member meta.json (meta.batch), so it stays
// correct as members are added or deleted — no manifest to keep in sync.
// One-off generations (no meta.batch) are ignored. `?source=` scopes the root.

// POST /api/outputs/reveal — highlight the generation folder (or its primary file).

// DELETE /api/outputs/:id — permanently delete the WHOLE generation folder.
// `?source=` scopes to the right root (default generate).

// POST /api/outputs/clear-all — delete every generation folder under a source
// root (default generate). Body/query `source` scopes it.

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

// GET /api/config — current app config surfaced to the UI (assets directory etc).

// POST /api/config/assets-root { path, migration } — persist a new assets
// directory to app-config.json. `migration` decides what happens to data that
// already lives in the CURRENT assets directory:
//   'switch' — just point at the new dir, leave old data where it is (default)
//   'copy'   — copy existing voices into the new dir, keep the originals
//   'move'   — copy existing voices into the new dir, then delete the originals
// The new root takes effect after a server restart (paths.js resolves once at
// startup); the migration itself is done here so the data is already in place.

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

// GET /api/fs/browse?path=<abs> — server-side directory listing that powers an
// IN-APP folder browser. Spawning a native OS dialog from this (headless, non-
// interactive) server process is unreliable — it opens behind the browser or
// not at all — so instead we list directories over HTTP and let the frontend
// render a reliable, cross-platform, testable picker.
//   - empty/absent path on Windows → returns the drive list (C:\, D:\, …)
//   - otherwise → returns { path, parent, dirs:[{name, path}] }
// Only directories are listed; unreadable entries are skipped.

// POST /api/fs/mkdir { path } — create a directory (recursively) so the in-app
// folder browser can make a new destination on the fly. Returns the resolved
// absolute path; the frontend then navigates into it.

// DELETE /api/assets/:id — delete an asset directory and its voice config

// POST /api/assets/:id/scan — scan a single voice asset

// POST /api/assets/import — import voice from GPT-SoVITS output using slicer_opt.list

// GET /api/assets/:id — get meta.json for a voice

// GET /api/assets/:id/segments — get segments.json for a voice

// GET /api/assets/:id/raw-list — live listing of raw/ audio files (for the
// non-sliced reference-audio column). Reads the directory NOW (not meta.json)
// so deleted files never appear. Each entry is enriched with:
//   - text:     aligned reference transcript from asr_opt/raw_opt.list (by basename)
//   - duration: WAV header duration in seconds (0 when unknown, e.g. mp3 — the
//               client then measures it via the <audio> element for the 3–10s guard)

// POST /api/assets/generate-segments — parse name2text and generate segments.json

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

// POST /api/assets/:id/transcript — persist hand-edited reference TEXT back to the
// asset's .list, resync segments.json, and mark provenance as human-edited. Does
// NOT run ASR or training. body: { kind, rows:[{audio_filename|audio_path, text}], verified? }

// POST /api/assets/:id/transcribe — lightweight IN-PLACE ASR recovery.
// One-click "generate reference text": runs the shared ASR kernel over the asset's
// own raw/ and/or slicer_opt/ audio, writing asr_opt/<kind>.list + regenerating
// segments.json + rescanning meta. It does NOT go through the training pipeline or
// promote — the asset is edited in place. Reference TEXT is advisory (inference
// works without it); this just makes recovery a single button.
//   body.source: 'raw' | 'slices' | 'both' | 'missing'(default, fills absent lists)

// GET /api/assets/:id/transcribe-status — poll the in-place transcribe job.
// requireApiKey for consistency with the rest of the asset API; strip internal
// child/cancel bookkeeping from the response.

// GET /api/transcribe-jobs — list ALL non-idle in-place transcribe jobs so the
// Assets UI can re-hydrate after navigating away and back (the AssetsTab component
// unmounts on page switch, losing its local job state, while these jobs keep running
// server-side). Distinct top-level path on purpose: anything under /api/assets/<x>
// is captured by the GET /api/assets/:id route above. Strip internal bookkeeping.

// DELETE /api/assets/:id/transcribe — cancel a running in-place transcribe job.

// POST /api/assets/:id/rebuild — dependency-driven asset repair.
// Computes the SHORTEST set of stages to fill missing artifacts (reusing what
// exists). By default it only returns the PLAN (execute=false). With
// execute=true it performs the repair: lightweight cases (only segments) run
// inline; cases needing training are handed to the existing training pipeline
// with inputDir pointed at the published asset dir and the computed stepOptions.

// ===========================
//  OPENAI-COMPATIBLE ENDPOINT
// ===========================

// ===========================
//  TRAINING API
// ===========================

const trainingPipeline = require("./lib/training/pipeline");
const _uvr5Models = require("./lib/training/gsv-tools/uvr5/uvr5_models");

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
      // Vocal-extraction pipeline: normalise to a validated [{model,agg?}] array via
      // the shared registry (drops unknown models, clamps agg, coerces the legacy
      // {model:string} shape). Storing the canonical pipeline is what makes the step
      // fingerprint diff correctly, so a changed chain always re-runs.
      safe.steps.denoise = { params: {} };
      const dp = custom.steps.denoise.params;
      const pipeline = _uvr5Models.normalizePipeline(
        Array.isArray(dp.pipeline) ? dp.pipeline : dp
      );
      if (pipeline.length) safe.steps.denoise.params.pipeline = pipeline;
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

// ── P6: 人工校对（ASR 后暂停）───────────────────────────────────────────────
// GET  读取当前可校对的 .list（awaiting_review 时有效，其它状态也可只读预览）

// GET 试听校对片段音频（Range 支持，供校对面板的播放/暂停按钮用）。
// path 为 .list 里的资产内相对路径；解析与目录穿越防护由 task.resolveReviewAudioPath 负责。

// POST 保存用户校对后的文本（写回 .list + segments.json）。可在 awaiting_review 期间反复保存。

// POST 结束校对，放行管线继续（preprocess→train→…）。

// GET /api/train/recoverable — 缓存里所有可恢复(failed + interrupted)的微调任务，
// 含失败步、英文原因、原始参数，供"恢复训练"面板列出并回填。

// POST /api/train/clear-staging — 清除训练暂存目录 (.staging) 中已结束的任务工作区。
// 只删除非运行中的任务：内存里活跃的任务 + task.json 标记为 running/pending 的都会被保护。

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

// GET /api/recipes/:role/:name — fetch one.

// POST /api/recipes — create. Body carries the full recipe payload. Duplicate
// (role,name) is rejected with 409 unless { force:true } (overwrite, keeps
// created_at). The frontend uses 409 to raise the "already exists, overwrite?"
// confirmation.

// PUT /api/recipes/:role/:name — merge-update (Broker model re-bind + edits).

// DELETE /api/recipes/:role/:name — remove one.

// ── Recipe v2→v3 path migration (explicit, assisted; never auto/startup) ──────
// GET preview — READ-ONLY. Classifies every v<3 recipe's managed paths into
// convertible/external/missing/ambiguous. Writes nothing.

// POST apply — backs up then rewrites ONE recipe to v3. Refuses when any field is
// ambiguous/missing unless the body supplies explicit `resolutions`
// (field → { base, path }). Ambiguous/missing are NEVER auto-selected.

// POST revert — restore a recipe from its most recent (or named) backup.

// GET /api/assets/voices-with-models — the first-level picker for the Broker
// re-bind (PC). Lists every voice that owns at least one GPT ckpt or SoVITS pth,
// with per-type flags so the GPT box only offers voices that have GPT models and
// the SoVITS box only those with SoVITS models (PC-1).

// GET /api/recipes-models/:role — list a voice's available GPT/SoVITS
// checkpoints (from meta.json) for the Broker page "project query" model
// re-bind path. Returns project-relative paths so recipes stay portable.

// ===========================
//  SERVE REACT FRONTEND
// ===========================

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


// ===========================
//  ROUTE MOUNTING (Stage-1 refactor)
// ===========================
// All API routes now live in lib/routes/<domain>.js as express.Router
// factories. They receive shared server-scope symbols via `ctx` and are
// mounted here (paths unchanged). The static frontend + SPA catch-all are
// registered LAST so specific API routes always win.
const ctx = { ADVANCED_PARAMS_FILE, ALLOWED_EXT, ALLOWED_LANGUAGES, API_KEY, APP_DIR, ASSETS_DIR, ASSETS_ROOT, ASSETS_ROOT_SOURCE, AUDIO_FORMATS, BACKUP_DIR, BASE_VOICE_DISPLAY, BASE_VOICE_ID, BROKER_DIR, COMPARE_DIR, CONFIG_FILE, CUSTOM_REF_DIR, DEFAULT_ADVANCED_PARAMS, GENERATE_DIR, GPT_SOVITS_BASE_URL, GSV_PRETRAINED_DIR, HOST, MAX_BACKUPS, OUTPUT_DIR, OUTPUT_ROOTS, PORT, PRON_LEXICON_DIR, RECIPES_DIR, RENAME_LOCK_CODES, REQUIRE_KEY_FOR_DESTRUCTIVE, TRAIN_DATA_ROOT, TRANSCRIPT_KINDS, TTS_PASS_THROUGH_KEYS, VOICES_DIR, VOICES_JSON, WEB_DIST, _BASE_SOVITS_DEFS, _MV_BASE_REQ, _MV_HARD, _backupVoicesUnlocked, _baseS1Path, _mvFirstExisting, assetId, assetScanner, assetsNeedScan, backupVoices, baseCheckpoints, baseVoiceMeta, baseVoiceReg, buildTtsPayload, checkBaseModelsForVersion, checkFfmpeg, classifyRecipeManagedFields, clientError, collectTakenVoiceIds, computeSegmentBounds, concatWavFiles, concatWavPureNode, concatWithFfmpeg, cors, createMigrator, createRecipeStore, crypto, customRefStorage, customRefUpload, detectCuda, execFileSync, execSync, ffmpegCmd, findWavDataChunk, firstMismatch, forceSplitLong, fs, fsp, genAssetDir, genBaseName, genItemFromMeta, generateOneSegment, generateSilenceWav, getCleanEnv, getPythonPath, gsvGet, gsvPost, gsvRequest, gsvStream, http, importCustomRefToAsset, isBaseVoice, isLoopback, isPlaceholder, knownVoice, loadAdvancedParams, loadPronLexicon, loadTrainingConfig, loadVoices, localError, migrationJobs, multer, newGenId, normModelVersion, normSource, noteEngineHealth, normalizeModelPath, normalizeVersion, os, outputRoot, path, pathResolver, pickBestCkpt, pickLatestByEpoch, pronLexiconPath, readConfig, readTranscriptListRows, recipeMigrator, recipeStore, renameDirWithRetry, renameVoiceFolder, requireApiKey, resolveGenDir, resolveRefPath, resolveSeed, runAsr, runFullAssetScan, runMigrationJob, safeId, sanitizeCustomParams, saveAdvancedParams, savePronLexicon, saveVoices, scanStagingTasks, sleepSyncMs, spawn, splitJapaneseText, startCudaProbe, storage, switchModels, toPcm16Wav, toProjectRelative, trainingPipeline, transcodeAudio, transcribeJobs, upload, validateHost, vendoredFfmpegPath, versionFromName, wavDurationSec, withGenerationLock, withVoicesLock, writeConfig, writeGenMeta, shutdownState };
app.use(require("./lib/routes/system")(ctx));
app.use(require("./lib/routes/pron")(ctx));
app.use(require("./lib/routes/voices")(ctx));
app.use(require("./lib/routes/synthesis")(ctx));
app.use(require("./lib/routes/outputs")(ctx));
app.use(require("./lib/routes/assets")(ctx));
app.use(require("./lib/routes/config")(ctx));
app.use(require("./lib/routes/training")(ctx));
app.use(require("./lib/routes/uvr5")(ctx));
app.use(require("./lib/routes/recipes")(ctx));

// ---- Aurivox Flow (FLOW-CORE-004 live wiring) ----
// Opt-in ONLY. With FLOW_ENABLED unset the Flow kernel is never constructed and
// never mounted, so the default server behaviour is unchanged from before the
// wiring existed. The Flow routes are additive (/api/flow/*) and touch none of
// the Workbench paths above.
if (String(process.env.FLOW_ENABLED || "").trim() && process.env.FLOW_ENABLED !== "0") {
  try {
    const { createFlowRuntime } = require("./lib/workflow/runtime");
    const { generateService } = require("./lib/services/synthesisService")(ctx);
    ctx.flowRuntime = createFlowRuntime(ctx, { generateService });
    app.use(require("./lib/routes/flow")(ctx));
    console.log(`[flow] Aurivox Flow enabled — journal dir: ${ctx.flowRuntime.journalDir}`);
  } catch (err) {
    // Fail loudly but do not take the Workbench down with it: Flow is opt-in
    // and experimental, the legacy surface must keep serving.
    console.error(`[flow] FAILED to enable Aurivox Flow: ${err && err.message}`);
  }
}

// ---- Serve React frontend (must stay after API routers) ----
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

// ── Global JSON error handler (1.0.7) ───────────────────────────
// Any error handed to next(err) — most importantly multer upload failures (file
// too large / unsupported type) and body-parser JSON syntax errors — would
// otherwise reach Express's default handler and return an HTML stack page.
// Normalise them to a JSON body so API / OpenAI clients always get a
// machine-readable error. MUST stay LAST, after all routes.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const MULTER_STATUS = { LIMIT_FILE_SIZE: 413, LIMIT_UNEXPECTED_FILE: 400,
    LIMIT_PART_COUNT: 400, LIMIT_FILE_COUNT: 400, LIMIT_FIELD_KEY: 400,
    LIMIT_FIELD_VALUE: 400, LIMIT_FIELD_COUNT: 400 };
  let status = (err && Number.isInteger(err.status)) ? err.status : 500;
  if (err && err.name === "MulterError") status = MULTER_STATUS[err.code] || 400;
  else if (err && err.type === "entity.too.large") status = 413;
  else if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) status = 400;
  else if (err && /Unsupported file type/i.test(err.message || "")) status = 400;
  const msg = status >= 500
    ? clientError(err, "Internal server error")
    : ((err && err.message) ? err.message : "Bad request");
  res.status(status).json({ error: msg });
});

// ---- Start ----
const server = app.listen(PORT, HOST, () => {
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

// ── Graceful shutdown (1.0.7) ────────────────────────────────────
// Default: stop taking new requests, let in-flight synthesis finish, then exit.
// interrupted:true requests are aborted at once; a 2nd signal / grace timeout
// forces exit.
function shutdown(signal) {
  if (_shuttingDown) {
    console.warn(`[shutdown] second ${signal} — forcing exit now.`);
    return process.exit(1);
  }
  _shuttingDown = true;
  const graceMs = Math.max(0, parseInt(process.env.AURIVOX_SHUTDOWN_GRACE_MS, 10) || 120000);
  console.log(`[shutdown] ${signal} received — refusing new requests; ` +
    `${_inflight.size} in-flight (grace ${graceMs}ms).`);
  try { server.close(() => console.log("[shutdown] HTTP server closed to new connections.")); } catch (_) {}
  // Abort only the requests that explicitly opted in via interrupted:true.
  for (const entry of _inflight) {
    if (entry && entry.interruptible && typeof entry.abort === "function") {
      try { entry.abort(); } catch (_) {}
    }
  }
  const started = Date.now();
  const timer = setInterval(() => {
    if (_inflight.size === 0) {
      clearInterval(timer);
      console.log("[shutdown] all in-flight work finished — exiting cleanly.");
      process.exit(0);
    } else if (Date.now() - started > graceMs) {
      clearInterval(timer);
      console.warn(`[shutdown] grace elapsed with ${_inflight.size} still running — forcing exit.`);
      process.exit(0);
    }
  }, 250);
  if (typeof timer.unref === "function") timer.unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
