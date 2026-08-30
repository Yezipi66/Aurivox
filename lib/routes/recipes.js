// ===========================
//  ROUTES: Recipes + recipe migration
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");
// ⭐ meta.assets.models 这层结构只许在一个地方拆包（lib/assets/modelLayout.js）。
const { enginesInMeta } = require("../assets/modelLayout");

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

// 「这个角色有哪些模型」——给配方编辑器用。
//
// ⭐⭐ 2026-08-30：返回体原本写死两个键（gpt / sovits）⇒ 第二台引擎的模型
//    连一个能装它的字段都没有。现在**按引擎分组原样端出来**：
//        models: { <引擎id>: { <权重位>: [ {name, path, ...}, ... ] } }
//    这条链路上平台不认识任何引擎名，目录里有什么就报什么。
router.get("/api/recipes-models/:role", requireApiKey, (req, res) => {
  const role = req.params.role;
  if (!knownVoice(role)) return res.status(404).json({ error: `unknown voice: ${role}` });
  const metaPath = path.join(ASSETS_DIR, role, "meta.json");
  // 配方里存的是**项目相对路径**（assets/<角色>/…），不是绝对路径 ——
  // 配方要能跟着项目目录一起搬走。
  const toRel = (p) => {
    if (!p) return "";
    const norm = String(p).replace(/\\/g, "/");
    const marker = `/assets/${role}/`;
    const i = norm.indexOf(marker);
    return i >= 0 ? norm.slice(i + 1) : norm; // strip up to "assets/<role>/..."
  };
  let models = {};
  let engines = [];
  try {
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const all = (meta && meta.assets && meta.assets.models) || {};
      for (const [engineId, slots] of Object.entries(all)) {
        const outSlots = {};
        for (const [slotName, list] of Object.entries(slots || {})) {
          outSlots[slotName] = (Array.isArray(list) ? list : []).map(x => ({
            ...x, path: toRel(x.path),
          }));
        }
        models[engineId] = outSlots;
      }
      engines = enginesInMeta(meta);
    }
  } catch (err) {
    return res.status(500).json({ error: clientError(err, "failed to read models") });
  }
  res.json({ role, engines, models });
});

  return router;
};
