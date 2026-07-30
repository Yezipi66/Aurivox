// Recipe storage layer (P0 keystone).
//
// A "recipe" is a first-class, reusable inference preset scoped to a voice
// (role). Recipes live in a single flat folder as JSON files named
// `recipe_{voiceId}_{name}.json`. The JSON content is the source of truth; the
// filename is derived for convenience but lookups also fall back to scanning by
// the stored `id` so the theoretical filename collision (e.g. role "A_x"+name
// "y" vs role "A"+name "x_y") never corrupts a lookup.
//
// Contract (locked 2026-07-07):
//   - id           = `{role}/{name}`  (also the OpenAI `voice` field, D3)
//   - role         = voiceId, `[a-zA-Z0-9_-]+`
//   - name         = free label (emotion/identifier), Unicode letters allowed,
//                    filesystem-dangerous symbols blacklisted.
//   - reference_audio stored as a project-relative path (D3 / point 3).
//   - gpt_ckpt + sovits_pth pinned (point 4) for reproducible distribution;
//     the Broker page re-binds them when a model file goes missing.
//   - Create rejects duplicates; overwrite goes through update({force}).
//
// This module is intentionally framework-free so it can be unit-tested in
// isolation. `createRecipeStore(recipesDir)` returns the CRUD surface.

const fs = require("fs");
const path = require("path");

// schema_version 2 (2026-07-08, PA): `params` widened to carry the full
// inference contract so recipes are reproducible when distributed via
// /v1/audio/speech. New fields: aux_ref_audio_paths, text_split_method,
// pron_overrides, repetition_penalty, sample_steps, if_sr, batch_size,
// batch_threshold, split_bucket, fragment_interval, parallel_infer, seed.
// Older (v1) recipes are read as-is; missing fields fall back to engine
// defaults at replay time — no migration script required (PA-3).
//
// schema_version 3 (2026-07-17, Option-A): managed path fields
// (reference_audio, aux_ref_audio_paths[], gpt_ckpt, sovits_pth) may now be a
// STRUCTURED path object `{ base: "asset"|"external", path }` instead of a bare
// string. `base:"asset"` resolves against ASSETS_ROOT (portable); `base:"external"`
// is an absolute non-portable file. Bare strings remain valid and are read with
// legacy APP_DIR semantics (version-aware resolver). schema_version is PRESERVED
// on update so a v2 recipe is never silently rewritten to v3 — migration to v3
// is an explicit, assisted operation. Only `create` (new) mints v3.
const SCHEMA_VERSION = 3;
const MAX_NAME_LEN = 64;

// Characters that are unsafe in a filename / would break the `role/name`
// `voice` grammar. Unicode letters (中日英韓 etc.) are allowed — only these
// symbols and control characters are rejected.
const NAME_BLACKLIST = /[\/\\:*?"<>|]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function validateVoiceId(role) {
  if (typeof role !== "string" || !role.trim()) {
    return { ok: false, error: "role (voiceId) is required" };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(role)) {
    return { ok: false, error: "role must match [a-zA-Z0-9_-]+" };
  }
  return { ok: true };
}

function validateName(name) {
  if (typeof name !== "string") {
    return { ok: false, error: "name is required" };
  }
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "name is required" };
  if (trimmed.length > MAX_NAME_LEN) {
    return { ok: false, error: `name too long (max ${MAX_NAME_LEN})` };
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return { ok: false, error: "name contains control characters" };
  }
  if (NAME_BLACKLIST.test(trimmed)) {
    return { ok: false, error: 'name must not contain / \\ : * ? " < > |' };
  }
  if (trimmed === "." || trimmed === ".." || trimmed.startsWith(".")) {
    return { ok: false, error: "name must not start with '.'" };
  }
  return { ok: true, value: trimmed };
}

function displayNameFor(role, name) {
  return `${role.toUpperCase()} - ${name}`;
}

function recipeFilename(role, name) {
  return `recipe_${role}_${name}.json`;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// A path is storable in a recipe only if it is project-relative (portable /
// distribution-safe). Absolute paths, drive-letters and `..` traversal are
// rejected so a shared recipe never points outside the receiver's project.
function isProjectRelativePath(p) {
  return typeof p === "string" && p !== "" &&
    !p.includes("..") && !p.startsWith("/") && !p.includes(":\\") && !p.includes(":/");
}

// A structured v3 managed-path object: { base: "asset"|"external", path: "..." }.
function isManagedPathObject(v) {
  return isPlainObject(v) &&
    (v.base === "asset" || v.base === "external") &&
    typeof v.path === "string" && v.path !== "";
}

// `portable` is a DERIVED field (asset⇒true, external⇒false); it may be persisted
// but must never disagree with `base`.
function portableInconsistent(v) {
  return isManagedPathObject(v) && v.portable !== undefined &&
    !!v.portable !== (v.base === "asset");
}

// Validate a managed-path field value for storage. Accepts:
//   - "" / null            → cleared
//   - a v3 structured object (shape-checked here; the field-aware external
//     permission gate lives in the server layer via pathResolver)
//   - a bare string, which — for portable fields (reference/aux) — must still be
//     project-relative to preserve the legacy portability guard. Model fields
//     (gpt/sovits) historically stored absolute strings and are accepted as-is.
function managedFieldError(v, { field, portableString }) {
  if (v === "" || v == null) return null;
  if (isManagedPathObject(v)) {
    if (portableInconsistent(v)) return `${field}.portable is inconsistent with base`;
    return null;
  }
  if (isPlainObject(v)) return `${field} object must be { base: "asset"|"external", path }`;
  if (typeof v === "string") {
    if (portableString && !isProjectRelativePath(v)) {
      return `${field} must be a project-relative path`;
    }
    return null;
  }
  return `${field} must be a string path or a { base, path } object`;
}

function num(v, d) {
  return v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d;
}

function bool(v, d) {
  return v != null ? !!v : d;
}

function createRecipeStore(recipesDir) {
  if (!recipesDir) throw new Error("recipesDir is required");

  function ensureDir() {
    fs.mkdirSync(recipesDir, { recursive: true });
  }

  // Deterministic path first; if absent, scan for a file whose stored id matches
  // (collision-proof and case-preserving).
  function pathFor(role, name) {
    return path.join(recipesDir, recipeFilename(role, name));
  }

  function findFileById(id) {
    let files = [];
    try { files = fs.readdirSync(recipesDir); } catch (_) { return null; }
    for (const f of files) {
      if (!f.startsWith("recipe_") || !f.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(recipesDir, f), "utf-8"));
        if (data && data.id === id) return { file: path.join(recipesDir, f), data };
      } catch (_) { /* skip corrupt */ }
    }
    return null;
  }

  function readByRoleName(role, name) {
    const direct = pathFor(role, name);
    if (fs.existsSync(direct)) {
      try { return { file: direct, data: JSON.parse(fs.readFileSync(direct, "utf-8")) }; }
      catch (_) { /* fall through to scan */ }
    }
    return findFileById(`${role}/${name}`);
  }

  function atomicWrite(file, obj) {
    ensureDir();
    const tmp = file + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  }

  // Build a normalized recipe from a client payload. Does not touch disk.
  function normalize(payload, existing) {
    const role = payload.role != null ? payload.role : payload.voiceId;
    const rv = validateVoiceId(role);
    if (!rv.ok) return { ok: false, error: rv.error };

    const nv = validateName(payload.name);
    if (!nv.ok) return { ok: false, error: nv.error };
    const name = nv.value;

    // F1 / v3: reference_audio may be a bare project-relative string (legacy) or
    // a structured { base, path } object. The bare-string project-relative guard
    // is preserved so the forward-slash drive form `X:/…` can't slip through as a
    // silently-absolute path; v3 external audio must arrive as an explicit object
    // (gated by the server's allow_external_audio policy).
    {
      const e = managedFieldError(payload.reference_audio, { field: "reference_audio", portableString: true });
      if (e) return { ok: false, error: e };
    }

    const srcParams = isPlainObject(payload.params) ? payload.params : {};
    const prevParams = existing && isPlainObject(existing.params) ? existing.params : {};

    // Auxiliary reference audio — array of project-relative paths (PA). Reject
    // any non-portable path so distribution stays reproducible.
    let auxRaw = srcParams.aux_ref_audio_paths;
    if (auxRaw === undefined) auxRaw = prevParams.aux_ref_audio_paths;
    let aux_ref_audio_paths = [];
    if (Array.isArray(auxRaw)) {
      for (const p of auxRaw) {
        if (p === "" || p == null) continue;
        if (typeof p === "string" || isPlainObject(p)) {
          const e = managedFieldError(p, { field: "aux_ref_audio_paths", portableString: true });
          if (e) return { ok: false, error: e };
          aux_ref_audio_paths.push(p);
        }
      }
    }

    // Pronunciation overrides — opaque dict pinned so reading corrections travel
    // with the recipe (PA-1). Stored verbatim; the engine's set_context consumes
    // whatever shape the client sends.
    let pron_overrides = srcParams.pron_overrides;
    if (pron_overrides === undefined) pron_overrides = prevParams.pron_overrides;
    if (!isPlainObject(pron_overrides)) pron_overrides = {};

    const params = {
      top_k: num(srcParams.top_k != null ? srcParams.top_k : prevParams.top_k, 15),
      top_p: num(srcParams.top_p != null ? srcParams.top_p : prevParams.top_p, 1.0),
      temperature: num(srcParams.temperature != null ? srcParams.temperature : prevParams.temperature, 1.0),
      speed: num(srcParams.speed != null ? srcParams.speed : prevParams.speed, 1.0),

      // PA: extended, reproducible inference contract.
      text_split_method: srcParams.text_split_method || prevParams.text_split_method || "cut5",
      repetition_penalty: num(srcParams.repetition_penalty != null ? srcParams.repetition_penalty : prevParams.repetition_penalty, 1.35),
      sample_steps: num(srcParams.sample_steps != null ? srcParams.sample_steps : prevParams.sample_steps, 32),
      if_sr: bool(srcParams.if_sr != null ? srcParams.if_sr : prevParams.if_sr, false),
      batch_size: num(srcParams.batch_size != null ? srcParams.batch_size : prevParams.batch_size, 1),
      batch_threshold: num(srcParams.batch_threshold != null ? srcParams.batch_threshold : prevParams.batch_threshold, 0.75),
      split_bucket: bool(srcParams.split_bucket != null ? srcParams.split_bucket : prevParams.split_bucket, true),
      fragment_interval: num(srcParams.fragment_interval != null ? srcParams.fragment_interval : prevParams.fragment_interval, 0.3),
      parallel_infer: bool(srcParams.parallel_infer != null ? srcParams.parallel_infer : prevParams.parallel_infer, true),
      // PA-2: seed stored but defaults to -1 (random) — user locks it explicitly.
      seed: num(srcParams.seed != null ? srcParams.seed : prevParams.seed, -1),

      aux_ref_audio_paths,
      pron_overrides,
    };

    // Model checkpoint fields — accept bare string (any, incl. legacy absolute) or
    // v3 object. No project-relative guard on strings (models historically stored
    // absolute); the server's field-aware gate + read-time containment enforce
    // security.
    {
      const eg = managedFieldError(payload.gpt_ckpt, { field: "gpt_ckpt", portableString: false });
      if (eg) return { ok: false, error: eg };
      const es = managedFieldError(payload.sovits_pth, { field: "sovits_pth", portableString: false });
      if (es) return { ok: false, error: es };
    }

    const now = new Date().toISOString();
    const srcMeta = isPlainObject(payload.meta) ? payload.meta : {};
    const prevMeta = existing && isPlainObject(existing.meta) ? existing.meta : {};

    // Preserve the existing schema_version on update so a legacy recipe is never
    // silently upgraded to v3. New recipes (no `existing`) mint the current
    // SCHEMA_VERSION. Migration explicitly passes payload.schema_version.
    const schemaVersion =
      payload.schema_version != null ? payload.schema_version :
      (existing && existing.schema_version != null ? existing.schema_version : SCHEMA_VERSION);

    return {
      ok: true,
      value: {
        schema_version: schemaVersion,
        id: `${role}/${name}`,
        role,
        name,
        display_name: displayNameFor(role, name),

        reference_audio: payload.reference_audio || "",
        reference_text: payload.reference_text || "",
        // Language is the recipe's OPTIONAL pinned target-text language. It may be
        // a concrete lang (all_zh/all_ja/en/all_ko/all_yue), an auto mode
        // (auto/auto_zh_ja), or BLANK. Blank means "don't freeze" — at replay the
        // synthesis layer follows the asset's language (then auto). Preserved on
        // update; only an explicit choice (usually the Save-as-recipe dialog,
        // which requires a selection) writes a value. No default "ja" is minted.
        language: (typeof payload.language === "string" && payload.language.trim())
          ? payload.language.trim()
          : (existing && typeof existing.language === "string" ? existing.language : ""),

        params,

        // Pinned models for reproducible distribution (Broker page re-binds).
        gpt_ckpt: payload.gpt_ckpt || (existing && existing.gpt_ckpt) || "",
        sovits_pth: payload.sovits_pth || (existing && existing.sovits_pth) || "",

        // Current-engine emotion control (ref-audio route).
        emotion_ref: payload.emotion_ref || null,
        // Reserved for IndexTTS2 explicit 8-dim vector (ignored by v2Pro).
        emo_vector: payload.emo_vector != null ? payload.emo_vector : null,

        meta: {
          source: srcMeta.source || prevMeta.source || "generate",
          created_at: prevMeta.created_at || now,
          updated_at: now,
          sovits_version: srcMeta.sovits_version || prevMeta.sovits_version || "",
          notes: srcMeta.notes != null ? srcMeta.notes : (prevMeta.notes || ""),
          tags: Array.isArray(srcMeta.tags) ? srcMeta.tags : (prevMeta.tags || []),
        },
      },
    };
  }

  return {
    SCHEMA_VERSION,
    validateVoiceId,
    validateName,
    normalize,

    // CREATE — rejects an existing (role,name) unless force=true.
    create(payload, opts) {
      const force = !!(opts && opts.force);
      const n = normalize(payload);
      if (!n.ok) return { ok: false, code: "invalid", error: n.error };
      const existing = readByRoleName(n.value.role, n.value.name);
      if (existing && !force) {
        return { ok: false, code: "exists", error: `recipe already exists: ${n.value.id}` };
      }
      // Preserve created_at when force-overwriting.
      if (existing) {
        const re = normalize(payload, existing.data);
        atomicWrite(existing.file, re.value);
        return { ok: true, recipe: re.value };
      }
      atomicWrite(pathFor(n.value.role, n.value.name), n.value);
      return { ok: true, recipe: n.value };
    },

    // LIST — optionally scoped to a role.
    list(opts) {
      const role = opts && opts.role;
      let files = [];
      try { files = fs.readdirSync(recipesDir); } catch (_) { return []; }
      const out = [];
      for (const f of files) {
        if (!f.startsWith("recipe_") || !f.endsWith(".json")) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(recipesDir, f), "utf-8"));
          if (role && data.role !== role) continue;
          out.push(data);
        } catch (_) { /* skip corrupt */ }
      }
      out.sort((a, b) => (a.id || "").localeCompare(b.id || ""));
      return out;
    },

    // GET one by role+name.
    get(role, name) {
      const rv = validateVoiceId(role); if (!rv.ok) return null;
      const nv = validateName(name); if (!nv.ok) return null;
      const found = readByRoleName(role, nv.value);
      return found ? found.data : null;
    },

    // Resolve an OpenAI `voice` field ("role/name") to a recipe, or null.
    resolveVoice(voiceField) {
      if (typeof voiceField !== "string") return null;
      const idx = voiceField.indexOf("/");
      if (idx <= 0 || idx === voiceField.length - 1) return null;
      const role = voiceField.slice(0, idx);
      const name = voiceField.slice(idx + 1);
      return this.get(role, name);
    },

    // UPDATE — merge a partial patch (used by Broker model re-bind + edits).
    update(role, name, patch) {
      const rv = validateVoiceId(role); if (!rv.ok) return { ok: false, code: "invalid", error: rv.error };
      const nv = validateName(name); if (!nv.ok) return { ok: false, code: "invalid", error: nv.error };
      const found = readByRoleName(role, nv.value);
      if (!found) return { ok: false, code: "not_found", error: `recipe not found: ${role}/${nv.value}` };

      const merged = Object.assign({}, found.data, isPlainObject(patch) ? patch : {});
      // role/name are immutable via update (rename = delete+create).
      merged.role = found.data.role;
      merged.name = found.data.name;
      if (isPlainObject(patch) && isPlainObject(patch.params)) {
        merged.params = Object.assign({}, found.data.params, patch.params);
      }
      if (isPlainObject(patch) && isPlainObject(patch.meta)) {
        merged.meta = Object.assign({}, found.data.meta, patch.meta);
      }
      const n = normalize(merged, found.data);
      if (!n.ok) return { ok: false, code: "invalid", error: n.error };
      atomicWrite(found.file, n.value);
      return { ok: true, recipe: n.value };
    },

    // DELETE — returns true if a file was removed.
    remove(role, name) {
      const rv = validateVoiceId(role); if (!rv.ok) return false;
      const nv = validateName(name); if (!nv.ok) return false;
      const found = readByRoleName(role, nv.value);
      if (!found) return false;
      try { fs.unlinkSync(found.file); return true; } catch (_) { return false; }
    },
  };
}

module.exports = { createRecipeStore, SCHEMA_VERSION, validateName, validateVoiceId };
