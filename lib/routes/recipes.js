// ===========================
//  ROUTES: Recipes + recipe migration
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { APP_DIR, ASSETS_DIR, ASSETS_ROOT, classifyRecipeManagedFields, clientError, fs, knownVoice, path, recipeMigrator, recipeStore, requireApiKey } = ctx;

router.get("/api/recipes", requireApiKey, (req, res) => {
  try {
    const role = req.query.role ? String(req.query.role) : null;
    res.json({ recipes: recipeStore.list(role ? { role } : undefined) });
  } catch (err) {
    res.status(500).json({ error: clientError(err, "failed to list recipes") });
  }
});

router.get("/api/recipes/:role/:name", requireApiKey, (req, res) => {
  const rec = recipeStore.get(req.params.role, req.params.name);
  if (!rec) return res.status(404).json({ error: "recipe not found" });
  res.json({ recipe: rec });
});

router.post("/api/recipes", requireApiKey, (req, res) => {
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

router.put("/api/recipes/:role/:name", requireApiKey, (req, res) => {
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

router.delete("/api/recipes/:role/:name", requireApiKey, (req, res) => {
  const ok = recipeStore.remove(req.params.role, req.params.name);
  if (!ok) return res.status(404).json({ error: "recipe not found" });
  res.json({ ok: true });
});

router.get("/api/recipes/migration/preview", requireApiKey, (req, res) => {
  try {
    res.json({ assets_root: ASSETS_ROOT, app_dir: APP_DIR, recipes: recipeMigrator.preview() });
  } catch (err) {
    res.status(500).json({ error: clientError(err, "migration preview failed") });
  }
});

router.post("/api/recipes/migration/apply", requireApiKey, (req, res) => {
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

router.post("/api/recipes/migration/revert", requireApiKey, (req, res) => {
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

router.get("/api/recipes-models/:role", requireApiKey, (req, res) => {
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

  return router;
};
