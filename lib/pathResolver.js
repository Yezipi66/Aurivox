// Managed-path resolver (recipe schema v3, path portability keystone).
//
// A "managed path" is any file a recipe references: reference_audio,
// aux_ref_audio_paths[], gpt_ckpt, sovits_pth. Two representations coexist:
//
//   v3 (structured, self-describing):
//       { "base": "asset",    "path": "voice_id/models/x.ckpt" }   // under ASSETS_ROOT
//       { "base": "external", "path": "D:/models/x.ckpt" }         // absolute, non-portable
//
//   legacy (v<=2, plain string):
//       "assets/voice_id/models/x.ckpt"   // resolved against APP_DIR (unchanged)
//       "D:/models/x.ckpt"                // absolute passthrough (unchanged)
//
// Version-aware resolution — NEVER a silent "try A then B":
//   * v3 object base=asset    -> resolve against ASSETS_ROOT + containment assert
//   * v3 object base=external -> absolute as-is, marked non-portable
//   * legacy string           -> APP_DIR-relative (or absolute passthrough)
//
// `portable` is DERIVED from base (asset=portable, external=not) and never a
// second source of truth; a persisted `portable` is validated for consistency.

const path = require("path");
const fs = require("fs");
const { ASSETS_ROOT, APP_DIR } = require("./paths");

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function normSep(s) {
  return String(s == null ? "" : s).replace(/\\/g, "/");
}

// True for POSIX "/…", Windows "X:\…", or forward-slashed "X:/…".
function isAbsolutePath(raw) {
  const t = normSep(raw);
  return t.startsWith("/") || /^[a-zA-Z]:\//.test(t) || String(raw).includes(":\\");
}

// Relativize an absolute path under `root`; null if it escapes the root.
function underRoot(abs, root) {
  let rel = path.relative(root, path.resolve(normSep(abs)));
  rel = normSep(rel);
  if (rel === "" || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return rel;
}

// ── WRITE-TIME classification ────────────────────────────────────────────────
// Turn a raw client value (string OR already-v3 object) into a v3 managed-path
// object, applying FIELD-AWARE external permission. Never broadens perms:
//   field='model' external requires allowExternalModels
//   field='audio' external requires allowExternalAudio (default OFF)
//
// Returns { ok, value:{base,path}|"" , external } or { ok:false, code, error }.
function classifyManagedPath(raw, opts = {}) {
  const field = opts.field || "model";
  const allowExternalModels = !!opts.allowExternalModels;
  const allowExternalAudio = !!opts.allowExternalAudio;
  const assetsRoot = opts.assetsRoot || ASSETS_ROOT;

  if (raw == null || raw === "") return { ok: true, value: "", external: false };

  // Already a v3 object — validate + passthrough (consistency-checked).
  if (isPlainObject(raw)) {
    return validateManagedObject(raw, { field, allowExternalModels, allowExternalAudio });
  }

  const s = normSep(raw);

  if (!isAbsolutePath(s)) {
    if (s.includes("..")) return { ok: false, code: "invalid", error: 'path must not contain ".."' };
    // A bare relative path is interpreted as ASSETS_ROOT-relative under v3.
    // Tolerate a legacy "assets/" prefix (project-relative) by stripping it so
    // the stored form is genuinely assets-root-relative.
    let clean = s.replace(/^\/+/, "");
    clean = clean.replace(/^assets\//, "");
    if (clean === "") return { ok: false, code: "invalid", error: "empty path" };
    return { ok: true, value: { base: "asset", path: clean }, external: false };
  }

  // Absolute — relativize under ASSETS_ROOT when possible (portable).
  const rel = underRoot(raw, assetsRoot);
  if (rel != null) return { ok: true, value: { base: "asset", path: rel }, external: false };

  // Genuinely external (outside ASSETS_ROOT).
  const allowed = field === "model" ? allowExternalModels : allowExternalAudio;
  if (!allowed) {
    return {
      ok: false,
      code: "external",
      error: field === "model"
        ? "model file is outside ASSETS_ROOT — pinning it as an absolute (non-portable) path requires allow_external_models, or copy it under assets/ first."
        : "reference audio must live under ASSETS_ROOT (external audio is not permitted).",
    };
  }
  return { ok: true, value: { base: "external", path: normSep(raw) }, external: true };
}

// Validate a client-supplied v3 object (base/path) with field-aware perms and
// derived-portable consistency.
function validateManagedObject(obj, opts = {}) {
  const field = opts.field || "model";
  const allowExternalModels = !!opts.allowExternalModels;
  const allowExternalAudio = !!opts.allowExternalAudio;

  const base = obj.base;
  const p = normSep(obj.path || "");
  if (base !== "asset" && base !== "external") {
    return { ok: false, code: "invalid", error: `managed path base must be "asset" or "external" (got ${JSON.stringify(base)})` };
  }
  if (!p) return { ok: false, code: "invalid", error: "managed path is empty" };

  // Derived-portable consistency: if the caller persisted `portable`, it MUST
  // match base. We never trust it as an independent source of truth.
  if (obj.portable !== undefined && !!obj.portable !== (base === "asset")) {
    return { ok: false, code: "invalid", error: `portable (${obj.portable}) is inconsistent with base (${base})` };
  }

  if (base === "asset") {
    if (p.includes("..")) return { ok: false, code: "invalid", error: 'asset path must not contain ".."' };
    if (isAbsolutePath(p)) return { ok: false, code: "invalid", error: "asset path must be relative to ASSETS_ROOT" };
    return { ok: true, value: { base: "asset", path: p.replace(/^\/+/, "").replace(/^assets\//, "") }, external: false };
  }

  // external
  const allowed = field === "model" ? allowExternalModels : allowExternalAudio;
  if (!allowed) {
    return {
      ok: false,
      code: "external",
      error: field === "model"
        ? "external model path requires allow_external_models."
        : "external reference audio is not permitted.",
    };
  }
  if (!isAbsolutePath(p)) return { ok: false, code: "invalid", error: "external path must be absolute" };
  return { ok: true, value: { base: "external", path: p }, external: true };
}

// ── READ-TIME resolution ─────────────────────────────────────────────────────
// Resolve a managed-path VALUE (string legacy OR v3 object) to an absolute
// filesystem path, enforcing containment for asset-based paths.
//
// Returns { ok, path, external, portable, legacy } or { ok:false, code, error }.
// Lexical containment ALWAYS runs; realpath containment ALSO runs when the
// target exists (symlink/junction escape guard).
function resolveManagedRef(value, opts = {}) {
  const assetsRoot = opts.assetsRoot || ASSETS_ROOT;
  const appDir = opts.appDir || APP_DIR;

  if (value == null || value === "") return { ok: true, path: "" };

  // ── v3 structured object ──
  if (isPlainObject(value)) {
    const base = value.base;
    const p = normSep(value.path || "");
    if (base === "external") {
      return { ok: true, path: p, external: true, portable: false };
    }
    if (base === "asset") {
      if (p.includes("..")) return { ok: false, code: "escape", error: 'asset path contains ".."' };
      const rootAbs = normSep(path.resolve(assetsRoot));
      const resolved = normSep(path.resolve(assetsRoot, p));
      // Lexical containment (always).
      if (resolved !== rootAbs && !resolved.startsWith(rootAbs + "/")) {
        return { ok: false, code: "escape", error: "asset path escapes ASSETS_ROOT (lexical)" };
      }
      // Realpath containment (when the target exists) — guards symlink/junction.
      try {
        if (fs.existsSync(resolved)) {
          const real = normSep(fs.realpathSync(resolved));
          const rootReal = normSep(fs.realpathSync(rootAbs));
          if (real !== rootReal && !real.startsWith(rootReal + "/")) {
            return { ok: false, code: "escape", error: "asset path escapes ASSETS_ROOT (realpath)" };
          }
        }
      } catch (_) { /* stat/realpath race — lexical guard already held */ }
      return { ok: true, path: resolved, external: false, portable: true };
    }
    return { ok: false, code: "invalid", error: `unknown managed-path base: ${base}` };
  }

  // ── legacy string (v<=2) — APP_DIR semantics, unchanged ──
  const s = normSep(value);
  if (isAbsolutePath(s)) {
    return { ok: true, path: s, external: true, portable: false, legacy: true };
  }
  return { ok: true, path: normSep(path.join(appDir, s)), external: false, legacy: true, portable: false };
}

// Convenience: resolve and require existence; returns absolute path or throws a
// typed error the caller maps to an HTTP status.
function resolveExisting(value, opts = {}) {
  const r = resolveManagedRef(value, opts);
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; }
  return r.path;
}

module.exports = {
  isPlainObject,
  normSep,
  isAbsolutePath,
  underRoot,
  classifyManagedPath,
  validateManagedObject,
  resolveManagedRef,
  resolveExisting,
};
