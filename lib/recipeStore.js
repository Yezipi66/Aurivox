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
// 契约 C11：「这个参数默认多少、是什么类型」只有名片能回答。
const { findLegacyDefaultId } = require("./engines/legacyDefault");
const { engineParamDefaults, engineUiSchema } = require("./engines/paramTable");

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
//
// schema_version 4 (2026-08-23, 引擎契约 v2)：配方成为**闭合的调用目标** ——
// 除了 text（由调用方每次递进来），一条配方不缺任何东西，包括**去哪台引擎**。
//
// 加两个字段：
//   engine_id      去哪台引擎。空 = 老路径引擎（名片写 legacy_default 的那台），
//                  与 v3 行为一致，所以老配方不改一个字也仍然能跑。
//   engine_params  { "<引擎id>": { 该引擎自己的参数 } }。**原样存、原样取，
//                  平台一个键都不看**（Owner 2026-08-23 定的尺度：硬判参数
//                  等于恒常误报，误报久了就没人看了）。
//
// ⭐ v4 最要紧的一处修复不是加字段，是**堵住静默吃键**：
//    v3 的 `params` 是写死的 16 键白名单，不在表上的键**直接丢掉还照返 200**
//    —— 保存成功了，值没了，这是最恶劣的失败形式。v4 里这些键不再消失，
//    而是落进 engine_params[engine_id]。前端一个字都不用改。
//
// ⚠ 没有做、且是**故意**没做的：gpt_ckpt / sovits_pth 仍留在顶层。它们表面上
//   是 GPT-SoVITS 的私有字段，实际上是**平台托管的路径**（pathResolver 按
//   schema_version 做版本感知解析，Broker 页在文件丢失时重新绑定）。挪进
//   「平台不许看」的格子会和「平台必须解析它」直接冲突，而且要动前端
//   web/src/lib/recipes.js。留给下一刀，连同顶层字段的名片映射一起做。
const SCHEMA_VERSION = 4;
const MAX_NAME_LEN = 64;

// v4 的 `params` = **通用格子**：平台自己要读的键。其余一律进 engine_params。
//
// 这张表怎么来的：我查了 6 台开源引擎的真实推理入口（GPT-SoVITS / IndexTTS2 /
// F5-TTS / CosyVoice2 / XTTS-v2 / Kokoro），逐个字段对通用性 ——
//   speed  6/6 全中，唯一真通用的
//   seed   3/6（CosyVoice2、XTTS-v2、Kokoro 都不暴露）
//   其余（top_k/temperature/nfe_step/…）没有一个跨得过两种架构
// seed 通不过 6/6 却仍留在通用格子，是因为**平台自己要用它**：resolveSeed()
// 在调引擎之前把 -1 变成具体数字并写进 meta.json，Rerun 靠它复现。引擎没有
// seed 概念时，这个键就只是没人读，不会出错。
const GENERIC_PARAM_KEYS = new Set(["speed", "seed"]);

// v3 的 16 键白名单。v4 **继续原样收下它们**（前端还在这么发，改了就是回归），
// 只是不再把表外的键丢掉。这张表存在的唯一目的是回答「哪些键属于历史通用格子」。
const V3_PARAM_KEYS = new Set([
  "top_k", "top_p", "temperature", "speed",
  "text_split_method", "repetition_penalty", "sample_steps", "if_sr",
  "batch_size", "batch_threshold", "split_bucket", "fragment_interval",
  "parallel_infer", "seed", "aux_ref_audio_paths", "pron_overrides",
]);

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

// 平台自己的通用格子的默认值。这两个键不属于任何一台引擎（GENERIC_PARAM_KEYS
// 上面那段注释解释了它们凭什么是通用的：speed 查了 6 台引擎 6/6 全中；seed
// 是平台自己要用的 —— resolveSeed() 把 -1 变成具体数字写进 meta.json，Rerun
// 靠它复现）。⚠ seed 的 -1 同时也写在老路径名片的 defaults 上，这里用名片的
// 那一份，下面 legacyParamDefaults() 会把它盖过来。
const PLATFORM_GENERIC_DEFAULTS = { speed: 1.0, seed: -1 };

// 老形状（v3）配方的默认值与类型，全部来自老路径引擎的名片。
// ⛔ 不缓存：装了哪些引擎、环境变量拧到几，都是运行时事实（同 server.js）。
function legacyParamDefaults() {
  return { ...PLATFORM_GENERIC_DEFAULTS, ...engineParamDefaults(findLegacyDefaultId()) };
}

function legacyParamTypes() {
  const out = {};
  for (const entry of engineUiSchema(findLegacyDefaultId())) out[entry.name] = entry.type;
  return out;
}

/**
 * 按名片声明的类型把一个值转成能存盘的形状。
 *
 * ⛔ 这里不认识任何一个具体参数名 —— 它只认名片上写的 type（契约 §5.5：
 *    平台只搬运，不翻译）。名片没描述过的键（平台通用格子 speed/seed）走
 *    数字，这是它们**在平台侧**的既有形状，不是对某台引擎的了解。
 */
function coerceLegacyParam(key, raw) {
  const def = legacyParamDefaults()[key];
  const type = legacyParamTypes()[key];
  if (type === "boolean") return bool(raw, def);
  if (type === "enum") return raw || def;
  // number / integer，以及名片没描述的平台通用格子
  return num(raw, def);
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

    // 这里原本是一张写死的表：16 个键，每个键的默认值直接写在参数位上。
    // 它是 batch_size 那几份副本之一 —— 名片写 4（我们自己的调优决策，还配了
    // AURIVOX_TTS_BATCH_SIZE 旋钮），这里写 1，两边谁也不知道对方存在，
    // 而且**不一致不会让任何一条测试变红**。契约 C11 要杀的就是这个。
    //
    // 现在：**键集**仍来自 V3_PARAM_KEYS（那是「v3 当年往盘上写了哪些键」的
    // 历史事实，名片改了它也不能改，否则老配方会缺键）；**默认值和类型**
    // 一律问名片。
    //
    // ⭐ V3_PARAM_KEYS 的书写顺序与原来那个对象字面量逐项相同，所以按它迭代
    //    出来的键序和搬家前一模一样 —— 存量配方文件不会因为这一刀而变字节。
    const params = {};
    for (const key of V3_PARAM_KEYS) {
      // 这两个是结构化字段（数组 / 不透明字典），上面已经各自校验过了，
      // 不走「取个标量、按类型转一下」这条路。
      if (key === "aux_ref_audio_paths" || key === "pron_overrides") continue;
      const raw = srcParams[key] != null ? srcParams[key] : prevParams[key];
      params[key] = coerceLegacyParam(key, raw);
    }
    params.aux_ref_audio_paths = aux_ref_audio_paths;
    params.pron_overrides = pron_overrides;

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

    // ---- v4: 去哪台引擎 ----------------------------------------------------
    // 空字符串是合法的，含义是「老路径引擎」（名片上写 legacy_default 的那台）。
    // 这样 v3 老配方读出来就是空，行为与今天一字不差；调用层负责把空解析成
    // 那台引擎。⛔ 这里不认识任何具体引擎的名字 —— recipeStore 是纯存储层，
    // 引擎注册表在 lib/engines/ 下，两边不能互相知道。
    let engine_id = payload.engine_id != null ? payload.engine_id
      : (existing && existing.engine_id != null ? existing.engine_id : "");
    if (typeof engine_id !== "string") return { ok: false, error: "engine_id must be a string" };
    engine_id = engine_id.trim();
    if (engine_id && !/^[a-zA-Z0-9_.-]+$/.test(engine_id)) {
      return { ok: false, error: "engine_id must match [a-zA-Z0-9_.-]+" };
    }

    // ---- v4: 每台引擎自己的参数格子 ----------------------------------------
    // 原样存。⛔ 不校验键名、不校验值、不填默认值、不排序、不裁剪。
    // 只校验一件事：它得是 { 引擎id: {对象} } 这个形状 —— 因为形状错了，
    // 调用层就没法按 engine_params[engine_id] 取到格子，那才是真的会静默失败。
    const srcBoxes = isPlainObject(payload.engine_params) ? payload.engine_params : null;
    const prevBoxes = existing && isPlainObject(existing.engine_params) ? existing.engine_params : {};
    const engine_params = {};
    for (const [k, v] of Object.entries(srcBoxes || prevBoxes)) {
      if (!isPlainObject(v)) {
        return { ok: false, error: `engine_params.${k} must be an object of that engine's own parameters` };
      }
      engine_params[k] = v;
    }

    // ⭐ 堵住静默吃键：v3 把白名单外的键直接丢了还返 200。现在它们落进本次
    // 配方所属引擎的格子里。只在 payload 显式带了 params 时才收（避免更新
    // 别的字段时，把上一版遗留的未知键重复搬一次）。
    if (isPlainObject(payload.params)) {
      const strays = {};
      for (const [k, v] of Object.entries(payload.params)) {
        if (!V3_PARAM_KEYS.has(k)) strays[k] = v;
      }
      if (Object.keys(strays).length > 0) {
        const boxKey = engine_id || "";
        // 引擎未知（老配方、老前端）时，用一个明确的占位键收着，而不是丢掉。
        // 调用层解析出真实引擎后会把它当成那台引擎的格子读。占位键本身是
        // 可见的、可审计的，比「值消失了」好得多。
        const target = boxKey || "_unassigned";
        engine_params[target] = Object.assign({}, engine_params[target], strays);
      }
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

        // v4: 去哪台引擎。"" = 老路径引擎，由调用层解析。
        engine_id,

        params,

        // v4: 每台引擎自己的参数格子，原样存原样取。
        engine_params,

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
