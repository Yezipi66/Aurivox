// ===========================
//  ROUTES: System (health, model status)
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { GPT_SOVITS_BASE_URL, checkBaseModelsForVersion, checkFfmpeg, detectCuda, http, normModelVersion, noteEngineHealth } = ctx;
  // The engine base URL is resolved once from the same env var / default the
  // rest of the backend uses (GPT_SOVITS_BASE_URL). Health MUST NOT hard-code
  // 127.0.0.1:9880 — when start.ps1 shifts the engine port off a busy 9880 it
  // exports GPT_SOVITS_BASE_URL, and a hard-coded probe would then永远误报
  // engine_online:false. Fall back to the historical default only if unset.
  const ENGINE_URL = (GPT_SOVITS_BASE_URL || "http://127.0.0.1:9880").replace(/\/+$/, "");

  // App version surfaced in /api/health (1.0.7) — read from package.json so it
  // tracks releases without a hard-coded string.
  let APP_VERSION = "0.0.0";
  try { APP_VERSION = require("../../package.json").version || APP_VERSION; } catch (_) {}

router.get("/api/health", async (req, res) => {
  let engine_online = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`${ENGINE_URL}/`, { signal: ctrl.signal });
    clearTimeout(t);
    engine_online = r.ok;
  } catch { engine_online = false; }
  // Feed liveness to the model-switch cache: an offline->online flip means the
  // engine restarted and lost its resident weights, so the cache is invalidated
  // (guarded so unit harnesses without this hook don't break).
  if (typeof noteEngineHealth === "function") noteEngineHealth(engine_online);
  res.json({
    ok: true,
    version: APP_VERSION,
    engine_online,
    gpt_sovits_url: ENGINE_URL,
    ffmpeg_available: checkFfmpeg(),
    cuda: detectCuda(),
  });
});

router.get("/api/models/status", (req, res) => {
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

  return router;
};
