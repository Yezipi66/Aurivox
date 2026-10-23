'use strict';

// 路径语义：项目相对 ⇄ 绝对的互相换算、id 语法、临时参考音频入库。
// 目录位置一律问 lib/paths.js，本文件不按 __dirname 数层数。

const fs = require('fs');
const path = require('path');

const PATHS = require('../paths');
const {
  APP_DIR, ASSETS_ROOT, CUSTOM_REF_DIR, CUSTOM_REFS_DIRNAME,
} = PATHS;

function resolveRefPath(raw) {
  if (!raw) return "";
  // 绝对路径（POSIX "/…"，Windows "X:\…" 或 "X:/…"）原样返回；
  // 只有项目相对路径才接到 APP_DIR 下面。
  if (raw.startsWith("/") || raw.includes(":\\") || /^[a-zA-Z]:\//.test(raw)) return raw;
  return path.join(APP_DIR, raw).replace(/\\/g, "/");
}

// 把一个绝对路径（用户浏览选出来的）换回项目相对的正斜杠路径。
// 路径逃出项目根（APP_DIR）时返回 null，Broker 页面据此拒收不可移植的模型选择。
function toProjectRelative(abs) {
  if (!abs) return null;
  let rel = path.relative(APP_DIR, path.resolve(abs));
  rel = rel.replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return null;
  return rel;
}

// 规整配方里选的模型路径。已经相对的原样保留；项目内的绝对路径转成项目相对
// 形式（可移植）；项目外的绝对路径只有调用方明确确认（allowExternal）才允许，
// 这时原样存成绝对路径，等于把配方钉死在当前机器上：文件不能挪，配方也不再
// 自包含（用户得把那些模型文件一并带走）。
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
  // 在项目外。
  if (!allowExternal) {
    return {
      ok: false,
      code: "external",
      error: "model file is outside the project — it will be pinned as an absolute path (not portable). Confirm to proceed, or copy it under assets/ first.",
    };
  }
  return { ok: true, value: s, external: true };
}

// 「自定义」参考音频的临时上传落在 APP_DIR/voices/custom_refs（在 ASSETS_ROOT
// 之外）。把那个原始路径直接存进 v3 配方会被误标成 ASSETS_ROOT 资产
//（classifyManagedPath 把裸相对路径当成 asset 相对）⇒ 配方指向一个不存在的文件，
// 而且不可移植。所以保存 v3 配方时把这个临时文件导入角色的托管资产
//（ASSETS_ROOT/<role>/custom_refs/<fn>），返回 assets 相对路径，它才真的是
// { base:'asset' } 引用。非自定义路径（本角色切片 / 跨角色 / 已导入 / v3 对象）原样放过。
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
  if (!abs || !fs.existsSync(abs)) return rawPath; // 不是临时自定义引用（或已不在）：原样放过
  const fn = path.basename(abs);
  const destDir = path.join(ASSETS_ROOT, role, CUSTOM_REFS_DIRNAME);
  fs.mkdirSync(destDir, { recursive: true });
  let destName = fn;
  let dest = path.join(destDir, destName);
  // 防撞名：已有同名且内容相同的直接复用，否则加后缀改名。
  if (fs.existsSync(dest) && fs.statSync(dest).size !== fs.statSync(abs).size) {
    const ext = path.extname(fn);
    destName = `${path.basename(fn, ext)}_${Date.now().toString(36)}${ext}`;
    dest = path.join(destDir, destName);
  }
  if (!fs.existsSync(dest)) fs.copyFileSync(abs, dest);
  return `${role}/custom_refs/${destName}`; // assets 根相对 ⇒ 归类为 {base:'asset'}
}

function safeId(id) { return /^[a-zA-Z0-9_-]+$/.test(id); }

module.exports = {
  resolveRefPath,
  toProjectRelative,
  normalizeModelPath,
  importCustomRefToAsset,
  safeId,
};
