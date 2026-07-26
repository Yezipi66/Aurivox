// ===========================
//  ROUTES: System (health, model status)
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { checkBaseModelsForVersion, checkFfmpeg, detectCuda, http, normModelVersion } = ctx;

router.get("/api/health", async (req, res) => {
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
