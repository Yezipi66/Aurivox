// 配方的 v2→v3 迁移：把托管路径从裸字符串改成结构化的 { base, path }。
// 判据是路径的落点：裸相对字符串按 APP_DIR 与按 ASSETS_ROOT 解析可能指向两个不同文件，
// 因此迁移是要人过目的操作：预览分类 → 人确认 → 备份后改写 → 可回滚。
// 分类分四类：convertible（落在 ASSETS_ROOT 内，可转成资产相对）、external（落在 ASSETS_ROOT 外）、
// missing（各处都找不到文件）、ambiguous（两种解释都命中不同的真实文件，必须人来定）。
// 边界：只在用户显式调用时运行，启动与扫描都不会自动迁移。

const fs = require("fs");
const path = require("path");

function normSep(s) { return String(s == null ? "" : s).replace(/\\/g, "/"); }

function isAbsolutePath(raw) {
  const s = normSep(raw);
  return s.startsWith("/") || /^[a-zA-Z]:\//.test(s);
}

// 若 abs 在 root 之内，返回相对 root 的路径（正斜杠）；否则返回 null。
function relUnderRoot(abs, root) {
  const rel = path.relative(root, abs);
  const r = normSep(rel);
  if (r === "" || r === ".." || r.startsWith("../") || path.isAbsolute(rel)) return null;
  return r;
}

// 配方里需要迁移的托管路径字段：reference_audio / gpt_ckpt / sovits_pth 在顶层，
// aux_ref_audio_paths 是 params 下的数组。
const TOP_FIELDS = ["reference_audio", "gpt_ckpt", "sovits_pth"];

// 把一个旧格式的字符串值分类，并给出建议的 v3 结构。
// 返回 { status, proposed, ... }：status 取 already_v3 / empty / convertible / external / missing / ambiguous。
// ambiguous 时没有 proposed，改为给出两个候选，由人通过 resolutions 指定。
function classifyValue(value, { appDir, assetsRoot }) {
  // 已经是 v3 结构：无事可做。
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

  // 相对路径：两种都说得通的解释。
  //  (a) 按 APP_DIR 解析（v2 的语义）
  //  (b) 按 ASSETS_ROOT 解析（去掉开头的 "assets/" 之后）
  const absApp = path.resolve(appDir, s);
  const stripped = s.replace(/^\/+/, "").replace(/^assets\//, "");
  const absAsset = path.resolve(assetsRoot, stripped);
  const appExists = safeExists(absApp);
  const assetExists = safeExists(absAsset);
  const appUnderAssets = relUnderRoot(absApp, assetsRoot);

  // 两种解释都命中文件且指向不同的文件：判为 ambiguous。
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

  // 按 APP_DIR 解析的结果本来就落在 ASSETS_ROOT 内：可直接转成资产相对路径。
  if (appUnderAssets != null) {
    return {
      status: appExists ? "convertible" : "missing",
      proposed: { base: "asset", path: appUnderAssets },
      resolved: normSep(absApp),
    };
  }

  // 按 APP_DIR 解析的结果落在 ASSETS_ROOT 之外。
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
  // 两种解释都找不到文件。
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

// 为一份配方生成迁移预览（只读，不写盘）。
// 返回 { id, role, name, schema_version, fields, applicable, blocked }：
// applicable 为 true 表示这份配方可以整体迁移（没有 ambiguous/missing 字段，且版本 < 3）。
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
    // 只有没有任何字段是 ambiguous/missing，这份配方才可安全迁移。
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

  // 预览：分类每一份版本 < 3 的配方，不写任何东西。
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

  // 改写：迁移一份配方，先备份再把 convertible/external 字段写成 v3 结构，schema_version 升到 3。
  // 任何字段是 ambiguous/missing 时拒绝，除非 opts.resolutions 里给了该字段的明确取值。
  // 返回 { ok: true, backup, recipe } 或 { ok: false, error }。
  function apply(file, opts = {}) {
    const resolutions = opts.resolutions || {}; // 字段名 → { base, path }
    let rec;
    try { rec = readRecipe(file); } catch (e) { return { ok: false, error: `unreadable: ${e.message}` }; }
    if ((rec.schema_version || 1) >= 3) return { ok: false, error: "already v3" };

    const cls = classifyRecipe(rec, ctx);
    // 定每个字段的最终取值：人给的 resolutions 优先；否则用自动建议，
    // 但只在建议的 status 是安全（非 blocked）时才用。
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

    // 先备份。
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `${file}.${ts}.json`;
    fs.copyFileSync(path.join(recipesDir, file), path.join(backupDir, backupName));

    // 改写字段。
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

  // 回滚：从备份恢复一份配方。opts.backup 指定用哪一份备份，不给就用最新的一份。
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
