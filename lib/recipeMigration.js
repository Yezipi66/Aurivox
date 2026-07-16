// Recipe v2→v3 assisted migration (explicit; never runs at startup/scan).
//
// A v2 recipe stores managed paths as bare strings resolved against APP_DIR. v3
// stores them as structured { base, path } objects resolved against ASSETS_ROOT
// (asset) or as an explicit external absolute path. Because a bare relative
// string can plausibly resolve two different ways, migration is a REVIEWED
// operation: preview classifies every path, the user approves, apply backs up
// then rewrites, and revert restores the backup.
//
// Classification buckets (per the approved spec):
//   convertible → resolves to a real file under ASSETS_ROOT (asset-relative)
//   external    → resolves to a real file OUTSIDE ASSETS_ROOT (non-portable)
//   missing     → no file found at any plausible interpretation
//   ambiguous   → MULTIPLE plausible interpretations point at different real
//                 files; never auto-selected, requires explicit user resolution.
//
// Conservatism: any case with >1 plausible source/target match is `ambiguous`.

const fs = require("fs");
const path = require("path");

function normSep(s) { return String(s == null ? "" : s).replace(/\\/g, "/"); }

function isAbsolutePath(raw) {
  const s = normSep(raw);
  return s.startsWith("/") || /^[a-zA-Z]:\//.test(s);
}

// Return ASSETS_ROOT-relative path (forward-slash) if `abs` is inside root, else null.
function relUnderRoot(abs, root) {
  const rel = path.relative(root, abs);
  const r = normSep(rel);
  if (r === "" || r === ".." || r.startsWith("../") || path.isAbsolute(rel)) return null;
  return r;
}

// Managed path fields on a recipe. `reference_audio`/`gpt_ckpt`/`sovits_pth` are
// top-level; `aux_ref_audio_paths` is an array under params.
const TOP_FIELDS = ["reference_audio", "gpt_ckpt", "sovits_pth"];

// Classify a single legacy string value into a bucket + a proposed v3 object.
function classifyValue(value, { appDir, assetsRoot }) {
  // Already a v3 object → nothing to do.
  if (value && typeof value === "object") {
    return { status: "already_v3", proposed: value, note: "already structured" };
  }
  const s = normSep(value || "");
  if (!s) return { status: "empty", proposed: "" };

  if (isAbsolutePath(s)) {
    const abs = path.resolve(s);
    const rel = relUnderRoot(abs, assetsRoot);
    const exists = safeExists(abs);
    if (rel != null) {
      return {
        status: exists ? "convertible" : "missing",
        proposed: { base: "asset", path: rel },
        resolved: abs,
      };
    }
    return {
      status: exists ? "external" : "missing",
      proposed: { base: "external", path: s },
      resolved: abs,
    };
  }

  // Relative — two plausible interpretations:
  //   (a) APP_DIR-relative  (legacy v2 semantics)
  //   (b) ASSETS_ROOT-relative (after stripping a leading "assets/")
  const absApp = path.resolve(appDir, s);
  const stripped = s.replace(/^\/+/, "").replace(/^assets\//, "");
  const absAsset = path.resolve(assetsRoot, stripped);
  const appExists = safeExists(absApp);
  const assetExists = safeExists(absAsset);
  const appUnderAssets = relUnderRoot(absApp, assetsRoot);

  // AMBIGUOUS: both interpretations resolve to DIFFERENT real files.
  if (appExists && assetExists && normSep(absApp) !== normSep(absAsset)) {
    return {
      status: "ambiguous",
      candidates: [
        { interpretation: "app_dir", resolved: normSep(absApp), under_assets: appUnderAssets != null },
        { interpretation: "assets_root", resolved: normSep(absAsset), rel: relUnderRoot(absAsset, assetsRoot) },
      ],
      note: "both APP_DIR and ASSETS_ROOT interpretations match different files",
    };
  }

  // Legacy APP_DIR resolution already lands inside ASSETS_ROOT → clean convert.
  if (appUnderAssets != null) {
    return {
      status: appExists ? "convertible" : "missing",
      proposed: { base: "asset", path: appUnderAssets },
      resolved: normSep(absApp),
    };
  }

  // APP_DIR resolution is outside ASSETS_ROOT.
  if (appExists) {
    return {
      status: "external",
      proposed: { base: "external", path: normSep(absApp) },
      resolved: normSep(absApp),
      note: "resolves outside ASSETS_ROOT",
    };
  }
  if (assetExists) {
    return {
      status: "convertible",
      proposed: { base: "asset", path: relUnderRoot(absAsset, assetsRoot) },
      resolved: normSep(absAsset),
    };
  }
  // Nothing found anywhere.
  return {
    status: "missing",
    proposed: { base: "asset", path: stripped },
    resolved: normSep(absAsset),
    note: "no file found at either interpretation",
  };
}

function safeExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

// Build a preview for one recipe file (read-only).
function classifyRecipe(recipe, ctx) {
  const fields = [];
  for (const f of TOP_FIELDS) {
    if (recipe[f] == null || recipe[f] === "") continue;
    fields.push(Object.assign({ field: f, original: recipe[f] }, classifyValue(recipe[f], ctx)));
  }
  const aux = recipe.params && Array.isArray(recipe.params.aux_ref_audio_paths)
    ? recipe.params.aux_ref_audio_paths : [];
  aux.forEach((v, i) => {
    if (v == null || v === "") return;
    fields.push(Object.assign({ field: `aux_ref_audio_paths[${i}]`, index: i, original: v }, classifyValue(v, ctx)));
  });
  const statuses = fields.map((f) => f.status);
  const blocked = statuses.some((s) => s === "ambiguous" || s === "missing");
  return {
    id: recipe.id,
    role: recipe.role,
    name: recipe.name,
    schema_version: recipe.schema_version || 1,
    fields,
    // A recipe is safely applicable only when NOTHING is ambiguous/missing.
    applicable: !blocked && (recipe.schema_version || 1) < 3,
    blocked,
  };
}

function createMigrator({ recipesDir, appDir, assetsRoot }) {
  if (!recipesDir) throw new Error("recipesDir is required");
  const backupDir = path.join(recipesDir, ".backup");
  const ctx = { appDir, assetsRoot };

  function listRecipeFiles() {
    let files = [];
    try { files = fs.readdirSync(recipesDir); } catch (_) { return []; }
    return files.filter((f) => f.startsWith("recipe_") && f.endsWith(".json"));
  }

  function readRecipe(file) {
    return JSON.parse(fs.readFileSync(path.join(recipesDir, file), "utf-8"));
  }

  // READ-ONLY: classify every v<3 recipe. Never writes.
  function preview() {
    const out = [];
    for (const f of listRecipeFiles()) {
      let rec;
      try { rec = readRecipe(f); } catch (_) { continue; }
      if ((rec.schema_version || 1) >= 3) continue;
      out.push(Object.assign({ file: f }, classifyRecipe(rec, ctx)));
    }
    return out;
  }

  // APPLY: for a single recipe file, back up then rewrite convertible/external
  // proposals and bump schema_version to 3. Refuses if any field is
  // ambiguous/missing unless an explicit per-field `resolutions` override is
  // supplied. Returns { ok, backup } or { ok:false, error }.
  function apply(file, opts = {}) {
    const resolutions = opts.resolutions || {}; // field -> { base, path }
    let rec;
    try { rec = readRecipe(file); } catch (e) { return { ok: false, error: `unreadable: ${e.message}` }; }
    if ((rec.schema_version || 1) >= 3) return { ok: false, error: "already v3" };

    const cls = classifyRecipe(rec, ctx);
    // Compose the final value for each field: explicit resolution wins; else the
    // auto proposal, but ONLY if it is a safe (non-blocked) status.
    for (const fld of cls.fields) {
      const override = resolutions[fld.field];
      if (override) {
        if (!override.base || !override.path) return { ok: false, error: `bad resolution for ${fld.field}` };
        continue;
      }
      if (fld.status === "ambiguous" || fld.status === "missing") {
        return { ok: false, error: `field ${fld.field} is ${fld.status}; explicit resolution required`, field: fld.field, status: fld.status };
      }
    }

    // Backup first.
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `${file}.${ts}.json`;
    fs.copyFileSync(path.join(recipesDir, file), path.join(backupDir, backupName));

    // Rewrite fields.
    const applyField = (fieldKey) => {
      const override = resolutions[fieldKey];
      const fld = cls.fields.find((x) => x.field === fieldKey);
      if (override) return { base: override.base, path: normSep(override.path) };
      return fld && fld.proposed && typeof fld.proposed === "object" ? fld.proposed : null;
    };
    for (const f of TOP_FIELDS) {
      if (rec[f] == null || rec[f] === "") continue;
      const v = applyField(f);
      if (v) rec[f] = v;
    }
    if (rec.params && Array.isArray(rec.params.aux_ref_audio_paths)) {
      rec.params.aux_ref_audio_paths = rec.params.aux_ref_audio_paths.map((orig, i) => {
        if (orig == null || orig === "") return orig;
        const v = applyField(`aux_ref_audio_paths[${i}]`);
        return v || orig;
      });
    }
    rec.schema_version = 3;
    if (!rec.meta) rec.meta = {};
    rec.meta.migrated_from = cls.schema_version;
    rec.meta.migrated_at = new Date().toISOString();

    const tmp = path.join(recipesDir, file + ".tmp" + process.pid);
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf-8");
    fs.renameSync(tmp, path.join(recipesDir, file));
    return { ok: true, backup: backupName, recipe: rec };
  }

  // REVERT: restore a recipe from its most recent (or named) backup.
  function revert(file, opts = {}) {
    let backups = [];
    try { backups = fs.readdirSync(backupDir); } catch (_) { return { ok: false, error: "no backups" }; }
    const mine = backups.filter((b) => b.startsWith(file + ".")).sort();
    if (mine.length === 0) return { ok: false, error: `no backup for ${file}` };
    const chosen = opts.backup && mine.includes(opts.backup) ? opts.backup : mine[mine.length - 1];
    const src = path.join(backupDir, chosen);
    const tmp = path.join(recipesDir, file + ".tmp" + process.pid);
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, path.join(recipesDir, file));
    return { ok: true, restored_from: chosen };
  }

  function listBackups(file) {
    let backups = [];
    try { backups = fs.readdirSync(backupDir); } catch (_) { return []; }
    return backups.filter((b) => !file || b.startsWith(file + ".")).sort();
  }

  return { preview, apply, revert, listBackups, classifyValue: (v) => classifyValue(v, ctx) };
}

module.exports = { createMigrator, classifyValue, TOP_FIELDS };
