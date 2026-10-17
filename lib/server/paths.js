'use strict';

// ============================================================================
//  路径语义：项目相对 ⇄ 绝对的互相换算、id 语法、临时参考音频入库
// ============================================================================
//
// 从 server.js 逐字搬来（P0 拆分任务 3），行为零变化。
//
// 目录位置一律问 lib/paths.js（契约 C7），本文件不按 __dirname 数层数。

const fs = require('fs');
const path = require('path');

const PATHS = require('../paths');
const {
  APP_DIR, ASSETS_ROOT, CUSTOM_REF_DIR, CUSTOM_REFS_DIRNAME,
} = PATHS;

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

// A "custom" reference upload lands in APP_DIR/voices/custom_refs
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
  const destDir = path.join(ASSETS_ROOT, role, CUSTOM_REFS_DIRNAME);
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

function safeId(id) { return /^[a-zA-Z0-9_-]+$/.test(id); }

module.exports = {
  resolveRefPath,
  toProjectRelative,
  normalizeModelPath,
  importCustomRefToAsset,
  safeId,
};
