// 托管路径（recipe schema v3）：配方引用的文件（参考音频、辅助参考音频、模型权重）
// 有两种写法并存。v3 结构化写法：{ base: "asset", path: "voice_id/models/x.ckpt" }
// 按 ASSETS_ROOT 解析，可移植；{ base: "external", path: "D:/models/x.ckpt" } 是绝对路径，不可移植。
// 旧写法（v2 及以前）是一个裸字符串，按 APP_DIR 解析，绝对字符串原样透传。
// 解析必须看版本，不能「先试 A 再试 B」：三种写法的语义各不相同，混着试会把
// 不可移植的路径说成可移植的。
// portable 由 base 推导（asset 为真，external 为假），它不是第二个真相来源；
// 落盘时带了 portable 的，要校验它与 base 一致。

const path = require("path");
const fs = require("fs");
const { ASSETS_ROOT, APP_DIR } = require("./paths");

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function normSep(s) {
  return String(s == null ? "" : s).replace(/\\/g, "/");
}

// 绝对路径：POSIX 的 "/..."、Windows 的 "X:\..." 或 "X:/..."。
function isAbsolutePath(raw) {
  const t = normSep(raw);
  return t.startsWith("/") || /^[a-zA-Z]:\//.test(t) || String(raw).includes(":\\");
}

// 把绝对路径换成相对 root 的形式；逃出 root 时返回 null。
function underRoot(abs, root) {
  let rel = path.relative(root, path.resolve(normSep(abs)));
  rel = normSep(rel);
  if (rel === "" || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return rel;
}

// 写入时分类：把客户端给的值（裸字符串或已经是 v3 对象）转成 v3 托管路径对象。
// 外部路径按字段分别放行，且只收不放：model 字段要 allowExternalModels，
// audio 字段要 allowExternalAudio（默认不放行）。
// 返回 { ok, value:{base,path}|"", external } 或 { ok:false, code, error }。
function classifyManagedPath(raw, opts = {}) {
  const field = opts.field || "model";
  const allowExternalModels = !!opts.allowExternalModels;
  const allowExternalAudio = !!opts.allowExternalAudio;
  const assetsRoot = opts.assetsRoot || ASSETS_ROOT;

  if (raw == null || raw === "") return { ok: true, value: "", external: false };

  // 已经是 v3 对象：校验后原样透传。
  if (isPlainObject(raw)) {
    return validateManagedObject(raw, { field, allowExternalModels, allowExternalAudio });
  }

  const s = normSep(raw);

  if (!isAbsolutePath(s)) {
    if (s.includes("..")) return { ok: false, code: "invalid", error: 'path must not contain ".."' };
    // 相对路径在 v3 里按 ASSETS_ROOT 解释。旧写法里的 "assets/" 前缀照样收下，
    // 但要剥掉，好让存下来的形状确实是相对 ASSETS_ROOT 的。
    let clean = s.replace(/^\/+/, "");
    clean = clean.replace(/^assets\//, "");
    if (clean === "") return { ok: false, code: "invalid", error: "empty path" };
    return { ok: true, value: { base: "asset", path: clean }, external: false };
  }

  // 绝对路径：能落到 ASSETS_ROOT 下就转成可移植写法。
  const rel = underRoot(raw, assetsRoot);
  if (rel != null) return { ok: true, value: { base: "asset", path: rel }, external: false };

  // 真的在 ASSETS_ROOT 之外。
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

// 校验客户端给的 v3 对象（base/path），并按字段判断外部路径是否放行。
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

  // portable 由 base 推导，不承认它作为独立真相：落盘的 portable 必须与 base 一致。
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

// 读取时解析：把托管路径的值（旧写法的裸字符串或 v3 对象）解析成绝对路径，
// asset 一律做包含检查。词法包含检查总是跑；目标存在时再跑一次 realpath 检查，
// 挡住符号链接与 junction 逃逸。
// 返回 { ok, path, external, portable, legacy } 或 { ok:false, code, error }。
function resolveManagedRef(value, opts = {}) {
  const assetsRoot = opts.assetsRoot || ASSETS_ROOT;
  const appDir = opts.appDir || APP_DIR;

  if (value == null || value === "") return { ok: true, path: "" };

  // v3 结构化对象
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
      // 词法包含检查，总是跑。
      if (resolved !== rootAbs && !resolved.startsWith(rootAbs + "/")) {
        return { ok: false, code: "escape", error: "asset path escapes ASSETS_ROOT (lexical)" };
      }
      // realpath 包含检查，目标存在时才跑：挡住符号链接与 junction。
      try {
        if (fs.existsSync(resolved)) {
          const real = normSep(fs.realpathSync(resolved));
          const rootReal = normSep(fs.realpathSync(rootAbs));
          if (real !== rootReal && !real.startsWith(rootReal + "/")) {
            return { ok: false, code: "escape", error: "asset path escapes ASSETS_ROOT (realpath)" };
          }
        }
      } catch (_) { /* stat/realpath 竞态：词法检查已经挡住了 */ }
      return { ok: true, path: resolved, external: false, portable: true };
    }
    return { ok: false, code: "invalid", error: `unknown managed-path base: ${base}` };
  }

  // 旧写法（v2 及以前）的裸字符串：按 APP_DIR 解释。
  const s = normSep(value);
  if (isAbsolutePath(s)) {
    return { ok: true, path: s, external: true, portable: false, legacy: true };
  }
  return { ok: true, path: normSep(path.join(appDir, s)), external: false, legacy: true, portable: false };
}

// 解析并要求文件存在；返回绝对路径，失败时抛带 code 的错误，由调用方映射成 HTTP 状态。
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
