// 后端入口：拼装 express 应用、装中间件与各路由模块，并托管前台静态文件。
// 业务实现在 lib/server/ 与 lib/routes/ 下，这个文件只做依赖注入与装配；
// 路由上下文 ctx 集中了所有共享依赖，新增路由只往 ctx 加字段。
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const http = require("http");
const { execSync, spawn, execFileSync } = require("child_process");
const os = require("os");

const PATHS = require('./lib/paths');
const {
  ASSETS_ROOT, ASSETS_ROOT_SOURCE, CONFIG_FILE, readConfig, writeConfig,
  APP_DIR, DATA_DIR,
  VOICES_JSON, VOICES_DIR, CUSTOM_REF_DIR, CUSTOM_REFS_DIRNAME,
  BACKUP_DIR, RECIPES_DIR, PRON_LEXICON_DIR, FLOWGRAPH_DIR,
  ADVANCED_PARAMS_FILE,
  OUTPUT_DIR, GENERATE_DIR, COMPARE_DIR, BROKER_DIR, OUTPUT_ROOTS,
  WEB_DIST, GSV_PRETRAINED_DIR,
} = PATHS;
const { getPythonPath, getCleanEnv } = require('./lib/training/python_helper');

// ── File logging (1.0.7) ──────────────────────────────────────────
const { setupFileLogging } = require("./lib/server/fileLogging");
setupFileLogging(console, process);

const app = express();
const PORT = parseInt(process.env.BROKER_PORT || process.env.PORT || "9886", 10);
const HOST = process.env.BROKER_HOST || process.env.HOST || "127.0.0.1";
const GPT_SOVITS_BASE_URL = process.env.GPT_SOVITS_BASE_URL || "http://127.0.0.1:9880";

const {
  API_KEY, REQUIRE_KEY_FOR_DESTRUCTIVE,
  isLoopback, validateHost, requireApiKey, clientError, localError,
  safeStaticRoot, corsOptions,
} = require("./lib/server/middleware");
const { splitJapaneseText, forceSplitLong, isPlaceholder } = require("./lib/server/text");
const {
  resolveRefPath, toProjectRelative, normalizeModelPath,
  importCustomRefToAsset, safeId,
} = require("./lib/server/paths");
const { classifyRecipeManagedFields } = require("./lib/server/recipeFields");
const { createSynthesisModule } = require("./lib/server/synthesis");
const { newGenId, genBaseName } = require("./lib/genUtils");
const {
  pickBestCkpt, firstMismatch, RENAME_LOCK_CODES, sleepSyncMs,
  renameDirWithRetry, renameVoiceFolder, scanStagingTasks,
} = require("./lib/server/fileOps");
const {
  BASE_VOICE_ID, BASE_VOICE_DISPLAY, isBaseVoice, normModelVersion,
  checkBaseModelsForVersion, baseCheckpoints, baseModelsAll,
  baseVoiceMeta, baseVoiceReg, collectTakenVoiceIds, normSource,
  outputRoot, genAssetDir, writeGenMeta, resolveGenDir,
  genItemFromMeta, assetsNeedScan,
} = require("./lib/server/assets");

const ASSETS_DIR = ASSETS_ROOT;
PATHS.ensureRuntimeDirs();

const { createRecipeStore } = require("./lib/recipeStore");
const recipeStore = createRecipeStore(RECIPES_DIR);
const assetScanner = require("./lib/assetScanner");
const assetId = require("./lib/assetId");
const pathResolver = require("./lib/pathResolver");
const { createMigrator } = require("./lib/recipeMigration");
const recipeMigrator = createMigrator({ recipesDir: RECIPES_DIR, appDir: APP_DIR, assetsRoot: ASSETS_ROOT });
const { runAsr } = require("./lib/training/steps/asr");
const { loadTrainingConfig } = require("./lib/training/config");
const { gsvRequest, gsvPost, gsvGet, gsvStream } = require("./lib/gsv/client");
const {
  generateSilenceWav, findWavDataChunk, toPcm16Wav,
  wavDurationSec, computeSegmentBounds, concatWavPureNode,
} = require("./lib/audio/wav");
const {
  vendoredFfmpegPath, ffmpegCmd, checkFfmpeg, AUDIO_FORMATS, transcodeAudio,
} = require("./lib/audio/ffmpeg");
const { concatWavFiles, concatWithFfmpeg } = require("./lib/audio/concat");
const { startCudaProbe, detectCuda } = require("./lib/system/gpu");
const { HttpError } = require("./lib/http/http");
const { VoicesStore } = require("./lib/voices/store");
const { resolveEngineProfile } = require("./lib/engines/profile");
const { storedGeneration } = require("./lib/engines/weightSummary");
const { engineParamDefaults } = require("./lib/engines/paramTable");
const { createAdvancedParamsStore } = require("./lib/advancedParams");
const { acceptsKey } = require("./lib/engines/payload");
const transcribeJobs = new Map();

// ── Graceful-shutdown coordinator (1.0.7) ─────────────────────────
const _inflight = new Set();
let _shuttingDown = false;
const { createShutdownManager } = require("./lib/server/shutdown");

// ---- Multer ----
const { ALLOWED_EXT, createUpload, createCustomRefUpload } = require("./lib/server/multer");
const upload = createUpload(VOICES_DIR);
const customRefUpload = createCustomRefUpload(CUSTOM_REF_DIR);
try { fs.mkdirSync(CUSTOM_REF_DIR, { recursive: true }); } catch (_) {}

const crypto = require("crypto");
const migrationJobs = new Map();

app.use(cors(corsOptions()));
app.use(express.json({ limit: "10mb" }));
app.use(validateHost);

// ---- Static + Frontend + Error handling ----
const { setupStatic, setupFrontend, setupErrorHandling, setupOptionalRoutes, startServer } = require("./lib/server/startup");
setupStatic(app, { ASSETS_DIR, OUTPUT_DIR, VOICES_DIR, WEB_DIST, safeStaticRoot });

//  HELPERS

const MAX_BACKUPS = 20;
const voicesStore = new VoicesStore({ voicesJson: VOICES_JSON, backupDir: BACKUP_DIR, maxBackups: MAX_BACKUPS });
// ---- Engine supervisor ----
// 排在合成模块之前：走 stdio 的引擎，合成时要向它要管道（lib/engines/engineChannel.js）。
const { createEngineSupervisor } = require("./lib/server/engineSupervisor");
const _engineSupervisor = createEngineSupervisor(__dirname, process, { resolveEngineProfile, console });

const { createSynthesisInstance } = require("./lib/server/synthesisInstance");
const { _GEN_MAX_QUEUE, _GEN_RETRY_AFTER, _generationMutex, _weightSwitch, segmentCache, synthesis } = createSynthesisInstance(process, PATHS, { engineSupervisor: _engineSupervisor });

// 进程被 supervisor 关掉（空闲清扫、腾地方、换 launch 模型、加载失败）后，里面装过的权重随进程一起没了。
_engineSupervisor.onStopped = (id) => _weightSwitch.forgetEngine(id);

function noteEngineHealth(online) { return _weightSwitch.noteEngineHealth(online); }

process.on("exit", () => {
  try { _engineSupervisor.stopAll("后端退出", true); } catch { /* 退出路径上不许再抛 */ }
});

function loadVoices() { return voicesStore.load(); }
function saveVoices(data) { return voicesStore.save(data); }
function withVoicesLock(fn) { return voicesStore.withLock(fn); }
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

//  TTS PAYLOAD BUILDER / GENERATION CORE
const {
  resolveSeed, resolveReference, buildTtsPayload, switchModels, generateOneSegment,
} = synthesis;

if (segmentCache.enabled) {
  const from = process.env.CACHE_DIR ? "（跟随环境变量 CACHE_DIR）" : "";
  console.log(`[CACHE] 分段复用已开启：目录 ${segmentCache.dir}${from}`);
} else {
  console.log("[CACHE] 分段复用已关闭（AURIVOX_CACHE=0）");
}

//  ADVANCED PARAMS (advanced_params.json)
const { ENGINE_LAUNCH_DEFAULTS } = require("./lib/server/engineLaunch");
const advancedParamsStore = createAdvancedParamsStore({
  file: ADVANCED_PARAMS_FILE,
  engineDefaults: (engineId) => (engineId ? engineParamDefaults(engineId) : {}),
  launchDefaults: ENGINE_LAUNCH_DEFAULTS,
});
function defaultAdvancedParams(engineId) { return advancedParamsStore.defaults(engineId); }
function loadAdvancedParams(engineId) { return advancedParamsStore.load(engineId); }
function saveAdvancedParams(params) { return advancedParamsStore.save(params); }

// 读音校对 / Pronunciation proofing (task6)
const { pronLexiconPath, loadPronLexicon, savePronLexicon } = require("./lib/server/pronLexicon");

//  VOICE ASSET MANAGER APIs
const { runFullAssetScan: _runFullAssetScan } = require("./lib/server/assetScan");
// 路由与启动扫描都是无参调用：依赖在这里接好，别让调用方各自去凑四个参数。
function runFullAssetScan() { return _runFullAssetScan(assetScanner, withVoicesLock, loadVoices, saveVoices); }
const { runMigrationJob } = require("./lib/server/migration");
const TRANSCRIPT_KINDS = [
  { kind: "slicer_opt", listName: "slicer_opt.list", audioSub: "slicer_opt" },
  { kind: "raw", listName: "raw_opt.list", audioSub: "raw" },
];
const { readTranscriptListRows } = require("./lib/server/transcriptRows");

//  OPENAI-COMPATIBLE ENDPOINT

//  TRAINING API
const trainingPipeline = require("./lib/training/pipeline");
const _uvr5Models = require("./pipeline/uvr5/uvr5_models");
const ALLOWED_LANGUAGES = new Set(["zh", "yue", "ja", "en", "ko", "auto"]);
const { sanitizeCustomParams } = require("./lib/server/trainingParams");
const TRAIN_DATA_ROOT = process.env.TRAIN_DATA_ROOT || "";

try {
  const { registerBaseModelSource } = require("./lib/assets/baseModels");
  registerBaseModelSource("gpt-sovits", () => {
    const ck = baseCheckpoints();
    return { gpt: ck.gpt, sovits: ck.sovits };
  });
} catch (e) {
  console.warn(`[assets] 无法登记 GPT-SoVITS 底模找法: ${e && e.message}`);
}

const { versionFromName, normalizeVersion, pickLatestByEpoch } = require("./lib/server/trainingVersion");

//  RECIPES API (P0 keystone)
const { createKnownVoice } = require("./lib/server/recipeVoice");
const knownVoice = createKnownVoice(isBaseVoice, loadVoices);

// ── Graceful shutdown (1.0.7) ────────────────────────────────────
const { shutdown, shutdownState } = createShutdownManager(null, { _inflight, _shuttingDown, console });

//  ROUTE MOUNTING
const ctx = { ADVANCED_PARAMS_FILE, ALLOWED_EXT, ALLOWED_LANGUAGES, API_KEY, APP_DIR, ASSETS_DIR, ASSETS_ROOT, ASSETS_ROOT_SOURCE, AUDIO_FORMATS, BACKUP_DIR, BASE_VOICE_DISPLAY, BASE_VOICE_ID, BROKER_DIR, COMPARE_DIR, CONFIG_FILE, CUSTOM_REF_DIR, defaultAdvancedParams, GENERATE_DIR, GPT_SOVITS_BASE_URL, GSV_PRETRAINED_DIR, HOST, MAX_BACKUPS, OUTPUT_DIR, OUTPUT_ROOTS, PORT, PRON_LEXICON_DIR, RECIPES_DIR, RENAME_LOCK_CODES, REQUIRE_KEY_FOR_DESTRUCTIVE, TRAIN_DATA_ROOT, TRANSCRIPT_KINDS, VOICES_DIR, VOICES_JSON, WEB_DIST, _backupVoicesUnlocked, assetId, assetScanner, assetsNeedScan, backupVoices, baseCheckpoints, baseVoiceMeta, baseVoiceReg, buildTtsPayload, resolveReference, checkBaseModelsForVersion, checkFfmpeg, classifyRecipeManagedFields, clientError, collectTakenVoiceIds, computeSegmentBounds, concatWavFiles, concatWavPureNode, concatWithFfmpeg, cors, createMigrator, createRecipeStore, crypto, customRefUpload, detectCuda, engineSupervisor: _engineSupervisor, execFileSync, execSync, ffmpegCmd, findWavDataChunk, firstMismatch, forceSplitLong, fs, fsp, genAssetDir, genBaseName, genItemFromMeta, generateOneSegment, generateSilenceWav, getCleanEnv, getPythonPath, gsvGet, gsvPost, gsvRequest, gsvStream, http, importCustomRefToAsset, isBaseVoice, isLoopback, isPlaceholder, knownVoice, loadAdvancedParams, loadPronLexicon, loadTrainingConfig, loadVoices, localError, migrationJobs, newGenId, normModelVersion, normSource, noteEngineHealth, normalizeModelPath, normalizeVersion, os, outputRoot, path, pathResolver, pickBestCkpt, pickLatestByEpoch, pronLexiconPath, readConfig, readTranscriptListRows, recipeMigrator, recipeStore, renameDirWithRetry, renameVoiceFolder, requireApiKey, resolveGenDir, resolveRefPath, resolveSeed, runAsr, runFullAssetScan, runMigrationJob, safeId, sanitizeCustomParams, saveAdvancedParams, savePronLexicon, saveVoices, scanStagingTasks, sleepSyncMs, spawn, splitJapaneseText, startCudaProbe, switchModels, toPcm16Wav, transcribeJobs, upload, validateHost, vendoredFfmpegPath, voicesStore, wavDurationSec, withGenerationLock, withVoicesLock, writeConfig, writeGenMeta, trainingPipeline, shutdownState };
app.use(require("./lib/routes/system")(ctx));
app.use(require("./lib/routes/engines")(ctx));
app.use(require("./lib/routes/pron")(ctx));
app.use(require("./lib/routes/voices")(ctx));
app.use(require("./lib/routes/synthesis")(ctx));
app.use(require("./lib/routes/outputs")(ctx));
app.use(require("./lib/routes/assets")(ctx));
app.use(require("./lib/routes/config")(ctx));
app.use(require("./lib/routes/training")(ctx));
app.use(require("./lib/routes/uvr5")(ctx));
app.use(require("./lib/routes/recipes")(ctx));

// ---- Aurivox Flow routes (mounted only when FLOW_ENABLED / FLOWGRAPH_ENABLED is set) ----
setupOptionalRoutes(app, ctx, { FLOWGRAPH_ENABLED: process.env.FLOWGRAPH_ENABLED, FLOW_ENABLED: process.env.FLOW_ENABLED, FLOWGRAPH_DIR, console });

// ---- Serve React frontend (must stay after API routers) ----
setupFrontend(app, { WEB_DIST, path, fs });

// ---- Global JSON error handler (1.0.7) ───────────────────────────
setupErrorHandling(app, { clientError, localError });

// ---- Start ----
if (require.main === module) {
  server = startServer(app, {
    PORT, HOST, API_KEY, checkFfmpeg, startCudaProbe, scanStagingTasks,
    assetsNeedScan, runFullAssetScan, console, PATHS,
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason);
  shutdown("unhandledRejection");
});